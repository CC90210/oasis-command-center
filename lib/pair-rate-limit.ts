/**
 * Shared rate-limit + audit-log primitives for the pair-related API routes.
 *
 * Backed by public.pair_attempts (migrations 031 + 034). One table holds the
 * attempts of /api/auth/pair (keyed on OASIS_PROFILE_ID) and of
 * /api/auth/pair-code/redeem (keyed on `redeem:<address bucket>`, see
 * ipRateBucket), and the places claimCappedSlot hands out
 * (`redeem-attempts:<bucket>` for redemptions, `unsubscribe-unsigned:<bucket>`
 * for unsigned opt-outs). The `profile_id` column accepts every shape — see
 * migration 034's table comment for the rationale. /api/unsubscribe no longer
 * counts failures here: it only claims places (review of #715).
 *
 * Why a shared module: both routes have the same threat surface (bearer
 * credential brute-force) and should enforce the same defense uniformly.
 * Inline-duplicating the helpers in each route guarantees they drift —
 * one place is the right shape.
 *
 * USAGE
 *   import { isRateLimited, recordPairAttempt, clientIp } from "@/lib/pair-rate-limit";
 *
 *   // At the top of POST handler:
 *   const ip = clientIp(req);
 *   if (await isRateLimited(rateKey)) {
 *     await recordPairAttempt(rateKey, "rate_limited", ip);
 *     return bad(429, "rate_limited");
 *   }
 *
 *   // After auth check:
 *   if (failed) {
 *     await recordPairAttempt(rateKey, "invalid_hmac", ip);
 *     return bad(401, ...);
 *   }
 *
 *   // After success:
 *   await recordPairAttempt(rateKey, "ok", ip);
 */

import type { NextRequest } from "next/server";
import { getServiceSupabase } from "./supabase-server";
import { getClientIp } from "./api-helpers";
import { keepAlive } from "./os/runs/keepalive";

export const PAIR_RATE_WINDOW_SECONDS = 60;
export const PAIR_RATE_MAX_FAILURES = 10;

export type PairOutcome =
  // /api/auth/pair outcomes (migration 031)
  | "ok"
  | "invalid_hmac"
  | "invalid_bearer"
  | "rate_limited"
  | "missing_headers"
  // /api/auth/pair-code/redeem outcomes (migration 034)
  | "code_invalid_shape"
  | "code_not_found"
  | "code_expired"
  | "code_consumed"
  | "code_redeem_failed";

/** Outcomes that count as failures and accumulate toward the rate limit. */
const FAILURE_OUTCOMES: PairOutcome[] = [
  "invalid_hmac",
  "invalid_bearer",
  "missing_headers",
  "code_invalid_shape",
  "code_not_found",
  "code_expired",
  "code_consumed",
  "code_redeem_failed",
];

/**
 * Resolve the originating client IP from common Vercel/proxy headers.
 * Returns null if no header is set (local dev / direct hit).
 */
export function clientIp(req: NextRequest): string | null {
  const ip = getClientIp(req);
  return ip === "unknown" ? null : ip;
}

/**
 * Probabilistic GC: on ~1% of writes, prune rows older than 24h. No cron
 * required, table stays bounded over time, write amplification is
 * negligible (1 extra DELETE per 100 INSERTs). Self-sufficient — the
 * table maintains itself. Gating value chosen so a low-traffic deployment
 * still GCs eventually (one event per ~100 attempts; at 10 attempts/day
 * = ~10 days between sweeps, plenty for a 24h retention window).
 *
 * The DELETE is handed to the platform (keepAlive, lib/os/runs/keepalive.ts).
 * On Cloudflare Workers a promise nobody awaits is cancelled when the response
 * goes out, unless it was given to ctx.waitUntil, so the bare `void prune()`
 * this used to be never finished: 2,018 of the table's 3,429 rows were over a
 * day old (review of #715). Callers await _maybeRunGc, which returns once the
 * prune is registered with the platform, not once it is done.
 */
const GC_PROBABILITY = 0.01;
const GC_RETENTION_HOURS = 24;

/** The client reports a failed statement in `error` and does not reject, so it
 *  is thrown here for keepAlive to log; a prune that never works must be seen. */
async function pruneOldAttempts(db: ReturnType<typeof getServiceSupabase>): Promise<void> {
  const cutoff = new Date(
    Date.now() - GC_RETENTION_HOURS * 3600 * 1000,
  ).toISOString();
  const r = await db.from("pair_attempts").delete().lt("attempted_at", cutoff);
  if (r.error) throw new Error(`could not prune pair_attempts: ${r.error.message}`);
}

async function _maybeRunGc(db: ReturnType<typeof getServiceSupabase>): Promise<void> {
  if (Math.random() >= GC_PROBABILITY) return;
  await keepAlive(pruneOldAttempts(db), "pair-rate-limit.prune");
}

/**
 * Insert one row into public.pair_attempts. Best-effort: never throws,
 * never breaks the request flow even if the insert fails. Logging is
 * defense in depth, not gating logic.
 *
 * Side effect: ~1% of calls also prune rows older than 24h via
 * _maybeRunGc, so the table stays bounded without external cron.
 */
export async function recordPairAttempt(
  rateKey: string,
  outcome: PairOutcome,
  ip: string | null,
): Promise<void> {
  try {
    const db = getServiceSupabase();
    await db.from("pair_attempts").insert({
      profile_id: rateKey,  // column name is historical; holds any rate-limit key
      outcome,
      ip,
    });
    // The occasional prune finishes after the response, on the platform's
    // waitUntil, so a slow DELETE does not delay it (review of #715).
    await _maybeRunGc(db);
  } catch {
    // intentional swallow — see docstring
  }
}

/**
 * True if `rateKey` has accumulated >= PAIR_RATE_MAX_FAILURES in the
 * last PAIR_RATE_WINDOW_SECONDS, counting only failure outcomes.
 * Successful pairs don't push toward the limit, so a legitimate operator
 * who pairs successfully and then re-pairs immediately doesn't get
 * locked out by their own activity.
 *
 * Fails OPEN (returns false) on DB errors — preferring availability of
 * legitimate auth over a hard lockout from a transient DB issue.
 */
export async function isRateLimited(rateKey: string): Promise<boolean> {
  if (!rateKey) return false;
  try {
    const db = getServiceSupabase();
    const since = new Date(
      Date.now() - PAIR_RATE_WINDOW_SECONDS * 1000,
    ).toISOString();
    const r = await db
      .from("pair_attempts")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", rateKey)
      .in("outcome", FAILURE_OUTCOMES)
      .gte("attempted_at", since);
    if (r.error) return false;
    return (r.count ?? 0) >= PAIR_RATE_MAX_FAILURES;
  } catch {
    return false;
  }
}

/**
 * The bucket an address is rate-limited in. An IPv4 address is its own
 * bucket. An IPv6 address is bucketed by its /64, the block one subscriber is
 * given: every production address is IPv6, and keyed per address a client
 * could rotate through its /64 past any cap (reviewer of OCC #711: 150
 * filings from 150 addresses in one /64, all accepted). An IPv4-mapped IPv6
 * address is its IPv4 address, in either spelling. A dotted-quad tail
 * ("2001:db8:77:1::192.0.2.1") is read as the two hex groups it stands for:
 * read raw, each such spelling was a bucket of its own (CodeRabbit on #715).
 * Anything unparseable is its own bucket.
 */
export function ipRateBucket(ip: string | null | undefined): string {
  const raw = (ip || "").trim().toLowerCase().split("%")[0];
  if (!raw) return "unknown";
  if (!raw.includes(":")) return raw;
  let addr = raw;
  const quad = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
  if (quad) {
    const [a, b, c, d] = quad.slice(2).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return raw;
    addr = `${quad[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = addr.split("::");
  if (halves.length > 2) return raw;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 && fill < 1) return raw;
  const groups = halves.length === 2 ? [...head, ...Array(fill).fill("0"), ...tail] : head;
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return raw;
  const n = groups.map((g) => parseInt(g, 16));
  if (n.slice(0, 5).every((v) => v === 0) && n[5] === 0xffff) {
    return `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  }
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** A place in a capped allowance (claimCappedSlot). */
export type CappedSlot = {
  /** True when this attempt is among the first `cap` in the window. */
  allowed: boolean;
  /**
   * Give the place back, for an attempt that turned out not to be what the cap
   * guards against. Never throws: a release that fails is logged, and the place
   * stays counted until the window passes.
   */
  release: () => Promise<void>;
};

/** What a place that was never recorded gives back: nothing. */
const noRelease = async (): Promise<void> => undefined;

/**
 * Take one place in a capped allowance: `allowed` is true when this attempt is
 * among the first `cap` that `rateKey` made in the last `windowSeconds`.
 * isRateLimited counts failures only, which suits a credential; this caps a
 * write that succeeds, such as an unsigned opt-out that stops every sender
 * (/api/unsubscribe), or an attempt at a pair code, where a guess and a pairing
 * look alike until the code is checked.
 *
 * The attempt is RECORDED FIRST, then only the attempts recorded before it are
 * counted (pair_attempts.id only grows), so each attempt gets its own place in
 * line. Counting first and recording after let a parallel burst all read
 * "under the cap" before any of them was written (reviewer of OCC #711: 300
 * parallel filings, 300 accepted). Fails OPEN like isRateLimited, but logs it:
 * a limiter that cannot count must be visible, not silent.
 *
 * `release` gives the place back once the attempt proves to be a real one. The
 * pair-code route calls it when a code paired a computer: the cap is on guesses,
 * and counted for good, a team setting up an eleventh computer in a minute
 * behind one address was refused (review of #715). An attempt that is not
 * released keeps its place, so a flood of guesses still fills the window.
 */
export async function claimCappedSlot(
  rateKey: string,
  ip: string | null,
  windowSeconds: number,
  cap: number,
): Promise<CappedSlot> {
  if (!rateKey) return { allowed: true, release: noRelease };
  let release = noRelease;
  try {
    const db = getServiceSupabase();
    const mine = await db
      .from("pair_attempts")
      .insert({ profile_id: rateKey, outcome: "ok", ip })
      .select("id")
      .single();
    if (mine.error || !mine.data) {
      console.error("[pair-rate-limit] could not record an attempt; allowing it", { rateKey, error: mine.error?.message });
      return { allowed: true, release };
    }
    const myId = Number((mine.data as { id: unknown }).id);
    release = async () => {
      try {
        const gone = await db.from("pair_attempts").delete().eq("id", myId);
        if (gone.error) throw new Error(gone.error.message);
      } catch (err) {
        console.error("[pair-rate-limit] could not give a place back; it stays counted until the window passes", { rateKey, error: err instanceof Error ? err.message : String(err) });
      }
    };
    // The same occasional prune recordPairAttempt runs: a caller that only
    // claims slots (the opt-out route) would otherwise grow the table forever.
    await _maybeRunGc(db);
    const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const r = await db
      .from("pair_attempts")
      .select("id", { count: "exact", head: true })
      .eq("profile_id", rateKey)
      .gte("attempted_at", since)
      .lte("id", myId);
    if (r.error) {
      console.error("[pair-rate-limit] could not count attempts; allowing this one", { rateKey, error: r.error.message });
      return { allowed: true, release };
    }
    return { allowed: (r.count ?? 0) <= cap, release };
  } catch (err) {
    console.error("[pair-rate-limit] limiter failed; allowing this attempt", { rateKey, error: err instanceof Error ? err.message : String(err) });
    return { allowed: true, release };
  }
}
