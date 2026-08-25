import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import {
  transition_pipeline_lead,
  TURSO_RPC_SHIM,
} from "../lib/turso-rpc-shim";

const TENANT = "tenant-oasis";
const OTHER_TENANT = "tenant-other";
const LEAD = "lead-a";
const EARLY_BOOKING_LEAD = "lead-early-booking";
const ROLLBACK_LEAD = "lead-rollback";
const DELIVERY_LEAD = "lead-delivery";
const ACTOR = "user-opener";
const REQUEST = "11111111-1111-4111-8111-111111111111";

// Shared-cache memory keeps the schema visible after @libsql/client closes an
// interactive transaction's connection. It is still a real in-memory libSQL
// database (no filesystem fixture or mocked client).
const client = createClient({ url: "file::memory:?cache=shared" });

async function readLead(leadId: string) {
  const result = await client.execute({
    sql: "SELECT data FROM tenant_records WHERE id = ? AND tenant_id = ?",
    args: [leadId, TENANT],
  });
  assert.equal(result.rows.length, 1);
  return JSON.parse(String(result.rows[0].data)) as Record<string, unknown>;
}

async function interactionCount(leadId: string) {
  const result = await client.execute({
    sql: "SELECT count(*) AS total FROM lead_interactions WHERE tenant_id = ? AND lead_id = ?",
    args: [TENANT, leadId],
  });
  return Number(result.rows[0].total);
}

async function main() {
  await client.executeMultiple(`
    CREATE TABLE tenant_records (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      data TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE lead_interactions (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT,
      type TEXT NOT NULL,
      channel TEXT NOT NULL,
      direction TEXT,
      agent_source TEXT,
      actor_user_id TEXT,
      subject TEXT CHECK (subject <> 'force_failure'),
      content TEXT,
      content_preview TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX website_sales_interaction_request_uidx
      ON lead_interactions (tenant_id, json_extract(metadata, '$.request_id'))
      WHERE agent_source = 'website_sales_pipeline'
        AND json_extract(metadata, '$.request_id') IS NOT NULL;

    CREATE TABLE website_onboarding (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      lead_id TEXT NOT NULL,
      fulfillment_owner_id TEXT,
      status TEXT NOT NULL,
      launched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await client.batch([
    {
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        LEAD,
        TENANT,
        JSON.stringify({
          stage: "qualified",
          company: "Acme",
          assigned_to: ACTOR,
          last_contacted_at: "2026-08-24T16:00:00.000Z",
        }),
        "2026-08-24T16:00:00.000Z",
      ],
    },
    {
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        EARLY_BOOKING_LEAD,
        TENANT,
        JSON.stringify({
          stage: "attempting_contact",
          company: "Early Audit Co",
          assigned_to: ACTOR,
        }),
        "2026-08-24T14:00:00.000Z",
      ],
    },
    {
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        ROLLBACK_LEAD,
        TENANT,
        JSON.stringify({
          stage: "onboarding",
          assigned_to: "user-builder",
          last_contacted_at: "2026-08-24T10:00:00.000Z",
        }),
        "2026-08-24T10:00:00.000Z",
      ],
    },
    {
      sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, ?)",
      args: [
        DELIVERY_LEAD,
        TENANT,
        JSON.stringify({
          stage: "onboarding",
          assigned_to: "user-builder",
          stage_entered_at: "2026-08-20T10:00:00.000Z",
        }),
        "2026-08-24T10:00:00.000Z",
      ],
    },
    {
      sql: "INSERT INTO website_onboarding VALUES (?, ?, ?, NULL, 'ready', NULL, ?, ?)",
      args: ["onboarding-delivery", TENANT, DELIVERY_LEAD, "2026-08-24T10:00:00.000Z", "2026-08-24T10:00:00.000Z"],
    },
    {
      sql: "INSERT INTO website_onboarding VALUES (?, ?, ?, NULL, 'ready', NULL, ?, ?)",
      args: ["onboarding-rollback", TENANT, ROLLBACK_LEAD, "2026-08-24T10:00:00.000Z", "2026-08-24T10:00:00.000Z"],
    },
  ], "write");

  assert.equal(
    TURSO_RPC_SHIM.transition_pipeline_lead,
    transition_pipeline_lead,
    "the transaction primitive must be reachable through the production Turso RPC registry",
  );

  const first = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: LEAD,
    p_expected_stage: "qualified",
    p_patch: {
      stage: "founder_meeting_booked",
      founder_meeting_at: "2026-08-25T20:00:00.000Z",
    },
    p_request_id: REQUEST,
    p_occurred_at: "2026-08-24T15:00:00.000Z",
    p_actor_user_id: ACTOR,
    p_expected_owner_id: ACTOR,
    p_action: "book_founder",
    p_interaction_type: "founder_handoff",
    p_subject: "Founder meeting booked",
    p_content: "15-minute audit booked.",
    p_metadata: { audit_host_user_id: "user-founder" },
  }) as Record<string, unknown>;

  assert.deepEqual(
    { ok: first.ok, idempotent: first.idempotent, previous_stage: first.previous_stage, current_stage: first.current_stage },
    { ok: true, idempotent: false, previous_stage: "qualified", current_stage: "founder_meeting_booked" },
  );
  const moved = await readLead(LEAD);
  assert.equal(moved.stage, "founder_meeting_booked");
  assert.equal(
    moved.stage_entered_at,
    "2026-08-24T15:00:00.000Z",
    "a genuine stage move must reset the durable stage-entry clock",
  );
  assert.equal(moved.company, "Acme", "the patch must shallow-merge without dropping lead context");
  assert.equal(
    moved.last_contacted_at,
    "2026-08-24T16:00:00.000Z",
    "an older lifecycle event must never move Last Touch backwards",
  );
  assert.equal(await interactionCount(LEAD), 1);

  const interaction = await client.execute({
    sql: "SELECT metadata, created_at FROM lead_interactions WHERE tenant_id = ? AND lead_id = ?",
    args: [TENANT, LEAD],
  });
  const metadata = JSON.parse(String(interaction.rows[0].metadata)) as Record<string, unknown>;
  assert.equal(metadata.request_id, REQUEST);
  assert.equal(metadata.from, "qualified");
  assert.equal(metadata.to, "founder_meeting_booked");
  assert.equal(metadata.changed_by, ACTOR);
  assert.equal(interaction.rows[0].created_at, "2026-08-24T15:00:00.000Z");

  // When the prospect agrees to the audit before the rep separately clicks
  // "Mark qualified", the route submits one transition containing both the
  // explicit qualification facts and the confirmed Calendar handoff. This
  // exercises the production Turso transaction that must commit the stage,
  // owner, Last Touch, meeting, and one timeline receipt together.
  const earlyBookingRequest = "99999999-9999-4999-8999-999999999999";
  const earlyBooking = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: EARLY_BOOKING_LEAD,
    p_expected_stage: "attempting_contact",
    p_expected_owner_id: ACTOR,
    p_patch: {
      stage: "founder_meeting_booked",
      qualification: {
        authorityConfirmed: true,
        websiteProblemConfirmed: true,
        timingConfirmed: true,
        minimumInvestmentConfirmed: true,
      },
      qualified_at: "2026-08-24T15:30:00.000Z",
      qualification_source: "confirmed_calendar_handoff",
      assigned_to: "user-founder",
      founder_meeting_at: "2026-08-25T20:00:00.000Z",
      next_action_at: "2026-08-25T20:00:00.000Z",
      calendar_event_status: "operator_confirmed",
      calendar_confirmation_method: "operator_asserted_prefilled_google_calendar",
      last_handoff_note: "Owner requested a 4:00 p.m. audit and needs online booking.",
    },
    p_request_id: earlyBookingRequest,
    p_occurred_at: "2026-08-24T15:30:00.000Z",
    p_actor_user_id: ACTOR,
    p_action: "book_founder",
    p_interaction_type: "founder_handoff",
    p_subject: "book founder",
    p_content: "Qualification completed during handoff. Operator confirmed the Calendar event was saved.",
    p_metadata: {
      calendar_event_status: "operator_confirmed",
      qualification_source: "confirmed_calendar_handoff",
    },
  }) as Record<string, unknown>;
  assert.equal(earlyBooking.ok, true);
  const earlyLead = await readLead(EARLY_BOOKING_LEAD);
  assert.equal(earlyLead.stage, "founder_meeting_booked");
  assert.equal(earlyLead.assigned_to, "user-founder");
  assert.equal(earlyLead.last_contacted_at, "2026-08-24T15:30:00.000Z");
  assert.equal(earlyLead.qualified_at, "2026-08-24T15:30:00.000Z");
  assert.equal(earlyLead.next_action_at, "2026-08-25T20:00:00.000Z");
  assert.equal(earlyLead.calendar_event_status, "operator_confirmed");
  assert.deepEqual(earlyLead.qualification, {
    authorityConfirmed: true,
    websiteProblemConfirmed: true,
    timingConfirmed: true,
    minimumInvestmentConfirmed: true,
  });
  assert.equal(await interactionCount(EARLY_BOOKING_LEAD), 1);
  const earlyReceipt = await client.execute({
    sql: "SELECT actor_user_id, metadata FROM lead_interactions WHERE tenant_id = ? AND lead_id = ?",
    args: [TENANT, EARLY_BOOKING_LEAD],
  });
  const earlyMetadata = JSON.parse(String(earlyReceipt.rows[0].metadata)) as Record<string, unknown>;
  assert.equal(earlyReceipt.rows[0].actor_user_id, ACTOR);
  assert.equal(earlyMetadata.request_id, earlyBookingRequest);
  assert.equal(earlyMetadata.from, "attempting_contact");
  assert.equal(earlyMetadata.to, "founder_meeting_booked");
  assert.equal(earlyMetadata.qualification_source, "confirmed_calendar_handoff");

  // A transport retry reaches the transaction after the stage has changed.
  // The durable request marker wins before the expected-stage check, so the
  // retry is a no-op instead of a false conflict or duplicate timeline row.
  const replay = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: LEAD,
    p_expected_stage: "qualified",
    p_patch: { stage: "must_not_apply" },
    p_request_id: REQUEST,
    p_occurred_at: "2026-08-24T17:00:00.000Z",
    p_actor_user_id: ACTOR,
    p_expected_owner_id: ACTOR,
    p_action: "book_founder",
    p_interaction_type: "founder_handoff",
    p_subject: "Founder meeting booked",
    p_content: "retry",
  }) as Record<string, unknown>;
  assert.equal(replay.ok, true);
  assert.equal(replay.idempotent, true);
  assert.equal((await readLead(LEAD)).stage, "founder_meeting_booked");
  assert.equal(await interactionCount(LEAD), 1);

  const conflict = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: LEAD,
    p_expected_stage: "qualified",
    p_patch: { stage: "demo_completed" },
    p_request_id: "22222222-2222-4222-8222-222222222222",
    p_occurred_at: "2026-08-24T18:00:00.000Z",
    p_actor_user_id: ACTOR,
    p_expected_owner_id: ACTOR,
    p_action: "complete_audit",
    p_interaction_type: "audit_completed",
    p_subject: "Audit complete",
    p_content: "audit notes",
  }) as Record<string, unknown>;
  assert.deepEqual(conflict, {
    ok: false,
    error: "stage_conflict",
    expected_stage: "qualified",
    current_stage: "founder_meeting_booked",
  });
  assert.equal(await interactionCount(LEAD), 1, "a stage conflict must not create a timeline event");

  const ownerConflict = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: LEAD,
    p_expected_stage: "founder_meeting_booked",
    p_expected_owner_id: "someone-else",
    p_patch: { stage: "demo_completed" },
    p_request_id: "77777777-7777-4777-8777-777777777777",
    p_occurred_at: "2026-08-24T18:00:00.000Z",
    p_actor_user_id: ACTOR,
    p_action: "complete_audit",
    p_interaction_type: "audit_completed",
    p_subject: "Audit complete",
    p_content: "audit notes",
  }) as Record<string, unknown>;
  assert.deepEqual(ownerConflict, {
    ok: false,
    error: "owner_conflict",
    expected_owner_id: "someone-else",
    current_owner_id: ACTOR,
    current_stage: "founder_meeting_booked",
  });
  assert.equal(await interactionCount(LEAD), 1);

  await assert.rejects(
    transition_pipeline_lead(client, {
      p_tenant_id: OTHER_TENANT,
      p_lead_id: LEAD,
      p_expected_stage: "founder_meeting_booked",
      p_patch: { stage: "demo_completed" },
      p_request_id: "33333333-3333-4333-8333-333333333333",
      p_occurred_at: "2026-08-24T18:00:00.000Z",
      p_actor_user_id: ACTOR,
      p_action: "complete_audit",
      p_interaction_type: "audit_completed",
      p_subject: "Audit complete",
      p_content: "audit notes",
    }),
    /lead_not_found_or_wrong_tenant/,
  );

  const sameStageTouch = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: DELIVERY_LEAD,
    p_expected_stage: "onboarding",
    p_patch: {
      stage: "onboarding",
      stage_entered_at: "2026-08-24T18:15:00.000Z",
      disposition: "follow_up",
    },
    p_request_id: "88888888-8888-4888-8888-888888888888",
    p_occurred_at: "2026-08-24T18:15:00.000Z",
    p_actor_user_id: "user-builder",
    p_expected_owner_id: "user-builder",
    p_action: "disposition",
    p_interaction_type: "call_outcome",
    p_subject: "Follow-up requested",
    p_content: "Keep this lead in onboarding.",
  }) as Record<string, unknown>;
  assert.equal(sameStageTouch.ok, true);
  assert.equal(
    (await readLead(DELIVERY_LEAD)).stage_entered_at,
    "2026-08-20T10:00:00.000Z",
    "same-stage outcomes must not reset the SLA clock, even if the patch supplies a new timestamp",
  );

  const delivery = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: DELIVERY_LEAD,
    p_expected_stage: "onboarding",
    p_patch: { stage: "in_build" },
    p_request_id: "55555555-5555-4555-8555-555555555555",
    p_occurred_at: "2026-08-24T18:30:00.000Z",
    p_actor_user_id: "user-builder",
    p_expected_owner_id: "user-builder",
    p_action: "advance",
    p_interaction_type: "stage_changed",
    p_subject: "Build started",
    p_content: "Builder accepted the handoff.",
    p_onboarding_status: "in_build",
    p_fulfillment_owner_id: "user-builder",
  }) as Record<string, unknown>;
  assert.equal(delivery.ok, true);
  assert.equal(
    (await readLead(DELIVERY_LEAD)).stage_entered_at,
    "2026-08-24T18:30:00.000Z",
    "delivery handoffs must record the real stage-entry time",
  );
  const onboarding = await client.execute({
    sql: "SELECT status, fulfillment_owner_id FROM website_onboarding WHERE tenant_id = ? AND lead_id = ?",
    args: [TENANT, DELIVERY_LEAD],
  });
  assert.deepEqual(
    { status: onboarding.rows[0].status, fulfillment_owner_id: onboarding.rows[0].fulfillment_owner_id },
    { status: "in_build", fulfillment_owner_id: "user-builder" },
    "delivery stage and builder ownership must commit with the lead stage",
  );

  const deliveryConflict = await transition_pipeline_lead(client, {
    p_tenant_id: TENANT,
    p_lead_id: DELIVERY_LEAD,
    p_expected_stage: "onboarding",
    p_patch: { stage: "client_review" },
    p_request_id: "66666666-6666-4666-8666-666666666666",
    p_occurred_at: "2026-08-24T18:45:00.000Z",
    p_actor_user_id: "user-builder",
    p_expected_owner_id: "user-builder",
    p_action: "advance",
    p_interaction_type: "stage_changed",
    p_subject: "Client review",
    p_content: "Ready for review.",
    p_onboarding_status: "client_review",
  }) as Record<string, unknown>;
  assert.equal(deliveryConflict.error, "stage_conflict");
  const onboardingAfterConflict = await client.execute({
    sql: "SELECT status FROM website_onboarding WHERE tenant_id = ? AND lead_id = ?",
    args: [TENANT, DELIVERY_LEAD],
  });
  assert.equal(onboardingAfterConflict.rows[0].status, "in_build");

  // Force the second write to fail. The stage update happens first inside the
  // transaction, so this proves it rolls back instead of leaving an unlogged
  // lifecycle move behind.
  await assert.rejects(
    transition_pipeline_lead(client, {
      p_tenant_id: TENANT,
      p_lead_id: ROLLBACK_LEAD,
      p_expected_stage: "onboarding",
      p_patch: { stage: "in_build" },
      p_request_id: "44444444-4444-4444-8444-444444444444",
      p_occurred_at: "2026-08-24T19:00:00.000Z",
      p_actor_user_id: ACTOR,
      p_expected_owner_id: "user-builder",
      p_action: "advance",
      p_interaction_type: "stage_changed",
      p_subject: "force_failure",
      p_content: "forced transaction failure",
      p_onboarding_status: "in_build",
      p_fulfillment_owner_id: "user-builder",
    }),
    /CHECK constraint failed/,
  );
  const rolledBack = await readLead(ROLLBACK_LEAD);
  assert.equal(rolledBack.stage, "onboarding");
  assert.equal(rolledBack.last_contacted_at, "2026-08-24T10:00:00.000Z");
  assert.equal(await interactionCount(ROLLBACK_LEAD), 0);
  const rolledBackOnboarding = await client.execute({
    sql: "SELECT status, fulfillment_owner_id FROM website_onboarding WHERE tenant_id = ? AND lead_id = ?",
    args: [TENANT, ROLLBACK_LEAD],
  });
  assert.equal(rolledBackOnboarding.rows[0].status, "ready");
  assert.equal(rolledBackOnboarding.rows[0].fulfillment_owner_id, null);

  await client.close();
  console.log("atomic-pipeline-lifecycle: OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
