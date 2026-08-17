/**
 * lib/drips/channel-limits-core.ts — the send ceilings, as data an operator can
 * change, rather than env vars only I can change.
 *
 * Adon, 2026-08-17: "make sure your results are posted on the drips tab for
 * texts and emails so I can keep track of everything, and then those tabs are
 * actually functional where if I want to increase or decrease the volume, I
 * will be able to use the rest of the software."
 *
 * WHAT WAS WRONG. Every ceiling this engine enforces lived in an env var:
 * DRIPS_SMS_DAILY_CAP, DRIPS_EMAIL_DAILY_CAP_BLUERISE, and friends. Changing
 * one meant a Vercel write and a redeploy — so "increase the volume today"
 * was a request to me rather than a control in the product. The per-SEQUENCE
 * email cap was already editable in the UI; the per-CHANNEL ones were not, and
 * they are the ones that actually gate the day.
 *
 * PRECEDENCE, deliberately: stored value → env → built-in default. Env stays
 * meaningful as the deploy-time floor and as the emergency lever when the UI or
 * the database is the thing that is broken; the stored value is what an
 * operator moves day to day.
 *
 * CEILINGS ARE ENFORCED HERE, not in the form. A typo of 5000 in a number field
 * would burn a domain before anyone noticed, and validation that lives only in
 * the browser is not validation. Bluerise carries a lower ceiling than SunBiz
 * because it is four days into its sending life with no reputation buffer.
 *
 * Pure and free of "server-only" so the numbers that decide how much mail
 * leaves the building are directly testable.
 */

export type ChannelLimits = {
  smsDaily: number;
  smsHourly: number;
  emailDailySunbiz: number;
  emailDailyBluerise: number;
};

export type LimitKey = keyof ChannelLimits;

/**
 * Hard ceilings. An operator can go up to these from the UI and no further.
 *
 * These are not opinions about what is optimal, they are the point past which a
 * mistake stops being recoverable. A warmed domain absorbs a bad day; a cold
 * one does not, and a burned number cannot be un-burned.
 */
export const LIMIT_MAX: Record<LimitKey, number> = {
  smsDaily: 500,
  smsHourly: 60,
  // SunBiz is the established domain with months of history.
  emailDailySunbiz: 500,
  // Bluerise started sending 2026-08-14. Deliberately a fifth of SunBiz until
  // it has a reputation to spend.
  emailDailyBluerise: 100,
};

/** Built-in defaults, matching what the env vars were set to. */
export const LIMIT_DEFAULT: ChannelLimits = {
  smsDaily: 40,
  smsHourly: 6,
  emailDailySunbiz: 150,
  emailDailyBluerise: 50,
};

/** Which env var backs each limit, for the middle tier of the precedence. */
const LIMIT_ENV: Record<LimitKey, string> = {
  smsDaily: "DRIPS_SMS_DAILY_CAP",
  smsHourly: "DRIPS_SMS_HOURLY_CAP",
  emailDailySunbiz: "DRIPS_EMAIL_DAILY_CAP_SUNBIZ",
  emailDailyBluerise: "DRIPS_EMAIL_DAILY_CAP_BLUERISE",
};

export const LIMIT_KEYS: LimitKey[] = [
  "smsDaily",
  "smsHourly",
  "emailDailySunbiz",
  "emailDailyBluerise",
];

export type LimitProblem = { key: LimitKey; reason: string };

/**
 * Validate one operator-supplied value.
 *
 * ZERO IS LEGAL and means stopped. That is a real thing an operator needs on a
 * bad morning, and treating it as "unset" — the classic falsy bug — would
 * silently resume sending at the default the moment they tried to stop.
 */
export function validateLimit(key: LimitKey, raw: unknown): { ok: true; value: number } | { ok: false; reason: string } {
  if (raw === null || raw === undefined) return { ok: false, reason: "enter a number" };
  // Trim BEFORE the empty check. Number("") and Number("   ") are both 0, and 0
  // is a legal value here meaning "stopped" — so a blank or whitespace-only
  // field would silently stop the channel and look deliberate. An empty box is
  // a missing answer, never an instruction.
  const text = typeof raw === "number" ? String(raw) : String(raw).trim();
  if (text === "") return { ok: false, reason: "enter a number" };
  const n = Number(text);
  if (!Number.isFinite(n)) return { ok: false, reason: "must be a number" };
  if (!Number.isInteger(n)) return { ok: false, reason: "must be a whole number" };
  if (n < 0) return { ok: false, reason: "cannot be negative" };
  if (n > LIMIT_MAX[key]) return { ok: false, reason: `cannot exceed ${LIMIT_MAX[key]}` };
  return { ok: true, value: n };
}

/** Validate a whole patch. Returns every problem, not just the first — a form
 *  that reports one error at a time makes an operator submit four times. */
export function validateLimits(patch: Partial<Record<LimitKey, unknown>>): {
  ok: boolean;
  values: Partial<ChannelLimits>;
  problems: LimitProblem[];
} {
  const values: Partial<ChannelLimits> = {};
  const problems: LimitProblem[] = [];
  for (const key of LIMIT_KEYS) {
    if (!(key in patch)) continue;
    const v = validateLimit(key, patch[key]);
    if (v.ok) values[key] = v.value;
    else problems.push({ key, reason: v.reason });
  }
  return { ok: problems.length === 0, values, problems };
}

function fromEnv(env: Record<string, string | undefined>, key: LimitKey): number | null {
  const raw = (env[LIMIT_ENV[key]] ?? "").trim();
  if (!raw) return null;
  const n = Number(raw);
  // A malformed env var falls through to the default rather than becoming NaN,
  // which would compare false against every count and uncap the channel.
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * Resolve the effective limits: stored → env → default, clamped to the ceiling.
 *
 * A stored value ABOVE the ceiling is clamped rather than rejected. Ceilings can
 * be lowered in a later deploy, and a value that was legal when it was saved
 * must not take the channel down or resolve to a default that is higher than
 * what the operator last chose.
 */
export function resolveLimits(
  stored: unknown,
  env: Record<string, string | undefined> = process.env,
): ChannelLimits {
  const s = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const out = {} as ChannelLimits;
  for (const key of LIMIT_KEYS) {
    const raw = s[key];
    const v = validateLimit(key, raw);
    const picked = v.ok
      ? v.value
      : // A stored value that is merely OVER the ceiling still expresses intent;
        // clamp it. Anything else unusable falls to env, then to the default.
        typeof raw === "number" && Number.isInteger(raw) && raw > LIMIT_MAX[key]
        ? LIMIT_MAX[key]
        : fromEnv(env, key) ?? LIMIT_DEFAULT[key];
    out[key] = Math.min(picked, LIMIT_MAX[key]);
  }
  return out;
}

/** Human labels for the UI, kept beside the rules so the two cannot drift. */
export const LIMIT_LABEL: Record<LimitKey, string> = {
  smsDaily: "Texts per day",
  smsHourly: "Texts per hour",
  emailDailySunbiz: "SunBiz emails per day",
  emailDailyBluerise: "Bluerise emails per day",
};
