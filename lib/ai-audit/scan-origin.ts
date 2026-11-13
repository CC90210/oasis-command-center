/**
 * lib/ai-audit/scan-origin.ts - the free scans an AI audit was opened from.
 *
 * A lead who sends their free scan to the team (lib/site-scan/claim.ts) opens an audit with a
 * `free_scan_attached` event naming the scan. The scan is the audit's front door (CC,
 * 2026-11-13), so the audit's page links the report the lead saw: its public replay, /scan/<id>.
 * Only a scan id of the right shape on that event becomes a link.
 */
import type { AuditEvent } from "@/lib/ai-audit/store";

export type ScanOrigin = { id: string; domain: string; score: number | null; at: string };

const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function scansAttached(events: readonly AuditEvent[]): ScanOrigin[] {
  const seen = new Set<string>();
  const out: ScanOrigin[] = [];
  for (const ev of events) {
    if (ev.event !== "free_scan_attached" || ev.ref_type !== "site_scan" || !ev.ref_id || !SCAN_ID.test(ev.ref_id) || seen.has(ev.ref_id)) continue;
    seen.add(ev.ref_id);
    const domain = typeof ev.meta?.domain === "string" && ev.meta.domain ? ev.meta.domain : "their website";
    const score = typeof ev.meta?.score === "number" && Number.isFinite(ev.meta.score) ? Math.round(ev.meta.score) : null;
    out.push({ id: ev.ref_id, domain, score, at: ev.created_at });
  }
  return out;
}
