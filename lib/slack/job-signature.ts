/**
 * lib/slack/job-signature.ts - how the queue consumer (worker-entry.ts) proves
 * to /api/webhooks/slack/jobs that a job came from OASIS's own queue.
 *
 * HMAC-SHA256 with the Slack signing secret, over a DIFFERENT message than
 * Slack's ("oasis-slack-job.v1:" + ts + ":" + body, where Slack signs
 * "v0:ts:body"), so no Slack request can ever pass as a job and no job can pass
 * as a Slack request. Web Crypto only: the same code runs in the Worker entry
 * (outside Next) and in the route.
 *
 * A queue message can wait or be retried for hours, so the window is a day.
 * Replaying a job is harmless anyway: one approval per Slack event
 * (lib/slack/jobs.ts), whatever runs it.
 */
export const JOB_SIGNATURE_HEADER = "x-oasis-slack-job-signature";
export const JOB_TIMESTAMP_HEADER = "x-oasis-slack-job-timestamp";
export const JOB_SIGNATURE_MAX_AGE_SEC = 24 * 60 * 60;

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signSlackJob(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`oasis-slack-job.v1:${timestamp}:${body}`));
  return `j1=${hex(mac)}`;
}

/** Constant-time for equal lengths. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifySlackJob(input: {
  secret: string | null;
  timestamp: string | null;
  signature: string | null;
  body: string;
  nowMs: number;
}): Promise<boolean> {
  if (!input.secret || !input.timestamp || !input.signature || !/^\d{1,12}$/.test(input.timestamp)) return false;
  if (Math.abs(Math.floor(input.nowMs / 1000) - Number(input.timestamp)) > JOB_SIGNATURE_MAX_AGE_SEC) return false;
  return sameString(await signSlackJob(input.secret, input.timestamp, input.body), input.signature);
}
