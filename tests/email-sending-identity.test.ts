import assert from "node:assert/strict";
import {
  clickAllowedHosts,
  fromAddress,
  fromDomain,
  messageIdDomain,
  sendingIdentity,
  suppressionBrand,
  unsubscribeMailto,
} from "../lib/email/sending-identity";

/**
 * Foundation for the Bluerise Business Capital cutover (2026-07-29).
 *
 * The sending identity used to be five string literals scattered across five
 * files: the From address, the unsubscribe mailto, the Message-Id domain, the
 * click allowlist and the safe-redirect default. Changing brand meant finding
 * all of them and missing one. These assertions pin the two properties that make
 * the cutover safe: everything DERIVES from one place, and an unconfigured
 * environment is byte-identical to the pre-change behaviour.
 */

const ENV_KEYS = [
  "DRIP_FROM_ADDRESS",
  "DRIP_TRACKING_BASE_URL",
  "DRIP_INTAKE_URL",
  "DRIP_SUPPRESSION_BRAND",
  "PUBLIC_APP_URL",
];

/** Run `fn` with a specific environment, restoring whatever was there before. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
  try {
    fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── Unconfigured is exactly the old behaviour ───────────────────────────────
// This is what makes the whole thing safe to merge and deploy before the
// Bluerise domain is ready.

withEnv({}, () => {
  assert.equal(fromAddress(), "submissions@sunbizfunding.com", "default From is the legacy sender");
  assert.equal(fromDomain(), "sunbizfunding.com", "default domain is legacy");
  assert.equal(messageIdDomain(), "sunbizfunding.com", "default Message-Id domain is legacy");
  assert.equal(
    unsubscribeMailto(),
    "mailto:submissions@sunbizfunding.com?subject=unsubscribe",
    "default unsubscribe mailto is byte-identical to the literal it replaced",
  );
  assert.equal(suppressionBrand(), "SunBiz", "default suppression brand is unchanged");
  assert.equal(sendingIdentity().aligned, false, "unset tracking origin is not aligned");
});

// ── One variable moves the whole identity ───────────────────────────────────

withEnv({ DRIP_FROM_ADDRESS: "funding@bluerisebusinesscapital.com" }, () => {
  assert.equal(fromDomain(), "bluerisebusinesscapital.com", "domain follows the From address");
  assert.equal(
    messageIdDomain(),
    "bluerisebusinesscapital.com",
    "Message-Id follows the sender — a mismatch is scored against by filters",
  );
  assert.equal(
    unsubscribeMailto(),
    "mailto:funding@bluerisebusinesscapital.com?subject=unsubscribe",
    "the unsubscribe mailto follows the sender, never a stale mailbox",
  );
});

// ── Suppression brand does NOT follow the sender ────────────────────────────
// The sharpest edge in the cutover. Changing who mail is FROM must never
// silently repoint WHERE opt-outs are filed: a brand that matches no tenant
// records suppressions against tenant_id=NULL, which are never honored.

withEnv({ DRIP_FROM_ADDRESS: "funding@bluerisebusinesscapital.com" }, () => {
  assert.equal(
    suppressionBrand(),
    "SunBiz",
    "SAFETY: the suppression brand is independent of the From address and must be changed deliberately",
  );
});

withEnv({ DRIP_SUPPRESSION_BRAND: "Bluerise" }, () => {
  assert.equal(suppressionBrand(), "Bluerise", "it is overridable, but only explicitly");
});

// ── Alignment: the actual goal of the cutover ───────────────────────────────

withEnv(
  {
    DRIP_FROM_ADDRESS: "funding@bluerisebusinesscapital.com",
    DRIP_TRACKING_BASE_URL: "https://go.bluerisebusinesscapital.com",
  },
  () => {
    assert.equal(sendingIdentity().aligned, true, "a subdomain of the sending domain is aligned");
  },
);

withEnv(
  {
    DRIP_FROM_ADDRESS: "funding@bluerisebusinesscapital.com",
    DRIP_TRACKING_BASE_URL: "https://oasisai.work",
  },
  () => {
    assert.equal(
      sendingIdentity().aligned,
      false,
      "THE FAILURE TO CATCH: a new From with the old tracking domain just rebuilds the mismatch under a new brand",
    );
  },
);

// A lookalike domain must not count as aligned.
withEnv(
  {
    DRIP_FROM_ADDRESS: "funding@bluerisebusinesscapital.com",
    DRIP_TRACKING_BASE_URL: "https://go.bluerisebusinesscapital.com.evil.test",
  },
  () => {
    assert.equal(
      sendingIdentity().aligned,
      false,
      "suffix matching must be on a dot boundary, not a substring",
    );
  },
);

// ── Click allowlist ─────────────────────────────────────────────────────────

withEnv(
  {
    DRIP_FROM_ADDRESS: "funding@bluerisebusinesscapital.com",
    DRIP_TRACKING_BASE_URL: "https://go.bluerisebusinesscapital.com",
    DRIP_INTAKE_URL: "https://bluerisebusinesscapital.com/apply",
  },
  () => {
    const hosts = clickAllowedHosts();
    assert.ok(hosts.has("go.bluerisebusinesscapital.com"), "tracking host is allowed");
    assert.ok(hosts.has("bluerisebusinesscapital.com"), "sending domain is allowed");
    assert.ok(hosts.has("www.bluerisebusinesscapital.com"), "www of sending domain is allowed");
    // Legacy hosts MUST remain: mail already in inboxes points at them, and a
    // merchant opening a three-week-old email must still reach the right page
    // rather than being bounced to the safe default.
    assert.ok(hosts.has("oasisai.work"), "legacy platform host stays allowed for mail already sent");
    assert.ok(hosts.has("sunbizfunding.com"), "legacy sending domain stays allowed");
  },
);

withEnv({ DRIP_TRACKING_BASE_URL: "http://insecure.test" }, () => {
  assert.ok(
    !clickAllowedHosts().has("insecure.test"),
    "FAIL CLOSED: a non-https tracking value must not widen the redirect allowlist",
  );
});

withEnv({ DRIP_INTAKE_URL: "not-a-url" }, () => {
  // Must not throw, and must not add anything.
  const hosts = clickAllowedHosts();
  assert.ok(hosts.has("oasisai.work"), "a malformed intake URL leaves the allowlist usable");
});

console.log("email-sending-identity.test.ts — all assertions passed ✓");
