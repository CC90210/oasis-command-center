import "server-only";

/**
 * notification_log — the complete record of what the agents told CC.
 *
 * CC (2026-11-05): "make sure all the automation notifications are also displayed on
 * the OasisAI command center." Telegram stays the curated push; every notice Bravo,
 * Maven, Atlas or the Command Center sends (or tries to send) also lands here, and the
 * Automations page lists it (app/api/automations/notifications). Schema:
 * database/turso/bravo__254_notification_log.sql.
 *
 * The Python agents write the same columns from their own notify modules. This file
 * is the Command Center's writer (sendTelegram's operator lane) and the one reader.
 *
 * Before the migration is applied the table does not exist: a write is a quiet no-op,
 * a read says "not set up yet", and the purge reports notInstalled. Never a crash.
 */

import type { Client } from "@libsql/client";

export const NOTIFICATION_AGENTS = ["bravo", "maven", "atlas", "command_center"] as const;
export type NotificationAgent = (typeof NOTIFICATION_AGENTS)[number];
export type NotificationSeverity = "info" | "warn" | "urgent";

export const NOTIFICATION_LOG_RETENTION_DAYS = 90;
const DAY = 86_400_000;
const PURGE_BATCH = 500;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const READ_MAX = 200;

export type NotificationRow = {
  id: string;
  agent: NotificationAgent;
  category: string | null;
  title: string;
  body: string | null;
  severity: NotificationSeverity;
  bridge: NotificationAgent | null;
  delivered: boolean;
  detail: string | null;
  source: string | null;
  created_at: string;
};

export type NotificationRead =
  | { ok: true; rows: NotificationRow[] }
  | { ok: false; reason: "not_installed" | "read_failed" };

export function isNotificationAgent(value: unknown): value is NotificationAgent {
  return typeof value === "string" && (NOTIFICATION_AGENTS as readonly string[]).includes(value);
}

function clip(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Telegram text is HTML; the page shows plain text. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** A notice's first non-empty line is its title; the rest is the body. */
export function splitNotice(text: string): { title: string; body: string | null } {
  const lines = plainText(text).split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return { title: "(empty notice)", body: null };
  return { title: lines[first].trim(), body: lines.slice(first + 1).join("\n").trim() || null };
}

/**
 * Record one notice. Best-effort by contract: never throws, so a failed record can
 * never fail the send it describes. Returns whether the row was written.
 */
export async function recordNotification(
  db: Client,
  input: {
    tenantId: string;
    agent: NotificationAgent;
    title: string;
    body?: string | null;
    category?: string | null;
    severity?: NotificationSeverity;
    bridge?: NotificationAgent | null;
    delivered: boolean;
    detail?: string | null;
    source?: string | null;
    now?: Date;
  },
): Promise<boolean> {
  try {
    await db.execute({
      sql: `INSERT INTO notification_log
              (id, tenant_id, agent, category, title, body, severity, bridge, delivered, detail, source, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        crypto.randomUUID(),
        input.tenantId,
        input.agent,
        clip(input.category, 60),
        clip(input.title, TITLE_MAX) ?? "(empty notice)",
        clip(input.body, BODY_MAX),
        input.severity ?? "info",
        input.bridge ?? null,
        input.delivered ? 1 : 0,
        clip(input.detail, 300),
        clip(input.source, 120),
        (input.now ?? new Date()).toISOString(),
      ],
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such table/i.test(message)) console.error("[notification-log] record failed:", message);
    return false;
  }
}

/** The newest notices for a workspace, optionally one agent's, newest first. */
export async function readRecentNotifications(
  db: Client,
  tenantId: string,
  opts: { agent?: NotificationAgent; limit?: number } = {},
): Promise<NotificationRead> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, READ_MAX));
  const args: (string | number)[] = [tenantId];
  let where = "tenant_id = ?";
  if (opts.agent) {
    where += " AND agent = ?";
    args.push(opts.agent);
  }
  args.push(limit);
  try {
    const rs = await db.execute({
      sql: `SELECT id, agent, category, title, body, severity, bridge, delivered, detail, source, created_at
              FROM notification_log WHERE ${where} ORDER BY created_at DESC LIMIT ?`,
      args,
    });
    const rows = rs.rows.map((row) => {
      const r = row as unknown as Record<string, unknown>;
      return {
        id: String(r.id),
        agent: (isNotificationAgent(r.agent) ? r.agent : "bravo") as NotificationAgent,
        category: r.category == null ? null : String(r.category),
        title: String(r.title ?? ""),
        body: r.body == null ? null : String(r.body),
        severity: (r.severity === "warn" || r.severity === "urgent" ? r.severity : "info") as NotificationSeverity,
        bridge: isNotificationAgent(r.bridge) ? r.bridge : null,
        // libSQL over HTTP can return integers as strings.
        delivered: Number(r.delivered) === 1,
        detail: r.detail == null ? null : String(r.detail),
        source: r.source == null ? null : String(r.source),
        created_at: String(r.created_at ?? ""),
      };
    });
    return { ok: true, rows };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) return { ok: false, reason: "not_installed" };
    console.error("[notification-log] read failed:", message);
    return { ok: false, reason: "read_failed" };
  }
}

/** 90-day retention, pruned in batches by /api/cron/connection-health. */
export async function purgeNotificationLog(db: Client, now: Date): Promise<{ deleted: number; notInstalled: boolean }> {
  const cutoff = new Date(now.getTime() - NOTIFICATION_LOG_RETENTION_DAYS * DAY).toISOString();
  try {
    const rs = await db.execute({
      sql: `DELETE FROM notification_log WHERE id IN (
              SELECT id FROM notification_log WHERE created_at < ? LIMIT ${PURGE_BATCH})`,
      args: [cutoff],
    });
    return { deleted: rs.rowsAffected, notInstalled: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) return { deleted: 0, notInstalled: true };
    throw err;
  }
}
