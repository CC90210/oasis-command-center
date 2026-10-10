/**
 * lib/connections/oauth-adapters.ts - what is different about each vendor's
 * OAuth 2 sign-in, in one place: how the code is exchanged, how the token is
 * refreshed, who the grant belongs to, how a live connection is checked, and
 * how the vendor is told to forget it (QuickBooks, Xero, Zoom, WhatsApp).
 *
 * The generic parts (the signed single-use state, the tenant and user a
 * consent is bound to, the atomic token save, the refresh lease) live in
 * lib/connections/{oauth,token-store,oauth-connect,oauth-live}.ts. Every URL
 * and parameter below is from the vendor's current documentation, read
 * 2026-10-10:
 *
 *   QuickBooks  developer.intuit.com/app/developer/qbo/docs/develop/authentication-and-authorization/oauth-2.0
 *               Basic client auth; the company (realmId) arrives on the callback;
 *               access 1 hour; the refresh token is re-issued on every refresh;
 *               revoke is POST developer.api.intuit.com/v2/oauth2/tokens/revoke.
 *   Xero        developer.xero.com/documentation/guides/oauth2/auth-flow
 *               Basic client auth; access 30 minutes; the refresh token (60 days)
 *               is single-use with a 30 minute grace; the organisation comes from
 *               GET api.xero.com/connections; revoke is POST
 *               identity.xero.com/connect/revocation.
 *   Zoom        developers.zoom.us/docs/integrations/oauth/
 *               Basic client auth; access 1 hour; refresh token 90 days, always
 *               use the latest; revoke is POST zoom.us/oauth/revoke.
 *   WhatsApp    developers.facebook.com (Facebook Login, Graph API)
 *               code -> token over GET oauth/access_token, then extended to a
 *               long-lived token with fb_exchange_token. Meta issues no refresh
 *               token: the stored "refresh token" IS that long-lived token, and
 *               refreshing exchanges it again. The WhatsApp Business Account is
 *               found with debug_token; permissions are revoked with
 *               DELETE me/permissions.
 *
 * NO SECRET IN A MESSAGE. An error thrown here names the vendor and an HTTP
 * status, never a code, token or client secret.
 *
 * Every function takes its fetch and its clock-free deadline from the caller,
 * so tests/every-connector-works.test.ts drives the real code against a mocked
 * vendor.
 */
import "server-only";
import type { ConnectionEnvironment, HealthVerdict, ProbeErrorCode } from "@/lib/connections/rules";
import { RefreshRefusedError } from "@/lib/connections/token-store";

type Env = Readonly<Record<string, string | undefined>>;
type Obj = Record<string, unknown>;

export type OAuthClient = { clientId: string; clientSecret: string };
export type AdapterDeps = { fetchImpl: typeof fetch; timeoutMs: number; env: Env };

export type TokenGrant = {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lives. */
  expiresInSec: number;
};

export type OAuthIdentity = {
  accountId: string;
  accountLabel: string | null;
  environment: ConnectionEnvironment | null;
};

export type OAuthProbeResult = {
  verdict: HealthVerdict;
  code: ProbeErrorCode | null;
  detail: string | null;
  latencyMs: number;
  accountId: string | null;
  accountLabel: string | null;
  environment: ConnectionEnvironment | null;
};

/** The code could not be turned into a grant, or the grant belongs to nobody OASIS can pin. */
export class OAuthExchangeError extends Error {
  code: "exchange_failed" | "account_unidentified";
  constructor(code: OAuthExchangeError["code"], message: string) {
    super(message);
    this.name = "OAuthExchangeError";
    this.code = code;
  }
}

export type OAuthAdapter = {
  provider: string;
  /** What a disconnect asks the vendor to forget, in words for the owner. */
  revokes: string;
  exchange(client: OAuthClient, input: { code: string; redirectUri: string }, deps: AdapterDeps): Promise<TokenGrant>;
  refresh(client: OAuthClient, refreshToken: string, deps: AdapterDeps, signal?: AbortSignal): Promise<TokenGrant>;
  /** Who the grant belongs to. `query` is the callback's own query string (QuickBooks sends the company there). */
  identify(client: OAuthClient, grant: TokenGrant, query: URLSearchParams, deps: AdapterDeps): Promise<OAuthIdentity>;
  /** A live read with the access token, compared with the account the connection is pinned to. */
  probe(accessToken: string, accountId: string, deps: AdapterDeps): Promise<OAuthProbeResult>;
  /** Tell the vendor to forget the grant. False when it could not be done (the owner is told). */
  revoke(client: OAuthClient, tokens: { accessToken: string | null; refreshToken: string | null }, deps: AdapterDeps): Promise<boolean>;
};

// -- shared plumbing -----------------------------------------------------------

const asObj = (v: unknown): Obj | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const basic = (c: OAuthClient) => `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`;

type Reply = { status: number; body: unknown } | { status: 0; body: null };

/** One request under a deadline. A network failure or timeout is status 0: nothing was learned. */
async function send(deps: AdapterDeps, url: string, init: RequestInit, signal?: AbortSignal): Promise<Reply> {
  // One controller for the deadline and the caller's own abort (the refresh
  // lease), so neither can outlive the other.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener("abort", onCallerAbort, { once: true });
  try {
    const res = await deps.fetchImpl(url, { ...init, redirect: "manual", cache: "no-store", signal: controller.signal });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch (err) {
    // The error's NAME only: a message can echo an address.
    console.error("[oauth-adapter.network]", new URL(url).hostname, err instanceof Error ? err.name : "error");
    return { status: 0, body: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onCallerAbort);
  }
}

const form = (values: Record<string, string>) => new URLSearchParams(values).toString();
const FORM = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } as const;

function grantFrom(vendor: string, body: unknown, fallbackRefresh: string | null): TokenGrant {
  const o = asObj(body);
  const accessToken = text(o?.access_token);
  const refreshToken = text(o?.refresh_token) ?? fallbackRefresh;
  const expiresIn = Number(o?.expires_in);
  if (!accessToken || !refreshToken) throw new OAuthExchangeError("exchange_failed", `${vendor} did not return a usable token`);
  return { accessToken, refreshToken, expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600 };
}

/** Exchange or refresh at a Basic-auth token endpoint (QuickBooks, Xero, Zoom). */
async function basicTokenCall(
  vendor: string,
  url: string,
  client: OAuthClient,
  values: Record<string, string>,
  deps: AdapterDeps,
  mode: "exchange" | "refresh",
  fallbackRefresh: string | null,
  signal?: AbortSignal,
): Promise<TokenGrant> {
  const r = await send(deps, url, { method: "POST", headers: { ...FORM, Authorization: basic(client) }, body: form(values) }, signal);
  if (r.status === 200) return grantFrom(vendor, r.body, fallbackRefresh);
  if (mode === "refresh") {
    // The vendor answered and said no: the grant is dead. Anything else says nothing about it.
    if (r.status === 400 || r.status === 401) {
      throw new RefreshRefusedError({ oauthError: text(asObj(r.body)?.error), httpStatus: r.status });
    }
    throw new Error(`${vendor} token refresh could not be completed (HTTP ${r.status})`);
  }
  throw new OAuthExchangeError("exchange_failed", `${vendor} refused the sign-in code (HTTP ${r.status})`);
}

function probeFail(
  vendor: string,
  r: Reply,
  startedAt: number,
  accountId: string,
): OAuthProbeResult {
  const latencyMs = Date.now() - startedAt;
  const none = { accountId: null, accountLabel: null, environment: null } as const;
  if (r.status === 401) {
    return { ...none, verdict: "down", code: "key_rejected", latencyMs, detail: `${vendor} no longer accepts OASIS's access to this account. Reconnect it.` };
  }
  if (r.status === 403) {
    return { ...none, accountId, verdict: "degraded", code: "missing_permissions", latencyMs, detail: `${vendor} accepted the sign-in but would not show OASIS this account's data. Reconnect it and approve the access it asks for.` };
  }
  if (r.status === 0 || r.status === 429 || r.status >= 500) {
    return { ...none, verdict: "unknown", code: "provider_unreachable", latencyMs, detail: `${vendor} could not be reached (${r.status === 0 ? "no answer" : `HTTP ${r.status}`}). OASIS will check again.` };
  }
  return { ...none, verdict: "unknown", code: "unexpected_response", latencyMs, detail: `${vendor} answered with an unexpected HTTP ${r.status}. OASIS will check again.` };
}

// -- QuickBooks (Intuit) ---------------------------------------------------------

const INTUIT_TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
const INTUIT_REVOKE_URL = "https://developer.api.intuit.com/v2/oauth2/tokens/revoke";

/** OASIS's Intuit app is development (sandbox) or production; INTUIT_ENVIRONMENT says which. Default production. */
export function intuitEnvironment(env: Env): "sandbox" | "production" {
  return (env.INTUIT_ENVIRONMENT || "").trim().toLowerCase() === "sandbox" ? "sandbox" : "production";
}

function intuitApi(env: Env): string {
  return intuitEnvironment(env) === "sandbox" ? "https://sandbox-quickbooks.api.intuit.com" : "https://quickbooks.api.intuit.com";
}

async function intuitCompany(accessToken: string, realmId: string, deps: AdapterDeps): Promise<Reply> {
  return send(deps, `${intuitApi(deps.env)}/v3/company/${encodeURIComponent(realmId)}/companyinfo/${encodeURIComponent(realmId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
}

const quickbooks: OAuthAdapter = {
  provider: "quickbooks",
  revokes: "the QuickBooks access OASIS holds",
  exchange: (client, input, deps) =>
    basicTokenCall("QuickBooks", INTUIT_TOKEN_URL, client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, deps, "exchange", null),
  refresh: (client, refreshToken, deps, signal) =>
    basicTokenCall("QuickBooks", INTUIT_TOKEN_URL, client, { grant_type: "refresh_token", refresh_token: refreshToken }, deps, "refresh", refreshToken, signal),
  async identify(_client, grant, query, deps) {
    const realmId = (query.get("realmId") || "").trim();
    if (!/^\d{4,25}$/.test(realmId)) throw new OAuthExchangeError("account_unidentified", "QuickBooks did not say which company was connected");
    const r = await intuitCompany(grant.accessToken, realmId, deps);
    const info = asObj(asObj(r.body)?.CompanyInfo);
    if (r.status !== 200 || !info) throw new OAuthExchangeError("exchange_failed", `QuickBooks would not show the company (HTTP ${r.status})`);
    return {
      accountId: realmId,
      accountLabel: text(info.CompanyName) ?? text(info.LegalName),
      environment: intuitEnvironment(deps.env) === "sandbox" ? "test" : "live",
    };
  },
  async probe(accessToken, accountId, deps) {
    const started = Date.now();
    const r = await intuitCompany(accessToken, accountId, deps);
    const info = asObj(asObj(r.body)?.CompanyInfo);
    if (r.status === 200 && info) {
      return {
        verdict: "healthy",
        code: null,
        detail: null,
        latencyMs: Date.now() - started,
        accountId,
        accountLabel: text(info.CompanyName) ?? text(info.LegalName),
        environment: intuitEnvironment(deps.env) === "sandbox" ? "test" : "live",
      };
    }
    return probeFail("QuickBooks", r, started, accountId);
  },
  async revoke(client, tokens, deps) {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return false;
    const r = await send(deps, INTUIT_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: basic(client) },
      body: JSON.stringify({ token }),
    });
    return r.status === 200;
  },
};

// -- Xero --------------------------------------------------------------------------

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_REVOKE_URL = "https://identity.xero.com/connect/revocation";
const XERO_CONNECTIONS_URL = "https://api.xero.com/connections";

export type XeroOrg = { tenantId: string; tenantName: string | null; authEventId: string | null };

function xeroOrgs(body: unknown): XeroOrg[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => {
    const o = asObj(row);
    const tenantId = text(o?.tenantId);
    return tenantId ? [{ tenantId, tenantName: text(o?.tenantName), authEventId: text(o?.authEventId) }] : [];
  });
}

/**
 * The access token's own `authentication_event_id` claim: which consent this
 * is (developer.xero.com/documentation/guides/oauth2/tenants, read
 * 2026-10-10). Read without verifying the signature — the token just came
 * from Xero's own token endpoint over TLS (the same trust the Bearer header
 * already relies on), so its claims are good enough for picking WHICH of the
 * caller's organisations this is, never for authenticating anything. Not
 * every token carries one (a malformed one, or a test double), so a caller
 * treats a miss as "unknown", not as Xero's fault.
 */
export function xeroAuthEventId(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = asObj(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    return text(payload?.authentication_event_id);
  } catch {
    return null;
  }
}

export type XeroOrgResolution = { ok: true; org: XeroOrg } | { ok: false; reason: "none" | "several" };

/**
 * Which organisation THIS consent approved. `GET /connections` can list every
 * organisation the signed-in Xero user has EVER approved for OASIS's app, not
 * only the one just granted (CodeRabbit, PR #574): Xero does not document the
 * array's order, and `createdDateUtc` is each connection's original creation
 * time, not this consent's time, so neither says "current" — picking `[0]` or
 * the newest `createdDateUtc` can both pin the wrong organisation. Xero's own
 * answer is `authEventId`: every connection row carries the auth event that
 * authorised it, and the access token carries the auth event THIS consent
 * just ran.
 *
 * One organisation is unambiguous either way. More than one needs a match —
 * but a single Xero consent can itself approve SEVERAL organisations at once
 * (Codex review, PR #574): they all carry the SAME authEventId, so `.find()`
 * would silently pick whichever sorted first. OASIS connects one organisation
 * per workspace, so more than one match refuses with its own reason, in the
 * SAME order regardless of which row the vendor lists first — never a guess.
 */
export function xeroCurrentOrg(orgs: readonly XeroOrg[], authEventId: string | null): XeroOrgResolution {
  if (orgs.length === 0) return { ok: false, reason: "none" };
  if (orgs.length === 1) return { ok: true, org: orgs[0] };
  if (!authEventId) return { ok: false, reason: "none" };
  const matches = orgs.filter((o) => o.authEventId === authEventId);
  if (matches.length === 0) return { ok: false, reason: "none" };
  if (matches.length > 1) return { ok: false, reason: "several" };
  return { ok: true, org: matches[0] };
}

const xero: OAuthAdapter = {
  provider: "xero",
  revokes: "the Xero access OASIS holds",
  exchange: (client, input, deps) =>
    basicTokenCall("Xero", XERO_TOKEN_URL, client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, deps, "exchange", null),
  refresh: (client, refreshToken, deps, signal) =>
    basicTokenCall("Xero", XERO_TOKEN_URL, client, { grant_type: "refresh_token", refresh_token: refreshToken }, deps, "refresh", refreshToken, signal),
  async identify(_client, grant, _query, deps) {
    const authEventId = xeroAuthEventId(grant.accessToken);
    const url = authEventId ? `${XERO_CONNECTIONS_URL}?authEventId=${encodeURIComponent(authEventId)}` : XERO_CONNECTIONS_URL;
    const r = await send(deps, url, {
      method: "GET",
      headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: "application/json" },
    });
    const orgs = xeroOrgs(r.body);
    if (r.status !== 200) throw new OAuthExchangeError("exchange_failed", `Xero would not list the organisation (HTTP ${r.status})`);
    // One OASIS workspace connects one Xero organisation: the one THIS consent
    // approved (xeroCurrentOrg), never an arbitrary pick off someone's whole
    // history, and never an arbitrary pick among several this ONE consent approved.
    const resolved = xeroCurrentOrg(orgs, authEventId);
    if (!resolved.ok) {
      throw new OAuthExchangeError(
        "account_unidentified",
        resolved.reason === "several"
          ? "This Xero sign-in covers several organisations; connect one organisation at a time"
          : "Xero did not say which organisation was connected",
      );
    }
    return { accountId: resolved.org.tenantId, accountLabel: resolved.org.tenantName, environment: null };
  },
  async probe(accessToken, accountId, deps) {
    const started = Date.now();
    const r = await send(deps, XERO_CONNECTIONS_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (r.status === 200) {
      const org = xeroOrgs(r.body).find((o) => o.tenantId === accountId);
      if (org) {
        return { verdict: "healthy", code: null, detail: null, latencyMs: Date.now() - started, accountId, accountLabel: org.tenantName, environment: null };
      }
      return {
        verdict: "down",
        code: "key_rejected",
        detail: "Xero no longer lists this organisation for OASIS's access (it was disconnected in Xero). Reconnect it.",
        latencyMs: Date.now() - started,
        accountId: null,
        accountLabel: null,
        environment: null,
      };
    }
    return probeFail("Xero", r, started, accountId);
  },
  async revoke(client, tokens, deps) {
    if (!tokens.refreshToken) return false;
    const r = await send(deps, XERO_REVOKE_URL, {
      method: "POST",
      headers: { ...FORM, Authorization: basic(client) },
      body: form({ token: tokens.refreshToken }),
    });
    return r.status === 200;
  },
};

// -- Zoom ----------------------------------------------------------------------------

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token";
const ZOOM_REVOKE_URL = "https://zoom.us/oauth/revoke";
const ZOOM_ME_URL = "https://api.zoom.us/v2/users/me";

function zoomIdentity(body: unknown): { accountId: string; label: string | null } | null {
  const o = asObj(body);
  const accountId = text(o?.account_id);
  if (!accountId) return null;
  return { accountId, label: text(o?.email) ?? text(o?.display_name) };
}

const zoom: OAuthAdapter = {
  provider: "zoom",
  revokes: "the Zoom access OASIS holds",
  exchange: (client, input, deps) =>
    basicTokenCall("Zoom", ZOOM_TOKEN_URL, client, { grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri }, deps, "exchange", null),
  refresh: (client, refreshToken, deps, signal) =>
    basicTokenCall("Zoom", ZOOM_TOKEN_URL, client, { grant_type: "refresh_token", refresh_token: refreshToken }, deps, "refresh", refreshToken, signal),
  async identify(_client, grant, _query, deps) {
    const r = await send(deps, ZOOM_ME_URL, { method: "GET", headers: { Authorization: `Bearer ${grant.accessToken}`, Accept: "application/json" } });
    const who = zoomIdentity(r.body);
    if (r.status !== 200 || !who) throw new OAuthExchangeError("account_unidentified", `Zoom did not say whose account this is (HTTP ${r.status})`);
    return { accountId: who.accountId, accountLabel: who.label, environment: null };
  },
  async probe(accessToken, accountId, deps) {
    const started = Date.now();
    const r = await send(deps, ZOOM_ME_URL, { method: "GET", headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    const who = zoomIdentity(r.body);
    if (r.status === 200 && who) {
      if (who.accountId !== accountId) {
        return {
          verdict: "down",
          code: "account_mismatch",
          detail: "This Zoom sign-in now belongs to a different Zoom account than the one connected. OASIS stopped using it. Disconnect and connect the right account.",
          latencyMs: Date.now() - started,
          accountId: null,
          accountLabel: null,
          environment: null,
        };
      }
      return { verdict: "healthy", code: null, detail: null, latencyMs: Date.now() - started, accountId, accountLabel: who.label, environment: null };
    }
    return probeFail("Zoom", r, started, accountId);
  },
  async revoke(client, tokens, deps) {
    const token = tokens.accessToken ?? tokens.refreshToken;
    if (!token) return false;
    const r = await send(deps, ZOOM_REVOKE_URL, {
      method: "POST",
      headers: { ...FORM, Authorization: basic(client) },
      body: form({ token }),
    });
    return r.status === 200;
  },
};

// -- WhatsApp (Meta) -------------------------------------------------------------------

const GRAPH = "https://graph.facebook.com/v23.0";
/** Meta keeps a long-lived token for about 60 days; used only when the answer omits expires_in. */
const META_DEFAULT_TOKEN_SEC = 60 * 24 * 60 * 60;

async function metaTokenCall(
  client: OAuthClient,
  values: Record<string, string>,
  deps: AdapterDeps,
  mode: "exchange" | "refresh",
  signal?: AbortSignal,
): Promise<{ token: string; expiresInSec: number }> {
  // Meta documents this as a GET; the app secret rides in the query string of
  // an HTTPS request to Meta and is never logged here.
  const url = `${GRAPH}/oauth/access_token?${form({ client_id: client.clientId, client_secret: client.clientSecret, ...values })}`;
  const r = await send(deps, url, { method: "GET", headers: { Accept: "application/json" } }, signal);
  const o = asObj(r.body);
  const token = text(o?.access_token);
  if (r.status === 200 && token) {
    const expiresIn = Number(o?.expires_in);
    return { token, expiresInSec: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : META_DEFAULT_TOKEN_SEC };
  }
  if (mode === "refresh") {
    // Meta answers HTTP 400 for rate limits too (OAuthException codes 4, 17, 32,
    // 613), so the status alone says nothing about the grant. Only a code that
    // means "this token is no longer valid" is a confirmed refusal (190 invalid
    // or expired token, 102 session invalid, subcodes 463 expired / 467
    // invalid); anything else is "could not refresh now" and never expires it.
    const err = asObj(o?.error);
    const code = Number(err?.code);
    const sub = Number(err?.error_subcode);
    if ((r.status === 400 || r.status === 401) && (code === 190 || code === 102 || sub === 463 || sub === 467)) {
      throw new RefreshRefusedError({ oauthError: "invalid_grant", httpStatus: r.status });
    }
    throw new Error(`WhatsApp token refresh could not be completed (HTTP ${r.status}${Number.isFinite(code) ? `, code ${code}` : ""})`);
  }
  throw new OAuthExchangeError("exchange_failed", `Meta refused the sign-in code (HTTP ${r.status})`);
}

async function metaExtend(client: OAuthClient, token: string, deps: AdapterDeps, mode: "exchange" | "refresh", signal?: AbortSignal): Promise<TokenGrant> {
  const longLived = await metaTokenCall(client, { grant_type: "fb_exchange_token", fb_exchange_token: token }, deps, mode, signal);
  // The long-lived token doubles as the "refresh token": Meta extends it by exchanging it again.
  return { accessToken: longLived.token, refreshToken: longLived.token, expiresInSec: longLived.expiresInSec };
}

function wabaFrom(body: unknown): string | null {
  const scopes = asObj(asObj(body)?.data)?.granular_scopes;
  if (!Array.isArray(scopes)) return null;
  for (const entry of scopes) {
    const o = asObj(entry);
    if (o?.scope !== "whatsapp_business_management" || !Array.isArray(o.target_ids)) continue;
    const id = o.target_ids.map((t) => String(t)).find((t) => /^\d{5,25}$/.test(t));
    if (id) return id;
  }
  return null;
}

async function wabaName(accessToken: string, wabaId: string, deps: AdapterDeps): Promise<Reply> {
  return send(deps, `${GRAPH}/${encodeURIComponent(wabaId)}?fields=name`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
}

const whatsapp: OAuthAdapter = {
  provider: "whatsapp",
  revokes: "the WhatsApp access OASIS holds",
  async exchange(client, input, deps) {
    const first = await metaTokenCall(client, { redirect_uri: input.redirectUri, code: input.code }, deps, "exchange");
    return metaExtend(client, first.token, deps, "exchange");
  },
  refresh: (client, currentToken, deps, signal) => metaExtend(client, currentToken, deps, "refresh", signal),
  async identify(client, grant, _query, deps) {
    const appToken = `${client.clientId}|${client.clientSecret}`;
    const debug = await send(deps, `${GRAPH}/debug_token?${form({ input_token: grant.accessToken })}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${appToken}`, Accept: "application/json" },
    });
    const wabaId = debug.status === 200 ? wabaFrom(debug.body) : null;
    if (!wabaId) throw new OAuthExchangeError("account_unidentified", "Meta did not say which WhatsApp Business Account was approved");
    const named = await wabaName(grant.accessToken, wabaId, deps);
    return { accountId: wabaId, accountLabel: text(asObj(named.body)?.name), environment: null };
  },
  async probe(accessToken, accountId, deps) {
    const started = Date.now();
    const r = await wabaName(accessToken, accountId, deps);
    const o = asObj(r.body);
    if (r.status === 200 && text(o?.id) === accountId) {
      return { verdict: "healthy", code: null, detail: null, latencyMs: Date.now() - started, accountId, accountLabel: text(o?.name), environment: null };
    }
    const code = Number(asObj(o?.error)?.code);
    if (code === 190 || code === 102) {
      return { verdict: "down", code: "key_rejected", detail: "Meta no longer accepts OASIS's access to this WhatsApp account (it was removed or the token expired). Reconnect it.", latencyMs: Date.now() - started, accountId: null, accountLabel: null, environment: null };
    }
    // A 400 about the object itself (code 100: it cannot be read) is a permission answer, not an outage.
    const failed = r.status === 400 && code === 100 ? ({ status: 403, body: r.body } as Reply) : r;
    return probeFail("WhatsApp", failed, started, accountId);
  },
  async revoke(_client, tokens, deps) {
    if (!tokens.accessToken) return false;
    const r = await send(deps, `${GRAPH}/me/permissions`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${tokens.accessToken}`, Accept: "application/json" },
    });
    return r.status === 200 && asObj(r.body)?.success === true;
  },
};

// -- Lookup ----------------------------------------------------------------------------

const ADAPTERS: Readonly<Record<string, OAuthAdapter>> = { quickbooks, xero, zoom, whatsapp };

/** The providers OASIS connects over its own OAuth app through the generic flow (Slack has its own install). */
export const OAUTH_CONNECT_PROVIDERS: readonly string[] = Object.keys(ADAPTERS);

export function oauthAdapterFor(provider: string): OAuthAdapter | null {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, provider) ? ADAPTERS[provider] : null;
}
