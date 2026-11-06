/**
 * tests/notification-log.test.ts — every automation notification also shows in the
 * Command Center (CC, 2026-11-05). Pins the log module, the Command Center's own
 * writer (sendTelegram's OASIS lanes, end to end against a real libSQL file), the
 * retention, and the words the Automations panel uses for delivery.
 *
 * Run: node --conditions=react-server --import tsx tests/notification-log.test.ts
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import {
  purgeNotificationLog,
  readRecentNotifications,
  recordNotification,
  splitNotice,
} from "../lib/notify/notification-log";
import { deliveryLine } from "../components/automations/NotificationLogPanel";

const MIGRATION = readFileSync("database/turso/bravo__254_notification_log.sql", "utf8");
const TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "11111111-2222-3333-4444-555555555555";

async function freshDb() {
  const db = createClient({ url: ":memory:" });
  await db.executeMultiple(MIGRATION);
  return db;
}

async function run() {
  // --- the log module ---------------------------------------------------------
  {
    const db = await freshDb();
    const t0 = new Date("2026-11-05T10:00:00Z");
    assert.equal(await recordNotification(db, {
      tenantId: TENANT, agent: "maven", title: "Library Post Linker failed", body: "boom",
      category: "system", severity: "warn", bridge: "maven", delivered: true, now: t0,
    }), true);
    await recordNotification(db, {
      tenantId: TENANT, agent: "bravo", title: "Daily Bravo Brief", bridge: "bravo", delivered: true,
      now: new Date("2026-11-05T11:00:00Z"),
    });
    await recordNotification(db, {
      tenantId: OTHER, agent: "bravo", title: "another workspace", delivered: true,
      now: new Date("2026-11-05T12:00:00Z"),
    });
    const all = await readRecentNotifications(db, TENANT);
    assert.ok(all.ok);
    if (all.ok) {
      assert.deepEqual(all.rows.map((r) => r.title), ["Daily Bravo Brief", "Library Post Linker failed"],
        "newest first, and only this workspace's notices");
      assert.equal(all.rows[1].delivered, true);
      assert.equal(all.rows[1].severity, "warn");
    }
    const maven = await readRecentNotifications(db, TENANT, { agent: "maven" });
    assert.ok(maven.ok && maven.rows.length === 1 && maven.rows[0].agent === "maven");

    // The schema refuses an agent nobody routes to.
    await assert.rejects(db.execute({
      sql: "INSERT INTO notification_log (id, tenant_id, agent, title, delivered, created_at) VALUES ('x', ?, 'someone', 't', 1, ?)",
      args: [TENANT, t0.toISOString()],
    }));

    // 90-day retention: only rows past the window go.
    await recordNotification(db, { tenantId: TENANT, agent: "atlas", title: "old", delivered: true,
      now: new Date("2026-07-01T00:00:00Z") });
    const purged = await purgeNotificationLog(db, new Date("2026-11-05T12:00:00Z"));
    assert.deepEqual(purged, { deleted: 1, notInstalled: false });
    const after = await readRecentNotifications(db, TENANT);
    assert.ok(after.ok && after.rows.length === 2);
  }

  // --- before the migration: quiet, honest, never a crash -------------------
  {
    const bare = createClient({ url: ":memory:" });
    assert.equal(await recordNotification(bare, { tenantId: TENANT, agent: "bravo", title: "x", delivered: true }), false);
    assert.deepEqual(await readRecentNotifications(bare, TENANT), { ok: false, reason: "not_installed" });
    assert.deepEqual(await purgeNotificationLog(bare, new Date()), { deleted: 0, notInstalled: true });
  }

  // --- titles from Telegram HTML -------------------------------------------
  assert.deepEqual(splitNotice("\n<b>New lead</b> &amp; booking\nJane &lt;jane@x.com&gt;\n"),
    { title: "New lead & booking", body: "Jane <jane@x.com>" });
  assert.deepEqual(splitNotice("   "), { title: "(empty notice)", body: null });

  // --- the Command Center's own writer, end to end ---------------------------
  {
    const dir = mkdtempSync(join(tmpdir(), "notification-log-"));
    const path = join(dir, "occ.db");
    const setup = createClient({ url: `file:${path}` });
    await setup.executeMultiple(MIGRATION);
    setup.close();
    process.env.TURSO_DB_PATH = path;
    process.env.OASIS_TELEGRAM_BOT_TOKEN = "test-token";
    process.env.OASIS_TELEGRAM_CHAT_ID = "111";
    const sent: string[] = [];
    let status = 200;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body ?? ""));
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false, description: "chat not found" }),
        { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const { sendTelegram } = await import("../lib/notify/telegram");
    assert.equal((await sendTelegram("<b>Meeting in 1 hour</b>\nJane at 3pm", { lane: "operator" })).ok, true);
    // A client workspace's own bot is that workspace's record, not CC's.
    await sendTelegram("client workspace alert", { token: "client-bot", chatId: "222" });
    status = 400;
    assert.equal((await sendTelegram("<b>Reminder failed</b>", { lane: "operator" })).ok, false);

    const { getTursoClient } = await import("../lib/turso");
    const read = await readRecentNotifications(getTursoClient(), TENANT);
    assert.ok(read.ok, "the Command Center wrote under CC's OASIS workspace");
    if (read.ok) {
      const titles = read.rows.map((r) => r.title).sort();
      assert.deepEqual(titles, ["Meeting in 1 hour", "Reminder failed"], "both operator-lane sends recorded, the client bot's not");
      const ok = read.rows.find((r) => r.title === "Meeting in 1 hour")!;
      assert.equal(ok.agent, "command_center");
      assert.equal(ok.bridge, "command_center");
      assert.equal(ok.delivered, true);
      assert.equal(ok.body, "Jane at 3pm");
      const failed = read.rows.find((r) => r.title === "Reminder failed")!;
      assert.equal(failed.delivered, false);
      assert.match(failed.detail ?? "", /telegram_http_400/);
    }
    assert.equal(sent.length, 3, "recording never changes what is sent");
    getTursoClient().close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold the libSQL file a moment after close(); it is the OS temp dir.
    }
  }

  // --- what the panel says about delivery -----------------------------------
  assert.equal(deliveryLine({ agent: "maven", bridge: "maven", delivered: true, detail: null }), "Sent by Maven's bot");
  assert.equal(
    deliveryLine({ agent: "maven", bridge: "bravo", delivered: true, detail: null }),
    "Sent by Bravo's bot: Maven's bot is not set up where this ran",
  );
  assert.equal(
    deliveryLine({ agent: "atlas", bridge: null, delivered: false, detail: "telegram_http_403" }),
    "Not sent to Telegram: telegram_http_403",
  );
  assert.equal(deliveryLine({ agent: "command_center", bridge: "command_center", delivered: true, detail: null }),
    "Sent by the Command Center");

  // --- the read gate is bound to the tenant the notices come from ------------
  // An agents owner of ANOTHER OASIS workspace is not CC (CodeRabbit, #806): the
  // owner check must name WEBDEV_TENANT_ID, the tenant readRecentNotifications reads.
  {
    const route = readFileSync("app/api/automations/notifications/route.ts", "utf8");
    assert.match(route, /isAgentsOwner\(WEBDEV_TENANT_ID, session\.userId\)/);
    assert.doesNotMatch(route, /isAgentsOwner\(session\.tenantId/);
    assert.match(route, /readRecentNotifications\(getTursoClient\(\), WEBDEV_TENANT_ID,/);
    // The panel drops an answer that is no longer the newest request's.
    const panel = readFileSync("components/automations/NotificationLogPanel.tsx", "utf8");
    // \r?\n: a Windows checkout (core.autocrlf) has CRLF line ends.
    assert.match(panel, /const seq = \+\+latest\.current;\r?\n(?:\s*\/\/[^\n]*\n)*\s*const qs = /);
    assert.match(panel, /\{ retries: 2 \}\);\r?\n\s*if \(seq !== latest\.current\) return;\r?\n/);
  }

  console.log("notification-log: all assertions passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
