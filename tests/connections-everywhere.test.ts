/**
 * connections-everywhere.test.ts - every connection a workspace can see either
 * works or says plainly that it does not, and it is the SAME connection
 * wherever it is opened (W10a, CC 2026-10-01: "all of the connections have a
 * build interface thing, and part of onboarding").
 *
 *   - Not built: every app with no backend says why, and its drawer files a
 *     request the OASIS team sees (a real ticket on OASIS's desk through the
 *     real POST /api/tickets), never a dead chip or a release date.
 *   - One drawer, three entry points: Settings > Connections, the workspace
 *     setup's connections step and Settings > AI brain render the same
 *     ConnectorDrawer, with statuses from one loader, so an app set up in the
 *     setup reads the same in Settings (driven through the real wizard page).
 *   - Slack: the drawer states both ways a workspace could connect it, and
 *     which one exists.
 *
 * Real routes and pages on a local libSQL file (tests/_delivery-harness.ts);
 * nothing reaches a provider.
 *
 * Run: node --conditions=react-server --import tsx tests/connections-everywhere.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
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
process.env.BRAVO_FIELD_ENCRYPTION_KEY = "connections-everywhere-field-encryption-passphrase";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
type Json = Record<string, unknown>;

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
  `);
  await db.executeMultiple(read("database/turso/bravo__187_os_connections.sql"));

  const { NextRequest } = await import("next/server");
  const connectors = await import("../lib/os/connectors");
  const { loadConnectorStatuses } = await import("../components/os/connections/connector-facts");
  const { connectorRequestTicket, CONNECTOR_REQUEST_ENDPOINT } = await import("../components/os/connections/RequestConnector");
  const tickets = await import("../app/api/tickets/route");
  const store = await import("../lib/tenant-integration-store");

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

  console.log("connections-everywhere:");

  // -- 1. Not built: a reason, and a request the OASIS team sees -------------------

  const notBuilt = connectors.CONNECTOR_CATALOG.filter((d) => !d.live);
  await check("every app with nothing behind it says why, in words that promise no date", () => {
    assert.deepEqual(
      notBuilt.map((d) => d.slug).sort(),
      ["cal-com", "calendly", "discord", "fathom", "fireflies", "gohighlevel", "meta", "microsoft-teams", "plaid", "quickbooks", "whatsapp", "xero", "zernio", "zoom"],
      "the not-built list changed: update the PR's list and this one together",
    );
    for (const def of notBuilt) {
      const reason = def.pendingNote ?? "";
      assert.ok(reason.trim().length > 20, `${def.slug}: no reason`);
      assert.doesNotMatch(reason, /phase \d|next release|later release|coming soon|soon|Q[1-4]|20\d\d/i, `${def.slug}: a date or era`);
      const status = connectors.resolveConnectorStatus(def, { keyRows: [], heartbeats: [], personalGoogleLinked: null, connections: [] }, Date.now());
      assert.deepEqual([status.kind, status.label, status.detail], ["coming_soon", "Not built yet", reason]);
    }
    assert.equal("plannedFor" in (notBuilt[0] as object), false, "the era label is gone from the catalog");
    console.log(notBuilt.map((d) => `        ${d.slug}: Not built yet - ${d.pendingNote}`).join("\n"));
  });

  await check("a not-built app's drawer files the request (no dead chip), and the hub lists them as one 'Not built yet' row", () => {
    const drawer = read("components/os/connections/ConnectorDrawer.tsx");
    const footerStart = drawer.indexOf("const footer =");
    const footer = drawer.slice(footerStart, drawer.indexOf("return (", footerStart));
    assert.match(footer, /<RequestConnector key=\{def\.slug\} name=\{def\.name\} reason=\{def\.pendingNote \?\? null\} from=\{requestFrom\} \/>/);
    assert.doesNotMatch(drawer, /Tell OASIS|supportHref/, "the support-form link that left the page is gone");
    const hub = read("components/os/connections/ConnectionsHub.tsx");
    assert.match(hub, />\s*Not built yet\s*</);
    assert.doesNotMatch(hub, /Coming later/);
    assert.equal(CONNECTOR_REQUEST_ENDPOINT, "/api/tickets", "the request rides the desk's own ticket API");
  });

  const zoom = connectors.connectorBySlug("zoom")!;
  const body = connectorRequestTicket({ name: zoom.name, reason: zoom.pendingNote, from: "Settings > Connections" });
  let clientTicketId = "";
  await check("a client owner asks for Zoom: a ticket lands on OASIS's desk for that client, in words the client may read", async () => {
    assert.deepEqual([body.title, body.category, body.severity], ["Connection request: Zoom", "change_request", "low"]);
    assert.match(body.description, /^Requested from Settings > Connections: please make Zoom connectable for this workspace\.\nWhy it is not available today: Needs OASIS's own Zoom app/);
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

  // -- 2. One drawer, three entry points, one loader --------------------------------

  await check("the workspace setup hands the wizard the very statuses Settings > Connections reads (one loader, one store)", async () => {
    // Client B's owner is still in the setup, with Twilio half saved.
    await db.execute({ sql: "UPDATE user_profiles SET onboarding_completed_at = NULL WHERE auth_user_id = ?", args: [USERS.clientB.id] });
    assert.ok((await store.setTenantIntegrationValue({ tenantId: CLIENT_B, service: "twilio", fieldKey: "account_sid", value: `AC${"0".repeat(31)}b` })).ok);
    await login(USERS.clientB);
    const { default: OnboardingWizardPage } = await import("../app/onboarding/wizard/page");
    const el = (await OnboardingWizardPage()) as { props: { connections?: { statuses: Record<string, { kind: string; label: string }>; supportHref: string | null } } };
    const fromWizard = el.props.connections?.statuses;
    assert.ok(fromWizard, "the wizard is handed the workspace's statuses");
    const fromSettings = await loadConnectorStatuses({ tenantId: CLIENT_B, userId: USERS.clientB.id });
    const shape = (s: Record<string, { kind: string; label: string }>) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, `${v.kind}:${v.label}`]));
    assert.deepEqual(shape(fromWizard!), shape(fromSettings));
    assert.equal(fromWizard!.twilio.kind, "attention", "the half-saved Twilio reads the same in both places");
    assert.equal(fromWizard!.zoom.label, "Not built yet");
    // And it is not another workspace's: Client A has nothing saved.
    assert.equal((await loadConnectorStatuses({ tenantId: CLIENT_A, userId: USERS.clientA.id })).twilio.kind, "not_connected");
  });

  await check("the connections step is the Connections hub itself (embedded): same cards, same drawer, nothing leaves the setup", () => {
    const wizard = read("components/onboarding/OnboardingWizardClient.tsx");
    assert.match(wizard, /const STEP_ORDER: Step\[\] = \[[^\]]*"jev", "connections", "brand"/);
    const step = wizard.slice(wizard.indexOf('step === "connections"'), wizard.indexOf('step === "brand"'));
    assert.match(step, /<ConnectionsHub[\s\S]*statuses=\{connections\.statuses\}[\s\S]*personalGoogle=\{false\}[\s\S]*embedded/);
    const hub = read("components/os/connections/ConnectionsHub.tsx");
    assert.match(hub, /if \(embedded && action\.kind === "link"\) return openDrawer\(def\.slug\);/, "a Settings-page app opens its drawer, never navigates out");
    assert.match(hub, /<ConnectorDrawer[\s\S]{0,400}embedded=\{embedded\}/);
    const drawer = read("components/os/connections/ConnectorDrawer.tsx");
    assert.match(drawer, /def\.seeAlso &&\s*\(embedded \?/, "inside the setup, a Settings link is text, not a way out");
    const page = read("app/onboarding/wizard/page.tsx");
    assert.match(page, /await loadConnectorStatuses\(\{ tenantId: access\.profile\.tenant_id, userId: user\.id \}\)/);
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

  // -- 3. Slack: both paths, stated -------------------------------------------------

  await check("the Slack drawer states both paths and offers a request for the one that is not built", () => {
    const slack = connectors.connectorBySlug("slack")!;
    assert.deepEqual(slack.paths?.map((p) => p.built), [true, false]);
    const drawer = read("components/os/connections/ConnectorDrawer.tsx");
    const block = drawer.slice(drawer.indexOf("def.paths && def.paths.length > 0"));
    assert.match(block, /\{!p\.built && \([\s\S]{0,200}<RequestConnector/);
    assert.match(block, /p\.built \? "Available" : "Not built yet"/);
  });

  // -- 4. Every live app's drawer links its provider's own docs ---------------------

  await check("every app set up with keys in its drawer links the provider's own docs (Twilio, Stripe, Google, Telegram, Jev)", () => {
    for (const slug of ["twilio", "stripe", "google-workspace", "telegram", "jev"]) {
      const docs = connectors.connectorBySlug(slug)!.docs;
      assert.ok(docs && /^https:\/\//.test(docs.href) && docs.label.trim(), `${slug}: no docs link`);
    }
    assert.match(read("components/os/connections/ConnectorDrawer.tsx"), /def\.docs && \([\s\S]{0,200}target="_blank" rel="noopener noreferrer"/);
  });

  finish("connections-everywhere");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
