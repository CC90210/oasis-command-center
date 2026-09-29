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
  connectorBySlug,
  connectorMatches,
  glyphColor,
  contrastOnTile,
  resolveConnectorStatus,
  type ConnectorDef,
  type ConnectorFacts,
  type HeartbeatFact,
  type KeyRowFact,
} from "../lib/os/connectors";
import { OS_DEPARTMENTS } from "../lib/os/departments";
import { findIntegrationSchema } from "../lib/tenant-integration-schemas";
import {
  SETTINGS_SECTIONS,
  legacyAnchorTargets,
  maySeeSettingsSection,
  visibleSettingsSections,
  type SettingsAccess,
  type SettingsSectionKey,
} from "../components/settings/settings-sections";
import { OASIS_ADDONS } from "../components/settings/addons";
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
const LIVE = ["stripe", "google-workspace", "telegram", "twilio", "constant-contact"].sort();
assert.deepEqual(
  CONNECTOR_CATALOG.filter((c) => c.live).map((c) => c.slug).sort(),
  LIVE,
  "the set of connectors with a status source changed",
);

const factsSource = read("components/os/connections/connector-facts.ts");
for (const def of CONNECTOR_CATALOG) {
  if (!def.live) {
    assert.ok(def.plannedFor, `${def.slug}: a coming-soon connector must say when`);
    continue;
  }
  const src = def.live.source;
  // Every field a status reads is a real field of a real integration schema —
  // the same store Credentials writes and listTenantIntegrationStatus reads.
  const schema = findIntegrationSchema(src.service);
  assert.ok(schema, `${def.slug}: status service "${src.service}" is not an integration the store knows`);
  const fields = new Set(schema!.fields.map((f) => f.key));
  const named = [...src.requireAll, ...(src.kind === "tenant_keys" ? src.requireAny ?? [] : [])];
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
  if (def.live) everyService.add(def.live.source.service);
}
const allFields = ["secret_key", "app_password", "from_address", "bot_token", "chat_id", "account_sid", "auth_token",
  "from_number", "messaging_service_sid", "access_token", "refresh_token", "api_key", "token"];
const GREEN: ConnectorFacts = {
  keyRows: [...everyService].flatMap((service) =>
    allFields.map((field_key): KeyRowFact => ({
      service, field_key, has_value: true, last_tested_at: iso(MIN), last_test_ok: true,
    })),
  ),
  heartbeats: [...everyService].map((service): HeartbeatFact => ({ service, status: "healthy", last_ping_at: iso(MIN) })),
  personalGoogleLinked: true,
};

for (const def of CONNECTOR_CATALOG) {
  const s = resolveConnectorStatus(def, GREEN, NOW);
  if (!def.live) {
    assert.equal(s.kind, "coming_soon", `${def.slug} has no status source but resolved to "${s.kind}"`);
    assert.doesNotMatch(s.label, /connected/i);
  }
}
assert.equal(resolveConnectorStatus(connectorBySlug("stripe")!, GREEN, NOW).kind, "connected");
assert.equal(resolveConnectorStatus(connectorBySlug("google-workspace")!, GREEN, NOW).kind, "connected");

// Every lookup failed: "status unavailable" for every live card — never
// "not connected", never "connected".
const FAILED: ConnectorFacts = { keyRows: null, heartbeats: null, personalGoogleLinked: null };
for (const def of CONNECTOR_CATALOG) {
  const s = resolveConnectorStatus(def, FAILED, NOW);
  assert.equal(s.kind, def.live ? "unknown" : "coming_soon", `${def.slug}: a failed lookup resolved to "${s.kind}"`);
}
// Only the heartbeat read failing is still unknown for a heartbeat-backed card.
assert.equal(
  resolveConnectorStatus(connectorBySlug("telegram")!, { ...GREEN, heartbeats: null }, NOW).kind,
  "unknown",
);

// Nothing saved at all: honestly not connected.
const EMPTY: ConnectorFacts = { keyRows: [], heartbeats: [], personalGoogleLinked: false };
for (const slug of LIVE) {
  assert.equal(resolveConnectorStatus(connectorBySlug(slug)!, EMPTY, NOW).kind, "not_connected", slug);
}

const keyRow = (service: string, field_key: string, over: Partial<KeyRowFact> = {}): KeyRowFact => ({
  service, field_key, has_value: true, last_tested_at: null, last_test_ok: null, ...over,
});
const stripe = connectorBySlug("stripe")!;
const twilio = connectorBySlug("twilio")!;

// A saved key nobody tested is set up, not connected.
assert.equal(
  resolveConnectorStatus(stripe, { ...EMPTY, keyRows: [keyRow("stripe", "secret_key")] }, NOW).kind,
  "configured",
);
// A failed test is attention, even beside an older passing one.
assert.equal(
  resolveConnectorStatus(stripe, {
    ...EMPTY,
    keyRows: [
      keyRow("stripe", "secret_key", { last_test_ok: false, last_tested_at: iso(MIN) }),
      keyRow("stripe", "publishable_key", { last_test_ok: true, last_tested_at: iso(HOUR) }),
    ],
  }, NOW).kind,
  "attention",
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
  resolveConnectorStatus(gws, { keyRows: [], heartbeats: [], personalGoogleLinked: true }, NOW).kind,
  "connected",
);
// A heartbeat for one service never lights up another.
assert.notEqual(
  resolveConnectorStatus(connectorBySlug("telegram")!, {
    keyRows: [keyRow("telegram", "bot_token"), keyRow("telegram", "chat_id")],
    heartbeats: [{ service: "gws", status: "healthy", last_ping_at: iso(MIN) }],
    personalGoogleLinked: true,
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
assert.match(read("app/settings/connections/page.tsx"), /resolveConnectorStatus\(/);
assert.match(read("app/settings/chat-apps/page.tsx"), /resolveConnectorStatus\(telegram/);
// Slack is Phase 2 on both surfaces.
assert.equal(connectorBySlug("slack")!.live, null);
assert.equal(connectorBySlug("slack")!.plannedFor, "Phase 2");
assert.match(read("app/settings/chat-apps/page.tsx"), /Coming in Phase 2/);

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
}
assert.match(OASIS_ADDONS.find((a) => a.slug === "oasis-whispr")!.platforms, /^Windows$/);
const billing = read("app/settings/billing/page.tsx");
assert.match(billing, /SUPPORT_FORM_PATH/, "the add-on request must go through the existing support form");
assert.match(read("components/settings/AddonCard.tsx"), /Ask OASIS to add this/);
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
assert.match(read("app/settings/connections/page.tsx"), /if \(viewer\.access\.canManage\)/);

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
      post: (origin: string, data: unknown) => {
        for (const fn of [...listeners]) fn({ origin, data } as MessageEvent);
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
    watchPopup({ popup: { closed: false }, source: "constant_contact", env: w.env, onDone: (r) => done.push(r) });
    assert.equal(w.listeners.size, 1);
    assert.equal(w.timers.size, 1);
    w.post("https://evil.test", { source: "constant_contact", status: "connected" });
    w.post("https://app.test", { source: "other", status: "connected" });
    w.post("https://app.test", null);
    assert.deepEqual(done, [], "another origin or source is not this popup's answer");
    w.post("https://app.test", { source: "constant_contact", status: "error", reason: "admin_only" });
    w.post("https://app.test", { source: "constant_contact", status: "connected" });
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
    w.post("https://app.test", { source: "constant_contact", status: "connected" });
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

console.log(
  `os-connectors: OK — ${CONNECTOR_CATALOG.length} connectors (${LIVE.length} live, ` +
    `${CONNECTOR_CATALOG.filter((c) => c.icon.kind === "monogram").length} monograms), ` +
    `${shipped.length} logos, ${OASIS_ADDONS.length} add-ons, ${SETTINGS_SECTIONS.length} sections gated`,
);
