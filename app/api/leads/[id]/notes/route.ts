/**
 * /api/leads/[id]/notes — operator-written notes on a lead.
 *
 * Stored in `lead_interactions` with channel='note', direction='internal',
 * agent_source='operator_note'. That table is already the unified
 * interaction ledger (migrations 003 + 049), already tenant-scoped,
 * already surfaced by /api/leads/[id]/timeline. Reusing it instead of
 * introducing a `lead_notes` table means notes show up in the timeline
 * automatically and stay part of the lead's audit trail.
 *
 * Auth: session-cookie → tenant via resolveSessionContext.
 *
 *   GET   — list the lead's notes, newest first, 100 max.
 *   POST  — body { note: string, followUpAt?: string | null } — insert one note,
 *           and optionally schedule (or clear) a follow-up on the operator's
 *           own Google Calendar.
 *
 * ON `followUpAt`, THE TRI-STATE MATTERS:
 *   absent  — leave any existing follow-up exactly as it is. A plain note must
 *             never silently cancel a callback the operator already promised.
 *   null    — clear the follow-up and delete the reminder.
 *   string  — schedule at that instant.
 *
 * The calendar is a MIRROR of `follow_up_at` on the lead, never the record of
 * it. See lib/leads/follow-up.ts for the ordering rule and the retry design.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getAccessibleLeadTarget } from "@/lib/lead-access";
import { assertMayWorkLead } from "@/lib/leads/rep-lead-access";
import { getRecord, updateRecord, RecordsError } from "@/lib/manifest/data";
import { removeReminderEvent } from "@/lib/integrations/calendar-reminder";
import {
  syncFollowUpReminder,
  describeFollowUpSync,
  FOLLOW_UP_FIELDS,
  type FollowUpSyncState,
} from "@/lib/leads/follow-up";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NOTE_LENGTH = 4000;

type NoteRow = {
  id: string;
  content: string | null;
  content_preview: string | null;
  agent_source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  // Per-agent lock + entity resolve: notes disclose lead context — an agent can't
  // read another agent's notes by guessing the id; the drawer opens for both lead
  // and application records, so resolve the linked lead id (Codex 2026-06-19 MEDIUM).
  const target = await getAccessibleLeadTarget(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, id, entityParam: req.nextUrl.searchParams.get("entity") },
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const db = getServiceSupabase();
  const r = await db
    .from("lead_interactions")
    .select("id, content, content_preview, agent_source, created_at, metadata")
    .eq("tenant_id", sess.tenantId)
    .eq("lead_id", target.queryLeadId)
    .eq("channel", "note")
    .order("created_at", { ascending: false })
    .limit(100);
  if (r.error) {
    return NextResponse.json({ ok: false, error: r.error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, notes: (r.data || []) as NoteRow[] });
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 });
  }
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  const target = await getAccessibleLeadTarget(
    { isAdmin: sess.isAdmin, userId: sess.userId },
    { tenantId: sess.tenantId, id, entityParam: req.nextUrl.searchParams.get("entity") },
  );
  if (!target) {
    return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  }
  const access = await assertMayWorkLead({
    teamRole: sess.teamRole,
    userId: sess.userId,
    tenantId: sess.tenantId,
    leadId: target.queryLeadId,
    isOwner: sess.isTrueAdmin,
    adminAccess: sess.adminAccess,
    accessMode: "owned_oasis_sales",
  });
  if (!access.ok) {
    return NextResponse.json(
      { ok: false, error: access.error, message: access.message },
      { status: access.status },
    );
  }
  let body: { note?: unknown; followUpAt?: unknown; reminderMinutes?: unknown; timeZone?: unknown };
  try {
    body = (await req.json()) as {
      note?: unknown;
      followUpAt?: unknown;
      reminderMinutes?: unknown;
      timeZone?: unknown;
    };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const raw = typeof body.note === "string" ? body.note.trim() : "";
  if (!raw) {
    return NextResponse.json({ ok: false, error: "note_required" }, { status: 400 });
  }
  const note = raw.slice(0, MAX_NOTE_LENGTH);

  // Tri-state: undefined leaves the existing follow-up alone, null clears it,
  // a string schedules it. `"followUpAt" in body` is the only way to tell
  // "not supplied" from "explicitly cleared" once JSON has been parsed.
  const followUpSupplied = Object.prototype.hasOwnProperty.call(body, "followUpAt");
  let followUpAt: string | null = null;
  if (followUpSupplied && body.followUpAt !== null) {
    if (typeof body.followUpAt !== "string") {
      return NextResponse.json({ ok: false, error: "invalid_follow_up_at" }, { status: 400 });
    }
    const parsed = Date.parse(body.followUpAt);
    if (!Number.isFinite(parsed)) {
      return NextResponse.json({ ok: false, error: "invalid_follow_up_at" }, { status: 400 });
    }
    // A reminder in the past fires immediately or never, depending on the
    // client. Either way it is not what the operator meant, so refuse it here
    // rather than writing a promise nothing will keep.
    if (parsed <= Date.now()) {
      return NextResponse.json({ ok: false, error: "follow_up_must_be_future" }, { status: 400 });
    }
    followUpAt = new Date(parsed).toISOString();
  }
  // The operator's IANA zone, so the event reads correctly on their phone.
  // Charset-allowlisted rather than trusted: this string is stored on the lead
  // and sent to Google, and "Area/Location" is the entire legal shape.
  let timeZone: string | null = null;
  if (typeof body.timeZone === "string" && body.timeZone) {
    if (!/^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+){0,2}$/.test(body.timeZone)) {
      return NextResponse.json({ ok: false, error: "invalid_time_zone" }, { status: 400 });
    }
    timeZone = body.timeZone;
  }

  let reminderMinutes: number | undefined;
  if (body.reminderMinutes !== undefined) {
    const value = Number(body.reminderMinutes);
    if (!Number.isFinite(value) || value < 0 || value > 40_320) {
      return NextResponse.json({ ok: false, error: "invalid_reminder_minutes" }, { status: 400 });
    }
    reminderMinutes = value;
  }

  const occurredAt = new Date().toISOString();
  const db = getServiceSupabase();
  const ins = await db
    .from("lead_interactions")
    .insert({
      tenant_id: sess.tenantId,
      lead_id: target.queryLeadId,
      // type is NOT NULL in the schema — set explicitly. `channel` is
      // the medium (note, email, sms, phone, etc.); `type` is the
      // higher-level category. Existing rows use {email_sent,
      // email_received, call, note} for type.
      type: "note",
      channel: "note",
      direction: "internal",
      agent_source: "operator_note",
      // actor_user_id is the canonical "who wrote this" field
      // (migration 078). metadata.author_* duplicates kept for
      // backwards-compat with pre-migration analytics; can drop
      // once every reader has been updated.
      actor_user_id: sess.userId,
      content: note,
      content_preview: note.length > 1024 ? note.slice(0, 1024) : note,
      created_at: occurredAt,
      metadata: {
        author_email: sess.email,
        author_profile_id: sess.profileId,
      },
    })
    .select("id, content, content_preview, agent_source, created_at, metadata")
    .single();
  if (ins.error) {
    return NextResponse.json({ ok: false, error: ins.error.message }, { status: 500 });
  }
  // Read the lead BEFORE patching it: the stored event id is the only handle
  // we have on any reminder already on this operator's calendar, and the
  // business name and phone are what make the reminder readable at a glance.
  let leadData: Record<string, unknown> = {};
  if (followUpSupplied) {
    try {
      const record = await getRecord({
        tenant_id: sess.tenantId,
        entity: "lead",
        id: target.queryLeadId,
      });
      leadData = (record?.data || {}) as Record<string, unknown>;
    } catch {
      // Not fatal. A missing read costs us the existing event id, which the
      // sync below handles by creating a fresh event; it never costs the note.
      leadData = {};
    }
  }

  // STEP 2 — THE SOURCE-OF-TRUTH WRITE. `follow_up_at` lands on the lead here,
  // before Google is contacted at all. Everything after this point is a mirror.
  try {
    await updateRecord({
      tenant_id: sess.tenantId,
      entity: "lead",
      id: target.queryLeadId,
      patch: {
        last_contacted_at: occurredAt,
        ...(followUpSupplied ? { [FOLLOW_UP_FIELDS.at]: followUpAt } : {}),
      },
    });
  } catch (error) {
    const code = error instanceof RecordsError ? error.code : "unknown";
    return NextResponse.json(
      { ok: false, error: "touch_update_failed", code, noteSaved: true, note: ins.data },
      { status: 500 },
    );
  }

  if (!followUpSupplied) {
    return NextResponse.json({ ok: true, note: ins.data, touchAt: occurredAt });
  }

  // STEP 3 — THE MIRROR. Never throws, never undoes steps 1 or 2.
  const existingEventId =
    typeof leadData[FOLLOW_UP_FIELDS.eventId] === "string"
      ? (leadData[FOLLOW_UP_FIELDS.eventId] as string)
      : null;
  const outcome = await syncFollowUpReminder({
    lead: {
      leadId: target.queryLeadId,
      tenantId: sess.tenantId,
      operatorUserId: sess.userId,
      businessName:
        (typeof leadData.company === "string" && leadData.company) ||
        (typeof leadData.name === "string" && leadData.name) ||
        "lead",
      phone: typeof leadData.phone === "string" ? leadData.phone : null,
      leadUrl: `${req.nextUrl.origin}/pipeline/${target.queryLeadId}`,
      timeZone:
        timeZone ||
        (typeof leadData[FOLLOW_UP_FIELDS.timeZone] === "string"
          ? (leadData[FOLLOW_UP_FIELDS.timeZone] as string)
          : null),
    },
    followUpAt,
    note,
    existingEventId,
    // A fresh operator action restarts the retry ladder: this is new intent,
    // not a continuation of an old failing attempt.
    attempts: 0,
    reminderMinutes,
  });

  // STEP 4 — PERSIST THE OUTCOME, AND ROLL BACK IF WE CANNOT.
  //
  // The event id only exists here, in memory. If this write fails after Google
  // created an event, nothing will ever be able to address that event again:
  // a later "clear this reminder" would target a null id, succeed vacuously,
  // and leave a live alert on the operator's phone forever. Deleting the event
  // we just made returns us to "no reminder", which is recoverable.
  let syncState: FollowUpSyncState = outcome.state;
  let syncMessage = outcome.message;
  try {
    await updateRecord({
      tenant_id: sess.tenantId,
      entity: "lead",
      id: target.queryLeadId,
      patch: outcome.patch,
    });
  } catch {
    const orphanId = outcome.patch[FOLLOW_UP_FIELDS.eventId];
    if (typeof orphanId === "string" && orphanId && orphanId !== existingEventId) {
      const rolledBack = await removeReminderEvent(sess.tenantId, sess.userId, orphanId);
      syncState = "blocked";
      syncMessage = rolledBack.ok
        ? "Follow-up saved. The phone reminder could not be recorded, so it was removed. Save again to retry."
        : "Follow-up saved, but a reminder may be live on your calendar that we can no longer manage. Remove it by hand.";
    } else {
      syncState = "blocked";
      syncMessage = describeFollowUpSync("blocked", null);
    }
  }

  return NextResponse.json({
    ok: true,
    note: ins.data,
    touchAt: occurredAt,
    followUpAt,
    calendar: { state: syncState, message: syncMessage },
  });
}
