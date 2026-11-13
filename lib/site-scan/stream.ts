/**
 * lib/site-scan/stream.ts — the live scan on the wire (GET /api/scan/:id/stream).
 *
 *   id: <n>   event: ev      data: ScanEvent        one feed line (`id` lets EventSource resume)
 *             event: scan    data: ScanView         the scan changed (status, a section landed)
 *             event: end     data: ScanView         the scan is over: the final report
 *             event: window  data: {}               this connection's window is up; reconnect
 *   : ping                                          keeps an idle connection open
 *
 * The follower reads the table, never memory, so the page that started the scan, a reload, and a
 * second tab all get the same feed: saved events after the last id they saw, then the live ones.
 * A window lasts WINDOW_MS (longer while this connection is running the scan's Tier 0 itself), and
 * EventSource reconnects on its own with Last-Event-ID, so the window is invisible to the visitor.
 */
import type { Client } from "@libsql/client";
import { listEvents, type ScanEvent } from "@/lib/site-scan/events";
import { currentScan } from "@/lib/site-scan/sweep";
import type { ScanView } from "@/lib/site-scan/types";
import { toView } from "@/lib/site-scan/view";

export type ScanFrame = { type: "event"; event: ScanEvent } | { type: "scan"; scan: ScanView } | { type: "end"; scan: ScanView } | { type: "window" } | { type: "ping" } | { type: "gone" };

export const TAIL_POLL_MS = 450;
/** The scan row is read every ROW_EVERY ticks (and at once after a done/error line). */
export const ROW_EVERY = 3;
export const WINDOW_MS = 25_000;
/** A connection running Tier 0 stays open until it is done, but never longer than this. */
export const DRIVE_MAX_MS = 120_000;
/** A finished scan's last lines may still be landing: wait this long with nothing new before `end`. */
export const END_QUIET_MS = 1_500;
export const PING_MS = 15_000;

export type FollowScan = {
  db: Client;
  tenantId: string;
  scanId: string;
  afterId: number;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** The reader disconnected. */
  gone: () => boolean;
  /** This connection is running the scan's Tier 0 (lib/site-scan/run.ts runTier0Live). */
  driving: () => boolean;
};

export async function* followScan(o: FollowScan): AsyncGenerator<ScanFrame> {
  const start = o.now().getTime();
  let cursor = o.afterId;
  let lastRow = "";
  let lastSent = start;
  let quietSince: number | null = null;
  for (let tick = 0; ; tick++) {
    if (o.gone()) return;
    const events = await listEvents(o.db, { tenantId: o.tenantId, scanId: o.scanId, afterId: cursor, limit: 200 });
    for (const event of events) {
      yield { type: "event", event };
      cursor = event.id;
    }
    const nowMs = o.now().getTime();
    if (events.length) lastSent = nowMs;

    if (tick % ROW_EVERY === 0 || events.some((e) => e.kind === "done" || e.kind === "error")) {
      const row = await currentScan(o.db, o.tenantId, o.scanId, o.now());
      if (!row) {
        yield { type: "gone" };
        return;
      }
      const key = `${row.status}|${row.updatedAt}`;
      if (key !== lastRow) {
        lastRow = key;
        lastSent = nowMs;
        yield { type: "scan", scan: toView(row, o.now()) };
      }
      const finished = row.status === "done" || row.status === "failed";
      if (finished && !o.driving()) {
        quietSince = events.length ? nowMs : (quietSince ?? nowMs);
        if (nowMs - quietSince >= END_QUIET_MS) {
          yield { type: "end", scan: toView(row, o.now()) };
          return;
        }
      } else quietSince = null;
    }

    const elapsed = nowMs - start;
    if ((!o.driving() && elapsed >= WINDOW_MS) || elapsed >= DRIVE_MAX_MS) {
      yield { type: "window" };
      return;
    }
    if (nowMs - lastSent >= PING_MS) {
      lastSent = nowMs;
      yield { type: "ping" };
    }
    await o.sleep(TAIL_POLL_MS);
  }
}

export function encodeScanFrame(f: ScanFrame): string {
  switch (f.type) {
    case "event":
      return `id: ${f.event.id}\nevent: ev\ndata: ${JSON.stringify(f.event)}\n\n`;
    case "scan":
      return `event: scan\ndata: ${JSON.stringify(f.scan)}\n\n`;
    case "end":
      return `event: end\ndata: ${JSON.stringify(f.scan)}\n\n`;
    case "window":
      return "event: window\ndata: {}\n\n";
    case "gone":
      return "event: gone\ndata: {}\n\n";
    case "ping":
      return ": ping\n\n";
  }
}

const enc = new TextEncoder();

/** A reconnect after a `window` frame comes back this fast. */
export const RETRY_MS = 400;

/**
 * Frames as an event-stream response. The reader's disconnect ends the read only; a Tier 0 this
 * connection started is a separate promise the route registered with the platform.
 */
export function scanStreamResponse(frames: AsyncGenerator<ScanFrame>, onGone: () => void): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(`retry: ${RETRY_MS}\n\n`));
    },
    async pull(controller) {
      try {
        const next = await frames.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(encodeScanFrame(next.value)));
      } catch (err) {
        // Closed without a `window` frame: the browser counts it as a failure (useScanStream), and
        // one that keeps failing falls back to reading the scan the plain way.
        console.error("[site-scan.stream]", err instanceof Error ? (err.stack ?? err.message) : String(err));
        controller.close();
      }
    },
    cancel() {
      onGone();
      void frames.return(undefined).catch(() => undefined);
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-store, no-transform", connection: "keep-alive" },
  });
}

/** Where a follower resumes: the larger of ?after= and the Last-Event-ID EventSource sends on reconnect. */
export function resumeAfter(param: string | null, lastEventId: string | null): number {
  const n = (v: string | null) => {
    const x = Number(v ?? "0");
    return Number.isInteger(x) && x >= 0 ? x : 0;
  };
  return Math.max(n(param), n(lastEventId));
}
