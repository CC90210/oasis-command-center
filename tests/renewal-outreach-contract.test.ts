import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
const migration = read("database/132_renewal_outreach.sql");
const outreach = read("lib/renewals/outreach.ts");
const row = read("components/renewals/renewals-shared.tsx");
const renewalApi = read("app/api/renewals/[id]/route.ts");
const drawer = read("components/renewals/RenewalDetailDrawer.tsx");

assert.match(migration, /unique\(funded_deal_id, event_kind\)/, "database prevents duplicate threshold events");
assert.match(migration, /lender_id uuid references public\.tenant_records/, "funded deals link canonical lenders");
// The 50%-threshold cron (/api/cron/renewal-thresholds) served SunBiz only; it
// was unscheduled at the retirement and deleted 2026-10-01 (OS plan W0).
assert.equal(fs.existsSync(path.join(process.cwd(), "app/api/cron/renewal-thresholds")), false, "the retired renewal-thresholds cron is back");
assert.match(outreach, /may be eligible to discuss renewal options/, "lender message is the approved minimal inquiry");
assert.doesNotMatch(outreach, /factor_rate|funded_amount_usd|contact_phone/, "lender message excludes sensitive deal fields");
assert.match(row, /event\.stopPropagation\(\)/, "row contact actions do not open the renewal drawer");
assert.match(renewalApi, /export async function DELETE/, "renewals expose a deletion endpoint");
assert.match(renewalApi, /send\.status === "sending"/, "deletion cannot race an in-progress lender send");
assert.match(renewalApi, /status: "cancelled"/, "deletion cancels queued lender sends");
assert.match(drawer, /Delete renewal/, "renewal drawer exposes deliberate deletion");
assert.match(drawer, /lender_id: lenderId/, "renewal editing supports correcting the linked lender");

console.log("renewal-outreach-contract tests passed");
