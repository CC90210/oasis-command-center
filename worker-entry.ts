/**
 * worker-entry.ts - the Worker's entry point when OASIS runs Slack agent turns
 * on a Cloudflare Queue: OpenNext's own fetch handler, unchanged, plus a
 * queue() consumer for the SLACK_AGENT_JOBS queue.
 *
 * WHY. Slack wants an answer in 3 seconds and a department's turn can take
 * longer than the 30 seconds a request may keep working after it answers.
 * Queue consumers get 15 minutes. lib/slack/jobs.ts sends each @mention to the
 * queue when the Worker has the binding, and falls back to after() when it
 * does not, so Slack works either way; the queue only lifts the time limit.
 *
 * NOT WIRED YET, ON PURPOSE (a held step for CC, see the PR): switching
 * wrangler.jsonc "main" to this file and adding the queue bindings needs the
 * queue to exist in the Cloudflare account first (a deploy with a binding to a
 * missing queue fails), and the CI bundle check reads the entry's output name:
 *
 *   "main": "worker-entry.ts",
 *   "queues": {
 *     "producers": [{ "binding": "SLACK_AGENT_JOBS", "queue": "oasis-slack-agent-jobs" }],
 *     "consumers": [{ "queue": "oasis-slack-agent-jobs", "max_batch_size": 1, "max_retries": 3 }]
 *   }
 *
 * The consumer logic is lib/slack/queue-consumer.ts (tested without a Worker).
 */
import handler from "./.open-next/worker.js";
import { consumeSlackJobs, type QueueBatch } from "./lib/slack/queue-consumer";

type Env = { SLACK_SIGNING_SECRET?: string; PUBLIC_APP_URL?: string } & Record<string, unknown>;
type Ctx = { waitUntil(p: Promise<unknown>): void; passThroughOnException?(): void };

const worker = {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
  async queue(batch: QueueBatch, env: Env, ctx: Ctx): Promise<void> {
    await consumeSlackJobs(batch, env, (request) => handler.fetch(request, env, ctx));
  },
};

export default worker;
