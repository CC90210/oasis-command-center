import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildHumanActorMaps,
  getActivityFeed,
  resolveActivityAgent,
  sourceNamesDisabledAgent,
  type ActivityActor,
} from "@/lib/audit/activity-feed";
import { buildEmployeeActivityRollup } from "@/lib/audit/employee-rollup";
import { canonicalizeTenantMembers, type MemberRow } from "@/lib/team";

type Row = Record<string, unknown>;

function fakeDatabase(tables: Record<string, Row[]>) {
  const queriedTables: string[] = [];
  return {
    queriedTables,
    from(table: string) {
      queriedTables.push(table);
      let rows = [...(tables[table] || [])];
      let cap: number | null = null;
      // Test-only fluent adapter for the subset used by getActivityFeed().
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select() {
          return chain;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return chain;
        },
        in(column: string, values: unknown[]) {
          rows = rows.filter((row) => values.includes(row[column]));
          return chain;
        },
        not(column: string, operator: string, value: unknown) {
          if (operator === "is" && value === null) {
            rows = rows.filter((row) => row[column] != null);
          }
          return chain;
        },
        order(column: string, options: { ascending: boolean }) {
          rows.sort((left, right) => {
            const a = String(left[column] || "");
            const b = String(right[column] || "");
            return options.ascending ? a.localeCompare(b) : b.localeCompare(a);
          });
          return chain;
        },
        limit(value: number) {
          cap = value;
          return chain;
        },
        then(
          resolve: (value: { data: Row[]; error: null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          return Promise.resolve({ data: cap == null ? rows : rows.slice(0, cap), error: null }).then(
            resolve,
            reject,
          );
        },
      };
      return chain;
    },
  };
}

const members: MemberRow[] = [
  {
    id: "profile-cc",
    auth_user_id: "user-cc",
    email: "cc@oasis.test",
    full_name: "Conaugh McKenna",
    display_name: "CC",
    team_role: "owner",
    is_owner: true,
    admin_access: true,
    invited_by: null,
    joined_at: "2026-01-01T00:00:00.000Z",
  },
  {
    id: "profile-rep",
    auth_user_id: "user-rep",
    email: "rep@oasis.test",
    full_name: "OASIS Rep",
    display_name: null,
    team_role: "opener",
    is_owner: false,
    admin_access: false,
    invited_by: "user-cc",
    joined_at: "2026-08-20T00:00:00.000Z",
  },
];

const oasisAgents: ActivityActor[] = [
  { key: "agent:bravo", label: "Bravo", type: "agent" },
  { key: "agent:atlas", label: "Atlas", type: "agent" },
  { key: "agent:maven", label: "Maven", type: "agent" },
  { key: "agent:aura", label: "Aura", type: "agent" },
];

const now = "2026-08-25T04:00:00.000Z";
const db = fakeDatabase({
  tenant_audit_log: [
    {
      id: "audit-oasis",
      tenant_id: "oasis-tenant",
      actor_user_id: "user-rep",
      actor_email: "wrong@outside.test",
      action_type: "lead.stage_changed",
      target_table: "tenant_records",
      after: { stage: "qualified" },
      created_at: now,
    },
    {
      id: "audit-sunbiz",
      tenant_id: "sunbiz-tenant",
      actor_user_id: "sunbiz-user",
      actor_email: "matt@sunbiz.test",
      action_type: "invite.create",
      target_table: "tenant_invites",
      after: {},
      created_at: now,
    },
  ],
  lead_interactions: [
    {
      id: "interaction-oasis-rep",
      tenant_id: "oasis-tenant",
      actor_user_id: "user-rep",
      metadata: { requested_by_email: "matt@sunbiz.test" },
      type: "call_started",
      channel: "call",
      direction: "outbound",
      agent_source: "dashboard",
      created_at: now,
    },
    {
      id: "interaction-stale-helios",
      tenant_id: "oasis-tenant",
      actor_user_id: null,
      metadata: {},
      type: "outbound.recorded",
      channel: "email",
      direction: "outbound",
      agent_source: "helios",
      created_at: now,
    },
    {
      id: "interaction-stale-sunbiz-family",
      tenant_id: "oasis-tenant",
      actor_user_id: null,
      metadata: {},
      type: "outbound.recorded",
      channel: "email",
      direction: "outbound",
      agent_source: "sunbiz-sequence-runner",
      to_email: "merchant@sunbiz.test",
      created_at: now,
    },
    {
      id: "interaction-other-tenant",
      tenant_id: "sunbiz-tenant",
      actor_user_id: "user-rep",
      metadata: {},
      type: "email_sent",
      channel: "email",
      direction: "outbound",
      agent_source: "helios",
      created_at: now,
    },
  ],
  agent_events: [
    {
      id: "event-oasis-bravo",
      correlation_id: "oasis-tenant",
      publisher_agent: "bravo",
      event_type: "pipeline.reviewed",
      payload: { tenant_id: "oasis-tenant" },
      created_at: now,
    },
    {
      id: "event-oasis-helios",
      correlation_id: "oasis-tenant",
      publisher_agent: "helios",
      event_type: "outbound.recorded",
      payload: { tenant_id: "oasis-tenant" },
      created_at: now,
    },
    {
      id: "event-sunbiz",
      correlation_id: "sunbiz-tenant",
      publisher_agent: "bravo",
      event_type: "must.not.leak",
      payload: { tenant_id: "sunbiz-tenant" },
      created_at: now,
    },
  ],
  chat_sessions: [
    {
      id: "chat-oasis",
      tenant_id: "oasis-tenant",
      user_id: "user-cc",
      agent_key: "bravo",
      created_at: now,
    },
    {
      id: "chat-stale-helios",
      tenant_id: "oasis-tenant",
      user_id: "user-cc",
      agent_key: "helios",
      created_at: now,
    },
  ],
  tenant_cron_jobs: [
    {
      id: "cron-oasis",
      tenant_id: "oasis-tenant",
      name: "Daily review",
      agent_key: "bravo",
      schedule: "daily",
      last_run_at: now,
      last_run_status: "success",
      run_count: 4,
    },
    {
      id: "cron-stale-helios",
      tenant_id: "oasis-tenant",
      name: "SunBiz outreach",
      agent_key: "helios",
      schedule: "daily",
      last_run_at: now,
      last_run_status: "success",
      run_count: 4,
    },
  ],
});

async function main() {
const { actors: humanActors, byEmail, byId } = buildHumanActorMaps(members);
assert.deepEqual(
  humanActors.map((actor) => actor.label),
  ["CC", "OASIS Rep"],
  "the roster comes from this tenant's real profiles, not a static name list",
);
assert.equal(byId.get("user-rep")?.label, "OASIS Rep");
assert.equal(byEmail.get("rep@oasis.test")?.key, "human:profile-rep");

assert.equal(resolveActivityAgent("bravo-scheduler", oasisAgents)?.label, "Bravo");
assert.equal(
  resolveActivityAgent("cold_outreach", oasisAgents),
  null,
  "a SunBiz source family is not attributed when Helios is not enabled",
);
assert.equal(sourceNamesDisabledAgent("helios", oasisAgents), true);
for (const foreignFamily of [
  "sunbiz-sequence-runner",
  "cold_outreach",
  "sequence",
  "texttorrent",
  "follow_up",
  "underwriting",
]) {
  assert.equal(
    sourceNamesDisabledAgent(foreignFamily, oasisAgents),
    true,
    `${foreignFamily} must not be relabelled System when its owning agent is disabled`,
  );
}
assert.equal(sourceNamesDisabledAgent("bravo-scheduler", oasisAgents), false);

const canonicalMembers = canonicalizeTenantMembers([
  ...members,
  {
    ...members[1],
    id: "profile-rep-duplicate",
    full_name: "rep@oasis.test00",
    display_name: null,
    joined_at: "2026-08-21T00:00:00.000Z",
  },
]);
assert.equal(canonicalMembers.length, 2, "duplicate auth/email profiles render as one teammate");
assert.equal(
  canonicalMembers.find((member) => member.auth_user_id === "user-rep")?.id,
  "profile-rep",
  "the richer deterministic profile wins over a malformed duplicate",
);

const normalizedLegacyMember = canonicalizeTenantMembers([
  {
    ...members[1],
    full_name: "rep@oasis.test00",
    display_name: null,
  },
])[0];
assert.equal(normalizedLegacyMember.full_name, "Rep", "email-shaped names become a human label");

const feed = await getActivityFeed("oasis-tenant", {
  members,
  agents: oasisAgents,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: db as any,
});
assert.equal(feed.errors.length, 0);
assert.ok(feed.rows.some((row) => row.id === "li:interaction-oasis-rep"));
assert.equal(
  feed.rows.find((row) => row.id === "li:interaction-oasis-rep")?.actor,
  "OASIS Rep",
  "server-stamped user id wins over untrusted/stale metadata email",
);
assert.ok(
  !feed.rows.some((row) => row.id === "li:interaction-stale-helios"),
  "a disabled foreign persona's interaction is dropped, not relabelled with its target intact",
);
assert.ok(
  !feed.rows.some((row) => row.id === "li:interaction-stale-sunbiz-family"),
  "a disabled foreign agent family is dropped before its target can leak under System",
);
assert.ok(!feed.rows.some((row) => row.id.includes("sunbiz") || row.action === "must.not.leak"));
assert.ok(!feed.rows.some((row) => row.actor === "Helios" || row.target.includes("Helios")));
assert.ok(!feed.actors.some((actor) => ["Matt", "Jordan", "Alex", "Helios", "Solara"].includes(actor.label)));
assert.deepEqual(
  feed.actors.filter((actor) => actor.type === "agent").map((actor) => actor.label),
  ["Bravo", "Atlas", "Maven", "Aura"],
);

const filtered = await getActivityFeed("oasis-tenant", {
  actor: "human:profile-rep",
  members,
  agents: oasisAgents,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: db as any,
});
assert.ok(filtered.rows.length > 0);
assert.ok(filtered.rows.every((row) => row.actorKey === "human:profile-rep"));

db.queriedTables.length = 0;
const managerFeed = await getActivityFeed("oasis-tenant", {
  scope: "sales_team",
  salesActorUserIds: ["user-rep"],
  members,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: db as any,
});
assert.deepEqual(
  db.queriedTables,
  ["lead_interactions"],
  "manager activity must never query tenant audits, agents, chats, crons, or automations",
);
assert.deepEqual(managerFeed.actors.map((actor) => actor.label), ["OASIS Rep"]);
assert.deepEqual(managerFeed.rows.map((row) => row.id), ["li:interaction-oasis-rep"]);
assert.ok(managerFeed.rows.every((row) => row.actorType === "human"));
const activitySource = readFileSync(
  new URL("../lib/audit/activity-feed.ts", import.meta.url),
  "utf8",
);
assert.equal(
  activitySource.includes("getTenantMembers(tenantId).catch(() => [])"),
  false,
  "a roster outage must not silently relabel human activity as System",
);
assert.ok(activitySource.includes("errors: [`team_members:"));

const skewMembers: MemberRow[] = [
  {
    ...members[1],
    id: "profile-busy",
    auth_user_id: "user-busy",
    email: "busy@oasis.test",
    full_name: "Busy Rep",
  },
  {
    ...members[1],
    id: "profile-quiet",
    auth_user_id: "user-quiet",
    email: "quiet@oasis.test",
    full_name: "Quiet Rep",
  },
];
const skewDb = fakeDatabase({
  lead_interactions: [
    ...Array.from({ length: 200 }, (_, index) => ({
      id: `busy-${index}`,
      tenant_id: "oasis-tenant",
      actor_user_id: "user-busy",
      metadata: {},
      type: "call_started",
      channel: "call",
      direction: "outbound",
      agent_source: "dashboard",
      created_at: new Date(Date.parse(now) + index * 1_000).toISOString(),
    })),
    {
      id: "quiet-older",
      tenant_id: "oasis-tenant",
      actor_user_id: "user-quiet",
      metadata: {},
      type: "note_added",
      channel: "internal",
      direction: "outbound",
      agent_source: "dashboard",
      created_at: "2026-08-01T00:00:00.000Z",
    },
  ],
});
const quietRepFeed = await getActivityFeed("oasis-tenant", {
  actor: "human:profile-quiet",
  limit: 1,
  scope: "sales_team",
  salesActorUserIds: ["user-busy", "user-quiet"],
  members: skewMembers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: skewDb as any,
});
assert.deepEqual(
  quietRepFeed.rows.map((row) => row.id),
  ["li:quiet-older"],
  "a selected quiet rep must be filtered in the database before busy teammates consume the row limit",
);

const rollup = buildEmployeeActivityRollup(
  members,
  [
    {
      channel: "call",
      direction: "outbound",
      actor_user_id: "user-rep",
      metadata: { requested_by_email: "matt@sunbiz.test" },
    },
    {
      channel: "email",
      direction: "outbound",
      actor_user_id: null,
      metadata: { requested_by_email: "cc@oasis.test" },
    },
    {
      channel: "sms",
      direction: "outbound",
      actor_user_id: null,
      metadata: { requested_by_email: "outsider@sunbiz.test" },
    },
  ],
  [{ actor_user_id: "user-rep", actor_email: "wrong@outside.test" }],
);
assert.equal(rollup.length, 2, "every connected rep renders, including zero-activity reps");
assert.equal(rollup.find((row) => row.profileId === "profile-rep")?.call_actions, 1);
assert.equal(rollup.find((row) => row.profileId === "profile-rep")?.recent_actions, 2);
assert.equal(rollup.find((row) => row.profileId === "profile-cc")?.email_sends, 1);
assert.ok(!rollup.some((row) => row.email.includes("sunbiz")), "foreign metadata cannot add a rep");

const operationsPanel = readFileSync(
  new URL("../components/settings/OperationsTrackerPanel.tsx", import.meta.url),
  "utf8",
);
assert.ok(
  !operationsPanel.includes(".limit(1_000)"),
  "seven-day rep totals must not silently stop at the first database page",
);
assert.equal(
  operationsPanel.match(/\.order\("id", \{ ascending: true \}\)\s*\.range\(/gu)?.length,
  2,
  "both metric sources must page in a stable primary-key order",
);
assert.ok(
  operationsPanel.includes("no partial totals are being shown"),
  "a failed metrics page must be disclosed instead of rendering false zeroes",
);

console.log("activity log tenant isolation: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
