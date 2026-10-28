/**
 * Runs the sales suite, one node process per test.
 *
 * WHY THIS EXISTS
 * On 2026-09-08, 26 of the 27 tests/web-leads-*.test.ts files were in no npm
 * script, so CI had never executed a single one of them. That is not a
 * bookkeeping detail: it is why the owner-tier filters shipped returning zero
 * rows against 1,668 owner-named leads and stayed that way for two weeks. A
 * guard nothing executes is documentation.
 *
 * 2026-10-28: the Prospects surface (/web-leads) retired, and this suite was
 * renamed from test:web-leads to test:sales. Its prospect-only files went with
 * the code they tested; what stays is the lead ownership rules, the lead send
 * path, the objection library and trainer, and sales training.
 *
 * WHY IT DOES NOT STOP AT THE FIRST FAILURE, unlike tests/_suite.mjs.
 * That file's fail-fast is inherited from the `&&` chain it replaced, and this
 * repo has twice paid for it — the 2026-08-07 server-only import killed the
 * 12th of 48 tests and the 37 after it never ran for a full day behind one
 * generic error. The useful question is "what is broken", not "what broke
 * first". Every file runs; every failure is named; the exit code is still
 * non-zero if any failed.
 *
 * The list stays EXPLICIT rather than globbed, same reasoning as _suite.mjs:
 * membership is deliberate, and a glob would silently adopt a future file that
 * needs credentials or a live database.
 *
 * Adding a test: put it in the list. There is no other step.
 */
import { spawnSync } from "node:child_process";

const TESTS = [
  // One vocabulary for "what happened on that call".
  "tests/call-disposition.test.ts",
  // Lead ownership: the pure claim rules, releasing a lead back to the pool,
  // who a lead may be assigned to, and the website link a rep may open.
  "tests/leads-claim.test.ts",
  "tests/leads-release-tracking.test.ts",
  "tests/leads-assign-target.test.ts",
  "tests/leads-site-url.test.ts",
  // The capability ladder the Playbook's industry guide sells from.
  "tests/capability-ladder.test.ts",
  // The rep-facing send path that hangs off a worked lead.
  "tests/lead-quick-email.test.ts",
  "tests/lead-quick-email-delivery.test.ts",
  // The field labelled "Contact name" must hold a person, not the business.
  "tests/lead-contact-name.test.ts",
  // A rep may add a lead they sourced, and it lands in their own book.
  "tests/rep-creates-own-lead.test.ts",
  "tests/oasis-admin-create-assignee.test.ts",
  // An OASIS email must name OASIS, in the signature as well as the footer.
  "tests/oasis-email-branding.test.ts",
  // Operator copy on the Automations tab must match a real job name.
  "tests/cron-descriptions-render.test.ts",
  // The objection catalog: validation and projection only, no credentials.
  "tests/objection-catalog.test.ts",
  // The copy rules for every sentence a rep says out loud. Listed here
  // deliberately: tests/industry-automations.test.ts sat in NO suite and never
  // ran, which is the failure mode this line avoids.
  "tests/objection-copy.test.ts",
  // The Playbook's per-industry automations.
  "tests/industry-automations.test.ts",
  // The authoring surface: dedup, batch parsing, write-path copy rules, and
  // the approval gate. Pure decisions only; the SQL is not covered and the
  // test says so in its own header.
  "tests/objection-admin.test.ts",
  // Model-drafted answers: every rejection path, and the structural proof that
  // nothing generated can reach a rep without a human approving it.
  "tests/objection-draft-answers.test.ts",
  // The rep practice trainer: drill construction and what a typed answer is
  // checked against. The invariant that matters is exactly one right answer.
  "tests/objection-practice.test.ts",
  // The Training curriculum and its drills: exactly one right answer, and no
  // drill answer states a price.
  "tests/training-drills.test.ts",
  // The practice call: the model plays a CUSTOMER so its turns are NOT
  // copy-rule checked, while the debrief IS; the persona never leaves the server.
  "tests/training-roleplay.test.ts",
  // The objection catalog's tenant pins and approval filter. Source reads only.
  "tests/objection-guards.test.ts",
  // The four qualification gates: new wording, unchanged stored keys, legacy
  // records still read as qualified.
  "tests/sales-qualification.test.ts",
  // Meeting times in the prospect's own zone; DST gaps refused, not shifted.
  "tests/meeting-time-zones.test.ts",
  // Booking a founder meeting from a lead: lapsed claims refused; do-not-call
  // booked only on the rep's "owner asked" confirmation.
  "tests/book-meet-route.test.ts",
];

const NODE_ARGS = ["--conditions=react-server", "--import", "tsx"];

const failures = [];
for (const file of TESTS) {
  const r = spawnSync(process.execPath, [...NODE_ARGS, file], { stdio: "inherit" });
  if (r.status !== 0) failures.push({ file, status: r.status, signal: r.signal });
}

if (failures.length) {
  console.error(`\n[test:sales] ${failures.length} of ${TESTS.length} test files FAILED:`);
  for (const f of failures) {
    console.error(`  - ${f.file}` + (f.signal ? ` (signal ${f.signal})` : ` (exit ${f.status})`));
  }
  process.exit(1);
}

console.log(`\n[test:sales] ${TESTS.length} test files passed.`);
