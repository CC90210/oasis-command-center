/**
 * Stripe REST access for Finances — OASIS's OWN Stripe account only.
 *
 * KEY SOURCE: the same path the command center already uses for OASIS's
 * Stripe (lib/tenant-integration-store.ts getTenantIntegrationValue, service
 * "stripe", field "secret_key", which falls back to STRIPE_SECRET_KEY), read
 * for the founders' own workspace tenant (first id in FOUNDERS_TENANT_IDS).
 *
 * ACCOUNT PIN — WHY. Several Stripe accounts exist around this business
 * (OASIS, Trytan's Arthrisil store, PropFlow, the oasis-store). A key is just
 * a string; nothing about it says whose it is. So before Finances creates a
 * payment link or backfills anything, it asks Stripe GET /v1/account which
 * account the key belongs to and compares it with the account a founder
 * pinned in Finances > Settings. Unpinned or different -> refuse, loudly.
 * The webhook does not need the pin to RECORD events (its signing secret is
 * per-endpoint, created inside OASIS's dashboard), only to fetch fees.
 *
 * Plain fetch against the REST API, form-encoded, like
 * lib/website-sales-payment.ts. The key is never logged or returned.
 */
import "server-only";

import { getTenantIntegrationValue } from "@/lib/tenant-integration-store";
import { parseFoundersAllowlist } from "@/lib/founders-marketing-core";
import { BUSINESS_ENTITY_ID } from "./chart";
import { queryOne } from "./db";
import { asObj } from "./stripe-map";

type Obj = Record<string, unknown>;

export class StripeNotReady extends Error {
  code: "stripe_key_missing" | "stripe_account_unpinned" | "stripe_account_mismatch" | "stripe_account_unreachable";
  accountId: string | null;
  constructor(code: StripeNotReady["code"], message: string, accountId: string | null = null) {
    super(message);
    this.name = "StripeNotReady";
    this.code = code;
    this.accountId = accountId;
  }
}

export class StripeApiError extends Error {
  status: number;
  stripeCode: string | null;
  constructor(status: number, stripeCode: string | null, message: string) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
    this.stripeCode = stripeCode;
  }
}

export function financeTenantId(): string | null {
  return parseFoundersAllowlist(process.env.FOUNDERS_TENANT_IDS)[0] ?? null;
}

export async function stripeSecretKey(): Promise<string | null> {
  const tenantId = financeTenantId();
  if (tenantId) return getTenantIntegrationValue(tenantId, "stripe", "secret_key");
  const env = (process.env.STRIPE_SECRET_KEY || "").trim();
  return env || null;
}

export type StripeFetch = typeof fetch;

function encode(params: Record<string, string | number | boolean | undefined | null> | URLSearchParams | undefined): string {
  if (!params) return "";
  if (params instanceof URLSearchParams) return params.toString();
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.append(k, String(v));
  return u.toString();
}

export async function stripeRequest(
  key: string,
  method: "GET" | "POST",
  path: string,
  params?: Record<string, string | number | boolean | undefined | null> | URLSearchParams,
  opts: { idempotencyKey?: string; fetchImpl?: StripeFetch } = {},
): Promise<Obj> {
  const qs = encode(params);
  const url = `https://api.stripe.com${path}${method === "GET" && qs ? `${path.includes("?") ? "&" : "?"}${qs}` : ""}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await (opts.fetchImpl ?? fetch)(url, {
      method,
      headers,
      body: method === "POST" ? qs : undefined,
      cache: "no-store",
      signal: controller.signal,
    });
    const body = asObj(await res.json().catch(() => null));
    if (!res.ok || !body) {
      const err = asObj(body?.error);
      throw new StripeApiError(
        res.status,
        typeof err?.code === "string" ? err.code : null,
        `Stripe ${method} ${path.split("?")[0]} failed: HTTP ${res.status}${typeof err?.message === "string" ? ` — ${err.message.slice(0, 200)}` : ""}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

let accountCache: { keyTail: string; at: number; account: { id: string; name: string | null } } | null = null;

export async function stripeAccountForKey(key: string): Promise<{ id: string; name: string | null }> {
  const tail = key.slice(-6);
  if (accountCache && accountCache.keyTail === tail && Date.now() - accountCache.at < 10 * 60_000) return accountCache.account;
  const acct = await stripeRequest(key, "GET", "/v1/account");
  const id = typeof acct.id === "string" ? acct.id : "";
  if (!id.startsWith("acct_")) throw new StripeNotReady("stripe_account_unreachable", "Stripe did not return an account id for this key");
  const settings = asObj(acct.settings);
  const dashboard = asObj(settings?.dashboard);
  const profile = asObj(acct.business_profile);
  const name =
    (typeof dashboard?.display_name === "string" && dashboard.display_name) ||
    (typeof profile?.name === "string" && profile.name) ||
    null;
  accountCache = { keyTail: tail, at: Date.now(), account: { id, name } };
  return accountCache.account;
}

export async function pinnedStripeAccount(entityId = BUSINESS_ENTITY_ID): Promise<string | null> {
  const row = await queryOne<{ stripe_account_id: string | null }>(
    `SELECT stripe_account_id FROM fin_settings WHERE entity_id = ?`,
    [entityId],
  );
  return row?.stripe_account_id || null;
}

/** Key + account, verified against the founder-pinned account. Throws StripeNotReady. */
export async function getStripeClient(): Promise<{ key: string; accountId: string }> {
  const key = await stripeSecretKey();
  if (!key) {
    throw new StripeNotReady(
      "stripe_key_missing",
      "No Stripe secret key for the founders' workspace (tenant integration 'stripe' / STRIPE_SECRET_KEY).",
    );
  }
  let account: { id: string; name: string | null };
  try {
    account = await stripeAccountForKey(key);
  } catch (e) {
    if (e instanceof StripeNotReady) throw e;
    throw new StripeNotReady("stripe_account_unreachable", `Could not verify the Stripe account: ${e instanceof Error ? e.message : "error"}`);
  }
  const pinned = await pinnedStripeAccount();
  if (!pinned) {
    throw new StripeNotReady(
      "stripe_account_unpinned",
      `The Stripe key belongs to ${account.id}${account.name ? ` (${account.name})` : ""}. Confirm it is OASIS's own account in Finances > Settings before Finances uses it.`,
      account.id,
    );
  }
  if (pinned !== account.id) {
    throw new StripeNotReady(
      "stripe_account_mismatch",
      `The Stripe key belongs to ${account.id}, but Finances is pinned to ${pinned}. Refusing to use another company's Stripe account.`,
      account.id,
    );
  }
  return { key, accountId: account.id };
}

export type StripeConnection = {
  keyPresent: boolean;
  accountId: string | null;
  accountName: string | null;
  pinned: string | null;
  ready: boolean;
  error: string | null;
};

export async function stripeConnectionStatus(): Promise<StripeConnection> {
  const pinned = await pinnedStripeAccount();
  const key = await stripeSecretKey().catch(() => null);
  if (!key) return { keyPresent: false, accountId: null, accountName: null, pinned, ready: false, error: "no Stripe key configured" };
  try {
    const a = await stripeAccountForKey(key);
    return { keyPresent: true, accountId: a.id, accountName: a.name, pinned, ready: pinned === a.id, error: null };
  } catch (e) {
    return { keyPresent: true, accountId: null, accountName: null, pinned, ready: false, error: e instanceof Error ? e.message : "error" };
  }
}

/** Page through a Stripe list endpoint. Bounded so a reconcile always ends. */
export async function listAll(
  key: string,
  path: string,
  params: Record<string, string | number>,
  opts: { maxPages?: number; expand?: string[] } = {},
): Promise<{ items: Obj[]; truncated: boolean }> {
  const items: Obj[] = [];
  let startingAfter: string | null = null;
  const maxPages = opts.maxPages ?? 50;
  for (let page = 0; page < maxPages; page++) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) u.append(k, String(v));
    u.set("limit", "100");
    for (const e of opts.expand || []) u.append("expand[]", e);
    if (startingAfter) u.set("starting_after", startingAfter);
    const res = await stripeRequest(key, "GET", path, u);
    const data = Array.isArray(res.data) ? (res.data as unknown[]).map(asObj).filter((x): x is Obj => x !== null) : [];
    items.push(...data);
    if (res.has_more !== true || data.length === 0) return { items, truncated: false };
    const last = data[data.length - 1];
    startingAfter = typeof last.id === "string" ? last.id : null;
    if (!startingAfter) break;
  }
  return { items, truncated: true };
}
