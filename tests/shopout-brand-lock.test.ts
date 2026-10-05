/**
 * tests/shopout-brand-lock.test.ts — lenders only ever receive paper from the
 * SunBiz brand (Adon, 2026-08-05), whatever brand the merchant sits on.
 *
 * Brand routing governs MERCHANT mail. Lender correspondence is a separate
 * relationship: the funder shopping the deal is SunBiz, and a lender suddenly
 * receiving submissions from a name they have no agreement with is a business
 * problem, not a deliverability one.
 *
 * This is a STRUCTURAL test rather than a unit test because the failure mode is
 * not a wrong return value. It is someone helpfully threading `brand` through a
 * shared helper during a refactor and silently rebranding lender mail. There is
 * no assertion a pure function could make that would catch that; the thing worth
 * pinning is that no lender-facing call site passes a brand at all.
 *
 * The lock is deliberately loose about HOW lender mail sends and strict about
 * one property: it never selects a non-SunBiz credential.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveBrandKey } from "../lib/email/brands";

// ---------------------------------------------------------------------------
// 1. Find every file that sends mail through the shared Gmail sender AND is
//    lender/shop-out facing.
// ---------------------------------------------------------------------------
// argv array, no shell. The pattern here is a static literal, but shell-string
// interpolation into an exec is the kind of thing that gets "improved" later
// into taking a variable, so the safe form is the one that lives in the tree.
// See [[argv-not-shell-strings]].
function repoFilesSending(): string[] {
  let out = "";
  try {
    out = execFileSync(
      "git",
      ["grep", "-l", "-E", "sendGmail|getSubmissionsFrom|getSubmissionsCreds", "--", "lib", "app"],
      { encoding: "utf8" },
    );
  } catch {
    // git grep exits non-zero when there are no matches; treat as empty.
    out = "";
  }
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

const senders = repoFilesSending();
assert.ok(senders.length > 0, "expected to find files that send through the shared Gmail sender");

const lenderFacing = senders.filter((f) => /shop-?out|lender/i.test(f));

// ---------------------------------------------------------------------------
// 2. No lender-facing sender may pass a brand.
// ---------------------------------------------------------------------------
for (const file of lenderFacing) {
  const src = readFileSync(file, "utf8");
  // Match a `brand` property or argument being handed to the send path.
  const passesBrand =
    /\bbrand\s*:/.test(src) ||
    /getSubmissionsCreds\s*\([^)]*,\s*[^)]+\)/.test(src) ||
    /getSubmissionsFrom\s*\([^)]*,\s*[^)]+\)/.test(src);
  assert.ok(
    !passesBrand,
    `${file} passes a brand to the send path. Lender mail is ALWAYS SunBiz — ` +
      `remove the brand argument rather than defaulting it.`,
  );
}

// ---------------------------------------------------------------------------
// 3. Omission must still land on SunBiz — but ONLY omission.
//
// REWRITTEN 2026-09-09. This used to pin the literal source text
//     `...includes(s) ? (s as BrandKey) : "sunbiz"`
// which made "every unrecognised value becomes SunBiz" a tested requirement.
// That is what put the client's legal identity on OASIS mail: "oasis" was not a
// BrandKey, so it was unrecognised, so it became SunBiz — and this assertion
// reported that as correct.
//
// The property lender mail actually needs is narrower: an ABSENT brand stays
// SunBiz. An unrecognised one must now throw. Asserted behaviourally rather
// than by matching source text, so a refactor that preserves the behaviour
// does not fail, and one that quietly restores the blanket fallback does.
// ---------------------------------------------------------------------------
assert.equal(
  resolveBrandKey(undefined),
  "sunbiz",
  "omitting a brand is how lender mail stays SunBiz — this must not change",
);
assert.equal(resolveBrandKey(""), "sunbiz");
assert.throws(
  () => resolveBrandKey("nonsense"),
  /unknown brand/,
  "an UNRECOGNISED brand must refuse, not silently become SunBiz",
);
assert.equal(
  resolveBrandKey("oasis"),
  "oasis",
  "and a real brand must resolve to itself, not to the lender brand",
);

const gmail = readFileSync("lib/integrations/submissions-gmail.ts", "utf8");
assert.match(
  gmail,
  /getBrand\(resolveBrandKey\(brand\)\)\.credentialService/,
  "credential selection must go through resolveBrandKey so an omitted brand lands on gws",
);
assert.match(
  gmail,
  /"SunBiz Submissions"/,
  "the shared lender-facing display name must remain SunBiz Submissions",
);

const lenderSender = readFileSync("lib/integrations/sunbiz-lender-mail-send.ts", "utf8");
assert.match(
  lenderSender,
  /from:\s*`SunBiz Submissions <\$\{creds\.fromAddress\}>`/,
  "lender mail From display name must always be SunBiz Submissions",
);
assert.match(
  lenderSender,
  /presentation\.branded[\s\S]*renderShopOutHtml\(lenderText,\s*creds\.fromAddress,\s*files\.length\)[\s\S]*:\s*undefined/,
  "lender mail must include branded HTML unless the operator explicitly chooses no template",
);

console.log(
  `shopout-brand-lock.test.ts — ${lenderFacing.length} lender-facing sender(s) verified SunBiz-only ✓`,
);
