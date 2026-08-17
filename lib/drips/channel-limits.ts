/**
 * lib/drips/channel-limits.ts — read and write the per-channel send ceilings.
 *
 * Stored on `tenants.custom_fields.drip_limits`. That column is an existing
 * JSON blob, so this needed no migration and no new table for four integers —
 * and the rules that interpret them live in channel-limits-core.ts, which is
 * where the tests point.
 *
 * FAILS OPEN TO THE ENV, deliberately, and this is the one judgement worth
 * stating. An unreadable tenants row resolves to the env/default ceilings
 * rather than to zero. Zero would be "safer" in the abstract, but it is a
 * silent full stop on every channel triggered by a database blip — the exact
 * shape of the outages this engine has already produced three times. The
 * ceilings are a THROTTLE, not a safety interlock; suppression, consent and the
 * carrier breaker are the interlocks, and every one of those fails closed.
 */

import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import {
  resolveLimits,
  validateLimits,
  type ChannelLimits,
  type LimitKey,
  type LimitProblem,
} from "./channel-limits-core";

type Db = ReturnType<typeof getServiceSupabase>;

/** Cache for one dispatch run. The engine asks per row; the answer changes when
 *  an operator edits it, not within a batch. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; limits: ChannelLimits }>();

export function resetChannelLimitsCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

export async function getChannelLimits(tenantId: string): Promise<ChannelLimits> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.limits;

  let stored: unknown = null;
  try {
    const db = getServiceSupabase();
    const r = await db.from("tenants").select("custom_fields").eq("id", tenantId).maybeSingle();
    if (!r.error) {
      const cf = (r.data as { custom_fields?: unknown } | null)?.custom_fields;
      // libSQL hands JSON columns back as TEXT, so a string here is normal
      // rather than a bug. Parsing failure falls through to env, not to zero.
      const parsed = typeof cf === "string" ? safeParse(cf) : cf;
      stored = (parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).drip_limits : null) ?? null;
    }
  } catch {
    // Fall through to env. See the fail-open note in the file header.
  }

  const limits = resolveLimits(stored);
  cache.set(tenantId, { at: Date.now(), limits });
  return limits;
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export type SaveResult =
  | { ok: true; limits: ChannelLimits }
  | { ok: false; problems: LimitProblem[] }
  | { ok: false; error: string };

/**
 * Apply an operator's change.
 *
 * READ-MODIFY-WRITE on the whole custom_fields blob, because it holds other
 * tenants' settings too and a bare update would delete them. Validated in the
 * core first: a number field in a browser is not validation, and a typo of 5000
 * would burn a domain before anyone noticed.
 */
export async function saveChannelLimits(
  tenantId: string,
  patch: Partial<Record<LimitKey, unknown>>,
): Promise<SaveResult> {
  const v = validateLimits(patch);
  if (!v.ok) return { ok: false, problems: v.problems };
  if (Object.keys(v.values).length === 0) return { ok: false, error: "nothing to change" };

  const db: Db = getServiceSupabase();

  // OPTIMISTIC RETRY. custom_fields is a blob shared with other product
  // features, so a read-modify-write can silently discard a change another
  // request made between our read and our write. There is no atomic JSON merge
  // available through the adapter, so instead: write, read back, and if our
  // keys did not land the way we set them, someone else won the race — merge
  // onto their newer blob and try again. Codex flagged the unguarded version.
  //
  // Bounded at three attempts. A control that hangs retrying is worse than one
  // that says it could not save.
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await db.from("tenants").select("custom_fields").eq("id", tenantId).maybeSingle();
    if (cur.error) return { ok: false, error: `could not read settings: ${cur.error.message}` };

    const rawCf = (cur.data as { custom_fields?: unknown } | null)?.custom_fields;
    const cf = ((typeof rawCf === "string" ? safeParse(rawCf) : rawCf) ?? {}) as Record<string, unknown>;
    const existing = (cf.drip_limits && typeof cf.drip_limits === "object" ? cf.drip_limits : {}) as Record<string, unknown>;

    const next = { ...cf, drip_limits: { ...existing, ...v.values } };
    const w = await db.from("tenants").update({ custom_fields: next }).eq("id", tenantId);
    // The adapter RETURNS errors rather than throwing. Reporting success on a
    // failed write is how an operator "changes" a cap that never moved.
    if (w.error) return { ok: false, error: `could not save: ${w.error.message}` };

    const back = await db.from("tenants").select("custom_fields").eq("id", tenantId).maybeSingle();
    if (back.error) {
      // The write reported success and we cannot confirm it. Say so rather than
      // claiming a value the engine may not be using.
      return { ok: false, error: `saved but could not confirm: ${back.error.message}` };
    }
    const rawBack = (back.data as { custom_fields?: unknown } | null)?.custom_fields;
    const cfBack = ((typeof rawBack === "string" ? safeParse(rawBack) : rawBack) ?? {}) as Record<string, unknown>;
    const landed = (cfBack.drip_limits ?? {}) as Record<string, unknown>;
    const allApplied = Object.entries(v.values).every(([k, val]) => landed[k] === val);
    if (allApplied) {
      resetChannelLimitsCache(tenantId);
      return { ok: true, limits: resolveLimits(landed) };
    }
    // Someone else wrote in between. Loop and merge onto their version.
  }
  return { ok: false, error: "another change kept overwriting this one; try again" };
}
