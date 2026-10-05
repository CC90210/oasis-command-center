/**
 * connections-everywhere.test.ts - every connection a workspace can see either
 * works or says plainly that it does not, and it is the SAME connection
 * wherever it is opened (W10a, CC 2026-10-01: "all of the connections have a
 * build interface thing, and part of onboarding").
 *
 *   - Not built: every app with no backend says why (in words the code
 *     supports, never OASIS's own vendor status), and its drawer files a
 *     request the OASIS team sees (a real ticket on OASIS's desk through the
 *     real POST /api/tickets), never a dead chip or a release date. Settings >
 *     Chat apps offers the same request for its not-built apps.
 *   - One drawer, three entry points: Settings > Connections, the workspace
 *     setup's connections step and Settings > AI brain render the same
 *     ConnectorDrawer, with statuses from one loader. An owner still in the
 *     setup saves and tests Twilio through the drawer's own API, and the setup
 *     and Settings then read the same verified state.
 *   - Slack, per CC: a client workspace connects its own Slack app; OASIS's own
 *     workspace uses the OASIS app. Each is shown its own path, with its state
 *     on this deployment.
 *
 * The drawer and hub are client components: they are rendered for real in a
 * child process (tests/connections-everywhere.render.ts) from the statuses the
 * server loader computed here, and asserted on their markup. Real routes and
 * pages on a local libSQL file (tests/_delivery-harness.ts); Twilio is mocked
 * at the fetch boundary and nothing reaches a provider.
 *
 * Run: node --conditions=react-server --import tsx tests/connections-everywhere.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { CLIENT_A, CLIENT_B, OASIS, USERS, check, finish, login, setupDatabase } from "./_delivery-harness";

// tsconfig.json sets jsx:"preserve", so tsx compiles page JSX with the classic
// runtime: the page modules need React in scope. next/link and next/image
// build the client router context the react-server condition lacks; the same
// stand-ins tests/f0-containment.test.ts uses.
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
// Settings > Chat apps mounts SettingsContent, which wraps cards in a CLASS
// error boundary (React.Component is not exported under react-server). A
// pass-through keeps its children in the tree; the same stand-in as
// tests/client-route-gating.test.ts.
{
  const p = join(__dirname, "..", "components/SafeBoundary.tsx");
  const exports = { SafeBoundary: ({ children }: { children?: unknown }) => children };
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
// resolveOwnedSlug swallows both of its reads and answers a failed one with
// null (lib/manifest/tenant-scope.ts). One check sets this to make it answer
// that null; every other caller gets the real function (as in
// tests/one-agent-roster.test.ts).
let ownedSlugReadFails = false;
{
  const p = require.resolve("../lib/manifest/tenant-scope");
  const real = require(p) as typeof import("../lib/manifest/tenant-scope");
  const exports = { __esModule: true, ...real, resolveOwnedSlug: async (tenantId: string | null) => (ownedSlugReadFails ? null : real.resolveOwnedSlug(tenantId)) };
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "connections-everywhere-field-encryption-passphrase";
process.env.PUBLIC_APP_URL = "https://oasisai.work";
// OASIS's Slack app and Twilio account are off unless a check turns them on.
const SLACK_ENV = {
  SLACK_CLIENT_ID: "1234.5678",
  SLACK_CLIENT_SECRET: "connections-everywhere-slack-client-secret",
  SLACK_SIGNING_SECRET: "connections-everywhere-slack-signing-secret",
  CONNECTIONS_OAUTH_STATE_SECRET: "connections-everywhere-state-secret-long-enough-01",
} as const;
for (const k of [...Object.keys(SLACK_ENV), "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "LIVE_SEND_TWILIO"]) delete process.env[k];

// Twilio, at the fetch boundary: one client account with one number that texts.
const twilioSid = (prefix: string, seed: string) => `${prefix}${createHash("md5").update(`${prefix}:${seed}`).digest("hex")}`;
const ACCT = { sid: twilioSid("AC", "client-b"), token: "client-b-auth-token-0000000000001", number: "+14165550188" };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname !== "api.twilio.com") throw new Error(`unexpected network call in test: ${href}`);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const [user, pass] = Buffer.from((new Headers(init?.headers).get("authorization") || "").replace(/^Basic /, ""), "base64").toString("utf8").split(":");
  if (user !== ACCT.sid || pass !== ACCT.token) return json(401, { code: 20003, message: "Authenticate" });
  if (url.pathname === `/2010-04-01/Accounts/${ACCT.sid}.json`) return json(200, { sid: ACCT.sid, friendly_name: "Client B Dental", status: "active", type: "Full" });
  if (url.pathname === `/2010-04-01/Accounts/${ACCT.sid}/IncomingPhoneNumbers.json`) {
    const want = url.searchParams.get("PhoneNumber");
    const numbers = [{ sid: twilioSid("PN", "b"), phone_number: ACCT.number, capabilities: { sms: true }, sms_url: "" }];
    return json(200, { incoming_phone_numbers: numbers.filter((n) => !want || n.phone_number === want) });
  }
  return json(404, { code: 20404, message: "not found" });
}) as typeof fetch;

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
type Json = Record<string, unknown>;
type Status = { kind: string; label: string; detail?: string; paths?: Array<{ title: string; body: string; state: string; requestable: boolean }> };

/** Render the drawer and hub for real (react-dom/server, in a child process without react-server). */
function renderClient(input: unknown): { markup: Record<string, string>; clicks: Array<{ slug: string; embedded: boolean; action: string }> } {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/connections-everywhere.render.ts"], {
    cwd: root,
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

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
    CREATE TABLE integrations_health (tenant_id TEXT, service TEXT, status TEXT, last_ping_at TEXT);
    CREATE TABLE user_integration_credentials (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, service TEXT,
      field_key TEXT, encrypted_value TEXT, last_tested_at TEXT, last_test_ok INTEGER, last_test_error TEXT, updated_at TEXT);
    CREATE TABLE tenant_manifests (tenant_id TEXT, slug TEXT, manifest TEXT);
    CREATE TABLE "channel_accounts" (
      "id" TEXT NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      "tenant_id" TEXT NOT NULL, "provider" TEXT NOT NULL, "owner_user_id" TEXT, "display_name" TEXT,
      "from_email" TEXT, "from_phone" TEXT, "texttorrent_act_as_email" TEXT,
      "twilio_messaging_service_sid" TEXT, "twilio_phone_sid" TEXT,
      "capabilities" TEXT NOT NULL DEFAULT '{}', "credential_ref" TEXT,
      "is_active" INTEGER NOT NULL DEFAULT 1, "is_dry_run" INTEGER NOT NULL DEFAULT 0,
      "metadata" TEXT NOT NULL DEFAULT '{}',
      "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY ("id"));
  `);
  await db.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));
  // Slack's channel map (Settings > Chat apps reads it once Slack is connected).
  await db.executeMultiple(read("database/turso/bravo__197_slack_jev.sql"));

  const { NextRequest } = await import("next/server");
  const connectors = await import("../lib/os/connectors");
  const { loadConnectorStatuses } = await import("../components/os/connections/connector-facts");
  const { connectorRequestTicket, CONNECTOR_REQUEST_ENDPOINT, RequestConnector } = await import("../components/os/connections/RequestConnector");
  const { ConnectorDrawerButton } = await import("../components/os/connections/ConnectorDrawerButton");
  const tickets = await import("../app/api/tickets/route");
  const keysRoute = await import("../app/api/integrations/keys/route");
  const keysTestRoute = await import("../app/api/integrations/keys/test/route");

  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`https://oasisai.work${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (p: Promise<Response>) => {
    const res = await p;
    return { status: res.status, body: (await res.json()) as Json };
  };
  const withSlackApp = async <T>(fn: () => Promise<T>): Promise<T> => {
    Object.assign(process.env, SLACK_ENV);
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(SLACK_ENV)) delete process.env[k];
    }
  };

  console.log("connections-everywhere:");

  // -- 1. Not built: a reason, and a request the OASIS team sees -------------------

  const notBuilt = connectors.CONNECTOR_CATALOG.filter((d) => !d.live);
  await check("every app with nothing behind it says why, in words that promise no date and claim nothing about OASIS's own accounts", () => {
    assert.deepEqual(
      notBuilt.map((d) => d.slug).sort(),
      ["cal-com", "calendly", "discord", "fathom", "fireflies", "gohighlevel", "meta", "microsoft-teams", "plaid", "quickbooks", "whatsapp", "xero", "zernio", "zoom"],
      "the not-built list changed: update the PR's list and this one together",
    );
    for (const def of notBuilt) {
      const reason = def.pendingNote ?? "";
      assert.ok(reason.trim().length > 20, `${def.slug}: no reason`);
      assert.doesNotMatch(reason, /phase \d|next release|later release|coming soon|soon|Q[1-4]|20\d\d/i, `${def.slug}: a date or era`);
      // W10a R4: what the code supports (nothing connects yet), never a claim
      // about OASIS's own vendor accounts, apps or approvals.
      assert.match(reason, /^Nothing in OASIS /, `${def.slug}: ${reason}`);
      assert.doesNotMatch(reason, /OASIS's own|OASIS's (Intuit|Xero|Plaid|Zoom|Meta|GoHighLevel)|partner access/i, `${def.slug}: ${reason}`);
      const status = connectors.resolveConnectorStatus(def, { keyRows: [], heartbeats: [], personalGoogleLinked: null, connections: [] }, Date.now());
      assert.deepEqual([status.kind, status.label, status.detail], ["coming_soon", "Not built yet", reason]);
    }
    assert.equal("plannedFor" in (notBuilt[0] as object), false, "the era label is gone from the catalog");
    console.log(notBuilt.map((d) => `        ${d.slug}: Not built yet - ${d.pendingNote}`).join("\n"));
  });

  await check("a not-built app's drawer draws the request button and no connect button; the hub lists every not-built app as one row of buttons", async () => {
    const statuses = await loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id });
    const { markup } = renderClient({
      cases: [
        { id: "zoom", kind: "drawer", slug: "zoom", status: statuses.zoom },
        { id: "hub", kind: "hub", statuses },
      ],
      clicks: [],
    });
    const zoom = text(markup.zoom);
    assert.match(zoom, /Ask OASIS for Zoom/, "the request button is drawn");
    assert.ok(zoom.includes(connectors.connectorBySlug("zoom")!.pendingNote!), "it says why");
    assert.doesNotMatch(zoom, /Tell OASIS|Set up in|Connect Zoom/, "no dead link and no connect button");
    const hub = markup.hub;
    const start = hub.indexOf('<section aria-labelledby="later-heading"');
    assert.ok(start >= 0, "the hub draws a not-built row");
    const laterRow = hub.slice(start, hub.indexOf("</section>", start));
    assert.match(text(laterRow), /^ ?Not built yet Not connectable today\./);
    for (const def of notBuilt) assert.ok(laterRow.includes(`>${def.name.replace(/&/g, "&amp;")}</button>`), `${def.slug}: a button in the not-built row`);
    assert.equal(CONNECTOR_REQUEST_ENDPOINT, "/api/tickets", "the request rides the desk's own ticket API");
  });

  const zoom = connectors.connectorBySlug("zoom")!;
  const body = connectorRequestTicket({ name: zoom.name, reason: zoom.pendingNote, from: "Settings > Connections" });
  let clientTicketId = "";
  await check("a client owner asks for Zoom: a ticket lands on OASIS's desk for that client, in words the client may read", async () => {
    assert.deepEqual([body.title, body.category, body.severity], ["Connection request: Zoom", "change_request", "low"]);
    assert.match(body.description, /^Requested from Settings > Connections: please make Zoom connectable for this workspace\.\nWhy it is not available today: Nothing in OASIS connects to Zoom yet\./);
    await login(USERS.clientA);
    const r = await call(tickets.POST(req("POST", CONNECTOR_REQUEST_ENDPOINT, body)));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    clientTicketId = String(r.body.id);
    const row = (await db.execute({ sql: "SELECT tenant_id, client_tenant_id, source, title, category, severity FROM support_tickets WHERE id = ?", args: [clientTicketId] })).rows[0];
    assert.deepEqual(
      [row.tenant_id, row.client_tenant_id, row.source, row.title, row.category, row.severity],
      [OASIS, CLIENT_A, "portal", "Connection request: Zoom", "change_request", "low"],
    );
    assert.match(String((r.body.ticket as Json).ticket_number), /^T-\d{4}$/, "the client is told its ticket number");
  });

  await check("OASIS's own workspace asks for an app too: an internal ticket on its own desk", async () => {
    await login(USERS.cc);
    const meta = connectors.connectorBySlug("meta")!;
    const r = await call(tickets.POST(req("POST", CONNECTOR_REQUEST_ENDPOINT, connectorRequestTicket({ name: meta.name, reason: meta.pendingNote, from: "the workspace setup" }))));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const row = (await db.execute({ sql: "SELECT tenant_id, source FROM support_tickets WHERE id = ?", args: [String(r.body.id)] })).rows[0];
    assert.deepEqual([row.tenant_id, row.source], [OASIS, "internal"]);
  });

  await check("the OASIS team sees both requests on its desk; another client sees neither", async () => {
    await login(USERS.cc);
    const desk = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    assert.equal(desk.status, 200, JSON.stringify(desk.body));
    const titles = (desk.body.tickets as Json[]).map((t) => String(t.title));
    assert.ok(titles.includes("Connection request: Zoom") && titles.includes("Connection request: Meta"), titles.join(" | "));
    await login(USERS.clientB);
    const other = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    assert.equal(other.status, 200);
    assert.equal((other.body.tickets as Json[]).some((t) => String(t.title).startsWith("Connection request")), false);
  });

  // W10a R5: Settings > Chat apps has no dead chip either.
  await check("Settings > Chat apps: each not-built app opens the shared drawer with its reason, and Telegram teammates and a client's own Slack app have the request button", async () => {
    const { default: ChatAppsPage } = await import("../app/settings/chat-apps/page");
    await login(USERS.clientA);
    const page = await ChatAppsPage({ searchParams: Promise.resolve({}) });
    const chips = elementsOf(page, ConnectorDrawerButton);
    assert.deepEqual(chips.map((c) => c.slug).sort(), ["discord", "microsoft-teams", "whatsapp"]);
    for (const c of chips) {
      const def = connectors.connectorBySlug(String(c.slug))!;
      const status = c.status as Status;
      assert.deepEqual([status.kind, status.label, status.detail], ["coming_soon", "Not built yet", def.pendingNote], def.slug);
      assert.equal(c.requestFrom, "Settings > Chat apps");
    }
    const asks = elementsOf(page, RequestConnector).map((p) => [p.name, p.from]);
    assert.deepEqual(asks, [
      ["Slack (Your own Slack app)", "Settings > Chat apps"],
      ["AI teammates in Telegram", "Settings > Chat apps"],
    ]);
    // OASIS's own workspace: its Slack path is the OASIS app, so no request for it.
    await login(USERS.cc);
    const oasisPage = await ChatAppsPage({ searchParams: Promise.resolve({}) });
    assert.deepEqual(elementsOf(oasisPage, RequestConnector).map((p) => p.name), ["AI teammates in Telegram"]);
  });

  // W4a D1, on this page: a workspace slug that could not be read is "could
  // not check", never a channel map in which no department can answer.
  await check("Settings > Chat apps: a roster that could not be read says so and asks for a reload, never offers a map no department can answer", async () => {
    const at = new Date().toISOString();
    await db.execute({
      sql: `INSERT INTO tenant_connections (id, tenant_id, provider, auth_kind, external_account_id, external_account_label, status, connected_at, created_at, updated_at)
            VALUES ('conn-slack-client-a', ?, 'slack', 'app_install', 'T0CLIENTA', 'Client A Slack', 'connected', ?, ?, ?)`,
      args: [CLIENT_A, at, at, at],
    });
    const { default: ChatAppsPage } = await import("../app/settings/chat-apps/page");
    const { SlackChannelMap } = await import("../components/settings/SlackChannelMap");
    const unread = "OASIS couldn't check which departments can answer in Slack just now. Reload in a minute.";
    try {
      await login(USERS.clientA);
      // A connected Slack on a deployment where installs work: the page reaches the channel map.
      const page = () => withSlackApp(() => ChatAppsPage({ searchParams: Promise.resolve({}) }));
      ownedSlugReadFails = true;
      const failed = await page();
      assert.equal(elementsOf(failed, SlackChannelMap).length, 0, "no channel map on a roster nobody could read");
      assert.ok(textOf(failed).includes(unread), "it says so");
      ownedSlugReadFails = false;
      const readable = await page();
      assert.equal(elementsOf(readable, SlackChannelMap).length, 1, "with the roster readable, the map is offered");
      assert.ok(!textOf(readable).includes(unread));
    } finally {
      ownedSlugReadFails = false;
      await db.execute({ sql: "DELETE FROM tenant_connections WHERE id = 'conn-slack-client-a'", args: [] });
    }
  });

  // -- 2. One drawer, three entry points, one loader --------------------------------

  // W10a R7: through the drawer's own API, as an owner still in the setup.
  await check("an owner still in the setup saves and tests Twilio through the drawer's API; the setup and Settings then read the same verified card", async () => {
    await db.execute({ sql: "UPDATE user_profiles SET onboarding_completed_at = NULL WHERE auth_user_id = ?", args: [USERS.clientB.id] });
    await login(USERS.clientB);
    for (const [field_key, value] of [["account_sid", ACCT.sid], ["auth_token", ACCT.token], ["from_number", ACCT.number]]) {
      const saved = await call(keysRoute.POST(req("POST", "/api/integrations/keys", { service: "twilio", field_key, value })));
      assert.equal(saved.status, 200, `${field_key}: ${JSON.stringify(saved.body)}`);
    }
    const tested = await call(keysTestRoute.POST(req("POST", "/api/integrations/keys/test", { service: "twilio" })));
    assert.equal(tested.status, 200, JSON.stringify(tested.body));
    assert.equal(tested.body.state, "connected", JSON.stringify(tested.body));
    const { default: OnboardingWizardPage } = await import("../app/onboarding/wizard/page");
    const el = (await OnboardingWizardPage()) as { props: { connections?: { statuses: Record<string, Status>; supportHref: string | null } } };
    const fromWizard = el.props.connections?.statuses;
    assert.ok(fromWizard, "the wizard is handed the workspace's statuses");
    const fromSettings = await loadConnectorStatuses({ tenantId: CLIENT_B, userId: USERS.clientB.id });
    const shape = (s: Record<string, Status>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.kind}:${v.label}`]));
    assert.deepEqual(shape(fromWizard!), shape(fromSettings));
    assert.equal(fromWizard!.twilio.kind, "connected", JSON.stringify(fromWizard!.twilio));
    assert.match(fromWizard!.twilio.label, /^Connected · verified /);
    assert.equal(fromWizard!.zoom.label, "Not built yet");
    // And it is not another workspace's: Client A has nothing saved.
    assert.equal((await loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id })).twilio.kind, "not_connected");
  });

  await check("inside the setup the drawer keeps the owner there: a Settings-page app says where it is set up, with no link out; the same drawer in Settings links", async () => {
    // OASIS's own workspace with OASIS's Slack app set up: a live card whose
    // setup is on another Settings page (Chat apps).
    const statuses = await withSlackApp(() => loadConnectorStatuses({ tenantId: OASIS, userId: USERS.cc.id }));
    assert.equal(statuses.slack.kind, "not_connected", JSON.stringify(statuses.slack));
    const { markup, clicks } = renderClient({
      cases: [
        // The hub itself, as the setup renders it, opened on Slack: proves the
        // hub hands `embedded` to its drawer.
        { id: "setup", kind: "hub", statuses, embedded: true, initialApp: "slack" },
        { id: "settings", kind: "hub", statuses, embedded: false, initialApp: "slack" },
      ],
      clicks: [
        { slug: "slack", embedded: true },
        { slug: "slack", embedded: false },
        { slug: "twilio", embedded: true },
        { slug: "constant-contact", embedded: true },
        { slug: "zoom", embedded: false },
      ],
    });
    const drawerOf = (html: string) => html.slice(html.indexOf('role="dialog"'));
    const setup = drawerOf(markup.setup);
    assert.match(text(setup), /Slack is set up in Settings \(Install Slack and map channels under Chat apps\) once your workspace setup is finished\./);
    assert.match(text(setup), /Install Slack and map channels under Chat apps, once your workspace setup is finished\./);
    assert.doesNotMatch(setup, /href="\/settings\/chat-apps"/, "no way out of the setup");
    const settings = drawerOf(markup.settings);
    assert.match(settings, /href="\/settings\/chat-apps"/, "in Settings the same drawer links to Chat apps");
    assert.match(text(settings), /Set up in Chat apps/);
    assert.deepEqual(
      clicks.map((c) => `${c.slug}:${c.embedded}:${c.action}`),
      ["slack:true:drawer", "slack:false:navigate", "twilio:true:drawer", "constant-contact:true:popup", "zoom:false:drawer"],
    );
    // Supplement: the setup step hands the hub `embedded` and the statuses.
    const wizard = read("components/onboarding/OnboardingWizardClient.tsx");
    assert.match(wizard, /const STEP_ORDER: Step\[\] = \[[^\]]*"jev", "connections", "brand"/);
    const step = wizard.slice(wizard.indexOf('step === "connections"'), wizard.indexOf('step === "brand"'));
    assert.match(step, /<ConnectionsHub[\s\S]*statuses=\{connections\.statuses\}[\s\S]*embedded/);
  });

  await check("AI brain opens the same drawer in place, with the status from the same loader", () => {
    const jev = read("components/settings/JevCard.tsx");
    assert.match(jev, /<ConnectorDrawerButton\s+slug="jev"/);
    assert.doesNotMatch(jev, /settings\/connections\?app=jev/, "no more sending the owner to another page");
    const button = read("components/os/connections/ConnectorDrawerButton.tsx");
    assert.match(button, /<ConnectorDrawer\s/);
    assert.match(button, /const close = useCallback\(\(\) => setOpen\(false\), \[\]\);/, "a stable close keeps the sheet's focus handling from re-running");
    assert.match(read("app/settings/ai/page.tsx"), /await loadConnectorStatuses\(\{ tenantId, userId, nowMs \}\)/);
    assert.match(read("app/settings/connections/page.tsx"), /await loadConnectorStatuses\(\{ tenantId: viewer\.tenantId, userId: viewer\.userId \}\)/);
  });

  // -- 3. Slack: each workspace is shown its own path (W10a R1) ---------------------

  await check("Slack, per CC: a client is shown its own Slack app (not built yet, with the request); OASIS the OASIS app, whose state follows this deployment", async () => {
    const client = (await loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id })).slack;
    assert.deepEqual([client.kind, client.label, client.detail], ["coming_soon", "Not built yet", "Connecting Slack with your own Slack app is not built yet."]);
    assert.deepEqual(client.paths?.map((p) => [p.title, p.state, p.requestable]), [["Your own Slack app", "Not built yet", true]]);
    assert.match(client.paths![0].body, /client ID, client secret and signing secret/);
    // Without OASIS's Slack app on the deployment, OASIS's path is not "Available".
    const oasisOff = (await loadConnectorStatuses({ tenantId: OASIS, userId: USERS.cc.id })).slack;
    assert.deepEqual([oasisOff.kind, oasisOff.label], ["coming_soon", "Slack app not configured yet"]);
    assert.deepEqual(oasisOff.paths?.map((p) => [p.title, p.state, p.requestable]), [["The OASIS Slack app", "Not set up on this deployment", false]]);
    const oasisOn = (await withSlackApp(() => loadConnectorStatuses({ tenantId: OASIS, userId: USERS.cc.id }))).slack;
    assert.deepEqual([oasisOn.kind, oasisOn.paths?.[0].state], ["not_connected", "Available"]);
    // A client's own path does not change with OASIS's app.
    const clientOn = (await withSlackApp(() => loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id }))).slack;
    assert.deepEqual([clientOn.kind, clientOn.label], ["coming_soon", "Not built yet"]);

    const { markup } = renderClient({
      cases: [
        { id: "client", kind: "drawer", slug: "slack", status: client },
        { id: "oasisOff", kind: "drawer", slug: "slack", status: oasisOff },
        { id: "oasisOn", kind: "drawer", slug: "slack", status: oasisOn },
      ],
      clicks: [],
    });
    const c = text(markup.client);
    assert.match(c, /How your workspace connects Slack Your own Slack app Not built yet/);
    assert.match(c, /Ask OASIS for Slack \(Your own Slack app\)/);
    assert.doesNotMatch(c, /The OASIS Slack app|OASIS's own workspace|Available|Set up in Chat apps/, "a client is never told OASIS's model, or offered a dead connect");
    const off = text(markup.oasisOff);
    assert.match(off, /The OASIS Slack app Not set up on this deployment/);
    assert.doesNotMatch(off, /Available|Your own Slack app|Ask OASIS for Slack/);
    assert.match(text(markup.oasisOn), /The OASIS Slack app Available/);
  });

  // -- 4. Every live app's drawer links its provider's own docs ---------------------

  await check("every app set up with keys in its drawer links the provider's own docs (Twilio, Stripe, Google, Telegram, Jev), opening in a new tab", async () => {
    for (const slug of ["twilio", "stripe", "google-workspace", "telegram", "jev"]) {
      const docs = connectors.connectorBySlug(slug)!.docs;
      assert.ok(docs && /^https:\/\//.test(docs.href) && docs.label.trim(), `${slug}: no docs link`);
    }
    const statuses = await loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id });
    const { markup } = renderClient({ cases: [{ id: "telegram", kind: "drawer", slug: "telegram", status: statuses.telegram }], clicks: [] });
    assert.match(markup.telegram, /<a href="https:\/\/core\.telegram\.org\/bots\/tutorial" target="_blank" rel="noopener noreferrer"[^>]*>Telegram&#x27;s guide to creating a bot<\/a>/);
  });

  globalThis.fetch = realFetch;
  finish("connections-everywhere");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
