import assert from "node:assert/strict";
import { observeAutomations, missedOccurrences, isObserverPagingTick, OBSERVER_PAGING_INTERVAL_MIN } from "../lib/health/automation-observer";
import { CRON_TABLE } from "../workers/oasis-cc-cron/src/index";
import { VPS_HEALTH_SERVICES } from "../lib/automations/vps-health";
import { incidentWindow } from "../lib/health/incident-window";
import { ObserverIncident, OUTAGE_CONFIRM_BAD, nextIncident, type Env, type Incident } from "../workers/oasis-automation-observer/src/index";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const iso = (minutes = 0) => new Date(NOW - minutes * 60_000).toISOString();
type Row = Record<string, unknown>;
function fixture() {
  const rows: Record<string, Row[]> = {
    cron_jobs: [{ id: "job1", name: "Synthetic Inbox", schedule: "*/5 * * * *", is_active: 1, last_run_at: iso(), next_run_at: new Date(NOW + 300_000).toISOString(), fail_count: 0 }],
    tenant_cron_jobs: [{ id: "atlas", name: "Inbound Financial Email", enabled: 1, schedule: "*/15 * * * *", last_run_at: iso(), last_run_status: "success", tz: "America/Toronto" }],
    cron_runs: CRON_TABLE.map((c) => ({ route: c.path, last_tick: iso(), ok: 1 })),
    cron_job_switches: [], vps_unit_controls: [],
    integrations_health: VPS_HEALTH_SERVICES.map((service) => ({ service, status: "healthy", last_ping_at: iso(), metadata: "{}" })),
    inbox_mailboxes: [{ source_account: "synthetic", last_scan_at: iso() }],
    inbox_messages: [], automation_notification_outbox: [], automation_occurrences: [], health_alert_state: [],
    weekly: [{ status: "healthy", metadata: JSON.stringify({ overall: "GREEN", checked_at: iso(), report_delivered: false }) }],
  };
  const unavailable = new Set<string>();
  const seen: string[] = [];
  const global = new Set(["cron_runs", "cron_job_switches", "vps_unit_controls"]);
  const db = { execute: async (query: { sql: string; args: unknown[] }) => {
    const table = query.sql.match(/FROM ([a-z_]+)/)?.[1];
    assert.ok(table, query.sql);
    if (!global.has(table)) { assert.match(query.sql, /tenant_id=\?/); assert.equal(query.args[0], "tenant-test"); }
    seen.push(table);
    if (unavailable.has(table)) throw new Error("no such table: synthetic");
    return { rows: query.sql.includes("automation.weekly_full_truth") ? rows.weekly : rows[table] ?? [] };
  } };
  const read = async () => new Map((await observeAutomations(db as never, "tenant-test", NOW)).map((r) => [r.id.replace("automation.", ""), r]));
  return { rows, unavailable, seen, read };
}

async function outcomes() {
  assert.equal(missedOccurrences({ enabled: true, schedule: "*/5 * * * *", zone: "UTC", last: iso(12) }, NOW), true);
  assert.equal(missedOccurrences({ enabled: false, schedule: "bad", zone: "bad", last: null }, NOW), false);
  assert.equal(missedOccurrences({ enabled: true, schedule: "bad", zone: "UTC", last: iso() }, NOW), null);
  const f = fixture();
  let result = await f.read();
  assert.ok([...result.values()].every((r) => r.observed === 0), JSON.stringify([...result.values()]));
  const drain = f.rows.integrations_health.find((r) => r.service === "vps.oasis-notification-drain")!;
  drain.last_ping_at = iso(3);
  assert.equal((await f.read()).get("worker_progress")?.observed, 1, "notification drain evidence expires after120seconds");
  drain.last_ping_at = iso();
  f.rows.cron_jobs.push({ id: "paused", name: "Paused", is_active: 0, schedule: "* * * * *", last_run_at: iso(100), fail_count: 99 });
  f.rows.cron_runs[0].ok = 0;
  result = await f.read();
  assert.equal(result.get("expected_occurrences")?.observed, 1, "recent failed HTTP dispatch is not healthy; paused job excluded");
  f.rows.cron_runs[0].ok = 1;
  f.rows.inbox_messages = [{ disposition: "pending", financial_status: "none", oldest: iso(11), n: 2 }, { disposition: "review", financial_status: "pending", oldest: iso(60), handoff_at: iso(5), n: 1 }];
  result = await f.read();
  assert.equal(result.get("inbox_completion")?.observed, 2);
  assert.equal(result.get("financial_handoff")?.observed, 0, "finance deadline starts at actual handoff, not discovery");
  f.rows.inbox_messages[1].handoff_at = iso(31);
  f.rows.automation_notification_outbox = [{ status: "delivery_unknown", oldest: NOW / 1000, n: 1 }];
  f.rows.automation_occurrences = [{ job_id: "digest", scheduled_at: iso(), state: "completed", result_json: JSON.stringify({ business_status: "failed" }) },
    { job_id: "stuck", scheduled_at: iso(5), state: "running", lease_expires_at: NOW / 1000 - 1, deadline_at: NOW / 1000 + 60 }];
  f.rows.cron_jobs.push({ id: "digest", name: "Synthetic weekly", is_active: 1, schedule: "0 12 * * 1", next_run_at: new Date(NOW + 7 * 86400_000).toISOString(), fail_count: 0 });
  f.rows.weekly[0].metadata = JSON.stringify({ overall: "RED", checked_at: iso(), report_delivered: true });
  result = await f.read();
  assert.equal(result.get("financial_handoff")?.observed, 1);
  assert.equal(result.get("notification_delivery")?.observed, 1);
  assert.equal(result.get("business_outcomes")?.observed, 2, "exit-zero delivered red digest still has failed business outcome");
  assert.equal(result.get("weekly_system_gate")?.observed, 1, "delivering a report cannot make RED green");
  // The real weekly digest: its COMPLETED verdict is weekly_system_gate's to page, not
  // business_outcomes' (one condition, one page). A digest that did not complete is the
  // reporter failing, and still counts.
  f.rows.cron_jobs.push({ id: "weekly-digest", name: "Weekly Full-Truth Health Digest", is_active: 1, schedule: "0 7 * * 0", next_run_at: new Date(NOW + 7 * 86400_000).toISOString(), fail_count: 0 });
  f.rows.automation_occurrences.push({ job_id: "weekly-digest", scheduled_at: iso(), state: "completed", result_json: JSON.stringify({ business_status: "failed", summary: "OVERALL: RED" }) });
  assert.equal((await f.read()).get("business_outcomes")?.observed, 2, "the weekly RED pages once, through weekly_system_gate");
  // The digest completes even when publishing the gate's record fails (persist_results only prints
  // the database error), and the gate then still reads LAST week's verdict, valid for 7 days + 2 h.
  // That run's occurrence is its only evidence, so it counts (Codex, 2026-11-16).
  const thisWeek = f.rows.weekly[0].metadata;
  f.rows.weekly[0].metadata = JSON.stringify({ overall: "GREEN", checked_at: iso(7 * 24 * 60 - 30), report_delivered: true });
  result = await f.read();
  assert.equal(result.get("weekly_system_gate")?.observed, 0, "the gate is reading last week's GREEN");
  assert.equal(result.get("business_outcomes")?.observed, 3, "so this run's RED occurrence pages instead");
  f.rows.weekly[0].metadata = thisWeek;
  f.rows.automation_occurrences.at(-1)!.state = "failed";
  assert.equal((await f.read()).get("business_outcomes")?.observed, 3, "a digest that crashed or could not deliver still counts");
  f.rows.automation_occurrences.pop();
  f.rows.cron_jobs.pop();
  for (const delivered of [false, true]) {
    f.rows.weekly[0].metadata = JSON.stringify({ overall: "WARN", checked_at: iso(), report_delivered: delivered });
    const warning = (await f.read()).get("weekly_system_gate");
    assert.equal(warning?.observed, 0, "WARN is degraded-but-operating: reported in the digest, never paged daily");
    assert.match(warning?.reason ?? "", /Weekly system verdict: WARN/, "the WARN verdict stays visible on the board");
  }
  f.rows.weekly[0].metadata = JSON.stringify({ overall: "WARN", checked_at: iso(8 * 24 * 60) });
  assert.equal((await f.read()).get("weekly_system_gate")?.observed, null, "an expired WARN report remains unverified");
  f.rows.weekly[0].metadata = JSON.stringify({ overall: "UNKNOWN", checked_at: iso() });
  assert.equal((await f.read()).get("weekly_system_gate")?.observed, null, "unrecognized verdicts do not become healthy");
  f.rows.weekly[0].metadata = JSON.stringify({ overall: "RED", checked_at: iso(), report_delivered: true });
  f.rows.automation_occurrences[0].scheduled_at = iso(2 * 24 * 60);
  assert.equal((await f.read()).get("business_outcomes")?.observed, 2, "a weekly failed outcome remains visible beyond24hours");
  f.rows.cron_jobs.at(-1)!.is_active = 0;
  assert.equal((await f.read()).get("business_outcomes")?.observed, 1, "disabled job's terminal outcome stops paging; unresolved running effects remain visible");
  f.rows.cron_jobs.at(-1)!.is_active = 1;
  f.rows.automation_occurrences.push({ job_id: "digest", scheduled_at: new Date(NOW + 1000).toISOString(), state: "completed", result_json: JSON.stringify({ business_status: "checked" }) });
  assert.equal((await f.read()).get("business_outcomes")?.observed, 1, "new success supersedes old failed job occurrence");
  f.rows.automation_occurrences.push({ job_id: "lost", scheduled_at: iso(120), state: "delivery_unknown", result_json: JSON.stringify({ status: "delivery_unknown", error_code: "execution_lease_expired" }) });
  assert.equal((await f.read()).get("business_outcomes")?.observed, 2, "a lost lease nobody has run since is stuck");
  f.rows.automation_occurrences.push({ job_id: "lost", scheduled_at: iso(60), state: "completed", result_json: JSON.stringify({ business_status: "checked" }) });
  assert.equal((await f.read()).get("business_outcomes")?.observed, 1, "a later clean run supersedes a lost lease; it no longer pages for good");
  f.rows.vps_unit_controls.push({ service: "vps.oasis-inbox-sweep", desired: "off" });
  f.rows.tenant_cron_jobs[0].enabled = 0;
  result = await f.read();
  assert.equal(result.get("inbox_completion")?.observed, 0);
  assert.equal(result.get("financial_handoff")?.observed, 0);
  f.unavailable.add("inbox_messages");
  result = await f.read();
  assert.equal(result.get("observation_sources")?.observed, null, "missing migration is explicitly unverified");
  assert.equal(result.get("notification_delivery")?.observed, 1, "another missing table cannot stop independent checks");
}

async function independent() {
  let state: Incident | undefined;
  for (const healthy of [false, false, true, true]) state = nextIncident(state, healthy, NOW);
  assert.equal(state?.open, false, "a two-minute blip (an app deploy, a database stall) is not an outage");
  state = undefined;
  for (const healthy of [false, false, false, false]) state = nextIncident(state, healthy, NOW);
  assert.equal(state?.open, false, "four failing minutes are still a blip");
  state = nextIncident(state, false, NOW);
  assert.equal(state?.open, true, "five failing minutes are an outage");
  state = undefined;
  for (const healthy of [false, true, false, true, false, true, false, true, false]) state = nextIncident(state, healthy, NOW);
  assert.equal(state?.open, true, "an app failing every other minute is half broken: flapping still opens");
  let window: string | undefined;
  for (const verdict of ["failing", "ok", "failing", "ok"] as const) window = incidentWindow(window, verdict).serialized;
  assert.equal(incidentWindow(window, "failing").confirm, true);
  assert.equal(incidentWindow('["failing","ok"]', "ok").recovered, true);
  assert.equal(incidentWindow(["failing", "ok"], "ok", true).recovered, true, "Turso adapter returns decoded arrays");
  assert.equal(incidentWindow(["failing", "ok", "failing", "ok"], "failing").confirm, true, "decoded history retains flap detection");

  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const realLog = console.log;
  let time = NOW;
  let available = false;
  let receiptUnknown = false;
  let receiptMissing = false;
  const data = new Map<string, unknown>();
  let sends = 0;
  const headers: string[] = [];
  const env = { CRON_SECRET: "synthetic-secret", AUTOMATION_OBSERVER_ATTEST_SECRET: "synthetic-attest", OASIS_TELEGRAM_BOT_TOKEN: "synthetic-token", OASIS_TELEGRAM_CHAT_ID: "synthetic-chat" } as Env;
  const worker = new ObserverIncident({ storage: { get: async <T>(key: string) => data.get(key) as T | undefined, put: async (key, value) => { data.set(key, value); } }, blockConcurrencyWhile: async (work) => work() }, env);
  // An outage long enough to confirm: one failing sample a minute.
  const down = async () => { for (let i = 0; i < OUTAGE_CONFIRM_BAD; i++) { if (i) time += 60_000; await worker.fetch(); } };
  try {
    Date.now = () => time;
    console.log = () => undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("api.telegram.org")) {
        sends++;
        if (receiptUnknown) throw new Error("synthetic timeout after acceptance");
        if (receiptMissing) return Response.json({ ok: true });
        return Response.json({ ok: true, result: { message_id: sends } });
      }
      headers.push(String((init?.headers as Record<string, string>)["x-oasis-observer-delivery"]));
      return Response.json({ ok: available, status: available ? "observed" : "unverified" }, { status: available ? 200 : 503 });
    }) as typeof fetch;
    await down();
    assert.equal(sends, 1, "a sustained database outage alerts independently");
    time += 60_000; await worker.fetch();
    assert.equal(sends, 1, "receipt-confirmed incident is not duplicated");
    available = true; time += 300_000; await worker.fetch(); time += 60_000; await worker.fetch();
    assert.equal(sends, 2, "two complete observations recover once");
    assert.equal((data.get("incident") as Incident).open, false);
    available = false; receiptUnknown = true; time += 300_000; await down();
    assert.equal(sends, 3);
    time += 600_000; await worker.fetch();
    assert.equal(sends, 3, "unknown provider acknowledgment is not replayed");
    assert.equal((data.get("incident") as Incident).delivery, "delivery_unknown");
    assert.equal(headers.at(-1), "delivery_unknown", "durable independent failure returns to existing health UI when app returns");
    data.clear(); receiptUnknown = false; receiptMissing = true;
    time += 600_000; await down();
    assert.equal(sends, 4);
    assert.equal((data.get("incident") as Incident).delivery, "delivery_unknown", "HTTP200 without receipt is ambiguous, not a safe refusal");
    time += 600_000; await worker.fetch(); assert.equal(sends, 4);
  } finally { globalThis.fetch = realFetch; Date.now = realNow; console.log = realLog; }
}

function paging() {
  // The Worker observes every minute; only the quarter-hour sample may page. Fed minute
  // samples, the runner's two-strike confirmed two-minute Telegram reconnects: 39 flaps
  // and ~30 FAILING/RECOVERED pages in the 24 h to 2026-11-13.
  assert.equal(OBSERVER_PAGING_INTERVAL_MIN, 15);
  for (const minute of [0, 15, 30, 45]) assert.equal(isObserverPagingTick(Date.parse(`2026-11-13T02:${String(minute).padStart(2, "0")}:00Z`)), true, `minute ${minute} pages`);
  for (const minute of [1, 2, 14, 16, 29, 44, 59]) assert.equal(isObserverPagingTick(Date.parse(`2026-11-13T02:${String(minute).padStart(2, "0")}:00Z`)), false, `minute ${minute} only observes`);
  assert.equal(isObserverPagingTick(Date.parse("2026-11-13T02:15:42Z")), true, "the route passes the floored tick; seconds never matter");
  assert.equal(isObserverPagingTick(NaN), false, "an unparseable tick never pages");
}

async function main() { paging(); await outcomes(); await independent(); console.log("automation-observer: OK (quarter-hour paging, scoped outcome evidence, disabled gates, outage isolation, independent durable delivery)"); }
main().catch((error) => { console.error(error); process.exit(1); });
