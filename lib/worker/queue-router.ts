/** Exact queue-name dispatch. An unknown queue is retried, never cross-consumed. */
import { consumeSlackJobs, type QueueBatch as SlackQueueBatch } from "../slack/queue-consumer";
import { consumeTelegramJobs, type TelegramQueueBatch } from "../telegram/queue-consumer";
import { OASIS_TELEGRAM_QUEUE_NAME, type OasisTelegramEnv } from "../telegram/protocol";
import {
  consumeMavenPublishJobs,
  type MavenQueueBatch,
  type MavenQueueEnv,
} from "../marketing/maven-publish-queue-consumer";
import { MAVEN_PUBLISH_QUEUE_NAME } from "../marketing/maven-publish-contract";

export const SLACK_AGENT_QUEUE_NAME = "oasis-slack-agent-jobs";

export type RoutedQueueBatch = TelegramQueueBatch & MavenQueueBatch & SlackQueueBatch;
type QueueEnv = OasisTelegramEnv & MavenQueueEnv & { SLACK_SIGNING_SECRET?: string };

type RouterDeps = {
  slack?: typeof consumeSlackJobs;
  telegram?: typeof consumeTelegramJobs;
  maven?: typeof consumeMavenPublishJobs;
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
  if (batch.queue === MAVEN_PUBLISH_QUEUE_NAME) {
    await (deps.maven ?? consumeMavenPublishJobs)(batch, env, appFetch);
    return;
  }
  if (batch.queue === SLACK_AGENT_QUEUE_NAME) {
    await (deps.slack ?? consumeSlackJobs)(batch, env, appFetch);
    return;
  }
  console.error("[worker.queue] unknown queue; every message retried", { queue: batch.queue });
  for (const message of batch.messages) message.retry();
}
