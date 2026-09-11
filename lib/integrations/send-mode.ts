/**
 * lib/integrations/send-mode.ts — the single dry-run authority for every
 * dashboard outbound path (Kixie calls/SMS, TextTorrent SMS/blasts, the
 * legacy Twilio SMS route, and the Kixie/TT chat tools).
 *
 * Why this exists: the dashboard's send routes call the typed integration
 * clients DIRECTLY on Vercel — they never pass through the Python
 * send_gateway.py, so the BRAVO_FORCE_DRY_RUN flag that protects the VPS
 * daemons does NOT protect the dashboard. Before this gate, the shipped
 * drawer Call button (and any new send surface) fired live the moment a
 * tenant's Kixie/TT credentials were present.
 *
 * Decision (CC, 2026-06-02): the dashboard defaults to DRY-RUN. Going live
 * is an explicit, deliberate act — set DASHBOARD_LIVE_SEND=1 in the Vercel
 * project env. BRAVO_FORCE_DRY_RUN=1 always forces dry-run regardless, so
 * the same kill-switch the VPS uses also clamps the dashboard.
 *
 * This module is intentionally NOT marked `import "server-only"` — the
 * SendResult type is imported by client components for typing API
 * responses. `isDryRun()` reads process.env and is only ever called from
 * server route handlers / tool dispatchers; never call it client-side.
 */

import { tenantSlugForId } from "@/lib/email/brand-for-tenant";

/** Standard envelope every gated send path returns on the dry-run branch. */
export type SendResult = {
  ok: boolean;
  dry_run: boolean;
  /** "kixie" | "texttorrent" | "twilio" | ... */
  provider: string;
  /** Echo of what WOULD have been sent (no secrets) so the caller can log it. */
  would_send?: Record<string, unknown>;
  detail?: unknown;
  error?: string;
};

/**
 * Per-channel env override for live sends. Lets each point of contact go live
 * independently (e.g. TextTorrent live while Kixie/Twilio stay dry-run) instead
 * of one global flip. `LIVE_SEND_<CHANNEL>=1` → that channel is live; `=0` →
 * forced dry-run for that channel; unset → fall back to the global flag.
 */
const CHANNEL_LIVE_ENV: Record<string, string> = {
  texttorrent: "LIVE_SEND_TEXTTORRENT",
  texttorrent_followup: "LIVE_SEND_TEXTTORRENT_FOLLOWUP",
  kixie: "LIVE_SEND_KIXIE",
  twilio: "LIVE_SEND_TWILIO",
  gws: "LIVE_SEND_EMAIL",
  email: "LIVE_SEND_EMAIL",
  // Constant Contact gets its OWN flag so going live for CC blasts doesn't also
  // un-gate the Gmail / cold-outreach email channels.
  constant_contact: "LIVE_SEND_CONSTANT_CONTACT",
  // Smartlead cold-email: activating a campaign / pushing leads is gated separately.
  smartlead: "LIVE_SEND_SMARTLEAD",
};

/** Which tenant a send belongs to. Either field is enough; the slug names the flags. */
export type SendTenant = { tenantId?: string | null; tenantSlug?: string | null };

function flag(name: string): string {
  return (process.env[name] || "").trim();
}

/**
 * The env-name suffix for a tenant's own flags, or null when its slug is not
 * known. submissions → SUBMISSIONS, oasis-ai-cc → OASIS_AI_CC.
 *
 * The id is resolved through brand-for-tenant's map, not the database: a kill
 * switch must not hang on a lookup that can fail. An id that is supplied but
 * unmapped does NOT fall through to the slug — the same rule as brandForTenant,
 * because holding a primary key we do not recognise is when guessing is worst.
 */
export function tenantFlagSuffix(tenant?: SendTenant): string | null {
  const id = String(tenant?.tenantId ?? "").trim();
  const slug = id ? tenantSlugForId(id) : String(tenant?.tenantSlug ?? "").trim() || null;
  return slug ? slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_") : null;
}

/** BRAVO_FORCE_DRY_RUN__<SLUG>=1: this tenant sends nothing, on any path that asks. */
export function tenantForcedDryRun(tenant?: SendTenant): boolean {
  const suffix = tenantFlagSuffix(tenant);
  return suffix !== null && flag(`BRAVO_FORCE_DRY_RUN__${suffix}`) === "1";
}

/**
 * True when the dashboard must NOT issue a live outbound request.
 *
 * Precedence (fail-safe → dry-run by default):
 *   1. BRAVO_FORCE_DRY_RUN=1 — hard kill-switch, always clamps to dry-run.
 *   2. The TENANT's own flags, when `tenant` is given and its slug is known:
 *        BRAVO_FORCE_DRY_RUN__<SLUG>=1       — that tenant is always dry-run;
 *        LIVE_SEND_<CHANNEL>__<SLUG>  1 / 0  — that tenant's channel live / dry;
 *        DASHBOARD_LIVE_SEND__<SLUG>  1 / 0  — that tenant live / dry.
 *   3. Per-channel LIVE_SEND_<CHANNEL> — "1" = live, "0" = dry, for that channel.
 *   4. Global DASHBOARD_LIVE_SEND=1 — live for any channel without its own flag.
 *   5. Otherwise dry-run.
 *
 * WHY step 2 (2026-09-11). These flags are Vercel env, one set for the whole
 * deployment, and OASIS and SunBiz both send through it, so going live for one
 * company went live for the other. A tenant's own flag now wins over the shared
 * one. With no per-tenant flag set the answer is exactly what it was before.
 *
 * `channel` and `tenant` are optional so legacy callers keep the global behavior.
 */
export function isDryRun(channel?: string, tenant?: SendTenant): boolean {
  if ((process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1") return true;
  const suffix = tenantFlagSuffix(tenant);
  if (suffix) {
    if (tenantForcedDryRun(tenant)) return true;
    const channelKey = channel ? CHANNEL_LIVE_ENV[channel.toLowerCase()] : undefined;
    const own = channelKey ? flag(`${channelKey}__${suffix}`) : "";
    if (own === "1") return false; // this tenant's channel explicitly live
    if (own === "0") return true; // this tenant's channel explicitly dry-run
    const all = flag(`DASHBOARD_LIVE_SEND__${suffix}`);
    if (all === "1") return false; // this tenant explicitly live
    if (all === "0") return true; // this tenant explicitly dry-run
  }
  if (channel) {
    const envKey = CHANNEL_LIVE_ENV[channel.toLowerCase()];
    const v = envKey ? (process.env[envKey] || "").trim() : "";
    if (v === "1") return false; // channel explicitly live
    if (v === "0") return true; // channel explicitly clamped to dry-run
  }
  return (process.env.DASHBOARD_LIVE_SEND || "").trim() !== "1";
}

/**
 * DRIPS_LIVE, the drip engine's go-live act, for one tenant.
 *
 * DRIPS_LIVE__<SLUG>=0 keeps that tenant's drips dry while the shared switch is
 * on, so SunBiz can stay live while OASIS rehearses, or the reverse. It can
 * only turn a tenant OFF. The executor sizes its hourly cap, provider checks
 * and email budget once per run from the shared switch, so a tenant switched on
 * alone would send with none of those computed. With no per-tenant flag the
 * answer is exactly `DRIPS_LIVE === "1"`, as before.
 */
export function isDripsLive(tenant?: SendTenant): boolean {
  if (process.env.DRIPS_LIVE !== "1") return false;
  const suffix = tenantFlagSuffix(tenant);
  return !(suffix && flag(`DRIPS_LIVE__${suffix}`) === "0");
}
