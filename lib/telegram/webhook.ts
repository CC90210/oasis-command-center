import "server-only";
import type { Client } from "@libsql/client";
import {
  constantTimeSecretEqual,
  oasisTelegramConfig,
  parseOasisTelegramUpdate,
  telegramWebhookEnabled,
  TELEGRAM_UPDATE_MAX_BYTES,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  type OasisTelegramEnv,
  type OasisTelegramJob,
} from "./protocol";
import { ensureTelegramReceipt } from "./receipt-store";

export type TelegramJobQueue = { send(body: OasisTelegramJob): Promise<unknown> };

type WebhookDeps = {
  env: OasisTelegramEnv;
  database(): Client | null;
  queue(): Promise<TelegramJobQueue | null>;
  now?: () => Date;
};

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function readLimitedText(req: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const announced = req.headers.get("content-length");
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > maxBytes)) return { ok: false };
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body_too_large");
      return { ok: false };
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false };
  }
}

/** Public webhook handler, dependency-injected so every rejection is tested without Cloudflare. */
export async function handleOasisTelegramWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  // Rollback means zero reads, writes or queue work. Keep this as the first branch.
  if (!telegramWebhookEnabled(deps.env)) return json(503, { ok: false, error: "telegram_webhook_disabled" });

  const config = oasisTelegramConfig(deps.env);
  if (!config) return json(503, { ok: false, error: "telegram_webhook_not_configured" });
  if (!(await constantTimeSecretEqual(config.webhookSecret, req.headers.get(TELEGRAM_WEBHOOK_SECRET_HEADER)))) {
    return json(401, { ok: false, error: "unauthorized" });
  }
  const contentType = String(req.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("application/json")) return json(415, { ok: false, error: "json_required" });
  const body = await readLimitedText(req, TELEGRAM_UPDATE_MAX_BYTES);
  if (!body.ok) return json(413, { ok: false, error: "payload_too_large" });
  let update: unknown;
  try {
    update = JSON.parse(body.text);
  } catch {
    return json(400, { ok: false, error: "invalid_json" });
  }
  const parsed = parseOasisTelegramUpdate(update, config.chatId);
  // Telegram retries non-2xx. Unsupported or foreign updates can never become valid.
  if (!parsed.ok) return json(200, { ok: true, ignored: parsed.reason });

  const queue = await deps.queue();
  if (!queue) return json(503, { ok: false, error: "telegram_queue_unavailable" });
  const db = deps.database();
  if (!db) return json(503, { ok: false, error: "database_not_configured" });
  try {
    const stored = await ensureTelegramReceipt(db, parsed.job, (deps.now ?? (() => new Date()))());
    if (stored.receipt.status === "done" || stored.receipt.status === "dead") {
      return json(200, { ok: true, duplicate: true, state: stored.receipt.payload.phase });
    }
    if (stored.receipt.status === "processing") {
      return json(200, { ok: true, duplicate: true, state: "processing" });
    }
    await queue.send(parsed.job);
    return json(200, { ok: true, queued: true, duplicate: !stored.created });
  } catch (error) {
    console.error("[oasis-telegram.webhook] ingress failed", {
      updateId: parsed.job.updateId,
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
    return json(503, { ok: false, error: "telegram_ingress_failed" });
  }
}

let noContextLogged = false;

/** The dedicated producer binding. There is intentionally no after() fallback. */
export async function telegramJobQueueBinding(): Promise<TelegramJobQueue | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    const context = mod.getCloudflareContext();
    const queue = (context.env as unknown as Record<string, unknown>).TELEGRAM_AGENT_JOBS as TelegramJobQueue | undefined;
    return queue && typeof queue.send === "function" ? queue : null;
  } catch (error) {
    if (!noContextLogged) {
      noContextLogged = true;
      console.error(
        "[oasis-telegram.webhook] Cloudflare queue context unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return null;
  }
}
