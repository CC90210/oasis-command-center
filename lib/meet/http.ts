/**
 * lib/meet/http.ts - request plumbing shared by Oasis Meet's room routes (app/api/meet/[code]/*):
 * answers that never cache, the per-address and per-room rate limits, what a room looks like to
 * the people in it, and one place that turns a failure into an answer.
 *
 * The rate limits are lib/rate-limit.ts buckets (per Worker isolate, in memory): they slow a script
 * guessing links or hammering a room. The real ceiling is the participant cap, which is one SQL
 * statement (lib/meet/participants.ts).
 */
import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { getClientIp } from "@/lib/api-helpers";
import { rateLimit } from "@/lib/rate-limit";
import { MeetNotConfiguredError } from "./access";
import { meetError, meetJson } from "./answers";
import { displayMeetCode, type MeetRoom } from "./rooms";
import { SfuError } from "./sfu";

type Limit = { capacity: number; refillPerSec: number };

/**
 * Per address, then per room. join is what a guessed link would call; state is polled every 2 s by each
 * of up to 8 people, who may all sit behind one office address (8 x 0.5/s, with headroom); sfu is a handful of
 * negotiations per person; action is a host's remove, end or delete.
 */
const LIMITS: Record<"join" | "state" | "sfu" | "leave" | "action", { ip: Limit; room: Limit }> = {
  join: { ip: { capacity: 10, refillPerSec: 10 / 60 }, room: { capacity: 30, refillPerSec: 30 / 60 } },
  state: { ip: { capacity: 180, refillPerSec: 6 }, room: { capacity: 600, refillPerSec: 8 } },
  sfu: { ip: { capacity: 60, refillPerSec: 1 }, room: { capacity: 400, refillPerSec: 6 } },
  leave: { ip: { capacity: 20, refillPerSec: 20 / 60 }, room: { capacity: 60, refillPerSec: 1 } },
  action: { ip: { capacity: 30, refillPerSec: 30 / 60 }, room: { capacity: 60, refillPerSec: 1 } },
};

/** A 429 when this address or this room is over its limit for this kind of call, else null. */
export function meetRateLimited(req: NextRequest, code: string, kind: keyof typeof LIMITS): NextResponse | null {
  const limit = LIMITS[kind];
  const refused = (resetIn: number) =>
    NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429, headers: { "retry-after": String(Math.max(resetIn, 1)), "cache-control": "no-store" } });
  const byAddress = rateLimit({ key: `meet:${kind}:ip:${getClientIp(req) || "unknown"}`, ...limit.ip });
  // An address over its limit is refused before a bucket is made for the room it named: the limiter keeps every
  // bucket it makes, so a script guessing links must not grow it by one per guess (lib/rate-limit.ts).
  if (!byAddress.allowed) return refused(byAddress.resetIn);
  const byRoom = rateLimit({ key: `meet:${kind}:room:${code}`, ...limit.room });
  return byRoom.allowed ? null : refused(byRoom.resetIn);
}

/** What the people in a room see of it. Never its workspace, host id, lead or calendar links. */
export function roomView(room: MeetRoom) {
  return {
    code: displayMeetCode(room.code),
    title: room.title,
    status: room.status,
    recordAudio: room.recordAudio,
    startsAt: room.startsAt,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
  };
}

/** One answer per failure kind: not set up 503, the SFU refused 502, anything else 500. Storage text never leaves the server. */
export function meetFailure(err: unknown, where: string): NextResponse {
  if (err instanceof MeetNotConfiguredError) {
    console.error(`[meet.${where}] not configured: ${err.message}`);
    return meetError(503, "meet_not_configured");
  }
  if (err instanceof SfuError) {
    console.error(`[meet.${where}] SFU ${err.code}: ${err.message}`);
    return meetJson({ ok: false, error: "sfu_failed", code: err.code }, 502);
  }
  console.error(`[meet.${where}]`, err);
  return meetError(500, "meet_unavailable");
}
