/**
 * The "New Form Application" drop must never show a rep a bare error code.
 *
 * Adon, 2026-09-15: the drop "kept on getting error-coded". Two separate causes
 * wore the same face:
 *   1. A real outage — Cloudflare's Browser Integrity Check answered the VPS
 *      callbacks with "error code: 1010", so extraction jobs died
 *      (blocked:dashboard_rejected_signature_403). Fixed VPS-side.
 *   2. This screen — a failed upload printed `failed_500` and stopped. That is a
 *      status code, not an instruction, and a rep cannot act on it.
 *
 * This test pins the second. It reads the component source rather than
 * rendering, matching how the other UI-contract tests in this suite work.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(process.cwd(), "components", "leads", "AutofillDropzone.tsx"),
  "utf8",
);

// 1. The bare-code fallback must be gone. This is the exact string a rep saw.
assert.ok(
  !/setErr\(\s*j\.detail \|\| j\.error \|\| `failed_\$\{r\.status\}`\s*\)/.test(source),
  "the upload path must not setErr a bare `failed_<status>` code",
);

// 2. The upload path must route through the plain-language explainer.
assert.match(
  source,
  /setErr\(\s*\n?\s*explainUploadFailure\(/,
  "a failed upload must be explained, not printed as a code",
);
assert.match(source, /function explainUploadFailure\(/, "explainUploadFailure must exist");

// 3. Body read as TEXT before parsing. `r.json()` on an empty-bodied 500
//    rejects, and the old `.catch(() => ({}))` turned that into `{}` — which is
//    how an invisible server crash became the string "failed_500".
// Scope to the UPLOAD block only — from send()'s start to the point where it
// hands off to polling. The poll loop below it legitimately keeps its own
// `.json().catch()`, because there a missing body just means "keep polling".
const sendStart = source.indexOf("async function send(");
const sendUploadEnd = source.indexOf("// Queued.", sendStart);
assert.ok(sendStart !== -1 && sendUploadEnd > sendStart, "could not locate the upload block");
const uploadBlock = source.slice(sendStart, sendUploadEnd);
assert.ok(
  uploadBlock.includes("await r.text()"),
  "the upload response must be read as text first so an empty body is legible",
);
assert.ok(
  !/await r\.json\(\)\.catch\(/.test(uploadBlock),
  "the swallow-into-empty-object json() read must be gone from the upload path",
);

// 4. Every explained branch must tell the rep what happened AND what to do.
//    A message that only names the fault still leaves them stuck.
const explainer = source.slice(
  source.indexOf("function explainUploadFailure("),
  source.indexOf("export function AutofillDropzone"),
);
for (const [label, needle] of [
  ["expired session", "sign in again"],
  ["file too large", "too large"],
  ["wrong file type", "can't be read"],
  ["rate limited", "Wait a moment"],
  ["server failure", "Enter the deal manually"],
]) {
  assert.ok(explainer.includes(needle), `explainUploadFailure must cover: ${label}`);
}
// Nothing-was-saved is the question a rep actually has after a failed drop:
// did this half-create something I now have to hunt for?
assert.ok(
  explainer.includes("Nothing was saved."),
  "upload failures that truly saved nothing must say so",
);

// 4b. 🚨 AND IT MUST NOT LIE. The two routes differ: new-from-document removes
//     its pending blob when the job insert fails; autofill-application has
//     already committed a real lead_documents row by then and does NOT roll it
//     back. A blanket "Nothing was saved" on queue_failed sends a rep to
//     re-drop a file the lead already has. The first version of this fix did
//     exactly that and a review caught it.
assert.ok(
  /queue_failed/.test(explainer),
  "queue_failed must be handled distinctly — it is the branch where a document IS saved",
);
assert.ok(
  /mode === "existing"/.test(explainer),
  "the message must branch on mode, because only the existing-lead route keeps the document",
);
assert.ok(
  explainer.includes("already on the Documents tab"),
  "on the existing-lead queue_failed path the rep must be told the file IS filed",
);
// The unknown-5xx branch must hedge, never promise. We cannot know how far an
// uncaught throw got.
const unknownBranch = explainer.slice(explainer.indexOf("status >= 500"));
assert.ok(
  !unknownBranch.includes("Nothing was saved."),
  "an unknown server failure must NOT promise that nothing was saved — we do not know",
);
assert.ok(
  unknownBranch.includes("before dropping the file again"),
  "an unknown server failure must tell the rep to check before re-dropping",
);
// ...and the raw code still has to survive, for diagnosing from a screenshot.
assert.ok(
  explainer.includes("(${code})"),
  "the raw code must still be printed in parentheses for diagnosis",
);

// 5. The extraction-failure explainer (the OTHER half of "error-coded") keeps
//    its plain-language contract too, including the blocked: case that the
//    Cloudflare 1010 outage produced.
assert.match(source, /function explainFailure\(/, "explainFailure must still exist");
assert.ok(
  source.includes("The application reader is offline"),
  "a blocked: extraction must be explained in plain language",
);

// 6. PROVE THE GUARD FIRES — against a mutated copy of the REAL source, not
//    against a string literal of the pattern. Asserting that a regex matches a
//    near-verbatim copy of itself proves only that the regex compiles; it would
//    still pass if the guard had been pointed at the wrong file entirely.
const BARE_CODE = /setErr\(\s*j\.detail \|\| j\.error \|\| `failed_\$\{r\.status\}`\s*\)/;
const BARE_CODE_LINE = "setErr(j.detail || j.error || `failed_${r.status}`);";

// The real file must be clean...
assert.ok(!BARE_CODE.test(source), "live source must not contain the bare-code fallback");

// ...and the same check, run over the real file with the historical defect
// spliced back in at the real call site, must reject it.
// Line endings are CRLF in this repo, so match on the call rather than a
// literal "setErr(\n".
const callMatch = /setErr\(\s*[\r\n]+\s*explainUploadFailure\(/.exec(source);
assert.ok(callMatch, "could not locate the explainUploadFailure call site to mutate");
const callSite = callMatch.index;
// Replace the whole multi-line call with the historical one-liner.
const callEnd = source.indexOf("),", callSite);
assert.ok(callEnd > callSite, "could not find the end of the explainUploadFailure call");
const mutated = source.slice(0, callSite) + BARE_CODE_LINE + source.slice(callEnd + 2);
assert.ok(
  BARE_CODE.test(mutated),
  "the bare-code check must FIRE on the real source with the 2026-09-15 defect restored",
);
// And the plain-language requirement must fail on that same mutation, otherwise
// check 2 is decorative.
assert.ok(
  !/setErr\(\s*\n?\s*explainUploadFailure\(/.test(mutated),
  "the explainer requirement must FIRE when the call site regresses",
);

console.log("dropzone-plain-language-errors: OK — no bare codes, every branch actionable");
