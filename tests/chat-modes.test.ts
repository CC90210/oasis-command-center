/**
 * Chat-modes test — covers both slash-parser and plan-mode in one runner-
 * friendly file. Pattern matches the other tests in this directory:
 * `tsx tests/<name>.test.ts` with node:assert/strict.
 *
 * Run: npm run test:chat-modes
 */
import assert from "node:assert/strict";
import {
  ALL_COMMANDS,
  isKnownCommand,
  parseInput,
  renderHelp,
  type SlashCommandName,
} from "@/lib/chat-modes/slash-parser";
import {
  composeSystemPrompt,
  filterToolsForMode,
  normalizeMode,
  PLAN_MODE_PROMPT_OVERLAY,
  PLAN_MODE_TOOL_ALLOWLIST,
} from "@/lib/chat-modes/plan-mode";

let passed = 0;
let failed = 0;
const fail = (label: string, err: unknown) => {
  failed++;
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`  FAIL  ${label}\n         ${msg}`);
};
const ok = (label: string) => {
  passed++;
  console.log(`  ok    ${label}`);
};
const test = (label: string, fn: () => void) => {
  try {
    fn();
    ok(label);
  } catch (e) {
    fail(label, e);
  }
};

console.log("\n=== slash-parser ===");

test("bare /clear", () => {
  const r = parseInput("/clear");
  assert.equal(r.kind, "command");
  if (r.kind === "command") {
    assert.equal(r.name, "clear");
    assert.equal(r.args, "");
  }
});

test("/agent atlas carries args", () => {
  const r = parseInput("/agent atlas");
  assert.equal(r.kind, "command");
  if (r.kind === "command") {
    assert.equal(r.name, "agent");
    assert.equal(r.args, "atlas");
  }
});

test("/model with multi-token arg keeps the rest of the line", () => {
  const r = parseInput("/model claude-sonnet-4-6 priority=high");
  assert.equal(r.kind, "command");
  if (r.kind === "command") {
    assert.equal(r.name, "model");
    assert.equal(r.args, "claude-sonnet-4-6 priority=high");
  }
});

test("/HELP case-insensitive", () => {
  const r = parseInput("/HELP");
  assert.equal(r.kind, "command");
  if (r.kind === "command") assert.equal(r.name, "help");
});

test("leading whitespace tolerated", () => {
  const r = parseInput("   /plan");
  assert.equal(r.kind, "command");
});

test("/compact + multi-line hint folds into args", () => {
  const r = parseInput("/compact\nfocus on revenue this week");
  assert.equal(r.kind, "command");
  if (r.kind === "command") assert.equal(r.args, "focus on revenue this week");
});

test("plain message falls through", () => {
  const r = parseInput("hello world");
  assert.equal(r.kind, "message");
});

test("unknown slash is treated as a message (not silently dropped)", () => {
  const r = parseInput("/foo bar");
  assert.equal(r.kind, "message");
  if (r.kind === "message") assert.equal(r.text, "/foo bar");
});

test("path-looking input is NOT a command", () => {
  const r = parseInput("/path/to/file.ts");
  assert.equal(r.kind, "message");
});

test("'/ plan' with space is NOT a command", () => {
  const r = parseInput("/ plan");
  assert.equal(r.kind, "message");
});

test("multi-line starting with text is a message", () => {
  const r = parseInput("look at this:\n/clear is what I'd usually type");
  assert.equal(r.kind, "message");
});

test("isKnownCommand passes for every entry in ALL_COMMANDS", () => {
  for (const c of ALL_COMMANDS) assert.equal(isKnownCommand(c), true);
});

test("isKnownCommand accepts /model + /compact (both now wired)", () => {
  // Both promoted from stubs to wired handlers on 2026-05-22 —
  // /model hits /api/agent-config; /compact hits /api/chat/compact.
  assert.equal(isKnownCommand("model"), true);
  assert.equal(isKnownCommand("compact"), true);
});

test("isKnownCommand rejects unknown + case-sensitive at the type-guard layer", () => {
  assert.equal(isKnownCommand("foo"), false);
  assert.equal(isKnownCommand("Build"), false);
});

test("renderHelp lists every wired command", () => {
  const help = renderHelp();
  for (const c of ALL_COMMANDS) assert.ok(help.includes(`/${c}`));
  // /model and /compact were stubs until 2026-05-22; now they're real
  // handlers and must appear in /help so operators discover them.
  assert.ok(help.includes("/model"));
  assert.ok(help.includes("/compact"));
});

test("renderHelp starts with a heading", () => {
  assert.match(renderHelp().split("\n")[0]!, /Slash commands/i);
});

console.log("\n=== plan-mode ===");

const SAMPLE_TOOLS = [
  { name: "list_records" },
  { name: "get_record" },
  { name: "search_records" },
  { name: "http_get" },
  { name: "read_file" },
  { name: "list_skills" },
  { name: "create_record" },
  { name: "update_record" },
  { name: "delete_record" },
  { name: "write_file" },
  { name: "bash" },
  { name: "send_email" },
  { name: "send_sms" },
  { name: "http_post" },
  { name: "run_script" },
];

test("build mode returns the full list unchanged", () => {
  const out = filterToolsForMode(SAMPLE_TOOLS, "build");
  assert.deepEqual(out, SAMPLE_TOOLS);
});

test("plan mode strips write tools", () => {
  const out = filterToolsForMode(SAMPLE_TOOLS, "plan");
  const names = out.map((t) => t.name);
  assert.ok(names.includes("list_records"));
  assert.ok(names.includes("read_file"));
  assert.ok(names.includes("http_get"));
  assert.ok(!names.includes("create_record"));
  assert.ok(!names.includes("write_file"));
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("send_email"));
  assert.ok(!names.includes("http_post"));
});

test("plan-mode allowlist is a strict subset of input names", () => {
  const out = filterToolsForMode(SAMPLE_TOOLS, "plan");
  for (const t of out) assert.ok(PLAN_MODE_TOOL_ALLOWLIST.has(t.name));
});

test("unknown tool in plan mode is filtered out (default-deny)", () => {
  const out = filterToolsForMode([{ name: "future_brand_new_tool" }], "plan");
  assert.deepEqual(out, []);
});

test("filter returns a new array (safe to mutate)", () => {
  const tools = [{ name: "list_records" }];
  const out = filterToolsForMode(tools, "build");
  assert.notEqual(out, tools);
  assert.deepEqual(out, tools);
});

test("composeSystemPrompt: build mode returns base prompt unchanged", () => {
  assert.equal(composeSystemPrompt("You are Bravo.", "build"), "You are Bravo.");
});

test("composeSystemPrompt: plan mode appends the overlay", () => {
  const out = composeSystemPrompt("You are Bravo.", "plan");
  assert.ok(out.startsWith("You are Bravo."));
  assert.ok(out.includes("PLAN MODE ACTIVE"));
  assert.ok(out.includes("/build"));
  assert.ok(out.includes(PLAN_MODE_PROMPT_OVERLAY));
});

test("plan overlay prohibits the dangerous primitives", () => {
  assert.match(PLAN_MODE_PROMPT_OVERLAY, /Write or edit any file/i);
  assert.match(PLAN_MODE_PROMPT_OVERLAY, /shell command/i);
  assert.match(PLAN_MODE_PROMPT_OVERLAY, /email or SMS/i);
  assert.match(PLAN_MODE_PROMPT_OVERLAY, /do NOT escape plan mode/i);
});

test("normalizeMode: 'plan' → plan", () => {
  assert.equal(normalizeMode("plan"), "plan");
});
test("normalizeMode: 'build' → build", () => {
  assert.equal(normalizeMode("build"), "build");
});
test("normalizeMode: anything else collapses to build (fail-open)", () => {
  assert.equal(normalizeMode("foo"), "build");
  assert.equal(normalizeMode(null), "build");
  assert.equal(normalizeMode(undefined), "build");
  assert.equal(normalizeMode(42), "build");
});

console.log("\n=== ResumeState carries chatMode (regression lock) ===");

// Structural contract: ResumeState MUST carry chatMode so a paused
// plan-mode turn can re-apply the tool filter on resume. If anyone
// removes this field, the test file fails to compile — TypeScript
// catches it before runtime.
test("ResumeState type-shape includes chatMode (compile-time guarantee)", async () => {
  const mod = await import("@/lib/cloud-tool-runner");
  // We assert by constructing a value that satisfies the ResumeState type.
  // If the field is removed from the type, this object literal will fail
  // typecheck on the `chatMode` assignment.
  const state: import("@/lib/cloud-tool-runner").ResumeState = {
    model: "claude-sonnet-4-6",
    system: "You are Bravo.",
    history: [],
    iteration: 0,
    totalIn: 0,
    totalOut: 0,
    chatMode: "plan",
  };
  // Runtime assertion: the value we constructed echoes back unchanged via
  // canonical JSON roundtrip (the same path the HMAC signer uses).
  const json = JSON.stringify(state);
  const parsed = JSON.parse(json) as typeof state;
  assert.equal(parsed.chatMode, "plan");
  assert.equal(typeof mod.streamAnthropicWithTools, "function");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Silence the noinspection that we don't export anything (this is a runner
// script, not a module). The SlashCommandName import is here to verify it
// type-exports cleanly when this file is processed by tsx.
type _Check = SlashCommandName;
