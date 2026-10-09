/**
 * The notice an app's key form shows after Test, from the Test route's own
 * answer (app/api/integrations/keys/test). Pure, so a test feeds it the real
 * route's JSON and reads the words an owner reads.
 *
 *   no Test ran     signed out, not allowed, the request failed: the request's
 *                   own failure sentence, never "did not pass".
 *   plain state     Twilio's check answers in its own words: shown as it put them.
 *   passed          says so; Telegram names the bot and the chat it reached.
 *   failed          what the check found, in the words the app's card uses for
 *                   it (lib/os/connectors.ts testFailureWords), never the code.
 *   not saved       the result could not be saved where the card reads it, so
 *                   the notice says the status above does not show it instead
 *                   of pointing at a status that cannot change.
 */

import { testFailureWords } from "@/lib/os/connectors";

export type TestNotice = { tone: "ok" | "err"; text: string };

export function testResultNotice(input: {
  service: string;
  appName: string;
  /** The request went through and the check passed. */
  ok: boolean;
  /** The route's JSON, or null when it sent none. */
  data: Record<string, unknown> | null;
  /** The request's failure in plain words, for when no Test ran. */
  requestFailure: string;
}): TestNotice {
  const { service, appName, ok, data } = input;
  if (typeof data?.service !== "string") return { tone: "err", text: input.requestFailure };
  const detail = typeof data.detail === "string" ? data.detail : null;
  const message = typeof data.message === "string" ? data.message : null;
  const unsaved = data.recorded === false ? " OASIS could not save this result, so the status above does not show it." : "";
  let text: string;
  if (message) {
    text = detail ? `${message} ${detail}` : message;
  } else if (ok) {
    text = service === "telegram" && detail ? `The check with ${appName} passed: ${detail}.` : `The check with ${appName} passed.`;
  } else {
    const words = testFailureWords(service, typeof data.error === "string" ? data.error : null);
    text = words ? `${words.label}. ${words.detail}` : `The check with ${appName} did not pass.`;
  }
  return { tone: ok ? "ok" : "err", text: `${text}${unsaved}` };
}
