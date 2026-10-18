/**
 * worker-entry.ts - the Worker's entry point (wrangler.jsonc "main"): OpenNext's own handler, given the env with every
 * secret bundle expanded (lib/runtime/secret-bundles.ts), plus a queue() consumer for Slack agent turns.
 *
 * SECRET BUNDLES (wired 2026-10-18). Cloudflare allows 128 secrets plus vars per Worker and this one reached it. A
 * bundle carries many secrets in one; this file expands them before OpenNext sees the env, so OpenNext copies them into
 * process.env (and getCloudflareContext().env) like any other secret. Expanded once per env object (one per isolate).
 *
 * SLACK QUEUE (still held for CC, see the Slack PR). Slack wants an answer in 3 seconds and a department's turn can
 * take longer than the 30 seconds a request may keep working after it answers; queue consumers get 15 minutes.
 * lib/slack/jobs.ts sends each @mention to the queue when the Worker has the binding and falls back to after() when it
 * does not, so Slack works either way. The queue bindings are NOT added yet: a deploy with a binding to a missing queue
 * fails, so the queue must exist in the Cloudflare account first. Then add to wrangler.jsonc:
 *
 *   "queues": {
 *     "producers": [{ "binding": "SLACK_AGENT_JOBS", "queue": "oasis-slack-agent-jobs" }],
 *     "consumers": [{ "queue": "oasis-slack-agent-jobs", "max_batch_size": 1, "max_retries": 3 }]
 *   }
 *
 * Until then queue() below is never called. The consumer logic is lib/slack/queue-consumer.ts (tested without a Worker).
 */
import handler from "./.open-next/worker.js";
import { expandSecretBundles } from "./lib/runtime/secret-bundles";
import { consumeSlackJobs, type QueueBatch } from "./lib/slack/queue-consumer";

type Env = { SLACK_SIGNING_SECRET?: string; PUBLIC_APP_URL?: string } & Record<string, unknown>;
type Ctx = { waitUntil(p: Promise<unknown>): void; passThroughOnException?(): void };

const expanded = new WeakMap<object, Env>();

/** The env with the secret bundles expanded, worked out once per env object. A bundle that cannot be read is logged. */
function withSecretBundles(env: Env): Env {
  const cached = expanded.get(env);
  if (cached) return cached;
  const { env: merged, report } = expandSecretBundles(env);
  if (report.invalid.length) {
    console.error("[secret-bundles] unreadable bundle(s), their keys are unset:", report.invalid.join(", "));
  }
  expanded.set(env, merged);
  return merged;
}

const worker = {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handler.fetch(request, withSecretBundles(env), ctx);
  },
  async queue(batch: QueueBatch, env: Env, ctx: Ctx): Promise<void> {
    const full = withSecretBundles(env);
    await consumeSlackJobs(batch, full, (request) => handler.fetch(request, full, ctx));
  },
};

export default worker;
