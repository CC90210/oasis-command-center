import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  daysUntil,
  fmtDate,
  groupRows,
  renewalProgress,
} from "../lib/renewals-core";
import type { FundedDealRow } from "../lib/queries";

const base: FundedDealRow = {
  id: "deal",
  merchant_name: "Merchant",
  contact_name: null,
  lender_name: null,
  funded_amount_usd: 10_000,
  factor_rate: null,
  funded_at: "2026-01-01T00:00:00.000Z",
  next_renewal_date: null,
  est_commission_usd: null,
};

const now = new Date("2026-07-30T12:00:00.000Z");
const rows: FundedDealRow[] = [
  { ...base, id: "past", next_renewal_date: "2026-07-01T00:00:00.000Z" },
  { ...base, id: "soon", next_renewal_date: "2026-08-15T00:00:00.000Z" },
  { ...base, id: "later", next_renewal_date: "2027-01-01T00:00:00.000Z" },
  { ...base, id: "missing" },
  { ...base, id: "invalid", next_renewal_date: "not-a-date", funded_amount_usd: Number.NaN },
];

assert.deepEqual(
  groupRows(rows, now).map((group) => [group.label, group.rows.map((row) => row.id), group.subtotal]),
  [
    ["PAST DUE", ["past"], 10_000],
    ["NEXT 60 DAYS", ["soon"], 10_000],
    ["LATER", ["later"], 10_000],
    ["NO DATE SET", ["missing", "invalid"], 10_000],
  ],
);
assert.equal(fmtDate("not-a-date"), "—");
assert.equal(daysUntil("not-a-date"), null);
assert.equal(renewalProgress({ ...base, next_renewal_date: "not-a-date" }), null);

const source = readFileSync(new URL("../lib/renewals-core.ts", import.meta.url), "utf8");
assert.doesNotMatch(source, /from\s+["'](?:react|lucide-react|@\/components\/)/);
assert.doesNotMatch(source, /["']use client["']/);

console.log("ok renewals-core");
