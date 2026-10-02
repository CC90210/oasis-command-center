/**
 * lib/slack/queue-consumer.ts - the SLACK_AGENT_JOBS queue consumer's logic,
 * kept out of worker-entry.ts so it can be tested without a Worker.
 *
 * Each message is one @mention job. It is signed (lib/slack/job-signature.ts)
 * and handed to the app's own /api/webhooks/slack/jobs route IN-PROCESS (the
 * OpenNext handler's fetch, not the network), which runs it with the queue
 * consumer's 15-minute budget. A 2xx acks the message; anything else retries
 * it (Cloudflare's retry and dead-letter settings apply). No job key on the
 * Worker (CONNECTIONS_OAUTH_STATE_SECRET, see job-signature.ts) means no job
 * can be proven, so every message is retried and the reason is logged once per
 * batch.
 *
 * No "server-only" and no Next import: this runs in the Worker entry, outside
 * Next's bundle.
 */
import { JOB_SIGNATURE_HEADER, JOB_TIMESTAMP_HEADER, signSlackJob, slackJobSecret } from "./job-signature";

export const SLACK_JOBS_PATH = "/api/webhooks/slack/jobs";
/** When PUBLIC_APP_URL is unset: the request never leaves the Worker (handler.fetch is called directly). */
export const INTERNAL_ORIGIN = "https://oasis-internal.invalid";

export type QueueMessage = { body: unknown; ack(): void; retry(): void };
export type QueueBatch = { messages: readonly QueueMessage[] };

export async function consumeSlackJobs(
  batch: QueueBatch,
  env: { CONNECTIONS_OAUTH_STATE_SECRET?: string; PUBLIC_APP_URL?: string },
  appFetch: (request: Request) => Promise<Response>,
  nowMs: () => number = Date.now,
): Promise<{ acked: number; retried: number }> {
  const secret = await slackJobSecret(env);
  let acked = 0;
  let retried = 0;
  // The app's own origin, so host-aware middleware treats the request as the
  // app's; the request still never leaves the Worker.
  let origin = INTERNAL_ORIGIN;
  try {
    if (env.PUBLIC_APP_URL) origin = new URL(env.PUBLIC_APP_URL).origin;
  } catch {
    console.error("[slack.queue] PUBLIC_APP_URL is not a URL; using the internal origin");
  }
  if (!secret) {
    console.error("[slack.queue] CONNECTIONS_OAUTH_STATE_SECRET is not set on the Worker (it keys the job signature); every job is retried");
    for (const m of batch.messages) {
      m.retry();
      retried += 1;
    }
    return { acked, retried };
  }
  for (const m of batch.messages) {
    const body = JSON.stringify(m.body);
    const ts = String(Math.floor(nowMs() / 1000));
    try {
      const res = await appFetch(
        new Request(`${origin}${SLACK_JOBS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [JOB_TIMESTAMP_HEADER]: ts,
            [JOB_SIGNATURE_HEADER]: await signSlackJob(secret, ts, body),
          },
          body,
        }),
      );
      if (res.ok) {
        m.ack();
        acked += 1;
      } else {
        console.error("[slack.queue] job not done; retrying", { status: res.status });
        m.retry();
        retried += 1;
      }
    } catch (err) {
      console.error("[slack.queue] job threw; retrying", err instanceof Error ? err.message : String(err));
      m.retry();
      retried += 1;
    }
  }
  return { acked, retried };
}
