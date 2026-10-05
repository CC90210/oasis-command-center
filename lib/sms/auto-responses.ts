/**
 * Carrier-facing SMS copy. Keep this pure and shared by the consent UI,
 * inbound webhook, and Toll-Free Verification submission so they cannot drift.
 */
export const SMS_CONSENT_DISCLOSURE_VERSION = "2026-08-31.v1";

export const SMS_CONSENT_DISCLOSURE =
  "OASIS AI Solutions may send automated meeting reminders. Message frequency varies by booking. Msg & data rates may apply. Reply STOP to opt out; HELP for help.";

export const STOP_CONFIRMATION =
  "OASIS AI Solutions: You are opted out. Message frequency varies. Msg & data rates may apply. Reply STOP to remain opted out; HELP for help.";

export const HELP_RESPONSE =
  "OASIS AI Solutions: Meeting reminder help. Message frequency varies by booking. Msg & data rates may apply. Reply STOP to opt out.";

export const START_CONFIRMATION =
  "OASIS AI Solutions: Texts restarted. Message frequency varies by booking. Msg & data rates may apply. Reply STOP to opt out; HELP for help.";
