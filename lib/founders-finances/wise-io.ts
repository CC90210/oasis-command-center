/**
 * Wise REST access for Finances — OASIS's business profile, READ-ONLY.
 *
 * CONFIG: WISE_API_TOKEN + WISE_PROFILE_ID (env; pushed to the Worker from
 * Bravo's store). Either missing -> WiseNotReady("wise_not_configured") with a
 * sentence a founder can act on; nothing here falls back to a guess. The
 * token is never logged or returned.
 *
 * Every call is a GET. Nothing in the command center moves money through
 * Wise: invoices print the receiving details, clients push the money,
 * wise-reconcile.ts matches what arrived to invoices, and wise-feed-io.ts
 * brings the whole statement into the register.
 *
 * Endpoints (probed live 2026-09-24, see wise.ts for the shapes):
 *   GET /v2/profiles                                   profile name
 *   GET /v4/profiles/{p}/balances?types=STANDARD        balance ids + amounts
 *   GET /v1/profiles/{p}/balance-statements/{b}/statement.json
 *                                                      labelled receiving details
 *                                                      + incoming transactions
 * A 403 carrying x-2fa-approval means Wise wants Strong Customer
 * Authentication for that call — a plain token cannot do it, so it is
 * reported as such rather than retried.
 */
import "server-only";

import {
  depositsFromStatement,
  receivingDetailsFromStatement,
  wiseValueToCents,
  type WiseDeposit,
  type WiseReceivingDetails,
} from "./wise";

const BASE_URL = "https://api.transferwise.com";
const USER_AGENT = "oasis-command-center-finances/1.0";
const DETAILS_TTL_MS = 30 * 60_000;
const BALANCES_TTL_MS = 60_000;

export type WiseNotReadyCode = "wise_not_configured" | "wise_denied" | "wise_sca_required" | "wise_unreachable" | "wise_no_balance";

export class WiseNotReady extends Error {
  code: WiseNotReadyCode;
  constructor(code: WiseNotReadyCode, message: string) {
    super(message);
    this.name = "WiseNotReady";
    this.code = code;
  }
}

export function wiseConfig(): { token: string; profileId: string } | null {
  const token = (process.env.WISE_API_TOKEN || "").trim();
  const profileId = (process.env.WISE_PROFILE_ID || "").trim();
  return token && /^\d+$/.test(profileId) ? { token, profileId } : null;
}

const NOT_CONFIGURED = "Wise isn't connected yet, so invoices go out with the card link and your payment instructions.";

function requireConfig(): { token: string; profileId: string } {
  const cfg = wiseConfig();
  if (!cfg) throw new WiseNotReady("wise_not_configured", NOT_CONFIGURED);
  return cfg;
}

export async function wiseRequest(path: string, params: Record<string, string | number> = {}): Promise<unknown> {
  const { token } = requireConfig();
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  // Founder-facing messages are plain sentences; the route, status and error
  // detail go to the server log only.
  const route = path.replace(/\/\d+/g, "/{id}");
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}${qs ? `?${qs}` : ""}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": USER_AGENT },
      cache: "no-store",
      signal: controller.signal,
    });
  } catch (e) {
    console.error("[wise-io] request failed", { route, error: e instanceof Error ? e.message.slice(0, 200) : String(e) });
    throw new WiseNotReady("wise_unreachable", "Couldn't reach Wise just now. Try again in a minute.");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403 && res.headers.get("x-2fa-approval")) {
    console.error("[wise-io] strong customer authentication required", { route });
    throw new WiseNotReady("wise_sca_required", "Wise wants an extra security approval for this request, which an API connection can't give.");
  }
  if (res.status === 401 || res.status === 403) {
    console.error("[wise-io] token refused", { route, status: res.status });
    throw new WiseNotReady("wise_denied", "Wise didn't accept the connection key. It may have expired, so a new Wise API token is needed.");
  }
  const body = await res.json().catch(() => null);
  if (!res.ok || body === null) {
    console.error("[wise-io] unexpected response", { route, status: res.status });
    throw new WiseNotReady("wise_unreachable", "Wise had a problem answering. Try again in a minute.");
  }
  return body;
}

// ── per-isolate caches ───────────────────────────────────────────────────

type Cached<T> = { at: number; value: T };
const detailsCache = new Map<string, Cached<WiseReceivingDetails>>();
let balancesCache: Cached<WiseBalance[]> | null = null;
let profileCache: Cached<string | null> | null = null;

export function resetWiseCache(): void {
  detailsCache.clear();
  balancesCache = null;
  profileCache = null;
}

export type WiseBalance = { id: number; currency: string; cents: number };

export async function wiseBalances(): Promise<WiseBalance[]> {
  if (balancesCache && Date.now() - balancesCache.at < BALANCES_TTL_MS) return balancesCache.value;
  const { profileId } = requireConfig();
  const raw = await wiseRequest(`/v4/profiles/${profileId}/balances`, { types: "STANDARD" });
  const list = (Array.isArray(raw) ? raw : [])
    .map((b) => (b && typeof b === "object" ? (b as Record<string, unknown>) : null))
    .filter((b): b is Record<string, unknown> => b !== null && typeof b.id === "number" && typeof b.currency === "string")
    .map((b) => ({
      id: b.id as number,
      currency: b.currency as string,
      cents: wiseValueToCents((b.amount as Record<string, unknown> | undefined)?.value) ?? 0,
    }));
  balancesCache = { at: Date.now(), value: list };
  return list;
}

export async function wiseProfileName(): Promise<string | null> {
  if (profileCache && Date.now() - profileCache.at < DETAILS_TTL_MS) return profileCache.value;
  const { profileId } = requireConfig();
  const raw = await wiseRequest(`/v2/profiles`);
  const mine = (Array.isArray(raw) ? raw : []).find((p) => p && typeof p === "object" && String((p as Record<string, unknown>).id) === profileId) as
    | Record<string, unknown>
    | undefined;
  if (!mine) {
    console.error("[wise-io] configured profile not visible to the token", { profileId });
    throw new WiseNotReady("wise_denied", "The Wise connection points at a profile it can't see. It needs the OASIS business profile.");
  }
  const name = (typeof mine.businessName === "string" && mine.businessName) || (typeof mine.fullName === "string" && mine.fullName) || null;
  profileCache = { at: Date.now(), value: name };
  return name;
}

/**
 * One currency's balance statement between two instants (an end in the
 * future is clamped to now). Carries the labelled receiving details AND every
 * transaction with its running balance — the invoice details, the deposit
 * reconcile and the bank feed (wise-feed-io.ts) all read it.
 */
export async function wiseStatement(currency: string, fromIso: string, toIso: string): Promise<unknown> {
  const { profileId } = requireConfig();
  const balance = (await wiseBalances()).find((b) => b.currency === currency);
  if (!balance) throw new WiseNotReady("wise_no_balance", `The Wise business account has no ${currency} balance to receive into.`);
  const now = new Date().toISOString();
  return wiseRequest(`/v1/profiles/${profileId}/balance-statements/${balance.id}/statement.json`, {
    currency,
    intervalStart: fromIso,
    intervalEnd: toIso > now ? now : toIso,
    type: "COMPACT",
  });
}

/** The bank details a client pays `currency` into. Cached per isolate (30 min). Throws WiseNotReady. */
export async function receivingDetails(currency: string): Promise<WiseReceivingDetails> {
  const cur = currency.toUpperCase();
  const hit = detailsCache.get(cur);
  if (hit && Date.now() - hit.at < DETAILS_TTL_MS) return hit.value;
  const now = Date.now();
  const stmt = await wiseStatement(cur, new Date(now - 86_400_000).toISOString(), new Date(now).toISOString());
  const details = receivingDetailsFromStatement(stmt, cur);
  if (!details) throw new WiseNotReady("wise_no_balance", `Wise returned no current ${cur} receiving details for the business account.`);
  detailsCache.set(cur, { at: Date.now(), value: details });
  return details;
}

export async function receivingDetailsOrReason(
  currency: string,
): Promise<{ ok: true; details: WiseReceivingDetails } | { ok: false; code: WiseNotReadyCode; reason: string }> {
  try {
    return { ok: true, details: await receivingDetails(currency) };
  } catch (e) {
    if (e instanceof WiseNotReady) return { ok: false, code: e.code, reason: e.message };
    throw e;
  }
}

/** Client deposits (bank transfers in, Wise-acquired card payments) into CAD and USD over the last `days`. */
export async function recentWiseDeposits(days: number): Promise<WiseDeposit[]> {
  const span = Math.max(1, Math.min(120, Math.trunc(days)));
  const now = Date.now();
  const from = new Date(now - span * 86_400_000).toISOString();
  const to = new Date(now).toISOString();
  const out: WiseDeposit[] = [];
  for (const cur of ["CAD", "USD"]) {
    try {
      out.push(...depositsFromStatement(await wiseStatement(cur, from, to)));
    } catch (e) {
      if (e instanceof WiseNotReady && e.code === "wise_no_balance") continue;
      throw e;
    }
  }
  return out;
}

export type WiseStatus = {
  configured: boolean;
  ready: boolean;
  profileName: string | null;
  balances: Array<{ currency: string; cents: number }>;
  details: Record<string, WiseReceivingDetails | null>;
  /** Why a currency has no details, per currency, when it has none. */
  detailIssues: Record<string, string>;
  error: string | null;
};

export async function wiseStatus(): Promise<WiseStatus> {
  const base: WiseStatus = { configured: wiseConfig() !== null, ready: false, profileName: null, balances: [], details: {}, detailIssues: {}, error: null };
  if (!base.configured) return { ...base, error: NOT_CONFIGURED };
  try {
    const [profileName, balances] = await Promise.all([wiseProfileName(), wiseBalances()]);
    const details: Record<string, WiseReceivingDetails | null> = {};
    const detailIssues: Record<string, string> = {};
    for (const cur of ["CAD", "USD"]) {
      const r = await receivingDetailsOrReason(cur);
      details[cur] = r.ok ? r.details : null;
      if (!r.ok) detailIssues[cur] = r.reason;
    }
    return {
      ...base,
      ready: Object.values(details).some(Boolean),
      profileName,
      balances: balances.filter((b) => b.cents !== 0 || b.currency === "CAD" || b.currency === "USD").map((b) => ({ currency: b.currency, cents: b.cents })),
      details,
      detailIssues,
    };
  } catch (e) {
    return { ...base, error: e instanceof Error ? e.message : "Wise check failed" };
  }
}
