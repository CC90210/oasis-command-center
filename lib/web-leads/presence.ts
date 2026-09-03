/**
 * lib/web-leads/presence.ts — read + validate the ONLINE-PRESENCE blob the
 * JARVIS worker writes (services/leadgen/presence-worker.mjs → migration
 * 013's leadgen_businesses.presence).
 *
 * Phase 2 of scoring-v2 (Adon: "not just the website... the company's
 * overall online presence"). The card renders this beside — never blended
 * into — the website score: two honest numbers a rep can each defend.
 *
 * THE HONESTY CONTRACT this parser preserves end-to-end:
 *   - A pillar the worker did not measure arrives with `score: null` and
 *     every check's `has: null`. Null renders as "not measured", NEVER as a
 *     zero or a failed row. ("We have not looked" and "they have nothing"
 *     are different sentences — the same rule the website audit was built
 *     on.)
 *   - A blob from a different presenceVersion, or one that fails shape
 *     validation, collapses to `{ state: "none" }` — the card then shows
 *     the honest not-measured-yet section and the auto-enqueue effect asks
 *     the worker for a fresh one. Malformed data never renders as findings.
 *   - `fetchedAt` travels with the blob so the card can say HOW FRESH the
 *     Google numbers are; staleness past PRESENCE_STALE_DAYS re-enqueues.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import { WEBDEV_TENANT_ID } from "@/lib/web-leads/tenant";
import { safeFilterValue } from "@/lib/web-leads/audit";

/** Mirrors JARVIS services/leadgen/lib/presence-model.js PRESENCE_VERSION.
 *  Kept in sync BY HAND, same discipline as MODEL_VERSION (tenant.ts). */
export const PRESENCE_VERSION = 1;

/** A blob older than this asks for a refresh on card-open. Google review
 *  counts move weekly, not hourly; 30 days keeps lookups rare and numbers
 *  defensible. */
export const PRESENCE_STALE_DAYS = 30;

export type PresenceCheck = {
  code: string;
  label: string;
  points: number;
  /** true/false = measured; null = this pillar was not measured at all. */
  has: boolean | null;
};

export type PresencePillar = {
  key: string;
  label: string;
  /** 0-100, or null when unmeasured (rule: null is never rendered as 0). */
  score: number | null;
  weight: number;
  checks: PresenceCheck[];
  missing: string[];
};

export type PresenceBlob = {
  presenceVersion: number;
  fetchedAt: string;
  pillars: PresencePillar[];
  composite: number | null;
  /** The cached Google answer (rating, count, status...) for evidence lines. */
  gbp?: Record<string, unknown> | null;
};

export type OnlinePresence =
  | { state: "none" }
  | { state: "measured"; blob: PresenceBlob; stale: boolean };

function coerce(raw: unknown): PresenceBlob | null {
  let v: unknown = raw;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const b = v as Partial<PresenceBlob>;
  if (b.presenceVersion !== PRESENCE_VERSION) return null;
  if (typeof b.fetchedAt !== "string") return null;
  if (!Array.isArray(b.pillars) || b.pillars.length === 0) return null;
  for (const p of b.pillars) {
    if (!p || typeof p.key !== "string" || !Array.isArray(p.checks)) return null;
    if (!(typeof p.score === "number" || p.score === null)) return null;
  }
  if (!(typeof b.composite === "number" || b.composite === null)) return null;
  return b as PresenceBlob;
}

export function isPresenceStale(fetchedAt: string, now = Date.now()): boolean {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return true;
  return now - t > PRESENCE_STALE_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * The one presence read the battlecard payload makes. Returns the honest
 * "none" state on absence, version mismatch, or malformed data — never
 * throws malformedness into the card, never renders it as findings.
 */
export async function fetchOnlinePresence(businessId: string | null): Promise<OnlinePresence> {
  if (!businessId) return { state: "none" };
  const bid = safeFilterValue(businessId);
  if (!bid) return { state: "none" };
  const db = getServiceSupabase();
  const { data, error } = await db
    .from("leadgen_businesses")
    .select("presence,presence_fetched_at")
    .eq("tenant_id", WEBDEV_TENANT_ID)
    .eq("id", bid)
    .maybeSingle();
  if (error) throw new Error(`presence_read_failed: ${error.message}`);
  const blob = coerce((data as { presence?: unknown } | null)?.presence);
  if (!blob) return { state: "none" };
  return { state: "measured", blob, stale: isPresenceStale(blob.fetchedAt) };
}
