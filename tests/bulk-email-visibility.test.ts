import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Pins the invariants that make a bulk send OBSERVABLE to the operator.
 *
 * Context (Adon, 2026-08-20): bulk email was reported as "not sending at all"
 * while every message was in fact being delivered. The transport was healthy;
 * what was missing was any way for the operator to see it. A prior fix proved
 * the drain worked with a synthetic canary and was declared complete, so the
 * same bug was re-reported. These assertions guard the feedback path, because
 * that is the part that actually broke, and it is the part a backend-only test
 * cannot see.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const bulkRoute = read("app/api/leads/bulk/route.ts");
const batchesRoute = read("app/api/leads/bulk/batches/route.ts");
const dialog = read("components/leads/BulkEmailDialog.tsx");
const history = read("components/leads/BulkSendHistory.tsx");
const pipeline = read("components/manifest/LeadPipelineView.tsx");

// ---------------------------------------------------------------------------
// 1. ONE classifier for both the preview and the send.
//    A separately-implemented preflight is a second source of truth that
//    drifts, and a preview that lies is worse than no preview at all.
// ---------------------------------------------------------------------------
assert.match(
  bulkRoute,
  /import \{ classifyBulkRecipients, summarizeClassification \} from "@\/lib\/bulk-email\/recipients"/,
  "route imports the shared classifier",
);
assert.equal(
  (bulkRoute.match(/classifyBulkRecipients\(/g) || []).length,
  1,
  "the classifier is invoked exactly ONCE, before the preflight/send fork — two call sites means the preview can disagree with the send",
);
assert.match(
  bulkRoute,
  /if \(op === "email" \|\| op === "email_preflight"\) \{/,
  "preflight and send enter the SAME block",
);
assert.match(
  bulkRoute,
  /if \(op === "email_preflight"\) \{[\s\S]*?return NextResponse\.json\(/,
  "preflight returns before any write",
);
// The preflight must not be able to queue or send.
const preflightBlock = bulkRoute.slice(
  bulkRoute.indexOf('if (op === "email_preflight") {'),
  bulkRoute.indexOf("// ---- resolve the message"),
);
assert.ok(!/\.insert\(/.test(preflightBlock), "preflight never inserts");
assert.ok(!/after\(/.test(preflightBlock), "preflight never kicks the drain");

// ---------------------------------------------------------------------------
// 2. Operator-authored copy passes the direct-funder guard BEFORE queueing.
//    SunBiz positions AS the lender; this is the first free-form merchant-facing
//    text on the bulk path, so the guard is load-bearing, not advisory.
// ---------------------------------------------------------------------------
assert.match(
  bulkRoute,
  /sanitizeBlastMessage\(\s*\n?\s*tenantId,[\s\S]{0,200}?checkPositioning: true/,
  "custom copy runs the positioning + lender-name guard",
);
const guardIdx = bulkRoute.indexOf("sanitizeBlastMessage(");
// Search from the guard onward: the `assign` op writes its own audit row to
// lead_interactions earlier in the file, which is not the queue insert.
const queueInsertIdx = bulkRoute.indexOf('db.from("lead_interactions").insert(chunk)', guardIdx);
assert.ok(guardIdx > 0, "the guard is present");
assert.ok(queueInsertIdx > guardIdx, "the guard runs BEFORE the queue insert");
assert.match(
  bulkRoute,
  /if \(!guard\.ok\) \{[\s\S]{0,400}?status: 400/,
  "a blocked message is refused, never silently sent",
);
assert.match(
  bulkRoute,
  /matchPositioningPhrases\(`\$\{subject\}\\n\\n\$\{rendered\}`\)/,
  "the RENDERED text is re-checked, so a merge value can't smuggle a broker phrase past the pre-render guard",
);
assert.match(
  bulkRoute,
  /if \(!canWriteCrm\(sess\.teamRole\)\) \{/,
  "free-form send carries a role gate",
);

// ---------------------------------------------------------------------------
// 3. Unknown merge fields never reach a merchant.
// ---------------------------------------------------------------------------
assert.match(bulkRoute, /validateCustomMessage\(/, "custom copy is validated server-side");
assert.match(
  bulkRoute,
  /error: "invalid_message"[\s\S]{0,200}?status: 400/,
  "invalid copy is a 400, not a partial send",
);

// ---------------------------------------------------------------------------
// 4. Every queued row is tagged with a batch id — the receipt's primary key.
// ---------------------------------------------------------------------------
assert.match(bulkRoute, /const batchId = randomUUID\(\);/, "one id per batch");
assert.match(bulkRoute, /batch_id: batchId,/, "stamped into row metadata");
assert.match(bulkRoute, /batch_id: batchId,\s*\n\s*\.\.\.out/, "and returned to the client so it can poll");

// ---------------------------------------------------------------------------
// 5. The send starts immediately. A five-minute wait with no feedback is
//    indistinguishable from a dead button, which is the whole reported bug.
// ---------------------------------------------------------------------------
assert.match(bulkRoute, /import \{ NextRequest, NextResponse, after \} from "next\/server"/, "after() imported");
assert.match(
  bulkRoute,
  /if \(queued > 0\) \{\s*\n\s*after\(async \(\) => \{[\s\S]{0,400}?runDispatchBulkEmail\(\)/,
  "queueing kicks the drain",
);
assert.match(
  bulkRoute,
  /catch \(err\) \{[\s\S]{0,300}?post-queue drain kick failed/,
  "the kick is best-effort: the cron still re-drains, so a failed kick delays a send but never loses one",
);
assert.match(bulkRoute, /export const maxDuration = 60;/, "the invocation has room for the drain");

// ---------------------------------------------------------------------------
// 6. Failure honesty: an unreadable chunk is reported as failed, never as
//    "not found". Telling an operator a lead vanished when the database
//    hiccuped sends them to clean data that was never dirty.
// ---------------------------------------------------------------------------
assert.match(bulkRoute, /const unreadable = new Set<string>\(\);/);
assert.match(bulkRoute, /out\.failed = insertFailed \+ unreadable\.size;/, "unreadable counts as failed");
assert.match(
  bulkRoute,
  /const readableIds = ids\.filter\(\(id\) => !unreadable\.has\(id\)\);/,
  "unreadable ids are excluded from classification rather than mislabelled",
);

// ---------------------------------------------------------------------------
// 7. The history endpoint is tenant-scoped and fails closed for a non-admin
//    with no resolvable identity.
// ---------------------------------------------------------------------------
assert.match(batchesRoute, /\.eq\("tenant_id", sess\.tenantId\)/, "tenant-bound");
assert.match(
  batchesRoute,
  /if \(!sess\.isAdmin && !sess\.userId\) \{\s*\n\s*return NextResponse\.json\(\{ ok: true, batches: \[\], rows: \[\] \}\);/,
  "no identity means no batches, never all of them",
);
assert.match(
  batchesRoute,
  /if \(!sess\.isAdmin\) q = q\.eq\("metadata->>acted_by_user_id", sess\.userId\);/,
  "a non-admin sees only their own sends",
);
assert.match(batchesRoute, /if \(!sess\.ok\) \{/, "authenticated");
// Turso shim: object-containment (.contains) NEVER matches an object column.
assert.ok(!/\.contains\(/.test(batchesRoute), "no .contains() — dead on the Turso adapter");
assert.ok(!/\.contains\(/.test(bulkRoute), "no .contains() in the bulk route either");

// ---------------------------------------------------------------------------
// 8. The dialog actually shows what happened: preflight, then live polling.
// ---------------------------------------------------------------------------
assert.match(dialog, /op: "email_preflight"/, "dialog runs the preflight before sending");
assert.match(
  dialog,
  /\/api\/leads\/bulk\/batches\?batch_id=/,
  "dialog polls the batch until it reaches a terminal state",
);
assert.match(dialog, /if \(!body\.batch\.in_flight\) \{/, "polling stops on a terminal batch");
assert.match(dialog, /POLL_CEILING_MS/, "polling has a ceiling so a wedged batch can't spin forever");
assert.match(dialog, /renderSunbizTemplate|renderCustomMessage/, "preview uses the same renderers as the server");
assert.match(
  dialog,
  /no email address, so/,
  "the reason a record can't be emailed is stated in plain language",
);

// The preview must be produced by the SHARED renderers, never re-implemented.
assert.ok(
  !/replace\(\/\\\{\\\{/.test(dialog),
  "the dialog does not hand-roll merge substitution",
);

// ---------------------------------------------------------------------------
// 9. The board exposes both surfaces.
// ---------------------------------------------------------------------------
assert.match(pipeline, /<BulkEmailDialog/, "composer mounted");
assert.match(pipeline, /<BulkSendHistory/, "history mounted");
assert.match(pipeline, /onOpenEmail=\{\(\) => setEmailDialogOpen\(true\)\}/);
assert.match(pipeline, /onOpenHistory=\{\(\) => setSendHistoryOpen\(true\)\}/);
// The old fire-from-a-dropdown path is gone; it queued correctly but told the
// operator nothing, which is the behaviour being fixed.
assert.ok(!/setPendingEmail/.test(pipeline), "the old bare-dropdown send is removed");

// ---------------------------------------------------------------------------
// 10. No em dashes in anything an operator or merchant reads.
// ---------------------------------------------------------------------------
/** Strip block + line comments; whatever dash survives is in real copy.
 *  (Comments are the one place an em dash is fine, and this file's own
 *  headers use them.) */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

for (const [name, src] of [
  ["BulkEmailDialog", dialog],
  ["BulkSendHistory", history],
] as const) {
  const code = stripComments(src);
  const hits = code.match(/.{0,40}[—–].{0,40}/g) || [];
  assert.equal(hits.length, 0, `${name} has em/en dashes in visible copy: ${hits.join(" | ")}`);
}

console.log("ok bulk-email-visibility");
