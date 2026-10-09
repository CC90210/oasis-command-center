/**
 * lib/integrations/key-probes.ts -- the live Test for each app that connects
 * with a key the owner pastes in Settings > Connections (Calendly, Cal.com,
 * Fathom, Fireflies, Zernio, GoHighLevel, n8n, and the workspace's own mail
 * server over SMTP).
 *
 * ONE READ, NO SIDE EFFECT. Each Test makes the cheapest read the vendor
 * documents for "whose key is this" (or lists one item) and changes nothing in
 * the owner's account: no booking, no message, no workflow run, no email sent.
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
 *                        (GoHighLevel's sub-account, n8n's address)
 *   rate_limited         the vendor asked OASIS to slow down (429)
 *   provider_unreachable the vendor did not answer (network, timeout)
 *   provider_error       any other answer (a 5xx, an unexpected shape)
 *   blocked_host         the address points somewhere OASIS never connects to
 *   smtp_auth_failed     the mail server refused the username and password
 *   missing_fields       a required value is not saved
 *
 * A code may carry a short reason after a colon ("provider_error: http 502");
 * the card looks up the part before it. No key, password or token ever appears
 * in a code or a detail: the detail names only what the vendor said the
 * account is called.
 *
 * Self-hosted addresses (n8n, SMTP) are re-checked here with the same rule the
 * save used (isPublicHostname), so a value saved before that rule, or set some
 * other way, still cannot aim a Test at an internal address.
 */

import "server-only";
import {
  SMTP_PORTS,
  findIntegrationSchema,
  isPublicHostname,
  requiredIntegrationFieldKeys,
  validateIntegrationValue,
} from "@/lib/tenant-integration-schemas";

export type KeyProbeResult = {
  ok: boolean;
  error?: string;
  detail?: string;
  /** Nothing was asked of the provider (a value is missing): never kept as a check. */
  noLiveCheck?: boolean;
};

export type SmtpVerify = (input: {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
}) => Promise<void>;

export type KeyProbeDeps = {
  fetchImpl?: typeof fetch;
  smtpVerify?: SmtpVerify;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

/** The services this module tests. The Test route asks here first. */
export const KEY_PROBE_SERVICES = ["calendly", "cal_com", "fathom", "fireflies", "late", "gohighlevel", "n8n", "smtp"] as const;

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
    // can echo the address, and an n8n address is the owner's own.
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

/** The n8n instance's API root from the address the owner saved, or null when it is not one OASIS may call. */
export function n8nApiRoot(raw: string): string | null {
  const field = findIntegrationSchema("n8n")?.fields.find((f) => f.key === "base_url");
  if (!field || validateIntegrationValue(field, raw) !== null) return null;
  const u = new URL(raw.trim());
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
  return `${u.origin}${path}/api/v1`;
}

/** n8n: GET <instance>/api/v1/workflows?limit=1 with X-N8N-API-KEY. Lists, never runs. */
async function probeN8n(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const root = n8nApiRoot(bundle.base_url);
  if (!root) return { ok: false, error: "blocked_host" };
  const r = await call(deps, `${root}/workflows?limit=1`, {
    method: "GET",
    headers: { "X-N8N-API-KEY": bundle.api_key.trim(), Accept: "application/json" },
  });
  if (!r.ok) return r.result;
  // A redirect or a 404 is an address with no n8n API behind it (or the API is
  // switched off, as on n8n Cloud's free trial): never followed anywhere else.
  if (r.res.status === 404 || (r.res.status >= 300 && r.res.status < 400)) return { ok: false, error: "not_found" };
  if (r.res.status !== 200) return { ok: false, error: httpFailureCode(r.res.status) };
  const body = await jsonOf(r.res);
  if (!body || !Array.isArray(body.data)) return { ok: false, error: "not_found" };
  return { ok: true, detail: "n8n accepted the key" };
}

const defaultSmtpVerify: SmtpVerify = async ({ host, port, secure, user, password }) => {
  const nodemailer = await import("nodemailer");
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    // Never send the password in the clear: a server that will not start TLS is refused.
    requireTLS: !secure,
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
 * public host name on a standard mail port, and never without TLS.
 */
async function probeSmtp(bundle: Record<string, string>, deps: KeyProbeDeps): Promise<KeyProbeResult> {
  const host = bundle.host.trim().toLowerCase();
  const port = bundle.port.trim();
  if (!isPublicHostname(host) || !SMTP_PORTS.has(port)) return { ok: false, error: "blocked_host" };
  try {
    await (deps.smtpVerify ?? defaultSmtpVerify)({
      host,
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
  n8n: probeN8n,
  smtp: probeSmtp,
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
