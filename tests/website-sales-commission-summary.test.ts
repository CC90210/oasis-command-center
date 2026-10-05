import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createTursoPostgrest } from "../lib/turso-postgrest";
import {
  commissionPartyRoleLabel,
  formatCommissionAmounts,
  loadWebsiteSalesCommissionListing,
  loadWebsiteSalesCommissionSummary,
} from "../lib/website-sales-commission-summary";

assert.equal(commissionPartyRoleLabel("full_stack", 3_500), "Finder + closer");
assert.equal(commissionPartyRoleLabel("full_stack", 4_000), "Finder + closer", "accelerated finder/closer stays truthful");
assert.equal(commissionPartyRoleLabel("full_stack", 7_000), "Finder + closer + builder");
assert.equal(commissionPartyRoleLabel("full_stack", 6_000), "Finder + closer + builder", "discounted all-in deal stays truthful");
assert.equal(commissionPartyRoleLabel("closer", 2_500), "Closer");

async function main() {
const client = createClient({ url: "file::memory:?cache=shared" });
await client.executeMultiple(`
  CREATE TABLE website_deals (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    currency TEXT NOT NULL
  );
  CREATE TABLE website_sales_commissions (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    deal_id TEXT NOT NULL,
    rep_user_id TEXT NOT NULL,
    party_role TEXT NOT NULL,
    status TEXT NOT NULL,
    amount_cents INTEGER,
    amount REAL,
    entry_type TEXT NOT NULL DEFAULT 'accrual',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`);
await client.batch([
  { sql: "INSERT INTO website_deals VALUES (?,?,?)", args: ["deal-cad", "tenant-a", "CAD"] },
  { sql: "INSERT INTO website_deals VALUES (?,?,?)", args: ["deal-usd", "tenant-a", "USD"] },
  { sql: "INSERT INTO website_deals VALUES (?,?,?)", args: ["deal-other-tenant", "tenant-b", "CAD"] },
], "write");

const rows: Array<{ sql: string; args: Array<string | number | null> }> = [];
for (let index = 0; index < 500; index += 1) {
  rows.push({
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: [`cad-${String(index).padStart(3, "0")}`, "tenant-a", "deal-cad", "rep-a", "closer", "accrued", 100, 1],
  });
}
rows.push(
  {
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: ["usd-paid", "tenant-a", "deal-usd", "rep-a", "closer", "paid", 250, 2.5],
  },
  {
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: ["cad-offset", "tenant-a", "deal-cad", "rep-a", "closer", "offset", -100, -1],
  },
  {
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: ["other-rep", "tenant-a", "deal-cad", "rep-b", "closer", "accrued", 999_999, 9_999.99],
  },
  {
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: ["other-tenant", "tenant-b", "deal-other-tenant", "rep-a", "closer", "accrued", 999_999, 9_999.99],
  },
  {
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: ["manager-cad", "tenant-a", "deal-cad", "manager-a", "manager", "approved", 300, 3],
  },
  {
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: ["manager-usd", "tenant-a", "deal-usd", "manager-a", "manager", "paid", 400, 4],
  },
);
for (let offset = 0; offset < rows.length; offset += 200) {
  await client.batch(rows.slice(offset, offset + 200), "write");
}

const db = createTursoPostgrest(client) as unknown as SupabaseClient;
const repSummary = await loadWebsiteSalesCommissionSummary(db, {
  tenantId: "tenant-a",
  repUserId: "rep-a",
});
assert.equal(repSummary.entryCount, 502, "all rows beyond the old 200/500 caps are included");
assert.deepEqual(repSummary.totals, [
  {
    currency: "CAD",
    accruedCents: 50_000,
    approvedCents: 0,
    paidCents: 0,
    offsetCents: -100,
    netCents: 49_900,
  },
  {
    currency: "USD",
    accruedCents: 0,
    approvedCents: 0,
    paidCents: 250,
    offsetCents: 0,
    netCents: 250,
  },
]);
assert.deepEqual(repSummary.byRep["rep-a"], repSummary.totals, "per-rep totals use the same complete ledger");
assert.equal(formatCommissionAmounts(repSummary.totals, ["accrued"]), "$500.00 CAD");
assert.equal(
  formatCommissionAmounts(repSummary.totals, ["accrued", "approved", "paid", "offset"]),
  "$499.00 CAD + US$2.50 USD",
  "CAD and USD stay separately labelled instead of becoming one false dollar amount",
);

const managerSummary = await loadWebsiteSalesCommissionSummary(db, {
  tenantId: "tenant-a",
  repUserId: "manager-a",
  partyRole: "manager",
});
assert.equal(managerSummary.entryCount, 2);
assert.equal(
  formatCommissionAmounts(managerSummary.totals, ["accrued", "approved", "paid"]),
  "$3.00 CAD + US$4.00 USD",
  "a manager's own override is also currency-separated",
);

const teamSalesSummary = await loadWebsiteSalesCommissionSummary(db, {
  tenantId: "tenant-a",
  repUserIds: ["rep-a", "manager-a"],
  excludePartyRole: "manager",
});
assert.equal(teamSalesSummary.entryCount, 502, "team sales excludes manager override rows shown in the separate card");
assert.deepEqual(
  teamSalesSummary.totals,
  repSummary.totals,
  "the direct-report ID scope excludes another manager's rep from every team total",
);
assert.equal(
  teamSalesSummary.byRep["manager-a"],
  undefined,
  "a manager override is never repeated inside the team commission breakdown",
);

type ManagerListingRow = { id: string; rep_user_id: string };
const managerTeamListing = await loadWebsiteSalesCommissionListing<ManagerListingRow>(db, {
  tenantId: "tenant-a",
  repUserIds: ["manager-a", "rep-a"],
  columns: "id,rep_user_id",
  recentLimit: 1_000,
});
assert.ok(
  managerTeamListing.rows.some((row) => row.id === "manager-cad") &&
    managerTeamListing.rows.some((row) => row.id === "cad-000"),
  "a manager ledger includes the manager's own entries and direct-report entries",
);
assert.equal(
  managerTeamListing.rows.some((row) => row.id === "other-rep"),
  false,
  "a same-tenant rep who does not report to this manager is excluded",
);
assert.equal(
  managerTeamListing.rows.some((row) => row.id === "other-tenant"),
  false,
  "the rep scope can never widen the tenant boundary",
);

await client.batch([
  { sql: "INSERT INTO website_deals VALUES (?,?,?)", args: ["deal-invalid", "tenant-invalid", "CAD"] },
  {
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount) VALUES (?,?,?,?,?,?,?,?)",
    args: ["missing-money", "tenant-invalid", "deal-invalid", "rep-invalid", "closer", "accrued", null, null],
  },
], "write");
await assert.rejects(
  loadWebsiteSalesCommissionSummary(db, { tenantId: "tenant-invalid", repUserId: "rep-invalid" }),
  /commission_summary_legacy_amount_missing:missing-money/,
  "a malformed money row fails closed instead of becoming a plausible $0 balance",
);

await client.execute({
  sql: "INSERT INTO website_deals VALUES (?,?,?)",
  args: ["deal-list", "tenant-list", "CAD"],
});
const listingRows: Array<{ sql: string; args: Array<string | number | null> }> = [{
  sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
  args: ["old-accrued", "tenant-list", "deal-list", "rep-list", "closer", "accrued", 12_500, 125, "2020-01-01T00:00:00.000Z"],
}];
for (let index = 0; index < 500; index += 1) {
  listingRows.push({
    sql: "INSERT INTO website_sales_commissions (id,tenant_id,deal_id,rep_user_id,party_role,status,amount_cents,amount,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    args: [
      `new-paid-${String(index).padStart(3, "0")}`,
      "tenant-list",
      "deal-list",
      "rep-list",
      "closer",
      "paid",
      100,
      1,
      new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    ],
  });
}
for (let offset = 0; offset < listingRows.length; offset += 200) {
  await client.batch(listingRows.slice(offset, offset + 200), "write");
}
type ListingRow = { id: string; status: string };
const listing = await loadWebsiteSalesCommissionListing<ListingRow>(db, {
  tenantId: "tenant-list",
  repUserId: "rep-list",
  columns: "id,status",
  recentLimit: 500,
});
assert.equal(listing.recentCount, 500);
assert.equal(listing.outstandingCount, 1);
assert.equal(listing.rows.length, 501);
assert.ok(
  listing.rows.some((row) => row.id === "old-accrued" && row.status === "accrued"),
  "an old accrued commission behind 500 newer paid rows remains in the founder action list",
);

console.log("website-sales-commission-summary: OK — 502 scoped rows, offsets, and CAD/USD stay authoritative");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
