/**
 * ai-audit-discovery.test.ts — phase 2 of the Free AI Audit: the discovery
 * call's transcripts and notes, and Gate 1 (CC authorizes the client's
 * information for processing), on a real libSQL file with the real migrations
 * (bravo__186, 206, 237, 238, 239).
 *
 * Pins:
 *   - a transcript exists only with recording consent; the same text twice is
 *     one transcript; its lines never change (database trigger); deleting it
 *     wipes the lines and the quotes taken from it, keeps the hash, and cannot
 *     be undone;
 *   - call notes save with a per-note version; a stale save is a conflict that
 *     returns the current text; unknown questions are refused;
 *   - Gate 1 binds the profile and transcripts by hash, with the consent and
 *     the engine (none without AI consent, whatever is asked); an edit
 *     withdraws a pending card; a changed profile or transcript makes the
 *     executor refuse; only the owner's approval freezes the profile and moves
 *     the engagement to Research & Audit Generation; after that the profile,
 *     notes and transcripts cannot change, and submission becomes possible.
 *
 * Run: node --conditions=react-server --import tsx tests/ai-audit-discovery.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Client } from "@libsql/client";
import { OASIS, USERS, check, finish, login, setupDatabase, setupProjectCustomers } from "./_delivery-harness";

for (const k of ["DASHBOARD_LIVE_SEND", "LIVE_SEND_EMAIL", "LIVE_SEND_AI_AUDIT", "LIVE_SEND_STRIPE_CHECKOUT", "BRAVO_FORCE_DRY_RUN"]) delete process.env[k];

const LEAD = "7b000000-0000-4000-8000-000000000001";
const NOW = () => new Date();

/** scripts/apply_turso_migration.py split_statements: a trigger body stays one statement. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  for (const line of sql.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("--")) continue;
    buf.push(line);
    const upper = stripped.toUpperCase();
    if (/\bBEGIN\b/.test(upper)) depth += 1;
    if (/\bEND\s*;/.test(upper)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        out.push(buf.join("\n").trim().replace(/;$/, "").trim());
        buf = [];
        continue;
      }
    }
    if (depth === 0 && stripped.endsWith(";")) {
      out.push(buf.join("\n").trim().replace(/;$/, "").trim());
      buf = [];
    }
  }
  const tail = buf.join("\n").trim().replace(/;$/, "").trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

async function apply(db: Client, file: string) {
  for (const stmt of splitStatements(readFileSync(join(process.cwd(), "database", "turso", file), "utf8"))) await db.execute(stmt);
}

async function main() {
  const db = await setupDatabase();
  await setupProjectCustomers(db);
  for (const f of ["bravo__186_os_approvals.sql", "bravo__206_tool_jobs.sql", "bravo__237_ai_audit_core.sql", "bravo__238_ai_audit_delivery.sql", "bravo__239_ai_audit_discovery.sql"]) await apply(db, f);
  await db.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [LEAD, OASIS, JSON.stringify({ stage: "qualified", company: "[TEST] OASIS Audit Fixture Co", name: "Test Owner", email: "owner@fixture.test" })],
  });

  const store = await import("../lib/ai-audit/store");
  const lifecycle = await import("../lib/ai-audit/lifecycle");
  const versions = await import("../lib/ai-audit/versions");
  const tr = await import("../lib/ai-audit/transcript");
  const transcripts = await import("../lib/ai-audit/transcripts");
  const notes = await import("../lib/ai-audit/call-notes");
  const authorize = await import("../lib/ai-audit/authorize");
  const delivery = await import("../lib/ai-audit/delivery");
  const execute = await import("../lib/os/approvals/execute");
  const executors = await import("../lib/os/approvals/executors");
  const approvals = await import("../lib/os/approvals/store");
  const rules = await import("../lib/ai-audit/rules");
  const payloads = await import("../lib/ai-audit/authorize-payload");

  const cc = { type: "user" as const, id: USERS.cc.id };
  const opened = await store.openEngagement(db, { tenantId: OASIS, leadId: LEAD, actor: cc, now: NOW(), isFixture: true });
  assert.ok(opened.ok);
  const id = opened.ok ? opened.engagement.id : "";
  assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: id, to: "call_scheduled", actor: cc, now: NOW() })).ok);

  const parsed = (text: string) => {
    const r = tr.parseTranscriptText(text);
    assert.ok(r.ok);
    return r.ok ? r.value : (null as never);
  };
  const consent = (ai: boolean) => ({ recording: true, ai, basis: "owner_attested" as const, by: USERS.cc.id });

  console.log("transcripts");
  let transcriptId = "";
  await check("a transcript needs recording consent; the first one marks the call completed; the same text twice is one", async () => {
    const t = parsed("Dana: We get about 40 calls a week.\nCC: How do you know?\nDana: The phone log, roughly.");
    const refused = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: id, parsed: t, source: "paste", consent: { ...consent(true), recording: false }, actor: cc, now: NOW() });
    assert.deepEqual(refused, { ok: false, error: "no_recording_consent" });
    const a = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: id, parsed: t, source: "paste", consent: consent(true), actor: cc, now: NOW() });
    assert.ok(a.ok && !a.duplicate);
    transcriptId = a.ok ? a.transcript.id : "";
    assert.equal((await store.getEngagement(db, OASIS, id))!.stage, "call_completed", "the call evidently happened");
    const b = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: id, parsed: t, source: "paste", consent: consent(true), actor: cc, now: NOW() });
    assert.ok(b.ok && b.duplicate && b.transcript.id === transcriptId);
  });
  await check("a transcript's lines never change; only a delete may wipe them", async () => {
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_transcripts SET lines_json = '[]' WHERE id = ?", args: [transcriptId] }), /frozen/);
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_transcripts SET consent_ai = 0 WHERE id = ?", args: [transcriptId] }), /frozen/);
  });

  console.log("call notes");
  await check("notes save per question with their own version; a stale save is a conflict that returns the current text", async () => {
    const first = await notes.saveCallNote(db, { tenantId: OASIS, engagementId: id, questionId: "sales-sources", notes: "Mostly Google, some referrals", expectedVersion: 0, actor: cc, now: NOW() });
    assert.ok(first.ok && first.note.row_version === 1);
    const second = await notes.saveCallNote(db, { tenantId: OASIS, engagementId: id, questionId: "sales-sources", notes: "Mostly Google, some referrals, ~40 a month", expectedVersion: 1, actor: cc, now: NOW() });
    assert.ok(second.ok && second.note.row_version === 2);
    const stale = await notes.saveCallNote(db, { tenantId: OASIS, engagementId: id, questionId: "sales-sources", notes: "overwrite", expectedVersion: 1, actor: cc, now: NOW() });
    assert.ok(!stale.ok && stale.error === "conflict" && "current" in stale && stale.current.notes.includes("40 a month"));
    const unknown = await notes.saveCallNote(db, { tenantId: OASIS, engagementId: id, questionId: "made-up", notes: "x", expectedVersion: 0, actor: cc, now: NOW() });
    assert.deepEqual(unknown, { ok: false, error: "unknown_question" });
  });
  await check("the call's clock starts and ends", async () => {
    const s = await notes.markCall(db, { tenantId: OASIS, engagementId: id, what: "start", actor: cc, now: NOW() });
    assert.ok(s.ok && s.engagement.call_started_at && !s.engagement.call_ended_at);
    const e = await notes.markCall(db, { tenantId: OASIS, engagementId: id, what: "end", actor: cc, now: NOW() });
    assert.ok(e.ok && e.engagement.call_ended_at);
  });

  console.log("Gate 1");
  const field = (key: string, value: unknown, extra: Record<string, unknown> = {}) =>
    versions.saveProfileField(db, { tenantId: OASIS, engagementId: id, field: { field_key: key, value, label: "client_reported", source_type: "call_notes", ...extra } as never, actor: cc, now: NOW() });
  let firstCard = "";
  await check("Gate 1 binds the profile and transcripts by hash; asking again for the same state gives the same card", async () => {
    await field("sales.leads_per_month", 40);
    // As extraction will write it: the value cites its transcript line and keeps a short quote.
    const draft = (await store.getEngagement(db, OASIS, id))!.current_profile_version_id;
    await db.execute({ sql: "UPDATE ai_audit_profile_fields SET source_type = 'transcript', evidence_quote = 'about 40 calls a week', source_ref = ? WHERE profile_version_id = ? AND field_key = 'sales.leads_per_month'", args: [JSON.stringify({ transcript_id: transcriptId, from: 1, to: 1 }), draft] });
    await field("consent.recording", true);
    await field("consent.ai_processing", true);
    const r = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: id, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(r.ok && r.created, !r.ok ? r.error : "");
    firstCard = r.ok ? r.approvalId : "";
    const e = (await store.getEngagement(db, OASIS, id))!;
    assert.equal(e.stage, "transcript_review");
    assert.equal(e.authorization_approval_id, firstCard);
    const a = (await approvals.getApprovalInTenant(db, OASIS, firstCard))!;
    assert.equal(a.action_kind, "authorize_ai_audit");
    assert.equal(a.risk_level, "data");
    assert.equal(a.department_key, null, "only owners and admins see it");
    const p = approvals.parsePayload(a);
    assert.equal(p.engine, "mac_claude");
    assert.equal(p.consent_ai, true);
    assert.equal(p.transcript_count, 1);
    assert.match(String(p.transcripts_sha256), /^[0-9a-f]{64}$/);
    const again = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: id, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(again.ok && !again.created && again.approvalId === firstCard);
  });
  await check("an edit withdraws the pending card; asking again files a revision", async () => {
    await field("sales.close_rate_pct", 50);
    await authorize.withdrawAuthorization(db, OASIS, (await store.getEngagement(db, OASIS, id))!, cc, NOW());
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, firstCard))!.status, "cancelled");
    const r = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: id, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(r.ok && r.created && r.approvalId !== firstCard);
    const revised = (await approvals.getApprovalInTenant(db, OASIS, r.ok ? r.approvalId : ""))!;
    assert.equal(revised.revision, 2);
  });
  const approveAs = async (approvalId: string, who: { id: string; email: string }) => {
    await db.execute({ sql: "UPDATE approvals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status IN ('pending', 'failed')", args: [who.id, new Date().toISOString(), approvalId] });
    return execute.executeApproval(db, { tenantId: OASIS, approvalId, approver: { userId: who.id, email: who.email } }, executors.defaultExecutorDeps() as never);
  };
  await check("a profile that changed behind the card is refused: nothing frozen, nothing moved", async () => {
    const e = (await store.getEngagement(db, OASIS, id))!;
    // A write that skipped the route's withdrawal (another path, a bug): the executor must catch it.
    await db.execute({
      sql: "INSERT INTO ai_audit_profile_fields (id, tenant_id, profile_version_id, field_key, value_json, label, source_type, source_ref, updated_at) VALUES ('sneak', ?, ?, 'sales.avg_job_value', '2000', 'client_reported', 'call_notes', '{}', ?)",
      args: [OASIS, e.current_profile_version_id, new Date().toISOString()],
    });
    const r = await approveAs(e.authorization_approval_id!, USERS.cc);
    assert.equal(r.ok && r.approval.status, "failed");
    assert.equal(r.ok && (r.approval.execution_result as { reason?: string } | null)?.reason, "payload_changed");
    const after = (await store.getEngagement(db, OASIS, id))!;
    assert.equal(after.stage, "transcript_review");
    assert.equal((await versions.getProfileVersion(db, OASIS, after.current_profile_version_id!))!.status, "draft");
  });
  await check("without the client's AI consent the card names no AI engine, whatever is asked", async () => {
    await field("consent.ai_processing", false);
    const r = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: id, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const p = approvals.parsePayload((await approvals.getApprovalInTenant(db, OASIS, r.ok ? r.approvalId : ""))!);
    assert.equal(p.engine, "none");
    assert.equal(p.consent_ai, false);
    await field("consent.ai_processing", true);
  });
  await check("an admin who is not the owner cannot pass Gate 1", async () => {
    const r = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: id, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(r.ok);
    const out = await approveAs(r.ok ? r.approvalId : "", USERS.admin);
    assert.equal(out.ok && (out.approval.execution_result as { reason?: string } | null)?.reason, "owner_only");
    assert.equal((await store.getEngagement(db, OASIS, id))!.stage, "transcript_review");
  });
  await check("a card that ended is never handed back as new; a save that changes nothing leaves a pending card alone (review F1)", async () => {
    // The admin's refused card above ended as failed: asking again for the same information files a FRESH card.
    const e0 = (await store.getEngagement(db, OASIS, id))!;
    const failedId = e0.authorization_approval_id!;
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, failedId))!.status, "failed");
    const fresh = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: id, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(fresh.ok && fresh.created && fresh.approvalId !== failedId, "a dead card is not success");
    const card = (await approvals.getApprovalInTenant(db, OASIS, fresh.ok ? fresh.approvalId : ""))!;
    assert.match(card.idempotency_key, /:retry-\d+$/);
    // Saving a field to the value it already has changes nothing the card binds: the card stays pending.
    await versions.saveProfileField(db, { tenantId: OASIS, engagementId: id, field: { field_key: "sales.close_rate_pct", value: 50, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    assert.equal(await authorize.withdrawAuthorizationIfStale(db, OASIS, id, cc, NOW()), false);
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, card.id))!.status, "pending");
    // A real change withdraws it.
    await versions.saveProfileField(db, { tenantId: OASIS, engagementId: id, field: { field_key: "sales.close_rate_pct", value: 45, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    assert.equal(await authorize.withdrawAuthorizationIfStale(db, OASIS, id, cc, NOW()), true);
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, card.id))!.status, "cancelled");
  });
  await check("the owner's approval freezes the profile and opens Research & Audit Generation; submission now passes Gate 1", async () => {
    const r = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: id, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    const out = await approveAs(r.ok ? r.approvalId : "", USERS.cc);
    assert.equal(out.ok && (out.approval.execution_result as { outcome?: string } | null)?.outcome, "authorized");
    const e = (await store.getEngagement(db, OASIS, id))!;
    assert.equal(e.stage, "generating");
    assert.equal(e.engine, "mac_claude");
    const v = (await versions.getProfileVersion(db, OASIS, e.current_profile_version_id!))!;
    assert.equal(v.status, "frozen");
    assert.match(String(v.transcript_sha256), /^[0-9a-f]{64}$/);
    const authed = await authorize.authorizedProfile(db, OASIS, e);
    assert.ok(authed && authed.engine === "mac_claude" && authed.versionId === v.id);
    // Submission no longer refuses on Gate 1 (it refuses later, on the missing drafts).
    const sub = await delivery.submitForFinalApproval(db, { tenantId: OASIS, engagementId: id, expectedRowVersion: e.row_version, actor: cc, now: NOW() });
    assert.ok(!sub.ok && sub.error === "no_audit_draft", !sub.ok ? sub.error : "");
  });
  await check("moved back to correct the profile, nothing is authorized until CC approves again (review F4)", async () => {
    const e = (await store.getEngagement(db, OASIS, id))!;
    assert.ok(await authorize.authorizedProfile(db, OASIS, e), "authorized while in Research & Audit Generation");
    const back = await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: id, to: "transcript_review", actor: cc, now: NOW() });
    assert.ok(back.ok);
    assert.equal(await authorize.authorizedProfile(db, OASIS, back.ok ? back.engagement : e), null);
    const fwd = await db.execute({ sql: "UPDATE ai_audit_engagements SET stage = 'generating', row_version = row_version + 1 WHERE id = ?", args: [id] });
    assert.equal(fwd.rowsAffected, 1);
  });
  await check("after Gate 1 the profile, the notes and the transcripts cannot change", async () => {
    await assert.rejects(field("sales.leads_per_month", 400), /frozen/);
    const n = await notes.saveCallNote(db, { tenantId: OASIS, engagementId: id, questionId: "sales-sources", notes: "late edit", expectedVersion: 2, actor: cc, now: NOW() });
    assert.deepEqual(n, { ok: false, error: "stage_closed" });
    const t = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: id, parsed: parsed("Dana: one more thing"), source: "paste", consent: consent(true), actor: cc, now: NOW() });
    assert.deepEqual(t, { ok: false, error: "stage_closed" });
  });
  await check("deleting a transcript wipes its lines and the profile's quotes from it, keeps its hash, and cannot be undone", async () => {
    const e = (await store.getEngagement(db, OASIS, id))!;
    const before = (await transcripts.getTranscript(db, OASIS, transcriptId))!;
    const d = await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: id, id: transcriptId, actor: cc, now: NOW() });
    assert.deepEqual(d, { ok: true });
    const after = (await transcripts.getTranscript(db, OASIS, transcriptId))!;
    assert.equal(after.status, "deleted");
    assert.deepEqual(after.lines, []);
    assert.equal(after.text_sha256, before.text_sha256);
    const q = await db.execute({ sql: "SELECT evidence_quote, value_json FROM ai_audit_profile_fields WHERE profile_version_id = ? AND field_key = 'sales.leads_per_month'", args: [e.current_profile_version_id] });
    assert.equal(q.rows[0].evidence_quote, null, "the quote went, on a frozen profile too");
    assert.equal(String(q.rows[0].value_json), "40", "the authorized value stays");
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_transcripts SET status = 'active' WHERE id = ?", args: [transcriptId] }), /deleted/);
  });

  console.log("review of phase 2: what Gate 1 binds, and when it stops holding");
  let leadN = 10;
  const freshEngagement = async (name: string) => {
    leadN += 1;
    const lead = `7b000000-0000-4000-8000-0000000000${String(leadN).padStart(2, "0")}`;
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [lead, OASIS, JSON.stringify({ stage: "qualified", company: `[TEST] ${name}`, name: "Test Owner", email: `owner+${leadN}@fixture.test` })],
    });
    const o = await store.openEngagement(db, { tenantId: OASIS, leadId: lead, actor: cc, now: NOW(), isFixture: true });
    assert.ok(o.ok);
    const eid = o.ok ? o.engagement.id : "";
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "call_scheduled", actor: cc, now: NOW() })).ok);
    const t = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: eid, parsed: parsed(`Dana: ${name} gets about 40 calls a week.`), source: "paste", consent: consent(true), actor: cc, now: NOW() });
    assert.ok(t.ok);
    const f = (key: string, value: unknown) =>
      versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: key, value, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    await f("sales.leads_per_month", 40);
    await f("consent.recording", true);
    await f("consent.ai_processing", true);
    return { eid, transcriptId: t.ok ? t.transcript.id : "" };
  };
  const fileCard = async (eid: string) => {
    const r = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(r.ok, !r.ok ? r.error : "");
    return r.ok ? r.approvalId : "";
  };
  const resultOf = (out: Awaited<ReturnType<typeof approveAs>>) => (out.ok ? (out.approval.execution_result as { reason?: string; outcome?: string } | null) : null);
  const engagementOf = async (eid: string) => (await store.getEngagement(db, OASIS, eid))!;
  const eventCount = async (eid: string, event: string) =>
    Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM ai_audit_events WHERE engagement_id = ? AND event = ?", args: [eid, event] })).rows[0].n);
  const route = await import("../app/api/ai-audit/[engagementId]/route");
  const transcriptRoute = await import("../app/api/ai-audit/[engagementId]/transcript/route");
  const params = (eid: string) => ({ params: Promise.resolve({ engagementId: eid }) });
  const postJson = (url: string, body: Record<string, unknown>) => {
    const r = new Request(url, { method: "POST", headers: { "content-type": "application/json", origin: "http://t.test" }, body: JSON.stringify(body) }) as Request & { nextUrl: URL };
    Object.defineProperty(r, "nextUrl", { value: new URL(url) });
    return r as never;
  };
  const getUrl = (url: string) => {
    const r = new Request(url) as Request & { nextUrl: URL };
    Object.defineProperty(r, "nextUrl", { value: new URL(url) });
    return r as never;
  };

  await check("the card binds CC's call notes: a note changed behind it is refused, and a real change withdraws it on the record (review F3)", async () => {
    const { eid } = await freshEngagement("Notes Co");
    assert.ok((await notes.saveCallNote(db, { tenantId: OASIS, engagementId: eid, questionId: "sales-sources", notes: "Mostly Google", expectedVersion: 0, actor: cc, now: NOW() })).ok);
    const a = await fileCard(eid);
    const p = approvals.parsePayload((await approvals.getApprovalInTenant(db, OASIS, a))!);
    assert.equal(p.note_count, 1);
    assert.match(String(p.notes_sha256), /^[0-9a-f]{64}$/);
    // Saved without the route's withdrawal (another path, a bug): the executor catches it.
    assert.ok((await notes.saveCallNote(db, { tenantId: OASIS, engagementId: eid, questionId: "biz-what", notes: "A note added after the card was filed", expectedVersion: 0, actor: cc, now: NOW() })).ok);
    assert.equal(resultOf(await approveAs(a, USERS.cc))?.reason, "payload_changed");
    assert.equal((await engagementOf(eid)).stage, "transcript_review");
    const b = await fileCard(eid);
    assert.ok((await notes.saveCallNote(db, { tenantId: OASIS, engagementId: eid, questionId: "biz-what", notes: "Changed again", expectedVersion: 1, actor: cc, now: NOW() })).ok);
    assert.equal(await authorize.withdrawAuthorizationIfStale(db, OASIS, eid, cc, NOW()), true);
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, b))!.status, "cancelled");
    assert.equal(await eventCount(eid, "authorization_withdrawn"), 1);
  });
  await check("the card binds the business's name and type; after Gate 1 only the contact may change (review F3)", async () => {
    const { eid } = await freshEngagement("Details Co");
    const a = await fileCard(eid);
    const e = await engagementOf(eid);
    assert.ok((await store.patchEngagement(db, { tenantId: OASIS, id: eid, expectedRowVersion: e.row_version, patch: { business_name: "Totally Different Co" }, event: "details_saved", actor: cc, now: NOW() })).ok);
    assert.equal(resultOf(await approveAs(a, USERS.cc))?.reason, "payload_changed");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    await login(USERS.cc);
    const rv = (await engagementOf(eid)).row_version;
    const frozen = await route.POST(postJson(`http://t.test/api/ai-audit/${eid}`, { action: "save_details", expected_row_version: rv, business_name: "Renamed After Gate" }), params(eid));
    assert.equal(frozen.status, 409);
    assert.equal(((await frozen.json()) as { error?: string }).error, "details_frozen");
    const contact = await route.POST(postJson(`http://t.test/api/ai-audit/${eid}`, { action: "save_details", expected_row_version: rv, contact_email: "new-contact@fixture.test" }), params(eid));
    assert.equal(contact.status, 200, JSON.stringify(await contact.clone().json()));
    assert.equal((await engagementOf(eid)).contact_email, "new-contact@fixture.test");
    // As the screen sends it: every field, the business type left out because nobody chose one (CodeRabbit on #733).
    const e2 = await engagementOf(eid);
    const asScreen = await route.POST(
      postJson(`http://t.test/api/ai-audit/${eid}`, { action: "save_details", expected_row_version: e2.row_version, business_name: e2.business_name, contact_name: "Dana Lee", contact_email: "dana@fixture.test" }),
      params(eid),
    );
    assert.equal(asScreen.status, 200, JSON.stringify(await asScreen.clone().json()));
    assert.equal((await engagementOf(eid)).business_type, null, "no type was invented");
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)), "a new contact does not touch the authorization");
    await login(null);
  });
  await check("a transcript added while the card waits makes the executor refuse (review F3)", async () => {
    const { eid } = await freshEngagement("Late Transcript Co");
    const a = await fileCard(eid);
    const t2 = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: eid, parsed: parsed("Dana: Actually the client did not agree to any AI."), source: "paste", consent: consent(false), actor: cc, now: NOW() });
    assert.ok(t2.ok);
    assert.equal(resultOf(await approveAs(a, USERS.cc))?.reason, "payload_changed");
    assert.equal((await engagementOf(eid)).stage, "transcript_review");
  });
  await check("an edit that began before Gate 1 cannot open a new draft behind the frozen profile (review F3)", async () => {
    const { eid } = await freshEngagement("Race Co");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const e = await engagementOf(eid);
    await assert.rejects(versions.ensureDraftProfile(db, OASIS, eid, cc, NOW()), /frozen/);
    // The write carries the stage check itself, so an engagement read before Gate 1 changes nothing after it.
    const stmt = store.engagementUpdateStatement(OASIS, eid, e.row_version, { current_profile_version_id: "sneaky-draft" }, NOW().toISOString(), undefined, rules.PROFILE_EDIT_STAGES);
    assert.equal((await db.execute(stmt)).rowsAffected, 0);
    assert.equal((await engagementOf(eid)).current_profile_version_id, e.current_profile_version_id);
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)));
  });
  await check("declined, or a transcript deleted after Gate 1: nothing is authorized any more, and the trail says why (review F4)", async () => {
    const one = await freshEngagement("Delete After Gate Co");
    assert.equal(resultOf(await approveAs(await fileCard(one.eid), USERS.cc))?.outcome, "authorized");
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(one.eid)));
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: one.eid, id: one.transcriptId, actor: cc, now: NOW() }), { ok: true });
    assert.equal(await authorize.authorizedProfile(db, OASIS, await engagementOf(one.eid)), null);
    assert.equal(await eventCount(one.eid, "authorization_voided"), 1);

    const two = await freshEngagement("Declined After Gate Co");
    assert.equal(resultOf(await approveAs(await fileCard(two.eid), USERS.cc))?.outcome, "authorized");
    const declined = await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: two.eid, to: "declined", actor: cc, now: NOW() });
    assert.ok(declined.ok, !declined.ok ? declined.error : "");
    assert.equal(await authorize.authorizedProfile(db, OASIS, await engagementOf(two.eid)), null);
  });
  await check("moved back after Gate 1, CC can authorize again: the frozen profile is copied into a new draft (review F1)", async () => {
    const { eid } = await freshEngagement("Move Back Co");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const frozenId = (await engagementOf(eid)).current_profile_version_id!;
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "transcript_review", actor: cc, now: NOW() })).ok);
    const again = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(again.ok && again.created, !again.ok ? again.error : "");
    const e = await engagementOf(eid);
    assert.notEqual(e.current_profile_version_id, frozenId);
    const draft = (await versions.getProfileVersion(db, OASIS, e.current_profile_version_id!))!;
    assert.deepEqual([draft.status, draft.version_no], ["draft", 2]);
    assert.equal((await versions.listProfileFields(db, OASIS, draft.id)).length, (await versions.listProfileFields(db, OASIS, frozenId)).length);
    assert.equal(resultOf(await approveAs(again.ok ? again.approvalId : "", USERS.cc))?.outcome, "authorized");
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)));
  });
  await check("only the owner deletes a transcript; another founder's consent is labelled theirs on the card; the stored lines read back (review F9)", async () => {
    const { eid, transcriptId: tid } = await freshEngagement("Owner Delete Co");
    await login(USERS.admin);
    const refused = await route.POST(postJson(`http://t.test/api/ai-audit/${eid}`, { action: "delete_transcript", transcript_id: tid }), params(eid));
    assert.equal(refused.status, 403);
    assert.equal((await transcripts.getTranscript(db, OASIS, tid))!.status, "active");
    const added = await transcriptRoute.POST(
      postJson(`http://t.test/api/ai-audit/${eid}/transcript`, { text: "Dana: added by the admin, my password is Summer2024x", source: "paste", consent_recording: true, consent_ai: true }),
      params(eid),
    );
    assert.equal(added.status, 200, JSON.stringify(await added.clone().json()));
    const addedId = ((await added.json()) as { transcript: { id: string } }).transcript.id;
    const row = (await transcripts.getTranscript(db, OASIS, addedId))!;
    assert.deepEqual([row.consent_basis, row.consent_by], ["founder_attested", USERS.admin.id]);
    const got = await transcriptRoute.GET(getUrl(`http://t.test/api/ai-audit/${eid}/transcript?id=${addedId}`), params(eid));
    assert.equal(got.status, 200);
    const lines = ((await got.json()) as { transcript: { lines: Array<{ text: string }> } }).transcript.lines;
    assert.equal(lines.length, 1);
    assert.ok(lines[0].text.includes("[removed: possible password or account detail]") && !lines[0].text.includes("Summer2024x"));
    const elsewhere = await transcriptRoute.GET(getUrl(`http://t.test/api/ai-audit/${id}/transcript?id=${addedId}`), params(id));
    assert.equal(elsewhere.status, 404, "a transcript is read only through its own engagement");
    const p = approvals.parsePayload((await approvals.getApprovalInTenant(db, OASIS, await fileCard(eid)))!);
    assert.deepEqual([p.founder_attested, p.redaction_count], [true, 1]);
    const preview = payloads.authorizeAiAuditPreview(p);
    assert.match(preview, /attested by a founder other than you/);
    assert.match(preview, /1 possible password or account detail was taken out/);
    assert.match(preview, /Read the stored lines/);
    await login(USERS.cc);
    const deleted = await route.POST(postJson(`http://t.test/api/ai-audit/${eid}`, { action: "delete_transcript", transcript_id: tid }), params(eid));
    assert.equal(deleted.status, 200);
    assert.equal((await transcripts.getTranscript(db, OASIS, tid))!.status, "deleted");
    await login(null);
  });
  await check("the database refuses a delete that keeps the lines; a delete wipes the file name and speakers' names (review F10)", async () => {
    const { eid } = await freshEngagement("Wipe Co");
    const r = await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: eid, parsed: parsed("Jane Roe: hello\nCC: hi"), source: "upload", filename: "Call with Jane Roe 2.txt", consent: consent(true), actor: cc, now: NOW() });
    assert.ok(r.ok);
    const tid = r.ok ? r.transcript.id : "";
    assert.deepEqual((await transcripts.getTranscript(db, OASIS, tid))!.speakers, ["Jane Roe", "CC"]);
    await assert.rejects(db.execute({ sql: "UPDATE ai_audit_transcripts SET status = 'deleted' WHERE id = ?", args: [tid] }), /frozen/);
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: tid, actor: cc, now: NOW() }), { ok: true });
    const gone = (await transcripts.getTranscript(db, OASIS, tid))!;
    assert.deepEqual([gone.status, gone.filename, gone.speakers, gone.lines], ["deleted", null, [], []]);
  });
  await check("a note is scrubbed like a transcript; the same text again is no conflict; a closing save lands on top of one still out (review F2, F5)", async () => {
    const { eid } = await freshEngagement("Notes Protocol Co");
    const save = (questionId: string, text: string, expectedVersion: number, afterText?: string) =>
      notes.saveCallNote(db, { tenantId: OASIS, engagementId: eid, questionId, notes: text, expectedVersion, afterText, actor: cc, now: NOW() });
    const a = await save("tech-tools", "Admin login\npassword: Summer2024x", 0);
    assert.ok(a.ok && a.note.notes === "Admin login\npassword: [removed: possible password or account detail]", a.ok ? a.note.notes : "");
    const same = await save("tech-tools", "Admin login\npassword: Summer2024x", 0);
    assert.ok(same.ok && same.note.row_version === 1, "a repeat of what is stored is a success, not a conflict");
    // The save that was out lands first, then the closing save that names it.
    assert.ok((await save("sales-sources", "x", 0)).ok);
    const onTop = await save("sales-sources", "xy", 0, "x");
    assert.ok(onTop.ok && onTop.note.notes === "xy" && onTop.note.row_version === 2);
    // The closing save lands first; the older one, arriving after, changes nothing.
    const early = await save("sales-conversion", "ab", 0, "a");
    assert.ok(early.ok && early.note.notes === "ab");
    const late = await save("sales-conversion", "a", 0);
    assert.ok(!late.ok && late.error === "conflict");
    assert.equal((await notes.listCallNotes(db, OASIS, eid)).find((n) => n.question_id === "sales-conversion")!.notes, "ab");
  });
  await check("an expired card is never handed back; asking again files a fresh one (Codex review of phase 2)", async () => {
    const { eid } = await freshEngagement("Expired Card Co");
    const a = await fileCard(eid);
    await db.execute({ sql: "UPDATE approvals SET expires_at = ? WHERE id = ?", args: [new Date(Date.now() - 60_000).toISOString(), a] });
    const again = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(again.ok && again.created && again.approvalId !== a, "a fresh card, not the expired one");
  });
  await check("a field delete on a profile frozen in between removes nothing (Codex review of phase 2)", async () => {
    const { eid } = await freshEngagement("Delete Race Co");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const e = await engagementOf(eid);
    const before = (await versions.listProfileFields(db, OASIS, e.current_profile_version_id!)).length;
    const r = await db.execute(versions.deleteDraftFieldStatement(OASIS, e.current_profile_version_id!, "sales.leads_per_month"));
    assert.equal(r.rowsAffected, 0);
    assert.equal((await versions.listProfileFields(db, OASIS, e.current_profile_version_id!)).length, before);
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)), "the authorization still holds");
  });
  await check("a transcript deleted after Gate 1 takes a waiting final approval out of Needs you (Codex review of phase 2)", async () => {
    const { eid, transcriptId: tid } = await freshEngagement("Voided Delivery Co");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const e = await engagementOf(eid);
    const payload = {
      engagement_id: eid, lead_id: e.lead_id, business_name: "Voided Delivery Co", audit_version_id: "ver-voided", audit_sha256: "a".repeat(64),
      proposal_version_id: "prop-voided", proposal_sha256: "b".repeat(64), pdf_sha256: "c".repeat(64), to: "owner@fixture.test",
      subject: "Your audit", body: "Hi\n\n{{audit_link}}", currency: "CAD", total_cents: 100, due_now_cents: 100,
    };
    const card = await approvals.createApproval(
      db,
      { tenantId: OASIS, departmentKey: null, requestedBy: { type: "routine", id: "ai-audit" }, actionKind: "deliver_ai_audit", title: "Deliver", payload, riskLevel: "spend", idempotencyKey: `voided-delivery:${eid}` },
      NOW(),
    );
    assert.ok(card.ok, !card.ok ? card.error : "");
    assert.ok((await store.patchEngagement(db, { tenantId: OASIS, id: eid, expectedRowVersion: e.row_version, patch: { delivery_approval_id: card.ok ? card.approval.id : null }, event: "test_link_card", actor: cc, now: NOW() })).ok);
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: tid, actor: cc, now: NOW() }), { ok: true });
    assert.equal((await approvals.getApprovalInTenant(db, OASIS, card.ok ? card.approval.id : ""))!.status, "cancelled");
  });
  await check("while the audit email is going out, a transcript delete and a stage move wait their turn; a send that never finished stops holding them after 15 minutes (Codex review of phase 2, second pass)", async () => {
    const { eid, transcriptId: tid } = await freshEngagement("In Flight Co");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const e = await engagementOf(eid);
    const payload = {
      engagement_id: eid, lead_id: e.lead_id, business_name: "In Flight Co", audit_version_id: "ver-flight", audit_sha256: "a".repeat(64),
      proposal_version_id: "prop-flight", proposal_sha256: "b".repeat(64), pdf_sha256: "c".repeat(64), to: "owner@fixture.test",
      subject: "Your audit", body: "Hi\n\n{{audit_link}}", currency: "CAD", total_cents: 100, due_now_cents: 100,
    };
    const card = await approvals.createApproval(
      db,
      { tenantId: OASIS, departmentKey: null, requestedBy: { type: "routine", id: "ai-audit" }, actionKind: "deliver_ai_audit", title: "Deliver", payload, riskLevel: "spend", idempotencyKey: `in-flight:${eid}` },
      NOW(),
    );
    assert.ok(card.ok, !card.ok ? card.error : "");
    const cardId = card.ok ? card.approval.id : "";
    // What the approvals executor's claim leaves while the send runs.
    const claimedAt = new Date();
    await db.execute({ sql: "UPDATE approvals SET status = 'executing', executing_at = ? WHERE tenant_id = ? AND id = ?", args: [claimedAt.toISOString(), OASIS, cardId] });
    assert.equal(await store.deliveryInFlight(db, OASIS, eid, claimedAt), true);
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: tid, actor: cc, now: claimedAt }), { ok: false, error: "delivery_in_progress" });
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)), "the authorization the send checked still holds");
    const before = await engagementOf(eid);
    const moved = await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "cancelled", actor: cc, now: claimedAt, expectedRowVersion: before.row_version, event: "stage_set_by_owner", unlessDeliveryInFlight: true });
    assert.equal(moved.ok ? "moved" : moved.error, "delivery_in_progress");
    assert.equal((await engagementOf(eid)).stage, before.stage);
    // A send that crashed mid-way is never re-run (execute.ts); after 15 minutes its mark holds nothing back.
    const later = new Date(claimedAt.getTime() + store.DELIVERY_IN_FLIGHT_MS + 60_000);
    assert.equal(await store.deliveryInFlight(db, OASIS, eid, later), false);
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: tid, actor: cc, now: later }), { ok: true });
  });
  await check("a Gate 1 card filed but never linked (the write after it was interrupted) is linked by the next request, not filed again (Codex review of phase 2, third pass)", async () => {
    const { eid } = await freshEngagement("Unlinked Card Co");
    const first = await fileCard(eid);
    // New information, so the next request files a revision; the write that points the engagement at it fails once.
    await versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: "business.team_size", value: 7, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    await db.execute("CREATE TRIGGER fail_card_link BEFORE UPDATE OF authorization_approval_id ON ai_audit_engagements BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    let threw = false;
    try {
      await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    } catch {
      threw = true;
    } finally {
      await db.execute("DROP TRIGGER fail_card_link");
    }
    assert.ok(threw, "the link write failed");
    assert.equal((await engagementOf(eid)).authorization_approval_id, first, "still pointing at the first card");
    const again = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(again.ok, !again.ok ? again.error : "");
    assert.ok(again.ok && !again.created && again.approvalId !== first, "the card already filed is the one handed back");
    assert.equal((await engagementOf(eid)).authorization_approval_id, again.ok ? again.approvalId : "", "and the engagement points at it now");
    assert.equal(resultOf(await approveAs(again.ok ? again.approvalId : "", USERS.cc))?.outcome, "authorized", "and it can be approved");
  });
  await check("a card filed but never linked that then expired is revised by the next request, never a dead end (Codex review of phase 2, fifth pass)", async () => {
    const { eid } = await freshEngagement("Expired Orphan Co");
    const first = await fileCard(eid);
    await versions.saveProfileField(db, { tenantId: OASIS, engagementId: eid, field: { field_key: "business.team_size", value: 4, label: "client_reported", source_type: "call_notes" } as never, actor: cc, now: NOW() });
    await db.execute("CREATE TRIGGER fail_orphan_link BEFORE UPDATE OF authorization_approval_id ON ai_audit_engagements BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" }).catch(() => undefined);
    await db.execute("DROP TRIGGER fail_orphan_link");
    // The unlinked revision expires before anyone asks again.
    await db.execute({ sql: "UPDATE approvals SET expires_at = ? WHERE tenant_id = ? AND supersedes_id = ?", args: [new Date(Date.now() - 60_000).toISOString(), OASIS, first] });
    const again = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(again.ok && again.created, !again.ok ? again.error : "a fresh card");
    assert.equal((await engagementOf(eid)).authorization_approval_id, again.ok ? again.approvalId : "");
    assert.equal(resultOf(await approveAs(again.ok ? again.approvalId : "", USERS.cc))?.outcome, "authorized");
  });
  await check("a card whose link loses three writes in a row is reported as a conflict, and the next request links it (Codex review of phase 2, fourth pass)", async () => {
    const { eid } = await freshEngagement("Lost Link Co");
    // Every write that would point the engagement at a card is skipped, as three concurrent writers would make it.
    await db.execute("CREATE TRIGGER skip_card_link BEFORE UPDATE OF authorization_approval_id ON ai_audit_engagements BEGIN SELECT RAISE(IGNORE); END");
    let lost: Awaited<ReturnType<typeof authorize.requestAuthorization>>;
    try {
      lost = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    } finally {
      await db.execute("DROP TRIGGER skip_card_link");
    }
    assert.deepEqual(lost, { ok: false, error: "changed_elsewhere_refresh" });
    const again = await authorize.requestAuthorization(db, { tenantId: OASIS, engagementId: eid, actor: cc, now: NOW(), engine: "mac_claude" });
    assert.ok(again.ok && !again.created, !again.ok ? again.error : "the card already filed");
    assert.equal((await engagementOf(eid)).authorization_approval_id, again.ok ? again.approvalId : "");
  });
  await check("a rename that read the engagement before Gate 1 cannot land after it; anything changed behind an authorization voids it (review of phase 2, second pass)", async () => {
    const { eid } = await freshEngagement("Late Rename Co");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const e = await engagementOf(eid);
    // The write the route makes for a name change carries the stage condition: on the version the approval left, it changes nothing.
    const late = await store.patchEngagement(db, { tenantId: OASIS, id: eid, expectedRowVersion: e.row_version, patch: { business_name: "Sneaky Rename" }, event: "details_saved", actor: cc, now: NOW(), onlyInStages: rules.PROFILE_EDIT_STAGES });
    assert.equal(late.ok, false);
    assert.equal((await engagementOf(eid)).business_name, e.business_name);
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)));
    // Changed out of band anyway (a bug, a hand edit): the authorization stops holding, for the notes and for the business.
    await db.execute({ sql: "INSERT INTO ai_audit_call_notes (id, tenant_id, engagement_id, question_id, notes, row_version, created_at, updated_at) VALUES ('oob-note', ?, ?, 'biz-goals', 'added by hand', 1, ?, ?)", args: [OASIS, eid, NOW().toISOString(), NOW().toISOString()] });
    assert.equal(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)), null, "a note it never saw");
    await db.execute("DELETE FROM ai_audit_call_notes WHERE id = 'oob-note'");
    assert.ok(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)));
    await db.execute({ sql: "UPDATE ai_audit_engagements SET business_name = 'Renamed By Hand' WHERE id = ?", args: [eid] });
    assert.equal(await authorize.authorizedProfile(db, OASIS, await engagementOf(eid)), null, "a business it never saw");
  });
  await check("after a transcript is deleted past Gate 1, the page says the authorization is void and the engagement needs attention (review of phase 2, second pass)", async () => {
    const { eid, transcriptId: tid } = await freshEngagement("Void View Co");
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const view = await import("../lib/ai-audit/view");
    assert.equal((await view.engagementView(db, OASIS, eid, NOW()))!.authorization?.status, "executed");
    assert.deepEqual(await transcripts.deleteTranscript(db, { tenantId: OASIS, engagementId: eid, id: tid, actor: cc, now: NOW() }), { ok: true });
    const v = (await view.engagementView(db, OASIS, eid, NOW()))!;
    assert.equal(v.authorization?.status, "voided");
    assert.match(String(v.authorization?.message), /no longer holds/);
    assert.equal(v.engagement.health, "attention");
    // Moved back, a new call's transcript added and authorized again: the warning is answered and goes (Codex review, fourth pass).
    const e = await engagementOf(eid);
    assert.ok((await lifecycle.advanceEngagement(db, { tenantId: OASIS, engagementId: eid, to: "transcript_review", actor: cc, now: NOW(), expectedRowVersion: e.row_version })).ok);
    assert.ok((await transcripts.addTranscript(db, { tenantId: OASIS, engagementId: eid, parsed: parsed("Dana: Void View Co gets about 40 calls a week."), source: "paste", consent: consent(true), actor: cc, now: NOW() })).ok);
    assert.equal(resultOf(await approveAs(await fileCard(eid), USERS.cc))?.outcome, "authorized");
    const w = (await view.engagementView(db, OASIS, eid, NOW()))!;
    assert.deepEqual([w.engagement.health, w.engagement.health_reason], ["ok", null]);
  });
  await check("note edits leave a line in the audit trail, one per note per ten minutes of typing (review F10)", async () => {
    const { eid } = await freshEngagement("Note Trail Co");
    const at0 = new Date("2026-10-26T10:00:00Z");
    const save = (text: string, expected: number, now: Date) => notes.saveCallNote(db, { tenantId: OASIS, engagementId: eid, questionId: "biz-goals", notes: text, expectedVersion: expected, actor: cc, now });
    assert.ok((await save("Grow to two vans", 0, at0)).ok);
    assert.ok((await save("Grow to two vans this year", 1, new Date(at0.getTime() + 60_000))).ok);
    assert.equal(await eventCount(eid, "call_note_saved"), 1, "typing on within ten minutes adds nothing");
    assert.ok((await save("Grow to two vans this year, then a shop", 2, new Date(at0.getTime() + 20 * 60_000))).ok);
    assert.equal(await eventCount(eid, "call_note_saved"), 2);
  });
  await check("the install guard needs every table and column phase 2 reads (review F6)", async () => {
    const { createClient } = await import("@libsql/client");
    const bare = createClient({ url: ":memory:" });
    for (const t of ["ai_audit_engagements", "ai_audit_share_links", "ai_audit_transcripts"]) await bare.execute(`CREATE TABLE ${t} (id text)`);
    assert.equal(await store.aiAuditTablesInstalled(bare), false, "no call notes table");
    await bare.execute("CREATE TABLE ai_audit_call_notes (id text)");
    assert.equal(await store.aiAuditTablesInstalled(bare), false, "the engagement lacks the call clock");
    await bare.execute("ALTER TABLE ai_audit_engagements ADD COLUMN call_started_at text");
    await bare.execute("ALTER TABLE ai_audit_engagements ADD COLUMN call_ended_at text");
    assert.equal(await store.aiAuditTablesInstalled(bare), true);
    assert.equal(await store.aiAuditTablesInstalled(db), true);
    bare.close();
  });

  finish("ai-audit-discovery");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
