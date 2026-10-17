/**
 * lib/forms/public-booking-cap.ts - how many calls one visitor may book a day.
 *
 * Since #667 the AI audit, COMMAND and FLEET calendars open right after the
 * contact step, so taking a real Google slot (an invite to CC) costs one step
 * instead of four. The booking POST's rate limit is in memory, per Worker
 * isolate: it slows a burst and never caps a day. This is the durable cap,
 * agreed with e9 on 2026-10-16 (migration bravo__228).
 *
 * A booking CLAIMS a place before anything reaches Google, with one atomic
 * statement, so two racing requests can never both take the last place (a
 * count-then-book check could). A booking that then fails gives its place
 * back, so a taken slot or a provider hiccup never uses up the allowance.
 */
import "server-only";
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";

/** Calls one visitor (one address) may hold per UTC day, per workspace. */
export const PUBLIC_BOOKING_DAILY_CAP = 3;

const PRUNE_AFTER_DAYS = 7;

/**
 * A request's address as the cap keys it: hashed, never stored as typed. A
 * request with no address ("unknown") is one shared key, so it can never
 * slip past the cap.
 */
export function publicBookingVisitorKey(ip: string | null | undefined): string {
  const address = (ip ?? "").trim() || "unknown";
  return createHash("sha256").update(`public-booking:${address}`).digest("hex").slice(0, 32);
}

/** The UTC day a claim counts against: "2026-10-16". */
export function publicBookingCapDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export type PublicBookingClaim =
  | { ok: true; tenantId: string; visitorKey: string; day: string; count: number }
  | { ok: false; reason: "daily_cap_reached" };

/**
 * Take one of today's places for this visitor, or refuse when they are all
 * taken. One statement: insert the first place, or add one while under the
 * cap; RETURNING says whether it happened. Throws when the database cannot
 * answer: the caller refuses the booking rather than book uncapped.
 */
export async function claimPublicBooking(
  db: Client,
  input: { tenantId: string; visitorKey: string; now: Date; cap?: number },
): Promise<PublicBookingClaim> {
  const cap = input.cap ?? PUBLIC_BOOKING_DAILY_CAP;
  const day = publicBookingCapDay(input.now);
  const at = input.now.toISOString();
  const rs = await db.execute({
    sql: `INSERT INTO public_booking_daily_claims (tenant_id, visitor_key, day, count, updated_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (tenant_id, visitor_key, day)
          DO UPDATE SET count = public_booking_daily_claims.count + 1, updated_at = excluded.updated_at
          WHERE public_booking_daily_claims.count < ?
          RETURNING count`,
    args: [input.tenantId, input.visitorKey, day, at, cap],
  });
  const row = rs.rows[0];
  if (!row) return { ok: false, reason: "daily_cap_reached" };
  // Best effort: a week-old place is never read again.
  const cutoff = publicBookingCapDay(new Date(input.now.getTime() - PRUNE_AFTER_DAYS * 86_400_000));
  await db
    .execute({ sql: "DELETE FROM public_booking_daily_claims WHERE tenant_id = ? AND day < ?", args: [input.tenantId, cutoff] })
    .catch((error: unknown) => console.error("[public-booking.cap] prune failed", error instanceof Error ? error.message : error));
  return { ok: true, tenantId: input.tenantId, visitorKey: input.visitorKey, day, count: Number(row.count) };
}

/**
 * Give back a place a booking claimed and then did not use (the slot was
 * taken, Google failed, the lead could not move). Never below zero, and on
 * the claim's own day, even when the failure lands after midnight. A release
 * that fails is logged and leaves the place used, which only ever errs strict.
 */
export async function releasePublicBooking(db: Client, claim: Extract<PublicBookingClaim, { ok: true }>, now: Date): Promise<void> {
  try {
    await db.execute({
      sql: `UPDATE public_booking_daily_claims SET count = count - 1, updated_at = ?
            WHERE tenant_id = ? AND visitor_key = ? AND day = ? AND count > 0`,
      args: [now.toISOString(), claim.tenantId, claim.visitorKey, claim.day],
    });
  } catch (error) {
    console.error("[public-booking.cap] release failed", error instanceof Error ? error.message : error);
  }
}
