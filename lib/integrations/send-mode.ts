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
 * Per-channel env override for live sends. Lets each point of contact go live
 * independently (e.g. TextTorrent live while Kixie/Twilio stay dry-run) instead
 * of one global flip. `LIVE_SEND_<CHANNEL>=1` → that channel is live; `=0` →
 * forced dry-run for that channel; unset → fall back to the global flag.
 */
const CHANNEL_LIVE_ENV: Record<string, string> = {
  texttorrent: "LIVE_SEND_TEXTTORRENT",
  kixie: "LIVE_SEND_KIXIE",
  twilio: "LIVE_SEND_TWILIO",
  gws: "LIVE_SEND_EMAIL",
  email: "LIVE_SEND_EMAIL",
  // Constant Contact gets its OWN flag so going live for CC blasts doesn't also
  // un-gate the Gmail / cold-outreach email channels.
  constant_contact: "LIVE_SEND_CONSTANT_CONTACT",
};

/**
 * True when the dashboard must NOT issue a live outbound request.
 *
 * Precedence (fail-safe → dry-run by default):
 *   1. BRAVO_FORCE_DRY_RUN=1 — hard kill-switch, always clamps to dry-run.
 *   2. Per-channel LIVE_SEND_<CHANNEL> — "1" = live, "0" = dry, for that channel.
 *   3. Global DASHBOARD_LIVE_SEND=1 — live for any channel without its own flag.
 *   4. Otherwise dry-run.
 *
 * `channel` is optional so legacy callers (no channel) keep the global behavior.
 */
export function isDryRun(channel?: string): boolean {
  if ((process.env.BRAVO_FORCE_DRY_RUN || "").trim() === "1") return true;
  if (channel) {
    const envKey = CHANNEL_LIVE_ENV[channel.toLowerCase()];
    const v = envKey ? (process.env[envKey] || "").trim() : "";
    if (v === "1") return false; // channel explicitly live
    if (v === "0") return true; // channel explicitly clamped to dry-run
  }
  return (process.env.DASHBOARD_LIVE_SEND || "").trim() !== "1";
}
