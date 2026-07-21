/**
 * sunbiz-form-templates.test.ts - guards the canonical SunBiz form seed.
 *
 * The live public forms are DB-driven, but scripts/reseed-sunbiz-forms.ts pushes
 * this template into the DB. These assertions prevent the two P0 regressions
 * from coming back: full applications must collect statements in-flow, and the
 * application must ask for FICO under the exact application-upsert key.
 */
import assert from "node:assert";
import { SUNBIZ_FORM_TEMPLATES } from "../lib/forms/sunbiz-templates";
import { parseFormSteps } from "../lib/forms/types";

function run() {
  const full = SUNBIZ_FORM_TEMPLATES["full-application"];
  const steps = parseFormSteps(full.steps);

  const uploadStepIndex = steps.findIndex((step) =>
    step.fields.some((field) => field.name === "bank_statements"),
  );
  assert.equal(
    uploadStepIndex,
    1,
    "full application collects bank statements after step 0 so anonymous users have a minted token",
  );

  const uploadField = steps[uploadStepIndex]?.fields.find((field) => field.name === "bank_statements");
  assert.ok(uploadField, "bank_statements upload field exists");
  assert.equal(uploadField.type, "file_upload_multi", "bank_statements uses direct-to-storage multi-upload");
  assert.equal(uploadField.required, true, "bank_statements is required in the full application");
  assert.deepEqual(uploadField.accept, ["application/pdf", "image/*"], "bank_statements accepts PDFs and images");
  assert.equal(uploadField.max_files, 50, "bank_statements keeps the high file cap for multi-account merchants");

  const business = steps.find((step) => step.key === "business");
  assert.ok(business, "business step exists");
  const websiteField = business.fields.find((field) => field.name === "website");
  assert.ok(websiteField, "full application collects the merchant website");
  assert.equal(websiteField.type, "url", "website uses URL validation");
  assert.equal(websiteField.required, false, "website remains optional for merchants without a site");

  const financial = steps.find((step) => step.key === "financial");
  assert.ok(financial, "financial step exists");
  const ficoField = financial.fields.find((field) => field.name === "applicant_fico");
  assert.ok(ficoField, "financial step includes applicant_fico");
  assert.equal(ficoField.label, "Credit Score (FICO)", "FICO label matches Ezra request");
  assert.equal(ficoField.type, "number", "FICO persists as a number");
  assert.equal(ficoField.required, true, "FICO is required for lender matching");
  assert.equal(ficoField.min, 300, "FICO has lower credit-score bound");
  assert.equal(ficoField.max, 850, "FICO has upper credit-score bound");

  assert.equal(
    full.step_outcomes[String(steps.length - 1)],
    "signed_application",
    "signed_application outcome tracks the actual final step index",
  );
  assert.ok(!("4" in full.step_outcomes), "old signature step index is not left behind");

  console.log("sunbiz-form-templates ok");
}

run();
