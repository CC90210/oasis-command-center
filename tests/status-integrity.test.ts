/**
 * status-integrity.test.ts - every screen that says whether an app is connected
 * gives the SAME answer for the same facts (CC, 2026-10-08: "Notifications says
 * Telegram is not set up, while Connections shows Connected, verified just
 * now ... the integrity and accuracy of the software").
 *
 * One fixture state, two workspaces:
 *
 *   OASIS (CC)    its Telegram bot and Google mailbox are OASIS's own server
 *                 values, and OASIS's computer reports a "healthy" heartbeat for
 *                 each every minute that only says the key NAME is in its env
 *                 file (via env_key_present). CC has no personal Telegram bot;
 *                 his own Google account is connected as his work address.
 *   Client A      its own Telegram team bot passed Test five minutes ago; its
 *                 shared Google mailbox failed Test (Gmail refused the sign-in);
 *                 the same presence heartbeats are planted for it too (hostile);
 *                 its owner's own Google account is connected as a DIFFERENT
 *                 address than her work email; her own Telegram bot is saved
 *                 with no chat linked; its Slack connection is expired.
 *
 * For each integration, every surface that answers is evaluated against those
 * facts, through the code the screen runs, and every answer must match:
 *
 *   Telegram team bot   Settings > Connections (the hub's loader), Settings >
 *                       Chat apps (the page, rendered), Settings > Notifications
 *                       (the page, rendered), the department chips and the AI
 *                       Team row (the same resolver, wired as pinned below),
 *                       System health's card (rendered).
 *   Your own Telegram   Notifications (rendered) and the bot's setup card (its
 *                       API, which the card prints verbatim).
 *   Google mailbox      Connections and the department chips (one resolver);
 *                       the drawer's key form has no verdict of its own.
 *   Your own Google     the Settings panel (its API), the Connections card's
 *                       line, Today's calendar line (loader + rendered).
 *   Slack               the Connections card, the department Slack line and the
 *                       AI Team row (rendered).
 *   Workspace counts    the rail's dot and the Operations tile.
 *
 * Real pages, routes and loaders on a local libSQL file (tests/_delivery-
 * harness.ts); no network: any fetch throws.
 *
 * Run: node --conditions=react-server --import tsx tests/status-integrity.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { CLIENT_A, CLIENT_B, OASIS, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";

(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
stub("next/image", {
  __esModule: true,
  default: ({ src, alt }: { src: string; alt?: string }) => ReactNS.createElement("img", { src, alt }),
});
{
  const p = join(__dirname, "..", "components/SafeBoundary.tsx");
  const exports = { SafeBoundary: ({ children }: { children?: unknown }) => children };
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

process.env.BRAVO_FIELD_ENCRYPTION_KEY = "status-integrity-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";
// OASIS's own server values (the harness cleared the real ones). Never sent anywhere.
process.env.OASIS_TELEGRAM_BOT_TOKEN = "123456789:status-integrity-oasis-bot-token-000000";
process.env.OASIS_TELEGRAM_CHAT_ID = "555000111";
process.env.GMAIL_USER = "ops@oasisai.work";
process.env.GMAIL_APP_PASSWORD = "abcdabcdabcdabcd";
const SLACK_ENV = {
  SLACK_CLIENT_ID: "1234.5678",
  SLACK_CLIENT_SECRET: "status-integrity-slack-client-secret",
  SLACK_SIGNING_SECRET: "status-integrity-slack-signing-secret",
  CONNECTIONS_OAUTH_STATE_SECRET: "status-integrity-state-secret-long-enough-0001",
} as const;
Object.assign(process.env, SLACK_ENV);
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`network disabled in test: ${String(input).slice(0, 80)}`);
}) as typeof fetch;

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
type Json = Record<string, unknown>;
type Status = { kind: string; label: string; detail?: string };

function renderClient(cases: unknown[]): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/status-integrity.render.ts"], {
    cwd: root,
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { markup: Record<string, string> }).markup;
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

/** Every string a server page's tree renders as text. */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(" ");
  if (!node || typeof node !== "object") return "";
  const props = (node as { props?: Json }).props ?? {};
  return Object.values(props).map(textOf).join(" ");
}

/** Every element of a server page's tree whose type is `type`, with its props. */
function elementsOf(node: unknown, type: unknown, out: Json[] = []): Json[] {
  if (Array.isArray(node)) {
    for (const n of node) elementsOf(n, type, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const el = node as { type?: unknown; props?: Json };
  if (el.type === type && el.props) out.push(el.props);
  for (const v of Object.values(el.props ?? {})) elementsOf(v, type, out);
  return out;
}

/** Every surface's answer for one integration must be the same value. */
function agree(what: string, answers: Array<[surface: string, value: string]>): void {
  console.log(`        ${what}:`);
  for (const [surface, value] of answers) console.log(`          ${surface.padEnd(44)} ${value}`);
  const first = answers[0][1];
  for (const [surface, value] of answers) {
    assert.equal(value, first, `${what}: "${surface}" says "${value}" but "${answers[0][0]}" says "${first}"`);
  }
}

async function main() {
  const db = await setupDatabase();
  await db.executeMultiple(`
    CREATE TABLE "tenant_integration_credentials" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "service" TEXT NOT NULL, "field_key" TEXT NOT NULL,
      "encrypted_value" TEXT NOT NULL, "last_tested_at" TEXT, "last_test_ok" INTEGER, "last_test_error" TEXT,
      "created_by" TEXT,
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
    CREATE UNIQUE INDEX "tic_key" ON "tenant_integration_credentials" (tenant_id, service, field_key);
    CREATE TABLE integrations_health (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT,
      profile_id TEXT, service TEXT, status TEXT, last_ping_at TEXT, last_error TEXT, metadata TEXT);
    CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      tenant_id TEXT, user_id TEXT, service TEXT, field_key TEXT, encrypted_value TEXT,
      last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT, created_at TEXT, updated_at TEXT);
    CREATE UNIQUE INDEX "uic_key" ON user_integration_credentials (tenant_id, user_id, service, field_key);
    CREATE TABLE tenant_manifests (tenant_id TEXT, slug TEXT, manifest TEXT, updated_at TEXT);
  `);
  await db.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));
  await db.executeMultiple(read("database/turso/bravo__197_slack_jev.sql"));

  const connectors = await import("../lib/os/connectors");
  const { loadConnectorFacts, loadConnectorStatuses, loadWorkspaceConnectorStatus } = await import("../components/os/connections/connector-facts");
  const store = await import("../lib/tenant-integration-store");
  const { setUserIntegrationBundle } = await import("../lib/user-integration-store");
  const { heartbeatVerdict } = await import("../lib/integrations/presence-heartbeat");
  const { loadCalendarStatus } = await import("../components/os/today/loaders");
  const { loadSlackPresence, slackHomeFor } = await import("../lib/slack/status");
  const { getTursoClient } = await import("../lib/turso");
  const { StatusLine } = await import("../components/os/connections/StatusLine");
  const { ChatAppCard } = await import("../components/settings/ChatAppCard");
  const { default: NotificationsPage } = await import("../app/settings/notifications/page");
  const { default: ChatAppsPage } = await import("../app/settings/chat-apps/page");
  const personalStatusRoute = await import("../app/api/integrations/personal/status/route");
  const personalTelegramRoute = await import("../app/api/integrations/personal/telegram/route");

  // -- The fixture ----------------------------------------------------------------
  const now = Date.now();
  const at = (msAgo: number) => new Date(now - msAgo).toISOString();
  const presence = JSON.stringify({ via: "env_key_present" });
  for (const tenant of [OASIS, CLIENT_A]) {
    for (const service of ["telegram", "gws"]) {
      await db.execute({
        sql: "INSERT INTO integrations_health (tenant_id, profile_id, service, status, last_ping_at, metadata) VALUES (?, ?, ?, 'healthy', ?, ?)",
        args: [tenant, `p-${tenant === OASIS ? USERS.cc.id : USERS.clientA.id}`, service, at(20_000), presence],
      });
    }
  }
  const save = async (service: string, values: Record<string, string>, test: { ok: boolean; error?: string } | null) => {
    for (const [fieldKey, value] of Object.entries(values)) {
      const r = await store.setTenantIntegrationValue({ tenantId: CLIENT_A, service, fieldKey, value, createdBy: "test" });
      assert.ok(r.ok, `${service}.${fieldKey} saved`);
    }
    if (test) {
      for (const fieldKey of Object.keys(values)) {
        await store.recordIntegrationTest({ tenantId: CLIENT_A, service, fieldKey, ok: test.ok, error: test.error ?? null });
      }
      // The Test ran five minutes ago.
      await db.execute({
        sql: "UPDATE tenant_integration_credentials SET last_tested_at = ? WHERE tenant_id = ? AND service = ?",
        args: [at(5 * 60_000), CLIENT_A, service],
      });
    }
  };
  await save("telegram", { bot_token: "987654321:client-a-team-bot-token-0000000000", chat_id: "-1001234567" }, { ok: true });
  await save("gws", { app_password: "wxyzwxyzwxyzwxyz", from_address: "team@client-a.test" }, { ok: false, error: "smtp_auth_failed" });

  const calendarScope = "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/gmail.send";
  assert.ok((await setUserIntegrationBundle(CLIENT_A, USERS.clientA.id, "gmail_oauth", {
    refresh_token: "client-a-refresh", scope: calendarScope, gmail_address: "alice.personal@gmail.test",
  })).ok);
  assert.ok((await setUserIntegrationBundle(OASIS, USERS.cc.id, "gmail_oauth", {
    refresh_token: "cc-refresh", scope: calendarScope, gmail_address: USERS.cc.email,
  })).ok);
  assert.ok((await setUserIntegrationBundle(CLIENT_A, USERS.clientA.id, "telegram_bot", {
    bot_token: "111111111:client-a-personal-bot-000000000000", bot_username: "alice_alerts_bot",
  })).ok);
  await db.execute({
    sql: `INSERT INTO tenant_connections (id, tenant_id, provider, auth_kind, external_account_id, external_account_label, status,
            last_health_at, last_health_verdict, last_health_code, connected_at, created_at, updated_at)
          VALUES ('conn-slack-a', ?, 'slack', 'app_install', 'T0CLIENTA', 'Client A Slack', 'expired', ?, 'down', 'key_rejected', ?, ?, ?)`,
    args: [CLIENT_A, at(30 * 60_000), at(86_400_000), at(86_400_000), at(30 * 60_000)],
  });

  const telegramDef = connectors.connectorBySlug("telegram")!;
  const slackDef = connectors.connectorBySlug("slack")!;
  const kl = (s: Status | null | undefined) => (s ? `${s.kind} | ${s.label}` : "(none)");

  /** Settings > Notifications, rendered for the signed-in viewer: [workspace bot, your own bot]. */
  async function notifications(): Promise<Status[]> {
    const page = await NotificationsPage();
    return elementsOf(page, StatusLine).map((p) => p.status as Status).filter((s) => s.kind !== "coming_soon");
  }
  /** Settings > Chat apps, rendered: the Telegram card's header status. */
  async function chatAppsTelegram(): Promise<Status | null> {
    const page = await ChatAppsPage({ searchParams: Promise.resolve({}) });
    const card = elementsOf(page, ChatAppCard).find((p) => (p.def as { slug?: string } | undefined)?.slug === "telegram");
    return (card?.status as Status | null) ?? null;
  }
  const routeJson = async (p: Promise<Response>) => (await (await p).json()) as Json;

  console.log("status-integrity:");

  // -- 1. Telegram: the workspace's team bot ----------------------------------------
  await check("Telegram team bot: Connections, Chat apps, Notifications, the department chip and the AI Team row say the same, in every workspace; a key-name heartbeat proves nothing", async () => {
    const rows: Array<{ name: string; setUp: boolean; rowSetUp: boolean }> = [];
    for (const [who, tenant, name] of [[USERS.cc, OASIS, "OASIS"], [USERS.clientA, CLIENT_A, "Client A"], [USERS.clientB, CLIENT_B, "Client B, nothing set up"]] as const) {
      await login(who);
      const hub = (await loadConnectorStatuses({ tenantId: tenant, userId: who.id })).telegram;
      const facts = await loadConnectorFacts({ tenantId: tenant, userId: who.id });
      const chip = connectors.resolveConnectorStatus(telegramDef, facts, Date.now()); // app/team/[dept]/page.tsx, pinned below
      const [notifWorkspace] = await notifications();
      agree(`Telegram team bot (${name})`, [
        ["Settings > Connections", kl(hub)],
        ["Settings > Chat apps", kl(await chatAppsTelegram())],
        ["Settings > Notifications (workspace bot)", kl(notifWorkspace)],
        ["Chief of Staff tab chip", kl(chip)],
        ["AI Team's reader (loadWorkspaceConnectorStatus)", kl(await loadWorkspaceConnectorStatus(tenant, "telegram"))],
      ]);
      rows.push({ name, setUp: connectors.connectionSetUp(hub), rowSetUp: connectors.connectionSetUp(await loadWorkspaceConnectorStatus(tenant, "telegram")) });
    }
    // The AI Team row, rendered, names Telegram exactly where the card says a team bot is set up.
    const markup = renderClient(rows.map((r) => ({ id: r.name, kind: "homes", props: { web: "ready", telegramSetUp: r.rowSetUp } })));
    for (const r of rows) {
      agree(`Telegram on the AI Team row (${r.name})`, [
        ["Settings > Connections", r.setUp ? "names Telegram" : "no Telegram line"],
        ["AI Team row (rendered)", /Telegram · alerts only/.test(text(markup[r.name])) ? "names Telegram" : "no Telegram line"],
      ]);
    }
    assert.deepEqual(rows.map((r) => r.setUp), [true, true, false]);
    // What each one is, in plain words: OASIS's own server values cannot say
    // "verified" (no check of them is recorded); Client A's passed its Test.
    await login(USERS.cc);
    const oasis = (await loadConnectorStatuses({ tenantId: OASIS, userId: USERS.cc.id })).telegram;
    assert.deepEqual([oasis.kind, oasis.label], ["configured", "Set up on OASIS's server · not verified"], "the env-key heartbeat must not read as verified");
    const client = (await loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id })).telegram;
    assert.deepEqual([client.kind, client.label], ["connected", "Connected · verified 5m ago"]);
  });

  await check("System health's integration card and the Connections card agree a key-name heartbeat is not a connection", async () => {
    const health = { id: "h1", profile_id: null, service: "telegram", status: "healthy", last_ping_at: at(20_000), last_error: null, metadata: { via: "env_key_present" }, updated_at: at(20_000) };
    const verdict = heartbeatVerdict({ builtIn: false, status: health.status, lastPingAt: health.last_ping_at, metadata: health.metadata, hasCredentials: false }, Date.now());
    const markup = renderClient([{ id: "dot", kind: "integration_dot", health, hasCredentials: false }]);
    await login(USERS.cc);
    const hub = (await loadConnectorStatuses({ tenantId: OASIS, userId: USERS.cc.id })).telegram;
    const proven = (yes: boolean) => (yes ? "proven connected" : "not proven");
    agree("Telegram, OASIS: proven or not", [
      ["Settings > Connections", proven(hub.kind === "connected")],
      ["System health card (verdict)", proven(verdict === "connected")],
      ["System health card (rendered)", proven(/\bConnected\b/.test(text(markup.dot)))],
    ]);
    assert.match(text(markup.dot), /Key on file/);
    assert.doesNotMatch(text(markup.dot), /last ping/, "no internal word on the card");
  });

  // -- 2. Telegram: your own bot ------------------------------------------------------
  await check("your own Telegram bot: Notifications and the bot's setup card (its API) say the same, and nothing promises alerts", async () => {
    await login(USERS.clientA);
    const [, yours] = await notifications();
    const api = await routeJson(personalTelegramRoute.GET());
    agree("Your own Telegram bot (Client A owner)", [
      ["Settings > Notifications (your own bot)", kl(yours)],
      ["Setup card (GET personal/telegram status)", kl(api.status as Status)],
    ]);
    assert.equal(yours.label, "Bot saved · chat not linked yet");
    await login(USERS.cc);
    const [workspace, ccYours] = await notifications();
    // CC's example, exactly: his workspace bot is set up, his own bot is not,
    // and the page says which is which instead of "Telegram is not set up".
    assert.equal(ccYours.label, "Not set up");
    assert.equal(workspace.label, "Set up on OASIS's server · not verified");
    const page = await NotificationsPage();
    const words = textOf(page);
    assert.match(words, /Workspace Telegram bot/);
    assert.match(words, /Your own Telegram bot/);
    assert.doesNotMatch(words, /sends your own alerts|get your alerts here/i);
  });

  // -- 3. Google: the shared mailbox ------------------------------------------------------
  await check("Google shared mailbox: Connections and the department chip read its Test, never a key-name heartbeat", async () => {
    await login(USERS.clientA);
    const hub = (await loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id }))["google-workspace"];
    const facts = await loadConnectorFacts({ tenantId: CLIENT_A, userId: USERS.clientA.id });
    const chip = connectors.resolveConnectorStatus(connectors.connectorBySlug("google-workspace")!, facts, Date.now());
    agree("Google shared mailbox (Client A)", [
      ["Settings > Connections", kl(hub)],
      ["Sales tab chip", kl(chip)],
    ]);
    // The heartbeat above is "healthy", the Test failed: the card says the Test.
    assert.deepEqual([hub.kind, hub.label], ["attention", "Could not sign in to Gmail"]);
    assert.doesNotMatch(hub.detail ?? "", /smtp_auth_failed|SMTP|GMAIL_/);
  });

  // -- 4. Google: your own account ---------------------------------------------------------
  await check("your own Google account: the Settings panel, the Connections card and Today's calendar line say the same", async () => {
    for (const [who, tenant, oasis, want] of [
      [USERS.clientA, CLIENT_A, false, "Wrong Google account"],
      [USERS.cc, OASIS, true, "Connected"],
    ] as const) {
      await login(who);
      const api = await routeJson(personalStatusRoute.GET());
      const gmail = (api.statuses as Json[]).find((s) => s.service === "gmail_oauth") as Json;
      const panel = (gmail.status as Status).label;
      const card = (await loadConnectorStatuses({ tenantId: tenant, userId: who.id }))["google-workspace"];
      const cardLine = /Your own Google account: ([^.]+)\./.exec(card.detail ?? "")?.[1] ?? "(none)";
      const today = await loadCalendarStatus(tenant, who.id, oasis);
      assert.ok(today.ok, "Today's calendar read");
      const markup = renderClient([
        {
          id: "today",
          kind: "schedule",
          props: { blocks: null, meetings: null, partial: false, calendar: today, connectHref: connectors.connectorHref("google-workspace") },
        },
      ]);
      const todayLine = today.value.personal.connected ? "Connected" : today.value.personal.label;
      agree(`Your own Google account (${tenant === OASIS ? "CC" : "Client A owner"})`, [
        ["Settings panel (GET personal/status)", panel],
        ["Settings > Connections, Google card", cardLine],
        ["Today, calendar line (loader)", todayLine],
        ["Today, calendar line (rendered)", /Google Calendar · (Connected|Wrong Google account|Reconnect once|Not connected)/.exec(text(markup.today))?.[1] ?? "(none)"],
      ]);
      assert.equal(panel, want);
      // The panel's flags come from the same state, so they cannot disagree with it.
      assert.equal(gmail.calendar_connected, want === "Connected");
      // Your own account never changes the WORKSPACE card's state.
      assert.notEqual(card.kind, "connected");
    }
  });

  // -- 5. Slack -------------------------------------------------------------------------
  await check("Slack: an expired connection reads the same on the Connections card, the department tab and the AI Team row", async () => {
    await login(USERS.clientA);
    const facts = await loadConnectorFacts({ tenantId: CLIENT_A, userId: USERS.clientA.id });
    const card = connectors.resolveConnectorStatus(slackDef, facts, Date.now());
    // The department tab (without the hub's facts) and the AI Team read the card
    // through the light loader; it must give the card's own answer.
    const light = await loadWorkspaceConnectorStatus(CLIENT_A, "slack");
    assert.equal(kl(light), kl(card), "the light loader is the card's own answer");
    const problem = connectors.connectionProblem(light);
    const presence = await loadSlackPresence(getTursoClient(), CLIENT_A);
    const home = slackHomeFor(presence, ["sales"]);
    assert.equal(home.kind, "mention_only", "the Slack status reader still sees a connection row");
    const markup = renderClient([
      { id: "dept", kind: "slack_line", props: { slack: home, problem, canManage: true } },
      { id: "row", kind: "homes", props: { web: "ready", slack: home, slackProblem: problem, telegramSetUp: true } },
    ]);
    agree("Slack (Client A)", [
      ["Settings > Connections", card.label],
      ["Sales tab, Slack line", /The Slack connection says: ([^.]+)\./.exec(text(markup.dept))?.[1] ?? "(none)"],
      ["AI Team row", /Slack · ([^·]+?)(?: Telegram|$)/.exec(text(markup.row))?.[1]?.trim() ?? "(none)"],
    ]);
    assert.equal(card.label, "Key no longer accepted");
    assert.doesNotMatch(text(markup.dept), /Answers @mentions|answers an @mention/);
  });

  // -- 6. The workspace counts ------------------------------------------------------------
  await check("the rail's dot and the Operations tile count the same workspace, whoever is looking", async () => {
    const facts = await loadConnectorFacts({ tenantId: CLIENT_A, userId: USERS.clientA.id });
    const noOne = { ...facts, personalGoogle: null };
    assert.deepEqual(connectors.connectionsHealth(facts, Date.now()), connectors.connectionsHealth(noOne, Date.now()));
    assert.match(read("app/layout.tsx"), /connectionsDot\(connectionsHealth\(facts, Date\.now\(\)\)\)/);
    assert.match(read("components/os/department/numbers.ts"), /connectionTile\(connectionsHealth\(facts, Date\.now\(\)\), /);
  });

  // -- 7. Every surface reads the one resolver (the wiring the checks above rely on) ----------
  await check("every status surface is wired to the one resolver, and no screen keeps a rule of its own", async () => {
    const dept = read("app/team/[dept]/page.tsx");
    assert.match(dept, /status: connectorFacts && def \? resolveConnectorStatus\(def, connectorFacts, nowMs\) : null/);
    assert.match(
      dept,
      /connectionProblem\(\s*connectorFacts\s*\? resolveConnectorStatus\(slackDef, connectorFacts, nowMs\)\s*: await loadWorkspaceConnectorStatus\(tenantId, "slack", nowMs\),?\s*\)/,
    );
    assert.match(dept, /const slackProblem =\s*binding\.kind === "agent" && slackPresence\.kind === "connected" && slackDef\s*\?/);
    assert.match(dept, /slack: binding\.kind === "agent" \? slackHomeFor\(slackPresence, \[dept\.key\]\) : null,\s*slackProblem,/);
    const roster = read("components/os/aiteam/roster.ts");
    assert.match(roster, /channels: \{ slackProblem: connectionProblem\(slackCard\), telegramSetUp: connectionSetUp\(telegramCard\) \}/);
    assert.match(roster, /slackPresence\.kind === "connected" \? loadWorkspaceConnectorStatus\(tenantId, "slack"\) : Promise\.resolve\(null\),\s*loadWorkspaceConnectorStatus\(tenantId, "telegram"\),/);
    // The light loader is the same resolver over the same reads as the hub.
    const facts = read("components/os/connections/connector-facts.ts");
    assert.match(facts, /export async function loadWorkspaceConnectorStatus[\s\S]*?return resolveConnectorStatus\(/);
    const row = read("components/os/aiteam/TeammateRow.tsx");
    assert.match(row, /\{telegramSetUp && <li/, "the Telegram line follows the Telegram card");
    assert.doesNotMatch(row, /^\s*<li className="text-fg-dim">Telegram · alerts only<\/li>/m, "never a fixed line");
    const agents = read("app/agents/page.tsx");
    assert.equal((agents.match(/telegramSetUp=\{team\.channels\.telegramSetUp\}/g) ?? []).length, 2);
    assert.match(agents, /slackProblem=\{team\.channels\.slackProblem\}/);
    // The drawer's key form has no verdict of its own: the Status above it is the card's.
    const form = read("components/os/connections/ServiceKeysForm.tsx");
    assert.doesNotMatch(form, /last_test_ok\s*===|lastOk|lastFail|twilioVerified/);
    assert.match(read("components/os/connections/ConnectorDrawer.tsx"), /<ServiceKeysForm [^>]*status=\{status\}/);
    // The personal panel prints the API's resolved words (StatusLine), nothing of its own.
    const panel = read("components/settings/PersonalIntegrationsPanel.tsx");
    assert.match(panel, /<StatusLine status=\{yourGoogle\} \/>/);
    assert.doesNotMatch(panel, /calendarConnected \?/);
    // Today reads the one personal reader, and its Connect link opens the Google panel, not Profile.
    const loaders = read("components/os/today/loaders.ts");
    assert.match(loaders, /readPersonalGoogleFact\(tenantId, userId\)/);
    assert.doesNotMatch(loaders, /operatorCalendarStatus/);
    assert.match(read("components/today/FounderToday.tsx"), /CALENDAR_CONNECT_HREF = connectorHref\("google-workspace"\)/);
    // No department chip names a Google product its card does not check.
    const { departmentProfile } = await import("../components/os/department/config");
    const { OS_DEPARTMENTS } = await import("../lib/os/departments");
    for (const d of OS_DEPARTMENTS) {
      for (const app of departmentProfile(d.key).connections) {
        if (app.connector === "google-workspace") assert.equal(app.label, "Google Workspace", `${d.key}: "${app.label}" is not what the card checks`);
      }
    }
    // The facts loader reads no heartbeat: a key name on OASIS's computer is not a check.
    assert.doesNotMatch(read("components/os/connections/connector-facts.ts"), /from\("integrations_health"\)/);
  });

  // -- 8. Plain words on the status surfaces -------------------------------------------------
  await check("the status surfaces show no API path, field name, env var or raw code", async () => {
    const jargon = /GMAIL_USER|GMAIL_APP_PASSWORD|TELEGRAM_BOT_TOKEN|smtp_auth_failed|telegram_http_|<digits>|<base64>|SMTP user|Personal Google OAuth|connect_failed:|disconnect_failed:|HTTP \$\{|\(\$\{loadError\}\)|\(\$\{(?:data\?\.)?error|\(\$\{reason|last ping/;
    for (const f of [
      "components/os/connections/ServiceKeysForm.tsx",
      "components/os/connections/ConnectionsHub.tsx",
      "components/os/connections/KeyConnectionPanel.tsx",
      "components/os/connections/TwilioWebhooksPanel.tsx",
      "components/os/connections/RequestConnector.tsx",
      "components/settings/PersonalIntegrationsPanel.tsx",
      "components/settings/TelegramConnectCard.tsx",
      "app/settings/notifications/page.tsx",
      "components/IntegrationDot.tsx",
    ]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
      assert.doesNotMatch(src, jargon, f);
    }
    const { TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS } = await import("../lib/tenant-integration-schemas");
    for (const s of TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS.filter((x) => ["gws", "telegram", "twilio"].includes(x.service))) {
      const copy = [s.description, ...s.fields.map((f) => `${f.label} ${f.hint ?? ""}`)].join(" ");
      assert.doesNotMatch(copy, /GMAIL_|TELEGRAM_|<digits>|SMTP|stays off until/, s.service);
    }
  });

  finish("status-integrity");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
