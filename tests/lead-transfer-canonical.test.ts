/* ─── Lead transfer: the stamp, the stage, and the fields that were dropped ───
 *
 * CC, 2026-08-24: "functionality issues when transferring leads over to the
 * pipeline ... make sure all the information is transferred, especially their
 * website, so that the sales reps have the most info and context they can get
 * when making that call."
 *
 * Six code paths wrote leads into tenant_records and each had its own field
 * mapping. Only the chat importer carried the website research and stamped
 * sales_program — and the OASIS board filters on exactly that stamp, so a lead
 * that arrived through any other door existed in the database and appeared on
 * no screen. These tests pin the two rules that make a transfer land:
 * the stamp, and the stage vocabulary.
 */

import assert from "node:assert/strict";
import {
  OASIS_INTAKE_STAGE,
  OASIS_WEBSITE_SALES_PROGRAM,
  SUNBIZ_INTAKE_STAGE,
  isWebsiteSalesLead,
  isWebsiteSalesTenantSlug,
  normalizeStageForTenant,
  pickWebsiteSalesFields,
  stageForWebsiteSalesLead,
  stampSalesProgram,
  stampSalesProgramForTenant,
} from "../lib/leads/canonical-lead-fields";
import { OASIS_LEAD_STAGE_KEYS } from "../lib/oasis-stage-meta";
import { LEAD_PIPELINE_STAGES } from "../lib/sunbiz-stage-meta";
import {
  REP_EDITABLE_LEAD_FIELDS,
  canOpenOasisSalesRecord,
  ownsOasisSalesRecord,
  rejectedRepPatchKeys,
  roleMaySelfEditLead,
} from "../lib/oasis-sales-pipeline-policy";

/* ─── the stamp ───────────────────────────────────────────────────────────── */

// Any single website-sales key is enough: a scraped lead with only a URL is
// still a website-sales lead, and an unstamped one is invisible on the board.
assert.equal(isWebsiteSalesLead({ website: "expertvelo.com" }), true);
assert.equal(isWebsiteSalesLead({ website_condition: "Has a site, not yet reviewed" }), true);
assert.equal(isWebsiteSalesLead({ audit_findings: "No mobile layout" }), true);
assert.equal(isWebsiteSalesLead({ icp_track: "local_services" }), true);

// A plain contact is not one, and must NOT be stamped onto the website board.
assert.equal(isWebsiteSalesLead({ name: "Bob", email: "b@x.com", phone: "5551234" }), false);
assert.deepEqual(stampSalesProgram({ name: "Bob", phone: "5551234" }), {});

// Whitespace is not a value — " " must not stamp a lead onto the board.
assert.equal(isWebsiteSalesLead({ website: "   " }), false);

assert.deepEqual(stampSalesProgram({ website: "expertvelo.com" }), {
  sales_program: OASIS_WEBSITE_SALES_PROGRAM,
});

// An explicit classification outranks our inference — never re-stamp a lead
// that already belongs to a program.
assert.deepEqual(stampSalesProgram({ website: "x.com", sales_program: "other_program_v3" }), {});

/* ─── the fields that were being dropped ──────────────────────────────────── */

const scraped = {
  name: "Bob Cyclo",
  website: "  http://www.expertvelo.com  ",
  website_condition: "Has a site, not yet reviewed",
  audit_findings: "Not audited yet - confirm on the call",
  icp_track: "sports_outdoors",
  business_city: "Laval",
  state: "QC",
  irrelevant_key: "dropped on purpose",
};

const carried = pickWebsiteSalesFields(scraped);
assert.equal(carried.website, "http://www.expertvelo.com", "trims, so a padded cell still links");
assert.equal(carried.website_condition, "Has a site, not yet reviewed");
assert.equal(carried.audit_findings, "Not audited yet - confirm on the call");
assert.equal(carried.icp_track, "sports_outdoors");
assert.equal(carried.business_city, "Laval");
assert.equal(carried.state, "QC");
assert.equal("irrelevant_key" in carried, false, "picks a known set, not the whole row");
assert.equal("name" in carried, false, "contact fields are the caller's business");

// The OSM importer writes webdev_industry; every UI reads industry. Collapsing
// them here is why the same lead stops showing an industry on one screen and a
// blank on the other.
assert.equal(pickWebsiteSalesFields({ webdev_industry: "Sports & Outdoors" }).industry, "Sports & Outdoors");
// An explicit `industry` wins over the legacy alias.
assert.equal(
  pickWebsiteSalesFields({ industry: "Cycling", webdev_industry: "Sports & Outdoors" }).industry,
  "Cycling",
);
assert.deepEqual(pickWebsiteSalesFields({ name: "Bob" }), {});

/* ─── the stage vocabularies, which do not overlap ────────────────────────── */

const oasisKeys = new Set(OASIS_LEAD_STAGE_KEYS);
const sunbizKeys = new Set(LEAD_PIPELINE_STAGES.map((s) => s.key));
for (const key of oasisKeys) {
  assert.equal(
    sunbizKeys.has(key),
    false,
    `"${key}" is in BOTH vocabularies — normalizeStageForTenant's whole premise is that they are disjoint`,
  );
}

const oasis = { isWebsiteSales: true, validStageKeys: OASIS_LEAD_STAGE_KEYS };

// Blank / generic intake → the pipeline's own intake stage.
assert.equal(normalizeStageForTenant(null, oasis), OASIS_INTAKE_STAGE);
assert.equal(normalizeStageForTenant("", oasis), OASIS_INTAKE_STAGE);
assert.equal(normalizeStageForTenant("new", oasis), OASIS_INTAKE_STAGE);
assert.equal(normalizeStageForTenant("New Contact".toLowerCase().replace(" ", "_"), oasis), OASIS_INTAKE_STAGE);

// A real OASIS stage is preserved, case-insensitively.
assert.equal(normalizeStageForTenant("assigned", oasis), "assigned");
assert.equal(normalizeStageForTenant("QUALIFIED", oasis), "qualified");

// THE BUG: a SunBiz stage on a website-sales lead has no column on the OASIS
// board. Writing it through is what stranded rows off-board; it becomes intake.
assert.equal(normalizeStageForTenant("uw_sheet", oasis), OASIS_INTAKE_STAGE);
assert.equal(normalizeStageForTenant("imported", oasis), OASIS_INTAKE_STAGE);
// Free text from a spreadsheet column ("Hot Lead") likewise.
assert.equal(normalizeStageForTenant("Hot Lead", oasis), OASIS_INTAKE_STAGE);

// And the mirror image: SunBiz rows keep SunBiz intake, so this change cannot
// quietly migrate the funding pipeline onto OASIS stages.
const sunbiz = { isWebsiteSales: false, validStageKeys: LEAD_PIPELINE_STAGES.map((s) => s.key) };
assert.equal(normalizeStageForTenant(null, sunbiz), SUNBIZ_INTAKE_STAGE);
assert.equal(normalizeStageForTenant("uw_sheet", sunbiz), "uw_sheet");
assert.equal(normalizeStageForTenant("assigned", sunbiz), SUNBIZ_INTAKE_STAGE, "OASIS stage is foreign here");

// The wrapper importers actually call. It exists so that lib/import/ (SunBiz
// portal-owned) never has to import lib/oasis-* — the portal-boundary test
// fails the build on that, and it is the reason this knowledge lives in a
// neutral module instead of being passed in by each caller.
assert.equal(stageForWebsiteSalesLead(null), OASIS_INTAKE_STAGE);
assert.equal(stageForWebsiteSalesLead("uw_sheet"), OASIS_INTAKE_STAGE);
assert.equal(stageForWebsiteSalesLead("connected"), "connected");

/* ─── what a rep may edit on their own lead (CC decision, 2026-08-24) ──────── */

// The facts of the lead: yes. A rep on a call fixes the phone number.
assert.deepEqual(rejectedRepPatchKeys({ phone: "514-555-0000", notes: "left VM" }), []);
assert.deepEqual(rejectedRepPatchKeys({ website: "x.com", audit_findings: "no ssl" }), []);

// The shape of the pipeline: no. These decide whose board a lead sits on and
// who gets paid for it, and they have their own audited routes.
assert.deepEqual(rejectedRepPatchKeys({ stage: "won" }), ["stage"]);
assert.deepEqual(rejectedRepPatchKeys({ assigned_to: "someone-else" }), ["assigned_to"]);
assert.deepEqual(rejectedRepPatchKeys({ sales_program: "x" }), ["sales_program"]);
assert.deepEqual(rejectedRepPatchKeys({ collaborators: [] }), ["collaborators"]);

// Mixed patch: the whole thing is refused, and the message names every offender
// rather than silently saving half the form.
assert.deepEqual(rejectedRepPatchKeys({ phone: "1", stage: "won", assigned_to: "x" }).sort(), [
  "assigned_to",
  "stage",
]);

// Allowlist, not denylist: a field nobody has classified is refused by default.
assert.deepEqual(rejectedRepPatchKeys({ some_future_field: 1 }), ["some_future_field"]);
assert.equal(REP_EDITABLE_LEAD_FIELDS.has("stage"), false);
assert.equal(REP_EDITABLE_LEAD_FIELDS.has("website"), true);
assert.equal(REP_EDITABLE_LEAD_FIELDS.has("next_action_at"), true, "reps may schedule the next touch on their own lead");

/* ─── ownership is the WRITE question, visibility is not ──────────────────────
 *
 * Caught during self-review, before ship. The rep-edit gate first used
 * canOpenOasisSalesRecord — the predicate that decides whether a lead may be
 * OPENED. That one treats `member` as an admin, and `member` is the team_role
 * COLUMN DEFAULT, so gating an edit on it silently handed every default-role
 * account write access to every lead in the tenant. A read predicate answering
 * a write question is the whole bug class; these assertions pin the split.
 */

const someoneElsesLead = { id: "L1", data: { assigned_to: "REP-1", stage: "assigned" } };

// A `member` may LOOK at any lead on the board...
assert.equal(
  canOpenOasisSalesRecord(someoneElsesLead, { role: "member", userId: "rep-2" }),
  true,
  "member keeps board-wide visibility — that is deliberate",
);
// ...and may NOT write to one that isn't theirs.
assert.equal(
  ownsOasisSalesRecord(someoneElsesLead, "rep-2"),
  false,
  "REGRESSION: a role shortcut has crept back into the write gate",
);

// The assigned rep owns it (case-insensitively — assignments are stored lowercased).
assert.equal(ownsOasisSalesRecord(someoneElsesLead, "rep-1"), true);
assert.equal(ownsOasisSalesRecord(someoneElsesLead, "REP-1"), true);

// A collaborator owns it too: an opener who handed off is still paid on it.
assert.equal(
  ownsOasisSalesRecord({ id: "L2", data: { assigned_to: "rep-1", collaborators: ["rep-9"] } }, "rep-9"),
  true,
);

// Fail closed: no identity, and an unassigned lead, belong to nobody.
assert.equal(ownsOasisSalesRecord(someoneElsesLead, null), false);
assert.equal(ownsOasisSalesRecord({ id: "L3", data: {} }, "rep-1"), false);
assert.equal(ownsOasisSalesRecord({ id: "L4", data: { assigned_to: "" } }, ""), false);

/* ─── the tenant guard on classification (Codex audit, finding 3) ────────────
 *
 * The shared import routes serve BOTH pipelines. Inferring the program from a
 * `website` column alone would take a SunBiz MCA lead imported at uw_sheet,
 * restamp it as website-sales and move it to `researched` — walking it out of
 * the Live Subs workflow it was filed into. A business website is ordinary
 * information on a funding application, so the tenant decides, not the column.
 */

assert.equal(isWebsiteSalesTenantSlug("oasis-webdev"), true);
assert.equal(isWebsiteSalesTenantSlug("oasis-ai-cc"), true);
assert.equal(isWebsiteSalesTenantSlug("OASIS"), true, "case-insensitive");
assert.equal(isWebsiteSalesTenantSlug("sun"), false);
assert.equal(isWebsiteSalesTenantSlug("suga"), false);
assert.equal(isWebsiteSalesTenantSlug("submissions"), false);
assert.equal(isWebsiteSalesTenantSlug(null), false, "fails closed");
assert.equal(isWebsiteSalesTenantSlug(""), false);

const merchantWithSite = { website: "merchant.com", business_name: "Reyes Motors" };
assert.deepEqual(
  stampSalesProgramForTenant(merchantWithSite, "sun"),
  {},
  "REGRESSION: a SunBiz merchant's website would drag it onto the OASIS board",
);
assert.deepEqual(stampSalesProgramForTenant(merchantWithSite, "oasis-webdev"), {
  sales_program: OASIS_WEBSITE_SALES_PROGRAM,
});
// Unknown / client tenants are not the website-sales program either.
assert.deepEqual(stampSalesProgramForTenant(merchantWithSite, "some-client"), {});

/* ─── the role floor on self-editing (Codex audit, finding 2) ────────────────
 *
 * Ownership is not authority. A read_only account can legitimately be named on
 * a deal as an observer, and gating the edit on ownership alone handed it the
 * write access its own role name denies.
 */

assert.equal(roleMaySelfEditLead("read_only"), false, "REGRESSION: read_only regained write access");
assert.equal(roleMaySelfEditLead(null), false, "fails closed");
assert.equal(roleMaySelfEditLead(""), false);
assert.equal(roleMaySelfEditLead("not_a_real_role"), false, "fails closed on an unknown role");

for (const role of ["closer", "opener", "manager", "builder", "marketing", "agent", "member"]) {
  assert.equal(roleMaySelfEditLead(role), true, `${role} should be able to edit its own lead`);
}

console.log("lead-transfer-canonical: OK");
