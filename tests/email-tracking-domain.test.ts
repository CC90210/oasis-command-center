import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// ── Cold outreach must NOT inherit the SunBiz sending domain ────────────────
// Codex review P1. lib/integrations/cold-sending.ts passes brand:"SunBiz" — it
// has to, because brand is the SUPPRESSION key and an unsubscribe from a cold
// blast must record against the SunBiz tenant. But cold mail sends from ISOLATED
// mailbox domains specifically so its reputation cannot touch sunbizfunding.com.
//
// Keying the tracking domain off brand alone would therefore have moved cold
// pixels and unsubscribe links onto the SunBiz sending domain, defeating that
// isolation. The context axis is what separates "who suppresses this" from
// "where was this actually sent from", and it defaults to the isolated choice.
//
// This is a source-level assertion rather than a call: tracked-html.ts imports
// "server-only" and cannot load here. It fails if anyone opts cold sending in.
{
  const cold = readFileSync(
    new URL("../lib/integrations/cold-sending.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !/brandTrackingBase\s*\(/.test(cold),
    "cold outreach must never resolve a brand sending domain — its reputation isolation depends on staying on the platform origin",
  );

  // And the drip path, which IS sent from that domain, must opt in — otherwise
  // this whole change is inert and the links stay misaligned.
  const executor = readFileSync(new URL("../lib/drips/executor.ts", import.meta.url), "utf8");
  assert.ok(
    /brandTrackingBase\s*\(\s*SUNBIZ_BRAND\s*\)/.test(executor),
    "the drip send path must resolve the SunBiz sending domain",
  );
  // The resolved origin, not the intent, must be what gets recorded — otherwise
  // the telemetry reconciler cannot rebuild a historical message exactly.
  assert.ok(
    /tracking_base:\s*sentTrackingBase/.test(executor),
    "the drip send must stamp the RESOLVED tracking origin on the interaction row",
  );

  // And the reconciler must read that recorded value rather than resolving now.
  const reconciler = readFileSync(
    new URL("../lib/drips/reconcile-email-telemetry.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    /meta\.tracking_base/.test(reconciler),
    "the telemetry reconciler must rebuild on the origin the send recorded, not today's config",
  );
}

console.log("email-tracking-domain.test.ts — all assertions passed ✓");
