/**
 * Submissions account Gmail SMTP — Adon spec section 4 (2026-06-10),
 * pivoted to App Password auth (2026-06-10 PM).
 *
 * Server-only. Resolves the submissions@sunbizfunding.com credentials
 * from per-tenant encrypted storage and connects via Gmail's SMTP relay
 * (smtp.gmail.com:587 STARTTLS). The existing tenant_integration_credentials
 * table holds `gws.app_password` + `gws.from_address` encrypted with
 * BRAVO_FIELD_ENCRYPTION_KEY — this is what Matt provisioned weeks ago
 * via Settings → Integrations.
 *
 * Why SMTP not OAuth: Adon's spec originally specified Gmail API + OAuth
 * (CLIENT_ID / CLIENT_SECRET / REFRESH_TOKEN), but the operator's actual
 * infrastructure uses Gmail App Passwords. Pivoting matches reality —
 * fewer env vars to provision, immediate compatibility with the
 * existing operator flow, and no separate OAuth dance.
 *
 * Gmail threading without the API:
 *   Gmail's MIME-level threading is driven by RFC2822 Message-ID +
 *   References + In-Reply-To headers. Even via plain SMTP, a thread is
 *   pinned by these headers — both Gmail's web UI and any standards-
 *   compliant client groups the replies. We synthesize Message-IDs
 *   ourselves (deterministic, audit-friendly) and persist the chain in
 *   application_lender_threads.message_id_history.
 *
 * Required tenant_integration_credentials rows for the SunBiz tenant:
 *   service='gws', field_key='app_password'   (Gmail App Password)
 *   service='gws', field_key='from_address'   (submissions@sunbizfunding.com)
 *
 * Both already provisioned for tenant aa04fa1f-…; verified via supabase
 * query at pivot time.
 */

import "server-only";
import { getTenantIntegrationBundle } from "@/lib/tenant-integration-store";
import { getBrand, resolveBrandKey, type BrandKey } from "@/lib/email/brands";

/** Cached per-tenant credentials so a burst of N sends does N=1 decrypts. */
const _credCache = new Map<
  string,
  { from: string; appPassword: string; cachedAt: number }
>();

/** 5 minutes — long enough to amortize a batch run, short enough to pick
 *  up a credential rotation within the same shop-out shift. */
const CACHE_TTL_MS = 5 * 60 * 1000;

export type SubmissionsCreds = {
  fromAddress: string;
  appPassword: string;
};

/**
 * Resolve a tenant's submissions credentials for one BRAND. Throws with a
 * machine-readable error code when either field is missing so the
 * caller can map it to the spec's testConnection() failure path.
 *
 * THE BRAND ARGUMENT IS WHAT ACTUALLY MOVES THE MAIL (2026-08-05).
 * The From header and the SMTP auth user both come from here, not from
 * DRIP_FROM_ADDRESS. Before this, setting a brand env var relabelled the
 * unsubscribe mailto and Message-Id while the message was still authenticated
 * and DKIM-signed by the SunBiz mailbox, so the visible sender disagreed with
 * the signature. To a receiver that is the shape of forgery, and it is a worse
 * position than never cutting over.
 *
 * Omitting `brand` resolves to SunBiz — the pre-existing behaviour, and what
 * every lender shop-out caller does. Lender mail is SunBiz always, whatever
 * brand the merchant sits on, so it simply never passes this argument.
 *
 * FAILS CLOSED. A missing Bluerise credential throws rather than falling back
 * to the SunBiz mailbox, because that fallback would send Bluerise copy from
 * the SunBiz mailbox: exactly the misalignment this exists to prevent.
 */
export async function getSubmissionsCreds(
  tenantId: string,
  brand?: BrandKey,
): Promise<SubmissionsCreds> {
  const service = getBrand(resolveBrandKey(brand)).credentialService;
  // The cache key MUST include the service, or the first brand to send in a
  // 5-minute window pins its mailbox for the other one.
  const cacheKey = `${tenantId}:${service}`;
  const cached = _credCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return { fromAddress: cached.from, appPassword: cached.appPassword };
  }
  const bundle = await getTenantIntegrationBundle(tenantId, service);
  const fromAddress = bundle.from_address?.trim();
  // Strip ALL whitespace, not just the ends. Google displays app passwords as
  // four spaced groups, and the value stored on 2026-07-02 was saved that way —
  // 19 characters for a 16-character secret.
  //
  // That matters because the two IMAP crons already stripped interior spaces
  // while all five SMTP call sites passed the value straight through. A spaced
  // password therefore let inbox reading work while every send returned 535:
  // the channel looks half-alive and the failure reads as a credential problem
  // that is really a formatting one. Normalising here means all consumers
  // inherit it instead of each remembering.
  const appPassword = bundle.app_password?.replace(/\s+/g, "");
  if (!fromAddress) throw new Error(`missing_creds:${service}.from_address`);
  if (!appPassword) throw new Error(`missing_creds:${service}.app_password`);
  _credCache.set(cacheKey, { from: fromAddress, appPassword, cachedAt: now });
  return { fromAddress, appPassword };
}

/**
 * Drop the cached credentials for one tenant — used when the operator
 * rotates the app password and the next send should re-fetch.
 */
export function invalidateSubmissionsCreds(tenantId: string, brand?: BrandKey): void {
  if (brand !== undefined) {
    _credCache.delete(`${tenantId}:${getBrand(resolveBrandKey(brand)).credentialService}`);
    return;
  }
  // No brand given: clear EVERY brand for this tenant. A rotation that only
  // cleared one brand would leave the other serving a stale password until the
  // TTL expired, which presents as intermittent auth failures.
  for (const key of Array.from(_credCache.keys())) {
    if (key.startsWith(`${tenantId}:`)) _credCache.delete(key);
  }
}

/**
 * Open a transient SMTP connection and run a no-op auth verify against
 * Gmail's relay. Used by /run as a connection gate before any send
 * fires (spec section 8 item #1). Never throws — returns a discriminated
 * union the caller can JSON.stringify into a response.
 */
export async function testConnection(
  tenantId: string,
  brand?: BrandKey,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  try {
    const creds = await getSubmissionsCreds(tenantId, brand);
    const nodemailer = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // STARTTLS — nodemailer upgrades after EHLO.
      requireTLS: true,
      auth: { user: creds.fromAddress, pass: creds.appPassword },
    });
    await transporter.verify();
    return { ok: true, email: creds.fromAddress };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "unknown_connection_error",
    };
  }
}

/**
 * Build the From: header. Cached per-tenant for the same lifecycle as
 * the credentials.
 */
export async function getSubmissionsFrom(
  tenantId: string,
  brand?: BrandKey,
): Promise<string> {
  const key = resolveBrandKey(brand);
  const creds = await getSubmissionsCreds(tenantId, key);
  // The display name follows the brand. With no brand this stays the literal
  // "SunBiz Submissions" it has always been, which is what lender shop-out mail
  // relies on — that mail is SunBiz whatever brand the merchant sits on.
  const label = key === "sunbiz" ? "SunBiz Submissions" : getBrand(key).displayName;
  return `${label} <${creds.fromAddress}>`;
}
