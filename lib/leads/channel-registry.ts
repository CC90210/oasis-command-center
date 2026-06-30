/**
 * lib/leads/channel-registry.ts — the per-lead outbound channels surfaced in the
 * lead drawer.
 *
 * Config-driven on purpose: enabling Twilio later is a single `enabled` flip (or
 * an env gate), not a drawer refactor. The send paths already exist —
 *   email        → POST /api/leads/[id]/email      (operator Gmail, then submissions@)
 *   texttorrent  → POST /api/leads/[id]/texttorrent (direct 1:1 via sendSms)
 *   twilio       → lib/sms-direct-twilio.sendSmsDirectTwilio (built, gated OFF)
 * so the registry is the one place that decides which appear in the UI.
 */

export type LeadChannelId = "email" | "texttorrent" | "twilio";

export type LeadChannel = {
  id: LeadChannelId;
  label: string;
  /** false = built but not surfaced yet (the gate). Twilio ships false. */
  enabled: boolean;
  /** Lead field required for this channel to apply. */
  requires: "email" | "phone";
};

export const LEAD_CHANNELS: LeadChannel[] = [
  { id: "email", label: "Email", enabled: true, requires: "email" },
  { id: "texttorrent", label: "Text Torrent", enabled: true, requires: "phone" },
  // Twilio per-lead SMS — sendSmsDirectTwilio + tenantHasDirectTwilio already
  // exist. Flip enabled:true (or gate via TENANT flag) when Twilio goes live.
  { id: "twilio", label: "Twilio SMS", enabled: false, requires: "phone" },
];

/** Channels active for a lead given the contact fields it has on file. */
export function activeLeadChannels(opts: { hasEmail: boolean; hasPhone: boolean }): LeadChannel[] {
  return LEAD_CHANNELS.filter(
    (c) => c.enabled && (c.requires === "email" ? opts.hasEmail : opts.hasPhone),
  );
}

/** Whether a given channel is currently enabled (single source of truth for the gate). */
export function isLeadChannelEnabled(id: LeadChannelId): boolean {
  return LEAD_CHANNELS.find((c) => c.id === id)?.enabled ?? false;
}
