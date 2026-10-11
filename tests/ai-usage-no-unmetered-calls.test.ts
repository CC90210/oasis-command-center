/**
 * ai-usage-no-unmetered-calls.test.ts — no file calls a model provider except
 * through the AI usage ledger (lib/ai/usage.ts).
 *
 * WHY (OASIS OS plan v2 §F2.6, docs/os-revamp/03-connectors-ai-finance.md
 * §d.3). A model call that bypasses the meter is spend nobody recorded and a
 * budget cap it walks straight past. Every metered call site is a file on the
 * ALLOW-LIST below, and each takes a ModelCallMeter from lib/ai/usage.ts; the
 * behavioural half (one row per call, the cap, the costs) is
 * tests/ai-usage-ledger.test.ts. Same shape as
 * tests/no-subscription-infer-outside-router.test.ts: "nobody bypasses the
 * meter" is a property of the whole tree, which only a scan of the tree can
 * establish.
 *
 * A "model call" here is any of:
 *   - a provider's model endpoint in a string: api.anthropic.com/v1/...,
 *     api.openai.com/v1/..., generativelanguage.googleapis.com, an OpenRouter
 *     model path (not /auth/key, /models or /credits, which spend nothing), or
 *     any string ENDING in /chat/completions or /v1/messages (a self-hosted or
 *     OpenAI-compatible base plus the model path);
 *   - an import of a model SDK (Anthropic, OpenAI, Google GenAI, Vercel AI SDK,
 *     OpenRouter, Ollama, Groq, Mistral, Cohere).
 * Comments are stripped first, so a sentence ABOUT an endpoint is not a call.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-usage-no-unmetered-calls.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const ROOT = join(__dirname, "..");
const SOURCE_DIRS = ["app", "lib", "components", "scripts", "workers"];
const ROOT_FILES = ["middleware.ts", "open-next.config.ts", "next.config.js"];
const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_DIRS = new Set(["node_modules", ".next", ".open-next", ".git", "__pycache__"]);

/**
 * The metered call sites, each with the number of lines in it that name a
 * model endpoint or import a model SDK (modelCallLines). Each one takes its
 * meter from lib/ai/usage.ts (a value or type import of it, or of
 * lib/ai/usage-codes via the recorder). Adding a file here is a claim that
 * every request in it goes through meter.begin() / call.finish();
 * tests/ai-usage-ledger.test.ts proves the claim for each one.
 *
 * The count is pinned because the allow-list is per FILE: without it, a second,
 * unmetered fetch to a provider added to one of these files would pass. A new
 * endpoint line fails here until someone checks it goes through the meter and
 * raises the count.
 */
export const METERED_CALL_SITES = new Map<string, number>([
  ["lib/providers.ts", 5], //           streamChat: Ollama, OpenRouter, Anthropic, OpenAI, Google
  ["lib/cloud-tool-runner.ts", 3], //   the Anthropic tool loop; the OpenAI-compatible loop's two URLs (OpenRouter, OpenAI)
  ["lib/agents/provider-probe.ts", 5], // Settings "Test": Anthropic, Google, OpenAI, OpenRouter, Ollama
  ["lib/ai-document-extractor.ts", 1], // document extraction
  ["lib/os/desk/gemini-loop.ts", 1], // a department turn's Gemini function-calling loop (tests/department-desk.test.ts: one ledger row per request)
]);
/** The subscription router records its own rows (its transport is gated by the other test). */
const RECORDING_ROUTERS = new Set(["lib/ai/infer.ts"]);
const RECORDER = "lib/ai/usage.ts";

const ENDPOINT_RES: Array<[string, RegExp]> = [
  ["Anthropic API", /api\.anthropic\.com\/v1\//],
  ["OpenAI API", /api\.openai\.com\/v1\//],
  ["Google Gemini API", /generativelanguage\.googleapis\.com/],
  ["OpenRouter model API", /openrouter\.ai\/api\/v1\/(?!auth\b|key\b|models\b|credits\b|generation\b)/],
  ["an OpenAI-compatible model path", /\/chat\/completions["'`]/],
  ["an Anthropic-compatible model path", /\/v1\/messages["'`]/],
];

const SDK_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)["'](@anthropic-ai\/[^"']+|openai|openai\/[^"']+|@google\/genai|@google\/generative-ai|ai|@ai-sdk\/[^"']+|@openrouter\/[^"']+|ollama|ollama\/[^"']+|groq-sdk|@mistralai\/[^"']+|cohere-ai)["']/g;

const USAGE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s+|\bimport\s*\(\s*)["'](?:@\/lib\/ai\/usage|(?:\.{1,2}\/)+(?:lib\/)?ai\/usage|\.\/usage)["']/;

/**
 * Remove comment LINES: a line that starts with // and a block comment that
 * starts a line (/* or /**) through its closing *\/. Line-based on purpose: a
 * character scanner mistakes the quotes inside a regex literal for strings.
 * A comment trailing code on the same line is kept, so the scan errs loud (a
 * false positive names the line to reword), never quiet.
 */
export function stripComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split(/\r?\n/)) {
    const t = line.trimStart();
    if (inBlock) {
      const close = line.indexOf("*/");
      if (close >= 0) {
        inBlock = false;
        out.push(line.slice(close + 2));
      }
      continue;
    }
    if (t.startsWith("//")) continue;
    if (t.startsWith("/*")) {
      const close = t.indexOf("*/", 2);
      if (close < 0) inBlock = true;
      else out.push(t.slice(close + 2));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/** What in `src` calls a model: endpoint names and SDK imports. */
export function modelCallsIn(src: string): string[] {
  const code = stripComments(src);
  const hits: string[] = [];
  for (const [label, re] of ENDPOINT_RES) if (re.test(code)) hits.push(label);
  for (const m of code.matchAll(SDK_RE)) hits.push(`SDK import "${m[1]}"`);
  return hits;
}

/** How many lines of `src` (comments stripped) name a model endpoint or import a model SDK. */
export function modelCallLines(src: string): number {
  let n = 0;
  for (const line of stripComments(src).split("\n")) {
    if (modelCallsIn(line).length > 0) n += 1;
  }
  return n;
}

/**
 * Violations for one file: a model call outside the allow-list, an allow-listed
 * file with no meter, or an allow-listed file whose endpoint lines changed.
 */
export function violationsFor(rel: string, src: string): string[] {
  if (rel === RECORDER) return [];
  const calls = modelCallsIn(src);
  const pinned = METERED_CALL_SITES.get(rel);
  const metered = pinned !== undefined || RECORDING_ROUTERS.has(rel);
  const takesMeter = USAGE_IMPORT_RE.test(stripComments(src));
  const out: string[] = [];
  if (calls.length > 0 && !metered) out.push(`${rel}: calls a model outside the metered call sites (${calls.join(", ")})`);
  if (metered && !takesMeter) out.push(`${rel}: is a metered call site but does not take its meter from lib/ai/usage.ts`);
  if (pinned !== undefined) {
    const lines = modelCallLines(src);
    if (lines !== pinned) {
      out.push(
        `${rel}: names a model endpoint on ${lines} line(s), pinned at ${pinned}. Put the new request through ` +
          `meter.begin() / call.finish() (or streamChat), then update the count in METERED_CALL_SITES.`,
      );
    }
  }
  return out;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SOURCE_EXT.test(name)) out.push(full);
  }
  return out;
}
const rel = (f: string) => f.slice(ROOT.length + 1).split(sep).join("/");

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${name}`);
    console.error(error);
  }
}

console.log("ai-usage-no-unmetered-calls:");

check("the matcher sees every endpoint and SDK form, and ignores comments, docs and non-model endpoints", () => {
  // Calls.
  assert.deepEqual(modelCallsIn(`await fetch("https://api.anthropic.com/v1/messages", {})`), ["Anthropic API", "an Anthropic-compatible model path"]);
  assert.ok(modelCallsIn("fetch(`https://api.openai.com/v1/responses`)").includes("OpenAI API"));
  assert.ok(modelCallsIn("const u = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;").includes("Google Gemini API"));
  assert.ok(modelCallsIn(`fetch("https://openrouter.ai/api/v1/chat/completions")`).includes("OpenRouter model API"));
  assert.ok(modelCallsIn("fetch(`${base}/chat/completions`)").includes("an OpenAI-compatible model path"));
  assert.ok(modelCallsIn("fetch(`${base}/v1/messages`)").includes("an Anthropic-compatible model path"));
  assert.deepEqual(modelCallsIn(`import Anthropic from "@anthropic-ai/sdk";`), ['SDK import "@anthropic-ai/sdk"']);
  assert.deepEqual(modelCallsIn(`import OpenAI from "openai";`), ['SDK import "openai"']);
  assert.deepEqual(modelCallsIn(`const { GoogleGenAI } = await import("@google/genai");`), ['SDK import "@google/genai"']);
  assert.deepEqual(modelCallsIn(`import { generateText } from "ai";`), ['SDK import "ai"']);
  assert.deepEqual(modelCallsIn(`import { anthropic } from "@ai-sdk/anthropic";`), ['SDK import "@ai-sdk/anthropic"']);
  // Not calls.
  assert.deepEqual(modelCallsIn(`// used to POST api.anthropic.com/v1/messages directly\nconst x = 1;`), []);
  assert.deepEqual(modelCallsIn(`/**\n * opens an api.anthropic.com/v1/messages stream\n */\nconst y = "POST /v1/messages — Anthropic API";`), []);
  assert.deepEqual(modelCallsIn(`fetch("https://openrouter.ai/api/v1/auth/key")`), [], "the key-info endpoint spends nothing");
  assert.deepEqual(modelCallsIn(`const hosts = ["openrouter.ai", "anthropic.com", "openai.com"];`), []);
  assert.deepEqual(modelCallsIn(`href="https://openrouter.ai/sign-up"`), []);
  assert.deepEqual(modelCallsIn(`import { ai } from "@/lib/ai/infer";`), []);
  // A "//" inside a string is not a comment.
  assert.ok(modelCallsIn(`const u = "https://api.openai.com/v1/chat/completions"; // note`).includes("OpenAI API"));
});

check("a PLANTED violation is caught: a new file calling a provider, and a metered site that dropped its meter", () => {
  const rogue = `export async function sneak(key: string) {\n  return fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key } });\n}\n`;
  const v1 = violationsFor("lib/rogue-helper.ts", rogue);
  assert.equal(v1.length, 1, v1.join("\n"));
  assert.match(v1[0], /lib\/rogue-helper\.ts: calls a model outside the metered call sites/);
  const sdk = violationsFor("app/api/x/route.ts", `import OpenAI from "openai";\nexport const c = new OpenAI();\n`);
  assert.equal(sdk.length, 1);
  // An allow-listed file that no longer takes a meter is caught too.
  const probe = readFileSync(join(ROOT, "lib/agents/provider-probe.ts"), "utf8");
  assert.deepEqual(violationsFor("lib/agents/provider-probe.ts", probe), [], "the real probe file passes");
  const unmetered = probe.replace(/^import type \{[^}]*\} from "@\/lib\/ai\/usage";\r?\n/m, "");
  assert.notEqual(unmetered, probe, "the planted edit did not change the file");
  assert.deepEqual(violationsFor("lib/agents/provider-probe.ts", unmetered), [
    "lib/agents/provider-probe.ts: is a metered call site but does not take its meter from lib/ai/usage.ts",
  ]);
  // A mention of the recorder in a comment is not a meter.
  assert.equal(
    violationsFor("lib/providers.ts", `// import from "@/lib/ai/usage"\nfetch("https://api.openai.com/v1/chat/completions")`).filter((v) => /does not take its meter/.test(v)).length,
    1,
  );
});

check("a PLANTED second, unmetered request inside an allow-listed file is caught, not waved through by the file's import", () => {
  const providers = readFileSync(join(ROOT, "lib/providers.ts"), "utf8");
  assert.deepEqual(violationsFor("lib/providers.ts", providers), [], "the real file passes");
  const sneaky =
    providers +
    `\nexport async function sneak(key: string) {\n  return fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key } });\n}\n`;
  const v = violationsFor("lib/providers.ts", sneaky);
  assert.equal(v.length, 1, v.join("\n"));
  assert.match(v[0], /^lib\/providers\.ts: names a model endpoint on \d+ line\(s\), pinned at \d+/);
  // An SDK import planted in the 3,000-line tool runner is caught the same way.
  const runner = readFileSync(join(ROOT, "lib/cloud-tool-runner.ts"), "utf8");
  assert.equal(violationsFor("lib/cloud-tool-runner.ts", `import OpenAI from "openai";\n${runner}`).length, 1);
  // One line naming two endpoint forms is one request.
  assert.equal(modelCallLines(`await fetch("https://api.anthropic.com/v1/messages", {})`), 1);
});

check("no file outside the metered call sites calls a model provider, and every metered site takes its meter", () => {
  const files = [
    ...SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...ROOT_FILES.map((f) => join(ROOT, f)).filter((f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    }),
  ];
  // Anti-vacuity: a broken walk would pass and prove nothing.
  assert.ok(files.length > 500, `only ${files.length} source files walked — the scan is broken`);
  const seen = new Set(files.map(rel));
  for (const site of [...METERED_CALL_SITES.keys(), ...RECORDING_ROUTERS, RECORDER]) {
    assert.ok(seen.has(site), `${site} is on the allow-list but was not found: update the list`);
  }
  const violations: string[] = [];
  let callingFiles = 0;
  for (const file of files) {
    const r = rel(file);
    const src = readFileSync(file, "utf8");
    if (modelCallsIn(src).length > 0) callingFiles += 1;
    violations.push(...violationsFor(r, src));
  }
  // The allow-listed sites really do call providers, so the matcher really matches.
  assert.ok(callingFiles >= METERED_CALL_SITES.size, `only ${callingFiles} files call a model: the matcher is broken`);
  for (const site of METERED_CALL_SITES.keys()) {
    assert.ok(modelCallsIn(readFileSync(join(ROOT, site), "utf8")).length > 0, `${site} no longer calls a model: drop it from the allow-list`);
  }
  assert.equal(
    violations.length,
    0,
    `Unmetered model calls (${violations.length}):\n  ${violations.join("\n  ")}\n\n` +
      `Every model call takes a ModelCallMeter (lib/ai/usage.ts modelCallMeter, from the tenant you already\n` +
      `resolved) and goes through meter.begin() / call.finish(), or through lib/providers.ts streamChat,\n` +
      `which does. Add a new call site to METERED_CALL_SITES only with a test in tests/ai-usage-ledger.test.ts.`,
  );
});

/** USAGE_SURFACES, read from lib/ai/usage.ts's source (this lint imports nothing it checks). */
function knownSurfaces(): Set<string> {
  const src = readFileSync(join(ROOT, RECORDER), "utf8");
  const block = /export const USAGE_SURFACES = \[([\s\S]*?)\] as const;/.exec(src);
  assert.ok(block, "USAGE_SURFACES was not found in lib/ai/usage.ts");
  return new Set([...block[1].matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]));
}

/**
 * Surface names a file that takes its meter writes as a literal (`surface: "x"`)
 * that the ledger does not know. A misspelt surface would be refused by the
 * meter at run time (and the call it meters would fail with it); this finds it
 * in the tree instead.
 */
export function unknownSurfacesIn(src: string, known: Set<string>): string[] {
  const code = stripComments(src);
  if (!USAGE_IMPORT_RE.test(code)) return [];
  return [...code.matchAll(/\bsurface: "([^"]+)"/g)]
    .map((m) => m[1])
    // A usage surface is a dotted lowercase name; prose in a field that happens
    // to be called surface (a model's API name in the registry) is something else.
    .filter((s) => /^(?:[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)*|infer:.*)$/.test(s))
    .filter((s) => !known.has(s) && !/^infer:[A-Za-z0-9_.:-]{1,100}$/.test(s));
}

check("every surface a metered file names is one the ledger knows, the automation surfaces included; a PLANTED misspelling is caught", () => {
  const known = knownSurfaces();
  for (const s of ["agents.chat", "automations.run", "automations.draft", "tools.repurpose_post"]) assert.ok(known.has(s), `${s} is not in USAGE_SURFACES`);
  const planted = `import { modelCallMeter } from "@/lib/ai/usage";\nexport const m = (t: string) => modelCallMeter({ tenantId: t, surface: "automation.run", authKind: "api_key", billingMode: "byo_key" });\n`;
  assert.deepEqual(unknownSurfacesIn(planted, known), ["automation.run"]);
  // A file that takes no meter may use the word for something else (a health check's surface).
  assert.deepEqual(unknownSurfacesIn(`const x = { surface: "oasis" };`, known), []);
  assert.deepEqual(unknownSurfacesIn(`import type { X } from "@/lib/ai/usage";\nconst api = { surface: "Anthropic's Messages API" };`, known), []);
  assert.deepEqual(unknownSurfacesIn(`import type { X } from "@/lib/ai/usage";\nconst m = { surface: "infer:" };`, known), ["infer:"]);
  const files = SOURCE_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const bad: string[] = [];
  let named = 0;
  for (const file of files) {
    const src = readFileSync(file, "utf8");
    if (USAGE_IMPORT_RE.test(stripComments(src))) named += [...stripComments(src).matchAll(/\bsurface: "([^"]+)"/g)].length;
    for (const s of unknownSurfacesIn(src, known)) bad.push(`${rel(file)}: surface "${s}"`);
  }
  assert.ok(named >= 5, `only ${named} surface literals found in metered files: the scan is broken`);
  assert.deepEqual(bad, [], `surfaces the ledger does not know:\n  ${bad.join("\n  ")}`);
});

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("ai usage lint gate passed");
