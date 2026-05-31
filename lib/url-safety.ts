/**
 * URL safety helpers.
 *
 * These run at the API edge before persisting an operator-supplied
 * URL that the bridge or another daemon will later request. They
 * defend against trivial SSRF: loopback, RFC-1918 LAN, IPv6
 * unique-local + link-local, and cloud-metadata endpoints (AWS
 * 169.254.169.254 / GCP metadata.google.internal).
 *
 * Out of scope here: DNS-rebinding. The companion check at request
 * time is _is_private_ipv4 + _check_resolved_addresses_safe in
 * CEO-Agent/bravo_cli/cron_runner.py. Range list MUST stay in sync
 * with that file. If you add a new private range here, mirror it
 * there (and vice-versa) — a one-sided update creates an attack
 * window through whichever check the attacker bypasses.
 */

/**
 * Returns a non-null error string when the URL targets a host the
 * bridge MUST NOT request from, null when it's safe. Hostnames that
 * resolve via DNS are not inspected — handle DNS-rebinding at the
 * requester.
 */
export function classifyUrlForSsrf(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "url is not parseable";
  }
  let host = parsed.hostname.toLowerCase();
  if (!host) return "url has no hostname";
  // URL parses IPv6 hosts with brackets ("[::1]"); strip them so the
  // checks below see the address literal directly.
  if (host.startsWith("[") && host.endsWith("]")) {
    host = host.slice(1, -1);
  }
  if (host === "169.254.169.254" || host === "metadata.google.internal") {
    return "url targets cloud metadata service";
  }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    return "url targets loopback";
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = parseInt(ipv4[1], 10);
    const b = parseInt(ipv4[2], 10);
    if (a === 10) return "url targets RFC-1918 (10.0.0.0/8)";
    if (a === 127) return "url targets loopback (127.0.0.0/8)";
    if (a === 169 && b === 254) return "url targets link-local (169.254.0.0/16)";
    if (a === 172 && b >= 16 && b <= 31) return "url targets RFC-1918 (172.16/12)";
    if (a === 192 && b === 168) return "url targets RFC-1918 (192.168/16)";
    if (a === 0) return "url targets 0.0.0.0/8";
  }
  // IPv6 unique-local (fc00::/7) — both fcXX and fdXX prefixes.
  if (/^fc[0-9a-f]/.test(host) || /^fd[0-9a-f]/.test(host)) {
    return "url targets IPv6 unique-local (fc00::/7)";
  }
  // IPv6 link-local (fe80::/10) — fe8x, fe9x, feax, febx prefixes.
  if (/^fe[89ab][0-9a-f]/.test(host)) {
    return "url targets IPv6 link-local (fe80::/10)";
  }
  return null;
}
