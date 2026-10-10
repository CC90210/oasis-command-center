/**
 * lib/integrations/key-probes.ts -- the live Test for each app that connects
 * with a key the owner pastes in Settings > Connections (Calendly, Cal.com,
 * Fathom, Fireflies, Zernio, GoHighLevel, the workspace's own mail server
 * over SMTP, Plaid, a Discord or Teams channel webhook, and Meta Ads).
 *
 * ONE READ, NO SIDE EFFECT. Each Test makes the cheapest read the vendor
 * documents for "whose key is this" (or lists one item) and changes nothing in
 * the owner's account: no booking, no message, no post, no email sent.
 * The endpoint and header of each come from the vendor's current API docs,
 * cited beside its schema in lib/tenant-integration-schemas.ts.
 *
 * ONE SET OF ANSWERS. Every probe answers with the same codes, which the app's
 * card turns into plain words (lib/os/connectors.ts keyTestStates):
 *
 *   key_rejected         the vendor refused the key (401, or its own word for it)
 *   missing_permission   the key works but may not read what the Test reads (403)
 *   plan_required        the vendor's plan for this account has no API access
 *   not_found            the account part named beside the key does not exist
 *                        (GoHighLevel's sub-account, a mail server's name)
 *   rate_limited         the vendor asked OASIS to slow down (429)
 *   provider_unreachable the vendor did not answer (network, timeout)
 *   provider_error       any other answer (a 5xx, an unexpected shape)
 *   blocked_host         the address points somewhere OASIS never connects to
 *                        (by its spelling, or by what its name RESOLVES to)
 *   cannot_pin           a self-hosted mail server this runtime cannot connect to
 *                        safely (no way to pin it to the checked address):
 *                        nothing was sent (lib/integrations/host-safety.ts)
 *   smtp_auth_failed     the mail server refused the username and password
 *   missing_fields       a required value is not saved
 *
 * A code may carry a short reason after a colon ("provider_error: http 502");
 * the card looks up the part before it. No key, password or token ever appears
 * in a code or a detail: the detail names only what the vendor said the
 * account is called.
 *
 * A self-hosted mail server's address is re-checked here with the same rule the
 * save used (isPublicHostname), so a value saved before that rule, or set some
 * other way, still cannot aim a Test at an internal address. Then their name is
 * resolved and every address checked, and the connection goes to the checked
 * address, or nowhere (lib/integrations/host-safety.ts).
 */

import "server-only";
import {
  PLAID_HOSTS,
  SMTP_PORTS,
  findIntegrationSchema,
  isPublicHostname,
  parseDiscordWebhookUrl,
  parseTeamsWebhookUrl,
  requiredIntegrationFieldKeys,
  type PlaidEnvironment,
} from "@/lib/tenant-integration-schemas";
import { checkPublicHost, connectPlan, dohResolver, type Resolver } from "@/lib/integrations/host-safety";

export type KeyProbeResult = {
  ok: boolean;
  error?: string;
  detail?: string;
  /** Nothing was asked of the provider (a value is missing): never kept as a check. */
  noLiveCheck?: boolean;
};

export type SmtpVerify = (input: {
  /** The name the owner saved: the TLS server name and the certificate check. */
  host: string;
  /** Where the connection goes: the checked address (pinned), or the name itself (a vendor's mail server). */
  connectHost: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}) => Promise<void>;

export type KeyProbeDeps = {
  fetchImpl?: typeof fetch;
  smtpVerify?: SmtpVerify;
  timeoutMs?: number;
  /** DNS lookups for owner-typed hosts (default: DNS over HTTPS). */
  resolve?: Resolver;
  /** Where this runs, which decides whether a connection can be pinned (default: detected). */
  runtime?: "workers" | "node";
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** The services this module tests. The Test route asks here first. */
export const KEY_PROBE_SERVICES = [
  "calendly",
  "cal_com",
  "fathom",
  "fireflies",
  "late",
  "gohighlevel",
  "smtp",
  "plaid",
  "discord",
  "microsoft_teams",
  "meta_ads",
] as const;

export function hasKeyProbe(service: string): boolean {
  return (KEY_PROBE_SERVICES as readonly string[]).includes(service);
}

/** An HTTP answer that is not a success, as one of the shared codes. */
export function httpFailureCode(status: number): string {
  if (status === 401) return "key_rejected";
  if (status === 403) return "missing_permission";
  if (status === 429) return "rate_limited";
  return `provider_error: http ${status}`;
}

type Fetched = { ok: true; res: Response } | { ok: false; result: KeyProbeResult };

async function call(deps: KeyProbeDeps, url: string, init: RequestInit): Promise<Fetched> {
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
    return { ok: true, res };
  } catch (err) {
    // The reason is the error's NAME only (TimeoutError, TypeError): a message
    // can echo the address.
    const name = err instanceof Error ? err.name : "error";
    console.error("[key-probe.network]", new URL(url).hostname, name);
    return { ok: false, result: { ok: false, error: `provider_unreachable: ${name}` } };
  }
}

async function jsonOf(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body = (await res.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null;
}

/** "Jane Doe (jane@acme.test)", "Jane Doe", or null. */
function who(name: string | null, email: string | null): string | null {
  if (name && email && name !== email) return `${name} (${email})`;
  return name ?? email;
}

function missing(service: string, bundle: Record<string, string>): KeyProbeResult | null {
  const schema = findIntegrationSchema(service);
  if (!schema) return { ok: false, error: "unknown_service", noLiveCheck: true };
  const absent = requiredIntegrationFieldKeys(schema).filter((k) => !bundle[k]?.trim());
  return absent.length > 0 ? { ok: false, error: `missing_fields: ${absent.join(", ")}`, noLiveCheck: true } : null;
}

// -- The probes ----------------------------------------------------------------

/** Calendly: GET /users/me with the personal access token (scope users:read). */
async function probeCalendly(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const r = await call(deps, "https://api.calendly.com/users/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${bundle.access_token.trim()}`, Accept: "application/json" },
  });
  if (!r.ok) return r.result;
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const resource = ((await jsonOf(r.res))?.resource ?? null) as Record<string, unknown> | null;
  if (!resource) return { ok: false, error: "provider_error: no user in the answer" };
  const name = who(str(resource.name), str(resource.email));
  return { ok: true, detail: name ? `Calendly account: ${name}` : "Calendly accepted the token" };
}

/** Cal.com: GET /v2/me with the API key as a Bearer token. */
async function probeCalCom(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const r = await call(deps, "https://api.cal.com/v2/me", {
    method: "GET",
    headers: { Authorization: `Bearer ${bundle.api_key.trim()}`, Accept: "application/json" },
  });
  if (!r.ok) return r.result;
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const body = await jsonOf(r.res);
  const data = (body?.data ?? null) as Record<string, unknown> | null;
  if (!data || body?.status === "error") return { ok: false, error: "provider_error: no profile in the answer" };
  const name = who(str(data.name) ?? str(data.username), str(data.email));
  return { ok: true, detail: name ? `Cal.com account: ${name}` : "Cal.com accepted the key" };
}

/**
 * Fathom: GET /external/v1/meetings with X-Api-Key. Fathom's answer names no
 * account (only the meetings), so a pass says the key was accepted.
 */
async function probeFathom(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const r = await call(deps, "https://api.fathom.ai/external/v1/meetings", {
    method: "GET",
    headers: { "X-Api-Key": bundle.api_key.trim(), Accept: "application/json" },
  });
  if (!r.ok) return r.result;
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const body = await jsonOf(r.res);
  if (!body || !Array.isArray(body.items)) return { ok: false, error: "provider_error: no meeting list in the answer" };
  return { ok: true, detail: "Fathom accepted the key" };
}

/**
 * Fireflies: the GraphQL `user` query with no id answers the key's owner.
 * GraphQL refusals arrive as errors[] with Fireflies' own code
 * (docs.fireflies.ai/miscellaneous/error-codes), sometimes on a 200.
 */
const FIREFLIES_ERROR_CODES: Readonly<Record<string, string>> = {
  auth_failed: "key_rejected",
  invalid_api_key: "key_rejected",
  unauthenticated: "key_rejected",
  paid_required: "plan_required",
  forbidden: "missing_permission",
  not_in_team: "missing_permission",
  account_cancelled: "plan_required",
  too_many_requests: "rate_limited",
};

async function probeFireflies(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const r = await call(deps, "https://api.fireflies.ai/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bundle.api_key.trim()}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query: "query { user { name email } }" }),
  });
  if (!r.ok) return r.result;
  const body = await jsonOf(r.res);
  const errors = Array.isArray(body?.errors) ? (body!.errors as Array<Record<string, unknown>>) : [];
  if (errors.length > 0) {
    const first = errors[0] ?? {};
    const ext = (first.extensions ?? {}) as Record<string, unknown>;
    const code = String(ext.code ?? first.code ?? "").toLowerCase();
    const mapped = FIREFLIES_ERROR_CODES[code];
    if (mapped) return { ok: false, error: mapped };
    if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
    return { ok: false, error: `provider_error: ${code || "graphql error"}` };
  }
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const user = ((body?.data as Record<string, unknown> | undefined)?.user ?? null) as Record<string, unknown> | null;
  if (!user) return { ok: false, error: "provider_error: no user in the answer" };
  const name = who(str(user.name), str(user.email));
  return { ok: true, detail: name ? `Fireflies account: ${name}` : "Fireflies accepted the key" };
}

/** Zernio (formerly Late): GET /api/v1/profiles with the API key as a Bearer token. */
async function probeZernio(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const r = await call(deps, "https://zernio.com/api/v1/profiles", {
    method: "GET",
    headers: { Authorization: `Bearer ${bundle.api_key.trim()}`, Accept: "application/json" },
  });
  if (!r.ok) return r.result;
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const body = await jsonOf(r.res);
  if (!body || !Array.isArray(body.profiles)) return { ok: false, error: "provider_error: no profile list in the answer" };
  const n = body.profiles.length;
  return { ok: true, detail: `Zernio accepted the key: ${n} ${n === 1 ? "profile" : "profiles"}` };
}

/**
 * GoHighLevel: GET /locations/{id} with the private integration token. A 400,
 * 404 or 422 is the sub-account, not the token: GoHighLevel answers those for
 * an id it does not know or the token may not open.
 */
async function probeGoHighLevel(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const locationId = bundle.location_id.trim();
  const r = await call(deps, `https://services.leadconnectorhq.com/locations/${encodeURIComponent(locationId)}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${bundle.private_token.trim()}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });
  if (!r.ok) return r.result;
  if (r.res.status === 400 || r.res.status === 404 || r.res.status === 422) return { ok: false, error: "not_found" };
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const location = ((await jsonOf(r.res))?.location ?? null) as Record<string, unknown> | null;
  if (!location) return { ok: false, error: "provider_error: no sub-account in the answer" };
  const name = str(location.name);
  return { ok: true, detail: name ? `GoHighLevel sub-account: ${name}` : "GoHighLevel accepted the token" };
}

/**
 * Plaid: POST /institutions/get for ONE bank in the environment the secret is
 * for. It sends no customer data and reads no account, and it needs only the
 * client id and secret, which travel in Plaid's own headers. The host comes
 * from the environment word and nowhere else (PLAID_HOSTS), so a saved secret
 * can only ever reach sandbox.plaid.com or production.plaid.com.
 */
const PLAID_KEY_ERRORS: ReadonlySet<string> = new Set(["INVALID_API_KEYS", "INVALID_CLIENT_ID", "INVALID_SECRET"]);
const PLAID_ACCESS_ERRORS: ReadonlySet<string> = new Set([
  "UNAUTHORIZED_ENVIRONMENT",
  "PRODUCT_NOT_ENABLED",
  "INVALID_PRODUCT",
  "ADDITIONAL_CONSENT_REQUIRED",
]);

async function probePlaid(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const plaidEnvironment = bundle.environment.trim() as PlaidEnvironment;
  const base = Object.prototype.hasOwnProperty.call(PLAID_HOSTS, plaidEnvironment) ? PLAID_HOSTS[plaidEnvironment] : null;
  if (!base) return { ok: false, error: "provider_error: unknown environment" };
  const r = await call(deps, `${base}/institutions/get`, {
    method: "POST",
    headers: {
      "PLAID-CLIENT-ID": bundle.client_id.trim(),
      "PLAID-SECRET": bundle.secret.trim(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ count: 1, offset: 0, country_codes: ["US"] }),
  });
  if (!r.ok) return r.result;
  const body = await jsonOf(r.res);
  if (r.res.status === 200) {
    return Array.isArray(body?.institutions)
      ? { ok: true, detail: `Plaid accepted the credentials (${plaidEnvironment})` }
      : { ok: false, error: "provider_error: no institution list in the answer" };
  }
  const code = typeof body?.error_code === "string" ? body.error_code : "";
  if (PLAID_KEY_ERRORS.has(code) || r.res.status === 401) return { ok: false, error: "key_rejected" };
  if (PLAID_ACCESS_ERRORS.has(code) || r.res.status === 403) return { ok: false, error: "missing_permission" };
  if (code === "RATE_LIMIT_EXCEEDED" || r.res.status === 429) return { ok: false, error: "rate_limited" };
  return { ok: false, error: `provider_error: http ${r.res.status}` };
}

/**
 * Discord: GET the webhook URL itself. Discord documents it as the call that
 * returns the webhook without posting anything, and it needs no other
 * authentication (the token is in the address). The address is parsed again
 * here, whatever the save said, so a value stored before the rule, or set some
 * other way, still cannot aim the Test (and the secret in the URL) anywhere
 * but Discord.
 */
async function probeDiscord(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const url = parseDiscordWebhookUrl(bundle.webhook_url);
  if (!url) return { ok: false, error: "blocked_host" };
  const r = await call(deps, url.toString(), { method: "GET", headers: { Accept: "application/json" } });
  if (!r.ok) return r.result;
  if (r.res.status === 401 || r.res.status === 404) return { ok: false, error: "key_rejected" };
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const body = await jsonOf(r.res);
  if (!body || typeof body.id !== "string") return { ok: false, error: "provider_error: no webhook in the answer" };
  const name = str(body.name);
  return { ok: true, detail: name ? `Discord webhook: ${name}` : "Discord accepted the webhook" };
}

/**
 * Microsoft Teams: a Workflows webhook accepts POST only, so Test posts one
 * short Adaptive Card that says OASIS connected. That is the one visible side
 * effect of any Test here, and the card's description says so before it is
 * pressed. The address is re-checked here exactly as Discord's is.
 */
async function probeTeams(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const url = parseTeamsWebhookUrl(bundle.webhook_url);
  if (!url) return { ok: false, error: "blocked_host" };
  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.2",
          body: [{ type: "TextBlock", wrap: true, text: "OASIS is connected to this channel. This is the one test message OASIS sends." }],
        },
      },
    ],
  };
  const r = await call(deps, url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(card),
  });
  if (!r.ok) return r.result;
  if (r.res.status === 200 || r.res.status === 202) return { ok: true, detail: "Posted one test message to the Teams channel" };
  if (r.res.status === 404) return { ok: false, error: "key_rejected" };
  return { ok: false, error: httpFailureCode(r.res.status) };
}

/** The Graph API version the Meta Test calls. Meta keeps each one for about two years. */
export const META_GRAPH_VERSION = "v23.0";

const META_KEY_ERRORS: ReadonlySet<number> = new Set([102, 190]);
const META_ACCESS_ERRORS: ReadonlySet<number> = new Set([3, 10, 200, 299]);
const META_RATE_ERRORS: ReadonlySet<number> = new Set([4, 17, 32, 613]);

/**
 * Meta Ads: GET /act_{id} with the system user's token as a Bearer header
 * (never in the address, so it cannot land in a log). Meta answers errors as
 * JSON with a numeric code, often on HTTP 400.
 */
async function probeMetaAds(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const digits = bundle.ad_account_id.trim().replace(/^act_/, "");
  if (!/^\d{5,20}$/.test(digits)) return { ok: false, error: "not_found" };
  const r = await call(deps, `https://graph.facebook.com/${META_GRAPH_VERSION}/act_${digits}?fields=name,account_status`, {
    method: "GET",
    headers: { Authorization: `Bearer ${bundle.access_token.trim()}`, Accept: "application/json" },
  });
  if (!r.ok) return r.result;
  const body = await jsonOf(r.res);
  if (r.res.status === 200) {
    if (!body || typeof body.id !== "string") return { ok: false, error: "provider_error: no ad account in the answer" };
    const name = str(body.name);
    const active = body.account_status === 1;
    return { ok: true, detail: `Meta ad account: ${name ?? `act_${digits}`}${active ? "" : " (not active in Meta)"}` };
  }
  const code = Number((body?.error as Record<string, unknown> | undefined)?.code);
  if (META_KEY_ERRORS.has(code) || r.res.status === 401) return { ok: false, error: "key_rejected" };
  if (META_ACCESS_ERRORS.has(code) || r.res.status === 403) return { ok: false, error: "missing_permission" };
  if (META_RATE_ERRORS.has(code) || r.res.status === 429) return { ok: false, error: "rate_limited" };
  if (code === 100 || r.res.status === 404) return { ok: false, error: "not_found" };
  return { ok: false, error: `provider_error: http ${r.res.status}` };
}

/**
 * Resolve and check an owner-typed host, then decide how to reach it
 * (lib/integrations/host-safety.ts): a refusal result, or the address to use.
 * One lookup per Test: the connection never asks DNS again, so the answer
 * cannot be swapped between the check and the connect.
 */
async function reachableHost(
  kind: "smtp",
  host: string,
  deps: KeyProbeDeps,
): Promise<{ ok: true; connectTo: string; pinned: boolean } | { ok: false; result: KeyProbeResult }> {
  const checked = await checkPublicHost(host, deps.resolve ?? dohResolver(deps.fetchImpl ?? fetch));
  if (!checked.ok) {
    console.error("[key-probe.host]", kind, checked.reason);
    return { ok: false, result: { ok: false, error: checked.reason === "private_address" ? "blocked_host" : "not_found" } };
  }
  const plan = connectPlan(kind, host, deps.runtime);
  if (plan === "refuse") return { ok: false, result: { ok: false, error: "cannot_pin" } };
  return plan === "by_name" ? { ok: true, connectTo: host, pinned: false } : { ok: true, connectTo: checked.addresses[0], pinned: true };
}

const defaultSmtpVerify: SmtpVerify = async ({ host, connectHost, port, secure, user, password }) => {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    // The checked address (or a vendor's own name); the saved name stays the
    // TLS server name, so the certificate is checked against it.
    host: connectHost,
    port,
    secure,
    // Never send the password in the clear: a server that will not start TLS is refused.
    requireTLS: !secure,
    tls: { servername: host },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
    auth: { user, pass: password },
  });
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
};

/**
 * SMTP: sign in (EHLO, STARTTLS or TLS, AUTH) and quit. Sends nothing. Only a
 * public host name on a standard mail port, whose every address is public,
 * reached at the checked address, and never without TLS.
 */
async function probeSmtp(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const host = bundle.host.trim().toLowerCase();
  const port = bundle.port.trim();
  if (!isPublicHostname(host) || !SMTP_PORTS.has(port)) return { ok: false, error: "blocked_host" };
  const reach = await reachableHost("smtp", host, deps);
  if (!reach.ok) return reach.result;
  try {
    await (deps.smtpVerify ?? defaultSmtpVerify)({
      host,
      connectHost: reach.connectTo,
      port: Number(port),
      secure: port === "465",
      user: bundle.user.trim(),
      password: bundle.password,
    });
    return { ok: true, detail: `Signed in to ${host} as ${bundle.user.trim().slice(0, 120)}` };
  } catch (err) {
    const code = String((err as { code?: unknown })?.code ?? "");
    console.error("[key-probe.smtp]", host, code || (err instanceof Error ? err.name : "error"));
    if (code === "EAUTH") return { ok: false, error: "smtp_auth_failed" };
    return { ok: false, error: `provider_unreachable: ${code || "smtp"}` };
  }
}

const PROBES: Readonly<Record<(typeof KEY_PROBE_SERVICES)[number], (b: Record<string, string>, d: KeyProbeDeps) => Promise<KeyProbeResult>>> = {
  calendly: probeCalendly,
  cal_com: probeCalCom,
  fathom: probeFathom,
  fireflies: probeFireflies,
  late: probeZernio,
  gohighlevel: probeGoHighLevel,
  smtp: probeSmtp,
  plaid: probePlaid,
  discord: probeDiscord,
  microsoft_teams: probeTeams,
  meta_ads: probeMetaAds,
};

/**
 * Run one app's Test against its saved values. A missing required value is an
 * answer (missing_fields), not a call: nothing is sent with half a setup.
 */
export async function runKeyProbe(
  service: string,
  bundle: Record<string, string>,
  deps: KeyProbeDeps = {},
): Promise<KeyProbeResult> {
  if (!hasKeyProbe(service)) return { ok: false, error: `no_probe_for_${service}`, noLiveCheck: true };
  const absent = missing(service, bundle);
  if (absent) return absent;
  return PROBES[service as (typeof KEY_PROBE_SERVICES)[number]](bundle, deps);
}
