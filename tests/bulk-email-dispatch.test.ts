/**
 * tests/bulk-email-dispatch.test.ts — pins the bulk-email repair (2026-08-18).
 *
 * Context: bulk email died 2026-07-27 when the submissions Gmail App Password
 * was rotated — the VPS send_gateway drain kept authenticating with the stale
 * env copy and terminally failed every queued row ("SMTP authentication
 * failed — rotate GMAIL_APP_PASSWORD" × 53). The repair moves the drain into
 * the app (lib/bulk-email/dispatch.ts, 5-min cron) on the SAME encrypted
 * tenant-integration credential the working form/receipt mail uses, and
 * retags queue rows so the VPS consumer can never claim them again.
 *
 * Source-pattern tests, same style as merchant-email-wiring.test.ts: they pin
 * the load-bearing shapes so a refactor that silently drops one fails here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

const dispatch = read("lib/bulk-email/dispatch.ts");
const bulkRoute = read("app/api/leads/bulk/route.ts");
const cronRoute = read("app/api/cron/dispatch-bulk-email/route.ts");
const vercel = read("vercel.json");

// ---- queue writer (app/api/leads/bulk) --------------------------------------

assert.match(
  bulkRoute,
  /import \{ BULK_EMAIL_SOURCE(?:, runDispatchBulkEmail)? \} from "@\/lib\/bulk-email\/dispatch"/,
  "the queue writer and the drain must share one source tag",
);
assert.match(
  bulkRoute,
  /agent_source: BULK_EMAIL_SOURCE/,
  "queued rows must carry the v2 tag — the legacy tag is drained by the VPS gateway whose credential is stale",
);
assert.doesNotMatch(
  bulkRoute,
  /agent_source: "dashboard_bulk_email"/,
  "no new rows may carry the legacy tag: the VPS drain would claim them and terminally fail them",
);
assert.doesNotMatch(
  bulkRoute,
  /publishAgentEvent/,
  "the email op must not nudge the VPS send_gateway — the cron is the only drain",
);
assert.match(
  bulkRoute,
  /const idCap = op === "email" \|\| op === "email_preflight" \? MAX_EMAIL_IDS : MAX_IDS/,
  "blast size must not be capped at the old per-id-loop bound; queueing is batched and cheap. The preflight shares the cap so it can answer for the same selection the send accepts.",
);
assert.match(
  bulkRoute,
  /for \(let i = 0; i < ids\.length; i \+= FETCH_CHUNK\)[\s\S]*?\.in\("id", chunk\)/,
  "record lookups must be chunked .in() fetches, not one round-trip per lead",
);
assert.match(
  bulkRoute,
  /for \(let i = 0; i < queueRows\.length; i \+= INSERT_CHUNK\)[\s\S]*?\.insert\(chunk\)/,
  "queue rows must be batch-inserted",
);
assert.match(
  bulkRoute,
  /canViewLead\(viewer, data, true, "isolate"\)/,
  "the per-record owner-or-admin gate must be enforced even when the rollout visibility flag is off",
);

// ---- drain (lib/bulk-email/dispatch.ts) -------------------------------------

assert.match(
  dispatch,
  /export const BULK_EMAIL_SOURCE = "dashboard_bulk_email_v2"/,
  "the v2 source tag is the contract between writer and drain",
);
assert.match(
  dispatch,
  /\.eq\("metadata->>status", fromStatus\)[\s\S]*?\.select\("id"\)/,
  "every state transition must be a CAS on metadata->>status with a returned row count",
);
assert.doesNotMatch(
  dispatch,
  /\.contains\(/,
  "object-containment filters are dead on the Turso adapter (json_each array semantics) — use metadata->>key",
);
assert.match(
  dispatch,
  /suppressionGate[\s\S]*?ilike\("email", pattern\)/,
  "every recipient must be re-checked against email_suppressions before SMTP",
);
assert.match(
  dispatch,
  /gate === "check_failed"[\s\S]*?requeueOrFail/,
  "a failed suppression lookup must fail CLOSED — requeue, never send blind",
);
assert.match(
  dispatch,
  /sendGmail\(\{[\s\S]*?brand: "sunbiz"[\s\S]*?listUnsubscribe: listUnsubscribeHeader\(toEmail, "SunBiz"\)[\s\S]*?retryTransient: false/,
  "sends must use the encrypted submissions App Password path with compliance headers and no in-request retry sleep",
);
assert.match(
  dispatch,
  /SUNBIZ_LEGAL_FOOTER/,
  "commercial bulk mail must carry the legal footer",
);
assert.match(
  dispatch,
  /AUTH_ERR\.test\(result\.error\)[\s\S]*?stoppedEarly = "smtp_auth_failed"[\s\S]*?break/,
  "an auth failure must stop the tick and leave the queue intact — one login probe per tick, never a hammering loop",
);
assert.match(
  dispatch,
  /THROTTLE_ERR\.test\(result\.error\)[\s\S]*?stoppedEarly = "smtp_throttled"[\s\S]*?break/,
  "a provider throttle must stop the tick, not burn the queue against it",
);
assert.match(
  dispatch,
  /status: "failed", send_error: result\.error\.slice\(0, 240\)[\s\S]*?out\.failed \+= 1;/,
  "a per-recipient failure must be recorded and the batch must continue",
);
// The per-recipient failure branch must NOT break the loop — only the two
// mailbox-level classes (auth, throttle) may end a tick early.
assert.strictEqual(
  (dispatch.match(/\bbreak;/g) || []).length,
  4,
  "exactly four early exits: send budget / time budget / auth failure / throttle",
);
assert.match(
  dispatch,
  /cap count failed — treating cap as reached/,
  "an uncountable daily ceiling must fail closed as a reached ceiling",
);
assert.match(
  dispatch,
  /attempts >= MAX_ATTEMPTS[\s\S]*?status: "failed"/,
  "a poison row must terminal-fail after MAX_ATTEMPTS instead of cycling forever",
);
assert.match(
  dispatch,
  /FRESHNESS_HOURS = 48[\s\S]*?status: "expired"/,
  "stale queued rows must expire unsent — a days-old blast must not resurrect",
);
assert.match(
  dispatch,
  /failStuckClaims[\s\S]*?STUCK_CLAIM_MINUTES \* 60_000[\s\S]*?send_error: "uncertain_delivery_after_claim"/,
  "claims orphaned by a crashed tick must terminal-fail as uncertain delivery — never requeue after a possible delivery (Codex P1 2026-08-18)",
);
assert.doesNotMatch(
  dispatch,
  /uncertain_delivery_after_claim[\s\S]*?status: "queued"/,
  "no path may requeue an orphaned claim",
);
assert.match(
  dispatch,
  /if \(result\.ok\) \{[\s\S]*?\.update\(sentPatch\)[\s\S]*?\.update\(sentPatch\)/,
  "the success audit must be an unconditional owned-row write with a retry, so a transient write failure cannot strand a delivered message on the resend path",
);

// ---- cron wiring -------------------------------------------------------------

assert.match(
  cronRoute,
  /checkCronAuth\(req\)[\s\S]*?runDispatchBulkEmail\(\)/,
  "the drain endpoint must sit behind the shared cron auth gate",
);
assert.match(
  vercel,
  /"path": "\/api\/cron\/dispatch-bulk-email",\s*"schedule": "\*\/5 \* \* \* \*"/,
  "the drain must be scheduled in vercel.json — without the cron entry nothing ever sends",
);

console.log("bulk-email dispatch tests passed");
