/**
 * tests/activity-log-roster.test.ts — the Activity log tells the truth about
 * who is on the team now, folds a bulk action into one line, and sits on the
 * OS chrome.
 *
 *   S1-C1 / S5-F07  the chips and the "N team members" count come from
 *                   CURRENT members; a teammate deactivated since keeps their
 *                   name on old rows and sits in a collapsed "Former" group.
 *   S1-C3           thirty "stage_changed · web_leads_claim" rows from one
 *                   bulk claim fold into one row that names the leads.
 *   S1-C4           PageFrame and the OS table, not components/Card.tsx.
 *   S5 verifier     agent chips go through lib/os/teammate-names, so a client
 *                   workspace never prints a persona slug.
 *
 * Run: node --conditions=react-server --import tsx tests/activity-log-roster.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import type { MemberRow } from "@/lib/team";

const ROOT = join(__dirname, "..");
// tsconfig.json sets jsx:"preserve", so tsx compiles JSX with the classic
// runtime, which expects a global React (as tests/os-channels-honest.test.ts).
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
// next/link needs the client router context, which react-server lacks; the chips only need an <a>.
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});

type Row = Record<string, unknown>;

/** The subset of the Supabase/Turso fluent adapter getActivityFeed uses (as tests/activity-log-tenant-isolation). */
function fakeDatabase(tables: Record<string, Row[]>) {
  const queriedTables: string[] = [];
  return {
    queriedTables,
    from(table: string) {
      queriedTables.push(table);
      let rows = [...(tables[table] || [])];
      let cap: number | null = null;
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
          if (operator === "is" && value === null) rows = rows.filter((row) => row[column] != null);
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
        then(resolve: (value: { data: Row[]; error: null }) => unknown, reject?: (reason: unknown) => unknown) {
          return Promise.resolve({ data: cap == null ? rows : rows.slice(0, cap), error: null }).then(resolve, reject);
        },
      };
      return chain;
    },
  };
}

const member = (over: Partial<MemberRow> & Pick<MemberRow, "id" | "auth_user_id" | "email" | "full_name">): MemberRow => ({
  display_name: null,
  team_role: "opener",
  is_owner: false,
  admin_access: false,
  invited_by: null,
  joined_at: "2026-01-01T00:00:00.000Z",
  ...over,
});
const members: MemberRow[] = [
  member({ id: "profile-cc", auth_user_id: "user-cc", email: "cc@oasis.test", full_name: "Conaugh McKenna", display_name: "CC", team_role: "owner", is_owner: true, admin_access: true }),
  member({ id: "profile-rep", auth_user_id: "user-rep", email: "rep@oasis.test", full_name: "OASIS Rep" }),
  // Deactivated on the 09-24 retirement, with rows in the window: "former".
  member({ id: "profile-former", auth_user_id: "user-former", email: "former@oasis.test", full_name: "Former Rep", deactivated_at: "2026-09-24T12:00:00.000Z" }),
  // Deactivated, with no rows in the window: not a chip anywhere.
  member({ id: "profile-ghost", auth_user_id: "user-ghost", email: "ghost@oasis.test", full_name: "Ghost Rep", deactivated_at: "2026-09-24T12:00:00.000Z" }),
];
const agents = [
  { key: "agent:bravo", label: "Chief of Staff · Operations", type: "agent" as const },
  { key: "agent:atlas", label: "Finance", type: "agent" as const },
];

const NOW = Date.parse("2026-09-30T15:00:00.000Z");
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const TENANT = "oasis-tenant";
const claim = (i: number, at: string, leadId: string, id = `claim-${i}`): Row => ({
  id,
  tenant_id: TENANT,
  lead_id: leadId,
  type: "stage_changed",
  channel: "system",
  direction: "internal",
  agent_source: "web_leads_claim",
  actor_user_id: "user-cc",
  subject: "Lead claimed",
  content: "Lead claimed and moved prospect pool -> assigned.",
  metadata: { action: "claim", to: "assigned" },
  created_at: at,
});
const db = fakeDatabase({
  tenant_audit_log: [],
  agent_events: [],
  chat_sessions: [],
  tenant_cron_jobs: [],
  lead_interactions: [
    // One bulk claim: thirty rows, one timestamp.
    ...Array.from({ length: 30 }, (_, i) => claim(i, iso(0), `lead-${i}`)),
    // The same action three minutes earlier: outside the two-minute window.
    claim(99, iso(-3 * 60 * 1000), "lead-old", "claim-old"),
    // The former teammate's call, last week.
    {
      id: "former-call",
      tenant_id: TENANT,
      actor_user_id: "user-former",
      type: "call_started",
      channel: "call",
      direction: "outbound",
      agent_source: "dashboard",
      metadata: {},
      created_at: iso(-7 * 24 * 60 * 60 * 1000),
    },
  ],
  tenant_records: [
    ...Array.from({ length: 30 }, (_, i) => ({ id: `lead-${i}`, tenant_id: TENANT, entity_type: "lead", data: { business_name: `Business ${i}` } })),
    { id: "lead-old", tenant_id: TENANT, entity_type: "lead", data: JSON.stringify({ name: "Old Business" }) },
    // Another workspace's lead with the same id shape must never name a row here.
    { id: "lead-0", tenant_id: "other-tenant", entity_type: "lead", data: { business_name: "Leaked" } },
  ],
});

type El = { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> & { children?: unknown } };
/** Every string under a node's children (components are not called: Link is a stub element). */
function textOf(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  const el = node as El;
  return el.props ? textOf(el.props.children) : "";
}
function findEl(node: unknown, pred: (el: El) => boolean): El | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const hit = findEl(n, pred);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as El;
  if (el.$$typeof && el.props && pred(el)) return el;
  return el.props ? findEl(el.props.children, pred) : null;
}
/** Render the chip tree: call every function component so Chip/Link become elements. */
function expand(node: unknown): unknown {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expand);
  const el = node as El;
  if (!el.$$typeof || !el.props) return node;
  if (typeof el.type === "function") return expand((el.type as (p: unknown) => unknown)(el.props));
  return { ...el, props: { ...el.props, children: expand(el.props.children) } };
}

async function main() {
  const { activityAgentLabel, getActivityFeed, groupActivityRows } = await import("@/lib/audit/activity-feed");
  const { ActivityActorChips } = await import("@/components/settings/ActivityActorChips");
  const { humanizeAction, groupSummary } = await import("@/components/settings/activity-log-format");

  // ── 1. The roster: current members are chips, deactivated ones are "former" ──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const feed = await getActivityFeed(TENANT, { members, agents, db: db as any });
  assert.deepEqual(feed.errors, []);
  const humans = (list: { type: string; label: string }[]) => list.filter((a) => a.type === "human").map((a) => a.label);
  assert.deepEqual(humans(feed.activeActors), ["CC", "OASIS Rep"], "the live roster is current members only");
  assert.deepEqual(feed.activeActors.filter((a) => a.type === "agent").map((a) => a.label), ["Chief of Staff · Operations", "Finance"]);
  assert.deepEqual(feed.formerActors.map((a) => a.label), ["Former Rep"], "deactivated with rows in the window: former");
  assert.ok(!feed.formerActors.some((a) => a.label === "Ghost Rep"), "deactivated with no rows: not a chip anywhere");
  assert.ok(feed.actors.some((a) => a.key === "human:profile-former"), "attribution still knows the former teammate");
  assert.equal(feed.rows.find((r) => r.id === "li:former-call")?.actor, "Former Rep", "an old row keeps its name");

  // Filtering by a former teammate still works (the chip in the Former group is a link).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const formerOnly = await getActivityFeed(TENANT, { actor: "human:profile-former", members, agents, db: db as any });
  assert.deepEqual(formerOnly.rows.map((r) => r.id), ["li:former-call"]);
  assert.deepEqual(formerOnly.formerActors.map((a) => a.label), ["Former Rep"]);
  assert.deepEqual(humans(formerOnly.activeActors), ["CC", "OASIS Rep"]);

  // ── 2. One bulk claim is one row, and it names the leads ──────────────────
  // Folding is opt-in. The Operations tracker and the Sales panel print
  // `actor · action` alone, so a thirty-lead claim folded there would read as
  // one lead and the other twenty-nine would vanish; only a caller that renders
  // the count (the Activity log page) asks for it (W3A-R1).
  assert.equal(feed.rows.length, 32, "without `group`: 30 claims + the older claim + the former teammate's call, each its own row");
  assert.ok(feed.rows.every((r) => r.count === undefined && r.items === undefined), "no folded row unless asked for");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const grouped = await getActivityFeed(TENANT, { members, agents, db: db as any, group: true });
  assert.deepEqual(grouped.errors, []);
  const folded = grouped.rows.find((r) => r.count === 30);
  assert.ok(folded, `thirty identical rows did not fold: ${JSON.stringify(grouped.rows.map((r) => [r.id, r.count]))}`);
  assert.equal(folded!.items?.length, 30);
  assert.equal(folded!.action, "stage_changed");
  assert.equal(folded!.actor, "CC");
  assert.ok(folded!.items!.every((item) => /^Business \d+$/.test(item.target)), `rows must name the lead: ${JSON.stringify(folded!.items!.map((i) => i.target))}`);
  assert.ok(!folded!.items!.some((item) => item.target === "Leaked"), "another workspace's record never names a row");
  assert.match(folded!.detail, /^Lead claimed and moved prospect pool/, "the writer's words, not web_leads_claim");
  assert.ok(!grouped.rows.some((r) => r.detail === "web_leads_claim" || r.target === "lead-0"), "no raw identifier is rendered");
  assert.equal(groupSummary(folded!), "30 leads");
  const old = grouped.rows.find((r) => r.id === "li:claim-old");
  assert.ok(old && !old.count, "the same action three minutes earlier is its own row");
  assert.equal(old!.target, "Old Business", "a JSON-string data column still names the lead");
  assert.equal(grouped.rows.length, 3, "with `group`: 30 claims fold into one, plus the older claim and the former teammate's call");
  assert.ok(db.queriedTables.includes("tenant_records"), "lead names come from one batched read");

  // The folding rule itself: same actor+action+source within two minutes, consecutive only.
  const base = { actorKey: "human:a", actor: "A", actorType: "human" as const, action: "x", target: "", detail: "", source: "comms", sourceKey: "s" };
  const at = (ms: number) => iso(ms);
  assert.equal(groupActivityRows([{ ...base, id: "1", time: at(0) }, { ...base, id: "2", time: at(-60_000) }]).length, 1);
  assert.equal(groupActivityRows([{ ...base, id: "1", time: at(0) }, { ...base, id: "2", time: at(-121_000) }]).length, 2, "outside the window");
  assert.equal(groupActivityRows([{ ...base, id: "1", time: at(0) }, { ...base, id: "2", time: at(0), actorKey: "human:b" }]).length, 2, "another actor");
  assert.equal(groupActivityRows([{ ...base, id: "1", time: at(0) }, { ...base, id: "2", time: at(0), sourceKey: "t" }]).length, 2, "another source");
  assert.equal(groupActivityRows([{ ...base, id: "1", time: at(0) }, { ...base, id: "2", time: at(0), action: "y" }, { ...base, id: "3", time: at(0) }]).length, 3, "consecutive only");
  assert.equal(groupActivityRows([{ ...base, id: "1", time: "not a time" }, { ...base, id: "2", time: "not a time" }]).length, 2, "an unparseable time never folds");

  // ── 3. Agents are named for this workspace, never by persona slug ──────────
  assert.equal(activityAgentLabel("bravo", { slug: "bravo", display_name: "Bravo" }, true), "Chief of Staff · Operations");
  assert.equal(activityAgentLabel("bravo", { slug: "bravo", display_name: "Bravo" }, false), "General assistant");
  assert.equal(activityAgentLabel("maven", { slug: "maven", display_name: "Maven" }, false), "Content assistant");
  assert.equal(activityAgentLabel("renewals-desk", { slug: "renewals-desk", display_name: "Renewals Desk" }, false), "Renewals Desk", "a custom teammate keeps its own name");
  assert.equal(activityAgentLabel("renewals-desk", undefined, false), "renewals-desk", "no binding at all: the slug, which is the workspace's own");
  for (const persona of ["bravo", "atlas", "maven", "aura", "hermes", "solara", "helios", "lex"]) {
    const label = activityAgentLabel(persona, { slug: persona, display_name: persona[0].toUpperCase() + persona.slice(1) }, false);
    assert.doesNotMatch(label.toLowerCase(), new RegExp(`\\b${persona}\\b`), `${persona}: a client never sees the persona`);
  }

  // ── 4. What a row says ─────────────────────────────────────────────────────
  assert.equal(humanizeAction("lead.stage_changed"), "Lead stage changed");
  assert.equal(humanizeAction("call_started"), "Call started");
  assert.equal(humanizeAction("chat session"), "Chat session");
  assert.equal(humanizeAction('ran "Daily review"'), 'Ran "Daily review"');
  assert.equal(humanizeAction(""), "Change");

  // ── 5. The chip row: current members in "Team", deactivated under "Former" ──
  const tree = expand(ActivityActorChips({ active: feed.activeActors, former: feed.formerActors, selectedKey: null, filtering: false }));
  const team = findEl(tree, (el) => el.type === "ul" && el.props?.["aria-label"] === "Team");
  assert.ok(team, "the Team chip row renders");
  const teamText = textOf(team);
  assert.match(teamText, /\bAll\b/);
  assert.match(teamText, /\bCC\b/);
  assert.match(teamText, /OASIS Rep/);
  assert.match(teamText, /Chief of Staff · Operations/);
  assert.doesNotMatch(teamText, /Former Rep|Ghost Rep/, "a deactivated member is not a current chip");
  const former = findEl(tree, (el) => el.type === "details");
  assert.ok(former, "the Former group renders");
  // textOf joins an element's children with spaces: ["Former teammates (", 1, ")"].
  assert.match(textOf(findEl(former, (el) => el.type === "summary")).replace(/\s+/g, " ").trim(), /^Former teammates \( ?1 ?\)$/);
  const formerList = findEl(former, (el) => el.type === "ul" && el.props?.["aria-label"] === "Former teammates");
  assert.match(textOf(formerList), /Former Rep/);
  assert.doesNotMatch(textOf(formerList), /\bCC\b|OASIS Rep/);
  assert.equal(former!.props?.open, undefined, "collapsed unless a former teammate is the filter");
  const formerLink = findEl(formerList, (el) => el.type === "a");
  assert.equal(formerLink?.props?.href, "/settings/audit-log?actor=human%3Aprofile-former");
  const withoutFormer = expand(ActivityActorChips({ active: feed.activeActors, former: [], selectedKey: null, filtering: false }));
  assert.equal(findEl(withoutFormer, (el) => el.type === "details"), null, "no Former group when nobody is former");
  const selected = expand(ActivityActorChips({ active: feed.activeActors, former: feed.formerActors, selectedKey: "human:profile-former", filtering: true }));
  assert.equal(findEl(selected, (el) => el.type === "details")?.props?.open, true, "open when the filter is a former teammate");
  const chipSource = readFileSync(join(ROOT, "components/settings/ActivityActorChips.tsx"), "utf8");
  assert.doesNotMatch(chipSource, /uppercase/, "sentence-case chips, no uppercase pills");

  // ── 6. The page is on the OS chrome ────────────────────────────────────────
  const page = readFileSync(join(ROOT, "app/settings/audit-log/page.tsx"), "utf8");
  assert.match(page, /from "@\/components\/os\/PageFrame"/, "the page uses PageFrame");
  assert.doesNotMatch(page, /@\/components\/Card"|PageHeader|<Tag\b|<Card\b/, "not the old Card chrome");
  assert.doesNotMatch(page, /Back to settings|Admin only|uppercase/, "no back button (SettingsNav exists), no ADMIN ONLY badge, no uppercase");
  assert.match(page, /activeActors/, "chips and counts read the active roster");
  assert.match(page, /formerActors/, "the former group reads the former roster");
  assert.match(page, /ActivityActorChips/);
  assert.match(page, /canSeeTeamPerformance\) redirect\("\/settings"\)/, "the gate is unchanged");
  // Folding is asked for only where the count is rendered: this page does
  // (About reads row.count); a panel that prints `actor · action` alone must not.
  assert.match(page, /group: true/, "the page asks for folded rows because it renders row.count");
  assert.match(page, /row\.count/, "the page renders the count behind a folded row");
  for (const panel of ["components/settings/OperationsTrackerPanel.tsx", "components/settings/SalesTeamOperationsPanel.tsx"]) {
    const src = readFileSync(join(ROOT, panel), "utf8");
    assert.match(src, /getActivityFeed\(/, `${panel}: still reads the feed`);
    if (!/row\.count/.test(src)) {
      assert.doesNotMatch(src, /group:\s*true/, `${panel}: prints actor · action with no count, so it must not fold rows`);
    }
  }

  console.log("activity-log-roster: ok");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
