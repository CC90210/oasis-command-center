/**
 * lib/forms/public-booking-cap.ts - how many calls one visitor may book a day.
 *
 * Since #667 the AI audit, COMMAND and FLEET calendars open right after the
 * contact step, so taking a real Google slot (an invite to CC) costs one step
 * instead of four. The booking POST's rate limit is in memory, per Worker
 * isolate: it slows a burst and never caps a day. This is the durable cap,
 * agreed with e9 on 2026-10-16 (migrations bravo__228 and bravo__229).
 *
 * A place belongs to a booking REQUEST (the id the booking saga already keys
 * on), so a retry of the same booking holds the same place instead of taking
 * another. The place counts the attempts holding it: every attempt adds one
 * when it claims, and only an attempt that booked nothing takes one off. The
 * place is freed when the count reaches zero, so no attempt can free a place
 * another still holds, and a booking that succeeds keeps its count for good
 * (Codex review of #670). Each change is one statement, never a read and then
 * a write.
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
   * `uncapped`: the claims table (or its attempts column) is missing, a deploy
   * ahead of migration 228 or 229, so the booking goes ahead without a cap
   * rather than every booking failing.
   */
  | { ok: true; uncapped?: boolean; tenantId: string; requestId: string }
  | { ok: false; reason: "daily_cap_reached" };

function isMissingSchema(error: unknown): boolean {
  // An INSERT naming a missing column says "has no column named"; a read says "no such column".
  return /no such table|no such column|has no column named/i.test(error instanceof Error ? error.message : String(error));
}

let warnedMissingSchema = false;

/**
 * Hold one of today's places for this visitor and booking request, or refuse
 * when they are all taken. One statement does it:
 *
 * - a request with no place inserts one while the visitor holds fewer than
 *   the cap today;
 * - a request that holds today's place (a retry, even at the cap) adds its
 *   attempt to it;
 * - a request whose place is from an earlier day (a retry after the UTC day
 *   changed) moves it to today, under today's limit and today's visitor.
 *
 * The claims table missing (a deploy ahead of migration 228 or 229, a preview
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
  const held = { tenantId: input.tenantId, requestId: input.requestId };
  let taken;
  try {
    taken = await db.execute({
      sql: `INSERT INTO public_booking_claims (tenant_id, request_id, visitor_key, day, created_at, attempts)
            SELECT ?, ?, ?, ?, ?, 1
            WHERE (SELECT count(*) FROM public_booking_claims
                   WHERE tenant_id = ? AND visitor_key = ? AND day = ?) < ?
               OR EXISTS (SELECT 1 FROM public_booking_claims
                          WHERE tenant_id = ? AND request_id = ? AND day = ?)
            ON CONFLICT (tenant_id, request_id) DO UPDATE SET
              attempts = attempts + 1,
              visitor_key = CASE WHEN day = excluded.day THEN visitor_key ELSE excluded.visitor_key END,
              created_at = CASE WHEN day = excluded.day THEN created_at ELSE excluded.created_at END,
              day = excluded.day
            RETURNING request_id`,
      args: [
        input.tenantId, input.requestId, input.visitorKey, day, input.now.toISOString(),
        input.tenantId, input.visitorKey, day, cap,
        input.tenantId, input.requestId, day,
      ],
    });
  } catch (error) {
    if (!isMissingSchema(error)) throw error;
    if (!warnedMissingSchema) {
      warnedMissingSchema = true;
      console.error("[public-booking.cap] claims schema missing, booking UNCAPPED: apply database/turso/bravo__228_public_booking_daily_cap.sql and bravo__229_public_booking_claim_attempts.sql");
    }
    return { ok: true, uncapped: true, ...held };
  }
  if (taken.rows.length === 0) return { ok: false, reason: "daily_cap_reached" };
  // Best effort: a week-old place is never read again.
  const cutoff = publicBookingCapDay(new Date(input.now.getTime() - PRUNE_AFTER_DAYS * 86_400_000));
  await db
    .execute({ sql: "DELETE FROM public_booking_claims WHERE tenant_id = ? AND day < ?", args: [input.tenantId, cutoff] })
    .catch((error: unknown) => console.error("[public-booking.cap] prune failed", error instanceof Error ? error.message : error));
  return { ok: true, ...held };
}

/**
 * Take this attempt off the place it held, because it booked nothing; the
 * place is freed once no attempt holds it. Call it at most once per claim,
 * and never for an attempt that may have booked: that one's count stays, so
 * its place does. Each statement holds on its own in any interleaving with
 * another attempt's claim: the delete only takes a place nobody holds. A
 * release that fails is logged and leaves the place held, which only ever
 * errs strict.
 */
export async function releasePublicBooking(db: Client, claim: Extract<PublicBookingClaim, { ok: true }>): Promise<void> {
  if (claim.uncapped) return;
  try {
    await db.execute({
      sql: "UPDATE public_booking_claims SET attempts = attempts - 1 WHERE tenant_id = ? AND request_id = ? AND attempts > 0",
      args: [claim.tenantId, claim.requestId],
    });
    await db.execute({
      sql: "DELETE FROM public_booking_claims WHERE tenant_id = ? AND request_id = ? AND attempts <= 0",
      args: [claim.tenantId, claim.requestId],
    });
  } catch (error) {
    console.error("[public-booking.cap] release failed", error instanceof Error ? error.message : error);
  }
}
