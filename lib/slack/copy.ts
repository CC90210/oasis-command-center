/**
 * lib/slack/copy.ts - the sentence Settings > Chat apps shows after an install
 * attempt comes back (?slack=connected|denied|error&reason=<code>).
 *
 * The query string is attacker-reachable, so only KNOWN codes turn into words;
 * anything else is a generic sentence, and the raw value is never shown.
 */

const REASONS: Readonly<Record<string, string>> = {
  not_configured: "OASIS's Slack app is not set up on this deployment yet.",
  state_invalid: "The install link expired or was already used. Start again from this page.",
  state_replayed_or_unknown: "The install link expired or was already used. Start again from this page.",
  state_expired: "The install took longer than ten minutes. Start again from this page.",
  state_secret_missing: "OASIS's Slack app is not fully set up on this deployment yet.",
  app_credentials_missing: "OASIS's Slack app is not fully set up on this deployment yet.",
  wrong_person: "The install was started by someone else or in another workspace. Start again from this page.",
  signed_out_or_not_allowed: "Only a signed-in owner or admin can finish installing Slack.",
  exchange_failed: "Slack did not confirm the install. Start again from this page.",
  not_a_bot_token: "Slack did not give OASIS the app permissions it needs. Start again and allow them.",
  enterprise_install_unsupported: "Installing across a whole Slack Enterprise Grid is not supported yet. Install it in one workspace.",
  team_connected_elsewhere: "That Slack workspace is already connected to another OASIS workspace. Disconnect it there first.",
  another_team_connected: "A different Slack workspace is already connected here. Disconnect it first.",
  token_save_failed: "OASIS could not save Slack's token, so nothing was connected. Try again.",
  missing_code: "Slack sent the browser back without an install code. Start again from this page.",
  no_install_flow: "That app cannot be installed from here.",
  app_url_missing: "This deployment does not know its own address, so Slack cannot send the browser back. Tell OASIS support.",
};

export function slackInstallBanner(status: unknown, reason: unknown): { ok: boolean; text: string } | null {
  const s = typeof status === "string" ? status : null;
  if (s === "connected") return { ok: true, text: "Slack is connected. Map your channels below." };
  if (s === "denied") return { ok: false, text: "The install was cancelled in Slack. Nothing was connected." };
  if (s === "error") {
    const r = typeof reason === "string" ? reason : "";
    return { ok: false, text: REASONS[r] ?? "Slack could not be connected. Start again from this page." };
  }
  return null;
}
