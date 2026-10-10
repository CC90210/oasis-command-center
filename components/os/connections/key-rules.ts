/**
 * The browser-side format rule for each pasted-key provider in
 * KeyConnectionPanel: the SAME rule the server enforces for that provider
 * (lib/connections/service.ts KEY_FORMAT), so a key is never refused here by
 * another provider's rule. Stripe's restricted-key rule used to run for every
 * provider, so a TypeSafe key was refused in the browser as "not a Stripe
 * restricted key" and never reached the Jev connect route (audit 2026-10-09).
 * Pure, so the test reads the same verdicts the page gives.
 */

import { checkJevApiKey, checkStripeRestrictedKey } from "@/lib/connections/rules";

export type ClientKeyCheck = { ok: true; key: string } | { ok: false; error: string; message: string };

export const CLIENT_KEY_RULES: Readonly<Record<string, (raw: unknown) => ClientKeyCheck>> = {
  stripe: checkStripeRestrictedKey,
  jev: checkJevApiKey,
};

/** A provider with no rule here is only trimmed; the server's own rule still decides. */
export function clientKeyCheck(providerId: string, raw: string): ClientKeyCheck {
  const rule = CLIENT_KEY_RULES[providerId];
  if (rule) return rule(raw);
  const key = raw.trim();
  return key ? { ok: true, key } : { ok: false, error: "key_missing", message: "Paste the key first." };
}
