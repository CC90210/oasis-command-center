/**
 * oasis-new-lead-form.test.ts -- /pipeline/new asks only for what a person types.
 *
 * THE DEFECT (portal audit, 2026-09-11). The rebuilt create form trimmed the
 * seed lead entity with a deny-list (the lifecycle fields), so everything else
 * the seed carries stayed on it as empty boxes: Score, Value Estimate, Website
 * Condition, Audit Findings, Ai Score, Ai Reasoning, Ai Scored At, Ai Next
 * Action, Ai Next Action Rationale, Ai Next Action At. The pipeline and its AI
 * jobs fill those in; nobody adding a lead types them. And the one required
 * field, the region, was labelled "State" while listing Canadian provinces.
 *
 * The real-route round trip (every offered field typed, POSTed to
 * /api/manifest/<slug>/records/lead, read back from the database) is the
 * "(c) every field the new-lead form offers is saved as typed" step of
 * tests/oasis-create-stage-contract.test.ts, which already has that harness.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OASIS_SEED } from "../lib/manifest/seeds";
import {
  OASIS_LEAD_CREATE_FIELDS,
  OASIS_LEAD_REGION_FIELD,
  OASIS_LEAD_REGION_LABEL,
  oasisLeadCreateForm,
  planOasisLeadCreate,
  type OasisCreateViewer,
} from "../lib/oasis-lead-create";

// CRLF on a Windows checkout would break the source checks below.
const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const seedLead = OASIS_SEED.data_model!.find((entity) => entity.name === "lead")!;
const VIEWERS: Array<[string, OasisCreateViewer]> = [
  ["admin", { isAdmin: true, teamRole: "owner" }],
  ["rep", { isAdmin: false, teamRole: "opener" }],
];

// ── (a) the form offers exactly what a person types ───────────────────────
const TYPED_FIELDS = [
  "name",
  "company",
  "email",
  "phone",
  "website",
  "industry",
  "business_city",
  "state",
  "source",
  "stage",
  "notes",
];
assert.deepEqual([...OASIS_LEAD_CREATE_FIELDS], TYPED_FIELDS);
for (const [who, viewer] of VIEWERS) {
  const form = oasisLeadCreateForm(seedLead, viewer);
  assert.deepEqual(
    form.entity.fields.map((field) => field.name),
    TYPED_FIELDS,
    `${who}: the new-lead form must ask only for what a person types`,
  );
}

const PIPELINE_FILLED = [
  "score",
  "value_estimate",
  "website_condition",
  "audit_findings",
  "ai_score",
  "ai_reasoning",
  "ai_scored_at",
  "ai_next_action",
  "ai_next_action_rationale",
  "ai_next_action_at",
  "last_contacted_at",
];
const adminForm = oasisLeadCreateForm(seedLead, VIEWERS[0][1]);
for (const name of PIPELINE_FILLED) {
  assert.ok(
    !adminForm.entity.fields.some((field) => field.name === name),
    `the new-lead form shows ${name}, which the pipeline fills in itself`,
  );
  // The form trims a COPY. The seed lead entity keeps every field, so nothing
  // that reads it (the edit form, the scoring and next-action jobs) loses one.
  assert.ok(seedLead.fields.some((field) => field.name === name), `the seed lead lost ${name}`);
}

// Nothing a person types is dropped: a create with a value in every field the
// form offers is accepted, and each value reaches the row the route writes.
const typed: Record<string, unknown> = {
  name: "Boulangerie Saint-Denis",
  company: "Boulangerie Saint-Denis Inc.",
  email: "owner@example.com",
  phone: "+1 514 555 0100",
  website: "https://example.com",
  industry: "Bakery",
  business_city: "Montreal",
  state: "QC",
  source: "referral",
  stage: "assigned",
  notes: "Met at the market. Wants online ordering.",
};
assert.deepEqual(Object.keys(typed).sort(), [...TYPED_FIELDS].sort(), "the probe must fill every offered field");
for (const [who, viewer] of VIEWERS) {
  const plan = planOasisLeadCreate({
    viewer,
    creatorUserId: "user-1",
    data: typed,
    now: new Date(),
    requireRegion: true,
  });
  if (!plan.ok) throw new Error(`${who}: a create with every offered field was refused: ${plan.message}`);
  for (const [key, value] of Object.entries(typed)) {
    assert.equal(plan.data[key], value, `${who}: ${key} was dropped or rewritten on create`);
  }
}

// ── (b) the region keeps its key and says what it holds ───────────────────
assert.equal(OASIS_LEAD_REGION_FIELD, "state", "every lead, filter and board reads `state`; it must not be renamed");
const region = adminForm.entity.fields.find((field) => field.name === OASIS_LEAD_REGION_FIELD)!;
assert.equal(region.required, true);
assert.ok(region.enum_values!.includes("QC") && region.enum_values!.includes("FL"));
assert.equal(OASIS_LEAD_REGION_LABEL, "Province / State");
assert.deepEqual(
  adminForm.fieldLabels,
  { [OASIS_LEAD_REGION_FIELD]: "Province / State" },
  "only the region is relabelled; every other field keeps its humanized name",
);

// The label reaches the screen: the page hands it to the form, and the form
// prefers it over humanize(key) while still saving the value under the key.
const page = read("app/pipeline/new/page.tsx");
assert.match(page, /fieldLabels=\{form\.fieldLabels\}/, "/pipeline/new must pass the field labels to the form");
const formSource = read("components/manifest/ManifestRecordForm.tsx");
assert.match(formSource, /fieldLabel=\{fieldLabels\?\.\[field\.name\]\}/, "the form must hand each field its label");
assert.match(
  formSource,
  /const labelText = fieldLabel \?\? humanize\(field\.name\);/,
  "a field label must win over humanize(key)",
);
assert.match(formSource, /onChange=\{\(v\) => setField\(field\.name, v\)\}/, "values must still save under the field's key");

// ── (c) the planner's comment matches quick-add ───────────────────────────
// Quick-add refuses a new OASIS lead without a region (driven end to end in
// the contract test: qaNoRegion -> 422 region_required). The comment on the
// planner said the opposite, and a reader trusting it would ship a caller that
// omits `state`.
const quickAdd = read("app/api/leads/quick-add/route.ts");
assert.match(quickAdd, /requireRegion: true,/, "quick-add must require a region on OASIS");
const planner = read("lib/oasis-lead-create.ts");
const plannerAt = planner.indexOf("export function planOasisLeadCreate(");
const plannerDoc = planner
  .slice(planner.lastIndexOf("/**", plannerAt), plannerAt)
  .split("\n")
  .map((line) => line.replace(/^\s*\*?\s?/, ""))
  .join(" ")
  .replace(/\s+/g, " ");
assert.doesNotMatch(plannerDoc, /only when present/, "the comment still says quick-add checks a region only when present");
assert.match(plannerDoc, /quick-add, which refuses a new OASIS lead without `state`/);

console.log("oasis-new-lead-form: OK");
