/**
 * telegram-webhook-secret.test.ts - POST /api/telegram/webhook fails CLOSED
 * (2026-10-11).
 *
 * The route linked a Telegram chat to a profile for anyone presenting a valid
 * link code, and checked Telegram's secret header only "if set": with
 * TELEGRAM_WEBHOOK_SECRET unset, a forged update tied the forger's own chat to
 * someone else's profile (and its lead alerts).
 *
 * Pinned, through the real route against a local libSQL file:
 *   1. secret unset (or blank): 200 {ok:false}, the body is never read, and the
 *      profile is untouched (no chat linked, the code still there);
 *   2. secret set: a wrong, missing or different-length header is 401, the body
 *      is never read, nothing is written;
 *   3. the right header: the update is processed and the chat is linked.
 *
 * Run: node --conditions=react-server --import tsx tests/telegram-webhook-secret.test.ts
 */
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { USERS, check, finish, setupDatabase } from "./_delivery-harness";

// Never let a reply reach Telegram: with no bot token the route drops replies.
delete process.env.SUNBIZ_TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_WEBHOOK_SECRET;

const SECRET = "tg-webhook-secret_0123456789";
const CODE = "ABC123";
const ATTACKER_CHAT = 99887766;

async function main() {
  console.log("telegram webhook secret:");
  const db = await setupDatabase();
  await db.execute("ALTER TABLE user_profiles ADD COLUMN custom_fields TEXT");
  const expires = new Date(Date.now() + 10 * 60_000).toISOString();
  await db.execute({
    sql: "UPDATE user_profiles SET custom_fields = ? WHERE auth_user_id = ?",
    args: [JSON.stringify({ telegram_link: { code: CODE, expires_at: expires } }), USERS.adon.id],
  });
  const { POST } = await import("../app/api/telegram/webhook/route");

  const fields = async () => {
    const r = await db.execute({ sql: "SELECT custom_fields FROM user_profiles WHERE auth_user_id = ?", args: [USERS.adon.id] });
    return JSON.parse(String(r.rows[0].custom_fields)) as Record<string, unknown>;
  };
  const unlinked = async (why: string) => {
    const cf = await fields();
    assert.equal(cf.telegram_chat_id, undefined, `${why}: a chat was linked`);
    assert.deepEqual(cf.telegram_link, { code: CODE, expires_at: expires }, `${why}: the link code was consumed`);
  };
  const update = (headers: Record<string, string> = {}) =>
    new NextRequest("https://oasisai.work/api/telegram/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ message: { chat: { id: ATTACKER_CHAT }, text: `/start ${CODE}` } }),
    });

  await check("no secret configured: refused with 200 {ok:false}, body never read, nothing linked", async () => {
    for (const value of [undefined, "", "   "]) {
      if (value === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
      else process.env.TELEGRAM_WEBHOOK_SECRET = value;
      for (const headers of [{}, { "x-telegram-bot-api-secret-token": "" }, { "x-telegram-bot-api-secret-token": "anything" }]) {
        const req = update(headers);
        const res = await POST(req);
        assert.equal(res.status, 200, "200 so a registered webhook does not retry-storm");
        assert.equal(((await res.json()) as { ok: boolean }).ok, false);
        assert.equal(req.bodyUsed, false, "the update was read before the refusal");
        await unlinked(`secret ${JSON.stringify(value)}`);
      }
    }
  });

  await check("secret set: a wrong, missing or different-length header is 401 and nothing is read or written", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
    for (const headers of [
      {},
      { "x-telegram-bot-api-secret-token": "" },
      { "x-telegram-bot-api-secret-token": "tg-webhook-secret_0123456780" },
      { "x-telegram-bot-api-secret-token": `${SECRET}x` },
      { "x-telegram-bot-api-secret-token": SECRET.slice(0, -1) },
    ]) {
      const req = update(headers);
      const res = await POST(req);
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.equal(req.bodyUsed, false);
      await unlinked(JSON.stringify(headers));
    }
  });

  await check("the right secret: the update is processed and the chat is linked", async () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = `  ${SECRET}\n`;
    const res = await POST(update({ "x-telegram-bot-api-secret-token": SECRET }));
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { ok: boolean }).ok, true);
    const cf = await fields();
    assert.equal(cf.telegram_chat_id, String(ATTACKER_CHAT));
    assert.equal(cf.telegram_link, undefined, "the one-time code is consumed");
  });

  finish("telegram webhook secret");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
