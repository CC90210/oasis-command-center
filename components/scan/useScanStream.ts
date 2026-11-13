"use client";

import { useEffect, useRef, useState } from "react";
import type { ScanEvent } from "@/lib/site-scan/events";
import type { ScanView } from "@/lib/site-scan/types";

/**
 * Follow one scan live: GET /api/scan/:id/stream (lib/site-scan/stream.ts). Opening it is also
 * what starts the scan's read (the first stream claims Tier 0). EventSource resumes on its own
 * after each window with Last-Event-ID; lines are de-duplicated by id. A browser without
 * EventSource, or a stream that keeps failing, falls back to polling GET /api/scan/:id.
 */

const POLL_MS = 2_000;
const MAX_STREAM_FAILURES = 3;

export type ScanStream = {
  scan: ScanView | null;
  events: ScanEvent[];
  /** The scan was already over when this page first saw it (a permalink): no live replay. */
  wasFinished: boolean;
  finished: boolean;
  error: string | null;
  /** The scan is gone (an expired link): nothing more will come. */
  gone: boolean;
};

function over(scan: ScanView): boolean {
  return scan.status === "done" || scan.status === "failed";
}

export function useScanStream(scanId: string | null): ScanStream {
  const [scan, setScan] = useState<ScanView | null>(null);
  const [events, setEvents] = useState<ScanEvent[]>([]);
  const [finished, setFinished] = useState(false);
  const [wasFinished, setWasFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const firstScan = useRef(true);

  useEffect(() => {
    setScan(null);
    setEvents([]);
    setFinished(false);
    setWasFinished(false);
    setError(null);
    setGone(false);
    firstScan.current = true;
    if (!scanId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let es: EventSource | null = null;

    const seen = new Set<number>();
    const addEvent = (ev: ScanEvent) => {
      if (seen.has(ev.id)) return;
      seen.add(ev.id);
      setEvents((prev) => [...prev, ev]);
    };
    const takeScan = (next: ScanView, final: boolean) => {
      if (firstScan.current) {
        firstScan.current = false;
        if (over(next)) setWasFinished(true);
      }
      setScan(next);
      if (final || over(next)) setFinished(final || over(next));
    };

    // A read that fails is tried again (backing off to 10 s) while the scan is unfinished; the
    // visitor is told only after a few misses in a row, and the message clears when a read lands.
    let misses = 0;
    let polling = false;
    const schedule = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void poll(), ms);
    };
    const poll = async () => {
      if (polling || !alive) return;
      polling = true;
      try {
        const res = await fetch(`/api/scan/${encodeURIComponent(scanId)}`, { cache: "no-store" }).catch(() => null);
        if (!alive) return;
        const data = (res ? await res.json().catch(() => null) : null) as { ok?: boolean; scan?: ScanView; error?: string } | null;
        // The visitor may have moved to another scan while the body was read: drop a stale answer.
        if (!alive) return;
        if (data?.error === "not_found") {
          setGone(true);
          setError("That scan link has expired. Start a new one below.");
          return;
        }
        if (!res || !res.ok || !data?.ok || !data.scan) {
          misses += 1;
          if (misses >= 3) setError("The scan could not be read right now. Still trying...");
          schedule(Math.min(10_000, POLL_MS * 2 ** Math.min(misses, 3)));
          return;
        }
        misses = 0;
        setError(null);
        takeScan(data.scan, false);
        if (!over(data.scan)) schedule(POLL_MS);
      } finally {
        polling = false;
      }
    };

    if (typeof window === "undefined" || typeof window.EventSource === "undefined") {
      void poll();
    } else {
      let failures = 0;
      es = new EventSource(`/api/scan/${encodeURIComponent(scanId)}/stream?after=0`);
      es.addEventListener("ev", (e) => {
        failures = 0;
        try {
          addEvent(JSON.parse((e as MessageEvent<string>).data) as ScanEvent);
        } catch {
          // A line that does not parse is skipped; the report is unaffected.
        }
      });
      es.addEventListener("scan", (e) => {
        failures = 0;
        try {
          takeScan(JSON.parse((e as MessageEvent<string>).data) as ScanView, false);
        } catch {
          // The next frame or the final `end` carries the scan again.
        }
      });
      es.addEventListener("end", (e) => {
        es?.close();
        try {
          takeScan(JSON.parse((e as MessageEvent<string>).data) as ScanView, true);
        } catch {
          void poll();
        }
      });
      es.addEventListener("gone", () => {
        es?.close();
        setGone(true);
        setError("That scan link has expired. Start a new one below.");
      });
      // The server ends each window on purpose; the reconnect that follows is not a failure.
      let windowClosed = false;
      es.addEventListener("window", () => {
        windowClosed = true;
      });
      es.onerror = () => {
        if (!alive || !es) return;
        if (es.readyState === EventSource.CLOSED) {
          // Refused outright (a 4xx/5xx, not an event stream): read the scan the plain way.
          void poll();
          return;
        }
        if (windowClosed) {
          windowClosed = false;
          return;
        }
        // A stream that keeps dropping (a proxy that buffers it) is swapped for polling.
        failures += 1;
        if (failures >= MAX_STREAM_FAILURES) {
          es.close();
          void poll();
        }
      };
    }

    return () => {
      alive = false;
      es?.close();
      if (timer) clearTimeout(timer);
    };
  }, [scanId]);

  return { scan, events, finished, wasFinished, error, gone };
}
