/**
 * Book sooner (CC, 2026-10-16: "make joining as easy as possible, collect data
 * ASAP"). On AI audit, COMMAND and FLEET the calendar opens right after the
 * contact step, and the remaining questions come after the call is booked.
 *
 *   - The gate both public booking routes share (resolvePublicFunnelBooking)
 *     opens for those three forms once the contact step is recorded, and still
 *     needs every step on every other form.
 *   - A lead who booked first and then finished the questions gets a COMPLETED
 *     event marked booked and an email that confirms the call instead of
 *     offering a time again.
 *
 * Real SQL on a throwaway libSQL file (tests/_delivery-harness.ts), real signed
 * form links.
 *
 * Run: node --conditions=react-server --import tsx tests/public-booking-early.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { check, finish, OASIS, setupDatabase } from "./_delivery-harness";

process.env.FORM_LINK_HMAC_KEY = "public-booking-early-test-key-that-is-long-enough-01";

const ROOT = join(__dirname, "..");
const AUDIT_FORM = "form-ai-audit-early";
const COMMAND_FORM = "form-command-early";
const PROTOCOL_FORM = "form-protocol-early";
const step = (id: string) => ({ id, title: id, fields: [] });

async function main() {
  const seed = await setupDatabase();
  // The booking gate reads the form with its workspace embedded
  // (tenant:tenants!inner), which the adapter resolves through the foreign key
  // the live table has and the shared harness's copy leaves out.
  await seed.executeMultiple(`
    DROP TABLE forms;
    CREATE TABLE forms (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), slug TEXT NOT NULL, name TEXT NOT NULL,
      description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]',
      on_complete_stage TEXT, step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
      redirect_url TEXT, created_by TEXT, created_at TEXT, updated_at TEXT
    );
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

  const form = (id: string, slug: string, steps: number) => ({
    sql: "INSERT INTO forms (id, tenant_id, slug, name, steps) VALUES (?, ?, ?, ?, ?)",
    args: [id, OASIS, slug, slug.toUpperCase(), JSON.stringify(Array.from({ length: steps }, (_, i) => step(`s${i}`)))],
  });
  const lead = (id: string, data: Record<string, unknown>) => ({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
    args: [id, OASIS, JSON.stringify({ stage: "researched", name: "Dana Reyes", email: `${id}@acme.test`, phone: "+15145550123", ...data })],
  });
  const submitted = (formId: string, leadId: string, stepIndex: number) => ({
    sql: "INSERT INTO form_submissions (form_id, tenant_id, lead_id, step_index, payload) VALUES (?, ?, ?, ?, ?)",
    args: [formId, OASIS, leadId, stepIndex, JSON.stringify({ [`answer_${stepIndex}`]: "yes" })],
  });
  const contactRecorded = { funnel_stage: "inbound_lead", inbound_lead_at: "2026-10-16T12:00:00.000Z" };
  await seed.batch([
    form(AUDIT_FORM, "ai-audit", 4),
    form(COMMAND_FORM, "command", 3),
    form(PROTOCOL_FORM, "protocol", 2),
    lead("audit-contact", contactRecorded),
    submitted(AUDIT_FORM, "audit-contact", 0),
    lead("audit-no-time", { funnel_stage: "inbound_lead" }),
    submitted(AUDIT_FORM, "audit-no-time", 0),
    lead("audit-no-stage", {}),
    submitted(AUDIT_FORM, "audit-no-stage", 0),
    lead("audit-nothing-sent", contactRecorded),
    lead("audit-other-form", contactRecorded),
    submitted(PROTOCOL_FORM, "audit-other-form", 0),
    lead("command-contact", contactRecorded),
    submitted(COMMAND_FORM, "command-contact", 0),
    lead("protocol-contact", contactRecorded),
    submitted(PROTOCOL_FORM, "protocol-contact", 0),
    lead("protocol-finished", { funnel_stage: "audit_requested", audit_requested_at: "2026-10-16T12:05:00.000Z" }),
    submitted(PROTOCOL_FORM, "protocol-finished", 0),
    submitted(PROTOCOL_FORM, "protocol-finished", 1),
    lead("booked-first", {
      funnel_stage: "meeting_booked",
      meeting_booked_at: "2026-10-16T12:01:00.000Z",
      stage: "founder_meeting_booked",
      founder_meeting_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    }),
    lead("booked-long-ago", {
      funnel_stage: "meeting_booked",
      founder_meeting_at: "2026-09-01T15:00:00.000Z",
    }),
    lead("never-booked", contactRecorded),
  ], "write");

  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { signFormLink } = await import("../lib/form-links");
  const { resolvePublicFunnelBooking } = await import("../lib/forms/public-booking");
  const { ensureAiAuditSubmissionDelivery, upcomingBookedCall } = await import("../lib/forms/ai-audit-notify");
  const { scoreAiAuditLead } = await import("../lib/forms/ai-audit-ingest");
  const db = getServiceSupabase();
  const token = (formId: string, leadId: string) => {
    const signed = signFormLink({ tenant: "oasis-ai-cc", form_id: formId, lead_id: leadId });
    assert.ok(signed, "the test key must sign a link");
    return signed;
  };
  const refusal = async (formId: string, leadId: string) => {
    try {
      await resolvePublicFunnelBooking(db, token(formId, leadId));
      return "opened";
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  console.log("public-booking-early:");

  await check("AI audit and COMMAND open the calendar once the contact step is recorded", async () => {
    const audit = await resolvePublicFunnelBooking(db, token(AUDIT_FORM, "audit-contact"));
    assert.equal(audit.formSlug, "ai-audit");
    assert.equal(audit.leadId, "audit-contact");
    assert.equal(audit.lead.phone, "+15145550123", "the booking has the contact step's phone");
    const command = await resolvePublicFunnelBooking(db, token(COMMAND_FORM, "command-contact"));
    assert.equal(command.formSlug, "command");
  });

  await check("the contact step must really be recorded, on this form, for this lead", async () => {
    assert.equal(await refusal(AUDIT_FORM, "audit-no-time"), "booking_form_not_completed", "inbound_lead with no time");
    assert.equal(await refusal(AUDIT_FORM, "audit-no-stage"), "booking_form_not_completed", "no funnel stage at all");
    assert.equal(await refusal(AUDIT_FORM, "audit-nothing-sent"), "booking_form_not_completed", "no submission for this lead");
    assert.equal(
      await refusal(AUDIT_FORM, "audit-other-form"),
      "booking_form_not_completed",
      "another form's contact step does not unlock this one",
    );
  });

  await check("PROTOCOL still needs every step, and opens once they are in", async () => {
    assert.equal(await refusal(PROTOCOL_FORM, "protocol-contact"), "booking_form_not_completed");
    const finished = await resolvePublicFunnelBooking(db, token(PROTOCOL_FORM, "protocol-finished"));
    assert.equal(finished.formSlug, "protocol");
  });

  await check("only an upcoming call counts as booked", () => {
    const now = Date.parse("2026-10-16T12:00:00.000Z");
    assert.equal(upcomingBookedCall({ founder_meeting_at: "2026-10-17T18:30:00.000Z" }, now), "Sat, Oct 17, 2:30 p.m. EDT");
    assert.equal(upcomingBookedCall({ founder_meeting_at: "2026-10-15T18:30:00.000Z" }, now), undefined, "a past call");
    assert.equal(upcomingBookedCall({ founder_meeting_at: "soon" }, now), undefined, "not a date");
    assert.equal(upcomingBookedCall({ founder_meeting_at: "" }, now), undefined);
    assert.equal(upcomingBookedCall({}, now), undefined);
  });

  const answers = (email: string) => ({
    name: "Dana Reyes",
    email,
    company: "Acme",
    automation_goal: "agent_fleet",
    bottleneck_detail: "Qualified leads wait for days because nobody owns a reliable follow-up queue.",
    monthly_revenue: "250k_plus",
    team_size: "21_100",
    budget: "15k_plus",
    timeframe: "immediate",
    wants_call: "yes",
  });
  const deliver = (leadId: string) =>
    ensureAiAuditSubmissionDelivery({
      db,
      tenantId: OASIS,
      formId: AUDIT_FORM,
      leadId,
      answers: answers(`${leadId}@acme.test`),
      score: scoreAiAuditLead(answers(`${leadId}@acme.test`)),
    });
  const delivered = async (leadId: string) => {
    const email = await seed.execute({
      sql: "SELECT subject, content FROM lead_interactions WHERE tenant_id = ? AND lead_id = ? AND channel = 'email'",
      args: [OASIS, leadId],
    });
    const events = await seed.execute({
      sql: "SELECT payload FROM agent_events WHERE correlation_id = ? AND event_type = 'OASIS_AI_AUDIT_COMPLETED'",
      args: [OASIS],
    });
    const event = events.rows
      .map((row) => JSON.parse(String(row.payload)) as Record<string, unknown>)
      .find((payload) => payload.lead_id === leadId);
    assert.equal(email.rows.length, 1, `${leadId}: one email queued`);
    return { subject: String(email.rows[0].subject), body: String(email.rows[0].content), event };
  };

  await check("a lead who booked before finishing: the event says booked, the email confirms the call", async () => {
    const result = await deliver("booked-first");
    assert.ok(result.bookedCall, "the alert is told the call's time");
    const { subject, body, event } = await delivered("booked-first");
    assert.equal(event?.booking_status, "booked");
    assert.match(body, /Your call is booked, and the Google Calendar invite in your inbox has the time and the Meet link\./);
    assert.doesNotMatch(body, /\/f\/oasis-ai-cc\/ai-audit\//, "no link to book a second call");
    assert.doesNotMatch(body, /pick the time|go\/community/);
    assert.doesNotMatch(subject, /booking your AI audit call/, "the subject does not ask them to book");
  });

  await check("a lead with no upcoming call: unbooked, and the email offers the calendar as before", async () => {
    for (const leadId of ["never-booked", "booked-long-ago"]) {
      const result = await deliver(leadId);
      assert.equal(result.bookedCall, undefined, leadId);
      const { subject, body, event } = await delivered(leadId);
      assert.equal(event?.booking_status, "unbooked", leadId);
      assert.match(body, /You asked for a call, so pick the time that works here: \S+\/f\/oasis-ai-cc\/ai-audit\/\S+\?book=1/, leadId);
      assert.match(subject, /booking your AI audit call/, leadId);
    }
  });

  finish("public-booking-early");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
