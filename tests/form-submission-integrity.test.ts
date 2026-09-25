import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalFormSubmissionId } from "../lib/forms/canonical-submission-id";

const first = canonicalFormSubmissionId("form-a", "lead-a", 1);
assert.equal(first, canonicalFormSubmissionId("form-a", "lead-a", 1));
assert.notEqual(first, canonicalFormSubmissionId("form-a", "lead-a", 2));
assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

// Pin the fail-closed ordering and atomic retry key at the route boundary.
const route = readFileSync("app/api/forms/submit/route.ts", "utf8");
const requiredGate = route.indexOf('error: "required_file_upload_failed"');
const canonicalWrite = route.indexOf("canonicalFormSubmissionId(form.id, link.lead_id, stepIndex)");
const stageEvent = route.indexOf('type: "doc_uploaded"');
assert.ok(requiredGate > 0, "required uploaded files must have a server-verified gate");
assert.ok(requiredGate < stageEvent, "an unverified required upload must fail before stage progression");
assert.ok(canonicalWrite > requiredGate, "the submission must be written only after required uploads verify");
assert.match(route, /\.upsert\([\s\S]*?onConflict: "id"/);
assert.match(route, /\.eq\("step_index", stepIndex\)[\s\S]*?\.maybeSingle\(\)/);
assert.match(route, /\.update\(\{[\s\S]*?submitted_at: new Date\(\)\.toISOString\(\)/);
assert.match(route, /documentsCreatedByRequest[\s\S]*?\.from\("lead_documents"\)[\s\S]*?\.delete\(\)/);
assert.match(route, /filter\(\(doc\) => doc\.remove_object\)[\s\S]*?\.remove\(inlinePaths\)/);
assert.match(route, /field\.type !== "file_upload"[\s\S]*?registerLeadDocument\(\{/);

console.log("form-submission-integrity: all assertions passed");
