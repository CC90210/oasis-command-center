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
 * TWO INDEPENDENT JOBS, TWO INDEPENDENT CLOCKS.
 *
 *   1. RETRY  — push a follow-up that has not reached the operator's calendar.
 *   2. CLEANUP — delete a reminder left on a PREVIOUS operator's calendar when
 *                a lead changed hands and the handover delete failed.
 *
 * They are deliberately not coupled. An earlier version hung the cleanup off
 * the sync state, so a stranded reminder was only ever retried when the new
 * operator's own push also happened to be pending. Clearing a reassigned
 * lead's follow-up, or handing it to someone with no Google connection, left
 * the old rep's phone ringing for a call nobody was going to make, with no
 * worker eligible to touch the record again.
 *
 * Both jobs raise the same flag, `follow_up_worker_queue`, which is the key
 * this scan filters on. A second compatibility scan on the legacy
 * `follow_up_sync_state = "pending"` runs alongside it so records written
 * before that flag existed are not silently excluded forever.
 *
 * WHAT IT DELIBERATELY DOES NOT RETRY. `"blocked"` syncs need a person to act
 * (connect Google, re-grant the scope, replace a revoked token). Retrying those
 * on a timer would burn quota forever, never fix the cause, and page about it
 * every cycle. They are surfaced to the operator instead, on the lead.
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
  isStrandedDue,
  nextAttemptAt,
  workerQueueFlag,
  MAX_SYNC_ATTEMPTS,
  WORKER_QUEUE_ON,
  FOLLOW_UP_FIELDS,
} from "@/lib/leads/follow-up";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Ceiling on records examined per run. The queue is small by nature (it only
 * grows during a Google outage or a failed handover), but a cap keeps one bad
 * window from running the function to its timeout. Anything left waits for the
 * next tick, and `truncated` in the response says so rather than reading as
 * "all clear".
 */
const SCAN_LIMIT = 200;

type LeadRow = {
  id: string;
  tenant_id: string;
  updated_at: string | null;
  data: Record<string, unknown> | null;
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  const startedAt = Date.now();
  const db = getServiceSupabase();

  // Filter on the flags only, then decide due-ness in JS.
  //
  // A range comparison against a value INSIDE the JSON document
  // (`next_attempt_at <= now`) would depend on the Turso PostgREST bridge
  // supporting operators it is not proven to support, and a filter the bridge
  // silently mistranslates returns a plausible empty set rather than an error.
  // The queue is small, so scanning it and comparing here is safe and cheap.
  //
  // ORDERED BY `updated_at` ASCENDING, AND THAT IS NOT COSMETIC. An unordered
  // LIMIT can hand back the same first 200 rows every run, so during an outage
  // that produces more than 200 queued leads the rows past the page are never
  // examined until the earlier ones finish -- which, on a ladder that ends at
  // twelve hours, could delay a callback by days. Every attempt writes the
  // record, so oldest-touched-first rotates the whole backlog through the page.
  // `updated_at` is a real column, not a field inside the JSON document, so
  // ordering on it does not depend on bridge support for JSON operators.
  //
  // TWO SCANS, AND THE SECOND IS A COMPATIBILITY SCAN.
  //
  // `follow_up_worker_queue` is new. Any record written by an earlier revision
  // of this feature carries `follow_up_sync_state = "pending"` and NO queue
  // field, so a filter on the new key alone would exclude that entire backlog
  // permanently -- silently, since an excluded row looks exactly like a row
  // with no work. The second scan keeps those visible; every record this
  // worker or the write path touches gets the flag, so the legacy set only
  // drains. Both filters are plain equalities, which is deliberate: an
  // "is not null" against a field inside the JSON document is the shape the
  // Turso bridge could mistranslate into a plausible empty set.
  // (Codex review round 3, 2026-08-26.)
  const [queued, legacyPending] = await Promise.all([
    db
      .from("tenant_records")
      .select("id, tenant_id, updated_at, data")
      .eq("entity_type", "lead")
      .eq(`data->>${FOLLOW_UP_FIELDS.workerQueue}`, WORKER_QUEUE_ON)
      .order("updated_at", { ascending: true })
      .limit(SCAN_LIMIT),
    db
      .from("tenant_records")
      .select("id, tenant_id, updated_at, data")
      .eq("entity_type", "lead")
      .eq(`data->>${FOLLOW_UP_FIELDS.state}`, "pending")
      .order("updated_at", { ascending: true })
      .limit(SCAN_LIMIT),
  ]);

  const scanError = queued.error || legacyPending.error;
  if (scanError) {
    // Fail loudly. A reconciler that reports success when it could not read its
    // own work queue is worse than one that is down, because it silences the
    // very alarm that would reveal the backlog.
    return NextResponse.json(
      { ok: false, error: "scan_failed", detail: scanError.message },
      { status: 500 },
    );
  }

  // MERGE, RE-SORT, THEN CAP. Two queries each capped at SCAN_LIMIT can return
  // disjoint sets, so the union is up to 2x the ceiling -- and the loop below
  // makes serial Google calls, so double the intended work is how this function
  // reaches its 120s limit and dies without persisting the later results. The
  // cap has to be applied to the COMBINED set, oldest-touched first, so the cap
  // still means what it says and rotation still reaches every row.
  // (Codex review round 4, 2026-08-26.)
  const byId = new Map<string, LeadRow>();
  for (const row of [
    ...((queued.data || []) as LeadRow[]),
    ...((legacyPending.data || []) as LeadRow[]),
  ]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }
  const merged = [...byId.values()].sort((a, b) =>
    String(a.updated_at || "").localeCompare(String(b.updated_at || "")),
  );
  const rows = merged.slice(0, SCAN_LIMIT);
  const counts = {
    scanned: rows.length,
    touched: 0,
    synced: 0,
    stillPending: 0,
    exhausted: 0,
    blocked: 0,
    unattributed: 0,
    persistFailed: 0,
    strandedCleared: 0,
    strandedRetrying: 0,
    strandedAbandoned: 0,
  };
  const alertsByTenant = new Map<string, { exhausted: number; stranded: number }>();
  const bumpAlert = (tenantId: string, key: "exhausted" | "stranded") => {
    const row = alertsByTenant.get(tenantId) || { exhausted: 0, stranded: 0 };
    row[key] += 1;
    alertsByTenant.set(tenantId, row);
  };

  for (const row of rows) {
    const data = (row.data || {}) as Record<string, unknown>;
    const now = Date.now();
    const strandedDue = isStrandedDue(data, now);
    const syncDue = isDueForRetry(data, now);
    if (!strandedDue && !syncDue) continue;
    counts.touched += 1;

    const patch: Record<string, unknown> = {};

    // ---- JOB 2: the stranded cleanup, on its own clock ---------------------
    let strandedEventId = asString(data[FOLLOW_UP_FIELDS.strandedEventId]);
    if (strandedDue) {
      const strandedOperator = asString(data[FOLLOW_UP_FIELDS.strandedOperatorUserId]);
      const strandedAttempts = asCount(data[FOLLOW_UP_FIELDS.strandedAttempts]);
      const removed = await removeReminderEvent(
        row.tenant_id,
        strandedOperator as string,
        strandedEventId as string,
      );
      if (removed.ok) {
        counts.strandedCleared += 1;
        strandedEventId = null;
        patch[FOLLOW_UP_FIELDS.strandedEventId] = null;
        patch[FOLLOW_UP_FIELDS.strandedOperatorUserId] = null;
        patch[FOLLOW_UP_FIELDS.strandedAttempts] = 0;
        patch[FOLLOW_UP_FIELDS.strandedNextAttemptAt] = null;
        patch[FOLLOW_UP_FIELDS.strandedReason] = null;
      } else {
        const next = nextAttemptAt(strandedAttempts, now);
        patch[FOLLOW_UP_FIELDS.strandedAttempts] = strandedAttempts + 1;
        patch[FOLLOW_UP_FIELDS.strandedNextAttemptAt] = next;
        if (next) {
          counts.strandedRetrying += 1;
          patch[FOLLOW_UP_FIELDS.strandedReason] = removed.reason;
        } else {
          // OUT OF RETRIES, AND THIS ONE MUST NOT GO QUIET.
          //
          // A live reminder we cannot delete is on a real person's phone. An
          // earlier version left the record `pending` with a null next-attempt,
          // which `isDueForRetry` then rejected forever: no retries, no alert,
          // no trace. It ends as an explicit terminal state that pages.
          counts.strandedAbandoned += 1;
          patch[FOLLOW_UP_FIELDS.strandedReason] = "retry_exhausted";
          bumpAlert(row.tenant_id, "stranded");
        }
      }
    }

    // ---- JOB 1: the sync retry --------------------------------------------
    if (syncDue) {
      const operatorUserId = asString(data[FOLLOW_UP_FIELDS.operatorUserId]);
      if (!operatorUserId) {
        // Nothing to retry against. Park it rather than guessing an owner: a
        // reminder pushed to the wrong operator lands on a stranger's phone.
        counts.unattributed += 1;
        patch[FOLLOW_UP_FIELDS.state] = "blocked";
        patch[FOLLOW_UP_FIELDS.reason] = "unattributed";
        patch[FOLLOW_UP_FIELDS.detail] = "no operator recorded for this reminder";
        patch[FOLLOW_UP_FIELDS.nextAttemptAt] = null;
      } else {
        const existingEventId = asString(data[FOLLOW_UP_FIELDS.eventId]);
        const attempts = asCount(data[FOLLOW_UP_FIELDS.attempts]);
        const outcome = await syncFollowUpReminder({
          lead: {
            leadId: row.id,
            tenantId: row.tenant_id,
            operatorUserId,
            // Retry the reminder AS SCHEDULED, from the snapshot taken when the
            // operator saved it. Rebuilding it from the lead as it looks now
            // would quietly push a different reminder than they were promised.
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
        Object.assign(patch, outcome.patch);

        if (outcome.state === "synced") counts.synced += 1;
        else if (outcome.state === "pending") counts.stillPending += 1;
        else if (outcome.state === "blocked") {
          counts.blocked += 1;
          if (outcome.patch[FOLLOW_UP_FIELDS.reason] === "retry_exhausted") {
            counts.exhausted += 1;
            bumpAlert(row.tenant_id, "exhausted");
          }
        }
      }
    }

    // The flag is recomputed from BOTH jobs, so neither can clear it while the
    // other still owes work. A stranded event that has exhausted its retries
    // drops out of the queue on purpose: no worker can help it now, and the
    // alert above is what carries it to a person.
    const strandedStillQueued =
      Boolean(strandedEventId) && patch[FOLLOW_UP_FIELDS.strandedReason] !== "retry_exhausted";
    patch[FOLLOW_UP_FIELDS.workerQueue] = workerQueueFlag({
      syncState: (patch[FOLLOW_UP_FIELDS.state] ?? data[FOLLOW_UP_FIELDS.state]) as string,
      strandedEventId: strandedStillQueued ? strandedEventId : null,
    });

    try {
      await updateRecord({
        tenant_id: row.tenant_id,
        entity: "lead",
        id: row.id,
        patch,
      });
    } catch {
      // Same hazard as the write path: an event Google created that we could
      // not record is unaddressable forever. Roll it back to "no reminder",
      // which the next tick can recreate cleanly.
      counts.persistFailed += 1;
      const newId = patch[FOLLOW_UP_FIELDS.eventId];
      const priorId = asString(data[FOLLOW_UP_FIELDS.eventId]);
      const operatorUserId = asString(data[FOLLOW_UP_FIELDS.operatorUserId]);
      if (typeof newId === "string" && newId && newId !== priorId && operatorUserId) {
        await removeReminderEvent(row.tenant_id, operatorUserId, newId);
      }
    }
  }

  // Page only on terminal conditions. A reminder that has run out of retries is
  // a promise no phone will surface; a stranded event that cannot be deleted is
  // a live alert on someone's phone for a lead they no longer own. Transient
  // pending records are the system working, and alerting on those every tick is
  // how a useful signal becomes noise nobody reads.
  for (const [tenantId, tally] of alertsByTenant) {
    const parts: string[] = [];
    if (tally.exhausted) {
      parts.push(
        `${tally.exhausted} follow-up reminder${tally.exhausted === 1 ? "" : "s"} gave up reaching Google Calendar. ` +
          "The follow-up is still on the lead, so nothing was lost, but it will not appear on the rep's phone.",
      );
    }
    if (tally.stranded) {
      parts.push(
        `${tally.stranded} reminder${tally.stranded === 1 ? "" : "s"} could not be removed from a previous rep's calendar ` +
          "after repeated attempts, and may still alert them for a lead they no longer own. Remove by hand.",
      );
    }
    try {
      await writeAgentAlert({
        tenantId,
        alertType: "calendar_reminder_unrecoverable",
        severity: "warn",
        title: `Calendar reminders need a human (${tally.exhausted + tally.stranded})`,
        body: parts.join(" "),
        lane: "operator",
        subjectType: "lead",
        payload: { ...tally, source: "reconcile-calendar-reminders" },
      });
    } catch {
      // An alert that cannot be delivered must not abort the drain.
    }
  }

  const body = {
    ok: true,
    ...counts,
    maxSyncAttempts: MAX_SYNC_ATTEMPTS,
    // Truncation is this run's ONLY backlog signal, so it must never
    // under-report. The merged slice alone is not enough: if both queries hit
    // their limit and returned the SAME rows, the union is not sliced and this
    // would read "all clear" while each query still had unseen rows behind it.
    // Either condition means there is more out there. (Codex round 5.)
    truncated:
      merged.length > rows.length ||
      (queued.data || []).length >= SCAN_LIMIT ||
      (legacyPending.data || []).length >= SCAN_LIMIT,
    ms: Date.now() - startedAt,
  };
  // One structured line per run: this is the only place the queue backlog is
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
