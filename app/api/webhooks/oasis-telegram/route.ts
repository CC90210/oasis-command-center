/** Dedicated CC/OASIS Telegram ingress. The SunBiz link-code webhook is separate. */
import type { NextRequest } from "next/server";
import { getTursoClient, tursoConfigured } from "@/lib/turso";
import type { OasisTelegramEnv } from "@/lib/telegram/protocol";
import { handleOasisTelegramWebhook, telegramJobQueueBinding } from "@/lib/telegram/webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  return handleOasisTelegramWebhook(req, {
    env: process.env as OasisTelegramEnv,
    database: () => (tursoConfigured() ? getTursoClient() : null),
    queue: telegramJobQueueBinding,
  });
}
