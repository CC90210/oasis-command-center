/**
 * lib/offer-pages/gate-words.ts - publishGate's sentence for a switched-off
 * form, shared with the browser.
 *
 * Confirm & publish (confirm-publish.ts) saves first and switches the form on
 * only once the save's gate lists nothing else, so it has to recognise this
 * one blocker among the gate's sentences. claims.ts is server-only
 * (node:crypto), so the sentence lives here, where both can import it.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */
export const FORM_OFF_BLOCKER =
  "Switch the form on first. The page's Book section is the form, and a switched-off form takes no one's details.";
