import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

/**
 * The incident (2026-08-26). Dropping a merchant application into the SunBiz
 * pipeline had been failing since the 2026-08-08/09 Turso/R2 cutover. The
 * dashboard wrote the PDF to Cloudflare R2; the VPS daemon that reads it back
 * was never given R2 credentials, boto3, or a deploy carrying the
 * etl_storage_to_r2.py its storage library imports to resolve key names. Every
 * drop died with a bare "download_failed", nothing alerted, and the rep quietly
 * went back to JotForm for three weeks.
 *
 * The repair does NOT hand the VPS R2 keys. The dashboard mints a short-lived
 * URL for the one object the job already references. That moves a merchant
 * bank-statement read behind two new guards, so both are made to fire here on
 * purpose:
 *
 *   1. the HMAC check that decides a caller is really the VPS, and
 *   2. the tenant-scope check on the path pulled out of the job row.
 *
 * Plus the health check that would have made the original outage loud.
 */

// Set before any assertion runs. verifyInternalHmac reads the secret at CALL
// time, not at module load, so plain static imports are safe here.
process.env.OASIS_OUTBOUND_HMAC_SECRET = "test-secret-for-guard-proof";

import { verifyInternalHmac } from "../lib/internal-hmac";
import { pathBelongsToTenant } from "../lib/storage-helpers";
import { FORM_CHECKS } from "../lib/health/form-checks";
import { evaluate } from "../lib/health/checks-core";

const sign = (body: string, secret = "test-secret-for-guard-proof") =>
  createHmac("sha256", secret).update(body, "utf8").digest("hex");

// ── 1. the HMAC gate ─────────────────────────────────────────────────────────

const BODY = JSON.stringify({ job_id: "f3bf9545-bb94-461c-a696-9ef0247bd259" });

assert.equal(
  verifyInternalHmac(BODY, sign(BODY)),
  true,
  "a correctly signed body from the VPS must be accepted, or the fix does nothing",
);

// THE GUARD FIRING. Each of these is a way in that must stay shut.
assert.equal(
  verifyInternalHmac(BODY, sign(BODY, "not-the-real-secret")),
  false,
  "a signature made with the wrong secret must be rejected",
);
assert.equal(
  verifyInternalHmac(BODY + " ", sign(BODY)),
  false,
  "a tampered body must not verify against the original signature",
);
assert.equal(
  verifyInternalHmac(BODY, null),
  false,
  "a missing x-oasis-signature header must be rejected, never treated as absent-so-allow",
);
assert.equal(
  verifyInternalHmac(BODY, "deadbeef"),
  false,
  "a wrong-LENGTH signature must return false, not throw — timingSafeEqual throws on length mismatch",
);
assert.equal(
  verifyInternalHmac(BODY, sign(BODY).toUpperCase()),
  false,
  "hex case is not normalised, so an uppercase digest is a mismatch and must fail closed",
);

// Fail closed when the server has NO secret configured. A blank secret must
// never make every caller valid — this is the one that turns a config slip into
// an open door.
{
  const saved = process.env.OASIS_OUTBOUND_HMAC_SECRET;
  process.env.OASIS_OUTBOUND_HMAC_SECRET = "";
  assert.equal(
    verifyInternalHmac(BODY, sign(BODY, "")),
    false,
    "with no secret configured the route must reject everything, including a signature over the empty secret",
  );
  process.env.OASIS_OUTBOUND_HMAC_SECRET = saved;
}

// ── 2. the tenant-scope gate on the path read out of the job row ─────────────

const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const OTHER = "bb15fb2f-be7b-55c1-bd5c-3ff6e2178221";

assert.equal(
  pathBelongsToTenant(SUNBIZ, `${SUNBIZ}/_extraction_pending/1787772114222_Funding-Second-Form.pdf`),
  true,
  "the real failing job's path must still be readable, or the outage is not actually fixed",
);

// THE GUARD FIRING. A job row is not a promise; these are the shapes that must
// never be turned into a signed URL.
assert.equal(
  pathBelongsToTenant(SUNBIZ, `${OTHER}/_extraction_pending/statement.pdf`),
  false,
  "a job row pointing at ANOTHER tenant's object must be refused, not signed",
);
assert.equal(
  pathBelongsToTenant(SUNBIZ, `${SUNBIZ}/../${OTHER}/statement.pdf`),
  false,
  "a traversal segment must be refused even though the path starts with the right tenant",
);
assert.equal(
  pathBelongsToTenant(SUNBIZ, `${SUNBIZ}-evil/statement.pdf`),
  false,
  "a prefix collision (tenant id followed by more characters) must not pass as the tenant folder",
);
assert.equal(
  pathBelongsToTenant(SUNBIZ, `${SUNBIZ}/`),
  false,
  "the bare tenant folder with no object is not a document and must be refused",
);
assert.equal(pathBelongsToTenant("", "any/path.pdf"), false, "an empty tenant must never match");
assert.equal(pathBelongsToTenant(SUNBIZ, ""), false, "an empty path must never match");
assert.equal(
  pathBelongsToTenant(SUNBIZ, `/${SUNBIZ}/statement.pdf`),
  false,
  "an absolute path must be refused rather than silently re-rooted",
);

// ── 3. the health check that ends the silence ────────────────────────────────

const check = FORM_CHECKS.find((c) => c.id === "forms.extraction_jobs_failed");
assert.ok(check, "the extraction-failure check must be registered in FORM_CHECKS");
assert.equal(check.rule.kind, "must_be_zero", "any failed drop is one too many");
assert.equal(check.severity, "critical", "a rep unable to file a deal is critical, not informational");

// THE GUARD FIRING: one failed drop must grade red. On 2026-08-25 there were
// five, and nothing asked.
assert.equal(
  evaluate(check.id, check.rule, 1, []).verdict,
  "failing",
  "a single failed extraction job must grade `failing` — this is the alert that did not exist",
);
assert.equal(
  evaluate(check.id, check.rule, 0, []).verdict,
  "ok",
  "zero failed jobs must be green, so the check can recover and announce it",
);
// Not knowing is not healthy. If the query itself fails, observe returns null,
// and that must page rather than read as a clean bill of health.
assert.equal(
  evaluate(check.id, check.rule, null, []).verdict,
  "check_broken",
  "a check that could not run must never grade `ok`",
);

// The check must actually READ the right rows. A check that queries the wrong
// table or drops the status filter still returns 0 and still reports green —
// presence of a check is not contribution of a check.
// (Wrapped in a function because this file transpiles to CJS, where top-level
// await is unavailable.)
async function provesItReadsTheRightRows() {
  const calls: string[] = [];
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "gte", "lt"]) {
    builder[m] = (...args: unknown[]) => {
      calls.push(`${m}(${args.filter((a) => typeof a === "string").join(",")})`);
      return builder;
    };
  }
  // The terminal await resolves to the PostgREST head-count shape.
  (builder as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    resolve({ count: 5, error: null });

  const db = { from: (t: string) => (calls.push(`from(${t})`), builder) };
  const observed = await check.observe(
    db as unknown as Parameters<typeof check.observe>[0],
    SUNBIZ,
    Date.parse("2026-08-26T20:00:00Z"),
  );

  assert.equal(observed, 5, "observe must return the row count the database reported");
  assert.ok(
    calls.includes("from(document_extraction_jobs)"),
    `must read the extraction queue, not another table — saw ${calls.join(" ")}`,
  );
  assert.ok(
    calls.includes(`eq(tenant_id,${SUNBIZ})`),
    `must scope to the tenant being graded — saw ${calls.join(" ")}`,
  );
  assert.ok(
    calls.includes("eq(status,failed)"),
    `must count only FAILED jobs, or every healthy drop reads as an outage — saw ${calls.join(" ")}`,
  );
}

// The operator-facing text has to name the one distinction that decides what
// they do next: retrying a `blocked:` job is pointless.
const described = check.describe({ observed: 5 } as Parameters<typeof check.describe>[0]);
assert.match(
  described,
  /blocked:/,
  "the check must tell the operator that a `blocked:` prefix means a human must act, not retry",
);

provesItReadsTheRightRows()
  .then(() => console.log("extraction-doc-url-guard: all guards fire ✓"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
