/**
 * lib/drips/channel-limits.ts — read and write the per-channel send ceilings.
 *
 * Stored in `drip_channel_limits`, one row per tenant, four nullable integers.
 * The rules that interpret them live in channel-limits-core.ts, which is where
 * the tests point.
 *
 * WHY A TABLE AND NOT THE JSON BLOB THIS STARTED IN. The first version kept
 * these on `tenants.custom_fields.drip_limits` to avoid a migration. That
 * column is shared with other product features, so every write was a
 * read-modify-write over data somebody else owns, and three attempts to make it
 * safe each introduced a subtler bug: a plain write discarded concurrent
 * changes; write-then-verify detected a race that had already happened without
 * preventing the next one; and a compare-and-swap could not work at all,
 * because the adapter parses JSON on read, so the token was a re-serialised
 * object rather than the stored text and any row whose formatting differed
 * would never match.
 *
 * The problem was never the locking, it was sharing a cell. A row no other
 * feature writes needs no compare-and-swap: an upsert is atomic on its own
 * primary key. Verified against the live table before this was written — two
 * upserts leave one row.
 *
 * NULL means "not set here" and falls through to env, then to the built-in
 * default. Deliberately distinct from 0, which means stopped.
 *
 * FAILS OPEN TO THE ENV on a read error, and that is the one judgement worth
 * stating. Zero would be "safer" in the abstract and is wrong: it is a silent
 * full stop on every channel from a database blip. These ceilings are a
 * THROTTLE; suppression, consent and the carrier breaker are the interlocks,
 * and every one of those fails closed.
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

/** camelCase in the app, snake_case in the table. Declared once so a rename
 *  cannot half-apply. */
const COLUMN: Record<LimitKey, string> = {
  smsDaily: "sms_daily",
  smsHourly: "sms_hourly",
  emailDailySunbiz: "email_daily_sunbiz",
  emailDailyBluerise: "email_daily_bluerise",
};

const SELECT = "sms_daily, sms_hourly, email_daily_sunbiz, email_daily_bluerise";

/** Cached for one dispatch run. The engine asks per row; the answer changes
 *  when an operator edits it, not within a batch. */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; limits: ChannelLimits }>();

export function resetChannelLimitsCache(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}

function toStored(row: Record<string, unknown> | null): Record<string, unknown> {
  if (!row) return {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(COLUMN) as LimitKey[]) {
    const v = row[COLUMN[key]];
    // NULL means unset. Dropping it lets resolveLimits fall through to env
    // rather than reading it as a value.
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

export async function getChannelLimits(tenantId: string): Promise<ChannelLimits> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.limits;

  let stored: Record<string, unknown> = {};
  try {
    const db = getServiceSupabase();
    const r = await db.from("drip_channel_limits").select(SELECT).eq("tenant_id", tenantId).maybeSingle();
    if (!r.error) stored = toStored(r.data as Record<string, unknown> | null);
  } catch {
    // Fall through to env. See the fail-open note in the file header.
  }

  const limits = resolveLimits(stored);
  cache.set(tenantId, { at: Date.now(), limits });
  return limits;
}

export type SaveResult =
  | { ok: true; limits: ChannelLimits }
  | { ok: false; problems: LimitProblem[] }
  | { ok: false; error: string };

/**
 * Apply an operator's change.
 *
 * Validated in the core first: a number field in a browser is not validation,
 * and a typo of 5000 would burn a domain before anyone noticed.
 *
 * A partial patch touches only the columns it names, so changing the SMS cap
 * cannot blank the email ones.
 */
export async function saveChannelLimits(
  tenantId: string,
  patch: Partial<Record<LimitKey, unknown>>,
): Promise<SaveResult> {
  const v = validateLimits(patch);
  if (!v.ok) return { ok: false, problems: v.problems };
  const keys = Object.keys(v.values) as LimitKey[];
  if (keys.length === 0) return { ok: false, error: "nothing to change" };

  const db = getServiceSupabase();
  const row: Record<string, unknown> = { tenant_id: tenantId, updated_at: new Date().toISOString() };
  for (const k of keys) row[COLUMN[k]] = v.values[k];

  const w = await db.from("drip_channel_limits").upsert(row, { onConflict: "tenant_id" });
  // The adapter RETURNS errors rather than throwing. Reporting success on a
  // failed write is how an operator "changes" a cap that never moved.
  if (w.error) return { ok: false, error: `could not save: ${w.error.message}` };

  resetChannelLimitsCache(tenantId);

  // Read back and return what the DATABASE holds, not what we sent. If a value
  // was clamped or a column did not take, the caller must show the real number
  // rather than leaving the screen disagreeing with the engine.
  const back = await db.from("drip_channel_limits").select(SELECT).eq("tenant_id", tenantId).maybeSingle();
  if (back.error) return { ok: false, error: `saved but could not confirm: ${back.error.message}` };

  const limits = resolveLimits(toStored(back.data as Record<string, unknown> | null));
  cache.set(tenantId, { at: Date.now(), limits });
  return { ok: true, limits };
}
