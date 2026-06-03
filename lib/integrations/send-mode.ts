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
 * True when the dashboard must NOT issue a live outbound request.
 *
 * Fail-safe default: dry-run UNLESS the operator has explicitly opted into
 * live sends via DASHBOARD_LIVE_SEND=1. BRAVO_FORCE_DRY_RUN=1 is a hard
 * override that re-clamps to dry-run even when live is enabled.
 */
export function isDryRun(): boolean {
  if ((process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1") return true;
  return (process.env.DASHBOARD_LIVE_SEND || "").trim() !== "1";
}
