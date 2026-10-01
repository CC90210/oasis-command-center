/**
 * lib/twilio/shared.ts - the Twilio connection's plain states and webhook
 * paths, shared by the server probe (lib/twilio/connection.ts), the
 * Connections card (lib/os/connectors.ts) and the drawer.
 *
 * PURE AND CLIENT-SAFE: no server import, no env read, no fetch.
 *
 * A Test records one of these codes on the saved keys (last_test_error), and
 * the card turns the newest one back into the same words the owner saw when
 * they pressed Test. So the card can never say something the check did not.
 */

/** Twilio's request to OASIS for an incoming text (the number's or messaging service's inbound URL). */
export const TWILIO_INBOUND_PATH = "/api/webhooks/twilio/sms-inbound";
/** Twilio's delivery updates for the texts OASIS sends (StatusCallback). */
export const TWILIO_STATUS_PATH = "/api/webhooks/twilio/sms-status";

export function twilioWebhookUrls(origin: string): { inbound: string; status: string } {
  const base = origin.replace(/\/+$/, "");
  return { inbound: `${base}${TWILIO_INBOUND_PATH}`, status: `${base}${TWILIO_STATUS_PATH}` };
}

/**
 * Every outcome of a Twilio connection test. Only `connected` is a pass;
 * `unreachable` is not a verdict on the keys (Twilio did not answer).
 */
export type TwilioTestState =
  | "connected"
  | "needs_number"
  | "number_lacks_sms"
  | "credentials_rejected"
  | "account_inactive"
  | "messaging_service_not_found"
  | "incomplete"
  | "unreachable";

/**
 * The card's words for a FAILED test, keyed by the state code stored as
 * last_test_error. "configured" kinds are not a fault in the keys.
 */
export const TWILIO_FAILURE_STATES: Readonly<
  Record<Exclude<TwilioTestState, "connected">, { kind: "attention" | "configured"; label: string; detail: string }>
> = {
  needs_number: {
    kind: "attention",
    label: "Needs a number",
    detail:
      "The Twilio account answered, but there is no phone number (or messaging service sender) OASIS can text from. Buy or choose a number in Twilio, save it here, then run Test again.",
  },
  number_lacks_sms: {
    kind: "attention",
    label: "Number cannot send texts",
    detail: "The saved number is on this Twilio account, but Twilio lists it without SMS. Choose a number that can text, then run Test again.",
  },
  credentials_rejected: {
    kind: "attention",
    label: "Credentials rejected",
    detail: "Twilio did not accept this Account SID with the saved Auth Token or API key. Paste them again from Twilio, then run Test again.",
  },
  account_inactive: {
    kind: "attention",
    label: "Twilio account not active",
    detail: "Twilio reports this account as suspended or closed, so it cannot send. Resolve it in Twilio, then run Test again.",
  },
  messaging_service_not_found: {
    kind: "attention",
    label: "Messaging service not found",
    detail: "Twilio has no messaging service with the saved SID on this account. Check the MG... SID, then run Test again.",
  },
  incomplete: {
    kind: "attention",
    label: "Needs attention",
    detail: "Setup is incomplete: add the Account SID and either the Auth Token or an API key.",
  },
  unreachable: {
    kind: "configured",
    label: "Twilio did not answer the last check",
    detail: "Twilio could not be reached when the test ran. That says nothing about the keys; run Test again.",
  },
};

export function isTwilioTestState(value: unknown): value is TwilioTestState {
  return value === "connected" || (typeof value === "string" && Object.prototype.hasOwnProperty.call(TWILIO_FAILURE_STATES, value));
}
