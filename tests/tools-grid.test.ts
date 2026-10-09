/**
 * tests/tools-grid.test.ts - the Tools section as a person sees it
 * (components/tools/ToolGrid.tsx and its pure helpers in
 * components/tools/tool-grid-format.ts).
 *
 * Pins:
 *   - every status, count and refusal reads in plain words (the helpers);
 *   - the server render draws ONLY the catalog's cards: no Run button on a card
 *     that needs an AI account (the connect line and Open Settings instead),
 *     no Download card without a live runner, one line when the tools are not
 *     set up;
 *   - nothing in the first render depends on the clock (no time, no "min ago"):
 *     the server's markup and the browser's first paint are the same;
 *   - every control is a 44 px touch target on phones;
 *   - no internal name (an agent persona, a vendor, a table) on the screen.
 *
 * Run: node --conditions=react-server --import tsx tests/tools-grid.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AI_UNREADABLE,
  CONNECT_AI,
  NOT_SET_UP,
  RUN_STOPPED,
  charsText,
  hardFailLine,
  isInFlight,
  refusalLine,
  runTime,
  runsOnText,
  scoreText,
  seenText,
  statusLabel,
  urlFieldLine,
  variantLines,
} from "../components/tools/tool-grid-format";
import { TOOL_REGISTRY } from "../lib/tools/registry";
import type { CatalogTool, ToolCatalog } from "../lib/tools/types";

const root = join(__dirname, "..");

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

function card(key: string, state: CatalogTool["state"] = "ready", runner?: CatalogTool["runner"]): CatalogTool {
  const t = TOOL_REGISTRY.find((x) => x.key === key)!;
  return { key: t.key, title: t.title, description: t.description, runLabel: t.runLabel, runsOn: t.runsOn, fields: t.fields, state, ...(runner ? { runner } : {}) };
}

function renderMarkup(cases: Array<{ id: string; catalog: ToolCatalog; showCodes?: boolean }>): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/tools-grid.render.ts"], {
    cwd: root,
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    // CI sets NODE_OPTIONS=--conditions=react-server for the whole step;
    // react-dom/server refuses to load under it, so the child drops it.
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { markup: Record<string, string> }).markup;
}

const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const articles = (html: string) => (html.match(/<article\b/g) ?? []).length;
const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<");

async function main() {
  console.log("tools grid:");

  await check("statuses in plain words: Waiting, Downloading, Uploading, Working, Done, Failed", () => {
    const s = (status: string, stage: string | null, runsOn: "worker" | "runner") => statusLabel({ status: status as never, stage }, runsOn);
    assert.equal(s("queued", null, "runner"), "Waiting");
    assert.equal(s("claimed", null, "runner"), "Downloading");
    assert.equal(s("running", "downloading", "runner"), "Downloading");
    assert.equal(s("running", "uploading", "runner"), "Uploading");
    assert.equal(s("running", null, "worker"), "Working");
    assert.equal(s("done", null, "runner"), "Done");
    assert.equal(s("failed", null, "worker"), "Failed");
    assert.deepEqual(["queued", "claimed", "running", "done", "failed"].map((x) => isInFlight({ status: x as never })), [true, true, true, false, false]);
  });

  await check("numbers and lines: score, characters, over the limit, the runner, hard fails", () => {
    assert.equal(scoreText(92.6), "Score 92.6%");
    assert.equal(charsText(600, 500), "600 of 500 characters");
    assert.deepEqual(variantLines({ chars: 600, max_chars: 500, over_limit: true }), ["600 of 500 characters", "Over the limit"]);
    assert.deepEqual(variantLines({ chars: 10, max_chars: 500, over_limit: false }), ["10 of 500 characters"]);
    assert.equal(runsOnText("CC's PC"), "Runs on CC's PC");
    assert.equal(seenText(3.7), "seen 3 min ago");
    assert.equal(seenText(-2), "seen 0 min ago");
    assert.equal(hardFailLine("preamble"), "Opens with a greeting or preamble.");
    assert.equal(hardFailLine("hashtags"), "More than 5 hashtags.");
  });

  await check("a run's time is the viewer's own clock, formatted on the client", () => {
    assert.equal(runTime("2026-10-09T01:02:03.000Z", "en-US", "UTC"), "1:02 AM");
    assert.equal(runTime("2026-10-09T01:02:03.000Z", "en-US", "America/Toronto"), "9:02 PM");
    assert.equal(runTime("not a time"), "");
  });

  await check("URL field and refusal lines", () => {
    assert.equal(urlFieldLine("video_download", "unsupported_url"), "That link can't be downloaded. Paste the post's own link.");
    assert.equal(urlFieldLine("video_download", "invalid_url"), "That link can't be downloaded. Paste the post's own link.");
    assert.equal(urlFieldLine("learn_from_link", "video_link_not_supported"), "Video links can't be read here.");
    assert.equal(urlFieldLine("learn_from_link", "invalid_url"), "Couldn't open that link.");
    assert.equal(urlFieldLine("learn_from_link", "required"), null);
    assert.equal(refusalLine(409, { ok: false, error: "runner_offline", message: "The computer that runs downloads was offline, so this didn't run." }), "The computer that runs downloads was offline, so this didn't run.");
    assert.equal(refusalLine(429, { ok: false, error: "too_many_in_flight", message: "Five downloads are already in progress." }), "Five downloads are already in progress.");
    assert.equal(refusalLine(503, { ok: false, error: "not_set_up" }), NOT_SET_UP);
    assert.equal(refusalLine(500, { ok: false, error: "run_failed", message: "stack trace here" }), RUN_STOPPED, "a server error's text is never shown");
    assert.equal(refusalLine(0, null), RUN_STOPPED);
  });

  const full: ToolCatalog = {
    installed: true,
    tools: [card("score_hook"), card("repurpose_post"), card("learn_from_link"), card("video_download", "ready", { label: "CC's PC", lastSeenMinutes: 3 })],
  };
  const noAi: ToolCatalog = { installed: true, tools: [card("score_hook"), card("repurpose_post", "needs_ai_account"), card("learn_from_link", "needs_ai_account")] };
  const unreadable: ToolCatalog = { installed: true, tools: [card("score_hook"), card("repurpose_post", "ai_account_unreadable"), card("learn_from_link", "ai_account_unreadable")] };
  const markup = renderMarkup([
    { id: "full", catalog: full },
    { id: "noAi", catalog: noAi },
    { id: "unreadable", catalog: unreadable },
    { id: "notSetUp", catalog: { installed: false } },
  ]);

  await check("every catalog card is drawn, each with its Run button, and nothing else", () => {
    const html = markup.full;
    assert.equal(articles(html), 4);
    assert.deepEqual(buttons(html), ["Score", "Repurpose", "Learn", "Download"]);
    for (const t of full.installed ? full.tools : []) assert.ok(decode(html).includes(t.title), t.title);
    assert.ok(decode(html).includes("Runs on CC's PC"), "the runner is named");
    assert.ok(html.includes(">Tools<"), "the section heading");
  });

  await check("needs an AI account: the connect line and Open Settings, NO fields and NO Run button; no Download card without a runner", () => {
    const html = decode(markup.noAi);
    assert.equal(articles(markup.noAi), 3);
    assert.deepEqual(buttons(markup.noAi), ["Score"], "only the tool that can run has a button");
    assert.equal(html.split(CONNECT_AI).length - 1, 2);
    assert.equal((markup.noAi.match(/href="\/settings\/ai"/g) ?? []).length, 2);
    assert.ok(!html.includes("Download a video"));
    assert.ok(!/<textarea[^>]*id="tool-repurpose_post-post"/.test(markup.noAi), "no field for a tool that cannot run");
    const u = decode(markup.unreadable);
    assert.deepEqual(buttons(markup.unreadable), ["Score"]);
    assert.equal(u.split(AI_UNREADABLE).length - 1, 2);
    assert.ok(!u.includes("Open Settings"), "an unreadable account is not a missing one");
  });

  await check("not set up: one line, no cards", () => {
    assert.equal(articles(markup.notSetUp), 0);
    assert.ok(decode(markup.notSetUp).includes(NOT_SET_UP));
    assert.deepEqual(buttons(markup.notSetUp), []);
  });

  await check("nothing in the first render depends on the clock", () => {
    for (const [id, html] of Object.entries(markup)) {
      assert.ok(!/min ago/.test(html), `${id}: no "seen n min ago" before mount`);
      assert.ok(!/\b\d{1,2}:\d{2}\b/.test(html), `${id}: no time of day before mount`);
    }
  });

  await check("every control is a 44 px touch target (min-h-11)", () => {
    for (const [id, html] of Object.entries(markup)) {
      for (const m of html.matchAll(/<(button|input|select|textarea|a)\b[^>]*>/g)) {
        assert.match(m[0], /\bmin-h-11\b/, `${id}: ${m[0].slice(0, 120)}`);
      }
    }
  });

  await check("no internal name on the screen", () => {
    for (const [id, html] of Object.entries(markup)) {
      assert.ok(!/maven|bravo|atlas|turso|libsql|tool_jobs|bea\b|r2\b/i.test(decode(html).replace(/<[^>]+>/g, " ")), `${id} names something internal`);
    }
  });

  console.log(failures ? `tools grid: ${failures} failure(s)` : "tools grid: all passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
