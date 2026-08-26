/**
 * GET+POST /api/cron/reconcile-calendar-reminders — drains follow-up reminders
 * that were promised in the app but never reached Google Calendar.
 *
 * WHY THIS EXISTS. When an operator writes a note with a follow-up time, the
 * lead write is the source of truth and the calendar push is a mirror that runs
 * after it. If Google is unreachable at that instant, the operator sees one
 * honest line saying so and then goes back to calling. Nobody returns to fix it.
 * A five-second outage therefore cost a phone reminder permanently, and the
 * failure was invisible: a lead with a reminder and a lead whose reminder never
 * landed look identical on every screen.
 *
 * This run is the thing that closes that gap. It never invents work: it only
 * touches leads the write path explicitly marked `follow_up_sync_state:
 * "pending"`, which happens only for transport-shaped failures.
 *
 * WHAT IT DELIBERATELY DOES NOT RETRY. `"blocked"` records need a person to
 * act (connect Google, re-grant the scope, replace a revoked token). Retrying
 * those on a timer would burn quota forever, never fix the cause, and page
 * about it every cycle. They are surfaced to the operator instead, on the lead.
 */

import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { updateRecord } from "@/lib/manifest/data";
import { writeAgentAlert } from "@/lib/notify/agent-alert";
import { removeReminderEvent } from "@/lib/integrations/calendar-reminder";
import {
  syncFollowUpReminder,
  isDueForRetry,
  FOLLOW_UP_FIELDS,
} from "@/lib/leads/follow-up";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Ceiling on records examined per run. The pending set is small by nature (it
 * only grows during a Google outage), but a cap keeps one bad window from
 * running the function to its timeout. Anything left waits for the next tick,
 * and `truncated` in the response says so rather than reading as "all clear".
 */
const SCAN_LIMIT = 200;

type LeadRow = {
  id: string;
  tenant_id: string;
  data: Record<string, unknown> | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const startedAt = Date.now();
  const db = getServiceSupabase();

  // Filter on the state only, then decide due-ness in JS.
  //
  // A range comparison against a value INSIDE the JSON document
  // (`next_attempt_at <= now`) would depend on the Turso PostgREST bridge
  // supporting operators it is not proven to support, and a filter the bridge
  // silently mistranslates returns a plausible empty set rather than an error.
  // The pending set is small, so scanning it and comparing here is both safe
  // and cheap. See isDueForRetry.
  const scan = await db
    .from("tenant_records")
    .select("id, tenant_id, data")
    .eq("entity_type", "lead")
    .eq(`data->>${FOLLOW_UP_FIELDS.state}`, "pending")
    .limit(SCAN_LIMIT);

  if (scan.error) {
    // Fail loudly. A reconciler that reports success when it could not read its
    // own work queue is worse than one that is down, because it silences the
    // very alarm that would reveal the backlog.
    return NextResponse.json(
      { ok: false, error: "scan_failed", detail: scan.error.message },
      { status: 500 },
    );
  }

  const rows = (scan.data || []) as LeadRow[];
  const counts = {
    scanned: rows.length,
    due: 0,
    synced: 0,
    stillPending: 0,
    exhausted: 0,
    blocked: 0,
    unattributed: 0,
    persistFailed: 0,
  };
  const exhaustedByTenant = new Map<string, number>();

  for (const row of rows) {
    const data = (row.data || {}) as Record<string, unknown>;
    if (!isDueForRetry(data, Date.now())) continue;
    counts.due += 1;

    const operatorUserId = asString(data[FOLLOW_UP_FIELDS.operatorUserId]);
    if (!operatorUserId) {
      // Nothing to retry against. Park it rather than guessing an owner: a
      // reminder pushed to the wrong operator lands on a stranger's phone.
      counts.unattributed += 1;
      try {
        await updateRecord({
          tenant_id: row.tenant_id,
          entity: "lead",
          id: row.id,
          patch: {
            [FOLLOW_UP_FIELDS.state]: "blocked",
            [FOLLOW_UP_FIELDS.reason]: "unattributed",
            [FOLLOW_UP_FIELDS.detail]: "no operator recorded for this reminder",
            [FOLLOW_UP_FIELDS.nextAttemptAt]: null,
          },
        });
      } catch {
        counts.persistFailed += 1;
      }
      continue;
    }

    const existingEventId = asString(data[FOLLOW_UP_FIELDS.eventId]);
    const attemptsRaw = Number(data[FOLLOW_UP_FIELDS.attempts]);
    const attempts = Number.isFinite(attemptsRaw) && attemptsRaw > 0 ? attemptsRaw : 0;

    const outcome = await syncFollowUpReminder({
      lead: {
        leadId: row.id,
        tenantId: row.tenant_id,
        operatorUserId,
        // Retry the reminder AS SCHEDULED, from the snapshot taken when the
        // operator saved it. Rebuilding it from the lead as it looks now would
        // quietly push a different reminder than the one they were promised.
        businessName:
          asString(data[FOLLOW_UP_FIELDS.summary])?.replace(/^Call\s+/, "") ||
          asString(data.company) ||
          asString(data.name) ||
          "lead",
        phone: asString(data.phone),
        leadUrl: `${req.nextUrl.origin}/pipeline/${row.id}`,
        timeZone: asString(data[FOLLOW_UP_FIELDS.timeZone]),
      },
      followUpAt: asString(data[FOLLOW_UP_FIELDS.at]),
      note: asString(data[FOLLOW_UP_FIELDS.note]),
      existingEventId,
      attempts,
    });

    if (outcome.state === "synced") counts.synced += 1;
    else if (outcome.state === "pending") counts.stillPending += 1;
    else if (outcome.state === "blocked") {
      counts.blocked += 1;
      if (outcome.patch[FOLLOW_UP_FIELDS.reason] === "retry_exhausted") {
        counts.exhausted += 1;
        exhaustedByTenant.set(row.tenant_id, (exhaustedByTenant.get(row.tenant_id) || 0) + 1);
      }
    }

    try {
      await updateRecord({
        tenant_id: row.tenant_id,
        entity: "lead",
        id: row.id,
        patch: outcome.patch,
      });
    } catch {
      // Same hazard as the write path: an event Google created that we could
      // not record is unaddressable forever. Roll it back to "no reminder",
      // which the next tick can recreate cleanly.
      counts.persistFailed += 1;
      const newId = outcome.patch[FOLLOW_UP_FIELDS.eventId];
      if (typeof newId === "string" && newId && newId !== existingEventId) {
        await removeReminderEvent(row.tenant_id, operatorUserId, newId);
      }
    }
  }

  // Page only on the terminal condition: a reminder that has run out of retries
  // is a promise to a prospect that no phone will ever surface. Transient
  // pending records are the system working, and alerting on them every tick is
  // how a useful signal becomes noise nobody reads.
  for (const [tenantId, count] of exhaustedByTenant) {
    try {
      await writeAgentAlert({
        tenantId,
        alertType: "calendar_reminder_unrecoverable",
        severity: "warn",
        title: `${count} follow-up reminder${count === 1 ? "" : "s"} gave up reaching Google Calendar`,
        body:
          "The follow-up is still on the lead in the pipeline, so nothing was lost, " +
          "but it will not appear on the rep's phone. Check the Google connection in Settings.",
        lane: "operator",
        subjectType: "lead",
        payload: { count, source: "reconcile-calendar-reminders" },
      });
    } catch {
      // An alert that cannot be delivered must not abort the drain.
    }
  }

  const body = {
    ok: true,
    ...counts,
    truncated: rows.length >= SCAN_LIMIT,
    ms: Date.now() - startedAt,
  };
  // One structured line per run: this is the only place the pending backlog is
  // observable without opening the database.
  console.log("[reconcile-calendar-reminders]", JSON.stringify(body));
  return NextResponse.json(body);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
