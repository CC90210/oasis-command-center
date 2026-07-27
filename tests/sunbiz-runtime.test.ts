import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canManageSunbizDraft, isSunbizDraftAction, isWithinSmsHours, normalizeDraftText } from "../lib/sunbiz-draft-policy";

for (const role of ["owner", "admin", "member", "loan_officer", "processor", " MEMBER "])
  assert.equal(canManageSunbizDraft(role), true);
for (const role of ["read_only", "guest", "", null, undefined])
  assert.equal(canManageSunbizDraft(role), false);
for (const action of ["approve", "edit_send", "reject", "pause", "resume", "handoff"])
  assert.equal(isSunbizDraftAction(action), true);
assert.equal(isSunbizDraftAction("send"), false);
assert.equal(normalizeDraftText(" hello "), "hello");
assert.equal(normalizeDraftText(""), null);
assert.equal(normalizeDraftText("x".repeat(1601)), null);
assert.equal(isWithinSmsHours("UTC", new Date("2026-01-01T12:00:00Z")), true);
assert.equal(isWithinSmsHours("UTC", new Date("2026-01-01T03:00:00Z")), false);
assert.equal(isWithinSmsHours("not/a-zone"), false);

const ingest = readFileSync("lib/integrations/texttorrent-ingest.ts", "utf8");
assert.ok(!/items\.filter\(\(m\) => !\(m\.unreadCount/.test(ingest));
assert.match(ingest, /provider_message_id:\s*textTorrentMessageFingerprint/);
const webhook = readFileSync("app/api/webhooks/texttorrent/sms-inbound/route.ts", "utf8");
assert.match(webhook, /error: "no_tenant_mapping"[\s\S]*status: 503/);
assert.match(webhook, /error: "suppression_failed"[\s\S]*status: 503/);
assert.match(webhook, /provider_message_id: providerMessageId/);
assert.match(webhook, /from\("texttorrent_inbound_work"\)/);
const route = readFileSync("app/api/conversations/drafts/[id]/route.ts", "utf8");
assert.match(route, /eq\("status", "pending"\).*select\("id"\)/s);
assert.match(route, /checkPhoneOptOut/);
const dispatcher = readFileSync("app/api/cron/dispatch-scheduled-sends/route.ts", "utf8");
assert.match(dispatcher, /from\("sunbiz_agent_accounts"\)[\s\S]*eq\("user_id", row\.actor_user_id\)/);
assert.match(dispatcher, /actAsEmail: identity\.data\.act_as_email/);
const collection = readFileSync("app/api/conversations/drafts/route.ts", "utf8");
assert.match(collection, /eq\("tenant_id", session\.tenantId\)/);
assert.match(collection, /eq\("thread_key", threadKey\)\.eq\("status", "pending"\)/);
assert.match(collection, /account\.data\.user_id !== session\.userId/);
const card = readFileSync("components/conversations/SunbizDraftCard.tsx", "utf8");
for (const action of ["approve", "edit_send", "reject", "pause", "resume"])
  assert.match(card, new RegExp(`\"${action}\"`));
const migration = readFileSync("database/127_sunbiz_agent_runtime.sql", "utf8");
for (const table of ["sunbiz_agent_accounts", "sunbiz_conversation_state", "sunbiz_reply_drafts",
  "sunbiz_processing_leases", "sunbiz_provider_rate_state", "texttorrent_inbound_work",
  "texttorrent_dead_letters"]) {
  assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
  assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`));
}
for (const rpc of ["claim_texttorrent_partition", "heartbeat_texttorrent_partition",
  "release_texttorrent_partition", "claim_texttorrent_inbound",
  "consume_texttorrent_rate_token", "suppress_texttorrent_inbound",
  "finalize_texttorrent_inbound", "approve_sunbiz_draft",
  "fail_texttorrent_inbound", "texttorrent_runtime_health"]) {
  assert.match(migration, new RegExp(`function public\\.${rpc}`));
}
assert.match(migration, /next_attempts := w\.attempts \+ 1/);
assert.match(migration, /insert into texttorrent_dead_letters[\s\S]*update texttorrent_inbound_work/);
assert.match(migration, /create table if not exists public\.sunbiz_phone_suppressions/);
assert.match(migration, /insert into sunbiz_phone_suppressions[\s\S]*update scheduled_sends set status='cancelled'/);
assert.match(migration, /qualification_state=sunbiz_conversation_state\.qualification_state \|\| excluded\.qualification_state/);
assert.match(migration, /insert into scheduled_sends[\s\S]*update sunbiz_reply_drafts set status='approved'/);

const suppression = readFileSync("lib/lead-interactions-queries.ts", "utf8");
assert.match(suppression, /from\("sunbiz_phone_suppressions"\)[\s\S]*eq\("tenant_id", tenantId\)/);
assert.match(dispatcher, /rate_priority: 80/);
assert.match(dispatcher, /daily_cap_check_failed/);
const ttClient = readFileSync("lib/integrations/texttorrent.ts", "utf8");
assert.match(ttClient, /consume_texttorrent_rate_token/);
assert.match(ttClient, /p_bucket: `\$\{creds\.tenantId\}:parent-sid`/);
assert.match(ttClient, /p_priority: opts\.priority \?\? 50/);
assert.match(migration, /effective_limit := greatest[\s\S]*when p_priority >= 90[\s\S]*p_limit - 20/);
assert.match(migration, /request_count < effective_limit/);
assert.match(migration, /inference_jobs add column if not exists next_attempt_at/);
assert.match(webhook, /approved: true[\s\S]*instructions: profile\.data\.compiled_prompt/);
assert.match(ingest, /work reconciliation failed/);
for (const column of ["account_id", "inbound_message", "conversation", "merchant_context",
  "voice_profile", "lease_owner", "next_attempt_at", "decision"])
  assert.match(migration, new RegExp(`\\b${column}\\b`));
for (const status of ["pending", "running", "drafted", "escalated", "suppressed", "dead_letter"])
  assert.match(migration, new RegExp(`'${status}'`));
console.log("sunbiz-runtime.test.ts: OK");
