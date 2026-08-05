/**
 * Which bot is sending lead alerts, and into which chat?
 *
 * WHY THIS EXISTS. On 2026-08-01 CC completed the ai-audit funnel, received
 * the welcome email, and got no Telegram alert. Every error path was checked
 * and none of them fired: credentials are set, the code reads the right
 * names, the ingest was not deduped, dry-run does not gate Telegram.
 *
 * That leaves a failure mode no amount of error handling can detect. This
 * app sends via OASIS_TELEGRAM_BOT_TOKEN → OASIS_TELEGRAM_CHAT_ID. The Bravo
 * bridge CC actually reads polls TELEGRAM_BOT_TOKEN. If those are different
 * BotFather bots, or the chat id points somewhere CC does not watch, every
 * alert has been delivering PERFECTLY — `{ok: true}`, HTTP 200, no error, no
 * marker row — into a conversation nobody opens. Silence that looks like
 * success is not something a try/catch can find.
 *
 * So: ask Telegram directly. `getMe` names the bot, `getChat` names the
 * destination. Comparing those two answers against the chat CC has open on
 * his phone is the only thing that closes this question.
 *
 * Returns IDENTIFIERS ONLY — bot username, chat id, chat title. Never the
 * token, never any part of it. A diagnostic that leaks the credential it is
 * diagnosing is worse than the bug.
 */
import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { describeLanes, laneCredentials } from "@/lib/notify/telegram";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TgResult = { ok: boolean; result?: Record<string, unknown>; description?: string };

async function tg(token: string, method: string, body?: unknown): Promise<TgResult> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(8000),
    });
    return (await res.json()) as TgResult;
  } catch (err) {
    return { ok: false, description: err instanceof Error ? err.message : "fetch_failed" };
  }
}

export async function GET() {
  // Same gate the other diagnostic routes use. This reveals which chat
  // receives lead alerts, which is not public information.
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }

  // Every lane, not just CC's. The first version of this route inspected only
  // the OASIS pair, so on 2026-08-02 it would have reported everything healthy
  // while SunBiz operational alerts were landing in the wrong DM — a diagnostic
  // blind to the exact failure it exists to catch. describeLanes() is derived
  // from the sender's own lane table, so this can never drift behind it again.
  const lanes = await Promise.all(
    describeLanes().map(async (l) => {
      if (!l.configured) {
        return {
          lane: l.lane,
          audience: l.audience,
          configured: false,
          tokenVar: l.tokenVar,
          chatVar: l.chatVar,
          note: "sends on this lane fail closed — they do NOT fall back to another lane",
        };
      }
      const creds = laneCredentials(l.lane);
      if (!creds) {
        return { lane: l.lane, audience: l.audience, configured: false, tokenVar: l.tokenVar, chatVar: l.chatVar };
      }
      const me = await tg(creds.token, "getMe");
      const chat = await tg(creds.token, "getChat", { chat_id: creds.chatId });
      return {
        lane: l.lane,
        audience: l.audience,
        configured: true,
        tokenVar: l.tokenVar,
        chatVar: l.chatVar,
        bot: me.ok
          ? { username: me.result?.username, id: me.result?.id, name: me.result?.first_name }
          : { error: me.description ?? "getMe_failed" },
        chat: chat.ok
          ? {
              id: chat.result?.id,
              type: chat.result?.type,
              title: chat.result?.title ?? chat.result?.username ?? null,
            }
          : { error: chat.description ?? "getChat_failed" },
      };
    }),
  );

  return NextResponse.json({
    ok: true,
    lanes,
    // The question this endpoint exists to answer.
    hint:
      "For each lane, compare `bot.username` and `chat.title`/`chat.id` against who `audience` says should be reading it. A lane whose destination is not that person has been delivering successfully to the wrong place — which looks identical to working from every other angle.",
  });
}
