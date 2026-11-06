/**
 * tests/automation-draft-schedule.test.ts — an AI draft whose schedule the
 * automation runner cannot run is refused at the DRAFT step, in a sentence, and
 * the operator can draft again straight away (Automations guided setup, PR1).
 *
 * WHY. PR1 put save-draft on the one shared cron grammar
 * (lib/automations/cron-grammar.ts), which refuses day names like MON-FRI
 * because the bridge's cron runner cannot parse them. The drafter never checked
 * the schedule the model wrote, and the draft route handed it straight to the
 * review step, where the schedule is read-only text beside "Save automation
 * (disabled)". So a draft like "0 9 * * MON-FRI" reached review, Save answered
 * 400 {error: "draft_invalid"} with no message, the page showed the bare code
 * "draft_invalid", and the draft was thrown away. In that error state the
 * "Draft with AI" button did nothing until the text was edited, so the obvious
 * next step was a dead button.
 *
 * WHAT IS PINNED, through the real draft and save-draft route handlers, a real
 * signed operator session, a local libSQL file, and the real component run
 * under a minimal hook runtime (no DOM, as in tests/calendar-routine-card.test.ts)
 * so its own click handlers execute. The model is the one stand-in:
 * lib/ai/infer's inferForTenant returns a canned draft, so nothing here can
 * reach a model.
 *   - the drafter refuses exactly what the shared grammar refuses and accepts
 *     what it accepts (one grammar, no drift between draft and save);
 *   - the prompt the model receives says days are numbers, never names;
 *   - the draft route answers a MON-FRI draft 502 draft_invalid with a sentence
 *     naming the schedule, and writes nothing;
 *   - save-draft's 400 carries a sentence naming each bad field;
 *   - on the page: a refused draft shows that sentence (never the bare code)
 *     and no Save button; "Draft with AI" works straight from the error; the
 *     redraft reaches review and saves switched off;
 *   - a review drafted before this fix, whose Save is refused, shows
 *     save-draft's sentence, not "draft_invalid", and can be drafted again.
 *
 * Run: node --conditions=react-server --import tsx tests/automation-draft-schedule.test.ts
 */
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { isValidElement, type ReactNode } from "react";
import { createClient } from "@libsql/client";

const dbFile = join(mkdtempSync(join(tmpdir(), "automation-draft-schedule-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "automation-draft-schedule-secret-0000000001";
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;
process.env.ADMIN_EMAILS = "";

// ── A minimal hook runtime: the component's `import { useState } from "react"`
// reads this module object at call time, so its real handlers run with no DOM.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const R = require("react") as Record<string, unknown>;
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
let slots: unknown[] = [];
let cursor = 0;
R.useState = (init: unknown) => {
  const i = cursor++;
  const own = slots;
  if (!(i in own)) own[i] = typeof init === "function" ? (init as () => unknown)() : init;
  return [own[i], (v: unknown) => (own[i] = typeof v === "function" ? (v as (p: unknown) => unknown)(own[i]) : v)];
};
function mount(render: () => unknown) {
  slots = [];
  return () => {
    cursor = 0;
    return render();
  };
}

type El = { type: unknown; props: Record<string, unknown> };
function elements(node: unknown, out: El[] = []): El[] {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement(node)) {
    const el = node as unknown as El;
    if (typeof el.type === "function") return elements((el.type as (p: unknown) => unknown)(el.props), out);
    out.push(el);
    elements(el.props.children as ReactNode, out);
  }
  return out;
}
function textOf(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement(node)) {
    const el = node as unknown as El;
    if (typeof el.type === "function") return textOf((el.type as (p: unknown) => unknown)(el.props));
    return textOf(el.props.children as ReactNode);
  }
  return "";
}
const flat = (tree: unknown) => textOf(tree).replace(/\s+/g, " ");
function buttons(tree: unknown, label: RegExp): El[] {
  return elements(tree).filter((e) => e.type === "button" && label.test(textOf(e.props.children).trim()));
}
function button(tree: unknown, label: RegExp): El {
  const found = buttons(tree, label);
  assert.equal(found.length, 1, `one button ${label} in: ${flat(tree)}`);
  return found[0];
}
const click = async (el: El) => {
  assert.notEqual(el.props.disabled, true, `the button "${textOf(el.props.children).trim()}" is disabled`);
  await (el.props.onClick as () => unknown)();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

// ── Stand-ins: the session cookie, and the model ─────────────────────────
const SESSION_COOKIE_NAME = "oasis_session";
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === SESSION_COOKIE_NAME && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: SESSION_COOKIE_NAME, value: sessionCookie }] : []),
    has: (name: string) => name === SESSION_COOKIE_NAME && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
  draftMode: async () => ({ isEnabled: false }),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
  usePathname: () => "/automations",
  useSearchParams: () => new URLSearchParams(),
});

/** What the model writes back, with the schedule a check chooses. */
const modelDraft = (schedule: string) => ({
  suggested_name: "Weekday lead summary",
  suggested_description: "Summarises new leads every weekday morning.",
  schedule,
  schedule_human: "Weekdays at 09:00",
  script_filename: "weekday_lead_summary.py",
  script_content: "#!/usr/bin/env python3\nprint('sent: 0 messages')\n",
  agent_key: "bravo",
  reasoning: "A weekday morning summary of new leads.",
});
/** Each model call takes the next schedule; a call nobody planned fails the check. */
let modelSchedules: string[] = [];
const modelCalls: Array<{ tenantId: string | null; system: string; prompt: string }> = [];
stub("../lib/ai/infer", {
  __esModule: true,
  inferForTenant: async (tenantId: string | null, args: { system: string; prompt: string }) => {
    modelCalls.push({ tenantId, system: args.system, prompt: args.prompt });
    const schedule = modelSchedules.shift();
    if (schedule === undefined) throw new Error("the model was called more times than this check planned");
    return { ok: true, text: JSON.stringify(modelDraft(schedule)) };
  },
});

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // OASIS_OPERATOR_TENANT_ID
const CC = { id: "0e000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" }; // verified operator
const PAIR_TOKEN = "test-pairing-token-with-enough-entropy";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || String(e)).split("\n").slice(0, 10).join("\n        ")}`);
  }
}

type Body = { ok?: boolean; error?: string; message?: string; missing_or_invalid?: string[]; cron_id?: string; draft?: { schedule?: string } };

/** A sentence a person can act on: words, a full stop, and no bare error code. */
function assertSentence(message: unknown, label: string) {
  assert.equal(typeof message, "string", `${label}: no message at all`);
  const m = message as string;
  assert.match(m, /\s/, `${label}: "${m}" is a code, not a sentence`);
  assert.match(m, /\.$/, `${label}: "${m}" does not end as a sentence`);
  assert.doesNotMatch(m, /^(automation_draft_|draft_invalid)/, `${label}: "${m}" leads with an error code`);
}

async function main() {
  console.log("automation-draft-schedule:");
  const db = createClient({ url: `file:${dbFile}` });
  await db.executeMultiple(`
    CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
      session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
    CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
      team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
      onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, agents_enabled TEXT,
      updated_at TEXT, deactivated_at TEXT, joined_at TEXT);
    CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT, custom_fields TEXT);
    CREATE TABLE tenant_cron_jobs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      agent_key TEXT NOT NULL DEFAULT 'bravo', name TEXT NOT NULL, description TEXT,
      schedule TEXT NOT NULL, action_type TEXT NOT NULL, action_payload TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1, last_run_at TEXT, last_run_status TEXT, last_run_output TEXT,
      last_run_error TEXT, run_count INTEGER NOT NULL DEFAULT 0, created_by TEXT, owner_user_id TEXT,
      last_scheduled_for TEXT, tz TEXT, target_pairing_id TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
    );
    CREATE TABLE bridge_pairings (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT, user_id TEXT,
      last_seen_at TEXT, revoked_at TEXT, scope TEXT, bridge_token_hash TEXT,
      previous_token_hash TEXT, token_rotated_at TEXT, paired_via TEXT,
      claim_enabled_at TEXT, claim_enabled_by TEXT, last_poll_ok_at TEXT, tool_capabilities TEXT
    );
    CREATE TABLE automation_templates (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created_by TEXT NOT NULL,
      cron_job_id TEXT NOT NULL, target_pairing_id TEXT NOT NULL, target_label TEXT NOT NULL,
      department TEXT NOT NULL, objective TEXT NOT NULL, trigger_kind TEXT NOT NULL,
      schedule_hint TEXT, input_parameters_json TEXT NOT NULL, expected_outputs TEXT NOT NULL,
      connector_keys_json TEXT NOT NULL, draft_json TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), updated_at TEXT
    );
    CREATE TABLE workspace_agents_owner (
      tenant_id TEXT PRIMARY KEY, auth_user_id TEXT NOT NULL, set_by TEXT NOT NULL,
      set_at TEXT NOT NULL, note TEXT, revoked_at TEXT
    );
  `);
  const stamp = "2026-09-01T00:00:00Z";
  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC.id, CC.email] },
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at,
                full_name, agents_enabled, updated_at, joined_at) VALUES ('p-cc', ?, ?, ?, 'owner', 1, ?, 'Test Person', '[]', ?, ?)`,
        args: [CC.id, CC.email, OASIS, stamp, stamp, stamp],
      },
      // O2: script-automation creation gates on the workspace's AGENTS OWNER
      // (lib/agents-owner.ts) — CC, here, matching production.
      {
        sql: `INSERT INTO workspace_agents_owner (tenant_id, auth_user_id, set_by, set_at) VALUES (?, ?, ?, ?)`,
        args: [OASIS, CC.id, CC.id, stamp],
      },
      {
        sql: `INSERT INTO bridge_pairings (id, tenant_id, label, user_id, last_seen_at, scope, bridge_token_hash, paired_via, tool_capabilities) VALUES ('pair-cc-main', ?, 'CCPC (Windows)', ?, ?, 'daemon', ?, 'pair_code', ?)`,
        args: [OASIS, CC.id, new Date().toISOString(), createHash("sha256").update(PAIR_TOKEN).digest("hex"), JSON.stringify(["generated_script_v1"])],
      },
    ],
    "write",
  );
  const { signSession } = await import("../lib/turso-auth");
  sessionCookie = signSession({ sub: CC.id, email: CC.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });

  const { draftAutomation } = await import("../lib/ai-automation-drafter");
  const { isValidCronExpr } = await import("../lib/automations/cron-grammar");
  const draftRoute = await import("../app/api/automations/draft/route");
  const saveRoute = await import("../app/api/automations/save-draft/route");
  const pollRoute = await import("../app/api/cron-jobs/poll/route");
  const { DescribeAutomationFlow } = await import("../components/automations/DescribeAutomationFlow");
  const { NextRequest } = await import("next/server");

  const post = async (route: { POST: (req: InstanceType<typeof NextRequest>) => Promise<Response> }, path: string, body: unknown) => {
    const res = await route.POST(
      new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    );
    return { status: res.status, body: (await res.json()) as Body };
  };
  const rowCount = async () => Number((await db.execute("SELECT COUNT(*) AS n FROM tenant_cron_jobs")).rows[0].n);
  const description = "Every weekday at 9am, send me a summary of the leads that came in overnight.";

  // The page's fetches go to the real routes. `draftAnswer`, when set, stands
  // in for a draft the page received before this fix (the server then did not
  // check it). File delivery is pull-based through the targeted cron payload,
  // so the browser must never call the tenant-level bridge proxy.
  const fetches: Array<{ url: string; body: unknown }> = [];
  let draftAnswer: unknown = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const req = () =>
      new NextRequest(`http://localhost${url}`, { method: init?.method ?? "GET", headers: init?.headers as HeadersInit, body: init?.body as BodyInit });
    if (url === "/api/automations/draft") return draftAnswer ? Response.json(draftAnswer) : draftRoute.POST(req());
    if (url === "/api/automations/save-draft") return saveRoute.POST(req());
    if (url === "/api/credentials/custom") return Response.json({ ok: true, entries: [{ key: "GMAIL_CLIENT_ID", has_value: true }] });
    if (url === "/api/devices") return Response.json({ ok: true, devices: [{ id: "pair-cc-main", label: "CCPC", user_id: CC.id, last_seen_at: new Date().toISOString(), revoked_at: null, scope: "daemon", tool_capabilities: ["generated_script_v1"], mine: true }] });
    throw new Error(`the page fetched something this check does not expect: ${url}`);
  }) as typeof fetch;
  const fetchesTo = (url: string) => fetches.filter((f) => f.url === url).length;

  const completeWizard = async (view: () => unknown) => {
    await click(button(view(), /^Marketing$/));
    await click(button(view(), /^Workflow details$/));
    const textareas = elements(view()).filter((element) => element.type === "textarea");
    assert.equal(textareas.length, 3, "workflow step has objective, inputs and output fields");
    (textareas[0].props.onChange as (event: { target: { value: string } }) => void)({ target: { value: description } });
    (textareas[1].props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "lead_id" } });
    (textareas[2].props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "A concise lead summary" } });
    const schedule = elements(view()).find((element) => element.type === "input");
    assert.ok(schedule, "workflow step has a schedule field");
    (schedule.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: "Weekdays at 9am" } });
    await click(button(view(), /^Bind connectors$/));
    assert.match(flat(view()), /Credentials were matched/, flat(view()));
    await click(button(view(), /^Choose computer$/));
    assert.match(flat(view()), /CCPC/, flat(view()));
  };

  // ── the drafter ──────────────────────────────────────────────────────────
  await check("the drafter refuses exactly what the shared grammar refuses, and accepts what it accepts", async () => {
    const cases = [
      "0 9 * * 1-5",
      "0 8 * * *",
      "*/15 * * * *",
      "30 6 1,15 * *",
      "0 0-22/2 * * 0",
      "0 9 * * MON-FRI",
      "0 9 * * MON",
      "0 9 1 JAN *",
      "0 9 L * *",
      "0 9 * * 1#2",
      "0 9 ? * *",
      "@daily",
      "0 9 * *",
      "0 9 * * * *",
      "5/10 * * * *",
      "0 25 * * *",
    ];
    assert.ok(cases.some((c) => isValidCronExpr(c)) && cases.some((c) => !isValidCronExpr(c)), "the table holds both kinds");
    for (const schedule of cases) {
      modelSchedules = [schedule];
      if (isValidCronExpr(schedule)) {
        const draft = await draftAutomation(description, { tenantId: OASIS });
        assert.equal(draft.schedule, schedule, `"${schedule}" is runnable and must come back as drafted`);
      } else {
        await assert.rejects(
          () => draftAutomation(description, { tenantId: OASIS }),
          /^Error: automation_draft_bad_schedule/,
          `"${schedule}" cannot be run and must be refused at the draft step`,
        );
      }
      assert.deepEqual(modelSchedules, [], `the model was asked once for "${schedule}"`);
    }
  });

  await check("the prompt the model receives asks for numeric days and months, never names", async () => {
    modelSchedules = ["0 9 * * 1-5"];
    await draftAutomation(description, { tenantId: OASIS });
    const { tenantId, system, prompt } = modelCalls[modelCalls.length - 1];
    assert.equal(tenantId, OASIS, "the drafter runs for the session's workspace");
    assert.match(system, /day of week as numbers 0-6 \(0 = Sunday\)/i);
    assert.match(system, /never names like MON or MON-FRI/);
    assert.match(system, /month as numbers 1-12/i);
    assert.match(system, /no L, W, # or \?/i);
    assert.match(prompt, /"weekdays" pick 0 9 \* \* 1-5/, "the worked examples include a numeric weekday schedule");
  });

  // ── the routes ───────────────────────────────────────────────────────────
  await check("the draft route answers a MON-FRI draft 502 draft_invalid with a sentence naming the schedule, and writes nothing", async () => {
    const before = await rowCount();
    modelSchedules = ["0 9 * * MON-FRI"];
    const res = await post(draftRoute, "/api/automations/draft", { description });
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "draft_invalid");
    assertSentence(res.body.message, "the draft refusal");
    assert.ok(res.body.message!.includes("0 9 * * MON-FRI"), `the refusal names what the AI wrote: ${res.body.message}`);
    assert.match(res.body.message!, /Draft with AI/, "the refusal says what to do next");
    assert.equal(res.body.draft, undefined, "the refused draft is not handed to the review step");
    assert.equal(await rowCount(), before);

    modelSchedules = ["0 9 * * 1-5"];
    const ok = await post(draftRoute, "/api/automations/draft", { description });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.draft?.schedule, "0 9 * * 1-5");
  });

  await check("save-draft's 400 is a sentence naming each bad field, not the bare code", async () => {
    const before = await rowCount();
    const res = await post(saveRoute, "/api/automations/save-draft", { confirmed: true, draft: modelDraft("0 9 * * MON-FRI") });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "draft_invalid");
    assert.deepEqual(res.body.missing_or_invalid, ["schedule"]);
    assertSentence(res.body.message, "the save refusal");
    assert.match(res.body.message!, /schedule/i, `the refusal names the schedule: ${res.body.message}`);
    assert.match(res.body.message!, /Draft with AI/, "the refusal says what to do next");

    const several = await post(saveRoute, "/api/automations/save-draft", {
      confirmed: true,
      draft: { ...modelDraft("0 9 * JAN *"), suggested_name: "x".repeat(81), script_filename: "Weekday Summary.py" },
    });
    assert.equal(several.status, 400, JSON.stringify(several.body));
    assert.deepEqual(several.body.missing_or_invalid, ["suggested_name", "script_filename", "schedule"]);
    assertSentence(several.body.message, "the save refusal for three fields");
    assert.match(several.body.message!, /its name, script file name and schedule are missing or not valid\./, several.body.message);
    assert.doesNotMatch(several.body.message!, /suggested_name|script_filename/, "field keys are not words");
    assert.equal(await rowCount(), before, "a refused save wrote a row");
  });

  await check("save-draft refuses a valid legacy body that has no target pipeline", async () => {
    const before = await rowCount();
    const res = await post(saveRoute, "/api/automations/save-draft", { confirmed: true, draft: modelDraft("0 9 * * 1-5") });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.error, "pipeline_required");
    assert.match(String(res.body.message), /choose a compatible computer/i);
    assert.equal(await rowCount(), before, "an undeliverable legacy body wrote a cron row");
  });

  // ── the page ─────────────────────────────────────────────────────────────
  await check("the four-step page preserves a refused draft error, retries immediately, and saves a targeted paused template", async () => {
    const before = await rowCount();
    fetches.length = 0;
    draftAnswer = null;
    modelSchedules = ["0 9 * * MON-FRI", "0 9 * * 1-5"];
    const view = mount(() => DescribeAutomationFlow());
    await completeWizard(view);
    await click(button(view(), /^Draft for review$/));

    const refused = flat(view());
    assert.doesNotMatch(refused, /Review before saving/, `a draft that cannot be saved reached review: ${refused}`);
    assert.equal(buttons(view(), /^Save automation/).length, 0, "a draft that cannot be saved must not offer Save");
    assert.match(refused, /can't run \("0 9 \* \* MON-FRI"\)/, `the sentence from the route is shown: ${refused}`);
    assert.match(refused, /Draft with AI to/, `the shown sentence says what to do: ${refused}`);
    assert.doesNotMatch(refused, /draft_invalid|automation_draft_/, `a bare code is shown: ${refused}`);

    // The very next click, with no edit in between, must draft again.
    await click(button(view(), /^Draft for review$/));
    assert.equal(fetchesTo("/api/automations/draft"), 2, "Draft with AI did nothing from the error state");
    const review = flat(view());
    assert.match(review, /Review before saving/, review);
    assert.match(review, /0 9 \* \* 1-5/, review);

    await click(button(view(), /^Save automation \(disabled\)$/));
    assert.match(flat(view()), /Automation saved \(paused\)/, flat(view()));
    assert.equal(fetchesTo("/api/bridge/exec-tool"), 0, "the browser never writes to a tenant-level bridge that may be another computer");
    assert.equal(await rowCount(), before + 1);
    const row = (await db.execute("SELECT id, tenant_id, schedule, action_type, action_payload, enabled, owner_user_id, created_by, target_pairing_id FROM tenant_cron_jobs ORDER BY created_at DESC LIMIT 1")).rows[0];
    assert.equal(row.tenant_id, OASIS);
    assert.equal(row.schedule, "0 9 * * 1-5");
    assert.equal(row.action_type, "script_run");
    assert.equal(Number(row.enabled), 0, "an AI-drafted script lands switched off");
    // O2: an unowned row is anyone's to manage and is served to the labelled
    // computer, so a saved draft must belong to the person who saved it.
    assert.equal(row.owner_user_id, CC.id, "the saved draft is owned by the saver's auth id");
    assert.equal(row.created_by, CC.id, "created_by is the auth id, like POST /api/cron-jobs");
    assert.equal(row.target_pairing_id, "pair-cc-main", "the paused job is pinned to the chosen computer");
    const payload = JSON.parse(String(row.action_payload)) as Record<string, unknown>;
    assert.equal(payload._generated_script_content, undefined, "executable source is never persisted in the forgeable cron payload");
    assert.equal(typeof payload._automation_template_id, "string", "the cron payload carries only the reviewed template id");
    assert.equal(payload._target_pairing_id, "pair-cc-main");
    const template = (await db.execute("SELECT id, department, target_pairing_id, status, draft_json FROM automation_templates LIMIT 1")).rows[0];
    assert.equal(template.department, "marketing");
    assert.equal(template.target_pairing_id, "pair-cc-main");
    assert.equal(template.status, "ready");
    assert.equal(payload._automation_template_id, template.id);

    await db.execute({ sql: "UPDATE tenant_cron_jobs SET enabled = 1 WHERE id = ?", args: [row.id] });
    const pollResponse = await pollRoute.GET(new NextRequest("http://localhost/api/cron-jobs/poll", {
      headers: { authorization: `Bearer ${PAIR_TOKEN}` },
    }));
    assert.equal(pollResponse.status, 200);
    const pollBody = await pollResponse.json() as { jobs: Array<{ id: string; agent_key: string; action_payload: Record<string, unknown> }> };
    assert.equal(pollBody.jobs.length, 1);
    const delivered = pollBody.jobs[0].action_payload;
    const envelope = delivered._generated_script as { version: number; source: string; signature: string };
    const source = modelDraft("0 9 * * 1-5").script_content;
    const sourceHash = createHash("sha256").update(source, "utf8").digest("hex");
    const message = `v1\n${row.id}\nbravo\n${String(delivered.script)}\n${sourceHash}`;
    assert.equal(delivered.script, `scripts/_generated/${row.id}/${sourceHash.slice(0, 16)}_weekday_lead_summary.py`);
    assert.deepEqual(envelope, {
      version: 1,
      source,
      signature: createHmac("sha256", PAIR_TOKEN).update(message, "utf8").digest("hex"),
    });
    const storedAfterPoll = JSON.parse(String((await db.execute({ sql: "SELECT action_payload FROM tenant_cron_jobs WHERE id = ?", args: [row.id] })).rows[0].action_payload)) as Record<string, unknown>;
    assert.equal(storedAfterPoll._generated_script, undefined, "the signed source is ephemeral and is not written back to the database");

    const stampBeforeFailure = String((await db.execute("SELECT last_poll_ok_at FROM bridge_pairings WHERE id = 'pair-cc-main'")).rows[0].last_poll_ok_at);
    await db.execute("ALTER TABLE automation_templates RENAME TO automation_templates_offline");
    const originalError = console.error;
    console.error = () => undefined;
    try {
      const failedPoll = await pollRoute.GET(new NextRequest("http://localhost/api/cron-jobs/poll", {
        headers: { authorization: `Bearer ${PAIR_TOKEN}` },
      }));
      assert.equal(failedPoll.status, 503, "a template lookup outage must not masquerade as an empty healthy poll");
      assert.equal((await failedPoll.json()).error, "generated_template_lookup_failed");
      const stampAfterFailure = String((await db.execute("SELECT last_poll_ok_at FROM bridge_pairings WHERE id = 'pair-cc-main'")).rows[0].last_poll_ok_at);
      assert.equal(stampAfterFailure, stampBeforeFailure, "a failed delivery must not advance last_poll_ok_at");
    } finally {
      console.error = originalError;
      await db.execute("ALTER TABLE automation_templates_offline RENAME TO automation_templates");
    }
  });

  await check("a review drafted before this fix, whose Save is refused, shows save-draft's sentence and can be drafted again", async () => {
    const before = await rowCount();
    fetches.length = 0;
    // A draft the page received before the draft step checked schedules.
    draftAnswer = { ok: true, draft: modelDraft("0 9 * * MON-FRI") };
    const view = mount(() => DescribeAutomationFlow());
    await completeWizard(view);
    await click(button(view(), /^Draft for review$/));
    assert.match(flat(view()), /Review before saving/);

    await click(button(view(), /^Save automation \(disabled\)$/));
    const refused = flat(view());
    assert.match(refused, /schedule/i, `save-draft's sentence is shown: ${refused}`);
    assert.match(refused, /Draft with AI to/, refused);
    assert.doesNotMatch(refused, /draft_invalid/, `the bare code is shown: ${refused}`);
    assert.equal(fetchesTo("/api/bridge/exec-tool"), 0, "nothing is written to the paired computer");
    assert.equal(await rowCount(), before);

    draftAnswer = null;
    modelSchedules = ["0 9 * * 1-5"];
    await click(button(view(), /^Re-draft$/));
    assert.match(flat(view()), /Review before saving/, "Re-draft did nothing after a refused save");
    assert.match(flat(view()), /0 9 \* \* 1-5/);
  });

  if (failures > 0) {
    console.log(`automation-draft-schedule: ${failures} failing`);
    process.exit(1);
  }
  console.log("automation-draft-schedule: all checks passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
