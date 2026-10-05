import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { summarizeSalesRepLeads } from "../lib/audit/sales-performance-core";
import { isOasisPipelineRepRole } from "../lib/team-roles";

const now = Date.parse("2026-09-01T12:00:00.000Z");
const summary = summarizeSalesRepLeads(
  [
    { data: { stage: "assigned", next_action_at: "2026-09-01T11:00:00.000Z" } },
    { data: { stage: "attempting_contact", last_contacted_at: "2026-08-31T10:00:00.000Z" } },
    { data: { stage: "qualified", qualified_at: "2026-08-30T10:00:00.000Z" } },
    { data: { stage: "founder_meeting_booked", founder_meeting_at: "2026-09-02T10:00:00.000Z" } },
    { data: { stage: "onboarding", next_action_at: "2026-08-01T00:00:00.000Z" } },
    { data: { stage: "lost", next_follow_up_at: "2026-08-01T00:00:00.000Z" } },
  ],
  now,
);

assert.deepEqual(summary, {
  assigned: 6,
  contacted: 1,
  qualified: 3,
  booked: 2,
  won: 1,
  lost: 1,
  overdue: 1,
});

assert.deepEqual(summarizeSalesRepLeads([{ data: null }, { data: {} }], now), {
  assigned: 2,
  contacted: 0,
  qualified: 0,
  booked: 0,
  won: 0,
  lost: 0,
  overdue: 0,
});

for (const role of ["manager", "closer", "opener", "builder", "marketing", "agent"]) {
  assert.equal(isOasisPipelineRepRole(role), true, `${role} belongs in the manager rep roster`);
}
for (const role of ["owner", "admin", "member", "read_only"]) {
  assert.equal(
    isOasisPipelineRepRole(role),
    false,
    `${role} must stay outside manager performance and activity scope`,
  );
}

const performanceSource = readFileSync(
  join(process.cwd(), "lib", "audit", "sales-performance.ts"),
  "utf8",
);
assert.match(
  performanceSource,
  /\.in\("data->>assigned_to", \[\.\.\.repUserIds\]\)/,
  "team lead metrics must use one roster-scoped paginated query, not one scan per rep",
);
assert.match(
  performanceSource,
  /\.in\("actor_user_id", \[\.\.\.repUserIds\]\)/,
  "team touch metrics must use one roster-scoped paginated query, not one count per rep",
);
assert.doesNotMatch(
  performanceSource,
  /members\.map\(async/,
  "Settings must not fan out two database calls for every sales rep",
);

console.log("sales-team-performance.test.ts: OK");
