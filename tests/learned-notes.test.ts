/**
 * tests/learned-notes.test.ts - the Agent training page shows what it has learned,
 * and says honestly what happens to it.
 *
 * The page was one card and nothing else: after pressing Learn there was nowhere
 * to see the result. The notes are marketing_corpus rows (the same ones Content >
 * Training lists). What this pins:
 *
 *   1. the summary and intent wording the list reads in;
 *   2. a failed read is said plainly, never "nothing learned yet";
 *   3. the footer says what an agent does with its notes, which is now true: each note
 *      trains one agent (or all), and that agent reads its newest ones before it answers
 *      (tests/per-agent-training.test.ts pins the reader);
 *   4. the page does its reads behind a guard, so one failing read is "degraded",
 *      not a crashed page;
 *   5. the tool card says why Learn is off while its one field is empty.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

async function main(): Promise<void> {
  const { learnedSummary, intentLabel, TRAINING_HREF } = await import("../components/tools/LearnedNotes");
  const base = { total: 0, queued: 0, extracting: 0, indexed: 0, failed: 0, exemplars: 0, counter_examples: 0, degraded: false };

  assert.equal(learnedSummary({ ...base, total: 3, indexed: 3 }), "3 learned");
  assert.equal(learnedSummary({ ...base, total: 6, indexed: 3, queued: 1, extracting: 1 }), "3 learned · 2 being read");
  assert.equal(learnedSummary({ ...base, total: 5, indexed: 3, failed: 2 }), "3 learned · 2 couldn't be read");
  assert.equal(
    learnedSummary({ ...base, total: 9, indexed: 4, queued: 2, extracting: 1, failed: 2 }),
    "4 learned · 3 being read · 2 couldn't be read",
  );
  assert.equal(intentLabel("exemplar"), "Do more of this");
  assert.equal(intentLabel("counter_example"), "Never do this");
  assert.equal(intentLabel("neutral"), null);
  assert.equal(TRAINING_HREF, "/founders/marketing/train", "links to where the same notes are listed in full");
  console.log("  ok - the summary and intent wording read in plain words");

  const component = read("components/tools/LearnedNotes.tsx");
  assert.match(component, /stats\.degraded[\s\S]{0,260}Couldn&apos;t read the training material, so this is not an empty list/, "a failed count is said, not shown as zero");
  assert.match(component, /items\.degraded[\s\S]{0,260}the list did not load/, "a failed list is said, not shown as empty");
  assert.match(component, /Nothing learned yet\./, "a genuinely empty corpus says so");
  assert.match(component, /Before it answers, an agent reads its \{TRAINING_NOTES_MAX\} newest notes as examples of how to write/, "the footer says what the agent does with them");
  assert.match(component, /They never change what it is allowed to do\./, "and what it does not");
  assert.match(component, /Trains: \{trainsLabel\(row\.trains/, "each row says which agent it trains");
  const { rowsFor } = await import("../components/tools/LearnedNotes");
  const r = (id: string, trains: string | null) => ({ id, kind: "link", label: "exemplar", title: id, source_url: null, state: "indexed", last_error: null, contributed_by: "cc", created_at: "2026-10-15T12:00:00.000Z", indexed_at: null, trains });
  const all = [r("a", "sales"), r("b", "all"), r("c", null), r("d", "finance")];
  assert.deepEqual(rowsFor(all, "sales").map((x) => x.id), ["a", "b"], "an agent's tab lists what that agent reads");
  assert.deepEqual(rowsFor(all, "marketing").map((x) => x.id), ["b", "c"], "Marketing also reads the older notes");
  assert.deepEqual(rowsFor(all, null).map((x) => x.id), ["a", "b", "c", "d"], "All agents lists every note");
  assert.match(component, /ingestStateCopy/, "state wording comes from the one shared function (Training uses it too)");
  assert.match(component, /last_error\.slice\(0, 160\)/, "a failed row's reason is shown, bounded");
  console.log("  ok - failed reads and an empty list are told apart, each row names its agent, and the footer says what happens");

  const page = read("app/admin/agent-training/page.tsx");
  assert.match(page, /await requireOperator\(\);/, "still gated first");
  assert.match(page, /getCorpusStats\(tenantId\)/);
  assert.match(page, /getCorpusItems\(tenantId, ITEMS_READ\)/);
  assert.match(page, /<AgentTabs current=\{agent\} \/>/, "the page asks which agent is being trained");
  assert.match(page, /fieldDefaults=\{\{ learn_from_link: \{ trains: agent \?\? TRAINS_ALL \} \}\}/, "and starts the Learn form on that agent");
  assert.match(page, /key=\{agent \?\? TRAINS_ALL\}/, "a new tab starts the form again");
  assert.match(page, /async function safely/, "a rejected read becomes degraded instead of a crashed page");
  assert.match(page, /\{ \.\.\.EMPTY_CORPUS_STATS, degraded: true \}/);
  assert.match(page, /<LearnedNotes stats=\{stats\} items=\{items\} agent=\{agent\} \/>/);
  assert.ok(page.indexOf("requireOperator()") < page.indexOf("getCorpusStats("), "the gate runs before any read");
  console.log("  ok - the page is gated first and degrades a failed read");

  // Codex review of #612: the history reads must not hold back the Learn control, and a
  // finished run must make the list re-read.
  const body = page.slice(page.indexOf("export default async function AgentTrainingPage"));
  assert.doesNotMatch(body, /getCorpus(Stats|Items)\(/, "the page body awaits no corpus read: they live in the Suspense child");
  assert.match(body, /<Suspense[\s\S]*<LearnedNotesLoader tenantId=\{founder\.tenantId\} agent=\{agent\} \/>[\s\S]*<\/Suspense>/);
  assert.ok(body.indexOf("<ToolsSection") < body.indexOf("<Suspense"), "the Learn control is drawn before the streamed list");
  const refresher = read("components/tools/RefreshOnToolRun.tsx");
  assert.match(refresher, /addEventListener\(TOOL_RUN_FINISHED_EVENT/);
  assert.match(refresher, /router\.refresh\(\)/);
  assert.match(body, /<RefreshOnToolRun \/>/, "the page mounts the listener");
  console.log("  ok - the list streams behind Suspense and re-reads when a run finishes");

  const grid = read("components/tools/ToolGrid.tsx");
  assert.match(grid, /data-testid=\{`tool-\$\{tool\.key\}-needs-input`\}/);
  assert.match(grid, /!\(values\[validation\.field\] \?\? ""\)\.trim\(\)/, "the hint shows only while the field is empty");
  assert.match(grid, /to turn \$\{tool\.runLabel\} on/);
  assert.match(grid, /window\.dispatchEvent\(new CustomEvent\(TOOL_RUN_FINISHED_EVENT/, "a settled run announces itself");
  assert.match(grid, /if \(!wasInFlight\.current\) return;/, "a mount with no run in flight announces nothing");
  console.log("  ok - a disabled Learn button says which field it is waiting for");

  // The counts and the "newest N of M" footer never present a read's cap as a
  // total, and the footer shows whenever the list is partial (2026-10-26, review of #739).
  {
    // tsconfig sets jsx:"preserve", so tsx compiles JSX with the classic runtime, which expects a global React.
    const React = await import("react");
    (globalThis as unknown as { React: typeof React }).React = React;
    const { LearnedNotes, LEARNED_NOTES_READ } = await import("../components/tools/LearnedNotes");
    type El = { props?: { children?: unknown } } | string | number | null | undefined | boolean | El[];
    const text = (el: El): string => {
      if (el === null || el === undefined || typeof el === "boolean") return "";
      if (typeof el === "string" || typeof el === "number") return String(el);
      if (Array.isArray(el)) return el.map(text).join("");
      return text((el.props?.children ?? null) as El);
    };
    const note = (id: string, trains: string | null) => ({ id, kind: "link", label: "exemplar", title: id, source_url: null, state: "indexed", last_error: null, contributed_by: "cc", created_at: "2026-10-15T12:00:00.000Z", indexed_at: null, trains });
    const draw = (stats: typeof base, rows: ReturnType<typeof note>[], agent: "sales" | null) =>
      text(LearnedNotes({ stats, items: { rows, degraded: false }, agent }) as unknown as El);
    const many = (n: number, trains: string | null) => Array.from({ length: n }, (_, i) => note(`n${i}`, trains));

    // An agent's tab read in full: 10 of its notes among 200 rows may not be all of them.
    const full = [...many(10, "sales"), ...many(LEARNED_NOTES_READ - 10, "finance")];
    const salesFull = draw({ ...base, total: 400, indexed: 400 }, full, "sales");
    assert.match(salesFull, /10\+ for Sales/, "a full read is a floor: N+");
    assert.match(salesFull, /Showing the newest 10 of 10\+\./, "and the footer says the list may be partial even with fewer than 15 shown");
    assert.match(salesFull, /Every agent's notes are on Training/);
    // An agent's tab read short: the count is the whole of it, and 5 rows need no footer.
    const salesShort = draw({ ...base, total: 5, indexed: 5 }, many(5, "sales"), "sales");
    assert.match(salesShort, /5 for Sales/);
    assert.doesNotMatch(salesShort, /Showing the newest/);
    // The All tab counts against the true total.
    const all = draw({ ...base, total: 30, indexed: 30 }, many(30, "all"), null);
    assert.match(all, /Showing the newest 15 of 30\./);
    assert.match(all, /Open Training/);
    assert.doesNotMatch(all, /See all on Training/, "no promise of a full list the Training page does not keep");
    assert.doesNotMatch(draw({ ...base, total: 10, indexed: 10 }, many(10, "all"), null), /Showing the newest/, "everything shown: no footer");
    // The page's read size never exceeds what the reader returns, or a clamped read reads as a total.
    const { TRAINING_ROWS_MAX } = await import("../lib/os/training-notes");
    assert.ok(LEARNED_NOTES_READ <= TRAINING_ROWS_MAX, `LEARNED_NOTES_READ (${LEARNED_NOTES_READ}) must not exceed trainingRowsFor's cap (${TRAINING_ROWS_MAX})`);
    console.log("  ok - counts never present a read's cap as a total, and the footer shows whenever the list is partial");
  }

  console.log("learned-notes: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
