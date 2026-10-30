/** Exact queue-name dispatch. An unknown queue is retried, never cross-consumed. */
import { consumeSlackJobs, type QueueBatch as SlackQueueBatch } from "../slack/queue-consumer";
import { consumeTelegramJobs, type TelegramQueueBatch } from "../telegram/queue-consumer";
import { OASIS_TELEGRAM_QUEUE_NAME, type OasisTelegramEnv } from "../telegram/protocol";

export const SLACK_AGENT_QUEUE_NAME = "oasis-slack-agent-jobs";

export type RoutedQueueBatch = TelegramQueueBatch & SlackQueueBatch;
type QueueEnv = OasisTelegramEnv & { SLACK_SIGNING_SECRET?: string };

type RouterDeps = {
  slack?: typeof consumeSlackJobs;
  telegram?: typeof consumeTelegramJobs;
};

export async function routeQueueBatch(
  batch: RoutedQueueBatch,
  env: QueueEnv,
  appFetch: (request: Request) => Promise<Response>,
  deps: RouterDeps = {},
): Promise<void> {
  if (batch.queue === OASIS_TELEGRAM_QUEUE_NAME) {
    await (deps.telegram ?? consumeTelegramJobs)(batch, env, appFetch);
    return;
  }
  if (batch.queue === SLACK_AGENT_QUEUE_NAME) {
    await (deps.slack ?? consumeSlackJobs)(batch, env, appFetch);
    return;
  }
  console.error("[worker.queue] unknown queue; every message retried", { queue: batch.queue });
  for (const message of batch.messages) message.retry();
}
