/**
 * lib/slack/verify.ts - is this request really from Slack?
 *
 * Slack signs every Events API and interactivity request: the header
 * x-slack-signature is "v0=" + hex(HMAC-SHA256(signing secret,
 * "v0:" + x-slack-request-timestamp + ":" + the raw body)). A request is
 * accepted only when that matches (constant-time compare) AND its timestamp is
 * within five minutes of now, so a captured request cannot be replayed later.
 *
 * The signing secret is SLACK_SIGNING_SECRET and nothing else: a missing secret
 * is a refusal ("not_configured"), never a fallback to another key.
 *
 * Verification runs over the RAW body, before it is parsed: a body parsed and
 * re-serialized is not the body Slack signed.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export const SLACK_SIGNING_SECRET_ENV = "SLACK_SIGNING_SECRET";
/** Slack's own replay window: five minutes either side of now. */
export const SLACK_SIGNATURE_MAX_AGE_SEC = 5 * 60;

export type SlackVerifyResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "missing_headers" | "stale_timestamp" | "bad_signature" };

type Env = Readonly<Record<string, string | undefined>>;

export function slackSigningSecret(env: Env = process.env): string | null {
  const s = (env[SLACK_SIGNING_SECRET_ENV] || "").trim();
  return s ? s : null;
}

/** The v0 signature Slack would send for this body at this timestamp. */
export function slackSignature(secret: string, timestamp: string, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
}

export function verifySlackRequest(input: {
  rawBody: string;
  timestamp: string | null;
  signature: string | null;
  nowMs: number;
  env?: Env;
}): SlackVerifyResult {
  const secret = slackSigningSecret(input.env);
  if (!secret) return { ok: false, reason: "not_configured" };
  const ts = (input.timestamp || "").trim();
  const sig = (input.signature || "").trim();
  if (!ts || !sig) return { ok: false, reason: "missing_headers" };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, reason: "stale_timestamp" };
  const ageSec = Math.abs(Math.floor(input.nowMs / 1000) - Number(ts));
  if (ageSec > SLACK_SIGNATURE_MAX_AGE_SEC) return { ok: false, reason: "stale_timestamp" };
  const expected = Buffer.from(slackSignature(secret, ts, input.rawBody));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

/** Read the two signing headers off a request. */
export function slackSigningHeaders(headers: Headers): { timestamp: string | null; signature: string | null } {
  return { timestamp: headers.get("x-slack-request-timestamp"), signature: headers.get("x-slack-signature") };
}
