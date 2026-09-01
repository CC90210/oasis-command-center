import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

const integration = read("lib/integrations/telegram-personal.ts");
const route = read("app/api/integrations/personal/telegram/route.ts");
const card = read("components/settings/TelegramConnectCard.tsx");

assert.ok(
  integration.includes("getUserIntegrationBundleForStatus"),
  "personal Telegram status must use the strict credential read",
);
assert.doesNotMatch(
  integration.match(/export async function getTelegramStatus[\s\S]*?\n}/)?.[0] || "",
  /\.catch\(\(\) => \(\{\}/,
  "a status read failure must not be converted to an empty disconnected bundle",
);
assert.doesNotMatch(
  integration.match(/export async function captureChatId[\s\S]*?\n}/)?.[0] || "",
  /getUserIntegrationBundle\([^\n]+\)\.catch/,
  "linking must not convert a credential-store outage into not connected",
);
assert.ok(
  integration.includes("unable to read bot before linking") &&
    integration.includes('error: "telegram_store_failed"'),
  "a link-time credential read failure must use the route's 503 storage path",
);
assert.ok(
  route.includes('error: "personal_telegram_status_unavailable"') &&
    route.includes("{ status: 503 }"),
  "the Telegram status route must return unavailable when storage cannot be read",
);
assert.ok(
  integration.includes("if (!stored.ok || stored.written.length !== 2)") &&
    integration.includes("if (!stored.ok)") &&
    route.includes('error: "personal_telegram_disconnect_failed"'),
  "Telegram validate, link, and disconnect must never report success after a failed credential write",
);
assert.ok(
  integration.includes("connected: !!b.bot_token && !!b.bot_username"),
  "a partially persisted Telegram bundle is not a connected bot",
);
assert.ok(
  integration.includes("linked: !!b.bot_token && !!b.bot_username && !!b.chat_id"),
  "a leftover chat id cannot show Connected without a complete bot credential bundle",
);
assert.ok(
  route.includes('r.error === "telegram_store_failed" ? 503') &&
    card.includes("Telegram verified the bot, but OASIS couldn't save it") &&
    card.includes("The existing connection is unchanged"),
  "storage failures must be diagnosed separately and disconnect must preserve the displayed state",
);
assert.ok(
  card.includes("[TelegramConnectCard.validate]") &&
    card.includes("[TelegramConnectCard.link]") &&
    card.includes("No connection was recorded") &&
    card.includes("It is not connected yet"),
  "network failures must end with an honest retry message instead of an unhandled promise",
);
assert.ok(
  card.includes('setLoadState("unavailable")') &&
    card.includes("This is unknown") &&
    card.includes("not disconnected"),
  "Settings must render a failed Telegram status read as unknown, not disconnected",
);

console.log("telegram-personal-status.test.ts: OK");
