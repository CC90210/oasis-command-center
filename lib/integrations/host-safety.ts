/**
 * lib/integrations/host-safety.ts -- may OASIS connect to an address an owner
 * typed (their own mail server)? Answered from what the name RESOLVES
 * to, not how it is spelled (Codex review, 2026-10-09: a public-looking name
 * can point, or re-point, at 127.0.0.1 or 10.x).
 *
 *   1. Resolve every A and AAAA record of the name (DNS over HTTPS, Cloudflare
 *      1.1.1.1, which also works inside the Worker). A name with no address, a
 *      failed lookup or ANY private, loopback, link-local, multicast,
 *      unspecified or reserved address (IPv4 and IPv6, including IPv4 mapped,
 *      NAT64 and 6to4 forms) is refused. Nothing is connected to.
 *   2. The connection is then made to the address that was checked, never to
 *      the name again (no second lookup, so the answer cannot change between
 *      the check and the connect): connectPlan says how.
 *
 * WHERE PINNING IS POSSIBLE. In Node, a TLS connection can be opened to the
 * checked address while the certificate is verified against the name (the
 * name stays the SNI and the Host header). The Cloudflare Workers runtime
 * offers no documented way to do that (its fetch and connect() resolve the
 * name themselves), so on the Worker a self-hosted address is NOT connected
 * to at all: the Test answers "cannot_pin" and sends nothing.
 *
 * One exception, with its reason: the big mail providers' own SMTP names.
 * Only the
 * vendor controls those DNS answers, so an owner cannot point them inside a
 * network, and they are reached by name. They are still resolved and checked.
 */

import "server-only";

export type HostCheck =
  | { ok: true; addresses: string[] }
  | { ok: false; reason: "unresolvable" | "private_address" };

/** One DNS lookup: the A (type 1) or AAAA (type 28) addresses of a name, or null when the lookup failed. */
export type Resolver = (name: string, type: "A" | "AAAA") => Promise<string[] | null>;

// -- Addresses ------------------------------------------------------------------

function ipv4Parts(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p >= 0 && p <= 255) ? parts : null;
}

/** IPv4 ranges OASIS never connects to (RFC 6890 special-purpose, plus CGNAT, multicast and reserved). */
function blockedIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true; // this network, RFC 1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 shared address space (CGNAT)
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol assignments, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return true; // 6to4 relay anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(raw: string): number[] | null {
  let ip = raw.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  // A trailing dotted IPv4 (::ffff:10.0.0.1) becomes two groups.
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted) {
    const v4 = ipv4Parts(dotted[2]);
    if (!v4) return null;
    ip = `${dotted[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  if (!/^[0-9a-f:]+$/.test(ip) || (ip.match(/::/g) ?? []).length > 1) return null;
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const h = head ? head.split(":") : [];
  const t = tail === null ? [] : tail ? tail.split(":") : [];
  const missing = 8 - h.length - t.length;
  if (tail === null ? h.length !== 8 : missing < 1) return null;
  const groups = [...h, ...Array(tail === null ? 0 : missing).fill("0"), ...t];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function embeddedV4(hi: number, lo: number): number[] {
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];
}

/**
 * True when OASIS must never connect to this address. Anything that is not a
 * well-formed IPv4 or IPv6 address is refused too (fail closed).
 */
export function isBlockedAddress(ip: string): boolean {
  const v4 = ipv4Parts(ip);
  if (v4) return blockedIpv4(v4);
  const g = ipv6Groups(ip);
  if (!g) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && g[7] <= 1) return true; // :: unspecified, ::1 loopback
    return blockedIpv4(embeddedV4(g[6], g[7]));
  }
  // NAT64 well-known prefix 64:ff9b::/96 carries an IPv4 in its last 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return blockedIpv4(embeddedV4(g[6], g[7]));
  // 6to4 2002::/16 carries an IPv4 in groups 1-2.
  if (g[0] === 0x2002) return blockedIpv4(embeddedV4(g[1], g[2]));
  // Only global unicast 2000::/3 is reachable; inside it, the IETF special
  // block 2001::/23 (Teredo, benchmarking, ORCHID) and documentation 2001:db8::/32.
  if ((g[0] & 0xe000) !== 0x2000) return true; // fc00::/7, fe80::/10, ff00::/8, ::/8, 100::/64 ...
  if (g[0] === 0x2001 && g[1] < 0x0200) return true;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;
  return false;
}

// -- Resolution ------------------------------------------------------------------

/** DNS over HTTPS (Cloudflare's JSON API): no socket, works in Node and in the Worker. */
export const dohResolver = (fetchImpl: typeof fetch = fetch): Resolver => async (name, type) => {
  try {
    const res = await fetchImpl(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
      headers: { Accept: "application/dns-json" },
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status !== 200) return null;
    const body = (await res.json()) as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
    if (body.Status === 3) return []; // NXDOMAIN: the name has no address
    if (body.Status !== 0) return null;
    const want = type === "A" ? 1 : 28;
    // CNAME records in the chain (type 5) are skipped: only the final addresses count.
    return (body.Answer ?? []).filter((a) => a.type === want && typeof a.data === "string").map((a) => a.data!.trim());
  } catch (err) {
    console.error("[host-safety.doh]", type, err instanceof Error ? err.name : "error");
    return null;
  }
};

/**
 * Resolve every A and AAAA address of `host` and check each. A lookup that
 * failed, a name with no address, or one bad address refuses the whole host.
 */
export async function checkPublicHost(host: string, resolve: Resolver): Promise<HostCheck> {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  const [a, aaaa] = await Promise.all([resolve(name, "A"), resolve(name, "AAAA")]);
  if (a === null || aaaa === null) return { ok: false, reason: "unresolvable" };
  const addresses = [...a, ...aaaa];
  if (addresses.length === 0) return { ok: false, reason: "unresolvable" };
  if (addresses.some(isBlockedAddress)) return { ok: false, reason: "private_address" };
  return { ok: true, addresses };
}

// -- How to connect ----------------------------------------------------------------

/** Mail providers' own SMTP names: their DNS is the provider's, not the owner's. */
const VENDOR_SMTP_HOSTS: ReadonlySet<string> = new Set([
  "smtp.office365.com",
  "smtp-mail.outlook.com",
  "smtp.gmail.com",
  "smtp.sendgrid.net",
  "smtp.mailgun.org",
  "smtp.eu.mailgun.org",
  "smtp.postmarkapp.com",
  "smtp.zoho.com",
  "smtp.zoho.eu",
  "smtp.fastmail.com",
  "smtp.mail.yahoo.com",
  "smtp.mail.me.com",
]);

/** True when only a vendor controls this name's DNS answers (reached by name). */
export function isVendorControlledHost(kind: "smtp", host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  return VENDOR_SMTP_HOSTS.has(h) || /^email-smtp\.[a-z0-9-]+\.amazonaws\.com$/.test(h);
}

/** Running inside the Cloudflare Workers runtime (where a connection cannot be pinned to an address). */
export function onWorkersRuntime(): boolean {
  return typeof navigator !== "undefined" && (navigator as { userAgent?: string }).userAgent === "Cloudflare-Workers";
}

/**
 * How a Test reaches an owner-typed host it has already checked:
 *   by_name   a vendor-controlled name (its DNS is not the owner's)
 *   pinned    the checked address, with the name kept for SNI, Host and the
 *             certificate check (Node)
 *   refuse    neither is possible here (a self-hosted address on the Worker)
 */
export function connectPlan(
  kind: "smtp",
  host: string,
  runtime: "workers" | "node" = onWorkersRuntime() ? "workers" : "node",
): "by_name" | "pinned" | "refuse" {
  if (isVendorControlledHost(kind, host)) return "by_name";
  return runtime === "node" ? "pinned" : "refuse";
}
