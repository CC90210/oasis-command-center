/**
 * worker-entry.ts - the Worker's entry point (wrangler.jsonc "main"): OpenNext's own handler, given the env with every
 * secret bundle expanded (lib/runtime/secret-bundles.ts), plus exact-name queue routing.
 *
 * SECRET BUNDLES (wired 2026-10-18). Cloudflare allows 128 secrets plus vars per Worker and this one reached it. A
 * bundle carries many secrets in one; this file expands them before OpenNext sees the env, so OpenNext copies them into
 * process.env (and getCloudflareContext().env) like any other secret. Expanded once per env object (one per isolate).
 *
 * QUEUES. Every batch is dispatched by batch.queue in lib/worker/queue-router.ts.
 * Telegram can never fall into Slack (or a later Maven drain) when bindings share this Worker. The Telegram producer
 * and consumer are declared in wrangler.jsonc for oasis-telegram-agent-jobs. Rollback is TELEGRAM_WEBHOOK_ENABLED=off;
 * remove those two bindings only after the queue is drained or deliberately abandoned.
 *
 * Slack is still held for CC, see the Slack PR. Its queue does not exist yet, so its bindings remain absent. When it is
 * created the exact queue name is oasis-slack-agent-jobs:
 *
 *   "queues": {
 *     "producers": [{ "binding": "SLACK_AGENT_JOBS", "queue": "oasis-slack-agent-jobs" }],
 *     "consumers": [{ "queue": "oasis-slack-agent-jobs", "max_batch_size": 1, "max_retries": 3 }]
 *   }
 *
 * Queue consumers are kept outside this entry so they can be tested without a Worker bundle.
 */
import handler from "./.open-next/worker.js";
import { expandSecretBundles, scrubBundlesFromProcessEnv } from "./lib/runtime/secret-bundles";
import { routeQueueBatch, type RoutedQueueBatch } from "./lib/worker/queue-router";

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
  // nodejs_compat copied the raw bundles into process.env at isolate start; OpenNext never removes keys.
  scrubBundlesFromProcessEnv(process.env);
  expanded.set(env, merged);
  return merged;
}

const worker = {
  fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    return handler.fetch(request, withSecretBundles(env), ctx);
  },
  async queue(batch: RoutedQueueBatch, env: Env, ctx: Ctx): Promise<void> {
    const full = withSecretBundles(env);
    await routeQueueBatch(batch, full, (request) => handler.fetch(request, full, ctx));
  },
};

export default worker;
