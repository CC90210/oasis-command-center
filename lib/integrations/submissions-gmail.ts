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
 * Resolve the SunBiz tenant's submissions credentials. Throws with a
 * machine-readable error code when either field is missing so the
 * caller can map it to the spec's testConnection() failure path.
 */
export async function getSubmissionsCreds(
  tenantId: string,
): Promise<SubmissionsCreds> {
  const cached = _credCache.get(tenantId);
  const now = Date.now();
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return { fromAddress: cached.from, appPassword: cached.appPassword };
  }
  const bundle = await getTenantIntegrationBundle(tenantId, "gws");
  const fromAddress = bundle.from_address?.trim();
  const appPassword = bundle.app_password?.trim();
  if (!fromAddress) throw new Error("missing_creds:gws.from_address");
  if (!appPassword) throw new Error("missing_creds:gws.app_password");
  _credCache.set(tenantId, { from: fromAddress, appPassword, cachedAt: now });
  return { fromAddress, appPassword };
}

/**
 * Drop the cached credentials for one tenant — used when the operator
 * rotates the app password and the next send should re-fetch.
 */
export function invalidateSubmissionsCreds(tenantId: string): void {
  _credCache.delete(tenantId);
}

/**
 * Open a transient SMTP connection and run a no-op auth verify against
 * Gmail's relay. Used by /run as a connection gate before any send
 * fires (spec section 8 item #1). Never throws — returns a discriminated
 * union the caller can JSON.stringify into a response.
 */
export async function testConnection(
  tenantId: string,
): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
  try {
    const creds = await getSubmissionsCreds(tenantId);
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
export async function getSubmissionsFrom(tenantId: string): Promise<string> {
  const creds = await getSubmissionsCreds(tenantId);
  return `SunBiz Submissions <${creds.fromAddress}>`;
}
