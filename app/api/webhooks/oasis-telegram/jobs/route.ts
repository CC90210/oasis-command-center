/** Signed in-process target for the dedicated Telegram Cloudflare Queue. */
import type { NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import { runOasisTelegramJob } from "@/lib/telegram/jobs";
import {
  TELEGRAM_JOB_SIGNATURE_HEADER,
  TELEGRAM_JOB_TIMESTAMP_HEADER,
  verifyTelegramJob,
} from "@/lib/telegram/job-signature";
import {
  isOasisTelegramJob,
  oasisTelegramConfig,
  telegramWebhookEnabled,
  TELEGRAM_JOB_MAX_BYTES,
  type OasisTelegramEnv,
} from "@/lib/telegram/protocol";
import { readLimitedText } from "@/lib/telegram/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function POST(req: NextRequest): Promise<Response> {
  const env = process.env as OasisTelegramEnv;
  // The same emergency switch stops both ingress and already-queued work.
  if (!telegramWebhookEnabled(env)) return json(503, { ok: false, error: "telegram_webhook_disabled" });
  const config = oasisTelegramConfig(env);
  if (!config) return json(503, { ok: false, error: "telegram_webhook_not_configured" });
  if (!req.headers.get(TELEGRAM_JOB_TIMESTAMP_HEADER) || !req.headers.get(TELEGRAM_JOB_SIGNATURE_HEADER)) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const body = await readLimitedText(req, TELEGRAM_JOB_MAX_BYTES);
  if (!body.ok) return json(413, { ok: false, error: "payload_too_large" });
  const signed = await verifyTelegramJob({
    secret: config.jobSigningSecret,
    timestamp: req.headers.get(TELEGRAM_JOB_TIMESTAMP_HEADER),
    signature: req.headers.get(TELEGRAM_JOB_SIGNATURE_HEADER),
    body: body.text,
    nowMs: Date.now(),
  });
  if (!signed) return json(401, { ok: false, error: "unauthorized" });
  let job: unknown;
  try {
    job = JSON.parse(body.text);
  } catch {
    return json(200, { ok: true, dropped: "invalid_json" });
  }
  if (!isOasisTelegramJob(job) || job.botId !== config.botId || job.chatId !== config.chatId) {
    console.error("[oasis-telegram.jobs] malformed or foreign job dropped");
    return json(200, { ok: true, dropped: "malformed_job" });
  }
  if (!tursoConfigured()) return json(503, { ok: false, error: "database_not_configured" });
  try {
    const outcome = await runOasisTelegramJob(job, {
      db: getTursoClient(),
      config,
      now: () => new Date(),
    });
    if (outcome.outcome === "retry") return json(503, { ok: false, error: "job_incomplete", reason: outcome.reason });
    if (outcome.outcome === "delivery_unknown") {
      console.error("[oasis-telegram.jobs] Telegram delivery is ambiguous; suppressing retry", {
        botId: job.botId,
        updateId: job.updateId,
      });
    }
    return json(200, { ok: true, ...outcome });
  } catch (error) {
    console.error("[oasis-telegram.jobs] job failed", {
      botId: job.botId,
      updateId: job.updateId,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return json(500, { ok: false, error: "job_failed" });
  }
}
