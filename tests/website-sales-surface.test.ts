import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("app/sales-engine/page.tsx", "utf8");
const playbookIndex = readFileSync("app/playbook/page.tsx", "utf8");
const nav = readFileSync("lib/nav-config.ts", "utf8");

for (const heading of ["Rep Queue", "Founder Handoffs", "Proposal & Close", "Fulfillment", "Commission Ledger"]) {
  assert(page.includes(heading), `sales engine renders ${heading}`);
}
assert(page.includes('.eq("tenant_id", session.tenantId)'), "sales engine queries are tenant-scoped");
assert(page.includes('data->>assigned_to') || page.includes("assigned_to"), "rep queue uses lead ownership");
assert(nav.includes('href: "/sales-engine"'), "CC navigation links to the sales engine");
assert(playbookIndex.includes('href: "/playbook/script"') && playbookIndex.includes('title: "Sales Rep Script"'), "playbook landing page visibly links the rep script");
assert(playbookIndex.includes('href: "/sales-engine"') && playbookIndex.includes('title: "Sales Engine"'), "playbook landing page links the operating sales workspace");

console.log("website-sales-surface ok");
