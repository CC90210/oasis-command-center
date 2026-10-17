/**
 * lib/forms/honeypot.ts - the public forms' honeypot, shared by the browser
 * and the submit route.
 *
 * Every public form ends with one text box no person sees or reaches
 * (components/forms/HoneypotField.tsx). Only a script that fills every box puts
 * anything there. The form sends what the box holds as `honeypot` in its
 * request body, and POST /api/forms/submit answers a filled one like a
 * finished form and stores nothing.
 */

/** The request-body key the form sends the box's value under. */
export const HONEYPOT_BODY_KEY = "honeypot";

/** True when a request's honeypot value was filled: an empty or whitespace
 *  value, or one that is not a string, is no trap. */
export function isHoneypotFilled(value: unknown): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * A form caught a script (its box is filled): send the submit route one request
 * carrying the trap, which it drops and logs, instead of any of the form's own
 * requests. `body` is how the form identifies itself (anonymous_init or token,
 * step_index); never the visitor's answers. Never throws: the script is shown
 * the form's thanks either way.
 */
export async function reportTrappedSubmission(body: Record<string, unknown>, honeypot: string): Promise<void> {
  await fetch("/api/forms/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, [HONEYPOT_BODY_KEY]: honeypot }),
  }).catch(() => null);
}

/** What a script typed into the box, latched: once it was filled, every later
 *  request says so, even after the box renders empty on a new step. */
export function trapValue(input: HTMLInputElement | null, latch: { current: string }): string {
  const typed = input?.value.trim() ?? "";
  if (typed) latch.current = typed.slice(0, 200);
  return latch.current;
}
