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
 * count-then-book check could). A place belongs to a booking REQUEST (the id
 * the booking saga already keys on), so a retry of the same booking finds its
 * own place instead of taking another (Codex review of #670). Only the attempt
 * that took the place may give it back, and only when nothing was booked.
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
  /**
   * `fresh`: this attempt took the place (a retry of the same request did not).
   * `uncapped`: the claims table is missing (migration 228 not applied here), so
   * the booking goes ahead without a cap rather than every booking failing.
   */
  | { ok: true; fresh: boolean; uncapped?: boolean; tenantId: string; requestId: string; visitorKey: string; day: string }
  | { ok: false; reason: "daily_cap_reached" };

function isMissingTable(error: unknown): boolean {
  return /no such table/i.test(error instanceof Error ? error.message : String(error));
}

let warnedMissingTable = false;

/**
 * Take one of today's places for this visitor and booking request, or refuse
 * when they are all taken. One statement inserts the request's place only
 * while the visitor holds fewer than the cap; a request that already holds a
 * place (a retry) is allowed without taking another.
 *
 * The claims table missing (a deploy ahead of migration 228, a preview
 * database) books uncapped and says so loudly, the way the booking settings
 * store treats its own missing table: a cap must never take booking down
 * (Codex review of #670). Any other failure throws, and the caller refuses
 * the booking rather than book uncapped.
 */
export async function claimPublicBooking(
  db: Client,
  input: { tenantId: string; visitorKey: string; requestId: string; now: Date; cap?: number },
): Promise<PublicBookingClaim> {
  const cap = input.cap ?? PUBLIC_BOOKING_DAILY_CAP;
  const day = publicBookingCapDay(input.now);
  const held = { tenantId: input.tenantId, requestId: input.requestId, visitorKey: input.visitorKey, day };
  let taken;
  try {
    taken = await db.execute({
      sql: `INSERT INTO public_booking_claims (tenant_id, request_id, visitor_key, day, created_at)
            SELECT ?, ?, ?, ?, ?
            WHERE (SELECT count(*) FROM public_booking_claims
                   WHERE tenant_id = ? AND visitor_key = ? AND day = ?) < ?
            ON CONFLICT (tenant_id, request_id) DO NOTHING
            RETURNING request_id`,
      args: [
        input.tenantId, input.requestId, input.visitorKey, day, input.now.toISOString(),
        input.tenantId, input.visitorKey, day, cap,
      ],
    });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    if (!warnedMissingTable) {
      warnedMissingTable = true;
      console.error("[public-booking.cap] table missing, booking UNCAPPED: apply database/turso/bravo__228_public_booking_daily_cap.sql");
    }
    return { ok: true, fresh: false, uncapped: true, ...held };
  }
  if (taken.rows.length > 0) {
    // Best effort: a week-old place is never read again.
    const cutoff = publicBookingCapDay(new Date(input.now.getTime() - PRUNE_AFTER_DAYS * 86_400_000));
    await db
      .execute({ sql: "DELETE FROM public_booking_claims WHERE tenant_id = ? AND day < ?", args: [input.tenantId, cutoff] })
      .catch((error: unknown) => console.error("[public-booking.cap] prune failed", error instanceof Error ? error.message : error));
    return { ok: true, fresh: true, ...held };
  }
  // Nothing inserted: either this request already holds a place (a retry, so
  // allowed and counted once), or the visitor's places are all taken.
  const own = await db.execute({
    sql: "SELECT 1 FROM public_booking_claims WHERE tenant_id = ? AND request_id = ? LIMIT 1",
    args: [input.tenantId, input.requestId],
  });
  if (own.rows.length > 0) return { ok: true, fresh: false, ...held };
  return { ok: false, reason: "daily_cap_reached" };
}

/**
 * A booking that completed holds its place, whatever happened to the claim
 * meanwhile. Two attempts of one request can run at once: if the attempt that
 * took the place fails before Google and gives it back while the other goes
 * on to book, that booking would hold no place and the visitor would get one
 * more call than the cap (Codex review of #670). So every completed booking
 * re-asserts its request's place, without the cap check (it was admitted
 * when it claimed). Best effort: a failure here is logged.
 */
export async function confirmPublicBooking(db: Client, claim: Extract<PublicBookingClaim, { ok: true }>, now: Date): Promise<void> {
  if (claim.uncapped) return;
  try {
    await db.execute({
      sql: `INSERT INTO public_booking_claims (tenant_id, request_id, visitor_key, day, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, request_id) DO NOTHING`,
      args: [claim.tenantId, claim.requestId, claim.visitorKey, claim.day, now.toISOString()],
    });
  } catch (error) {
    console.error("[public-booking.cap] confirm failed", error instanceof Error ? error.message : error);
  }
}

/**
 * Give back the place a booking took and then did not use. Only the attempt
 * that took it (`fresh`) may: a retry's failure must never free the place of
 * an attempt that may still be booking (and one that completes re-asserts it,
 * confirmPublicBooking). A release that fails is logged and leaves the place
 * used, which only ever errs strict.
 */
export async function releasePublicBooking(db: Client, claim: Extract<PublicBookingClaim, { ok: true }>): Promise<void> {
  if (!claim.fresh || claim.uncapped) return;
  try {
    await db.execute({
      sql: "DELETE FROM public_booking_claims WHERE tenant_id = ? AND request_id = ?",
      args: [claim.tenantId, claim.requestId],
    });
  } catch (error) {
    console.error("[public-booking.cap] release failed", error instanceof Error ? error.message : error);
  }
}
