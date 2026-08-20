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
const dispatch = read("lib/bulk-email/dispatch.ts");
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
  /import \{ classifyBulkRecipients, summarizeClassification, redactForResponse \} from "@\/lib\/bulk-email\/recipients"/,
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
// 🚨 Merge values are MERCHANT-SUPPLIED, so the copy that ships is not the copy
// the pre-render guard saw. BOTH matchers must run on the final per-recipient
// text: a business name can complete a broker phrase, or simply BE a lender's
// name. Checking only the unrendered template leaves the load-bearing
// "never name a lender" rule open.
// (Codex review P1, 2026-08-20 round 5.)
assert.match(
  bulkRoute,
  /const finalText = `\$\{subject\}\\n\\n\$\{rendered\}`;/,
  "the rendered per-recipient text is what gets checked",
);
assert.match(
  bulkRoute,
  /matchPositioningPhrases\(finalText\)\.length > 0 \|\|\s*\n\s*matchLenderNames\(finalText, lenders\.names\)\.length > 0/,
  "positioning AND lender-name matchers both run on the rendered text",
);
// One lookup for the whole batch, not one per recipient.
assert.match(
  bulkRoute,
  /const lenders = await getTenantLenderNames\(tenantId\);/,
  "the lender list is fetched once, outside the loop",
);
assert.equal(
  (bulkRoute.match(/getTenantLenderNames\(/g) || []).length,
  1,
  "exactly one call site, never one per row",
);
// A guard that passes when its data is missing is not a guard.
assert.match(
  bulkRoute,
  /if \(!lenders\.checked\) \{[\s\S]{0,300}?status: 503/,
  "an unverifiable lender list blocks the batch, fail-closed",
);
assert.match(
  bulkRoute,
  /if \(!canWriteCrm\(sess\.teamRole\)\) \{/,
  "free-form send carries a role gate",
);

// 🚨 No UUID enumeration oracle. The route deliberately makes "not yours"
// indistinguishable from "does not exist"; the preflight must not undo that by
// reporting them as separate counts or reasons.
// (Codex review P1, 2026-08-20 round 4.)
assert.match(bulkRoute, /const shown = redactForResponse\(cls\);/, "responses go through the fold");
assert.ok(
  !/counts: \{ \.\.\.cls\.counts/.test(bulkRoute),
  "the RAW classification never reaches the client",
);
assert.ok(
  !/skipped: cls\.skipped/.test(bulkRoute),
  "nor do the raw per-id skip reasons",
);
assert.match(bulkRoute, /summary: summarizeClassification\(shown, emailEntity\)/, "the summary is built from the folded view");
assert.equal(
  (bulkRoute.match(/summarizeClassification\(cls,/g) || []).length,
  0,
  "no response path summarizes the unfolded classification",
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
assert.match(batchesRoute, /\.eq\("tenant_id", opts\.tenantId\)/, "tenant-bound");
assert.match(
  batchesRoute,
  /tenantId: sess\.tenantId,/,
  "and the tenant comes from the SESSION, never from the request",
);
assert.match(
  batchesRoute,
  /if \(!sess\.isAdmin && !sess\.userId\) \{\s*\n\s*return NextResponse\.json\(\{ ok: true, batches: \[\], rows: \[\], truncated: false \}\);/,
  "no identity means no batches, never all of them",
);
assert.match(
  batchesRoute,
  /ownerId: sess\.isAdmin \? null : sess\.userId,/,
  "a non-admin is pinned to their own sends",
);
assert.match(
  batchesRoute,
  /if \(opts\.ownerId\) q = q\.eq\("metadata->>acted_by_user_id", opts\.ownerId\);/,
  "and that pin is applied to every page of the scan, not just the first",
);
assert.match(batchesRoute, /if \(!sess\.ok\) \{/, "authenticated");

// 🚨 The drain rewrites a row's type from 'email_queued' to 'email_sent' on
// success, so filtering the history on `type` silently drops every DELIVERED
// recipient: successful batches vanish from history and the dialog polls a
// batch that no longer matches until it times out. That is the exact
// "it says nothing happened" failure this endpoint exists to end.
// (Codex review P1, 2026-08-20; confirmed in production, where every one of
// the 26 sent rows carries type='email_sent'.)
assert.ok(
  !/\.eq\("type",/.test(batchesRoute),
  "history must NOT filter on type: the drain rewrites it to email_sent and the receipt would lose every successful send",
);
assert.match(
  batchesRoute,
  /\.eq\("agent_source", BULK_EMAIL_SOURCE\)/,
  "bulk rows are identified by agent_source alone",
);
assert.match(
  dispatch,
  /type: "email_sent"/,
  "this is the rewrite the filter above must tolerate; if the drain stops doing it, revisit the note in the batches route",
);

// A receipt that stops early is a receipt that lies. A batch may hold up to
// MAX_EMAIL_IDS recipients, so the detail view reads to that depth, and the
// list view says so out loud when its rolling window is exhausted.
// (Codex review P2, 2026-08-20.)
assert.match(batchesRoute, /const DETAIL_MAX = 10_000;/, "detail reads a full batch");
assert.match(batchesRoute, /\.range\(from, from \+ take - 1\)/, "the read is paginated, not a single truncating limit");
assert.match(
  batchesRoute,
  /return \{ rows, truncated: true \};/,
  "hitting the ceiling is reported, never silently swallowed",
);
assert.match(batchesRoute, /max: wanted \? DETAIL_MAX : LIST_SCAN_MAX/, "detail and list use different depths on purpose");
assert.match(history, /Showing the most recent sends only/, "and the operator is told when the window cut off");
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

// 🚨 Hitting that ceiling must NOT be reported as completion. The drain sends
// PER_TICK (20) every 5 minutes, so a 100-recipient batch legitimately takes
// ~25 minutes; declaring "20 of 100 sent" as a final result is the same class
// of lie as the silence this dialog replaces.
// (Codex review P1, 2026-08-20 round 2.)
assert.match(
  dialog,
  /if \(Date\.now\(\) - pollStarted\.current > POLL_CEILING_MS\) \{[\s\S]{0,300}?setPhase\("background"\)/,
  "the poll ceiling hands off to a background state, never to done",
);
assert.ok(
  !/POLL_CEILING_MS\) \{\s*\n\s*setPhase\("done"\)/.test(dialog),
  "the ceiling never sets phase=done",
);
assert.match(dialog, /Still sending\. \$\{sent\} of \$\{status\.total\} done so far/, "and says so plainly");
assert.match(
  dialog,
  /It keeps\s*\n?\s*running whether or not this window is open/,
  "the operator is told the send continues without the dialog",
);
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

// 🚨 The receipt must be reachable WITHOUT a selection. BulkActionBar renders
// only in select mode with >=1 record checked, and the send dialog clears the
// selection on close, so a history button living there is unreachable at
// exactly the moment an operator asks "did that batch go out?"
// (Codex review P2, 2026-08-20 round 3.)
const bulkBarStart = pipeline.indexOf("function BulkActionBar(");
assert.ok(bulkBarStart > 0, "BulkActionBar found");
assert.ok(
  !pipeline.slice(bulkBarStart).includes("setSendHistoryOpen"),
  "the Recent sends control must NOT live inside the selection-only toolbar",
);
assert.ok(
  pipeline.slice(0, bulkBarStart).includes("onClick={() => setSendHistoryOpen(true)}"),
  "it lives in the always-rendered page header instead",
);
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
