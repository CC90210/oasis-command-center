/**
 * tests/training-relevance.test.ts - an agent reads the training notes that match the question (2026-10-28).
 *
 * Before this, a department agent read its 5 NEWEST notes, so the sixth note it was taught silently
 * dropped out of its instructions. Pinned here, against a real libSQL file:
 *   1. the pure pieces: termsOf (topic words), rankByRelevance (BM25-style, ties keep newest-first),
 *      topTermsOf (what a note gets picked for);
 *   2. readTrainingNotes with a question: the matching note comes first even when it is the oldest, the
 *      newest notes fill the rest, the department rule still applies, and a question that matches
 *      nothing reads exactly what it read before;
 *   3. a relevance read that fails falls back to the newest notes, never to none;
 *   4. trainingSelectionFor reports which notes went in; noteMemoryFor gives each learned note its card;
 *      a note that does not fit the block whole is left out and never reported as picked;
 *   5. every turn path hands its question over, and a prepared turn carries the injected note ids.
 *
 * Run: node --conditions=react-server --import tsx tests/training-relevance.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

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

async function main(): Promise<void> {
  const notes = await import("../lib/os/training-notes");

  await check("termsOf keeps topic words: lowercase, three letters or more, no stop words, any script", () => {
    assert.deepEqual(notes.termsOf("How do I write a COLD email subject-line?"), ["cold", "email", "subject", "line"]);
    assert.deepEqual(notes.termsOf("Le café du coin"), ["café", "coin"]);
    assert.deepEqual(notes.termsOf(""), []);
    assert.deepEqual(notes.termsOf(null), []);
  });

  await check("rankByRelevance puts the matching note first; ties and no question keep the given order", () => {
    const docs = [{ terms: ["pricing", "tiers"] }, { terms: ["cold", "email", "subject", "line"] }, { terms: ["video", "hook"] }];
    const ranked = notes.rankByRelevance(docs, "a cold email subject line");
    assert.equal(ranked[0].index, 1);
    assert.ok(ranked[0].score > 0);
    assert.deepEqual(ranked.slice(1).map((r) => r.score), [0, 0], "no shared word scores 0");
    assert.deepEqual(ranked.slice(1).map((r) => r.index), [0, 2], "the rest keep newest-first order");
    assert.deepEqual(notes.rankByRelevance(docs, "").map((r) => r.index), [0, 1, 2], "no question, no reordering");
    assert.deepEqual(notes.rankByRelevance([], "anything"), []);
  });

  await check("topTermsOf names what a note is distinctive for, not what every note says", () => {
    const docs = [
      { terms: ["hook", "video", "pricing", "pricing"] },
      { terms: ["hook", "video", "email"] },
      { terms: ["hook", "video", "story"] },
    ];
    const top = notes.topTermsOf(0, docs, 2);
    assert.equal(top[0], "pricing", "the word only this note has, twice, ranks first");
    assert.ok(!top.includes("hook") || top.indexOf("hook") > 0);
  });

  // ── the read, against a real libSQL file ──────────────────────────────
  const db = createClient({ url: ":memory:" });
  await db.execute(`CREATE TABLE marketing_corpus (
    id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, trains TEXT,
    title TEXT, source_url TEXT, extraction TEXT NOT NULL, state TEXT NOT NULL, last_error TEXT, contributed_by TEXT,
    search_text TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, indexed_at TEXT)`);
  const A = "tenant-a";
  let n = 0;
  const put = async (trains: string, title: string, steal: string, searchText: string, state = "indexed") => {
    n += 1;
    const at = `2026-10-28T12:${String(n).padStart(2, "0")}:00.000Z`;
    await db.execute({
      sql: "INSERT INTO marketing_corpus (id, tenant_id, kind, label, trains, title, source_url, extraction, state, search_text, created_at, updated_at, indexed_at) VALUES (?, ?, 'link', 'exemplar', ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      args: [`n${n}`, A, trains, title, `https://example.com/${n}`, JSON.stringify({ analysis: { hook: `Hook ${n}`, tone: "Warm", pacing: null, structure: null, steal, avoid: null } }), state, searchText, at, at, at],
    });
  };
  // The OLDEST note is the one about cold email subject lines; five newer ones are about other things.
  await put("sales", "Subject lines that get opened", "Name the outcome in the subject", "cold email subject line open rate curiosity");
  for (let i = 0; i < 5; i += 1) await put("sales", `Pricing page teardown ${i}`, "Anchor on the middle tier", "pricing tiers anchor annual monthly");
  await put("finance", "Invoice reminders", "Polite and specific", "invoice overdue reminder");
  await put("sales", "Unfinished note", "Not read yet", "cold email subject", "queued");

  await check("a question picks the note that matches it, even the oldest, and the newest fill the rest", async () => {
    const got = await notes.readTrainingNotes(db, A, "sales", 5, { query: "Write me a cold email subject line for a dentist" });
    assert.equal(got.length, 5);
    assert.equal(got[0].title, "Subject lines that get opened", "the match comes first");
    assert.equal(got[0].id, "n1");
    assert.deepEqual(got.slice(1).map((x) => x.id), ["n6", "n5", "n4", "n3"], "then the newest of the rest");
    assert.ok(!got.some((x) => x.title === "Invoice reminders"), "another department's note never comes in");
    assert.ok(!got.some((x) => x.title === "Unfinished note"), "an unfinished note never comes in");
  });

  await check("without a question, or with one that matches nothing, it reads exactly the newest five", async () => {
    const newest = (await notes.readTrainingNotes(db, A, "sales")).map((x) => x.id);
    assert.deepEqual(newest, ["n6", "n5", "n4", "n3", "n2"], "the old behaviour: newest first, the oldest note dropped");
    assert.deepEqual((await notes.readTrainingNotes(db, A, "sales", 5, { query: "zebra quantum" })).map((x) => x.id), newest);
    assert.deepEqual((await notes.readTrainingNotes(db, A, "sales", 5, { query: "the and for" })).map((x) => x.id), newest, "stop words alone are no question");
  });

  await check("a relevance read that fails falls back to the newest notes, never to none", async () => {
    const plain = createClient({ url: ":memory:" });
    // No search_text column: the relevance read throws, the newest read still works.
    await plain.execute(`CREATE TABLE marketing_corpus (id TEXT PRIMARY KEY, tenant_id TEXT, label TEXT, trains TEXT, title TEXT, source_url TEXT,
      extraction TEXT, state TEXT, created_at TEXT, updated_at TEXT, indexed_at TEXT)`);
    await plain.execute({
      sql: "INSERT INTO marketing_corpus VALUES ('p1', ?, 'exemplar', 'sales', 'Only note', NULL, ?, 'indexed', '2026-10-28', '2026-10-28', '2026-10-28')",
      args: [A, JSON.stringify({ analysis: { steal: "Lead with the outcome" } })],
    });
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const got = await notes.readTrainingNotes(plain, A, "sales", 5, { query: "cold email" });
      assert.deepEqual(got.map((x) => x.id), ["p1"]);
    } finally {
      console.error = original;
    }
    assert.ok(errors.length >= 1, "the failed relevance read is logged");
  });

  await check("trainingSelectionFor reports the notes it put in the block, best match first", async () => {
    const pick = await notes.trainingSelectionFor(A, "sales", { db, query: "cold email subject line" });
    assert.equal(pick.noteIds[0], "n1");
    assert.equal(pick.noteIds.length, 5);
    assert.match(pick.block, /Subject lines that get opened/);
    const none = await notes.trainingSelectionFor("", "sales", { db, query: "anything" });
    assert.deepEqual(none, { block: "", noteIds: [] });
  });

  await check("the block holds whole notes only, and reports exactly the notes it holds", () => {
    // Five long notes (three fields at the stored cap): the 3,000-character block fits three of them.
    const long = (i: number) => ({
      id: `long-${i}`,
      title: `Long note ${i}`,
      label: "exemplar",
      hook: `h${i}`.padEnd(280, "h"),
      steal: `s${i}`.padEnd(280, "s"),
      tone: `t${i}`.padEnd(280, "t"),
      pacing: null,
      structure: null,
      avoid: null,
    });
    const picked = notes.trainingSelection([1, 2, 3, 4, 5].map(long));
    assert.deepEqual(picked.noteIds, ["long-1", "long-2", "long-3"], "only the notes that fit are reported");
    for (const id of [1, 2, 3]) assert.ok(picked.block.includes(`Long note ${id}.`), `note ${id} is in the block`);
    for (const id of [4, 5]) assert.ok(!picked.block.includes(`Long note ${id}`), `note ${id} is left out, not cut off`);
    assert.doesNotMatch(picked.block, /truncated by llm-input-boundary/, "no note is cut partway");
    assert.equal(notes.trainingBlock([1, 2, 3, 4, 5].map(long)), picked.block, "trainingBlock is the same block");
    // A shorter note further down still gets in when a longer one before it does not fit.
    const short = { ...long(6), hook: "short", steal: null, tone: null };
    assert.deepEqual(
      notes.trainingSelection([...[1, 2, 3, 4].map(long), short]).noteIds,
      ["long-1", "long-2", "long-3", "long-6"],
    );
  });

  await check("noteMemoryFor gives each learned note what it holds and what picks it", async () => {
    const memory = await notes.noteMemoryFor(A, "sales", { db });
    assert.ok(memory.n1, "a learned note has a card");
    assert.equal(memory.n1.steal, "Name the outcome in the subject");
    assert.ok(memory.n1.topTerms.includes("subject") || memory.n1.topTerms.includes("cold"), `n1 is picked for its own words: ${memory.n1.topTerms}`);
    assert.equal(memory.n8, undefined, "an unfinished note has no card");
    assert.equal(memory.n7, undefined, "another department's note is not on this tab");
    assert.ok((await notes.noteMemoryFor(A, null, { db })).n7, "the All tab scores every learned note");
  });

  await check("every turn path hands over its question, and a prepared turn carries the injected note ids", () => {
    const agent = read("lib/os/department-agent.ts");
    assert.equal((agent.match(/trainingSelectionFor\(tenantId, dept\.key, \{ query: req\.trainingQuery \}\)/g) || []).length, 2, "hosted and computer turns both pick by the question");
    assert.equal((agent.match(/trainingNoteIds: trainingPick\.noteIds,/g) || []).length, 2, "both turn shapes report what went in");
    assert.match(read("lib/os/runs/turn-starter.ts"), /trainingQuery: run\.userText,/);
    assert.match(read("lib/os/runs/computer-turn.ts"), /trainingQuery: run\.userText,/);
    assert.match(read("app/api/agents/chat/route.ts"), /trainingQuery: lastUser\.content,/);
    assert.match(read("lib/slack/jobs.ts"), /trainingQuery: picked\.question,/, "a Slack mention picks by its question");
    assert.match(read("lib/os/runs/automation-turn.ts"), /trainingQuery: task,/, "a guided automation picks by its task");
    // And any caller added later: every module that prepares a department turn hands over a question.
    const callers = [
      "app/api/agents/chat/route.ts",
      "app/api/admin/agent-training/[[...path]]/route.ts",
      "lib/os/runs/turn-starter.ts",
      "lib/os/runs/computer-turn.ts",
      "lib/slack/jobs.ts",
      "lib/os/runs/automation-turn.ts",
    ];
    for (const file of callers) {
      const src = read(file);
      const prepares = (src.match(/(?:prepareAgentTurn|\bprepare)\(\{/g) || []).length;
      const queries = (src.match(/trainingQuery: /g) || []).length;
      assert.ok(prepares >= 1 && queries >= prepares, `${file}: ${prepares} prepare call(s), ${queries} trainingQuery`);
    }
  });

  console.log(`training-relevance: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
