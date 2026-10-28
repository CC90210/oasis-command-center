/**
 * tests/training-recall-route.test.ts - the recall test on Admin > Agent training (2026-10-28).
 *
 * POST /api/admin/agent-training/recall asks a department's agent about one learned note through the
 * department's real turn, and says whether the note was among the notes picked for the question.
 * Pinned here:
 *   1. the edges refuse before any session or database read: an unknown path is 404, a cross-origin
 *      call is 403, a body that is not exactly {note_id, department, question} is 400;
 *   2. the gates and the turn, from the source: operator only, the note checked in this workspace and
 *      finished, the department's bound agent, its own usage surface (never a chat), the question as the
 *      training query, the note NEVER forced in, and a computer-only engine refused in words;
 *   3. the surface is registered and kept out of the chat health check.
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
