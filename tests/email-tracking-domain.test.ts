import assert from "node:assert/strict";
import { resolveTrackingBase, trackingHost } from "../lib/email/tracking-base";

/**
 * Sending-domain alignment (2026-07-29).
 *
 * Drip mail is sent From submissions@sunbizfunding.com while every URL inside it
 * (open pixel, click-wrapped links, unsubscribe, List-Unsubscribe header) was
 * built on oasisai.work. A visible sender whose links all point somewhere
 * unrelated is a strong spam signal, and it means the sending domain earns no
 * reputation from engagement while carrying all the complaint risk.
 *
 * The two functions here are shared by the code that MINTS those links
 * (lib/email/tracked-html.ts) and the code that decides which hosts a click may
 * redirect to (app/api/track/click/[id]). Drift between them would silently
 * downgrade every click on the new domain to the safe default, which presents as
 * a broken campaign rather than a config error, so both read this one module.
 */

const FALLBACK = "https://oasisai.work";

// ── resolveTrackingBase: fail SAFE ──────────────────────────────────────────
// A bad value must not break every link in every email. Falling back keeps mail
// clickable; the cost is a spam signal, which is the lesser failure.

assert.equal(
  resolveTrackingBase(undefined, FALLBACK),
  FALLBACK,
  "UNSET IS TODAY'S BEHAVIOUR — this is what makes the change safe to merge before DNS exists",
);
assert.equal(resolveTrackingBase("", FALLBACK), FALLBACK, "empty falls back");
assert.equal(resolveTrackingBase("   ", FALLBACK), FALLBACK, "whitespace-only falls back");

assert.equal(
  resolveTrackingBase("https://go.sunbizfunding.com", FALLBACK),
  "https://go.sunbizfunding.com",
  "a valid https origin is used",
);
assert.equal(
  resolveTrackingBase("https://go.sunbizfunding.com/", FALLBACK),
  "https://go.sunbizfunding.com",
  "trailing slash is stripped so callers can concatenate paths safely",
);
assert.equal(
  resolveTrackingBase("https://go.sunbizfunding.com/some/path", FALLBACK),
  "https://go.sunbizfunding.com",
  "a path is discarded — this is an ORIGIN, and keeping the path would corrupt every URL",
);

assert.equal(
  resolveTrackingBase("http://go.sunbizfunding.com", FALLBACK),
  FALLBACK,
  "plaintext http is refused: tracked links carry a signed target and an email address",
);
assert.equal(resolveTrackingBase("not-a-url", FALLBACK), FALLBACK, "garbage falls back");
assert.equal(
  resolveTrackingBase("javascript:alert(1)", FALLBACK),
  FALLBACK,
  "a non-https scheme never becomes a link base",
);

assert.equal(
  resolveTrackingBase(undefined, "https://oasisai.work/"),
  FALLBACK,
  "the fallback is normalized too, so an env with a trailing slash cannot double it",
);

// ── trackingHost: fail CLOSED ───────────────────────────────────────────────
// This one feeds the click-redirect allowlist, so an unusable value must widen
// nothing. Opposite direction from resolveTrackingBase, deliberately.

assert.equal(trackingHost(undefined), null, "unset adds no host to the allowlist");
assert.equal(trackingHost(""), null, "empty adds no host");
assert.equal(
  trackingHost("https://go.sunbizfunding.com"),
  "go.sunbizfunding.com",
  "a valid origin contributes exactly its hostname",
);
assert.equal(
  trackingHost("https://GO.SunbizFunding.com"),
  "go.sunbizfunding.com",
  "hostname is lowercased to match the allowlist comparison",
);
assert.equal(
  trackingHost("http://evil.example.com"),
  null,
  "FAIL CLOSED: a non-https value must not widen the redirect allowlist",
);
assert.equal(trackingHost("not-a-url"), null, "FAIL CLOSED: garbage widens nothing");

// The two must agree about what a valid origin is: if one accepts a value the
// other rejects, links get minted on a host the click route will refuse.
for (const good of ["https://go.sunbizfunding.com", "https://links.sunbizfunding.com"]) {
  assert.notEqual(resolveTrackingBase(good, FALLBACK), FALLBACK, `${good} accepted by minter`);
  assert.ok(trackingHost(good), `${good} accepted by allowlist`);
}
for (const bad of ["http://go.sunbizfunding.com", "not-a-url", ""]) {
  assert.equal(resolveTrackingBase(bad, FALLBACK), FALLBACK, `${bad} rejected by minter`);
  assert.equal(trackingHost(bad), null, `${bad} rejected by allowlist`);
}

console.log("email-tracking-domain.test.ts — all assertions passed ✓");
