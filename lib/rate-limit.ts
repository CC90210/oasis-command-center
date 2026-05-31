/**
 * In-memory token-bucket rate limiter.
 *
 * Originally a per-tenant ceiling on /api/chat to keep a runaway script
 * from burning through the platform key in the operator-fallback path.
 * Also used by the bridge-token endpoints (/api/bridge/ping, /api/bridge/
 * records, /api/cron-jobs/poll) to backstop brute-force attempts BEFORE
 * the SHA-256 token comparison runs.
 *
 * Buckets live in the serverless-function instance memory. Vercel reuses
 * warm instances for ~minutes, so per-instance accuracy is "good enough"
 * for the bridge brute-force surface — a token guesser racing across 10
 * Vercel instances effectively gets 10x the documented rate, but legit
 * bridges are pinned to one instance per warm window so they see the
 * documented limits.
 *
 * If/when cross-instance accuracy matters (multiple bridges per tenant,
 * larger Vercel concurrency, dashboard view of who's hitting limits),
 * replace this with @upstash/ratelimit + @upstash/redis. Adds one
 * dependency and a Redis-cost line item; no API surface change beyond
 * the function signature.
 */

type Bucket = {
  tokens: number;
  refilledAt: number;
};

const buckets = new Map<string, Bucket>();

export type RateLimitDecision =
  | { allowed: true; remaining: number; resetIn: number }
  | { allowed: false; remaining: 0; resetIn: number };

export function rateLimit(opts: {
  key: string;
  capacity: number;     // max tokens in the bucket
  refillPerSec: number; // tokens added per second
  cost?: number;        // tokens consumed by THIS call (default 1)
}): RateLimitDecision {
  const cost = opts.cost ?? 1;
  const now = Date.now();
  const existing = buckets.get(opts.key);
  let tokens: number;
  if (!existing) {
    tokens = opts.capacity;
  } else {
    const elapsedSec = (now - existing.refilledAt) / 1000;
    tokens = Math.min(opts.capacity, existing.tokens + elapsedSec * opts.refillPerSec);
  }
  if (tokens >= cost) {
    tokens -= cost;
    buckets.set(opts.key, { tokens, refilledAt: now });
    return {
      allowed: true,
      remaining: Math.floor(tokens),
      resetIn: Math.ceil((opts.capacity - tokens) / opts.refillPerSec),
    };
  }
  buckets.set(opts.key, { tokens, refilledAt: now });
  return {
    allowed: false,
    remaining: 0,
    resetIn: Math.ceil((cost - tokens) / opts.refillPerSec),
  };
}
