/**
 * Settings › Connections, Chat apps, Add-ons and the Settings section gates.
 *
 * WHY THIS EXISTS. The Connections hub is where a client decides whether OASIS
 * is plugged into their business, so every failure that matters is a lie told
 * in the friendliest possible font:
 *   - a card that says "Connected" when nothing proved it (a saved key nobody
 *     tested, a stale heartbeat, a coming-soon app handed a green fact);
 *   - a failed lookup rendered as "Not connected", which sends an owner off to
 *     re-enter keys that were fine;
 *   - an invented logo for a brand Simple Icons removed at the owner's request;
 *   - an operator-only Settings section (Devices hands out a shell on a paired
 *     machine) reachable, or even listed, for a client.
 * Each is invisible until someone screenshots it. So the resolver is fed
 * deliberately hostile facts here — every field present, every test passing,
 * every heartbeat healthy — and must still refuse to go green where it has no
 * right to.
 *
 * Run: node --conditions=react-server --import tsx tests/os-connectors.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTOR_CATALOG,
  CONNECTOR_CATEGORIES,
  connectionsDot,
  connectionsHealth,
  connectorBySlug,
  connectorHref,
  connectorMatches,
  glyphColor,
  contrastOnTile,
  resolveConnectorStatus,
  type ConnectionFact,
  type ConnectorDef,
  type ConnectorFacts,
  type HeartbeatFact,
  type KeyRowFact,
} from "../lib/os/connectors";
import { OS_DEPARTMENTS } from "../lib/os/departments";
import { findIntegrationSchema, findTenantManuallyEditableIntegrationSchema } from "../lib/tenant-integration-schemas";
import { providerById } from "../lib/connections/registry";
import {
  SETTINGS_SECTIONS,
  legacyAnchorTargets,
  maySeeSettingsSection,
  visibleSettingsSections,
  type SettingsAccess,
  type SettingsSectionKey,
} from "../components/settings/settings-sections";
import { OASIS_ADDONS } from "../components/settings/addons";
import { PROVIDER_REGISTRY } from "../lib/providers";
import { watchPopup } from "../components/os/connections/popup-watch";
import { FOCUSABLE_SELECTOR, trapTab } from "../components/os/connections/focus-trap";

const root = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const NOW = Date.parse("2026-09-28T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

// ─── 1. Catalog shape and coverage ──────────────────────────────────────────

const slugs = CONNECTOR_CATALOG.map((c) => c.slug);
assert.equal(new Set(slugs).size, slugs.length, "connector slugs must be unique");

// The apps the plan promises in the hub (pillar 4). Dropping one is a product
// decision, not a refactor, so it fails here.
const REQUIRED = [
  "google-workspace", "slack", "telegram", "meta", "stripe", "quickbooks", "xero", "plaid",
  "gohighlevel", "zoom", "calendly", "cal-com", "fathom", "fireflies", "twilio",
  "constant-contact", "zernio", "discord", "microsoft-teams", "whatsapp",
];
for (const slug of REQUIRED) assert.ok(connectorBySlug(slug), `the hub is missing ${slug}`);

const categoryKeys = new Set(CONNECTOR_CATEGORIES.map((c) => c.key));
const departmentKeys = new Set(OS_DEPARTMENTS.map((d) => d.key));
for (const def of CONNECTOR_CATALOG) {
  assert.ok(categoryKeys.has(def.category), `${def.slug}: unknown category ${def.category}`);
  assert.ok(def.departments.length > 0, `${def.slug}: no department uses it`);
  for (const d of def.departments) assert.ok(departmentKeys.has(d), `${def.slug}: unknown department ${d}`);
  assert.ok(def.reads.length > 0 && def.does.length > 0, `${def.slug}: must say what OASIS reads and does`);
  assert.ok(def.summary.trim(), `${def.slug}: empty summary`);
}

// ─── 2. Every card has a real logo or an explicit monogram ──────────────────

const SIMPLE_ICON = /^<svg role="img" viewBox="0 0 24 24" xmlns="http:\/\/www\.w3\.org\/2000\/svg"><title>[^<]+<\/title><path d="[^"]+"\/><\/svg>\s*$/;
const referenced = new Set<string>();

function assertSimpleIcon(file: string, owner: string) {
  const rel = `public/connectors/${file}`;
  assert.ok(existsSync(join(root, rel)), `${owner}: ${rel} does not exist`);
  // Copied unmodified from Simple Icons: one path, one title, the 24px box. A
  // hand-drawn or edited "logo" does not have this shape.
  assert.match(read(rel), SIMPLE_ICON, `${owner}: ${rel} is not an unmodified Simple Icons SVG`);
  referenced.add(file);
}

for (const def of CONNECTOR_CATALOG) {
  if (def.icon.kind === "svg") {
    assertSimpleIcon(def.icon.file, def.slug);
    assert.match(def.brandColor ?? "", /^#[0-9A-F]{6}$/i, `${def.slug}: an SVG logo needs its brand colour`);
  } else {
    assert.equal(def.icon.kind, "monogram");
    assert.match(def.icon.letters, /^[A-Za-z]{1,3}$/, `${def.slug}: monogram letters must be 1-3 letters`);
    assert.ok(def.icon.reason.trim(), `${def.slug}: a monogram must say why there is no logo`);
    assert.equal(def.brandColor, null, `${def.slug}: a monogram tile is neutral — no brand colour`);
  }
  for (const sub of def.includes ?? []) {
    assertSimpleIcon(sub.file, `${def.slug} › ${sub.name}`);
    assert.match(sub.color, /^#[0-9A-F]{6}$/i);
  }
}

// Brands Simple Icons removed at the owner's request, and the one it only has
// under a different company's name. Any of these as "svg" is an invented logo.
for (const slug of ["slack", "microsoft-teams", "twilio", "fathom"]) {
  assert.equal(connectorBySlug(slug)!.icon.kind, "monogram", `${slug} must render a monogram, never a logo`);
}

// No orphan logos: every SVG shipped under public/connectors is in the catalog.
const shipped = readdirSync(join(root, "public/connectors")).filter((f) => f.endsWith(".svg"));
for (const f of shipped) assert.ok(referenced.has(f), `public/connectors/${f} is shipped but no connector uses it`);

// Every glyph stays visible on the dark tile (WCAG 3:1 for graphics).
for (const def of CONNECTOR_CATALOG) {
  if (def.icon.kind === "svg") {
    assert.ok(contrastOnTile(glyphColor(def)) >= 3, `${def.slug}: glyph colour vanishes on the tile`);
  }
}
assert.notEqual(glyphColor(connectorBySlug("cal-com")!), "#292929", "Cal.com's near-black must fall back to fg");

// ─── 3. Statuses come only from real sources ────────────────────────────────

// The live set is pinned. Making a connector live means pointing it at a store
// that exists — this list changes in the same commit, on purpose.
const LIVE = ["stripe", "google-workspace", "telegram", "twilio", "constant-contact", "slack", "jev"].sort();
assert.deepEqual(
  CONNECTOR_CATALOG.filter((c) => c.live).map((c) => c.slug).sort(),
  LIVE,
  "the set of connectors with a status source changed",
);

const factsSource = read("components/os/connections/connector-facts.ts");
for (const def of CONNECTOR_CATALOG) {
  if (!def.live) {
    // The reason it cannot connect, never an era or a date (S5-F01, W10a).
    assert.ok(def.pendingNote?.trim(), `${def.slug}: a not-built connector must say why`);
    continue;
  }
  const src = def.live.source;
  if (src.kind === "tenant_connection") {
    // A Connections-framework card reads tenant_connections, which the facts
    // loader must actually load; the provider must be LIVE in the registry
    // (tests/os-connections.test.ts pins the registry side).
    // Live, or live only where OASIS's own app is configured (Slack's
    // liveWhenEnv); such a card says "app not configured yet" elsewhere.
    const provider = providerById(src.provider);
    assert.ok(
      provider && (provider.availability === "live" || (provider.liveWhenEnv?.length ?? 0) > 0),
      `${def.slug}: "${src.provider}" is not a live provider`,
    );
    assert.equal(src.provider, def.slug, `${def.slug}: a framework card's provider id is its slug`);
    assert.match(factsSource, /listActiveConnections\(/, `${def.slug}: connections are never loaded`);
    continue;
  }
  // Every field a status reads is a real field of a real integration schema —
  // the same store Credentials writes and listTenantIntegrationStatus reads.
  const schema = findIntegrationSchema(src.service);
  assert.ok(schema, `${def.slug}: status service "${src.service}" is not an integration the store knows`);
  const fields = new Set(schema!.fields.map((f) => f.key));
  const named = [
    ...src.requireAll,
    ...(src.kind === "tenant_keys" ? [...(src.requireAny ?? []), ...(src.credentialAlternatives ?? []).flat()] : []),
  ];
  for (const f of named) assert.ok(fields.has(f), `${def.slug}: "${src.service}.${f}" is not a stored field`);
  if (src.kind === "workspace_heartbeat") {
    assert.match(factsSource, new RegExp(`"${src.service}"`), `${def.slug}: heartbeats for ${src.service} are never loaded`);
  }
}

// Hostile facts: every service anyone could name, every field present, every
// test passing a minute ago, every heartbeat healthy a minute ago.
const everyService = new Set<string>();
for (const def of CONNECTOR_CATALOG) {
  everyService.add(def.slug).add(def.slug.replace(/-/g, "_"));
  if (def.live) everyService.add(def.live.source.kind === "tenant_connection" ? def.live.source.provider : def.live.source.service);
}
const allFields = ["secret_key", "app_password", "from_address", "bot_token", "chat_id", "account_sid", "auth_token",
  "from_number", "messaging_service_sid", "access_token", "refresh_token", "api_key", "token", "restricted_key"];
const GREEN: ConnectorFacts = {
  keyRows: [...everyService].flatMap((service) =>
    allFields.map((field_key): KeyRowFact => ({
      service, field_key, has_value: true, last_tested_at: iso(MIN), last_test_ok: true,
    })),
  ),
  heartbeats: [...everyService].map((service): HeartbeatFact => ({ service, status: "healthy", last_ping_at: iso(MIN) })),
  personalGoogleLinked: true,
  // A connected, freshly verified framework connection for EVERY slug — a
  // coming-soon card handed one must still say coming soon.
  connections: [...everyService].map((provider): ConnectionFact => ({
    provider, status: "connected", account_id: "acct_hostile", account_label: "Hostile", environment: "live",
    last_health_at: iso(MIN), last_health_verdict: "healthy", last_health_code: null, last_health_detail: null,
  })),
};

for (const def of CONNECTOR_CATALOG) {
  const s = resolveConnectorStatus(def, GREEN, NOW);
  if (!def.live) {
    assert.equal(s.kind, "coming_soon", `${def.slug} has no status source but resolved to "${s.kind}"`);
    assert.doesNotMatch(s.label, /connected/i);
    // The state, in the same words Chat apps uses for the same apps; "Coming
    // soon" / "Planned" promised a release nobody had scheduled (S5-F01, W3A-R4).
    assert.equal(s.label, "Not built yet", `${def.slug}: a card with nothing behind it says so`);
    assert.equal(s.detail, def.pendingNote, `${def.slug}: the drawer says why it is not built`);
  }
}
assert.match(read("app/settings/chat-apps/page.tsx"), /label: "Not built yet"/, "Chat apps and Connections say it the same way");
// No card's copy promises a release: the Stripe card said the Finance sync
// "ships (next release)".
for (const def of CONNECTOR_CATALOG) {
  const copy = [def.summary, ...def.reads, ...def.does, def.pendingNote ?? ""].join(" ");
  assert.doesNotMatch(copy, /next release|later release|coming soon|Phase 2|ships? (in|next)/i, `${def.slug}: a release promise on the card`);
}
assert.equal(resolveConnectorStatus(connectorBySlug("stripe")!, GREEN, NOW).kind, "connected");
assert.equal(resolveConnectorStatus(connectorBySlug("google-workspace")!, GREEN, NOW).kind, "connected");

// Every lookup failed: "status unavailable" for every live card — never
// "not connected", never "connected".
const FAILED: ConnectorFacts = { keyRows: null, heartbeats: null, personalGoogleLinked: null, connections: null };
for (const def of CONNECTOR_CATALOG) {
  const s = resolveConnectorStatus(def, FAILED, NOW);
  assert.equal(s.kind, def.live ? "unknown" : "coming_soon", `${def.slug}: a failed lookup resolved to "${s.kind}"`);
}
// Only the heartbeat read failing is still unknown for a heartbeat-backed card.
assert.equal(
  resolveConnectorStatus(connectorBySlug("telegram")!, { ...GREEN, heartbeats: null }, NOW).kind,
  "unknown",
);

// Only the connections read failing is still unknown for a framework card.
assert.equal(resolveConnectorStatus(connectorBySlug("stripe")!, { ...GREEN, connections: null }, NOW).kind, "unknown");

// Nothing saved at all: honestly not connected.
const EMPTY: ConnectorFacts = { keyRows: [], heartbeats: [], personalGoogleLinked: false, connections: [] };
for (const slug of LIVE) {
  assert.equal(resolveConnectorStatus(connectorBySlug(slug)!, EMPTY, NOW).kind, "not_connected", slug);
}

const keyRow = (service: string, field_key: string, over: Partial<KeyRowFact> = {}): KeyRowFact => ({
  service, field_key, has_value: true, last_tested_at: null, last_test_ok: null, ...over,
});
const stripe = connectorBySlug("stripe")!;
const twilio = connectorBySlug("twilio")!;
const twilioKeys = (over: Partial<KeyRowFact> = {}) => [
  keyRow("twilio", "account_sid", over),
  keyRow("twilio", "auth_token", over),
  keyRow("twilio", "from_number", over),
];

// ─── The workspace at a glance (W2a, S5-F03) ────────────────────────────────
// The rail's Connections dot and the Operations tile count the SAME statuses
// the cards show. Green only when every app set up is proven; nothing set up,
// an unverified app or a failed read is no dot; any app needing the owner is
// amber whatever else is true.
{
  assert.deepEqual(connectionsHealth(EMPTY, NOW), { setUp: 0, attention: 0, connected: 0, unknown: 0 });
  assert.equal(connectionsDot(connectionsHealth(EMPTY, NOW)), null, "nothing set up is not 'all healthy'");
  const failedHealth = connectionsHealth(FAILED, NOW);
  assert.deepEqual([failedHealth.setUp, failedHealth.unknown], [0, LIVE.length], "every built card unknown when every read failed");
  assert.equal(connectionsDot(failedHealth), null, "a failed read draws no dot");
  const gwsOnly: ConnectorFacts = { ...EMPTY, heartbeats: [{ service: "gws", status: "healthy", last_ping_at: iso(MIN) }] };
  assert.deepEqual(connectionsHealth(gwsOnly, NOW), { setUp: 1, attention: 0, connected: 1, unknown: 0 });
  assert.equal(connectionsDot(connectionsHealth(gwsOnly, NOW)), "ok", "one proven app and nothing else set up: green");
  const unverified: ConnectorFacts = { ...gwsOnly, keyRows: twilioKeys() };
  assert.deepEqual(connectionsHealth(unverified, NOW), { setUp: 2, attention: 0, connected: 1, unknown: 0 });
  assert.equal(connectionsDot(connectionsHealth(unverified, NOW)), null, "a saved key nobody tested is not proven, so no green");
  const expired: ConnectorFacts = {
    ...gwsOnly,
    connections: [{
      provider: "stripe", status: "expired", account_id: null, account_label: null, environment: "live",
      last_health_at: iso(MIN), last_health_verdict: "down", last_health_code: "key_rejected", last_health_detail: null,
    }],
  };
  assert.deepEqual(connectionsHealth(expired, NOW), { setUp: 2, attention: 1, connected: 1, unknown: 0 });
  assert.equal(connectionsDot(connectionsHealth(expired, NOW)), "attention", "a key Stripe stopped accepting is amber");
  assert.equal(connectionsDot({ setUp: 1, attention: 1, connected: 0, unknown: 4 }), "attention", "a known problem outranks an unread one");
  // Hostile facts cannot light an app that has no status source.
  assert.equal(connectionsHealth(GREEN, NOW).setUp, LIVE.length, "only built apps are counted");
  // The rail reads it (app/layout.tsx), nothing hard-codes a status.
  const layout = read("app/layout.tsx");
  assert.match(layout, /connectionsDot\(connectionsHealth\(facts, Date\.now\(\)\)\)/);
  assert.match(layout, /connectionsStatus=\{showConnections \? connectionsMeasured : null\}/);
  // Chrome never holds a page: the facts read answers inside its own budget
  // or the rail draws no dot (lib/os/deadline.ts, W0).
  assert.match(layout, /withDeadline\(\s*loadConnectorFacts\(\{[^}]*\}\)\.then\([\s\S]*?\),\s*RAIL_CONNECTIONS_DEADLINE_MS,\s*"layout\.connections",\s*\)/);
  assert.match(layout, /const RAIL_CONNECTIONS_DEADLINE_MS = 2_500;/);
  // The Operations tile counts the same statuses, as the WORKSPACE's number:
  // the viewer's own Google link is left out (W2A-R5), and the tile links an
  // owner or admin to the hub.
  assert.match(
    read("components/os/department/numbers.ts"),
    /connectionTile\(connectionsHealth\(\{ \.\.\.facts, personalGoogleLinked: null \}, Date\.now\(\)\), viewer\.surface\.persona === "founder"\)/,
  );
  // Why it is left out: the same workspace, one person with their own Google
  // linked, would count an app set up that the workspace has not set up.
  const linked: ConnectorFacts = { ...EMPTY, personalGoogleLinked: true };
  assert.equal(connectionsHealth(linked, NOW).setUp, 1, "precondition: a personal link counts as set up on the hub");
  assert.equal(connectionsHealth({ ...linked, personalGoogleLinked: null }, NOW).setUp, 0);
}

// A saved key nobody tested is set up, not connected.
assert.equal(resolveConnectorStatus(twilio, { ...EMPTY, keyRows: twilioKeys() }, NOW).kind, "configured");
// A failed test is attention, even beside an older passing one.
assert.equal(
  resolveConnectorStatus(twilio, {
    ...EMPTY,
    keyRows: [
      ...twilioKeys({ last_test_ok: true, last_tested_at: iso(HOUR) }),
      keyRow("twilio", "messaging_service_sid", { last_test_ok: false, last_tested_at: iso(MIN) }),
    ],
  }, NOW).kind,
  "attention",
);
// Stripe is a framework card now: a legacy secret key in the Credentials store
// (OASIS's checkout-link key) never makes it connected — or even "set up".
assert.equal(
  resolveConnectorStatus(stripe, {
    ...EMPTY,
    keyRows: [keyRow("stripe", "secret_key", { last_test_ok: true, last_tested_at: iso(MIN) })],
  }, NOW).kind,
  "not_connected",
);
// Twilio needs a number OR a messaging service: sid + token alone are incomplete.
assert.equal(
  resolveConnectorStatus(twilio, {
    ...EMPTY,
    keyRows: [
      keyRow("twilio", "account_sid", { last_test_ok: true, last_tested_at: iso(MIN) }),
      keyRow("twilio", "auth_token", { last_test_ok: true, last_tested_at: iso(MIN) }),
    ],
  }, NOW).kind,
  "attention",
);
// A presence-only "test" can never prove a connection.
const unverifiable: ConnectorDef = {
  ...stripe,
  slug: "presence-only",
  live: {
    source: { kind: "tenant_keys", service: "late", requireAll: ["api_key"], verifiable: false },
    connect: stripe.live!.connect,
  },
};
assert.equal(
  resolveConnectorStatus(unverifiable, {
    ...EMPTY,
    keyRows: [keyRow("late", "api_key", { last_test_ok: true, last_tested_at: iso(MIN) })],
  }, NOW).kind,
  "configured",
);
// OAuth tokens in the store are authorised, not re-checked — never green.
assert.equal(
  resolveConnectorStatus(connectorBySlug("constant-contact")!, {
    ...EMPTY,
    keyRows: [
      keyRow("constant_contact", "access_token", { last_test_ok: true, last_tested_at: iso(MIN) }),
      keyRow("constant_contact", "refresh_token"),
    ],
  }, NOW).kind,
  "configured",
);

const gws = connectorBySlug("google-workspace")!;
const gwsKeys = [keyRow("gws", "app_password"), keyRow("gws", "from_address")];
// A healthy heartbeat older than 24h proves nothing about today.
assert.notEqual(
  resolveConnectorStatus(gws, {
    ...EMPTY,
    keyRows: gwsKeys,
    heartbeats: [{ service: "gws", status: "healthy", last_ping_at: iso(25 * HOUR) }],
  }, NOW).kind,
  "connected",
);
// Nor does one stamped in the future.
assert.notEqual(
  resolveConnectorStatus(gws, {
    ...EMPTY,
    keyRows: gwsKeys,
    heartbeats: [{ service: "gws", status: "healthy", last_ping_at: iso(-HOUR) }],
  }, NOW).kind,
  "connected",
);
// A fresh failing heartbeat is attention.
assert.equal(
  resolveConnectorStatus(gws, {
    ...EMPTY,
    keyRows: gwsKeys,
    heartbeats: [{ service: "gws", status: "down", last_ping_at: iso(MIN) }],
  }, NOW).kind,
  "attention",
);
// Your own Google link is real, but it never makes the WORKSPACE connected.
assert.notEqual(
  resolveConnectorStatus(gws, { keyRows: [], heartbeats: [], personalGoogleLinked: true, connections: [] }, NOW).kind,
  "connected",
);
// A heartbeat for one service never lights up another.
assert.notEqual(
  resolveConnectorStatus(connectorBySlug("telegram")!, {
    keyRows: [keyRow("telegram", "bot_token"), keyRow("telegram", "chat_id")],
    heartbeats: [{ service: "gws", status: "healthy", last_ping_at: iso(MIN) }],
    personalGoogleLinked: true,
    connections: [],
  }, NOW).kind,
  "connected",
);

// The UI cannot upgrade a status: no component under the hub or Settings
// writes a "connected" kind of its own, the hub reads a missing status as
// unknown, and the pages compute statuses only through the resolver.
const uiFiles = [
  ...readdirSync(join(root, "components/os/connections")).map((f) => `components/os/connections/${f}`),
  "components/settings/ChatAppCard.tsx",
  "components/settings/AddonCard.tsx",
  "components/settings/JevCard.tsx",
  "app/settings/ai/page.tsx",
  "app/settings/connections/page.tsx",
  "app/settings/chat-apps/page.tsx",
  "app/settings/notifications/page.tsx",
  "app/settings/billing/page.tsx",
].filter((f) => /\.tsx?$/.test(f));
for (const f of uiFiles) {
  assert.doesNotMatch(read(f), /kind:\s*"connected"/, `${f} constructs a "connected" status itself`);
}
const hub = read("components/os/connections/ConnectionsHub.tsx");
assert.match(hub, /status \?\? \{ kind: "unknown"/, "the hub must read a missing status as unknown");
// One loader for every entry point (Connections, the workspace setup, AI
// brain), and it computes each status through the resolver.
assert.match(read("app/settings/connections/page.tsx"), /loadConnectorStatuses\(/);
assert.match(read("components/os/connections/connector-facts.ts"), /resolveConnectorStatus\(def, facts, now\)/);
assert.match(read("app/settings/chat-apps/page.tsx"), /resolveConnectorStatus\(telegram/);
// Slack is a Connections-framework card set up under Chat apps, and it says
// "app not configured yet" wherever OASIS's Slack app is not on the deployment.
const slackDef = connectorBySlug("slack")!;
assert.deepEqual(slackDef.live?.source, { kind: "tenant_connection", provider: "slack" });
assert.deepEqual(slackDef.live?.connect, { kind: "link", href: "/settings/chat-apps", label: "Set up in Chat apps" });
assert.equal(
  resolveConnectorStatus(slackDef, { keyRows: [], heartbeats: [], personalGoogleLinked: null, connections: [], appNotConfigured: ["slack"] }, Date.now()).label,
  "Slack app not configured yet",
);
assert.doesNotMatch(JSON.stringify(slackDef.does), /never used for training/i, "a claim nothing enforces is not on the card");
// Telegram teammates are a state ("not built yet"), never an era word or a
// release promise (S2-11, S4-12, S5-F07's register).
assert.match(read("app/settings/chat-apps/page.tsx"), /Telegram teammates are not built yet/);
assert.doesNotMatch(read("app/settings/chat-apps/page.tsx"), /Phase 2|Coming soon/);
assert.match(read("app/settings/notifications/page.tsx"), /Choosing what notifies you is not built yet/);
assert.doesNotMatch(read("app/settings/notifications/page.tsx"), /Phase 2|arrives with/);
assert.match(read("components/os/aiteam/TeammateRow.tsx"), /Telegram · alerts only/);
assert.doesNotMatch(read("components/os/aiteam/TeammateRow.tsx"), /Phase 2/);
// The connector drawer's coming-soon note is the state too, not a date:
// "scheduled for the next release" promised a release nobody had scheduled.
assert.match(read("components/os/connections/ConnectorDrawer.tsx"), /Nothing is built for it yet, so it cannot be connected\./);
assert.doesNotMatch(read("components/os/connections/ConnectorDrawer.tsx"), /next release|later release|=== "Phase 2"/);
// The Google Gemini card never nudges an owner toward the free AI Studio tier,
// which may train on a client's data (S2-09): paid tier only, and it says why.
const gemini = PROVIDER_REGISTRY.find((p) => p.value === "google")!;
assert.equal(gemini.tagline, "Paid tier only. The free AI Studio tier may train on your data.");
assert.match(gemini.hint, /Paid tier only/);
assert.doesNotMatch(`${gemini.tagline} ${gemini.hint}`, /free tier available/i);

// Search: by name, keyword and category label; nonsense matches nothing.
assert.ok(connectorMatches(connectorBySlug("gohighlevel")!, "ghl"));
assert.ok(connectorMatches(connectorBySlug("meta")!, "instagram"));
assert.ok(connectorMatches(stripe, "money"));
assert.equal(CONNECTOR_CATALOG.filter((d) => connectorMatches(d, "zzqx-no-such-app")).length, 0);

// ─── 4. Add-ons: facts, icons, and no fake purchase ─────────────────────────

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
assert.deepEqual(OASIS_ADDONS.map((a) => a.slug).sort(), ["oasis-vision", "oasis-whispr"]);
for (const a of OASIS_ADDONS) {
  const rel = join("public", a.icon);
  assert.ok(existsSync(join(root, rel)), `${a.name}: icon ${rel} missing`);
  assert.ok(readFileSync(join(root, rel)).subarray(0, 8).equals(PNG), `${a.name}: icon is not a PNG`);
  assert.ok(a.facts.length > 0 && a.privacy.trim(), `${a.name}: must say what it does and what leaves the machine`);
  assert.doesNotMatch(
    [a.summary, ...a.facts, a.privacy].join(" "),
    /\$|price|download|buy|free trial/i,
    `${a.name}: nothing sells or ships an add-on in Phase 1`,
  );
  // OASIS's own workspace links the app's install guide in OASIS's own repo.
  assert.match(a.installGuide.href, /^https:\/\/github\.com\/CC90210\//, `${a.name}: install guide is OASIS's own repo`);
  assert.ok(a.installGuide.label.trim(), `${a.name}: install guide needs a label`);
}
// Whispr's macOS port merged on 2026-09-26 and its README now carries a macOS
// section, so the card says both (S1-A1; decision 24).
assert.match(OASIS_ADDONS.find((a) => a.slug === "oasis-whispr")!.platforms, /^macOS and Windows$/);
assert.match(OASIS_ADDONS.find((a) => a.slug === "oasis-whispr")!.summary, /Mac and Windows/);
const billing = read("app/settings/billing/page.tsx");
assert.match(billing, /SUPPORT_FORM_PATH/, "the add-on request must go through the existing support form");
assert.match(billing, /viewer\.access\.oasisWorkspace/, "the page must branch on whose workspace it is (S1-A2)");
assert.match(read("components/settings/AddonCard.tsx"), /Ask OASIS to add this/);
assert.match(read("components/settings/AddonCard.tsx"), /Built by OASIS/);
assert.doesNotMatch(billing + read("components/settings/AddonCard.tsx"), /\$\s?\d|mailto:/);

// ─── 5. Settings sections: operator-only stays operator-only ────────────────

const access = (over: Partial<SettingsAccess> = {}): SettingsAccess => ({
  canManage: false, isOperator: false, canSeeTeamPerformance: false, oasisWorkspace: false, ...over,
});
const keys = (a: SettingsAccess) => visibleSettingsSections(a).map((s) => s.key);

// A rep on a client workspace: only their own sections.
assert.deepEqual(keys(access()), ["profile", "connections", "chat-apps", "notifications", "privacy"]);
// An owner with every flag but operator: everything except Devices.
const owner = access({ canManage: true, canSeeTeamPerformance: true, oasisWorkspace: true });
assert.ok(!keys(owner).includes("devices"), "Devices is operator-only, not owner/admin");
assert.ok(keys(owner).includes("billing") && keys(owner).includes("audit-log"));
// The operator gets Devices.
assert.ok(keys({ ...owner, isOperator: true }).includes("devices"));
// Operator status alone does not grant workspace management.
assert.ok(!keys(access({ isOperator: true })).includes("ai"), "operator without a manage seat must not see AI brain");
// A sales manager on a CLIENT workspace has no Team section (their scorecard is OASIS-only).
assert.ok(!keys(access({ canSeeTeamPerformance: true })).includes("team"));
assert.ok(keys(access({ canSeeTeamPerformance: true, oasisWorkspace: true })).includes("team"));
// An unknown key is refused, not waved through.
assert.equal(maySeeSettingsSection(owner, "no-such-section" as SettingsSectionKey), false);
// Old anchors never forward anyone to a section they cannot open.
assert.ok(!("devices" in legacyAnchorTargets(owner)));
assert.equal(legacyAnchorTargets({ ...owner, isOperator: true }).devices, "/settings/devices");
assert.deepEqual(Object.keys(legacyAnchorTargets(access())), ["integrations"]);

// Every section link lands on a page, and every page gates on its own key, so
// a link can never sit over a 404 and a hidden section can never be reached.
// Profile and the audit log keep their own (older, equivalent) gates.
const OWN_GATE: Partial<Record<SettingsSectionKey, RegExp>> = {
  profile: /canSeePersonalSettings\) notFound\(\)/,
  "audit-log": /canSeeTeamPerformance\) redirect\("\/settings"\)/,
};
for (const s of SETTINGS_SECTIONS) {
  const rel = `app${s.href}/page.tsx`;
  assert.ok(existsSync(join(root, rel)), `${s.label} links to ${s.href}, but ${rel} does not exist`);
  const body = read(rel);
  const gate = OWN_GATE[s.key] ?? new RegExp(`requireSettingsSection\\("${s.key}"\\)`);
  assert.match(body, gate, `${rel} does not gate on the "${s.key}" section`);
}
assert.match(read("app/settings/layout.tsx"), /visibleSettingsSections\(viewer\.access\)/);

// The cards themselves keep their operator gates, from the VERIFIED check.
const content = read("components/settings/SettingsContent.tsx");
assert.match(content, /show\("devices"\) && isOperator &&/, "the Devices card must stay operator-only");
assert.match(content, /show\("ai"\) && isOperator &&[\s\S]{0,80}LocalCliProvidersCard/, "local CLI must stay operator-only");
assert.match(content, /isVerifiedOperator\(\)/);
assert.doesNotMatch(content, /isOperatorEmail\(/, "operator status must not come from the session email alone");
// The workspace-level hub is owners/admins only; everyone else sees their own Google.
assert.match(read("app/settings/connections/page.tsx"), /if \(!viewer\.access\.canManage\) \{[\s\S]{0,400}<SettingsContent section="connections"/);

// ─── 6. The hub's popup watch and the drawer's focus trap (CodeRabbit #468) ─

{
  // A fake window: the listeners and timers the watch registers stay visible.
  const fakeWindow = () => {
    const listeners = new Set<(e: MessageEvent) => void>();
    const timers = new Map<number, () => void>();
    let next = 1;
    return {
      listeners,
      timers,
      env: {
        origin: "https://app.test",
        addMessageListener: (fn: (e: MessageEvent) => void) => void listeners.add(fn),
        removeMessageListener: (fn: (e: MessageEvent) => void) => void listeners.delete(fn),
        setInterval: (fn: () => void) => {
          const id = next++;
          timers.set(id, fn);
          return id;
        },
        clearInterval: (id: unknown) => void timers.delete(id as number),
      },
      // `from` is the window that sent the message (MessageEvent.source).
      post: (origin: string, data: unknown, from?: unknown) => {
        for (const fn of [...listeners]) fn({ origin, data, source: from ?? null } as unknown as MessageEvent);
      },
      tick: () => {
        for (const fn of [...timers.values()]) fn();
      },
    };
  };

  // Reports back: onDone once, and nothing is left registered.
  {
    const w = fakeWindow();
    const done: unknown[] = [];
    const popup = { closed: false };
    const otherWindow = { closed: false };
    watchPopup({ popup, source: "constant_contact", env: w.env, onDone: (r) => done.push(r) });
    assert.equal(w.listeners.size, 1);
    assert.equal(w.timers.size, 1);
    w.post("https://evil.test", { source: "constant_contact", status: "connected" }, popup);
    w.post("https://app.test", { source: "other", status: "connected" }, popup);
    w.post("https://app.test", null, popup);
    // Same origin, same connector source, but ANOTHER window (a second connect
    // attempt, a stale tab): it must not finish this popup (CodeRabbit #469).
    w.post("https://app.test", { source: "constant_contact", status: "connected" }, otherWindow);
    w.post("https://app.test", { source: "constant_contact", status: "connected" });
    assert.deepEqual(done, [], "another origin, source or window is not this popup's answer");
    w.post("https://app.test", { source: "constant_contact", status: "error", reason: "admin_only" }, popup);
    w.post("https://app.test", { source: "constant_contact", status: "connected" }, popup);
    assert.deepEqual(done, [{ status: "error", reason: "admin_only" }], "one answer, once");
    assert.equal(w.listeners.size + w.timers.size, 0, "the listener and the poll are gone after the answer");
  }
  // Closed by hand: the poll finishes it with no status.
  {
    const w = fakeWindow();
    const popup = { closed: false };
    const done: unknown[] = [];
    watchPopup({ popup, source: "constant_contact", env: w.env, onDone: (r) => done.push(r) });
    w.tick();
    assert.deepEqual(done, []);
    popup.closed = true;
    w.tick();
    assert.deepEqual(done, [{}]);
    assert.equal(w.listeners.size + w.timers.size, 0);
  }
  // Stopped (the hub unmounted, or another popup started): nothing outlives it,
  // and a late answer never reaches router.refresh or setState.
  {
    const w = fakeWindow();
    const popup = { closed: false };
    const done: unknown[] = [];
    const stop = watchPopup({ popup, source: "constant_contact", env: w.env, onDone: (r) => done.push(r) });
    stop();
    stop();
    assert.equal(w.listeners.size + w.timers.size, 0, "stop removes the listener and clears the poll");
    popup.closed = true;
    w.tick();
    w.post("https://app.test", { source: "constant_contact", status: "connected" }, popup);
    assert.deepEqual(done, [], "no callback after stop");
  }
  const hub = read("components/os/connections/ConnectionsHub.tsx");
  assert.doesNotMatch(hub, /window\.addEventListener\("message", (?!fn\))/, "the hub registers message listeners only through watchPopup");
  assert.match(hub, /useEffect\(\s*\(\) => \(\) => \{\s*stopWatch\.current\?\.\(\);/, "the watch is stopped on unmount");
  assert.match(hub, /\(def: ConnectorDef, href: string, source: string\) => \{\s*stopWatch\.current\?\.\(\);/, "a new popup stops the previous watch first");

  // Focus trap: Tab wraps inside the sheet; focus outside is pulled back in.
  const stops = ["close", "tell-oasis", "connect"];
  assert.deepEqual(trapTab(stops, "connect", false, true), { prevent: true, focus: "close" }, "Tab from the last control wraps to the first");
  assert.deepEqual(trapTab(stops, "close", true, true), { prevent: true, focus: "connect" }, "Shift+Tab from the first wraps to the last");
  assert.deepEqual(trapTab(stops, "close", false, true), { prevent: false, focus: null }, "Tab between inside controls is the browser's");
  assert.deepEqual(trapTab(stops, "tell-oasis", true, true), { prevent: false, focus: null });
  assert.deepEqual(trapTab(stops, "page-link", false, false), { prevent: true, focus: "close" }, "focus behind the backdrop comes back in");
  assert.deepEqual(trapTab(stops, null, true, false), { prevent: true, focus: "connect" });
  assert.deepEqual(trapTab(["close"], "close", false, true), { prevent: true, focus: "close" }, "one control: focus stays on it");
  assert.deepEqual(trapTab([], null, false, false), { prevent: true, focus: null }, "nothing to focus: Tab still cannot leave");
  assert.match(FOCUSABLE_SELECTOR, /a\[href\]/, "the drawer's Tell OASIS link is a Tab stop");
  const drawer = read("components/os/connections/ConnectorDrawer.tsx");
  assert.match(drawer, /trapTab\(/, "the drawer's keydown handler traps Tab");
  assert.match(drawer, /e\.key === "Escape"/, "Escape still closes it");
  assert.match(drawer, /returnFocus\.current\?\.focus\?\.\(\)/, "focus still goes back to the opener on close");
  assert.match(drawer, /ref=\{panelRef\}\s+role="dialog"\s+aria-modal="true"/, "the trap is scoped to the aria-modal sheet");
}

// ─── 7. One card per app (CC, 2026-09-29) ───────────────────────────────────
// The page used to list every app a second time under "Keys and accounts".
// Now each app's card is the one place it is set up, custom keys are one card,
// and apps that are not built are a single compact row, not cards that do nothing.

{
  // An owner's page renders the hub and nothing that lists the apps again.
  const page = read("app/settings/connections/page.tsx");
  const ownerStart = page.indexOf("const statuses = await loadConnectorStatuses");
  assert.ok(ownerStart > 0, "the owner's path loads every status through the shared loader");
  const ownerPath = page.slice(ownerStart);
  assert.match(ownerPath, /<ConnectionsHub/);
  assert.doesNotMatch(ownerPath, /SettingsContent|IntegrationKeysPanel|Keys and accounts/, "an owner's page lists the apps once");
  assert.equal(existsSync(join(root, "components/settings/IntegrationKeysPanel.tsx")), false, "the page-wide key list is gone");
  const content = read("components/settings/SettingsContent.tsx");
  assert.doesNotMatch(content, /title="Credentials"|title="Integration health"|<IntegrationKeysPanel|<CustomCredentialsVault/);

  // Every app whose keys are saved in the store has exactly one card, and that
  // card's service is one an owner may actually edit.
  const keyCards = CONNECTOR_CATALOG.flatMap((d) => (d.live?.connect.kind === "keys" ? [[d.slug, d.live.connect.service] as const] : []));
  assert.ok(keyCards.length >= 3, "Google, Twilio and the Telegram team bot are set up in their drawers");
  const services = keyCards.map(([, s]) => s);
  assert.equal(new Set(services).size, services.length, "one card per saved-key service");
  for (const [slug, service] of keyCards) {
    assert.ok(findTenantManuallyEditableIntegrationSchema(service), `${slug}: "${service}" is not an owner-editable key set`);
  }
  // The legacy anchor that sent people to the removed list is gone everywhere.
  assert.doesNotMatch(read("lib/os/connectors.ts"), /CREDENTIALS_ANCHOR|keysLink/);
  assert.doesNotMatch(read("app/settings/chat-apps/page.tsx"), /CREDENTIALS_ANCHOR/);
  assert.match(read("app/settings/chat-apps/page.tsx"), /connectorHref\("telegram"\)/);
  assert.equal(connectorHref("telegram"), "/settings/connections?app=telegram");

  // The drawer sets the app up in place; the hub opens it for keys and ?app=.
  const drawer = read("components/os/connections/ConnectorDrawer.tsx");
  assert.match(drawer, /<ServiceKeysForm/);
  assert.match(drawer, /def\.yourAccount === "google" && personalGoogle[\s\S]{0,400}<PersonalIntegrationsPanel/);
  assert.match(hub, /action\.kind === "key_form" \|\| action\.kind === "keys"\) return openDrawer\(def\.slug\)/);
  assert.match(hub, /initialApp === "custom-keys"[\s\S]{0,120}connectorBySlug\(initialApp\)\) openDrawer\(initialApp\)/);
  // Google's sign-in comes back to its drawer, not to a removed anchor.
  assert.match(read("app/api/auth/google-oauth/callback/route.ts"), /SETTINGS_RETURN_PATH = "\/settings\/connections\?app=google-workspace"/);
  assert.match(page, /one\(sp\.gmail_oauth\) \? "google-workspace"/);

  // A closed sheet stays closed on refresh: both close paths clear ?app= and
  // Google's sign-in result params (CodeRabbit #477).
  assert.match(hub, /const closeDrawer = useCallback\(\(\) => \{\s*setDrawerOpen\(false\);\s*clearDeepLink\(\);/);
  assert.match(hub, /const closeCustom = useCallback\(\(\) => \{\s*setCustomOpen\(false\);\s*clearDeepLink\(\);/);
  assert.match(hub, /DEEP_LINK_PARAMS = \["app", "gmail_oauth", "reason", "gmail", "mailbox"\]/);
  // Remove always re-reads, even when a later DELETE fails part-way.
  assert.match(read("components/os/connections/ServiceKeysForm.tsx"), /\} finally \{[\s\S]{0,300}await reload\(\);\s*onChanged\(\);/);

  // Custom keys are one card, opened in the same accessible sheet.
  assert.match(hub, /<CustomCredentialsVault \/>/);
  assert.match(hub, /<DrawerSheet[\s\S]{0,200}CUSTOM_KEYS\.title/);

  // Apps that are not built are one compact row, never full cards that do nothing.
  assert.match(hub, /const later = visible\.filter\(\(def\) => !def\.live\)/);
  assert.match(hub, /const available = visible\.filter\(\(def\) => def\.live && !isYourTool/);
  assert.doesNotMatch(hub, /rest\.filter\(\(d\) => d\.category === cat\.key\)/, "coming-soon apps no longer fill the category grids");
}

console.log(
  `os-connectors: OK — ${CONNECTOR_CATALOG.length} connectors (${LIVE.length} live, ` +
    `${CONNECTOR_CATALOG.filter((c) => c.icon.kind === "monogram").length} monograms), ` +
    `${shipped.length} logos, ${OASIS_ADDONS.length} add-ons, ${SETTINGS_SECTIONS.length} sections gated`,
);
