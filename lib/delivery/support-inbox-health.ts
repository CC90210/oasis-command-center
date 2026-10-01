/**
 * lib/delivery/support-inbox-health.ts - is support@ being read?
 *
 * The reader runs on CC's PC (BEA scripts/integrations/support_inbox_daemon.py),
 * so it stops whenever that PC sleeps, the daemon dies or the app password is
 * revoked. It posts a heartbeat (POST /api/internal/support/heartbeat) after
 * each sweep, at least every 4 minutes; support_mailbox_status keeps the
 * latest, with the last time a sweep READ the mailbox (last_ok_at).
 *
 * STALE = not read for SUPPORT_INBOX_STALE_MINUTES (20). The SLA cron
 * (lib/delivery/sla-cron.ts) then alerts ONCE per stale stretch: one Telegram
 * to the founders, and one error event on the Feed's tape, which /operations
 * and /health count under "needs you" and show as "support@ not read for N
 * minutes". A successful read ends the stretch, so the next one alerts again.
 * The Support desk page shows the same sentence (inboxHealth).
 *
 * A mailbox that never sent a heartbeat (the reader not started yet) is not
 * stale: there is nothing to alert about until it has run once.
 */
import "server-only";
import type { Client, ResultSet } from "@libsql/client";
import { escapeTelegramHtml } from "@/lib/notify/telegram-format";
import { supportInboxForDesk } from "@/lib/email/support-mailbox";
import { isMissingSupportInboxSchema } from "@/lib/delivery/email-thread";
import { deskForMailbox } from "@/lib/delivery/email-intake";
import type { NotifyDeps } from "@/lib/delivery/notify";
import { authenticateSupportRequest, refuse, supportInboxInstalled, supportJson, type SupportIngestProducer } from "@/lib/delivery/support-ingest-auth";

export const SUPPORT_INBOX_STALE_MINUTES = 20;

type Row = Record<string, unknown>;

function rows(rs: ResultSet): Row[] {
  return rs.rows.map((r) => {
    const o: Row = {};
    rs.columns.forEach((c, i) => {
      const v = (r as unknown as unknown[])[i];
      o[c] = typeof v === "bigint" ? Number(v) : v;
    });
    return o;
  });
}

const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));

export type MailboxStatusRow = {
  tenant_id: string;
  mailbox: string;
  ok: boolean;
  last_error: string | null;
  last_sweep_at: string;
  last_ok_at: string | null;
  consecutive_failures: number;
  alerted_at: string | null;
  alert_status: string | null;
};

function mapStatus(r: Row): MailboxStatusRow {
  return {
    tenant_id: String(r.tenant_id),
    mailbox: String(r.mailbox),
    ok: Number(r.ok) === 1,
    last_error: s(r.last_error),
    last_sweep_at: String(r.last_sweep_at ?? ""),
    last_ok_at: s(r.last_ok_at),
    consecutive_failures: Number(r.consecutive_failures ?? 0) || 0,
    alerted_at: s(r.alerted_at),
    alert_status: s(r.alert_status),
  };
}

export type InboxHealth = {
  state: "not_started" | "reading" | "failing" | "stale";
  /** Minutes since the mailbox was last read; null when it never was. */
  minutesSinceRead: number | null;
  sentence: string;
};

/** PURE. What to say about one mailbox's latest heartbeat. */
export function inboxHealth(mailbox: string, row: MailboxStatusRow | null, now: Date): InboxHealth {
  if (!row) return { state: "not_started", minutesSinceRead: null, sentence: `${mailbox} is not being read yet: the reader on CC's PC has not started.` };
  const lastRead = Date.parse(row.last_ok_at ?? "");
  const since = Number.isFinite(lastRead) ? lastRead : Date.parse(row.last_sweep_at);
  const minutes = Number.isFinite(since) ? Math.max(0, Math.floor((now.getTime() - since) / 60_000)) : null;
  const why = row.ok || !row.last_error ? "" : ` The last attempt failed (${row.last_error}).`;
  if (minutes === null || minutes >= SUPPORT_INBOX_STALE_MINUTES) {
    return {
      state: "stale",
      minutesSinceRead: Number.isFinite(lastRead) ? minutes : null,
      sentence: `${mailbox} not read for ${minutes ?? "?"} minutes. The reader runs on CC's PC: check that it is on and the support inbox daemon is running.${why}`,
    };
  }
  if (!row.ok) {
    return { state: "failing", minutesSinceRead: Number.isFinite(lastRead) ? minutes : null, sentence: `${mailbox} could not be read at the last attempt.${why}` };
  }
  return {
    state: "reading",
    minutesSinceRead: minutes,
    sentence: `${mailbox} last read ${minutes === 0 ? "less than a minute" : `${minutes} minute${minutes === 1 ? "" : "s"}`} ago.`,
  };
}

/** The desk's support inbox status, or null (no heartbeat yet, no inbox, or the table is missing). */
export async function loadInboxStatus(db: Client, tenantId: string): Promise<{ mailbox: string; row: MailboxStatusRow | null } | null> {
  const mailbox = supportInboxForDesk(tenantId);
  if (!mailbox) return null;
  try {
    const r = rows(
      await db.execute({ sql: "SELECT * FROM support_mailbox_status WHERE tenant_id = ? AND mailbox = ? LIMIT 1", args: [tenantId, mailbox] }),
    )[0];
    return { mailbox, row: r ? mapStatus(r) : null };
  } catch (err) {
    if (isMissingSupportInboxSchema(err)) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The heartbeat route
// ---------------------------------------------------------------------------

export type HeartbeatBody = {
  mailbox: string;
  producer: string;
  phase: string;
  ok: boolean;
  errorCode: string | null;
  at: string | null;
  lastOkAt: string | null;
  consecutiveFailures: number;
  counts: Record<string, number>;
};

const CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The reader's heartbeat body (BEA scripts/support/ingest.py heartbeat_payload). */
export function validateHeartbeat(raw: unknown): { ok: true; value: HeartbeatBody } | { ok: false; field: string } {
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!b) return { ok: false, field: "body" };
  if (typeof b.mailbox !== "string") return { ok: false, field: "mailbox" };
  if (typeof b.producer !== "string" || !CODE.test(b.producer)) return { ok: false, field: "producer" };
  if (typeof b.phase !== "string" || !CODE.test(b.phase)) return { ok: false, field: "phase" };
  if (typeof b.ok !== "boolean") return { ok: false, field: "ok" };
  if (b.error_code !== null && b.error_code !== undefined && !(typeof b.error_code === "string" && CODE.test(b.error_code))) {
    return { ok: false, field: "error_code" };
  }
  const time = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.length <= 40 && Number.isFinite(Date.parse(v)));
  if (!time(b.at)) return { ok: false, field: "at" };
  if (!time(b.last_ok_at)) return { ok: false, field: "last_ok_at" };
  const failures = b.consecutive_failures ?? 0;
  if (typeof failures !== "number" || !Number.isInteger(failures) || failures < 0) return { ok: false, field: "consecutive_failures" };
  const counts: Record<string, number> = {};
  if (b.counts !== undefined && b.counts !== null) {
    if (typeof b.counts !== "object" || Array.isArray(b.counts)) return { ok: false, field: "counts" };
    const entries = Object.entries(b.counts as Record<string, unknown>);
    if (entries.length > 50) return { ok: false, field: "counts" };
    for (const [k, v] of entries) {
      if (!CODE.test(k) || typeof v !== "number" || !Number.isFinite(v)) return { ok: false, field: "counts" };
      counts[k] = Math.trunc(v);
    }
  }
  return {
    ok: true,
    value: {
      mailbox: b.mailbox.trim().toLowerCase(),
      producer: b.producer,
      phase: b.phase,
      ok: b.ok,
      errorCode: (b.error_code as string | null | undefined) ?? null,
      at: (b.at as string | null | undefined) ?? null,
      lastOkAt: (b.last_ok_at as string | null | undefined) ?? null,
      consecutiveFailures: failures,
      counts,
    },
  };
}

/**
 * Keep the latest heartbeat. A heartbeat that says the sweep read the mailbox
 * stamps last_ok_at with THIS server's clock and ends a stale stretch (clears
 * the alert claim, so the next stretch alerts again). Latest wins.
 */
export async function recordHeartbeat(db: Client, tenantId: string, hb: HeartbeatBody, now: Date): Promise<void> {
  const at = now.toISOString();
  await db.execute({
    sql: `INSERT INTO support_mailbox_status
            (tenant_id, mailbox, producer, phase, ok, last_error, last_sweep_at, reported_at, last_ok_at,
             consecutive_failures, counts_json, alerted_at, alert_status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
          ON CONFLICT (tenant_id, mailbox) DO UPDATE SET
            producer = excluded.producer,
            phase = excluded.phase,
            ok = excluded.ok,
            last_error = excluded.last_error,
            last_sweep_at = excluded.last_sweep_at,
            reported_at = excluded.reported_at,
            last_ok_at = COALESCE(excluded.last_ok_at, support_mailbox_status.last_ok_at),
            consecutive_failures = excluded.consecutive_failures,
            counts_json = excluded.counts_json,
            alerted_at = CASE WHEN excluded.ok = 1 THEN NULL ELSE support_mailbox_status.alerted_at END,
            alert_status = CASE WHEN excluded.ok = 1 THEN NULL ELSE support_mailbox_status.alert_status END,
            updated_at = excluded.updated_at`,
    args: [
      tenantId,
      hb.mailbox,
      hb.producer,
      hb.phase,
      hb.ok ? 1 : 0,
      hb.ok ? null : hb.errorCode,
      at,
      hb.at,
      hb.ok ? at : null,
      hb.consecutiveFailures,
      JSON.stringify(hb.counts),
      at,
    ],
  });
}

export type HeartbeatDeps = { db: Client; env: Record<string, string | undefined>; now: Date };

export async function handleSupportHeartbeat(req: Request, deps: HeartbeatDeps): Promise<Response> {
  const auth = await authenticateSupportRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const v = validateHeartbeat(auth.body);
  if (!v.ok) return refuse(422, "invalid_payload", { field: v.field });
  const desk = deskForMailbox(v.value.mailbox);
  if (!desk) return refuse(422, "unknown_mailbox");
  // The body names who is beating; it must be who signed.
  if (v.value.producer !== (auth.producer as SupportIngestProducer)) return refuse(422, "invalid_payload", { field: "producer" });
  if (!(await supportInboxInstalled(deps.db))) return refuse(503, "not_installed", { detail: "migration bravo__200 is not applied" });
  await recordHeartbeat(deps.db, desk.tenantId, v.value, deps.now);
  return supportJson(200, { ok: true, stale_after_minutes: SUPPORT_INBOX_STALE_MINUTES });
}

// ---------------------------------------------------------------------------
// The stale alert (run by the SLA cron)
// ---------------------------------------------------------------------------

export type StaleAlertResult = { checked: number; alerted: string[]; failures: Array<{ mailbox: string; reason: string }> };

/**
 * One alert per stale stretch, per mailbox. The claim (alerted_at) is a
 * compare-and-set, so overlapping cron runs alert once. A Telegram that fails
 * gives the claim back, so the next run tries again; the event on the Feed's
 * tape is published with the first claim of a stretch and is what /operations
 * counts.
 */
export async function alertStaleSupportInboxes(db: Client, deps: NotifyDeps, now: Date): Promise<StaleAlertResult> {
  const out: StaleAlertResult = { checked: 0, alerted: [], failures: [] };
  let list: MailboxStatusRow[];
  try {
    list = rows(await db.execute({ sql: "SELECT * FROM support_mailbox_status WHERE alerted_at IS NULL", args: [] })).map(mapStatus);
  } catch (err) {
    if (isMissingSupportInboxSchema(err)) return out;
    throw err;
  }
  for (const row of list) {
    out.checked += 1;
    const health = inboxHealth(row.mailbox, row, now);
    if (health.state !== "stale") continue;
    const claimed = await db.execute({
      sql: "UPDATE support_mailbox_status SET alerted_at = ? WHERE tenant_id = ? AND mailbox = ? AND alerted_at IS NULL",
      args: [now.toISOString(), row.tenant_id, row.mailbox],
    });
    if (claimed.rowsAffected !== 1) continue;
    const e = escapeTelegramHtml;
    // The event once per stretch: a retry after a failed Telegram (which left
    // its FAILED text in alert_status) does not publish it again.
    if (deps.publishEvent && row.alert_status === null) {
      try {
        await deps.publishEvent({
          eventType: "SUPPORT_INBOX_STALE",
          tenantId: row.tenant_id,
          severity: "error",
          payload: { mailbox: row.mailbox, minutes_since_read: health.minutesSinceRead, last_error: row.last_error, note: health.sentence },
        });
      } catch (err) {
        console.error("[support-inbox.stale] event not published", err instanceof Error ? err.message : err);
      }
    }
    let sent: { ok: boolean; reason?: string };
    try {
      sent = await deps.telegram(`<b>support@ is not being read</b>\n${e(health.sentence)}`);
    } catch (err) {
      sent = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    if (sent.ok) {
      out.alerted.push(row.mailbox);
      await db.execute({
        sql: "UPDATE support_mailbox_status SET alert_status = ? WHERE tenant_id = ? AND mailbox = ?",
        args: [`telegram: sent (${health.sentence})`.slice(0, 500), row.tenant_id, row.mailbox],
      });
    } else {
      out.failures.push({ mailbox: row.mailbox, reason: (sent.reason || "unknown").slice(0, 200) });
      // Give the claim back so the next run retries the Telegram.
      await db.execute({
        sql: "UPDATE support_mailbox_status SET alerted_at = NULL, alert_status = ? WHERE tenant_id = ? AND mailbox = ?",
        args: [`telegram: FAILED (${(sent.reason || "unknown").slice(0, 160)})`, row.tenant_id, row.mailbox],
      });
    }
  }
  return out;
}
