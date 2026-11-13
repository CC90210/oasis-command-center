/**
 * lib/site-scan/events.ts — a scan's live feed (database/turso/bravo__260_site_scan_events.sql).
 *
 * What the visitor watches while the scan works: each page read, each check, each signal found,
 * then the runner's category, location, competitors and prospects. Every event is a step that
 * actually happened, with the fact it found; narration ("Reading it the way a first-time buyer
 * would") describes an action, never a finding.
 *
 * Writers buffer (EventSink: one batch every FLUSH_MS, or at FLUSH_AT events) so a page read is
 * never slowed by a database round trip per line. A failed write is logged and dropped: the feed
 * is the show, the report is the product, and the report never waits on the feed.
 */
import type { Client, InStatement } from "@libsql/client";
import { isMissingTableError } from "@/lib/api-helpers";

export const EVENT_KINDS = [
  "note",
  "page",
  "check",
  "signal",
  "speed",
  "score",
  "geo",
  "screenshot",
  "category",
  "competitor",
  "prospect",
  "segment",
  "dns",
  "email",
  "done",
  "error",
] as const;
export type ScanEventKind = (typeof EVENT_KINDS)[number];
export type ScanEventSource = "worker" | "runner";

export type ScanEvent = {
  id: number;
  at: string;
  source: ScanEventSource;
  kind: ScanEventKind;
  text: string;
  data: Record<string, unknown> | null;
};

/** The feed of one scan stops growing here: a hostile or broken site cannot fill the table. */
export const MAX_EVENTS_PER_SCAN = 400;
export const MAX_EVENT_TEXT = 200;
export const MAX_EVENT_DATA_BYTES = 1_024;
export const FLUSH_MS = 250;
export const FLUSH_AT = 20;

const enc = new TextEncoder();

export function isEventKind(v: unknown): v is ScanEventKind {
  return typeof v === "string" && (EVENT_KINDS as readonly string[]).includes(v);
}

export type CleanEvent = { kind: ScanEventKind; text: string; dataJson: string | null; at: string };

/**
 * One event made safe to store: a known kind, text on one line within MAX_EVENT_TEXT, data as a
 * small JSON object (or none: data that is too big is dropped, never cut into invalid JSON).
 */
export function cleanEvent(input: { kind: unknown; text: unknown; data?: unknown; at: string }): CleanEvent | null {
  if (!isEventKind(input.kind)) return null;
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim().slice(0, MAX_EVENT_TEXT) : "";
  if (!text) return null;
  let dataJson: string | null = null;
  if (input.data && typeof input.data === "object" && !Array.isArray(input.data)) {
    const s = JSON.stringify(input.data);
    if (enc.encode(s).byteLength <= MAX_EVENT_DATA_BYTES) dataJson = s;
  }
  return { kind: input.kind, text, dataJson, at: input.at };
}

/** The rows to append, each guarded by the per-scan cap inside its own statement. */
export function appendStatements(input: { tenantId: string; scanId: string; source: ScanEventSource; events: CleanEvent[] }): InStatement[] {
  return input.events.map((e) => ({
    sql: `INSERT INTO site_scan_events (tenant_id, scan_id, at, source, kind, text, data_json)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM site_scan_events WHERE tenant_id = ? AND scan_id = ?) < ?`,
    args: [input.tenantId, input.scanId, e.at, input.source, e.kind, e.text, e.dataJson, input.tenantId, input.scanId, MAX_EVENTS_PER_SCAN],
  }));
}

export async function appendEvents(db: Client, input: { tenantId: string; scanId: string; source: ScanEventSource; events: CleanEvent[] }): Promise<number> {
  if (!input.events.length) return 0;
  const results = await db.batch(appendStatements(input), "write");
  return results.reduce((n, r) => n + r.rowsAffected, 0);
}

function parseData(v: unknown): Record<string, unknown> | null {
  if (typeof v !== "string" || !v) return null;
  try {
    const d = JSON.parse(v) as unknown;
    return d && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Events after `afterId`, oldest first. A table that is not installed reads as an empty feed. */
export async function listEvents(db: Client, input: { tenantId: string; scanId: string; afterId: number; limit?: number }): Promise<ScanEvent[]> {
  try {
    const rs = await db.execute({
      sql: `SELECT id, at, source, kind, text, data_json FROM site_scan_events WHERE tenant_id = ? AND scan_id = ? AND id > ? ORDER BY id LIMIT ?`,
      args: [input.tenantId, input.scanId, input.afterId, Math.min(500, Math.max(1, input.limit ?? 200))],
    });
    return rs.rows.flatMap((r) => {
      const kind = r.kind;
      if (!isEventKind(kind)) return [];
      return [
        {
          id: Number(r.id),
          at: String(r.at),
          source: r.source === "runner" ? "runner" : "worker",
          kind,
          text: String(r.text),
          data: parseData(r.data_json),
        } satisfies ScanEvent,
      ];
    });
  } catch (err) {
    if (eventsTableMissing(err)) return [];
    throw err;
  }
}

export function eventsTableMissing(err: unknown): boolean {
  const e = err as { message?: string; code?: string } | null;
  return isMissingTableError(e, "site_scan_events") || /no such table: site_scan_events/i.test(e?.message ?? "");
}

/** What Tier 0 and the stream need from a feed: fire-and-forget lines. */
export type ScanEvents = { emit(kind: ScanEventKind, text: string, data?: Record<string, unknown>): void };

export const NO_EVENTS: ScanEvents = { emit: () => undefined };

/**
 * A buffered writer for one scan. emit() never throws and never waits; flush() writes what is
 * queued, in order (flushes chain); close() flushes and stops the timer. A table that is not
 * installed turns the sink off after one log line, so a deploy that runs before its migration
 * scans normally without a feed.
 */
export class EventSink implements ScanEvents {
  private queue: CleanEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private off = false;

  constructor(
    private readonly db: Client,
    private readonly o: { tenantId: string; scanId: string; source: ScanEventSource; now: () => Date },
  ) {}

  emit(kind: ScanEventKind, text: string, data?: Record<string, unknown>): void {
    if (this.off) return;
    const e = cleanEvent({ kind, text, data, at: this.o.now().toISOString() });
    if (!e) return;
    this.queue.push(e);
    if (this.queue.length >= FLUSH_AT) void this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.flush();
      }, FLUSH_MS);
    }
  }

  flush(): Promise<void> {
    this.chain = this.chain.then(async () => {
      const batch = this.queue.splice(0);
      if (!batch.length || this.off) return;
      try {
        await appendEvents(this.db, { tenantId: this.o.tenantId, scanId: this.o.scanId, source: this.o.source, events: batch });
      } catch (err) {
        if (eventsTableMissing(err)) {
          this.off = true;
          console.warn("[site-scan.events] site_scan_events is not installed; this scan runs without a live feed");
          return;
        }
        console.error("[site-scan.events] a batch of feed events was not written", { scanId: this.o.scanId, count: batch.length, error: err instanceof Error ? (err.stack ?? err.message) : String(err) });
      }
    });
    return this.chain;
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }
}
