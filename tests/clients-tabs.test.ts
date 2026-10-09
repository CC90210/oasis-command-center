/**
 * tests/clients-tabs.test.ts: the Clients tabs answer a click (CLI-1, CLI-2,
 * CS-03, CS-06).
 *
 * WHY. CC, 2026-10-01: "when I go into clients and try to click from all to
 * prospect, or onboarding, active, paused, or past, they're not clickable" and
 * "I'm still unable to click the actual subbed things inside the clients
 * portal". Both tab bars were server links that change only the query string:
 * Next keeps the old page up during the server render and shows no loading
 * boundary for a query-only change, so nothing moved until the render landed
 * (Workers Logs, 10-01 22:33-22:37 UTC: every click reached the server and
 * answered 200 in 0.5 to 2.1 s; CC clicked five tabs in four seconds).
 *
 * Pins:
 *   1. OsTabBar (components/os/OsTabBar.tsx): a tab named by the address bar
 *      (a bar in a layout) or by the page; the clicked tab is drawn current at
 *      once and only until the page moves on (Back must not leave the
 *      underline on the tab you left); today's look; prefetch off, warm on
 *      intent, pending from useLinkStatus.
 *   2. The Clients list, rendered against a real database: every status is
 *      read once, whatever ?lifecycle= says, and each tab's count is the
 *      number of records with that status; the KPI row and "Not yet client
 *      records" stay under a status; a list cut at its page size reads the
 *      status on the server and its tabs navigate.
 *   3. A client record: the tab bar is the layout's and reads ?tab=; a client
 *      workspace's record has no Money and no Usage tab, and ?tab=usage or
 *      ?tab=money there opens Overview; OASIS's record keeps both (control).
 *   4. Every tab bar under app/clients is OsTabBar, and both pages have a
 *      loading boundary.
 *   5. What the browser components draw and do with a click or a hover,
 *      rendered where React is whole (tests/clients-tabs.render.ts): a status
 *      click cancels the navigation, writes the address bar and asks the
 *      server nothing, and the list then shows that status's rows.
 *
 * Run: node --conditions=react-server --import tsx tests/clients-tabs.test.ts
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import * as ReactNS from "react";
import { createElement, type ReactNode } from "react";
import { CLIENT_A, OASIS, USERS, check, finish, login, setupDatabase, splitSql } from "./_delivery-harness";

// next/link pulls the client router context, which does not exist under the
// react-server condition: a plain anchor stands in, as in tests/clients-hub.test.ts.
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
const linkPath = require.resolve("next/link");
require.cache[linkPath] = {
  id: linkPath,
  filename: linkPath,
  path: dirname(linkPath),
  loaded: true,
  children: [],
  paths: [],
  exports: {
    __esModule: true,
    default: ({ href, children, ...rest }: { href: string; children?: ReactNode }) => createElement("a", { href, ...rest }, children),
    useLinkStatus: () => ({ pending: false }),
  },
} as unknown as NodeModule;

const root = join(__dirname, "..");
const code = (rel: string) => readFileSync(join(root, rel), "utf8");
/** Code only: comments may say what the tabs used to be. */
const stripped = (rel: string) => code(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const MIG = (f: string) => code(join("database", "turso", f));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(relative(root, full).split(sep).join("/"));
  }
  return out;
}

/** The text a server-rendered tree shows: server components rendered, a client component's props walked. */
function textOf(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) textOf(v, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    if (typeof el.type === "function") {
      try {
        const rendered = (el.type as (p: unknown) => unknown)(el.props);
        if (!(rendered instanceof Promise)) textOf(rendered, out, seen);
      } catch {
        /* a client component: its props below are what ships */
      }
    }
    textOf(el.props, out, seen);
    return out;
  }
  for (const v of Object.values(node as Record<string, unknown>)) textOf(v, out, seen);
  return out;
}

/** Every element of `type` anywhere in a tree (props and children), without rendering anything. */
function findAll(node: unknown, type: unknown, out: Array<{ props: Record<string, unknown> }> = [], seen = new Set<unknown>()) {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) findAll(v, type, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (!el.$$typeof) {
    for (const v of Object.values(node as object)) findAll(v, type, out, seen);
    return out;
  }
  if (el.type === type && el.props) out.push(el as { props: Record<string, unknown> });
  if (el.props) findAll(Object.values(el.props), type, out, seen);
  return out;
}

type Tab = { key: string; label: string; href: string; count?: number };

/**
 * The "use client" modules the Clients pages' server files import or re-export
 * directly (read 2026-10-08; all three were boundaries on main before the tabs
 * work). Each is listed in every route's manifest of the Worker; a new one
 * fails the check that computes this set.
 */
const CLIENTS_BOUNDARIES: string[] = [
  "components/delivery/TicketForms.tsx",
  "components/os/landings/client-conversations.tsx",
  "components/os/landings/clients-actions.tsx",
];

async function main() {
  console.log("clients-tabs:");
  const bar = await import("../components/os/OsTabBar");
  const status = await import("../components/os/landings/clients-status");
  const records = await import("../components/os/landings/clients-records-data");

  // -- 1. OsTabBar ----------------------------------------------------------
  await check("OsTabBar: the address bar names the tab (a bar in a layout); missing or unknown is the first tab", () => {
    const tabs = [{ key: "overview" }, { key: "tickets" }, { key: "health" }];
    assert.equal(bar.tabFromParam("tickets", tabs), "tickets");
    for (const v of [null, undefined, "", "money", "Tickets"]) assert.equal(bar.tabFromParam(v, tabs), "overview", String(v));
  });
  await check("OsTabBar: the clicked tab is drawn current at once, and only until the page moves on from where it was clicked", () => {
    const click = { key: "money", from: "overview" };
    assert.equal(bar.shownTab("overview", null), "overview", "nothing clicked: the page's tab");
    assert.equal(bar.shownTab("overview", click), "money", "clicked: Money, before the server answers");
    assert.equal(bar.shownTab("money", click), "money", "landed");
    assert.equal(bar.pendingClick(click, "money"), null, "landed: the click is answered and forgotten");
    // Back (or the rail) took the page somewhere else: the page's tab wins,
    // never the tab clicked earlier.
    assert.equal(bar.shownTab("tickets", click), "tickets");
    assert.equal(bar.pendingClick(click, "overview"), click, "still on the page it was clicked from: still waiting");
    const src = stripped("components/os/OsTabBar.tsx");
    assert.match(src, /if \(clicked && !pendingClick\(clicked, current\)\) setClicked\(null\);/, "the bar forgets an answered click");
    assert.match(src, /setClicked\(\{ key: t\.key, from: current \}\)/, "a click remembers the tab it was made from");
  });
  await check("OsTabBar: today's tab look (-mb-px border-b-2, a foreground underline on the current tab, the rail's focus ring)", () => {
    assert.equal(
      bar.osTabClass(true),
      "relative -mb-px border-b-2 px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 border-fg font-medium text-fg",
    );
    assert.equal(
      bar.osTabClass(false),
      "relative -mb-px border-b-2 px-3 py-2 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-accent/60 border-transparent text-fg-muted hover:text-fg",
    );
  });
  await check("OsTabBar: prefetch off, warm on hover and focus with the rail's hook, pending from useLinkStatus, no new visual language", () => {
    const src = code("components/os/OsTabBar.tsx");
    const body = stripped("components/os/OsTabBar.tsx");
    assert.match(src, /^"use client";/, "a client component");
    const links = (body.match(/<Link\s/g) || []).length;
    assert.equal(links, 1, "one Link per tab");
    assert.equal((body.match(/prefetch=\{false\}/g) || []).length, links, "every Link keeps prefetch off (tests/os-nav.test.ts)");
    assert.doesNotMatch(body, /prefetch=\{true\}|router\.push|router\.replace/);
    assert.match(body, /import \{ useWarmOnIntent \} from "@\/components\/os\/RailRow";/, "the rail's own warm-on-intent hook, not a second one");
    assert.match(body, /function OsTabLabel[\s\S]*useLinkStatus\(\)/, "the pending state is read inside the Link, where useLinkStatus sees it");
    assert.doesNotMatch(body, /bg-gradient|from-accent|blur-|shadow-glow|animate-|drop-shadow|#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  // -- pure helpers of the list and the record --------------------------------
  await check("the status view: a lifecycle param names its tab; anything else is All; All splits current from Past", () => {
    for (const l of ["prospect", "onboarding", "active", "paused", "churned"]) assert.equal(status.clientStatusOf(l), l);
    for (const v of ["", "vip", "Active", null, undefined]) assert.equal(status.clientStatusOf(v), "");
    const l = ["active", "churned", "prospect", "active", "paused"] as const;
    assert.deepEqual(status.rowsForStatus(l, ""), { current: [0, 2, 3, 4], past: [1] });
    assert.deepEqual(status.rowsForStatus(l, "active"), { current: [0, 3], past: [] });
    assert.deepEqual(status.rowsForStatus(l, "onboarding"), { current: [], past: [] });
  });
  await check("the status view: a click is shown at once and stays shown until the address bar catches up; a change in the bar is followed", () => {
    const start = { shown: "" as const, seen: "" as const };
    const clicked = status.clickStatus(start, "active");
    assert.deepEqual(clicked, { shown: "active", seen: "" });
    // The click's own render: Next applies the address-bar write in a
    // transition, after it. The bar's old value must not pull the list back.
    assert.equal(status.followAddressBar(clicked, ""), clicked);
    // The write lands: nothing moves.
    assert.deepEqual(status.followAddressBar(clicked, "active"), { shown: "active", seen: "active" });
    // Back, Clear or the rail change the bar from outside: followed.
    assert.deepEqual(status.followAddressBar({ shown: "active", seen: "active" }, ""), { shown: "", seen: "" });
    assert.deepEqual(status.followAddressBar({ shown: "paused", seen: "active" }, "churned"), { shown: "churned", seen: "churned" });
    const src = stripped("components/os/landings/clients-status.tsx");
    assert.match(src, /const followed = followAddressBar\(view, inUrl\);\s*if \(followed !== view\) setView\(followed\);/, "every render follows the bar");
    assert.match(src, /setView\(\(v\) => clickStatus\(v, clientStatusOf\(key\)\)\);/, "a click goes through clickStatus");
  });
  await check("a record's tabs: no Money outside OASIS's books, no Usage outside OASIS; Overview first; ?tab= resolves to an offered tab", () => {
    const keys = (v: { tenantId: string; oasis: boolean }) => records.clientTabsFor(v).map((t) => t.key);
    const all = ["overview", "conversations", "tickets", "projects", "money", "usage", "activity", "health", "files"];
    assert.deepEqual(keys({ tenantId: OASIS, oasis: true }), all, "OASIS: every tab");
    assert.deepEqual(keys({ tenantId: CLIENT_A, oasis: false }), all.filter((k) => k !== "money" && k !== "usage"), "a client workspace");
    const clientTabs = records.clientTabsFor({ tenantId: CLIENT_A, oasis: false });
    assert.equal(records.resolveClientTab("usage", clientTabs), "overview");
    assert.equal(records.resolveClientTab("money", clientTabs), "overview");
    assert.equal(records.resolveClientTab("tickets", clientTabs), "tickets");
    assert.equal(records.resolveClientTab(null, clientTabs), "overview");
    // The browser bar and the server page land on the same tab for every value.
    for (const v of ["usage", "money", "tickets", "health", "", null, "x"]) {
      assert.equal(bar.tabFromParam(v, clientTabs), records.resolveClientTab(v, clientTabs), String(v));
    }
  });
  await check("a repeated param is its first value on the server, the value the browser's tab bar reads (?tab=a&tab=b)", () => {
    const clientTabs = records.clientTabsFor({ tenantId: CLIENT_A, oasis: false });
    assert.equal(records.firstParam(["tickets", "money"]), "tickets");
    assert.equal(records.firstParam("tickets"), "tickets");
    assert.equal(records.firstParam([]), undefined);
    assert.equal(records.firstParam(undefined), undefined);
    for (const query of ["tab=tickets&tab=health", "tab=health&tab=tickets", "tab=money&tab=tickets", "tab=x&tab=tickets"]) {
      const sp = new URLSearchParams(query);
      // Next hands the page every value (getAll); the browser's bar reads the first (get).
      assert.equal(records.resolveClientTab(sp.getAll("tab"), clientTabs), bar.tabFromParam(sp.get("tab"), clientTabs), query);
    }
    assert.equal(records.resolveClientTab(["tickets", "health"], clientTabs), "tickets");
  });

  // -- 2 and 3. The pages, against a real database ------------------------------
  const db = await setupDatabase();
  for (const f of ["bravo__188_os_customers.sql", "bravo__195_customers_links.sql"]) {
    for (const stmt of splitSql(MIG(f))) await db.execute(stmt);
  }
  await db.executeMultiple(MIG("bravo__186_os_approvals.sql"));
  // Production shapes (schema export) of the other tables the pages read.
  await db.executeMultiple(`
    CREATE TABLE conversation_events (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, thread_id TEXT, lead_id TEXT, event_type TEXT NOT NULL,
      actor_user_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
  `);
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  for (const [id, tenant, slug] of [["m-o", OASIS, "oasis-ai-cc"], ["m-a", CLIENT_A, "client-a"]] as const) {
    await db.execute({
      sql: "INSERT INTO tenant_manifests VALUES (?, ?, ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
      args: [id, tenant, slug, JSON.stringify(parseManifest(finalizeManifestFromWizard({ template: "custom", slug, answers: {} })))],
    });
  }
  const store = await import("../lib/os/customers/store");
  const T0 = new Date("2026-10-02T12:00:00.000Z");
  const make = async (tenant: string, display_name: string, lifecycle: "prospect" | "onboarding" | "active" | "paused" | "churned", actor: string) => {
    const r = await store.createCustomer(
      db,
      tenant,
      { display_name, primary_email: null, company_name: null, primary_phone: null, lifecycle, owner_user_id: null, stripe_customer_id: null, tags: [], custom_fields: {} },
      actor,
      T0,
    );
    assert.ok(r.ok, JSON.stringify(r));
    return r.customer;
  };
  // OASIS's book: 1 prospect, 1 onboarding, 2 active, 0 paused, 1 past.
  await make(OASIS, "Pia Prospect", "prospect", USERS.cc.id);
  await make(OASIS, "Otto Onboarding", "onboarding", USERS.cc.id);
  const alma = await make(OASIS, "Alma Active", "active", USERS.cc.id);
  await make(OASIS, "Abe Active", "active", USERS.cc.id);
  await make(OASIS, "Pete Past", "churned", USERS.cc.id);
  // A won deal not yet converted, so "Not yet client records" has a row.
  await db.execute({
    sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES ('lead-won-tabs', ?, 'lead', ?)",
    args: [OASIS, JSON.stringify({ stage: "won", company: "Wendy Won Deal Co", name: "Wendy" })],
  });
  const acme = await make(CLIENT_A, "Acme Home", "active", USERS.clientA.id);
  const EXPECTED = { "": 5, prospect: 1, onboarding: 1, active: 2, paused: 0, churned: 1 } as Record<string, number>;

  const ClientsPage = (await import("../app/clients/page")).default;
  const ClientRecordPage = (await import("../app/clients/[id]/page")).default;
  const ClientRecordLayout = (await import("../app/clients/[id]/layout")).default;
  const { KpiTile } = await import("../components/os/KpiTile");
  const listView = async (sp: Record<string, string>) => {
    const tree = await ClientsPage({ searchParams: Promise.resolve(sp) });
    const [view] = findAll(tree, status.ClientsByStatus);
    assert.ok(view, "the list is rendered through ClientsByStatus");
    return { tree, props: view.props as { tabs: Tab[]; lifecycles: string[]; rows: unknown[]; fromServer: boolean } };
  };
  const countsOf = (tabs: Tab[]) => Object.fromEntries(tabs.map((t) => [t.key, t.count]));
  const byStatus = (lifecycles: string[]) => {
    const n: Record<string, number> = { "": lifecycles.length };
    for (const l of lifecycles) n[l] = (n[l] ?? 0) + 1;
    return n;
  };

  await login(USERS.cc);
  await check("/clients?lifecycle=active: every status is read once, and each tab's count is the records with that status", async () => {
    const { tree, props } = await listView({ lifecycle: "active" });
    assert.equal(props.fromServer, false, "500 or fewer records: the tabs filter in the browser");
    assert.deepEqual(countsOf(props.tabs), EXPECTED, "a tab's count is its records, whichever tab the address bar names");
    // The rows the browser filters are every status's, not only the URL's.
    const read = byStatus(props.lifecycles);
    for (const k of Object.keys(EXPECTED)) assert.equal(read[k] ?? 0, EXPECTED[k], `rows with status '${k || "all"}'`);
    assert.equal(props.rows.length, props.lifecycles.length, "one rendered row per record");
    // The KPI row and the deals not yet records stay on the page under a status.
    const active = findAll(tree, KpiTile).find((k) => k.props.label === "Active");
    assert.equal(active?.props.value, 2, "the Active tile is drawn under the Active tab, with every record counted");
    assert.match(textOf(tree).join("\n"), /Not yet client records[\s\S]*Wendy Won Deal Co/);
  });
  await check("/clients: each tab's link is its status plus the form's filters, so the address bar, Back and a shared link agree", async () => {
    const { props } = await listView({ lifecycle: "paused", q: "Active" });
    const href = Object.fromEntries(props.tabs.map((t) => [t.key, t.href]));
    assert.equal(href[""], "/clients?q=Active");
    assert.equal(href.active, "/clients?lifecycle=active&q=Active");
    assert.equal(href.churned, "/clients?lifecycle=churned&q=Active");
    // The search narrows the read; the counts follow it.
    assert.deepEqual(countsOf(props.tabs), { "": 2, prospect: 0, onboarding: 0, active: 2, paused: 0, churned: 0 });
  });
  await check("/clients cut at its page size: the server reads the status in the address bar and the tabs navigate, with no counts", async () => {
    const bulk = Array.from({ length: 501 }, (_, i) => ({
      sql: `INSERT INTO customers (id, tenant_id, display_name, lifecycle, tags, custom_fields, created_at, updated_at)
            VALUES (?, ?, ?, 'prospect', '[]', '{}', ?, ?)`,
      args: [`bulk-tabs-${i}`, OASIS, `Bulk ${i}`, T0.toISOString(), T0.toISOString()],
    }));
    await db.batch(bulk, "write");
    try {
      // lib/perf/server-timing.ts logs each statement's SQL text (never its
      // values) when PERF_DB_VERBOSE=1: which reads this render made.
      const sql: string[] = [];
      const realLog = console.log;
      process.env.PERF_DB_VERBOSE = "1";
      console.log = (...a: unknown[]) => {
        const line = a.map(String).join(" ");
        if (line.startsWith("[perf.db] ")) sql.push((JSON.parse(line.slice("[perf.db] ".length)) as { sql: string }).sql);
      };
      let view: Awaited<ReturnType<typeof listView>>;
      try {
        view = await listView({ lifecycle: "active" });
      } finally {
        console.log = realLog;
        delete process.env.PERF_DB_VERBOSE;
      }
      const { tree, props } = view;
      assert.equal(props.fromServer, true, "a cut list cannot be filtered from the rows at hand");
      assert.deepEqual([...new Set(props.lifecycles)], ["active"], "the server read the Active records");
      assert.equal(props.lifecycles.length, 2);
      assert.ok(props.tabs.every((t) => t.count === undefined), "no count from a cut list: it would be a floor");
      assert.equal(findAll(tree, KpiTile).length, 0, "no KPI row from a cut list");
      // The health signals are read for the 2 rows shown, never for the 500 the
      // page drops (the desk's breach count, as its SQL text starts). 500 ids
      // are read in several statements, each listing more ids than the log's
      // 140-character preview holds; 2 ids are one statement, listed whole.
      const signalReads = sql.filter((s) => /^SELECT customer_id, COUNT\(\*\) AS n FROM support_tickets/.test(s));
      assert.ok(signalReads.length > 0, `control: the desk signals were read, in ${sql.length} statements`);
      assert.equal(signalReads.length, 1, `the desk signals were read in ${signalReads.length} statements: the rows the page drops were read too`);
      assert.match(signalReads[0], /customer_id IN \(\?, \?\) AND /, "the one read is for the 2 rows shown");
    } finally {
      await db.execute("DELETE FROM customers WHERE id LIKE 'bulk-tabs-%'");
    }
  });
  await check("/clients and a record given a repeated param read its first value, as the tab bars do; a repeated search no longer breaks the page", async () => {
    // Next hands a repeated param to the page as an array; `.trim()` on it threw.
    const { props } = await listView({ lifecycle: ["active", "paused"], q: ["Active", "Zed"] } as never);
    assert.deepEqual(countsOf(props.tabs), { "": 2, prospect: 0, onboarding: 0, active: 2, paused: 0, churned: 0 }, "the search is its first value");
    assert.equal(props.tabs.find((t) => t.key === "active")?.href, "/clients?lifecycle=active&q=Active");
    const body = textOf(
      await ClientRecordPage({ params: Promise.resolve({ id: alma.id }), searchParams: Promise.resolve({ tab: ["tickets", "money"] }) as never }),
    ).join("\n");
    assert.match(body, /No tickets from this client/, "?tab=tickets&tab=money opens Tickets, the tab the bar underlines");
  });

  const record = async (id: string, tab?: string) => {
    const body = await ClientRecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) });
    const layout = await ClientRecordLayout({ params: Promise.resolve({ id }), children: body as never });
    const [recordTabs] = findAll(layout, status.ClientRecordTabs);
    assert.ok(recordTabs, "the record's tab bar is drawn by its layout");
    // ClientRecordTabs is the shared OsTabBar, reading ?tab= from the address bar.
    const drawn = status.ClientRecordTabs(recordTabs.props as { tabs: Tab[] }) as unknown as { type: unknown; props: Record<string, unknown> };
    assert.equal(drawn.type, bar.OsTabBar);
    return { body: textOf(body).join("\n"), tabBar: drawn.props as { param?: string; label?: string; tabs: Tab[] } };
  };
  await login(USERS.clientA);
  await check("a client workspace's record: no Money and no Usage tab; ?tab=usage and ?tab=money open Overview", async () => {
    for (const tab of ["usage", "money"]) {
      const r = await record(acme.id, tab);
      assert.equal(r.tabBar.param, "tab", "the bar reads ?tab= from the address bar");
      assert.equal(r.tabBar.label, "Client record");
      assert.deepEqual(
        r.tabBar.tabs.map((t) => t.key),
        ["overview", "conversations", "tickets", "projects", "activity", "health", "files"],
      );
      assert.match(r.body, /Details[\s\S]*Record added/, `?tab=${tab} renders Overview`);
      assert.doesNotMatch(r.body, /Usage is how OASIS sees|payments and invoices are not kept in the app/, `?tab=${tab} renders no dead tab`);
    }
    assert.equal((await record(acme.id, "tickets")).tabBar.tabs.find((t) => t.key === "tickets")?.href, `/clients/${acme.id}?tab=tickets`);
  });
  await login(USERS.cc);
  await check("control: OASIS's record keeps Money and Usage, and ?tab=usage opens Usage", async () => {
    const r = await record(alma.id, "usage");
    assert.deepEqual(
      r.tabBar.tabs.map((t) => t.key),
      ["overview", "conversations", "tickets", "projects", "money", "usage", "activity", "health", "files"],
    );
    assert.match(r.body, /Not linked to the client/);
    assert.doesNotMatch(r.body, /Record added/, "not Overview");
  });

  await check("a tab switch renders the page alone, and the page reads only the open tab: no header, health or contact reads on Tickets", async () => {
    // lib/perf/server-timing.ts logs each statement's SQL text (never its
    // values) when PERF_DB_VERBOSE=1: the reads a tab click costs.
    const sql: string[] = [];
    const realLog = console.log;
    process.env.PERF_DB_VERBOSE = "1";
    console.log = (...a: unknown[]) => {
      const line = a.map(String).join(" ");
      if (line.startsWith("[perf.db] ")) sql.push((JSON.parse(line.slice("[perf.db] ".length)) as { sql: string }).sql);
    };
    try {
      const body = textOf(await ClientRecordPage({ params: Promise.resolve({ id: alma.id }), searchParams: Promise.resolve({ tab: "tickets" }) })).join("\n");
      assert.match(body, /No tickets from this client/, "the Tickets tab rendered");
    } finally {
      console.log = realLog;
      delete process.env.PERF_DB_VERBOSE;
    }
    // The tickets list (lib/delivery/store.ts ticketSelect), as its SQL text starts.
    assert.ok(sql.some((s) => /^SELECT t\.\*, p\.title AS project_title/.test(s)), `control: the tab's own read was seen in ${JSON.stringify(sql)}`);
    // The header's reads (projects, health signals, contacts, the team list,
    // the desk roster) belong to the layout, which a tab click does not render.
    for (const table of ["outcome_events", "approvals", "conversation_events", "customer_contacts", "fin_payments", "fin_subscriptions"]) {
      assert.ok(!sql.some((s) => new RegExp(`FROM ${table}\\b`).test(s)), `the Tickets tab read ${table}`);
    }
    // The projects list (lib/delivery/store.ts projectSelect), as its SQL text starts.
    assert.ok(!sql.some((s) => /^SELECT p\.\*, tn\.name AS client_tenant_name/.test(s)), "the Tickets tab read the projects list");
  });

  await check("a database without client records: the list, a record, the deal card and the API say so in plain words, never a migration's name (CS-16)", async () => {
    const { ClientRecordCard } = await import("../components/os/landings/clients-record-card");
    const { customersServerError } = await import("../lib/os/customers/session");
    await db.execute("ALTER TABLE customers RENAME TO customers_unapplied");
    // The detail goes to the log: captured here, so it can be checked and does not flood the run.
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void logged.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" "));
    try {
      const said = [
        textOf(await ClientsPage({ searchParams: Promise.resolve({}) })).join("\n"),
        textOf(await ClientRecordLayout({ params: Promise.resolve({ id: alma.id }), children: null as never })).join("\n"),
        textOf(await ClientRecordPage({ params: Promise.resolve({ id: alma.id }), searchParams: Promise.resolve({}) })).join("\n"),
        textOf(await ClientRecordCard({ tenantId: OASIS, leadId: "lead-won-tabs", stage: "won" })).join("\n"),
      ];
      for (const t of said) assert.match(t, /Client records aren.t available right now\. The error has been logged\./);
      const api = customersServerError("tabs_test", new Error("no such table: customers"));
      const body = (await api.json()) as { error: string; message: string };
      assert.deepEqual([api.status, body.error], [503, "customers_not_set_up"], "the code still names the cause for the log and the operator");
      for (const t of [...said, body.message]) assert.doesNotMatch(t, /migration|bravo__/i);
      for (const where of ["[os.clients.customers]", "[os.clients.record]", "[os.clients.record_card]", "[customers:tabs_test]"]) {
        assert.ok(logged.some((l) => l.startsWith(where) && /no such table: customers/.test(l)), `${where}: the cause is in the log`);
      }
    } finally {
      console.error = realError;
      await db.execute("ALTER TABLE customers_unapplied RENAME TO customers");
    }
  });

  // -- 4. The pages' structure -------------------------------------------------
  await check("every tab bar under app/clients is OsTabBar: none is hand-rolled; the record's bar is its layout's", () => {
    for (const f of walk(join(root, "app", "clients"))) {
      assert.doesNotMatch(stripped(f), /-mb-px border-b-2/, `${f} draws its own tab bar`);
      assert.doesNotMatch(stripped(f), /<nav aria-label=/, `${f} draws its own tab bar`);
    }
    assert.match(stripped("app/clients/page.tsx"), /<ClientsByStatus\b/);
    assert.match(stripped("components/os/landings/clients-status.tsx"), /<OsTabBar label="Client status"/);
    assert.match(stripped("components/os/landings/clients-status.tsx"), /<OsTabBar label="Client record" param="tab"/);
    assert.match(stripped("app/clients/[id]/layout.tsx"), /<ClientRecordTabs\b/);
    assert.doesNotMatch(stripped("app/clients/[id]/page.tsx"), /OsTabBar|ClientRecordTabs|loadClientHeader|loadAssignmentRoster/, "the page draws the open tab only");
  });
  await check("no new client boundary: server code reaches OsTabBar and the status view only through clients-actions.tsx (each boundary module costs ~147 KiB of Worker upload)", () => {
    // Every "use client" module a server component imports is listed three
    // times in each of the 538 route manifests: on 2026-10-02 OsTabBar.tsx and
    // clients-status.tsx, imported directly, put the Worker 235 KiB past its
    // budget. A server file may name OsTabBar's types (erased), not import it.
    const offenders: string[] = [];
    for (const dir of ["app", "components", "lib"]) {
      for (const f of walk(join(root, dir))) {
        const src = code(f);
        if (/^\s*["']use client["'];/.test(src)) continue;
        for (const m of src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
          if (/(^|\/)(OsTabBar|clients-status)$/.test(m[1])) offenders.push(`${f} imports ${m[1]}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
    const actions = code("components/os/landings/clients-actions.tsx");
    assert.match(actions, /^"use client";/, "clients-actions.tsx is the Clients pages' client boundary");
    assert.match(
      actions,
      /export \{ ClearClientFilters, ClientRecordTabs, ClientStatusField, ClientsByStatus \} from "@\/components\/os\/landings\/clients-status";/,
    );
  });
  await check("the Clients pages' server code imports exactly the client boundaries it has had: a new one fails here (each new boundary module costs ~147 KiB of Worker upload)", () => {
    // The check above names two files; this one computes the whole set. Every
    // server file of the Clients pages (app/clients and the clients-/client-
    // modules beside the landings), every runtime import or re-export it
    // makes, resolved to a file: the "use client" ones are the boundaries this
    // code adds to every route's manifest. A module that is new here goes
    // through clients-actions.tsx (the Clients pages' one boundary), or, if it
    // is already a boundary elsewhere in the app (no new cost), is added below
    // on purpose.
    const isClient = (rel: string) => /^\s*["']use client["'];/.test(code(rel));
    const resolveSpec = (from: string, spec: string): string | null => {
      const base = spec.startsWith("@/") ? join(root, spec.slice(2)) : spec.startsWith(".") ? join(root, dirname(from), spec) : null;
      if (!base) return null; // a package: not this app's code
      for (const ext of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        const p = base + ext;
        if (existsSync(p) && statSync(p).isFile()) return relative(root, p).split(sep).join("/");
      }
      throw new Error(`${from}: cannot resolve ${spec}`);
    };
    /** Runtime imports and re-exports: `import type`, `export type` and all-type braces are erased, so they are not boundaries. */
    const runtimeSpecs = (src: string): string[] => {
      const out: string[] = [];
      for (const m of src.matchAll(/(?:^|\n)[ \t]*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g)) {
        if (m[1]) continue;
        const braces = /^\{([^}]*)\}$/.exec(m[2].trim());
        if (braces && braces[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => /^type\s/.test(s))) continue;
        out.push(m[3]);
      }
      return out;
    };
    const serverFiles = [
      ...walk(join(root, "app", "clients")),
      ...walk(join(root, "components", "os", "landings")).filter((f) => /\/clients?-[^/]+$/.test(f)),
    ].filter((f) => !isClient(f));
    assert.ok(serverFiles.includes("app/clients/page.tsx") && serverFiles.includes("components/os/landings/clients-records-data.ts"), "control: the pages' server files are read");
    const boundaries = new Map<string, string[]>();
    for (const f of serverFiles) {
      for (const spec of runtimeSpecs(stripped(f))) {
        const target = resolveSpec(f, spec);
        if (target && isClient(target)) boundaries.set(target, [...(boundaries.get(target) ?? []), f]);
      }
    }
    assert.deepEqual([...boundaries.keys()].sort(), CLIENTS_BOUNDARIES, `the boundaries and who imports them: ${JSON.stringify(Object.fromEntries(boundaries))}`);
  });
  await check("both Clients pages have a loading boundary that paints at once", () => {
    for (const [f, variant] of [["app/clients/loading.tsx", "page"], ["app/clients/[id]/loading.tsx", "section"]] as const) {
      assert.ok(existsSync(join(root, f)), `${f} is missing`);
      assert.match(stripped(f), new RegExp(`<PageSkeleton variant="${variant}" />`), `${f} paints the shared skeleton`);
    }
  });

  // -- 5. Rendered where React is whole -----------------------------------------
  await check("rendered: what the tabs draw, and what a click and a hover do (tests/clients-tabs.render.ts)", () => {
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const run = spawnSync(process.execPath, ["--import", "tsx", "tests/clients-tabs.render.ts"], { cwd: root, encoding: "utf8", env });
    assert.equal(run.status, 0, `the render helper exited ${run.status}:\n${run.stderr}`);
    const r = JSON.parse(run.stdout) as Record<string, unknown>;
    const html = (k: string) => String(r[k]);
    const current = (markup: string) => [...markup.matchAll(/<a href="([^"]+)"[^>]*aria-current="page"/g)].map((m) => m[1]);

    // A record's tabs: the address bar names the current one; hover and focus warm; a click is not cancelled.
    assert.match(html("record"), /<nav aria-label="Client record"/);
    assert.deepEqual(current(html("record")), ["/clients/c1?tab=money"]);
    assert.deepEqual(current(html("recordNoTab")), ["/clients/c1"], "no ?tab=: Overview");
    assert.deepEqual(current(html("recordUnknownTab")), ["/clients/c1"], "a tab this record does not offer: Overview, as the page renders");
    assert.match(html("recordLayoutBar"), /<nav aria-label="Client record"/);
    assert.deepEqual(current(html("recordLayoutBar")), ["/clients/c1?tab=tickets"], "the layout's bar follows ?tab=");
    assert.deepEqual(r.recordPrefetch, [false, false, false, false]);
    assert.deepEqual(r.recordWarm, ["prefetch /clients/c1?tab=tickets", "prefetch /clients/c1?tab=conversations"]);
    assert.deepEqual(r.recordClick, { cancelled: false, href: "/clients/c1?tab=tickets" });
    assert.doesNotMatch(html("record"), /aria-busy/);
    assert.match(html("recordPending"), /<span aria-busy="true">Money<span aria-hidden="true" class="absolute inset-x-0 -bottom-0\.5 h-0\.5 bg-accent"><\/span><\/span>/, "a pending tab shows the slim accent bar");

    // The list, on ?lifecycle=active: only the Active rows, no Past heading; counts beside the labels.
    assert.deepEqual(current(html("listActive")), ["/clients?lifecycle=active"]);
    assert.match(html("listActive"), /Alpha Active[\s\S]*Delta Active/);
    assert.doesNotMatch(html("listActive"), /Bravo Past|Charlie Prospect|Past clients/);
    assert.match(html("listActive"), />Active<span class="ml-1\.5 tabular-nums text-fg-dim">2<\/span>/);
    // All: current rows in the server's order, then Past under its heading.
    assert.deepEqual(current(html("listAll")), ["/clients"]);
    assert.match(html("listAll"), /Alpha Active[\s\S]*Charlie Prospect[\s\S]*Delta Active[\s\S]*Past clients[\s\S]*Bravo Past/);
    assert.match(html("listAll"), /<\/nav><form>FILTER-FORM<\/form>/, "the filter form keeps its place under the tabs");
    assert.match(html("listPaused"), /No clients with the status Paused\./);
    assert.match(html("listPausedFiltered"), /No clients match these filters\./);
    assert.match(html("listNone"), /<p>EMPTY-STATE<\/p>/, "no records at all: the page's own empty state");

    // A status click: cancelled navigation, the address bar written, no server and no warming; then Past's rows.
    assert.deepEqual(r.localPrefetch, [false, false, false, false, false, false]);
    assert.deepEqual(r.localWarmHandlers, [false, false, false, false, false, false], "nothing to warm: the rows are already here");
    assert.deepEqual(r.localClick, { cancelled: true, href: "/clients?lifecycle=churned" });
    assert.deepEqual(r.localHistory, ["/clients?lifecycle=churned"]);
    assert.deepEqual(r.localRouter, [], "a status click asks the server nothing");
    assert.deepEqual(current(html("listAfterClick")), ["/clients?lifecycle=churned"]);
    assert.match(html("listAfterClick"), /Bravo Past/);
    assert.doesNotMatch(html("listAfterClick"), /Alpha Active|Charlie Prospect|Delta Active/);

    // Mounted (its state kept from render to render): the click's own render
    // already shows Past, while the address bar still says Active.
    assert.equal(r.mountedSlots, 2, "the mount kept the list's view and the bar's click: the simulation engaged");
    assert.deepEqual(current(html("mountedStart")), ["/clients?lifecycle=active"]);
    assert.match(html("mountedStart"), /Alpha Active[\s\S]*Delta Active/);
    assert.deepEqual(r.mountedClick, { cancelled: true, href: "/clients?lifecycle=churned" });
    assert.deepEqual(r.mountedHistory, ["/clients?lifecycle=churned"], "the click writes the address bar");
    assert.deepEqual(r.mountedRouter, [], "and asks the server nothing");
    assert.deepEqual(current(html("mountedBeforeUrl")), ["/clients?lifecycle=churned"], "the click's own render underlines Past");
    assert.match(html("mountedBeforeUrl"), /Bravo Past/, "the click's own render shows Past's rows");
    assert.doesNotMatch(html("mountedBeforeUrl"), /Alpha Active|Delta Active/, "the click's own render still shows the tab it left");
    assert.match(html("mountedUrlLanded"), /Bravo Past/, "nothing moves when the address bar catches up");
    assert.doesNotMatch(html("mountedUrlLanded"), /Alpha Active|Delta Active/);
    assert.deepEqual(current(html("mountedBack")), ["/clients?lifecycle=active"], "Back is followed");
    assert.match(html("mountedBack"), /Alpha Active[\s\S]*Delta Active/);
    assert.doesNotMatch(html("mountedBack"), /Bravo Past/);

    // A list cut at its page size: the server's rows, and the tabs navigate (warmed on hover).
    assert.match(html("server"), /Charlie Prospect/);
    assert.deepEqual(current(html("server")), ["/clients?lifecycle=prospect"]);
    assert.deepEqual(r.serverClick, { cancelled: false, href: "/clients?lifecycle=active" });
    assert.deepEqual(r.serverHistory, []);
    assert.deepEqual(r.serverWarm, ["prefetch /clients?lifecycle=active"]);

    // The form carries the status; Clear shows while a status or a filter is on.
    assert.equal(html("fieldActive"), '<input type="hidden" name="lifecycle" value="active"/>');
    assert.equal(html("fieldAll"), "");
    assert.equal(html("clearNone"), "");
    assert.match(html("clearStatus"), /<a href="\/clients"[^>]*>Clear<\/a>/);
    assert.match(html("clearForm"), /<a href="\/clients"[^>]*>Clear<\/a>/);

    // The record header's Write to client: everywhere but the tab it opens.
    assert.match(html("writeOnOverview"), /<a href="\/clients\/c1\?tab=conversations"[^>]*>Write to client<\/a>/);
    assert.equal(html("writeOnConversations"), "");
  });

  finish("clients-tabs");
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
