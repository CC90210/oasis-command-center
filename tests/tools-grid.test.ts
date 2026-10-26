/**
 * tests/tools-grid.test.ts - the Tools section as a person sees it
 * (components/tools/ToolGrid.tsx and its pure helpers in
 * components/tools/tool-grid-format.ts).
 *
 * Pins:
 *   - every status, count and refusal reads in plain words (the helpers);
 *   - the card's lifecycle (2026-10-26) is a pure function of the runs: every
 *     run in flight shows, every finished run shows until its own Done, Done
 *     puts away exactly that run (by id, per workspace), never one in flight;
 *   - the server render draws ONLY the catalog's cards: no Run button on a card
 *     that needs an AI account (the connect line and Open Settings instead),
 *     no Download card without a live runner, one line when the tools are not
 *     set up; the panels drawn with real runs carry the right buttons and links;
 *   - nothing in the first render depends on the clock (no time, no "min ago"):
 *     the server's markup and the browser's first paint are the same;
 *   - every control is a 44 px touch target on phones, in the panels too;
 *   - no internal name (an agent persona, a vendor, a table) on the screen.
 *
 * The states themselves (Done, polling, retries, offline) are driven in a real
 * browser by tests/tools-grid.browser.py.
 *
 * Run: node --conditions=react-server --import tsx tests/tools-grid.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  AI_UNREADABLE,
  CHECK_CONNECTION,
  CONNECT_AI,
  DONE_IDS_CAP,
  HISTORY_LIMIT,
  NOT_SET_UP,
  RUN_STOPPED,
  RUNNER_OFFLINE,
  cardPhase,
  charsText,
  doneHint,
  doneIdsKey,
  historyLabel,
  isInFlight,
  liveRuns,
  parseDoneIds,
  refusalLine,
  rememberDone,
  resultTitle,
  reviewHeadline,
  runTime,
  runTimeoutMs,
  runsOnText,
  seenLine,
  statusLabel,
  urlFieldLine,
  variantLines,
  withRun,
} from "../components/tools/tool-grid-format";
import { TOOL_REGISTRY, type ToolKey } from "../lib/tools/registry";
import type { CatalogTool, JobView, ToolCatalog } from "../lib/tools/types";

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

/** One run as the jobs route answers it. */
function job(id: string, status: JobView["status"], created_at: string, extra: Partial<JobView> = {}): JobView {
  return {
    id,
    tool_key: "video_download",
    status,
    stage: null,
    created_at,
    updated_at: created_at,
    finished_at: null,
    input_summary: `https://www.youtube.com/watch?v=${id}`,
    result: null,
    error_code: null,
    error_message: null,
    asset_id: null,
    ...extra,
  };
}

type Panel = { id: string; kind: "review" | "running" | "history"; jobs: JobView[]; toolKey: ToolKey; runsOn: "worker" | "runner"; showCodes?: boolean; canRetry?: boolean };

function renderMarkup(cases: Array<{ id: string; catalog: ToolCatalog; showCodes?: boolean }>, panels: Panel[] = []): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/tools-grid.render.ts"], {
    cwd: root,
    input: JSON.stringify({ cases, panels }),
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
const links = (html: string) => [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((m) => [m[2].replace(/<[^>]+>/g, "").trim(), m[1]]);
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

  await check("numbers and lines: characters, over the limit, the runner, seen", () => {
    assert.equal(charsText(600, 500), "600 of 500 characters");
    assert.deepEqual(variantLines({ chars: 600, max_chars: 500, over_limit: true }), ["600 of 500 characters", "Over the limit"]);
    assert.deepEqual(variantLines({ chars: 10, max_chars: 500, over_limit: false }), ["10 of 500 characters"]);
    assert.equal(runsOnText("CC's PC"), "Runs on CC's PC");
    // The runner's "seen" line speaks the one time-ago vocabulary (lib/devices/presence.ts timeAgo).
    const now = Date.parse("2026-10-17T12:00:00Z");
    const seenAt = (ms: number) => new Date(now - ms).toISOString();
    assert.equal(seenLine(seenAt(3.7 * 60_000), now), "seen 3 min ago");
    assert.equal(seenLine(seenAt(-120_000), now), "seen just now", "a check-in slightly ahead of this clock is not '0 min ago'");
    assert.equal(seenLine(seenAt(75 * 60_000), now), "seen 1 h ago", "past the hour it says hours, not '75 min ago'");
    assert.equal(seenLine("not a time", now), null);
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

  await check("the card's lifecycle (2026-10-26): every run in flight and every finished run until its own Done; Done puts away by id, never a run in flight", () => {
    const older = job("a", "done", "2026-10-25T10:00:00.000Z", { asset_id: "asset-a", result: { asset_id: "asset-a", title: "  The video  ", platform: "youtube" } });
    const failed = job("b", "failed", "2026-10-25T11:00:00.000Z", { error_code: "download_failed", error_message: "That link couldn't be downloaded." });
    const running = job("c", "running", "2026-10-25T12:00:00.000Z", { stage: "downloading" });
    const newest = job("d", "done", "2026-10-25T13:00:00.000Z", { asset_id: "asset-d" });

    // Nothing put away: every run is live. A finished run shows even while another is in flight.
    assert.deepEqual(liveRuns([newest, running, failed, older], []).map((j) => j.id), ["d", "c", "b", "a"]);
    assert.equal(cardPhase([]), "idle");
    assert.equal(cardPhase([running]), "running");
    assert.equal(cardPhase([running, newest]), "review", "a finished run waiting for Done is never hidden behind one in flight");
    assert.equal(cardPhase([newest]), "review");
    assert.equal(cardPhase([failed]), "review");
    // Done on the newest puts away exactly that run: the older failure still waits for its own Dismiss.
    assert.deepEqual(liveRuns([newest, running, failed, older], ["d"]).map((j) => j.id), ["c", "b", "a"]);
    assert.deepEqual(liveRuns([newest, running, failed, older], ["d", "b", "a"]).map((j) => j.id), ["c"], "only the run in flight is left");
    assert.equal(cardPhase(liveRuns([newest, running, failed, older], ["d", "b", "a"])), "running");
    assert.deepEqual(liveRuns([running], ["c"]).map((j) => j.id), ["c"], "a run in flight is never put away, whatever is stored");
    assert.deepEqual(liveRuns([failed, older], ["b", "a"]), []);
    assert.equal(cardPhase(liveRuns([failed, older], ["b", "a"])), "idle");

    // What the card remembers, and how.
    assert.equal(doneIdsKey("video_download", "tenant-1"), "oasis:tools:tenant-1:video_download:done-ids");
    assert.equal(doneIdsKey("video_download", ""), "oasis:tools:shared:video_download:done-ids");
    assert.notEqual(doneIdsKey("video_download", "tenant-1"), doneIdsKey("video_download", "tenant-2"), "two workspaces on one browser never share it");
    assert.deepEqual(parseDoneIds(null), []);
    assert.deepEqual(parseDoneIds("not json"), []);
    assert.deepEqual(parseDoneIds('{"a":1}'), []);
    assert.deepEqual(parseDoneIds('["a", 7, "b"]'), ["a", "b"], "junk entries are dropped, the rest kept");
    assert.deepEqual(rememberDone([], "a"), ["a"]);
    assert.deepEqual(rememberDone(["a", "b"], "a"), ["b", "a"], "once, moved to the newest end");
    assert.equal(rememberDone(Array.from({ length: DONE_IDS_CAP + 5 }, (_, i) => `r${i}`), "z").length, DONE_IDS_CAP);
    assert.equal(rememberDone(Array.from({ length: DONE_IDS_CAP + 5 }, (_, i) => `r${i}`), "z").at(-1), "z", "the newest is kept");
    assert.equal(withRun([newest, older], running).map((j) => j.id).join(","), "c,d,a", "an accepted run leads, never twice");
    assert.equal(withRun(Array.from({ length: HISTORY_LIMIT + 3 }, (_, i) => job(`h${i}`, "done", "2026-10-25T09:00:00.000Z")), running).length, HISTORY_LIMIT);

    // The words, and how long a run request may take.
    assert.equal(reviewHeadline(newest, "video_download"), "Video extracted");
    assert.equal(reviewHeadline(newest, "learn_from_link"), "Finished");
    assert.equal(reviewHeadline(failed, "video_download"), "Didn't finish");
    assert.equal(reviewHeadline({ status: "cancelled" as never }, "video_download"), "Didn't finish", "only done is a success");
    assert.equal(resultTitle(older), "The video", "the video's own title, trimmed");
    assert.equal(resultTitle(newest), null, "no title in the result, so the card shows the link");
    assert.equal(resultTitle(job("e", "done", "2026-10-25T10:00:00.000Z", { result: { title: 7 } })), null);
    assert.equal(historyLabel("video_download"), "Extracted videos");
    assert.equal(historyLabel("learn_from_link"), "Recent runs");
    assert.equal(doneHint("video_download", false), "Done clears this result. The video stays in Extracted videos.");
    assert.equal(doneHint("video_download", true), "Dismiss clears this result. The failed run stays listed below.");
    assert.equal(doneHint("learn_from_link", false), "Done clears this result.", "no promise the drawer cannot keep");
    assert.ok(runTimeoutMs("worker") > 60_000, "a worker tool runs inside the request, which the route allows 60 s");
    assert.ok(runTimeoutMs("runner") <= 30_000, "a runner tool's request only inserts a row");
  });

  const full: ToolCatalog = {
    installed: true,
    tools: [card("repurpose_post"), card("learn_from_link"), card("video_download", "ready", { label: "CC's PC", lastSeenAt: "2026-10-09T01:00:00.000Z" })],
  };
  const noAi: ToolCatalog = { installed: true, tools: [card("repurpose_post", "needs_ai_account"), card("learn_from_link", "needs_ai_account")] };
  const unreadable: ToolCatalog = { installed: true, tools: [card("repurpose_post", "ai_account_unreadable"), card("learn_from_link", "ai_account_unreadable")] };
  const doneVideo = job("v1", "done", "2026-10-25T10:00:00.000Z", { asset_id: "asset-v1", result: { asset_id: "asset-v1", title: "A reel worth keeping", platform: "instagram" } });
  const failedVideo = job("v2", "failed", "2026-10-25T11:00:00.000Z", { error_code: "download_failed", error_message: "That link couldn't be downloaded." });
  const learned = job("l1", "done", "2026-10-25T12:00:00.000Z", {
    tool_key: "learn_from_link",
    input_summary: "https://www.linkedin.com/posts/someone_activity-1",
    result: { analysis: { hook: "Opens on the number", pacing: ["short", "then long"], steal: "The number first" }, label: "exemplar" },
  });
  const markup = renderMarkup(
    [
      { id: "full", catalog: full },
      { id: "noAi", catalog: noAi },
      { id: "unreadable", catalog: unreadable },
      { id: "notSetUp", catalog: { installed: false } },
      { id: "offline", catalog: { installed: true, tools: [card("video_download", "runner_offline")] } },
    ],
    [
      { id: "review_video", kind: "review", jobs: [doneVideo], toolKey: "video_download", runsOn: "runner" },
      { id: "review_failed", kind: "review", jobs: [failedVideo], toolKey: "video_download", runsOn: "runner", showCodes: true },
      { id: "review_failed_client", kind: "review", jobs: [failedVideo], toolKey: "video_download", runsOn: "runner", showCodes: false },
      { id: "review_learn", kind: "review", jobs: [learned], toolKey: "learn_from_link", runsOn: "worker" },
      { id: "running", kind: "running", jobs: [job("q1", "queued", "2026-10-25T13:00:00.000Z"), job("r1", "running", "2026-10-25T12:30:00.000Z", { stage: "uploading" })], toolKey: "video_download", runsOn: "runner" },
      { id: "history", kind: "history", jobs: [doneVideo, failedVideo], toolKey: "video_download", runsOn: "runner" },
      { id: "history_learn", kind: "history", jobs: [learned], toolKey: "learn_from_link", runsOn: "worker" },
    ],
  );

  await check("every catalog card is drawn, each with its Run button, and nothing else", () => {
    const html = markup.full;
    assert.equal(articles(html), 3);
    // The first render knows no runs, so every ready card is idle: its form and its Run button, nothing else.
    assert.deepEqual(buttons(html), ["Repurpose", "Learn", "Extract video"]);
    assert.ok(/<article[^>]*\bdata-phase="idle"/.test(html), "a ready card starts idle");
    assert.ok(/<article[^>]*\bid="video-extractor"/.test(html), "the Video extractor card carries the anchor the Extracted videos page links back to");
    for (const t of full.installed ? full.tools : []) assert.ok(decode(html).includes(t.title), t.title);
    assert.ok(decode(html).includes("Runs on CC's PC"), "the runner is named");
    assert.ok(html.includes(">Tools<"), "the section heading");
  });

  await check("the panels with real runs: a finished video (Download, Open, Done), a failure (Try again, Dismiss, the code for founders only), a learned link, runs in flight, the drawer", () => {
    assert.deepEqual(buttons(markup.review_video), ["Done"]);
    assert.deepEqual(links(markup.review_video), [
      ["Download", "/api/founders/marketing/assets/asset-v1/download"],
      ["Open in Extracted videos", "/founders/marketing/extracted?video=asset-v1"],
    ]);
    assert.ok(decode(markup.review_video).includes("Video extracted"));
    assert.ok(decode(markup.review_video).includes("A reel worth keeping"), "the video's own title");
    assert.ok(decode(markup.review_video).includes("The video stays in Extracted videos."));
    assert.deepEqual(buttons(markup.review_failed), ["Try again", "Dismiss"]);
    assert.deepEqual(links(markup.review_failed), [], "nothing to download from a failure");
    assert.ok(decode(markup.review_failed).includes("Didn't finish"));
    assert.ok(decode(markup.review_failed).includes("That link couldn't be downloaded."));
    assert.ok(markup.review_failed.includes("download_failed"), "founders see the code");
    assert.ok(!markup.review_failed_client.includes("download_failed"), "a client workspace never does");
    assert.deepEqual(buttons(markup.review_learn), ["Done"]);
    assert.ok(decode(markup.review_learn).includes("Finished"));
    assert.ok(decode(markup.review_learn).includes("Opens on the number"), "the analysis is shown");
    assert.ok(decode(markup.review_learn).includes("short / then long"));
    assert.ok(decode(markup.review_learn).includes("Saved to Training material."));
    assert.ok(!decode(markup.review_learn).includes("stays listed below"), "no promise the drawer cannot keep");
    const running = decode(markup.running);
    assert.equal((markup.running.match(/<li\b/g) ?? []).length, 2, "every run in flight is listed");
    assert.ok(running.includes("Waiting") && running.includes("Uploading"), "each at its own stage");
    assert.deepEqual(buttons(markup.running), [], "the Refresh button sits outside the live region");
    const history = decode(markup.history);
    assert.ok(history.includes(">Extracted videos<"), "the Video extractor's drawer is its Extracted videos");
    assert.ok(!/>Done</.test(markup.history), "no status word on a finished row: 'Done' in a list is the word CC read as a locked button");
    assert.ok(history.includes(">Failed<"), "a failed row still says so");
    assert.deepEqual(links(markup.history), [
      ["Download", "/api/founders/marketing/assets/asset-v1/download"],
      ["Open in Extracted videos", "/founders/marketing/extracted?video=asset-v1"],
      ["All extracted videos", "/founders/marketing/extracted"],
    ]);
    assert.ok(decode(markup.history_learn).includes(">Recent runs<"));
    assert.deepEqual(links(markup.history_learn), [], "a learned link has nothing to open, and no Extracted videos link");
  });

  await check("needs an AI account: the connect line and Open Settings, NO fields and NO Run button; no Download card without a runner", () => {
    const html = decode(markup.noAi);
    assert.equal(articles(markup.noAi), 2);
    assert.deepEqual(buttons(markup.noAi), [], "no tool here can run without an account");
    assert.equal(html.split(CONNECT_AI).length - 1, 2);
    assert.equal((markup.noAi.match(/href="\/settings\/ai#providers"/g) ?? []).length, 2);
    assert.ok(!html.includes("Download a video"));
    assert.ok(!/<textarea[^>]*id="tool-repurpose_post-post"/.test(markup.noAi), "no field for a tool that cannot run");
    const u = decode(markup.unreadable);
    assert.deepEqual(buttons(markup.unreadable), []);
    assert.equal(u.split(AI_UNREADABLE).length - 1, 2);
    assert.ok(!u.includes("Open Settings"), "an unreadable account is not a missing one");
  });

  await check("runner offline (2026-10-17): the Video extractor card stays and says so, with NO field and NO Run button", () => {
    const html = decode(markup.offline);
    assert.equal(articles(markup.offline), 1);
    assert.ok(html.includes("Video extractor"));
    assert.ok(html.includes(RUNNER_OFFLINE), "the offline line");
    // Check connection asks the page to re-read (a window event, no router in the grid); it is the only button.
    assert.deepEqual(buttons(markup.offline), [CHECK_CONNECTION], "Check connection and no Run button");
    assert.ok(!/<input[^>]*id="tool-video_download-url"/.test(markup.offline), "no link field while offline");
    assert.ok(/<article[^>]*\bdata-phase="runner_offline"/.test(markup.offline));
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

  await check("every control is a 44 px touch target (min-h-11), in the panels and the drawer too", () => {
    for (const [id, html] of Object.entries(markup)) {
      for (const m of html.matchAll(/<(button|input|select|textarea|a)\b[^>]*>/g)) {
        assert.match(m[0], /\bmin-h-11\b/, `${id}: ${m[0].slice(0, 120)}`);
      }
    }
    assert.ok((markup.history.match(/<a\b/g) ?? []).length === 3 && (markup.review_failed.match(/<button\b/g) ?? []).length === 2, "not vacuous: the panels carry controls");
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
