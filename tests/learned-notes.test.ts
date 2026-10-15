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
 *   3. the footer does NOT claim an agent learns from these notes: nothing reads
 *      them into a prompt yet (design doc 2026-10-14, section 5), and a list of
 *      saved links called "training" with no consumer is the overclaim it names;
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
  assert.match(component, /No agent reads these notes into its writing yet/, "the footer is honest about the consumer");
  assert.doesNotMatch(component, /(agents?|it) (will |can |now )?(learn|train)s? (on|from) (these|this)/i, "no claim that an agent learns from the list");
  assert.match(component, /ingestStateCopy/, "state wording comes from the one shared function (Training uses it too)");
  assert.match(component, /last_error\.slice\(0, 160\)/, "a failed row's reason is shown, bounded");
  console.log("  ok - failed reads and an empty list are told apart, and the footer makes no training claim");

  const page = read("app/admin/agent-training/page.tsx");
  assert.match(page, /await requireOperator\(\);/, "still gated first");
  assert.match(page, /getCorpusStats\(tenantId\)/);
  assert.match(page, /getCorpusItems\(tenantId, 16\)/);
  assert.match(page, /async function safely/, "a rejected read becomes degraded instead of a crashed page");
  assert.match(page, /\{ \.\.\.EMPTY_CORPUS_STATS, degraded: true \}/);
  assert.match(page, /<LearnedNotes stats=\{stats\} items=\{items\} \/>/);
  assert.ok(page.indexOf("requireOperator()") < page.indexOf("getCorpusStats("), "the gate runs before any read");
  console.log("  ok - the page is gated first and degrades a failed read");

  // Codex review of #612: the history reads must not hold back the Learn control, and a
  // finished run must make the list re-read.
  const body = page.slice(page.indexOf("export default async function AgentTrainingPage"));
  assert.doesNotMatch(body, /getCorpus(Stats|Items)\(/, "the page body awaits no corpus read: they live in the Suspense child");
  assert.match(body, /<Suspense[\s\S]*<LearnedNotesLoader tenantId=\{founder\.tenantId\} \/>[\s\S]*<\/Suspense>/);
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

  console.log("learned-notes: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
