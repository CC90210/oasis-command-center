import assert from "node:assert/strict";
import {
  domainOfAddress,
  fromDisplayName,
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
  "DRIP_FROM_NAME",
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

// ── domainOfAddress must handle the display-name form ───────────────────────
// getSubmissionsFrom() returns `SunBiz Submissions <submissions@sunbizfunding.com>`.
// Naively slicing after the last "@" yields "sunbizfunding.com>" with the bracket
// attached, which produced a malformed Message-Id (`<uuid@domain>>`) on EVERY
// send. Receivers may rewrite or reject that, and it breaks the persisted
// threading ids we rely on to chain lender replies.

assert.equal(
  domainOfAddress("SunBiz Submissions <submissions@sunbizfunding.com>"),
  "sunbizfunding.com",
  "THE BUG: a display-name From must not leak the closing bracket into the domain",
);
assert.equal(
  domainOfAddress("submissions@sunbizfunding.com"),
  "sunbizfunding.com",
  "a bare mailbox still works",
);
assert.equal(
  domainOfAddress("Bluerise Business Capital <funding@bluerisebusinesscapital.com>"),
  "bluerisebusinesscapital.com",
  "display names containing spaces and words are fine",
);
assert.equal(domainOfAddress("  a@b.co  "), "b.co", "surrounding whitespace is trimmed");
assert.equal(domainOfAddress("MiXeD@CaSe.COM"), "case.com", "domain is lowercased");
assert.equal(domainOfAddress("no-at-sign"), "", "unparseable yields empty, never a partial");
assert.equal(domainOfAddress(""), "", "empty yields empty");

// ── Drip-only display name ──────────────────────────────────────────────────
// getSubmissionsFrom() hardcodes "SunBiz Submissions" and is SHARED with lender
// shop-out mail. DRIP_FROM_NAME rebrands only the drips, so the Bluerise cutover
// does not have to wait on the decision about whether lender mail rebrands too.

withEnv({}, () => {
  assert.equal(
    fromDisplayName(),
    undefined,
    "unset means leave the shared default alone — lender mail is untouched",
  );
});

withEnv({ DRIP_FROM_NAME: "Bluerise Business Capital" }, () => {
  assert.equal(fromDisplayName(), "Bluerise Business Capital", "set value is used verbatim");
});

// Header injection defence. This value lands in a From header, and a newline in a
// header value splits it. Operator-set rather than user-set, so this is defence
// in depth, but a header builder should never trust its input.
withEnv({ DRIP_FROM_NAME: "Evil\r\nBcc: attacker@example.com" }, () => {
  const n = fromDisplayName() || "";
  assert.ok(!/[\r\n]/.test(n), "CR/LF stripped — a display name cannot inject a header");
  assert.ok(!n.includes("<") && !n.includes(">"), "angle brackets stripped so the mailbox cannot be forged");
});

withEnv({ DRIP_FROM_NAME: '   Bluerise "Quoted" Name   ' }, () => {
  assert.equal(fromDisplayName(), "Bluerise Quoted Name", "quotes stripped and whitespace collapsed");
});

withEnv({ DRIP_FROM_NAME: "   " }, () => {
  assert.equal(fromDisplayName(), undefined, "whitespace-only is treated as unset, not an empty name");
});

// ---------------------------------------------------------------------------
// PER-BRAND RESOLUTION (2026-08-05, dual-brand build)
//
// Every resolver takes an optional brand. The no-arg form must stay exactly
// what it was, because that is what every existing caller uses and what makes
// this change safe to deploy before any brand routing exists.
// ---------------------------------------------------------------------------

// No-arg behaviour is unchanged. This is the deploy-safety guarantee.
assert.equal(fromAddress(), "submissions@sunbizfunding.com", "no-arg From is unchanged");
assert.equal(fromDomain(), "sunbizfunding.com", "no-arg domain is unchanged");
assert.equal(messageIdDomain(), "sunbizfunding.com", "no-arg Message-Id domain is unchanged");
assert.equal(unsubscribeMailto(), "mailto:submissions@sunbizfunding.com?subject=unsubscribe");

// Explicit sunbiz equals the no-arg form.
assert.equal(fromAddress("sunbiz"), fromAddress());
assert.equal(fromDomain("sunbiz"), fromDomain());

// Bluerise resolves to its own identity.
assert.equal(fromAddress("bluerise"), "submissions@bluerisebusinesscapital.com");
assert.equal(fromDomain("bluerise"), "bluerisebusinesscapital.com");
assert.equal(messageIdDomain("bluerise"), "bluerisebusinesscapital.com",
  "Message-Id must follow the sending domain or filters score against it");
assert.equal(unsubscribeMailto("bluerise"),
  "mailto:submissions@bluerisebusinesscapital.com?subject=unsubscribe",
  "the unsubscribe mailto must reach the mailbox that actually sent");

// An unknown brand falls back to SunBiz rather than erroring or going blank.
assert.equal(fromAddress("nonsense" as never), "submissions@sunbizfunding.com");

// ---------------------------------------------------------------------------
// The click allowlist must cover EVERY brand at once, not just the caller's.
//
// After a handoff, mail from the PREVIOUS brand is still sitting in inboxes and
// cannot be re-sent. Scoping the allowlist to the current brand would silently
// downgrade every click on that older mail to the safe default, which looks
// like a dead campaign rather than a config error.
// ---------------------------------------------------------------------------
{
  const hosts = clickAllowedHosts();
  assert.ok(hosts.has("sunbizfunding.com"), "sunbiz host allowed");
  assert.ok(hosts.has("www.sunbizfunding.com"), "sunbiz www allowed");
  assert.ok(hosts.has("bluerisebusinesscapital.com"), "bluerise host allowed");
  assert.ok(hosts.has("www.bluerisebusinesscapital.com"), "bluerise www allowed");
  assert.ok(hosts.has("oasisai.work"), "platform host allowed");
  // And it must not become a wildcard.
  assert.ok(!hosts.has("evil.test"), "allowlist is not open");
  assert.ok(!hosts.has(""), "allowlist has no empty entry");
}

// A configured per-brand tracking host joins the allowlist for that brand.
withEnv({ BLUERISE_TRACKING_ORIGIN: "https://go.bluerisebusinesscapital.com" }, () => {
  const hosts = clickAllowedHosts();
  assert.ok(hosts.has("go.bluerisebusinesscapital.com"),
    "a configured bluerise tracking host must be trusted, or every click 302s to the safe default");
  assert.ok(hosts.has("sunbizfunding.com"), "configuring one brand must not drop the other");
});

// A malformed tracking origin contributes NOTHING rather than widening the set.
// This is the one place that must fail closed: the allowlist decides where an
// unsigned link may send a merchant.
withEnv({ BLUERISE_TRACKING_ORIGIN: "http://insecure.test" }, () => {
  assert.ok(!clickAllowedHosts().has("insecure.test"), "plain http must not be trusted");
});
withEnv({ BLUERISE_TRACKING_ORIGIN: "not-a-url" }, () => {
  const hosts = clickAllowedHosts();
  assert.ok(!hosts.has("not-a-url"), "unparseable origin contributes nothing");
  assert.ok(hosts.has("bluerisebusinesscapital.com"), "and does not break the rest");
});

// ---------------------------------------------------------------------------
// The suppression brand deliberately does NOT follow the sending brand.
//
// /api/unsubscribe resolves this string to a tenant when RECORDING an opt-out.
// Both brands live on ONE tenant precisely so an opt-out to either stops both.
// Making this follow the sender would file Bluerise opt-outs against a tenant
// that may not exist, landing tenant_id = NULL, which checkEmailSuppressed can
// never match. That exact failure has already happened once in production.
// ---------------------------------------------------------------------------
assert.equal(suppressionBrand(), "SunBiz", "suppression brand is not derived from the sender");

console.log("email-sending-identity.test.ts — all assertions passed ✓");
