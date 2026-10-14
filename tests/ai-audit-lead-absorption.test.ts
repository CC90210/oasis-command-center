/** End-to-end persistence contracts for the AI-audit lead absorption path. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, finish, OASIS, setupDatabase } from "./_delivery-harness";

const ROOT = join(__dirname, "..");
const LEAD = "audit-lead-0001";
const NO_SMS_LEAD = "audit-lead-0002";
const CONCURRENT_LEAD = "audit-lead-0003";
const DELIVERY_LEAD = "audit-lead-0004";
const WARM_ASSIGN_LEAD = "audit-lead-0005";

async function main() {
  const seed = await setupDatabase();
  await seed.executeMultiple(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      event_type TEXT, publisher_agent TEXT, severity TEXT, target_agent TEXT,
      payload TEXT, correlation_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS ux_lead_interactions_provider_msg
      ON lead_interactions(provider, provider_message_id);
  `);
  await seed.executeMultiple(
    readFileSync(join(ROOT, "database", "turso", "bravo__214_consent_events.sql"), "utf8"),
  );
  await seed.batch([
    {
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [LEAD, OASIS, JSON.stringify({ stage: "researched", status: "open", company: "Acme", funnel_stage: "meeting_booked" })],
    },
    {
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [NO_SMS_LEAD, OASIS, JSON.stringify({ stage: "researched", company: "No SMS" })],
    },
    {
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [CONCURRENT_LEAD, OASIS, JSON.stringify({ stage: "researched", company: "Concurrency" })],
    },
    {
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [DELIVERY_LEAD, OASIS, JSON.stringify({ stage: "researched", company: "Delivery" })],
    },
    {
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [WARM_ASSIGN_LEAD, OASIS, JSON.stringify({ stage: "researched", sales_motion: "inbound_warm" })],
    },
  ], "write");

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { ingestAiAuditSubmission, scoreAiAuditLead } = await import("../lib/forms/ai-audit-ingest");
  const {
    ensureAiAuditSalesEvent,
    ensureAiAuditSubmissionDelivery,
  } = await import("../lib/forms/ai-audit-notify");
  const { recordConsentEvents } = await import("../lib/consent/ledger");
  const { queueAiAuditConfirmation, TRANSACTIONAL_OUTBOX_PROVIDER } = await import(
    "../lib/forms/transactional-outbox"
  );
  const { listOasisPipelineWindow } = await import("../lib/oasis-pipeline-query");
  const { assignLifecycleOwner } = await import("../lib/lifecycle-assignment");
  const {
    canOpenOasisSalesRecord,
    stagesForOasisWarmInboundRole,
  } = await import("../lib/oasis-sales-pipeline-policy");
  const db = getServiceSupabase();
  const answers = {
    name: "Dana Reyes",
    email: "dana@acme.test",
    phone: "+15145550123",
    company: "Acme",
    automation_goal: "agent_fleet",
    bottleneck_detail: "Qualified leads wait for days because nobody owns a reliable follow-up queue.",
    tried_before: "hired",
    monthly_revenue: "250k_plus",
    team_size: "21_100",
    budget: "15k_plus",
    timeframe: "immediate",
    wants_call: "yes",
  };

  console.log("ai-audit-lead-absorption:");

  await check("score and qualification persist on the canonical lead without changing lifecycle fields", async () => {
    const result = await ingestAiAuditSubmission({ db, tenantId: OASIS, leadId: LEAD, answers });
    assert.equal(result.ok, true);
    const saved = await seed.execute({ sql: "SELECT data FROM tenant_records WHERE id = ?", args: [LEAD] });
    const data = JSON.parse(String(saved.rows[0].data));
    assert.equal(data.score, result.score);
    assert.equal(data.ai_audit_qualification, result.status);
    assert.equal(data.stage, "researched");
    assert.equal(data.status, "open");
    assert.ok(data.ai_audit_scored_at);
    assert.equal(data.funnel_stage, "meeting_booked", "late score repair cannot downgrade a booked lead");
  });

  await check("repeat ingestion repairs the canonical score but never duplicates the timeline", async () => {
    const result = await ingestAiAuditSubmission({ db, tenantId: OASIS, leadId: LEAD, answers });
    assert.equal(result.error, "already_ingested");
    const count = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM lead_interactions WHERE tenant_id = ? AND lead_id = ? AND agent_source = 'ai_audit_funnel'",
      args: [OASIS, LEAD],
    });
    assert.equal(Number(count.rows[0].n), 1);
  });

  await check("concurrent final-step ingestion has exactly one winner", async () => {
    const results = await Promise.all([
      ingestAiAuditSubmission({ db, tenantId: OASIS, leadId: CONCURRENT_LEAD, answers }),
      ingestAiAuditSubmission({ db, tenantId: OASIS, leadId: CONCURRENT_LEAD, answers }),
    ]);
    assert.equal(results.filter((result) => result.error === "already_ingested").length, 1);
    assert.equal(results.filter((result) => result.ok && !result.error).length, 1);
    const count = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM lead_interactions WHERE tenant_id = ? AND lead_id = ? AND agent_source = 'ai_audit_funnel'",
      args: [OASIS, CONCURRENT_LEAD],
    });
    assert.equal(Number(count.rows[0].n), 1);
  });

  await check("email and consented SMS enqueue once with deterministic gateway keys", async () => {
    const consent = await recordConsentEvents(db, {
      tenantId: OASIS,
      leadId: LEAD,
      formId: "form-ai-audit",
      decisions: [{ channel: "sms", ticked: true, subject: "+15145550123" }],
      identity: {
        businessName: "OASIS AI Solutions",
        address: "6993 Decarie Blvd, Montreal, QC H3W 0B5, Canada",
        privacyUrl: "https://oasisai.work/privacy",
      },
      identitySource: "brand",
      ipAddress: "203.0.113.10",
      userAgent: "test",
      pageUrl: "https://oasisai.work/ai-audit",
    });
    assert.equal(consent.ok, true);

    const input = {
      db,
      tenantId: OASIS,
      leadId: LEAD,
      formId: "form-ai-audit",
      email: answers.email,
      phone: answers.phone,
      emailSubject: "Your audit",
      emailBody: "Email receipt",
      smsBody: "SMS receipt. Reply STOP to opt out.",
    };
    const first = await queueAiAuditConfirmation(input);
    const second = await queueAiAuditConfirmation(input);
    assert.equal(first.email.queued, true);
    assert.equal(first.sms.queued, true);
    assert.equal(second.email.queued, false);
    assert.equal(second.email.reason, "already_queued");
    assert.equal(second.sms.queued, false);
    assert.equal(second.sms.reason, "already_queued");
    assert.ok(second.email.interactionId);
    assert.ok(second.sms.interactionId);

    const rows = await seed.execute({
      sql: "SELECT channel, provider_message_id, metadata FROM lead_interactions WHERE provider = ? AND lead_id = ? ORDER BY channel",
      args: [TRANSACTIONAL_OUTBOX_PROVIDER, LEAD],
    });
    assert.equal(rows.rows.length, 2);
    assert.equal(new Set(rows.rows.map((row) => String(row.provider_message_id))).size, 2);
    for (const row of rows.rows) {
      const metadata = JSON.parse(String(row.metadata));
      assert.equal(metadata.status, "queued");
      assert.equal(metadata.intent, "transactional");
    }
  });

  await check("SMS is not queued when the exact destination lacks explicit consent", async () => {
    const result = await queueAiAuditConfirmation({
      db,
      tenantId: OASIS,
      leadId: NO_SMS_LEAD,
      formId: "form-ai-audit",
      email: "no-sms@example.test",
      phone: "+15145550999",
      emailSubject: "Your audit",
      emailBody: "Email receipt",
      smsBody: "This must not queue.",
    });
    assert.equal(result.email.queued, true);
    assert.equal(result.sms.queued, false);
    assert.equal(result.sms.reason, "sms_consent_required");
    const count = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM lead_interactions WHERE provider = ? AND lead_id = ? AND channel = 'sms'",
      args: [TRANSACTIONAL_OUTBOX_PROVIDER, NO_SMS_LEAD],
    });
    assert.equal(Number(count.rows[0].n), 0);
  });

  await check("a repeat completion repairs missing delivery rows without duplicate Sales events", async () => {
    const delivery = {
      db,
      tenantId: OASIS,
      formId: "form-ai-audit",
      leadId: DELIVERY_LEAD,
      answers: { ...answers, email: "delivery@acme.test", phone: "" },
      score: scoreAiAuditLead(answers),
    };
    const first = await ensureAiAuditSubmissionDelivery(delivery);
    const second = await ensureAiAuditSubmissionDelivery(delivery);
    assert.equal(first.salesEventOk, true);
    assert.equal(second.salesEventOk, true);

    const events = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM agent_events WHERE correlation_id = ? AND event_type = 'OASIS_AI_AUDIT_COMPLETED'",
      args: [OASIS],
    });
    assert.equal(Number(events.rows[0].n), 1);
    const queued = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM lead_interactions WHERE provider = ? AND lead_id = ? AND channel = 'email'",
      args: [TRANSACTIONAL_OUTBOX_PROVIDER, DELIVERY_LEAD],
    });
    assert.equal(Number(queued.rows[0].n), 1);

    await seed.execute({
      sql: "DELETE FROM lead_interactions WHERE provider = ? AND lead_id = ? AND channel = 'email'",
      args: [TRANSACTIONAL_OUTBOX_PROVIDER, DELIVERY_LEAD],
    });
    await ensureAiAuditSubmissionDelivery(delivery);
    const repaired = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM lead_interactions WHERE provider = ? AND lead_id = ? AND channel = 'email'",
      args: [TRANSACTIONAL_OUTBOX_PROVIDER, DELIVERY_LEAD],
    });
    assert.equal(Number(repaired.rows[0].n), 1);

    const started = {
      db,
      tenantId: OASIS,
      formId: "form-ai-audit",
      leadId: DELIVERY_LEAD,
      event: "started" as const,
      submissionId: "submission-delivery-1",
    };
    assert.equal((await ensureAiAuditSalesEvent(started)).ok, true);
    assert.equal((await ensureAiAuditSalesEvent(started)).ok, true);
    const startedEvents = await seed.execute({
      sql: "SELECT COUNT(*) AS n FROM agent_events WHERE correlation_id = ? AND event_type = 'OASIS_AI_AUDIT_STARTED'",
      args: [OASIS],
    });
    assert.equal(Number(startedEvents.rows[0].n), 1);
  });

  await check("assigning researched warm intake makes it actionable without a cold cycle", async () => {
    const assigned = await assignLifecycleOwner({
      tenantId: OASIS,
      record: {
        id: WARM_ASSIGN_LEAD,
        entity_type: "lead",
        data: { stage: "researched", sales_motion: "inbound_warm" },
      },
      assignedTo: "rep-warm-1",
      occurredAt: "2026-10-12T12:00:00.000Z",
      resetClaimClock: false,
      advanceResearchedLeadOnAssign: true,
    });
    assert.equal(assigned.ok, true);
    const saved = await seed.execute({
      sql: "SELECT data FROM tenant_records WHERE tenant_id = ? AND id = ?",
      args: [OASIS, WARM_ASSIGN_LEAD],
    });
    const data = JSON.parse(String(saved.rows[0].data));
    assert.equal(data.assigned_to, "rep-warm-1");
    assert.equal(data.stage, "assigned");
    assert.equal(data.assigned_at, "2026-10-12T12:00:00.000Z");
    assert.equal(data.pipeline_cycle, undefined);

    const singleAssign = readFileSync(
      join(ROOT, "app", "api", "leads", "[id]", "assign", "route.ts"),
      "utf8",
    );
    const bulkAssign = readFileSync(join(ROOT, "app", "api", "leads", "bulk", "route.ts"), "utf8");
    assert.match(singleAssign, /!isWarmInboundLead[\s\S]{0,500}advanceResearchedLeadOnAssign:\s*isWarmInboundLead/);
    assert.match(bulkAssign, /!isWarmInboundLead[\s\S]{0,700}advanceResearchedLeadOnAssign:\s*isWarmInboundLead/);
  });

  await check("the public route uses strong identity and the short URL permanently redirects", () => {
    const route = readFileSync(join(ROOT, "app", "api", "forms", "submit", "route.ts"), "utf8");
    assert.match(route, /findExistingLead\([\s\S]{0,220}matchOnBusinessName:\s*false/);
    assert.match(route, /r\.error === "already_ingested"[\s\S]{0,500}ensureAiAuditSubmissionDelivery/);
    assert.match(route, /repStartsWarmWork[\s\S]{0,300}stage:\s*repStartsWarmWork\s*\?\s*"assigned"/);
    const config = readFileSync(join(ROOT, "next.config.js"), "utf8");
    assert.match(config, /source:\s*["']\/ai-audit["'][\s\S]{0,180}destination:\s*["']\/f\/oasis-ai-cc\/ai-audit["'][\s\S]{0,80}permanent:\s*true/);
    assert.match(config, /source:\s*["']\/vsl["'][\s\S]{0,180}destination:\s*["']\/f\/oasis-ai-cc\/vsl["'][\s\S]{0,80}permanent:\s*true/);
  });

  await check("the Pipeline exposes a warm-inbound queue without the cold assignment-cycle filter", async () => {
    const page = readFileSync(join(ROOT, "app", "pipeline", "page.tsx"), "utf8");
    assert.match(page, /sp\.motion === "inbound"/);
    assert.match(page, /salesMotion:\s*warmInbound\s*\?\s*OASIS_INBOUND_WARM_MOTION/);
    assert.match(page, /cycle:\s*warmInbound\s*\?\s*undefined\s*:\s*CURRENT_OASIS_PIPELINE_CYCLE/);
    assert.match(page, />\s*Warm inbound\s*</);

    const calls: Array<Record<string, unknown>> = [];
    const window = await listOasisPipelineWindow(
      {
        tenantId: OASIS,
        stageKeys: ["researched", "assigned"],
        salesMotion: "inbound_warm",
        includeUnassigned: true,
      },
      {
        list: async (query) => {
          calls.push(query as unknown as Record<string, unknown>);
          return {
            total: 2,
            rows: [
              {
                id: "warm-unassigned",
                tenant_id: OASIS,
                entity_type: "lead",
                data: { stage: "researched", sales_motion: "inbound_warm" },
                created_at: "2026-10-12T00:00:00.000Z",
                updated_at: "2026-10-12T01:00:00.000Z",
              },
              {
                id: "warm-assigned",
                tenant_id: OASIS,
                entity_type: "lead",
                data: { stage: "assigned", sales_motion: "inbound_warm", assigned_to: "rep-1" },
                created_at: "2026-10-12T00:00:00.000Z",
                updated_at: "2026-10-12T00:30:00.000Z",
              },
            ],
          };
        },
      },
    );
    assert.deepEqual(window.rows.map((row) => row.id), ["warm-unassigned", "warm-assigned"]);
    assert.equal(calls.length, 1, "owner warm view reads the full motion in one bounded query");
    assert.equal(calls[0].whereEmpty, undefined);
    assert.equal(calls[0].whereNotEmpty, undefined);
    assert.equal(
      stagesForOasisWarmInboundRole("opener").some((stage) => stage.key === "researched"),
      true,
      "a rep-linked warm lead remains visible before its first lifecycle action",
    );
    assert.equal(
      canOpenOasisSalesRecord(
        { id: "warm-assigned", data: { stage: "researched", sales_motion: "inbound_warm", assigned_to: "rep-1" } },
        { role: "opener", userId: "rep-1" },
      ),
      true,
      "the assigned rep can open the same warm researched row shown by the queue",
    );
    assert.equal(
      canOpenOasisSalesRecord(
        { id: "warm-unassigned", data: { stage: "researched", sales_motion: "inbound_warm" } },
        { role: "manager", userId: "manager-1", readableRepUserIds: ["rep-1"] },
      ),
      false,
      "unassigned warm intake remains an owner/admin triage pool",
    );
  });

  await check("started and completed leads use deterministic department:Sales event writes", () => {
    const notify = readFileSync(join(ROOT, "lib", "forms", "ai-audit-notify.ts"), "utf8");
    assert.match(notify, /OASIS_AI_AUDIT_STARTED[\s\S]{0,100}OASIS_AI_AUDIT_COMPLETED/);
    assert.match(notify, /publisher_agent:\s*"dept:sales"[\s\S]{0,100}target_agent:\s*"dept:sales"/);
    assert.match(notify, /onConflict:\s*"id",\s*ignoreDuplicates:\s*true/);
    assert.doesNotMatch(notify, /publishAgentEvent/);
  });

  finish("ai-audit-lead-absorption");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
