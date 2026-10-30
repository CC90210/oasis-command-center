/** Worker-level queue consumer: sign and hand one Telegram job in-process to Next. */
import {
  TELEGRAM_JOB_SIGNATURE_HEADER,
  TELEGRAM_JOB_TIMESTAMP_HEADER,
  signTelegramJob,
} from "./job-signature";
import { type OasisTelegramEnv } from "./protocol";

export const TELEGRAM_JOBS_PATH = "/api/webhooks/oasis-telegram/jobs";
export const TELEGRAM_INTERNAL_ORIGIN = "https://oasis-internal.invalid";

export type TelegramQueueMessage = { body: unknown; ack(): void; retry(): void };
export type TelegramQueueBatch = { queue: string; messages: readonly TelegramQueueMessage[] };

export async function consumeTelegramJobs(
  batch: TelegramQueueBatch,
  env: OasisTelegramEnv,
  appFetch: (request: Request) => Promise<Response>,
  nowMs: () => number = Date.now,
): Promise<{ acked: number; retried: number }> {
  const secret = String(env.OASIS_TELEGRAM_JOB_SIGNING_SECRET || "").trim();
  let acked = 0;
  let retried = 0;
  let origin = TELEGRAM_INTERNAL_ORIGIN;
  try {
    if (env.PUBLIC_APP_URL) origin = new URL(env.PUBLIC_APP_URL).origin;
  } catch {
    console.error("[oasis-telegram.queue] PUBLIC_APP_URL is invalid; using the internal origin");
  }
  if (!secret) {
    console.error("[oasis-telegram.queue] job signing secret is unset; retrying every message");
    for (const message of batch.messages) {
      message.retry();
      retried += 1;
    }
    return { acked, retried };
  }
  for (const message of batch.messages) {
    const body = JSON.stringify(message.body);
    const timestamp = String(Math.floor(nowMs() / 1000));
    try {
      const response = await appFetch(
        new Request(`${origin}${TELEGRAM_JOBS_PATH}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [TELEGRAM_JOB_TIMESTAMP_HEADER]: timestamp,
            [TELEGRAM_JOB_SIGNATURE_HEADER]: await signTelegramJob(secret, timestamp, body),
          },
          body,
        }),
      );
      if (response.ok) {
        message.ack();
        acked += 1;
      } else {
        console.error("[oasis-telegram.queue] job incomplete; retrying", { status: response.status });
        message.retry();
        retried += 1;
      }
    } catch (error) {
      console.error(
        "[oasis-telegram.queue] job threw; retrying",
        error instanceof Error ? error.message : String(error),
      );
      message.retry();
      retried += 1;
    }
  }
  return { acked, retried };
}
