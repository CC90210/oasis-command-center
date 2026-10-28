/**
 * tests/training-recall-route.test.ts - the recall test on Admin > Agent training (2026-10-28).
 *
 * POST /api/admin/agent-training/recall asks a department's agent about one learned note through the
 * department's real turn, and says whether the note was among the notes picked for the question.
 * Pinned here:
 *   1. the edges refuse before any session or database read: an unknown path is 404, a cross-origin
 *      call is 403, a body that is not exactly {note_id, department, question} is 400;
 *   2. a refused session keeps its own reason (no AI account 412, unreadable settings 503, a computer
 *      that cannot take the turn = the computer guidance), and only a non-operator hears "operator";
 *   3. the question is scrubbed of secrets before the notes are ranked by it or the model sees it, and
 *      "included" is read off the notes the turn actually holds;
 *   4. the gates and the turn, from the source: operator only, the note checked in this workspace and
 *      finished, the department's bound agent, its own usage surface (never a chat), the question as the
 *      training query, the note NEVER forced in, and a computer-only engine refused in words;
 *   5. the surface is registered and kept out of the chat health check.
 *
 * Run: node --conditions=react-server --import tsx tests/training-recall-route.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The route's import chain reaches next/navigation and next/headers, whose real modules pull the client
// router context, which does not exist under the react-server condition. The edges tested at runtime
// never reach a session or a redirect, so empty stand-ins are enough (tests/manager-deactivated-report-history).
function stubModule(specifier: string, exports: Record<string, unknown>): void {
  const path = require.resolve(specifier);
  require.cache[path] = { id: path, filename: path, path: dirname(path), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stubModule("next/navigation", {
  notFound: () => { throw new Error("NEXT_HTTP_ERROR_FALLBACK;404"); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT;${url}`); },
  useRouter: () => ({}),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
});
stubModule("next/headers", {
  cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set: () => undefined }),
  headers: async () => new Headers(),
});

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const ROUTE = "app/api/admin/agent-training/[[...path]]/route.ts";

// Stand-ins for the session, the database, the department binding and the turn, so refusals and the
// happy path run through the real route with no login, database or model. Each records what it got.
let session: unknown = { ok: false, status: 401, error: "unauthorized" };
let picked: string[] = [];
let prepareResult: unknown = null;
let modelResult: unknown = null;
const turnRequests: Array<Record<string, unknown>> = [];
const modelMessages: Array<Array<{ role: string; content: string }>> = [];
stubModule(join(ROOT, "lib/os/runs/session.ts"), { resolveRunSession: async () => session });
stubModule(join(ROOT, "lib/turso.ts"), {
  tursoConfigured: () => true,
  getTursoClient: () => ({ execute: async () => ({ rows: [{ id: "n1" }] }) }),
});
stubModule(join(ROOT, "components/os/department/config.ts"), {
  departmentChannelFor: () => ({ kind: "agent", agentSlug: "sales-agent" }),
});
stubModule(join(ROOT, "lib/os/department-agent.ts"), {
  prepareAgentTurn: async (request: Record<string, unknown>) => {
    turnRequests.push(request);
    return prepareResult ?? { ok: true, turn: { trainingNoteIds: picked, engine: { runsOn: "the workspace AI account" } } };
  },
  runAgentTurnToText: async (_turn: unknown, messages: Array<{ role: string; content: string }>) => {
    modelMessages.push(messages);
    return modelResult ?? { ok: true, text: "Open with the problem, then the proof." };
  },
});
const operatorSession = (over: Record<string, unknown> = {}) => ({
  ok: true,
  session: {
    isOperator: true,
    viewer: { ok: true, oasis: true, manifest: null },
    scope: { tenantId: "tenant-1", userId: "user-1" },
    dept: { key: "sales" },
    tenantSlug: "oasis",
    operatorName: "CC",
    email: "cc@oasis.test",
    fallback: null,
    apiEngineChoice: { kind: "api" },
    apiAccountSnapshot: null,
    ...over,
  },
});

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).stack || error).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

function post(path: string[], body: unknown, headers: Record<string, string> = {}) {
  return {
    req: new Request("https://app.test/api/admin/agent-training/" + path.join("/"), {
      method: "POST",
      headers: { host: "app.test", "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    ctx: { params: Promise.resolve({ path }) },
  };
}

async function main(): Promise<void> {
  const route = await import("../app/api/admin/agent-training/[[...path]]/route");
  const same = { origin: "https://app.test" };
  const good = { note_id: "n1", department: "sales", question: "What did you learn?" };

  await check("an unknown path is a 404", async () => {
    const { req, ctx } = post(["nope"], good, same);
    assert.equal((await route.POST(req, ctx)).status, 404);
  });

  await check("a cross-origin or originless call is refused before anything is read", async () => {
    for (const headers of [{}, { origin: "https://evil.test" }]) {
      const { req, ctx } = post(["recall"], good, headers);
      const res = await route.POST(req, ctx);
      assert.equal(res.status, 403);
      assert.equal(((await res.json()) as { error: string }).error, "forbidden");
    }
  });

  await check("a body that is not exactly {note_id, department, question} is a 400, in plain words", async () => {
    const bad: unknown[] = [
      "{not json",
      [good],
      { ...good, extra: true },
      { ...good, department: "all" },
      { ...good, department: "nonsense" },
      { ...good, note_id: "../../etc" },
      { ...good, question: "" },
      { ...good, question: "x".repeat(601) },
      "x".repeat(4_100),
    ];
    for (const body of bad) {
      const { req, ctx } = post(["recall"], body, same);
      const res = await route.POST(req, ctx);
      assert.equal(res.status, 400, `refused ${JSON.stringify(body).slice(0, 60)}`);
      const json = (await res.json()) as { message: string };
      assert.match(json.message, /could not be read/);
    }
  });

  await check("a refused session keeps its own reason; only a missing sign-in is 401", async () => {
    const cases: Array<[Record<string, unknown>, number, string, RegExp]> = [
      [{ ok: false, status: 401, error: "unauthorized" }, 401, "unauthorized", /Sign in again/],
      [{ ok: false, status: 412, error: "agent_not_configured" }, 412, "agent_not_configured", /No AI account is connected/],
      [{ ok: false, status: 503, error: "config_unavailable" }, 503, "config_unavailable", /could not read this workspace's AI settings/],
      [{ ok: false, status: 503, error: "profile_unavailable" }, 503, "profile_unavailable", /could not confirm your workspace/],
      // Every refusal about a paired computer gets the computer guidance: a recall test never runs there.
      [{ ok: false, status: 409, error: "computer_not_connected" }, 409, "computer_only", /answers on your computer/],
      [{ ok: false, status: 403, error: "computer_not_yours" }, 409, "computer_only", /answers on your computer/],
      [{ ok: false, status: 409, error: "subscription_auth_failure" }, 409, "computer_only", /answers on your computer/],
    ];
    for (const [refusal, status, error, message] of cases) {
      session = refusal;
      const { req, ctx } = post(["recall"], good, same);
      const res = await route.POST(req, ctx);
      const json = (await res.json()) as { error: string; message: string; code?: string };
      assert.equal(res.status, status, `${String(refusal.error)} keeps its status`);
      assert.equal(json.error, error, `${String(refusal.error)} keeps its reason`);
      assert.match(json.message, message);
      assert.doesNotMatch(json.message, /platform operator/, `${String(refusal.error)} is not an operator refusal`);
      if (error === "computer_only") assert.equal(json.code, refusal.error, "the computer's own reason travels with it");
    }
    assert.equal(turnRequests.length, 0, "no refused session reaches the turn");
  });

  await check("only a non-operator hears \"operator\"; an unconfirmed seat says so", async () => {
    session = operatorSession({ isOperator: false });
    let { req, ctx } = post(["recall"], good, same);
    let res = await route.POST(req, ctx);
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { message: string }).message, /Only a platform operator/);
    session = operatorSession({ viewer: { ok: false } });
    ({ req, ctx } = post(["recall"], good, same));
    res = await route.POST(req, ctx);
    assert.equal(res.status, 403);
    assert.match(((await res.json()) as { message: string }).message, /could not confirm your access/);
    assert.equal(turnRequests.length, 0);
  });

  await check("the question is scrubbed before the notes are ranked by it or the model sees it", async () => {
    session = operatorSession();
    picked = ["n1", "n2"];
    const question = 'What did you learn from "https://x.test/page?token=abc123secret"?';
    const { req, ctx } = post(["recall"], { ...good, question }, same);
    const res = await route.POST(req, ctx);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const json = (await res.json()) as { included: boolean; picked: number; answer: string };
    assert.equal(json.included, true, "n1 is among the notes the turn holds");
    assert.equal(json.picked, 2);
    const ranked = String(turnRequests.at(-1)?.trainingQuery);
    const asked = modelMessages.at(-1)?.[0]?.content ?? "";
    for (const sent of [ranked, asked]) {
      assert.ok(!sent.includes("abc123secret"), "a credential in a quoted link never leaves the route");
      assert.match(sent, /token=\[REDACTED\]/);
    }
    assert.equal(turnRequests.at(-1)?.surface, "training.recall");
  });

  await check("a note the turn does not hold is reported as not picked", async () => {
    session = operatorSession();
    picked = ["n2"];
    const { req, ctx } = post(["recall"], good, same);
    const res = await route.POST(req, ctx);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { included: boolean }).included, false);
  });

  await check("a failed turn says what to change when its code is known, and only an unknown one says try again", async () => {
    session = operatorSession();
    picked = ["n1"];
    const ask = async () => {
      const { req, ctx } = post(["recall"], good, same);
      const res = await route.POST(req, ctx);
      return { status: res.status, json: (await res.json()) as { error: string; code: string; message: string; fix?: { href: string } } };
    };
    prepareResult = { ok: false, status: 402, error: "ai_budget_exhausted" };
    let got = await ask();
    assert.equal(got.status, 402);
    assert.equal(got.json.code, "ai_budget_exhausted");
    assert.match(got.json.message, /This month's AI budget is used/);
    prepareResult = null;
    modelResult = { ok: false, code: "provider_401" };
    got = await ask();
    assert.equal(got.status, 502);
    assert.match(got.json.message, /Your AI account refused the request/);
    assert.ok(got.json.fix?.href.startsWith("/"), "a fixable failure links to where it is fixed");
    modelResult = { ok: false, code: "something_new" };
    got = await ask();
    assert.match(got.json.message, /did not answer this time/);
    assert.equal(got.json.fix, undefined);
    modelResult = null;
  });

  await check("the gates and the turn, as the source writes them", () => {
    const src = read(ROUTE);
    assert.match(src, /if \(!session\.isOperator\) return refuse\(403, "forbidden"\);/, "operator only");
    assert.match(src, /WHERE tenant_id = \? AND id = \? AND state = 'indexed'/, "the note is checked in this workspace and finished");
    assert.match(src, /departmentChannelFor\(session\.dept\.key,/, "the department's bound agent answers");
    assert.match(src, /surface: "training\.recall",/, "its own usage surface");
    assert.match(src, /trainingQuery: question,/, "the question picks the notes");
    assert.doesNotMatch(src, /forceId|trainingForceNoteId/, "the note is never forced into the turn");
    assert.match(src, /const included = turn\.trainingNoteIds\.includes\(noteId\);/);
    assert.match(src, /failClosedWithoutComputerDispatch: true,/, "a device engine is never reached, and no fallback key is spent");
    assert.match(src, /prepared\.error === "computer_choice_needs_pairing" \|\| prepared\.error === "engine_dispatch_unavailable"/);
    assert.match(src, /computer_only:\s*\n?\s*"This agent answers on your computer/, "a computer-only agent is told so in words");
  });

  await check("training.recall is a registered surface, kept out of the chat health check", () => {
    assert.match(read("lib/ai/usage.ts"), /"training\.recall", \/\//);
    assert.match(read("lib/health/department-chat-checks.ts"), /NOT_CHAT_SURFACES: readonly UsageSurface\[\] = \[[^\]]*"training\.recall"/);
    assert.match(read("lib/os/department-agent.ts"), /surface\?: "agents\.chat" \| "automations\.run" \| "training\.recall";/);
  });

  console.log(`training-recall-route: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
