/**
 * clients-hub.test.ts — the client record as the hub OASIS runs a client from.
 * Run: node --conditions=react-server --import tsx tests/clients-hub.test.ts
 *
 * Real migrations (183, bravo__186, bravo__188, bravo__190, bravo__191,
 * bravo__195, 180), real stores and real route handlers with real signed
 * sessions, on a local libSQL file with TWO kinds of workspace: OASIS (the
 * business, with its own clients) and client workspaces A and B (businesses
 * of their own). Pins, per the plan's acceptance list:
 *
 *   - Conversations shows only this client's messages (email, SMS, Slack) and
 *     never another client's or another workspace's, even at the same address;
 *   - the composer sends only through the workspace's OWN mailbox (OASIS: the
 *     OASIS mailbox; any other: the teammate's own), refuses with a clear
 *     sentence when there is none, asks for confirmation, and the sent message
 *     lands in the client's Conversations and thread;
 *   - an agent's draft becomes exactly ONE send_email approval;
 *   - Money reconciles to fin_payments to the cent;
 *   - opening a ticket adds an Activity row in the same request (ledger);
 *   - /tickets and /projects render with an incomplete assignment roster;
 *   - the Stripe import is idempotent and stores a name and an email only;
 *   - last touch is the latest activity, not updated_at; end engagement,
 *     link workspace (operator only) and usage are tenant-scoped.
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, type ReactNode } from "react";
import { CLIENT_A, CLIENT_B, OASIS, USERS, check, finish, login, setupDatabase, splitSql } from "./_delivery-harness";

type Json = Record<string, unknown>;

// The founders' finance gate (Money) admits OASIS's founders only when OASIS is
// on the founders allowlist, as in production.
process.env.FOUNDERS_TENANT_IDS = OASIS;

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
  },
} as unknown as NodeModule;

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

/**
 * The `title` of every host element (span, td, ...) a page actually RENDERS:
 * function components are rendered and only their output is walked, never
 * their props, so a row object handed to a table cannot answer for what the
 * cell shows.
 */
function renderedTitles(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) renderedTitles(v, out, seen);
    return out;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (!el.$$typeof || !el.props) return out;
  if (typeof el.type === "function") {
    try {
      const rendered = (el.type as (p: unknown) => unknown)(el.props);
      if (!(rendered instanceof Promise)) renderedTitles(rendered, out, seen);
    } catch {
      // A client component renders in the browser. The server-rendered
      // ELEMENTS it is handed (the Clients list's rows, which it shows by
      // status) reach the page as rendered here, so those are walked; plain
      // data among its props is not an element and is skipped below.
      for (const v of Object.values(el.props)) renderedTitles(v, out, seen);
    }
    return out;
  }
  if (typeof el.props.title === "string") out.push(el.props.title);
  renderedTitles(el.props.children, out, seen);
  return out;
}

/** The first element of `type` anywhere in a page's element tree (props and children), not rendering anything. */
function findElement(node: unknown, type: unknown, seen = new Set<unknown>()): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  const kids = Array.isArray(node) ? node : (node as { $$typeof?: symbol }).$$typeof ? null : Object.values(node as object);
  if (kids) {
    for (const v of kids) {
      const found = findElement(v, type, seen);
      if (found) return found;
    }
    return null;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type === type && el.props) return el as { props: Record<string, unknown> };
  return el.props ? findElement(Object.values(el.props), type, seen) : null;
}

const MIG = (f: string) => readFileSync(join(__dirname, "..", "database", "turso", f), "utf8");
const MEMBER_A = { id: "0d000000-0000-4000-8000-0000000000a2", email: "helper@client-a.test" };
// An OASIS admin who runs the desk but is NOT one of the founders who may open
// Money (lib/founders-finances/access.ts FINANCE_OWNER_EMAILS).
const OPS_ADMIN = { id: "0d000000-0000-4000-8000-0000000000f5", email: "ops-admin@oasis-ops.test" };
const LEAD_X = "1ead0000-0000-4000-8000-00000000000a";
const T0 = new Date("2026-09-30T12:00:00.000Z");
const ago = (days: number) => new Date(T0.getTime() - days * 86_400_000).toISOString();

async function main() {
  const db = await setupDatabase();
  for (const f of ["bravo__188_os_customers.sql", "bravo__195_customers_links.sql"]) {
    for (const stmt of splitSql(MIG(f))) await db.execute(stmt);
  }
  await db.executeMultiple(MIG("bravo__186_os_approvals.sql"));
  await db.executeMultiple(MIG("bravo__191_agent_turn_outcomes.sql"));
  await db.executeMultiple(MIG("180_founders_finances.turso.sql"));
  // Production shapes (schema export) of the tables this hub reads.
  await db.executeMultiple(`
    CREATE TABLE conversation_threads (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, thread_key TEXT NOT NULL, lead_id TEXT,
      contact_phone_e164 TEXT, contact_email TEXT, contact_label TEXT, owner_agent_id TEXT, assigned_to TEXT,
      status TEXT NOT NULL DEFAULT 'open', priority TEXT, last_message_at TEXT, last_inbound_at TEXT,
      last_outbound_at TEXT, last_direction TEXT, last_preview TEXT, unread_count INTEGER NOT NULL DEFAULT 0,
      channel_summary TEXT NOT NULL DEFAULT '{}', sources TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]',
      snoozed_until TEXT, last_read_at TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE UNIQUE INDEX conversation_threads_tenant_id_thread_key_key ON conversation_threads (tenant_id, thread_key);
    CREATE TABLE conversation_events (
      id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, thread_id TEXT, lead_id TEXT, event_type TEXT NOT NULL,
      actor_user_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
    CREATE TABLE client_roi_snapshots (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      snapshot_date TEXT NOT NULL, messages_handled INTEGER DEFAULT 0, leads_processed INTEGER DEFAULT 0,
      hours_saved_est REAL DEFAULT 0, avg_response_sec INTEGER DEFAULT 0, ai_actions_taken INTEGER DEFAULT 0,
      custom_metrics_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), UNIQUE(tenant_id, snapshot_date));
    CREATE TABLE lead_documents (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, filename TEXT, mime_type TEXT,
      size_bytes INTEGER, doc_type TEXT, storage_path TEXT, uploaded_by TEXT, uploaded_at TEXT, metadata TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
    INSERT INTO fin_entities (id, slug, name, kind) VALUES ('fin_ent_oasis', 'oasis', 'OASIS AI Solutions', 'business');
  `);
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  for (const [id, tenant, slug] of [["m-o", OASIS, "oasis-ai-cc"], ["m-a", CLIENT_A, "client-a"], ["m-b", CLIENT_B, "client-b"]] as const) {
    await db.execute({
      sql: "INSERT INTO tenant_manifests VALUES (?, ?, ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
      args: [id, tenant, slug, JSON.stringify(parseManifest(finalizeManifestFromWizard({ template: "custom", slug, answers: {} })))],
    });
  }
  await db.batch(
    [
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [MEMBER_A.id, MEMBER_A.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES (?, ?, ?, ?, 'member', 0, '2026-09-01T00:00:00Z', 'Helper', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [`p-${MEMBER_A.id}`, MEMBER_A.id, MEMBER_A.email, CLIENT_A],
      },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [OPS_ADMIN.id, OPS_ADMIN.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES (?, ?, ?, ?, 'admin', 0, '2026-09-01T00:00:00Z', 'Ops Admin', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [`p-${OPS_ADMIN.id}`, OPS_ADMIN.id, OPS_ADMIN.email, OASIS],
      },
      // The deal OASIS's client X came from.
      {
        sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
        args: [LEAD_X, OASIS, JSON.stringify({ stage: "launched", company: "Breeze Test Co", name: "Pat Test", email: "x@breeze.test" })],
      },
    ],
    "write",
  );

  const store = await import("../lib/os/customers/store");
  const conversations = await import("../lib/os/customers/conversations");
  const activity = await import("../lib/os/customers/activity");
  const money = await import("../lib/os/customers/money");
  const usage = await import("../lib/os/customers/usage");
  const sync = await import("../lib/os/customers/stripe-sync");
  const notify = await import("../lib/delivery/notify");
  const deliveryStore = await import("../lib/delivery/store");
  const { NextRequest } = await import("next/server");
  const replyRoute = await import("../app/api/clients/[id]/reply/route");
  const linkRoute = await import("../app/api/clients/[id]/link-workspace/route");
  const endRoute = await import("../app/api/clients/[id]/end-engagement/route");
  const tickets = await import("../app/api/tickets/route");
  const comments = await import("../app/api/tickets/[id]/comments/route");
  const ticketRoute = await import("../app/api/tickets/[id]/route");
  const customerRoute = await import("../app/api/customers/[id]/route");

  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (p: Promise<Response>) => {
    const res = await p;
    return { status: res.status, body: (await res.json()) as Json };
  };
  const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
  const count = async (sql: string, args: unknown[] = []) => Number((await db.execute({ sql, args: args as never })).rows[0].n);
  const base = { company_name: null, primary_phone: null, lifecycle: "active" as const, owner_user_id: null, stripe_customer_id: null, tags: [], custom_fields: {} };

  // ── fixtures: OASIS's clients X and Y, and client workspace A's own client at X's address ──
  console.log("clients-hub:");
  const convert = await store.convertLeadToCustomer(db, OASIS, LEAD_X, USERS.cc.id, new Date(ago(40)));
  assert.ok(convert.ok);
  const X = convert.customer;
  await store.updateCustomer(db, OASIS, X.id, { stripe_customer_id: "cus_X" }, new Date(ago(39)), USERS.cc.id);
  const pat = await store.addContact(db, OASIS, X.id, { name: "Pat Contact", email: "pat@breeze.test", phone: "+15145550100", role: null }, new Date(ago(39)));
  assert.ok(pat);
  const Yr = await store.createCustomer(db, OASIS, { ...base, display_name: "Other Client", primary_email: "y@other.test" }, USERS.cc.id, new Date(ago(30)));
  assert.ok(Yr.ok);
  const Y = Yr.customer;
  const Ar = await store.createCustomer(db, CLIENT_A, { ...base, display_name: "Acme Same Address", primary_email: "x@breeze.test" }, USERS.clientA.id, new Date(ago(30)));
  assert.ok(Ar.ok);
  const A = Ar.customer;

  const li = (id: string, tenant: string, f: Json) => ({
    sql: `INSERT INTO lead_interactions (id, tenant_id, lead_id, type, channel, direction, subject, content_preview, to_email, from_email, to_phone, created_at, metadata)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, tenant, f.lead_id ?? null, f.type ?? "email", f.channel ?? "email", f.direction ?? "outbound", f.subject ?? null, f.preview, f.to_email ?? null, f.from_email ?? null, f.to_phone ?? null, f.at, f.metadata ?? "{}"],
  });
  const slack = (id: string, tenant: string, customerId: string, text: string, at: string) => ({
    sql: "INSERT INTO conversation_events (id, tenant_id, event_type, metadata, created_at) VALUES (?, ?, 'message', ?, ?)",
    args: [id, tenant, JSON.stringify({ channel: "slack", customer_id: customerId, text, direction: "inbound", author_name: "Pat" }), at],
  });
  await db.batch(
    [
      li("li-x-deal", OASIS, { lead_id: LEAD_X, direction: "inbound", preview: "X-DEAL-EMAIL", from_email: "x@breeze.test", at: ago(20) }),
      li("li-x-contact", OASIS, { preview: "X-CONTACT-EMAIL", to_email: "Pat@Breeze.test", at: ago(15) }),
      li("li-x-sms", OASIS, { channel: "sms", type: "sms_sent", preview: "X-SMS", to_phone: "+15145550100", at: ago(10) }),
      li("li-x-note", OASIS, { lead_id: LEAD_X, channel: "note", type: "note", preview: "X-INTERNAL-NOTE", at: ago(9) }),
      li("li-y", OASIS, { preview: "Y-EMAIL", to_email: "y@other.test", at: ago(8) }),
      li("li-a", CLIENT_A, { preview: "A-TENANT-EMAIL", to_email: "x@breeze.test", at: ago(7) }),
      slack("ce-x", OASIS, X.id, "X-SLACK", ago(5)),
      slack("ce-y", OASIS, Y.id, "Y-SLACK", ago(5)),
      slack("ce-a-forged", CLIENT_A, X.id, "A-SLACK-NAMING-X", ago(5)),
    ],
    "write",
  );

  // ── Conversations ──────────────────────────────────────────────────────────
  await check("Conversations: only this client's email, SMS and Slack, oldest first; never another client's or another workspace's", async () => {
    const contacts = await store.listContacts(db, OASIS, X.id);
    const c = await conversations.loadClientConversation(db, OASIS, X, contacts);
    const previews = c.messages.map((m) => m.preview);
    assert.deepEqual(previews, ["X-DEAL-EMAIL", "X-CONTACT-EMAIL", "X-SMS", "X-SLACK"]);
    assert.deepEqual(c.messages.map((m) => m.channel), ["email", "email", "sms", "slack"]);
    const other = await conversations.loadClientConversation(db, CLIENT_A, A, []);
    assert.deepEqual(other.messages.map((m) => m.preview), ["A-TENANT-EMAIL"], "workspace A at the same address sees only its own");
  });
  const ClientRecordPage = (await import("../app/clients/[id]/page")).default;
  const ClientRecordLayout = (await import("../app/clients/[id]/layout")).default;
  const ClientsPage = (await import("../app/clients/page")).default;
  const clientsStatus = await import("../components/os/landings/clients-status");
  // The record as Next draws it: the layout (header, tab bar) around the open
  // tab. The tab renders first: a tab switch renders it alone, so it must
  // refuse on its own.
  const record = async (id: string, tab?: string) => {
    const body = await ClientRecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) });
    return ClientRecordLayout({ params: Promise.resolve({ id }), children: body as never });
  };
  const page = async (el: Promise<unknown>) => textOf(await el).join("\n");
  const is404 = async (el: Promise<unknown>) => {
    try {
      await el;
      return false;
    } catch (err) {
      return /NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message);
    }
  };
  await login(USERS.cc);
  await check("the record shows Conversations, Money, Usage, Activity and Health tabs; Conversations carries only X's thread", async () => {
    const t = await page(record(X.id, "conversations"));
    for (const tab of ["Conversations", "Money", "Usage", "Activity", "Health"]) assert.match(t, new RegExp(tab));
    assert.match(t, /X-DEAL-EMAIL/);
    assert.match(t, /X-SLACK/);
    assert.doesNotMatch(t, /Y-EMAIL|Y-SLACK|A-TENANT-EMAIL|A-SLACK|X-INTERNAL-NOTE/);
    assert.match(t, /Sends as OASIS support mail \(from support@oasisai\.work once it is configured, else the OASIS mailbox\)/);
    assert.match(t, /the client's reply goes to support@oasisai\.work/);
    assert.doesNotMatch(t, /mailto:/, "the record writes from the app, not a mailto link");
  });
  // A tab click renders the PAGE alone; a first load runs page and layout side
  // by side. Each must refuse on its own: rendered together, the layout's own
  // 404 would hide a page that leaked.
  const pageAlone = (id: string, tab?: string) =>
    ClientRecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) });
  const layoutAlone = (id: string) => ClientRecordLayout({ params: Promise.resolve({ id }), children: null as never });
  const EVERY_TAB = [undefined, "conversations", "tickets", "projects", "money", "usage", "activity", "health", "files"] as const;
  await check("control: OASIS's founder gets X's page alone on every tab, and its layout alone", async () => {
    for (const tab of EVERY_TAB) await assert.doesNotReject(pageAlone(X.id, tab), `page ${tab ?? "overview"}`);
    assert.match(await page(layoutAlone(X.id)), /Breeze Test Co/);
  });
  await login(USERS.clientA);
  await check("another workspace's client record is a 404 from the page alone on every tab and from the layout alone, before anything of it is read", async () => {
    for (const tab of EVERY_TAB) assert.equal(await is404(pageAlone(X.id, tab)), true, `page ${tab ?? "overview"}`);
    assert.equal(await is404(layoutAlone(X.id)), true, "layout");
    assert.equal(await is404(record(X.id, "conversations")), true, "and together");
  });

  // ── The composer ───────────────────────────────────────────────────────────
  const sentMsg = { subject: "Your launch", body: "HELLO-FROM-RECORD" };
  await login(USERS.cc);
  await check("reply route: a person's send needs confirmation; nothing is sent or recorded without it", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM lead_interactions");
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, sentMsg), params({ id: X.id })));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "confirmation_required");
    assert.equal(await count("SELECT COUNT(*) AS n FROM lead_interactions"), before);
  });
  await check("reply route: OASIS with no OASIS mailbox configured refuses in a sentence, and records nothing", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM lead_interactions");
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: X.id })));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "oasis_mailbox_not_configured");
    assert.match(String(r.body.message), /OASIS mailbox is not configured/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM lead_interactions"), before);
  });
  await check("reply route: only the client's own addresses can be written to", async () => {
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, { ...sentMsg, confirmed: true, to: "someone@else.test" }), params({ id: X.id })));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "to_not_this_client");
  });
  await login(USERS.clientA);
  await check("reply route (real brandForTenant): a client workspace with no registered sender identity is refused as THAT, never told to connect a mailbox", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM lead_interactions");
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${A.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: A.id })));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "no_sender_identity");
    assert.match(String(r.body.message), /no registered business identity to send client email as, so nothing was sent/);
    assert.doesNotMatch(String(r.body.message), /Connect your own mailbox/, "connecting a mailbox cannot fix this, so it is not the advice");
    assert.equal(await count("SELECT COUNT(*) AS n FROM lead_interactions"), before);
    assert.equal((await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: X.id })))).status, 404, "OASIS's client is not A's");
  });
  await check("the record says a workspace without a sender identity cannot send yet, before anyone writes", async () => {
    assert.match(await page(record(A.id, "conversations")), /Email can't be sent from this workspace yet: it has no registered business identity/);
    await login(USERS.cc);
    assert.doesNotMatch(await page(record(X.id, "conversations")), /Email can't be sent from this workspace yet/, "OASIS sends from the OASIS mailbox");
    await login(USERS.clientA);
  });
  await login(MEMBER_A);
  await check("reply route: a member below owner/admin may not write to clients", async () => {
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${A.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: A.id })));
    assert.equal(r.status, 403);
  });
  await check("reply route: a desk viewer who may not act (canAct false) is refused before anything is sent or recorded", async () => {
    // No persona pairs the desk with canAct:false today; the route's gate must
    // still hold if the capability matrix ever does (a read-only founder view).
    const surfaces = await import("../lib/role-surfaces");
    const founder = surfaces.SURFACE_CAPABILITIES.founder;
    (surfaces.SURFACE_CAPABILITIES as Record<string, unknown>).founder = { ...founder, canAct: false };
    try {
      await login(USERS.cc);
      const before = await count("SELECT COUNT(*) AS n FROM lead_interactions");
      const r = await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: X.id })));
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(r.body.error, "forbidden");
      assert.equal(await count("SELECT COUNT(*) AS n FROM lead_interactions"), before);
    } finally {
      (surfaces.SURFACE_CAPABILITIES as Record<string, unknown>).founder = founder;
    }
  });

  type Call = { kind: string; args: Json };
  const fakeDeps = (over: Partial<import("../lib/os/customers/conversations").MailboxDeps> = {}) => {
    const calls: Call[] = [];
    const deps: import("../lib/os/customers/conversations").MailboxDeps = {
      oasisTenantId: OASIS,
      killSwitch: () => false,
      oasisMailboxFrom: async () => "team@oasis.test",
      sendOasis: async (a) => {
        calls.push({ kind: "oasis", args: a as unknown as Json });
        return { ok: true, provider: "oasis_shared_gmail", gmail_message_id: `gm-${calls.length}`, from_address: "team@oasis.test" };
      },
      operatorMailbox: async () => null,
      sendAsOperator: async (kind, a) => {
        calls.push({ kind: `operator:${kind}`, args: a as unknown as Json });
        return { ok: true, provider: "gmail_apppassword", gmail_message_id: `op-${calls.length}`, from_address: "owner@client-a.test" };
      },
      brandFor: async () => null,
      signerFor: () => null,
      ...over,
    };
    return { deps, calls };
  };
  const reply = (customer: typeof X, contacts: Parameters<typeof conversations.clientAddresses>[1], body: Json) => {
    const v = conversations.validateClientReply(body, conversations.clientAddresses(customer, contacts));
    assert.ok(v.ok, JSON.stringify(v));
    return v.value;
  };

  await check("send: OASIS's client goes out through the OASIS mailbox only, and appears in Conversations and its thread", async () => {
    const { deps, calls } = fakeDeps();
    const contacts = await store.listContacts(db, OASIS, X.id);
    const r = await conversations.sendClientEmail(db, deps, {
      tenantId: OASIS,
      userId: USERS.cc.id,
      userEmail: USERS.cc.email,
      customer: X,
      reply: reply(X, contacts, { ...sentMsg, confirmed: true }),
      now: T0,
    });
    assert.equal(r.ok && r.status, "sent", JSON.stringify(r));
    assert.deepEqual(calls.map((c) => c.kind), ["oasis"]);
    assert.equal(calls[0].args.tenantId, OASIS);
    assert.equal(calls[0].args.to, "x@breeze.test");
    assert.deepEqual(calls[0].args.cc, [USERS.cc.email], "the sender is copied");
    const after = await conversations.loadClientConversation(db, OASIS, X, contacts);
    assert.equal(after.messages.at(-1)?.preview, "HELLO-FROM-RECORD");
    const thread = (await db.execute({ sql: "SELECT tenant_id, last_direction, last_preview FROM conversation_threads WHERE thread_key = ?", args: [`lead:${LEAD_X}`] })).rows[0];
    assert.equal(thread.tenant_id, OASIS);
    assert.equal(thread.last_direction, "outbound");
    assert.equal(thread.last_preview, "HELLO-FROM-RECORD");
  });
  await check("send: another workspace uses ITS OWN connected mailbox, never OASIS's; no identity or no mailbox is refused, each in its own words", async () => {
    // No registered sender identity: refused as such, EVEN WITH a mailbox connected.
    const noIdentity = fakeDeps({ brandFor: async () => null, operatorMailbox: async () => "app_password" });
    const refused = await conversations.sendClientEmail(db, noIdentity.deps, {
      tenantId: CLIENT_A, userId: USERS.clientA.id, userEmail: USERS.clientA.email, customer: A, reply: reply(A, [], { ...sentMsg, confirmed: true }), now: T0,
    });
    assert.deepEqual(refused, { ok: false, status: 409, error: "no_sender_identity" });
    assert.equal(noIdentity.calls.length, 0);
    // A workspace WITH an identity (as SunBiz's own is, lib/email/brand-for-tenant.ts) but no mailbox of the teammate's own.
    const noOwn = fakeDeps({ brandFor: async () => "sunbiz" });
    const refused2 = await conversations.sendClientEmail(db, noOwn.deps, {
      tenantId: CLIENT_A, userId: USERS.clientA.id, userEmail: USERS.clientA.email, customer: A, reply: reply(A, [], { ...sentMsg, confirmed: true }), now: T0,
    });
    assert.deepEqual(refused2, { ok: false, status: 409, error: "no_mailbox" });
    assert.equal(noOwn.calls.length, 0);
    const own = fakeDeps({ brandFor: async () => "sunbiz", operatorMailbox: async () => "app_password" });
    const sent = await conversations.sendClientEmail(db, own.deps, {
      tenantId: CLIENT_A, userId: USERS.clientA.id, userEmail: USERS.clientA.email, customer: A, reply: reply(A, [], { ...sentMsg, confirmed: true }), now: T0,
    });
    assert.equal(sent.ok && sent.status, "sent");
    assert.deepEqual(own.calls.map((c) => c.kind), ["operator:app_password"]);
    assert.equal(own.calls[0].args.tenantId, CLIENT_A);
    assert.equal(own.calls[0].args.brand, "sunbiz");
    const aMsgs = await conversations.loadClientConversation(db, CLIENT_A, A, []);
    assert.equal(aMsgs.messages.at(-1)?.preview, "HELLO-FROM-RECORD");
    const xMsgs = await conversations.loadClientConversation(db, OASIS, X, await store.listContacts(db, OASIS, X.id));
    assert.equal(xMsgs.messages.filter((m) => m.preview === "HELLO-FROM-RECORD").length, 1, "A's send is not in OASIS's client thread");
  });
  await check("send: the kill switch answers dry run after every check, and records nothing", async () => {
    const { deps, calls } = fakeDeps({ killSwitch: () => true });
    const before = await count("SELECT COUNT(*) AS n FROM lead_interactions");
    const r = await conversations.sendClientEmail(db, deps, {
      tenantId: OASIS, userId: USERS.cc.id, userEmail: USERS.cc.email, customer: X, reply: reply(X, [], { ...sentMsg, confirmed: true }), now: T0,
    });
    assert.equal(r.ok && r.status, "dry_run");
    assert.equal(calls.length, 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM lead_interactions"), before);
  });
  await check("send: a send the server could not confirm is recorded as delivery unknown, never as sent", async () => {
    const { deps } = fakeDeps({
      sendOasis: async () => ({ ok: false, provider: "oasis_shared_gmail", reason: "delivery_unknown", error: "timeout" }),
    });
    const r = await conversations.sendClientEmail(db, deps, {
      tenantId: OASIS, userId: USERS.cc.id, userEmail: USERS.cc.email, customer: X, reply: reply(X, [], { subject: "S", body: "UNSURE-SEND", confirmed: true }), now: T0,
    });
    assert.equal(r.ok && r.status, "delivery_unknown");
    const row = (await db.execute("SELECT type FROM lead_interactions WHERE content = 'UNSURE-SEND'")).rows[0];
    assert.equal(row.type, "email_delivery_unknown");
  });
  await check("the thread marks an unconfirmed send 'Delivery unconfirmed' from its row, long after the one-off notice (tests/clients-hub.render.ts)", async () => {
    const thread = await conversations.loadClientConversation(db, OASIS, X, await store.listContacts(db, OASIS, X.id));
    const unsure = thread.messages.find((m) => m.preview === "UNSURE-SEND");
    const sent = thread.messages.find((m) => m.preview === "HELLO-FROM-RECORD");
    assert.ok(unsure && sent, "both sends are in the thread");
    assert.equal(unsure!.type, "email_delivery_unknown");
    // The render needs whole React: drop the suite's react-server condition.
    const nodeOptions = (process.env.NODE_OPTIONS || "")
      .split(/\s+/)
      .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
      .join(" ");
    const env = { ...process.env, NODE_OPTIONS: nodeOptions };
    if (!nodeOptions) delete env.NODE_OPTIONS;
    const out = spawnSync(process.execPath, ["--import", "tsx", "tests/clients-hub.render.ts"], {
      encoding: "utf8",
      env,
      input: JSON.stringify([sent, unsure]),
    });
    assert.equal(out.status, 0, `the render helper exited ${out.status}:\n${out.stderr}`);
    const html = (JSON.parse(out.stdout) as { thread: string }).thread;
    const bubble = (id: string) => {
      const start = html.indexOf(`data-message-id="${id}"`);
      assert.ok(start >= 0, `bubble ${id} is drawn`);
      const next = html.indexOf("data-message-id=", start + 1);
      return html.slice(start, next < 0 ? undefined : next);
    };
    assert.match(bubble(unsure!.id), /Delivery unconfirmed/, "the unconfirmed send says so");
    assert.doesNotMatch(bubble(sent!.id), /Delivery unconfirmed/, "a confirmed send does not");
  });

  // ── An agent's draft ───────────────────────────────────────────────────────
  await login(USERS.cc);
  const agentDraft = { subject: "Check-in", body: "AGENT-DRAFT", drafted_by: "agent", drafted_by_agent: "client-success" };
  await check("reply route: a signed-in person cannot file a draft AS an agent; nothing is created", async () => {
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, agentDraft), params({ id: X.id })));
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error, "agent_drafts_not_from_a_session");
    assert.equal(await count("SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ?", [OASIS]), 0);
  });
  await check("an agent's draft (server-side, the agent runtime) creates exactly ONE send_email approval, and is never sent", async () => {
    const draft = reply(X, [], agentDraft);
    const r1 = await conversations.proposeClientEmail(db, { tenantId: OASIS, tenantSlug: "oasis-ai-cc", customer: X, reply: draft, now: T0 });
    assert.ok(r1.ok && r1.created, JSON.stringify(r1));
    const r2 = await conversations.proposeClientEmail(db, { tenantId: OASIS, tenantSlug: "oasis-ai-cc", customer: X, reply: draft, now: T0 });
    assert.ok(r2.ok && !r2.created, "the same draft is the same approval");
    const row = (await db.execute({ sql: "SELECT requested_by_type, requested_by_id, action_kind FROM approvals WHERE tenant_id = ? AND target_ref = ?", args: [OASIS, `customer:${X.id}`] })).rows;
    assert.equal(row.length, 1);
    assert.deepEqual([row[0].requested_by_type, row[0].requested_by_id, row[0].action_kind], ["agent", "client-success", "send_email"]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM lead_interactions WHERE content = 'AGENT-DRAFT'"), 0);
    const c = await conversations.loadClientConversation(db, OASIS, X, []);
    assert.deepEqual(c.drafts.map((d) => [d.status, d.subject]), [["pending", "Check-in"]]);
  });
  await check("an agent's draft in a workspace whose approved email could never go out is not proposed at all", async () => {
    const r = await conversations.proposeClientEmail(db, { tenantId: CLIENT_A, tenantSlug: "client-a", customer: A, reply: reply(A, [], agentDraft), now: T0 });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.error, "workspace_cannot_send_email");
    assert.match(String(!r.ok && "message" in r ? r.message : ""), /no email sender set up/);
    assert.equal(await count("SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ?", [CLIENT_A]), 0);
  });

  // ── Money ──────────────────────────────────────────────────────────────────
  const pay = (id: string, f: Json) => ({
    sql: `INSERT INTO fin_payments (id, entity_id, kind, source, occurred_at, occurred_on, amount_cents, currency, parent_payment_id,
            customer_name, customer_email, stripe_customer_id, livemode, created_by)
          VALUES (?, 'fin_ent_oasis', ?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test')`,
    args: [id, f.kind ?? "payment", f.at, String(f.at).slice(0, 10), f.cents, f.cur ?? "CAD", f.parent ?? null, f.name ?? "", f.email ?? "", f.stripe ?? null, f.live ?? 1],
  });
  await db.batch(
    [
      pay("p1", { cents: 10000, stripe: "cus_X", name: "Breeze Test Co", email: "x@breeze.test", at: ago(60) }),
      pay("p2", { cents: 2550, stripe: "cus_X", at: ago(30) }),
      pay("r1", { kind: "refund", cents: 1000, parent: "p2", at: ago(29) }),
      pay("p3", { cents: 5000, cur: "USD", stripe: "cus_X", at: ago(20) }),
      pay("p4", { cents: 1234, email: "X@Breeze.test", at: ago(10) }),
      pay("p-test", { cents: 99999, stripe: "cus_X", live: 0, at: ago(5) }),
      pay("p-y", { cents: 7777, stripe: "cus_Y", name: "Other Client", email: "y@other.test", at: ago(5) }),
      {
        sql: `INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents, current_period_end, cancel_at_period_end)
              VALUES ('sub-x', 'fin_ent_oasis', 'cus_X', 'Breeze Test Co', 'x@breeze.test', 'active', 'CAD', 10000, ?, 0)`,
        args: [Math.floor(new Date("2026-10-15T00:00:00Z").getTime() / 1000)],
      },
      {
        sql: `INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents, current_period_end, cancel_at_period_end)
              VALUES ('sub-x-old', 'fin_ent_oasis', 'cus_X', '', '', 'canceled', 'CAD', 20000, ?, 0)`,
        args: [Math.floor(new Date("2026-06-01T00:00:00Z").getTime() / 1000)],
      },
      { sql: "INSERT INTO fin_contacts (id, entity_id, kind, name, email, stripe_customer_id) VALUES ('fc-x', 'fin_ent_oasis', 'customer', 'Breeze Test Co', 'x@breeze.test', 'cus_X')", args: [] },
      {
        sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, number, status, issue_date, due_date, currency, total_cents, amount_paid_cents, created_by)
              VALUES ('inv-x-1', 'fin_ent_oasis', 'fc-x', 'INV-0001', 'sent', '2026-08-15', '2026-09-01', 'CAD', 30000, 10000, 'test')`,
        args: [],
      },
      {
        sql: `INSERT INTO fin_invoices (id, entity_id, contact_id, number, status, issue_date, due_date, currency, total_cents, amount_paid_cents, created_by)
              VALUES ('inv-x-2', 'fin_ent_oasis', 'fc-x', 'INV-0002', 'paid', '2026-07-01', '2026-07-15', 'CAD', 10000, 10000, 'test')`,
        args: [],
      },
    ],
    "write",
  );
  await check("Money reconciles to fin_payments to the cent (payments minus refunds, live only, per currency)", async () => {
    const xNow = (await store.getCustomer(db, OASIS, X.id))!;
    const m = await money.loadClientMoney(db, xNow, "2026-09-30");
    assert.ok(m);
    const ledger = (await db.execute(
      `SELECT currency, SUM(CASE kind WHEN 'refund' THEN -amount_cents ELSE amount_cents END) AS cents
       FROM fin_payments WHERE id IN ('p1', 'p2', 'r1', 'p3', 'p4') GROUP BY currency ORDER BY currency`,
    )).rows.map((r) => ({ currency: String(r.currency), cents: Number(r.cents) }));
    assert.deepEqual(m!.collected, ledger);
    assert.deepEqual(m!.collected, [{ currency: "CAD", cents: 12784 }, { currency: "USD", cents: 5000 }]);
    assert.equal(m!.paymentCount, 4);
    assert.equal(m!.refundCount, 1);
    assert.deepEqual(m!.mrr, [{ currency: "CAD", cents: 10000 }], "the canceled subscription is not revenue");
    assert.equal(m!.nextRenewal, "2026-10-15T00:00:00.000Z");
    assert.equal(m!.overdueInvoices, 1);
    assert.deepEqual(m!.outstanding, [{ currency: "CAD", cents: 20000 }]);
    assert.deepEqual(m!.invoices.map((i) => [i.number, i.overdue]), [["INV-0001", true], ["INV-0002", false]]);
  });
  await check("Money tab: the founder sees the reconciled figures; a client with nothing to match says so, never zeros", async () => {
    await login(USERS.cc);
    const t = await page(record(X.id, "money"));
    assert.match(t, /CAD 127\.84/);
    assert.match(t, /USD 50\.00/);
    assert.match(t, /INV-0001/);
    const bare = await store.createCustomer(db, OASIS, { ...base, display_name: "No Books Co", primary_email: null }, USERS.cc.id, new Date(ago(2)));
    assert.ok(bare.ok);
    assert.equal(await money.loadClientMoney(db, bare.customer, "2026-09-30"), null);
    assert.match(await page(record(bare.customer.id, "money")), /not linked to the books yet/);
    // The same client's HEALTH: money that cannot be looked up is unknown, never "nothing overdue".
    const { moneySignalsFor } = await import("../lib/os/customers/health");
    assert.equal((await moneySignalsFor(db, [bare.customer], "2026-09-30")).has(bare.customer.id), false, "no signals are invented for it");
    const health = await page(record(bare.customer.id, "health"));
    assert.match(health, /Not known: payments and invoices/);
    assert.doesNotMatch(health, /\bHealthy\b/);
  });
  await check("Money is for the founders who may open Money: an OASIS admin on the desk gets 'not allowed', never the figures", async () => {
    await login(OPS_ADMIN);
    const t = await page(record(X.id, "money"));
    assert.match(t, /A client.{1,8}s money is for the founders who can open Money/);
    assert.doesNotMatch(t, /CAD 127\.84|INV-0001/);
    await login(USERS.cc);
  });

  // ── Activity ───────────────────────────────────────────────────────────────
  await check("opening a ticket adds an Activity row in the same request; first reply and resolution follow", async () => {
    await login(USERS.cc);
    const t = await call(tickets.POST(req("POST", "/api/tickets?scope=desk", { title: "Portal login broken", customer_id: X.id, severity: "high" })));
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const id = String(t.body.id);
    const a1 = await activity.loadClientActivity(db, OASIS, (await store.getCustomer(db, OASIS, X.id))!);
    const opened = a1.entries.find((e) => e.label === "Support ticket opened");
    assert.ok(opened, JSON.stringify(a1.entries.map((e) => e.label)));
    assert.equal(opened!.href, `/tickets/${id}`);
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'ticket.opened' AND customer_id = ? AND subject_id = ?", [X.id, id]), 1);
    const c = await call(comments.POST(req("POST", `/api/tickets/${id}/comments?scope=desk`, { body: "On it.", is_internal: false }), params({ id })));
    assert.ok(c.status === 200 || c.status === 201, JSON.stringify(c.body));
    const res = await call(ticketRoute.PATCH(req("PATCH", `/api/tickets/${id}?scope=desk`, { status: "resolved" }), params({ id })));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const labels = (await activity.loadClientActivity(db, OASIS, (await store.getCustomer(db, OASIS, X.id))!)).entries.map((e) => e.label);
    assert.ok(labels.includes("First reply sent on a ticket"), labels.join(", "));
    assert.ok(labels.includes("Support ticket resolved"), labels.join(", "));
    assert.ok(labels.includes("Became a client record"));
  });
  await check("Activity: the books' Stripe payment and refund events appear for the founders, found through the client's fin_payments", async () => {
    // What lib/founders-finances/stripe-ingest.ts writes: subject = the fin_payments row, no customer_id.
    const row = (id: string, key: string, subjectType: string, subjectId: string, cents: number, at: string) => ({
      sql: `INSERT INTO outcome_events (id, tenant_id, event_key, event_version, occurred_at, recorded_at, subject_type, subject_id,
              department_key, actor_type, source, idempotency_key, payload_hash, value_cents, currency, confidence, payload_json, producer)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, 'finance', 'external', 'stripe', ?, 'h', ?, 'CAD', 'verified', '{}', 'lib/founders-finances/stripe-ingest.ts')`,
      args: [id, OASIS, key, at, at, subjectType, subjectId, `stripe:${id}`, cents, at],
    });
    await db.batch(
      [
        row("01LEDGERPAYX0000000000001", "payment.received", "payment", "p2", 2550, ago(30)),
        row("01LEDGERREFX0000000000001", "refund.issued", "refund", "r1", 1000, ago(29)),
        row("01LEDGERPAYY0000000000001", "payment.received", "payment", "p-y", 7777, ago(5)),
      ],
      "write",
    );
    const xNow = (await store.getCustomer(db, OASIS, X.id))!;
    const withBooks = await activity.loadClientActivity(db, OASIS, xNow, { books: true });
    const money = withBooks.entries.filter((e) => /Payment received|Refund issued/.test(e.label)).map((e) => `${e.label}: ${e.detail}`);
    assert.deepEqual(money.sort(), ["Payment received: CAD 25.50", "Refund issued: CAD 10.00"], `Y's payment is not X's: ${JSON.stringify(money)}`);
    const withoutBooks = await activity.loadClientActivity(db, OASIS, xNow);
    assert.equal(withoutBooks.entries.some((e) => /Payment received/.test(e.label)), false, "no books, no payments");
    await login(USERS.cc);
    assert.match(await page(record(X.id, "activity")), /Payment received/);
  });
  await check("Activity: without the books, NO finance event is read, whichever column names the client (T5's contact_id = cus_, or customer_id)", async () => {
    // T5's contract: payment.received / refund.issued carry contact_id = the Stripe customer.
    const ev = (id: string, key: string, cols: { contact_id?: string; customer_id?: string }, cents: number, at: string) => ({
      sql: `INSERT INTO outcome_events (id, tenant_id, event_key, event_version, occurred_at, recorded_at, subject_type, subject_id,
              contact_id, customer_id, department_key, actor_type, source, idempotency_key, payload_hash, value_cents, currency, confidence, payload_json, producer)
            VALUES (?, ?, ?, 1, ?, ?, 'payment', ?, ?, ?, 'finance', 'external', 'stripe', ?, 'h', ?, 'CAD', 'verified', '{}', 'lib/founders-finances/stripe-ingest.ts')`,
      args: [id, OASIS, key, at, at, `pay-${id}`, cols.contact_id ?? null, cols.customer_id ?? null, `t5:${id}`, cents, at],
    });
    await db.batch(
      [
        ev("01LEDGERT5CONTACT00000001", "payment.received", { contact_id: "cus_X" }, 4242, ago(4)),
        ev("01LEDGERT5CUSTOMER0000001", "refund.issued", { customer_id: X.id }, 1313, ago(3)),
      ],
      "write",
    );
    const xNow = (await store.getCustomer(db, OASIS, X.id))!;
    const money = (entries: Array<{ detail: string | null }>) => entries.map((e) => e.detail ?? "").filter((d) => /CAD (42\.42|13\.13)/.test(d));
    assert.deepEqual(money((await activity.loadClientActivity(db, OASIS, xNow)).entries), [], "no amounts without the books");
    assert.equal(money((await activity.loadClientActivity(db, OASIS, xNow, { books: true })).entries).length, 2, "the founders who may open Money see both");
    await login(OPS_ADMIN);
    const t = await page(record(X.id, "activity"));
    assert.match(t, /Support ticket opened/, "the desk admin still sees the client's activity");
    assert.doesNotMatch(t, /Payment received|Refund issued|CAD 42\.42|CAD 13\.13/);
    await login(USERS.cc);
  });
  await check("Activity: the source deal's interactions are labelled inferred; another client's are not there", async () => {
    const a = await activity.loadClientActivity(db, OASIS, X);
    const inferred = a.entries.filter((e) => e.basis === "inferred");
    assert.ok(inferred.some((e) => (e.detail ?? "").includes("X-DEAL-EMAIL")));
    assert.ok(a.entries.every((e) => !(e.detail ?? "").includes("Y-EMAIL")));
    await login(USERS.cc);
    const t = await page(record(X.id, "activity"));
    assert.match(t, /inferred from the deal/);
    assert.match(t, /Support ticket opened/);
  });
  await check("Activity: a ticket linked to the client AFTER it opened, and the deal's own ledger events, are on its timeline (and on no one else's)", async () => {
    // Filed before anyone knew whose it was: its ticket.opened carries no customer_id.
    const t = await deliveryStore.createTicket(db, OASIS, {
      title: "Filed before it was linked", description: null, category: "bug", severity: "low", source: "form", project_id: null, client_tenant_id: null,
      client_name: "Walk-in", client_email: null, client_company: null, client_match: null, project_hint: null,
      reporter_user_id: null, assigned_to: null,
    }, new Date(ago(6)));
    const tid = t.ticket.id;
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'ticket.opened' AND subject_id = ? AND customer_id IS NULL", [tid]), 1);
    // A founder links it to X on the ticket.
    await login(USERS.cc);
    const linked = await call(ticketRoute.PATCH(req("PATCH", `/api/tickets/${tid}?scope=desk`, { customer_id: X.id }), params({ id: tid })));
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    // The deal X came from was won: a sales event about the deal, with no client record on it.
    await db.execute({
      sql: `INSERT INTO outcome_events (id, tenant_id, event_key, event_version, occurred_at, recorded_at, subject_type, subject_id, contact_id, deal_id,
              department_key, actor_type, source, idempotency_key, payload_hash, confidence, payload_json, producer)
            VALUES ('01LEDGERDEALWONX000000001', ?, 'deal.won', 1, ?, ?, 'deal', ?, 'contact-x', ?, 'sales', 'human', 'native', ?, 'h', 'verified', '{}', 'lib/lead-stage-engine.ts')`,
      args: [OASIS, ago(45), ago(45), LEAD_X, LEAD_X, `deal:${LEAD_X}:won:1`],
    });
    const x = await activity.loadClientActivity(db, OASIS, (await store.getCustomer(db, OASIS, X.id))!);
    const opened = x.entries.find((e) => e.href === `/tickets/${tid}`);
    assert.equal(opened?.label, "Support ticket opened", JSON.stringify(x.entries.map((e) => [e.label, e.href])));
    const won = x.entries.find((e) => e.label === "Deal won");
    assert.ok(won, JSON.stringify(x.entries.map((e) => e.label)));
    assert.match(won!.detail ?? "", /on the deal this client came from/);
    const y = await activity.loadClientActivity(db, OASIS, (await store.getCustomer(db, OASIS, Y.id))!);
    assert.ok(!y.entries.some((e) => e.href === `/tickets/${tid}` || e.label === "Deal won"), "another client's timeline has neither");
  });
  await check("a ticket resolved, reopened by the client and resolved again records BOTH resolutions (the ledger's n-th)", async () => {
    await login(USERS.cc);
    const t = await call(tickets.POST(req("POST", "/api/tickets?scope=desk", { title: "Comes back", customer_id: X.id, severity: "low" })));
    assert.equal(t.status, 201, JSON.stringify(t.body));
    const id = String(t.body.id);
    const resolve = () => call(ticketRoute.PATCH(req("PATCH", `/api/tickets/${id}?scope=desk`, { status: "resolved" }), params({ id })));
    assert.equal((await resolve()).status, 200);
    const back = await deliveryStore.addTicketComment(db, OASIS, id, { body: "Still broken.", is_internal: false, author_type: "client", author: { userId: null, name: "Pat" } }, new Date());
    assert.ok(back.ok && back.reopened, JSON.stringify(back));
    assert.equal((await resolve()).status, 200);
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'ticket.resolved' AND subject_id = ? AND customer_id = ?", [id, X.id]), 2);
  });
  /**
   * The same database, except that right after the FIRST read matching `read`
   * returns, `between` runs: another request's write landing between this
   * request's read and its write.
   */
  const racing = (read: RegExp, between: () => Promise<unknown>): typeof db => {
    let fired = false;
    return new Proxy(db, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop !== "execute") return typeof v === "function" ? v.bind(target) : v;
        return async (...a: unknown[]) => {
          const rs = await (v as (...x: unknown[]) => Promise<unknown>).apply(target, a);
          const sql = typeof a[0] === "string" ? a[0] : String((a[0] as { sql: string }).sql);
          if (!fired && read.test(sql)) {
            fired = true;
            await between();
          }
          return rs;
        };
      },
    });
  };
  const newTicket = (title: string) =>
    deliveryStore.createTicket(db, OASIS, {
      title, description: null, category: "bug", severity: "low", source: "form", project_id: null, client_tenant_id: null,
      client_name: "Walk-in", client_email: null, client_company: null, client_match: null, project_hint: null,
      reporter_user_id: null, assigned_to: null,
    }, T0);
  const CC_AUTHOR = { userId: USERS.cc.id, name: "CC" };
  const ADON_AUTHOR = { userId: USERS.adon.id, name: "Adon" };
  await check("two founders resolving one ticket at once resolve it once: one ledger row, one thread line, and the late one is told (409)", async () => {
    const id = (await newTicket("Resolved twice at once")).ticket.id;
    const raced = racing(/FROM support_tickets WHERE tenant_id = \? AND id = \?/, () => deliveryStore.updateTicket(db, OASIS, id, { status: "resolved" }, ADON_AUTHOR, T0));
    const late = await deliveryStore.updateTicket(raced, OASIS, id, { status: "resolved" }, CC_AUTHOR, T0);
    assert.deepEqual(late, { ok: false, status: 409, error: "invalid_transition" });
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'ticket.resolved' AND subject_id = ?", [id]), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ? AND author_type = 'system' AND body LIKE 'Status:%'", [id]), 1);
  });
  await check("a status move read from a stale status never lands: 'waiting on client' on a ticket closed meanwhile is refused, and it stays closed", async () => {
    const id = (await newTicket("Closed under a stale edit")).ticket.id;
    const raced = racing(/FROM support_tickets WHERE tenant_id = \? AND id = \?/, () => deliveryStore.updateTicket(db, OASIS, id, { status: "closed" }, ADON_AUTHOR, T0));
    const late = await deliveryStore.updateTicket(raced, OASIS, id, { status: "waiting_on_client", assigned_to: USERS.cc.id }, CC_AUTHOR, T0);
    assert.deepEqual(late, { ok: false, status: 409, error: "invalid_transition" });
    const row = (await db.execute({ sql: "SELECT status, assigned_to FROM support_tickets WHERE id = ?", args: [id] })).rows[0];
    assert.deepEqual([row.status, row.assigned_to], ["closed", null], "nothing of the stale edit landed");
    assert.equal(await count("SELECT COUNT(*) AS n FROM ticket_comments WHERE ticket_id = ? AND body LIKE '%Waiting%'", [id]), 0);
  });

  // ── Last touch, health ─────────────────────────────────────────────────────
  await check("last touch is the latest activity, not updated_at: an edit is not a touch, an email is", async () => {
    const zr = await store.createCustomer(db, OASIS, { ...base, display_name: "Quiet Co", primary_email: "quiet@co.test" }, USERS.cc.id, new Date(ago(3)));
    assert.ok(zr.ok);
    await store.updateCustomer(db, OASIS, zr.customer.id, { tags: ["retainer"] }, T0, USERS.cc.id);
    const z = (await store.getCustomer(db, OASIS, zr.customer.id))!;
    assert.equal((await activity.lastTouchFor(db, OASIS, [z])).get(z.id), null, "creating and tagging the record touched nobody");
    await db.batch([li("li-z", OASIS, { preview: "hello quiet", to_email: "quiet@co.test", at: ago(1) })], "write");
    assert.equal((await activity.lastTouchFor(db, OASIS, [z])).get(z.id), ago(1));
    // The LIST prints that time (the Last touch cell's title is its ISO), never the record's updated_at (the tag edit).
    await login(USERS.cc);
    const listEl = await ClientsPage({ searchParams: Promise.resolve({ q: "Quiet" }) });
    assert.match(textOf(listEl).join("\n"), /Quiet Co/);
    const titles = renderedTitles(listEl);
    assert.ok(titles.includes(ago(1)), `the list's Last touch is the email: ${JSON.stringify(titles)}`);
    assert.ok(!titles.includes(z.updated_at), "and not the record's updated_at");
  });
  await check("last touch reads every source the Conversations tab reads, per client, and equals the thread's latest message", async () => {
    // Hand-added clients (no deal), created 60 days ago, each reached through ONE source only.
    const made: Record<string, typeof X> = {};
    const mk = async (key: string, email: string, phone: string | null) => {
      const r = await store.createCustomer(db, OASIS, { ...base, display_name: `Touch ${key}`, primary_email: email, primary_phone: phone }, USERS.cc.id, new Date(ago(60)));
      assert.ok(r.ok, JSON.stringify(r));
      made[key] = r.customer;
    };
    await mk("contact", "owner@contact.test", null);
    await mk("sms", "owner@sms.test", "+1 (514) 555-0101");
    await mk("inbound", "owner@inbound.test", null);
    await mk("stamped", "owner@stamped.test", null);
    await mk("slack", "owner@slack.test", null);
    await mk("approved", "owner@approved.test", null);
    await mk("unsure", "owner@unsure.test", null);
    await store.addContact(db, OASIS, made.contact.id, { name: "Ops", email: "ops@contact.test", phone: null, role: null }, new Date(ago(59)));
    await store.addContact(db, OASIS, made.inbound.id, { name: "Cell", email: null, phone: "514-555-0199", role: null }, new Date(ago(59)));
    await db.batch(
      [
        // An email to a CONTACT's address, not stamped with the client (sent from the inbox, say).
        li("li-t-contact", OASIS, { preview: "TO-CONTACT", to_email: "Ops@Contact.test", at: ago(2) }),
        // A text to the primary phone: to_phone, no email at all.
        li("li-t-sms", OASIS, { channel: "sms", type: "sms_sent", preview: "TO-PHONE", to_phone: "+15145550101", at: ago(3) }),
        // A text FROM a contact's phone.
        {
          sql: "INSERT INTO lead_interactions (id, tenant_id, type, channel, direction, content_preview, from_phone, created_at) VALUES (?, ?, 'sms_received', 'sms', 'inbound', 'FROM-CONTACT-PHONE', '+15145550199', ?)",
          args: ["li-t-inbound", OASIS, ago(4)],
        },
        // Stamped with the client's id, to an address no longer on file.
        li("li-t-stamped", OASIS, { preview: "STAMPED", to_email: "gone@elsewhere.test", at: ago(5), metadata: JSON.stringify({ customer_id: made.stamped.id }) }),
        slack("ce-t-slack", OASIS, made.slack.id, "SLACK-ONLY", ago(6)),
        {
          sql: `INSERT INTO approvals (id, tenant_id, department_key, requested_by_type, requested_by_id, action_kind, title, target_ref, payload_json,
                  payload_hash, status, executed_at, execution_result, idempotency_key, created_at, updated_at)
                VALUES ('ap-t-approved', ?, 'client_success', 'agent', 'client-success', 'send_email', 'Email', ?, ?, 'h', 'executed', ?, ?, 'ap-t-approved', ?, ?)`,
          args: [OASIS, `customer:${made.approved.id}`, JSON.stringify({ to: "owner@approved.test", subject: "Hi", body: "APPROVED-SEND" }), ago(7),
            JSON.stringify({ outcome: "sent", provider: "oasis_shared_gmail" }), ago(8), ago(7)],
        },
        // A send the mail server could not confirm is the ONLY thing for this one.
        li("li-t-unsure", OASIS, { type: "email_delivery_unknown", preview: "MAYBE-SENT", to_email: "owner@unsure.test", at: ago(1), metadata: JSON.stringify({ customer_id: made.unsure.id }) }),
      ],
      "write",
    );
    // A client from a deal whose ONLY interaction is an internal note: not contact.
    const LEAD_NOTE = "1ead0000-0000-4000-8000-00000000009e";
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [LEAD_NOTE, OASIS, JSON.stringify({ stage: "launched", company: "Note Only Co", name: "Nora Note", email: "nora@noteonly.test" })],
    });
    const noteConv = await store.convertLeadToCustomer(db, OASIS, LEAD_NOTE, USERS.cc.id, new Date(ago(60)));
    assert.ok(noteConv.ok, JSON.stringify(noteConv));
    await db.batch([li("li-t-note", OASIS, { lead_id: LEAD_NOTE, channel: "note", type: "note", preview: "INTERNAL-ONLY", at: ago(1) })], "write");
    assert.equal((await activity.lastTouchFor(db, OASIS, [noteConv.customer])).get(noteConv.customer.id), null, "an internal note on the deal is not contact");
    const all = Object.values(made);
    const touch = await activity.lastTouchFor(db, OASIS, all);
    const expected: Record<string, string | null> = {
      contact: ago(2), sms: ago(3), inbound: ago(4), stamped: ago(5), slack: ago(6), approved: ago(7), unsure: null,
    };
    for (const [key, c] of Object.entries(made)) {
      assert.equal(touch.get(c.id), expected[key], `${key}: last touch`);
      if (key === "unsure") continue;
      const thread = await conversations.loadClientConversation(db, OASIS, c, await store.listContacts(db, OASIS, c.id));
      assert.equal(thread.messages.at(-1)?.at, touch.get(c.id), `${key}: the badge and the thread agree`);
    }
    // The finding's case: health reads the contact, not "no contact since the record was created".
    await login(USERS.cc);
    const h = await page(record(made.contact.id, "health"));
    assert.doesNotMatch(h, /No contact recorded since the record was created/);
    assert.doesNotMatch(h, /\bAt risk\b/);
    // (The page counts days against the real clock; the fixtures are 60 days before T0.)
    assert.match(await page(record(made.unsure.id, "health")), /No contact recorded since the record was created in \d+ days/, "an unconfirmed send is not contact");
  });
  await check("the list and the record carry a health badge", async () => {
    await login(USERS.cc);
    const list = await page(ClientsPage({ searchParams: Promise.resolve({}) }));
    assert.match(list, /Health/);
    assert.match(list, /1 invoice is overdue\./, "X's badge carries its reason (an overdue invoice)");
    assert.match(await page(record(X.id, "health")), /1 invoice is overdue/);
  });
  await check("a member who may not read the desk sees no health verdict, not a false 'Not enough data'", async () => {
    await login(MEMBER_A);
    const list = await page(ClientsPage({ searchParams: Promise.resolve({}) }));
    assert.match(list, /Acme Same Address/);
    assert.doesNotMatch(list, /Not enough data|Healthy|At risk/);
    assert.match(await page(record(A.id, "health")), /owners and admins/);
    await login(USERS.cc);
  });
  await check("a client workspace keeps no books in the app: its Health tab never says payments were checked", async () => {
    await login(USERS.clientA);
    const h = await page(record(A.id, "health"));
    assert.match(h, /payments and invoices are not kept in the app, so they are not part of this/);
    assert.doesNotMatch(h, /Nothing in payments/);
    assert.doesNotMatch(h, /from overdue or failed payments/);
    // OASIS keeps its books: the same tab counts payments.
    await login(USERS.cc);
    const o = await page(record(X.id, "health"));
    assert.match(o, /from overdue or failed payments/);
    assert.doesNotMatch(o, /not kept in the app/);
  });

  // ── Past engagements ───────────────────────────────────────────────────────
  await check("Mark engagement ended: owners/admins only, moves the client to Past once, and the ledger records it once", async () => {
    await login(MEMBER_A);
    assert.equal((await call(endRoute.POST(req("POST", `/api/clients/${A.id}/end-engagement`), params({ id: A.id })))).status, 403);
    await login(USERS.cc);
    const r1 = await call(endRoute.POST(req("POST", `/api/clients/${Y.id}/end-engagement`), params({ id: Y.id })));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.changed, true);
    const r2 = await call(endRoute.POST(req("POST", `/api/clients/${Y.id}/end-engagement`), params({ id: Y.id })));
    assert.equal(r2.body.changed, false);
    assert.equal((await store.getCustomer(db, OASIS, Y.id))!.lifecycle, "churned");
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'customer.churned' AND customer_id = ?", [Y.id]), 1);
    // The list splits Past from current clients in the browser, from the rows
    // the page hands it (components/os/landings/clients-status.tsx): grouped
    // by the same rowsForStatus, Y is under Past clients and not above it.
    const listed = findElement(await ClientsPage({ searchParams: Promise.resolve({}) }), clientsStatus.ClientsByStatus);
    assert.ok(listed, "the list is rendered through ClientsByStatus");
    const lifecycles = listed.props.lifecycles as Parameters<typeof clientsStatus.rowsForStatus>[0];
    const rowEls = listed.props.rows as unknown[];
    const { current, past } = clientsStatus.rowsForStatus(lifecycles, "");
    const said = (idx: number[]) => idx.map((i) => textOf(rowEls[i]).join("\n")).join("\n");
    assert.match(said(past), /Other Client/, "Y is listed under Past clients");
    assert.doesNotMatch(said(current), /Other Client/, "and not among the current clients");
    assert.equal((await call(endRoute.POST(req("POST", `/api/clients/${A.id}/end-engagement`), params({ id: A.id })))).status, 404, "not OASIS's");
  });
  await check("a Status edit into Past records customer.churned, and back out customer.reactivated, each naming the person who made it", async () => {
    await login(USERS.cc);
    const sr = await store.createCustomer(db, OASIS, { ...base, display_name: "Status Edit Co", primary_email: "status@edit.test" }, USERS.cc.id, new Date(ago(10)));
    assert.ok(sr.ok);
    const id = sr.customer.id;
    const patch = (lifecycle: string) => call(customerRoute.PATCH(req("PATCH", `/api/customers/${id}`, { lifecycle }), params({ id })));
    const toPast = await patch("churned");
    assert.equal(toPast.status, 200, JSON.stringify(toPast.body));
    const back = await patch("active");
    assert.equal(back.status, 200, JSON.stringify(back.body));
    const events = (await db.execute({
      sql: "SELECT event_key, actor_type, actor_id FROM outcome_events WHERE customer_id = ? AND event_key IN ('customer.churned', 'customer.reactivated') ORDER BY event_key",
      args: [id],
    })).rows.map((r) => [String(r.event_key), String(r.actor_type), r.actor_id === null ? null : String(r.actor_id)]);
    assert.deepEqual(events, [["customer.churned", "human", USERS.cc.id], ["customer.reactivated", "human", USERS.cc.id]]);
  });
  await check("a deal that ended AFTER it became a record is listed once, as the record, not again under Past clients in Pipeline", async () => {
    const LEAD_P = "1ead0000-0000-4000-8000-0000000000e5";
    const lead = (stage: string) => JSON.stringify({ stage, company: "Ended Later Co", name: "Eli Later", email: "eli@endedlater.test" });
    await db.execute({ sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)", args: [LEAD_P, OASIS, lead("launched")] });
    const conv = await store.convertLeadToCustomer(db, OASIS, LEAD_P, USERS.cc.id, new Date(ago(20)));
    assert.ok(conv.ok, JSON.stringify(conv));
    await db.execute({ sql: "UPDATE tenant_records SET data = ? WHERE id = ?", args: [lead("churned"), LEAD_P] });
    await login(USERS.cc);
    const list = await page(ClientsPage({ searchParams: Promise.resolve({}) }));
    assert.match(list, /Ended Later Co|Eli Later/, "the record is listed");
    assert.doesNotMatch(list, /Past clients in Pipeline/, "not listed a second time from the pipeline");
  });
  await check("the pipeline-derived list files a deal whose engagement ended under Past, not among clients to convert", async () => {
    const cm = await import("../components/os/landings/clients-model");
    const built = cm.buildClientRows({
      leads: [
        { id: "l-won", data: { stage: "launched", company: "Still Client Co" } },
        { id: "l-ended", data: { stage: "churned", company: "Ended Engagement Co" } },
      ],
      projects: [],
      tickets: [],
    });
    assert.deepEqual(built.rows.map((r) => r.name), ["Still Client Co"]);
    assert.deepEqual(built.past.map((r) => [r.name, r.status]), [["Ended Engagement Co", "Engagement ended"]]);
  });
  await check("customer.created is in the ledger for a conversion and a hand-made record", async () => {
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'customer.created' AND customer_id = ? AND deal_id = ?", [X.id, LEAD_X]), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'customer.created' AND customer_id = ?", [Y.id]), 1);
  });

  // ── The client's own workspace ─────────────────────────────────────────────
  await check("Link workspace: operator only, OASIS only, one record per workspace", async () => {
    const link = (id: string, body: unknown) => call(linkRoute.POST(req("POST", `/api/clients/${id}/link-workspace`, body), params({ id })));
    await login(USERS.adon);
    const notOperator = await link(X.id, { client_tenant_id: CLIENT_A, confirmed: true });
    assert.equal(notOperator.status, 403);
    assert.equal(notOperator.body.error, "operator_only");
    await login(USERS.clientA);
    const notOasis = await link(A.id, { client_tenant_id: CLIENT_B, confirmed: true });
    assert.equal(notOasis.status, 403);
    await login(USERS.cc);
    const unconfirmed = await link(X.id, { client_tenant_id: CLIENT_A });
    assert.equal(unconfirmed.status, 400, "a cross-workspace read grant is confirmed first");
    assert.equal(unconfirmed.body.error, "link_confirmation_required");
    assert.equal((await store.getCustomer(db, OASIS, X.id))!.client_tenant_id, null, "nothing changed");
    const ok = await link(X.id, { client_tenant_id: CLIENT_A, confirmed: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await store.getCustomer(db, OASIS, X.id))!.client_tenant_id, CLIENT_A);
    const unlinkUnconfirmed = await link(X.id, { client_tenant_id: null });
    assert.equal(unlinkUnconfirmed.body.error, "link_confirmation_required");
    assert.equal((await store.getCustomer(db, OASIS, X.id))!.client_tenant_id, CLIENT_A, "unlinking is confirmed too");
    const taken = await link(Y.id, { client_tenant_id: CLIENT_A, confirmed: true });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, "client_tenant_taken");
    const self = await link(Y.id, { client_tenant_id: OASIS, confirmed: true });
    assert.equal(self.body.error, "client_tenant_is_this_workspace");
    const unknown = await link(Y.id, { client_tenant_id: "0e000000-0000-4000-8000-00000000dead", confirmed: true });
    assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
    assert.equal(unknown.body.error, "client_tenant_not_found");
    assert.equal((await store.getCustomer(db, OASIS, Y.id))!.client_tenant_id, null, "nothing is linked to a workspace that does not exist");
  });
  await check("Usage reads the linked workspace only: its snapshots, agent channels, approvals and desk over 30 days", async () => {
    await db.batch(
      [
        { sql: "INSERT INTO client_roi_snapshots (tenant_id, snapshot_date, messages_handled, leads_processed, hours_saved_est, ai_actions_taken) VALUES (?, '2026-09-28', 40, 3, 1.5, 12)", args: [CLIENT_A] },
        { sql: "INSERT INTO client_roi_snapshots (tenant_id, snapshot_date, messages_handled, leads_processed, hours_saved_est, ai_actions_taken) VALUES (?, '2026-09-29', 10, 1, 0.5, 8)", args: [CLIENT_A] },
        { sql: "INSERT INTO client_roi_snapshots (tenant_id, snapshot_date, messages_handled, leads_processed, hours_saved_est, ai_actions_taken) VALUES (?, '2026-08-01', 999, 99, 9, 99)", args: [CLIENT_A] },
        { sql: "INSERT INTO client_roi_snapshots (tenant_id, snapshot_date, messages_handled, leads_processed, hours_saved_est, ai_actions_taken) VALUES (?, '2026-09-29', 555, 55, 5, 55)", args: [CLIENT_B] },
        { sql: "INSERT INTO agent_turn_outcomes (tenant_id, channel_key, agent_slug, outcome, code, at) VALUES (?, 'dept:sales', 'sales', 'failed', 'billing', ?)", args: [CLIENT_A, ago(2)] },
        { sql: "INSERT INTO agent_turn_outcomes (tenant_id, channel_key, agent_slug, outcome, code, at) VALUES (?, 'dept:sales', 'sales', 'ok', NULL, ?)", args: [CLIENT_B, ago(2)] },
      ],
      "write",
    );
    const u = await usage.loadClientUsage(db, CLIENT_A, T0);
    assert.equal(u.workspace?.name, "Client A Plumbing");
    assert.deepEqual(
      [u.roi.snapshotDays, u.roi.messagesHandled, u.roi.leadsProcessed, u.roi.aiActionsTaken, u.roi.hoursSaved],
      [2, 50, 4, 20, 2],
    );
    assert.deepEqual(u.agents, { channelsUsed: 1, lastTurnFailed: 1, lastTurnAt: ago(2) });
    assert.ok(u.tickets.opened >= 0);
    await login(USERS.cc);
    const t = await page(record(X.id, "usage"));
    assert.match(t, /Client A Plumbing/);
    assert.doesNotMatch(t, /555/);
    const unlinked = await page(record(Y.id, "usage"));
    assert.match(unlinked, /Not linked to the client/);
  });

  // ── Stripe import ──────────────────────────────────────────────────────────
  await db.batch(
    [
      { sql: "INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents) VALUES ('s-new', 'fin_ent_oasis', 'cus_NEW', 'Sam Subscriber', 'Sam@Sub.test', 'active', 'CAD', 10000)", args: [] },
      { sql: "INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents) VALUES ('s-old', 'fin_ent_oasis', 'cus_OLD', 'Old Sub', 'old@sub.test', 'canceled', 'CAD', 10000)", args: [] },
      { sql: "INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents) VALUES ('s-anon', 'fin_ent_oasis', 'cus_ANON', '', '', 'canceled', 'CAD', 10000)", args: [] },
      { sql: "INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents, livemode) VALUES ('s-test', 'fin_ent_oasis', 'cus_TEST', 'Test Mode', 'test@mode.test', 'active', 'CAD', 10000, 0)", args: [] },
    ],
    "write",
  );
  const importRoute = await import("../app/api/clients/import-stripe/route");
  const importPost = (body: unknown) => call(importRoute.POST(req("POST", "/api/clients/import-stripe", body)));
  // What the dialog shows (GET) and would confirm: every create and link, with its action.
  let reviewed: Array<{ stripe_customer_id: string; action: string }> = [];
  const customersNow = () => count("SELECT COUNT(*) AS n FROM customers");
  await check("Stripe import: the founder's preview lists what an import would do, and test-mode customers are not read", async () => {
    await login(USERS.cc);
    const plan = await sync.planStripeImport(db, OASIS);
    const by = Object.fromEntries(plan.map((p) => [p.group.stripe_customer_id, p.action]));
    assert.deepEqual(by, { cus_ANON: "skip", cus_NEW: "create", cus_OLD: "create", cus_X: "skip", cus_Y: "link" }, "test-mode customers are not read");
    const g = await call(importRoute.GET());
    assert.equal(g.status, 200, JSON.stringify(g.body));
    reviewed = (g.body.items as Array<{ stripe_customer_id: string; action: string }>)
      .filter((i) => i.action === "create" || i.action === "link")
      .map((i) => ({ stripe_customer_id: i.stripe_customer_id, action: i.action }));
    assert.deepEqual(reviewed.map((i) => i.stripe_customer_id).sort(), ["cus_NEW", "cus_OLD", "cus_Y"]);
  });
  await check("Stripe import route: refused, and nothing written, without the privacy answer or the reviewed list", async () => {
    await login(USERS.cc);
    const before = await customersNow();
    const noPrivacy = await importPost({ confirmed: reviewed });
    assert.equal(noPrivacy.status, 400);
    assert.equal(noPrivacy.body.error, "privacy_confirmation_required");
    const noList = await importPost({ confirm_privacy: true });
    assert.equal(noList.status, 400);
    assert.equal(noList.body.error, "import_confirmation_invalid");
    assert.equal(await customersNow(), before);
  });
  await check("Stripe import route: an OASIS admin who may not open Money is refused (finance_owners_only), GET and POST", async () => {
    await login(OPS_ADMIN);
    const before = await customersNow();
    const g = await call(importRoute.GET());
    assert.equal(g.status, 403);
    assert.equal(g.body.error, "finance_owners_only");
    const p = await importPost({ confirm_privacy: true, confirmed: reviewed });
    assert.equal(p.status, 403);
    assert.equal(p.body.error, "finance_owners_only");
    assert.equal(await customersNow(), before);
    await login(USERS.cc);
  });
  // CC standing in another workspace (a second, newer membership): still the
  // operator and a finance owner by identity, but not in OASIS's workspace.
  const CC_IN_B = `p-cc-in-b`;
  const standInB = () =>
    db.execute({
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
            VALUES (?, ?, ?, ?, 'owner', 1, '2026-09-01T00:00:00Z', 'Conaugh McKenna', '2026-09-29T00:00:00Z', '2026-09-29T00:00:00Z')`,
      args: [CC_IN_B, USERS.cc.id, USERS.cc.email, CLIENT_B],
    });
  const leaveB = () => db.execute({ sql: "DELETE FROM user_profiles WHERE id = ?", args: [CC_IN_B] });
  await check("the OASIS-only actions refuse the operator standing in a client's workspace: oasis_only, nothing written", async () => {
    const bClient = await store.createCustomer(db, CLIENT_B, { ...base, display_name: "B's Own Client", primary_email: "bee@client-b.test" }, USERS.clientB.id, new Date(ago(5)));
    assert.ok(bClient.ok);
    await standInB();
    try {
      await login(USERS.cc);
      const before = await customersNow();
      const imp = await importPost({ confirm_privacy: true, confirmed: reviewed });
      assert.equal(imp.status, 403, JSON.stringify(imp.body));
      assert.equal(imp.body.error, "oasis_only");
      assert.equal(await customersNow(), before);
      const link = await call(
        linkRoute.POST(req("POST", `/api/clients/${bClient.customer.id}/link-workspace`, { client_tenant_id: CLIENT_A, confirmed: true }), params({ id: bClient.customer.id })),
      );
      assert.equal(link.status, 403, JSON.stringify(link.body));
      assert.equal(link.body.error, "oasis_only");
      assert.equal((await store.getCustomer(db, CLIENT_B, bClient.customer.id))!.client_tenant_id, null);
    } finally {
      await leaveB();
    }
  });
  await check("Stripe import: imports ONLY what the founder reviewed; a customer that reached the books after the preview is held back", async () => {
    await login(USERS.cc);
    // Arrives between the preview and the click. Its id has underscores (as the
    // books can hold, e.g. cus_TEST_SUB): the POST takes ids as the GET showed them.
    await db.execute("INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents) VALUES ('s-late', 'fin_ent_oasis', 'cus_LATE_ARRIVAL', 'Late Arrival', 'late@sub.test', 'active', 'CAD', 10000)");
    const customersBefore = await count("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?", [OASIS]);
    const res = await importPost({ confirm_privacy: true, confirmed: reviewed });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.created, res.body.linked, res.body.unreviewed, res.body.changed], [2, 1, 1, 0]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers WHERE stripe_customer_id = 'cus_LATE_ARRIVAL'"), 0, "never shown, never imported");
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?", [OASIS]), customersBefore + 2);
    const sam = (await db.execute("SELECT * FROM customers WHERE tenant_id = ? AND stripe_customer_id = 'cus_NEW'", [OASIS])).rows[0];
    assert.equal(sam.display_name, "Sam Subscriber");
    assert.equal(sam.primary_email, "sam@sub.test");
    assert.equal(sam.primary_phone, null);
    assert.equal(sam.company_name, null);
    assert.equal(sam.lifecycle, "active");
    assert.equal(sam.tags, "[]");
    const old = (await db.execute("SELECT lifecycle FROM customers WHERE tenant_id = ? AND stripe_customer_id = 'cus_OLD'", [OASIS])).rows[0];
    assert.equal(old.lifecycle, "churned", "a subscriber with nothing active is a Past client");
    assert.equal((await store.getCustomer(db, OASIS, Y.id))!.stripe_customer_id, "cus_Y");
    assert.equal(await count("SELECT COUNT(*) AS n FROM outcome_events WHERE event_key = 'customer.created' AND source = 'import' AND tenant_id = ?", [OASIS]), 2);
  });
  await check("Stripe import is idempotent: a second run of the same review creates and links nothing", async () => {
    await login(USERS.cc);
    const before = await count("SELECT COUNT(*) AS n FROM customers");
    const r = await importPost({ confirm_privacy: true, confirmed: reviewed });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.created, r.body.linked, (r.body.conflicts as unknown[]).length], [0, 0, 0]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers"), before);
    const direct = await sync.runStripeImport(db, OASIS, USERS.cc.id, T0, new Map(reviewed.map((i) => [i.stripe_customer_id, i.action as "create" | "link"])));
    assert.deepEqual([direct.created.length, direct.linked.length, direct.conflicts.length], [0, 0, 0]);
  });
  await check("Stripe import: a customer shown with a different action than it now has is held back, not imported", async () => {
    await login(USERS.cc);
    const r = await importPost({ confirm_privacy: true, confirmed: [{ stripe_customer_id: "cus_LATE_ARRIVAL", action: "link" }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.created, r.body.linked, r.body.changed], [0, 0, 1]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers WHERE stripe_customer_id = 'cus_LATE_ARRIVAL'"), 0);
  });
  await check("Stripe import: two Stripe customers with one client's email - the first links, the second is a conflict, never an overwrite", async () => {
    const dup = await store.createCustomer(db, OASIS, { ...base, display_name: "Dup Email Co", primary_email: "dup@both.test" }, USERS.cc.id, new Date(ago(3)));
    assert.ok(dup.ok);
    const sub = (id: string, cus: string, name: string) => ({
      sql: `INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents)
            VALUES (?, 'fin_ent_oasis', ?, ?, 'dup@both.test', 'active', 'CAD', 10000)`,
      args: [id, cus, name],
    });
    await db.batch([sub("s-dup-a", "cus_DUPA", "Dup A"), sub("s-dup-b", "cus_DUPB", "Dup B")], "write");
    const plan = Object.fromEntries((await sync.planStripeImport(db, OASIS)).map((p) => [p.group.stripe_customer_id, p.action]));
    assert.deepEqual([plan.cus_DUPA, plan.cus_DUPB], ["link", "conflict"], "the dialog shows the second as a conflict");
    const r = await sync.runStripeImport(db, OASIS, USERS.cc.id, T0, new Map([["cus_DUPA", "link"], ["cus_DUPB", "link"]]));
    assert.deepEqual(r.linked, [dup.customer.id]);
    assert.ok(r.conflicts.some((c) => c.stripe_customer_id === "cus_DUPB"), JSON.stringify(r));
    assert.equal((await store.getCustomer(db, OASIS, dup.customer.id))!.stripe_customer_id, "cus_DUPA", "the first link stands");
  });
  await check("Stripe import: a record linked by someone else after the plan was read keeps its link; the import's link is a conflict", async () => {
    const rec = await store.createCustomer(db, OASIS, { ...base, display_name: "Raced Link Co", primary_email: "raced@link.test" }, USERS.cc.id, new Date(ago(3)));
    assert.ok(rec.ok);
    await db.execute({
      sql: `INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents)
            VALUES ('s-raced', 'fin_ent_oasis', 'cus_IMPORTED', 'Raced', 'raced@link.test', 'active', 'CAD', 10000)`,
      args: [],
    });
    // A founder links the record by hand between the import's plan and its write.
    const raced = racing(/SELECT id, primary_email, stripe_customer_id FROM customers/, () =>
      store.updateCustomer(db, OASIS, rec.customer.id, { stripe_customer_id: "cus_BY_HAND" }, T0, USERS.adon.id),
    );
    const r = await sync.runStripeImport(raced, OASIS, USERS.cc.id, T0, new Map([["cus_IMPORTED", "link"]]));
    assert.ok(!r.linked.includes(rec.customer.id), JSON.stringify(r));
    assert.ok(r.conflicts.some((c) => c.stripe_customer_id === "cus_IMPORTED" && c.customerId === rec.customer.id), JSON.stringify(r));
    assert.equal((await store.getCustomer(db, OASIS, rec.customer.id))!.stripe_customer_id, "cus_BY_HAND", "the hand link is never overwritten");
  });

  // ── Stripe import: choosing who (CC, 2026-10-02: "I want to be able to just
  // import one because some of them are inactive") ─────────────────────────────
  const dialog = await import("../components/os/landings/clients-actions");
  const sub = (id: string, cus: string, name: string, email: string, status: string, updatedAt: string) => ({
    sql: `INSERT INTO fin_subscriptions (id, entity_id, stripe_customer_id, customer_name, customer_email, status, currency, monthly_cents, updated_at)
          VALUES (?, 'fin_ent_oasis', ?, ?, ?, ?, 'CAD', 10000, ?)`,
    args: [id, cus, name, email, status, updatedAt],
  });
  await db.batch(
    [
      // One active subscriber. A NEWER canceled subscription does not hide the live one.
      sub("s-one", "cus_ONE", "One Person", "one@person.test", "active", ago(20)),
      sub("s-one-old", "cus_ONE", "One Person", "one@person.test", "canceled", ago(1)),
      pay("p-one-a", { cents: 10000, stripe: "cus_ONE", at: ago(40) }),
      pay("p-one-b", { cents: 10000, stripe: "cus_ONE", at: ago(10) }),
      // Neither a test-mode payment nor a refund is a payment the client made.
      pay("p-one-test", { cents: 10000, stripe: "cus_ONE", live: 0, at: ago(2) }),
      pay("r-one", { kind: "refund", cents: 500, parent: "p-one-b", stripe: "cus_ONE", at: ago(3) }),
      // A subscriber who cancelled in June: Past.
      sub("s-past", "cus_PAST", "Past Person", "past@person.test", "canceled", ago(90)),
      pay("p-past", { cents: 10000, stripe: "cus_PAST", at: ago(100) }),
      // Paid once, never subscribed.
      pay("p-payonly", { cents: 5000, stripe: "cus_PAYONLY", name: "Paid Once", email: "once@person.test", at: ago(50) }),
    ],
    "write",
  );
  let choosing: Array<Record<string, unknown>> = [];
  await check("Stripe import GET: each person carries their subscription status and last payment, as the books hold them", async () => {
    await login(USERS.cc);
    const g = await call(importRoute.GET());
    assert.equal(g.status, 200, JSON.stringify(g.body));
    choosing = g.body.items as Array<Record<string, unknown>>;
    const by = Object.fromEntries(choosing.map((i) => [i.stripe_customer_id, i]));
    assert.deepEqual(
      [by.cus_ONE.action, by.cus_ONE.lifecycle, by.cus_ONE.subscription_status, by.cus_ONE.last_paid_at],
      ["create", "active", "active", ago(10)],
      "the live subscription wins over a newer canceled one; the last payment is the newest live one",
    );
    assert.deepEqual([by.cus_PAST.lifecycle, by.cus_PAST.subscription_status, by.cus_PAST.last_paid_at], ["churned", "canceled", ago(100)]);
    assert.deepEqual([by.cus_PAYONLY.lifecycle, by.cus_PAYONLY.subscription_status, by.cus_PAYONLY.last_paid_at], ["churned", null, ago(50)]);
    for (const i of choosing) assert.ok("subscription_status" in i && "last_paid_at" in i, `every row carries both: ${String(i.stripe_customer_id)}`);
    assert.equal(dialog.subscriptionLabel("active"), "Subscription active");
    assert.equal(dialog.subscriptionLabel("canceled"), "Subscription canceled");
    assert.equal(dialog.subscriptionLabel(null), "No subscription");
    assert.equal(dialog.lastPaidLabel("2026-09-05T14:00:00.000Z"), "Last paid Sep 5, 2026");
    assert.equal(dialog.lastPaidLabel(null), "No payment on record");
  });
  await check("the dialog ticks Active people and leaves Past ones unticked; Select all, Active only and None do what they say", () => {
    const rows = choosing as unknown as Parameters<typeof dialog.importSelection>[0];
    const importableIds = rows.filter(dialog.importable).map((i) => i.stripe_customer_id).sort();
    assert.deepEqual(importableIds, ["cus_LATE_ARRIVAL", "cus_ONE", "cus_PAST", "cus_PAYONLY"]);
    assert.deepEqual([...dialog.importSelection(rows, "active")].sort(), ["cus_LATE_ARRIVAL", "cus_ONE"], "Active ticked, Past not");
    assert.deepEqual([...dialog.importSelection(rows, "all")].sort(), importableIds);
    assert.deepEqual([...dialog.importSelection(rows, "none")], []);
    for (const skipped of rows.filter((i) => !dialog.importable(i))) {
      assert.ok(!dialog.importSelection(rows, "all").has(skipped.stripe_customer_id), `a ${skipped.action} row is never ticked`);
    }
  });
  await check("Stripe import: ONE person, chosen by hand; everyone left unticked is 'left out by you', never 'unreviewed'", async () => {
    await login(USERS.cc);
    const rows = choosing as unknown as Parameters<typeof dialog.importSelection>[0];
    const body = dialog.importRequest(rows, new Set(["cus_ONE"]));
    assert.deepEqual(body.confirmed, [{ stripe_customer_id: "cus_ONE", action: "create" }]);
    assert.deepEqual([...body.declined].sort(), ["cus_LATE_ARRIVAL", "cus_PAST", "cus_PAYONLY"]);
    const before = await customersNow();
    const r = await importPost(body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.created, r.body.linked, r.body.declined, r.body.unreviewed, r.body.changed], [1, 0, 3, 0, 0]);
    assert.equal(await customersNow(), before + 1, "exactly one record");
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers WHERE stripe_customer_id = 'cus_ONE'"), 1);
    for (const out of ["cus_LATE_ARRIVAL", "cus_PAST", "cus_PAYONLY"]) {
      assert.equal(await count("SELECT COUNT(*) AS n FROM customers WHERE stripe_customer_id = ?", [out]), 0, `${out} was imported`);
    }
    const said = dialog.importOutcome({
      created: Number(r.body.created), linked: Number(r.body.linked), skipped: 0,
      conflicts: 0, declined: Number(r.body.declined), unreviewed: Number(r.body.unreviewed), changed: Number(r.body.changed),
    });
    assert.equal(said, "Imported 1. 3 left out by you.");
  });
  await check("Stripe import: the default choice leaves Past out; they are counted as declined and never imported", async () => {
    await login(USERS.cc);
    const g = await call(importRoute.GET());
    const rows = g.body.items as Parameters<typeof dialog.importSelection>[0];
    const body = dialog.importRequest(rows, dialog.importSelection(rows, "active"));
    assert.deepEqual(body.confirmed.map((i) => i.stripe_customer_id), ["cus_LATE_ARRIVAL"], "cus_ONE is a client now, so only the late arrival is Active");
    const r = await importPost(body);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual([r.body.created, r.body.declined, r.body.unreviewed], [1, 2, 0]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers WHERE stripe_customer_id IN ('cus_PAST', 'cus_PAYONLY')"), 0, "a Past customer was imported");
    assert.equal(
      dialog.importOutcome({ created: 1, linked: 0, skipped: 7, conflicts: 2, declined: 2, unreviewed: 1, changed: 0 }),
      "Imported 1. 2 left out by you. 7 skipped (already a client, or no name or email). 2 conflicts left for you. " +
        "1 not imported: they reached the books or changed after this list was opened. Open the import again to review them.",
    );
  });
  await check("Stripe import route: declined must be a list of ids, none of them also confirmed; nothing is written otherwise", async () => {
    await login(USERS.cc);
    const before = await customersNow();
    const both = await importPost({ confirm_privacy: true, confirmed: [{ stripe_customer_id: "cus_PAST", action: "create" }], declined: ["cus_PAST"] });
    assert.equal(both.status, 400);
    assert.deepEqual([both.body.error, both.body.field], ["import_confirmation_invalid", "declined"]);
    const notList = await importPost({ confirm_privacy: true, confirmed: [{ stripe_customer_id: "cus_PAST", action: "create" }], declined: "cus_PAYONLY" });
    assert.equal(notList.status, 400);
    const twice = await importPost({ confirm_privacy: true, confirmed: [{ stripe_customer_id: "cus_PAST", action: "create" }], declined: ["cus_PAYONLY", "cus_PAYONLY"] });
    assert.equal(twice.status, 400);
    assert.equal(await customersNow(), before);
  });
  await check("runStripeImport: a declined id that is not on offer (already a client, a conflict) is not counted as declined", async () => {
    const r = await sync.runStripeImport(db, OASIS, USERS.cc.id, T0, new Map(), new Set(["cus_ONE", "cus_DUPB", "cus_PAST"]));
    assert.deepEqual(r.declined, ["cus_PAST"], JSON.stringify(r));
    assert.deepEqual(r.unreviewed, ["cus_PAYONLY"], "shown or not, it is never imported without a tick");
    assert.deepEqual([r.created, r.linked], [[], []]);
  });

  // ── Support desk ───────────────────────────────────────────────────────────
  const TicketsPage = (await import("../app/tickets/page")).default;
  const ProjectsPage = (await import("../app/projects/page")).default;
  const Portal = (await import("../app/client-portal/page")).default;
  await check("/tickets and /projects render with an incomplete sales roster, and say why the assignee menu is empty", async () => {
    await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = ? WHERE auth_user_id = ?", args: [ago(1), USERS.adon.id] });
    try {
      await login(USERS.cc);
      const desk = await page(TicketsPage({ searchParams: Promise.resolve({ status: "all" }) }));
      assert.match(desk, /Portal login broken/, "the desk still lists its tickets");
      assert.doesNotMatch(desk, /Could not load/);
      assert.match(desk, /can't be assigned from here right now: the assignment roster needs both founders/);
      const board = await page(ProjectsPage({ searchParams: Promise.resolve({}) }));
      assert.doesNotMatch(board, /Could not load/);
      assert.match(board, /Projects can't be assigned from here right now/);
    } finally {
      await db.execute({ sql: "UPDATE user_profiles SET deactivated_at = NULL WHERE auth_user_id = ?", args: [USERS.adon.id] });
    }
  });
  await check("client emails from the desk end with OASIS's support link", async () => {
    const sent: Array<{ to: string; body: string }> = [];
    const deps = {
      telegram: async () => ({ ok: true }),
      email: async (m: { to: string; body: string }) => {
        sent.push(m);
        return { ok: true };
      },
      founderEmails: ["conaugh@oasisai.work"],
      appOrigin: "https://oasisai.work",
    };
    const t = await deliveryStore.createTicket(db, OASIS, {
      title: "Ack me", description: null, category: "bug", severity: "low", source: "form", project_id: null, client_tenant_id: null,
      client_name: "Pat", client_email: "pat@breeze.test", client_company: null, client_match: null, project_hint: null,
      reporter_user_id: null, assigned_to: null,
    }, T0);
    await notify.acknowledgeClient(db, OASIS, t.ticket.id, deps, T0);
    assert.equal(sent.length, 1);
    assert.match(sent[0].body, /https:\/\/oasisai\.work\/f\/oasis-ai-cc\/support/);
    // The team's reply on the ticket, emailed to the client, ends with it too.
    await notify.emailClientReply(db, OASIS, t.ticket, { id: "reply-with-link", body: "We fixed it.", authorName: "OASIS Support" }, deps);
    assert.equal(sent.length, 2);
    assert.match(sent[1].body, /We fixed it\./);
    assert.match(sent[1].body, /https:\/\/oasisai\.work\/f\/oasis-ai-cc\/support/);
  });
  await check("the client portal always shows the support link, and an unread ROI is a dash, never a zero", async () => {
    await login(USERS.clientA);
    const t = await page(Portal());
    assert.match(t, /\/f\/oasis-ai-cc\/support/);
    await db.execute("ALTER TABLE client_roi_snapshots RENAME TO client_roi_snapshots_gone");
    try {
      const broken = await page(Portal());
      assert.match(broken, /Couldn't load your AI's numbers/);
      assert.match(broken, /Messages Handled\n—/, "an unread number is a dash");
      assert.doesNotMatch(broken, /Messages Handled\n0\b/);
    } finally {
      await db.execute("ALTER TABLE client_roi_snapshots_gone RENAME TO client_roi_snapshots");
    }
  });
  await check("the client portal: a workspace that could not be resolved is the load error, never the empty 'nightly snapshot' state", async () => {
    await login(USERS.clientA);
    await db.execute("ALTER TABLE user_profiles RENAME TO user_profiles_gone");
    try {
      const t = await page(Portal());
      assert.match(t, /Couldn't load your AI's numbers/);
      assert.doesNotMatch(t, /nightly snapshot/, "an unread profile is not 'no data yet'");
      // The value's element carries a class name, which the walk prints before its text.
      assert.match(t, /Days Tracked\n(?:[^\n]*\n)?—/, "and not zero days");
    } finally {
      await db.execute("ALTER TABLE user_profiles_gone RENAME TO user_profiles");
    }
  });

  await check("before bravo__195 is applied: records read as 'Not linked', Link workspace answers 503 with its own code, as its header says, and a sentence with no migration name", async () => {
    const header = MIG("bravo__195_customers_links.sql");
    const ordering = header.slice(header.indexOf("-- ORDERING."), header.indexOf("-- NOT RE-RUNNABLE"));
    assert.match(ordering, /Not linked to the client's workspace yet/);
    assert.match(ordering, /503/);
    assert.doesNotMatch(ordering, /answers\s+(--\s+)?"no such column" on the Clients pages/);
    await db.execute("ALTER TABLE customers RENAME COLUMN client_tenant_id TO client_tenant_id_unapplied");
    try {
      await login(USERS.cc);
      assert.equal((await store.getCustomer(db, OASIS, X.id))!.client_tenant_id, null);
      // The list's retired-business guard reads client_tenant_id; without the
      // column no record can name a workspace, and the list still reads.
      assert.ok((await store.listCustomers(db, OASIS, {})).rows.some((r) => r.display_name === "Quiet Co"), "the list reads without bravo__195");
      // So do the pickers, the matchers and the desk's validator, through the same guard.
      assert.ok((await store.listCustomerOptions(db, OASIS)).some((o) => o.value === Y.id), "the Client picker reads without bravo__195");
      assert.equal(await store.matchCustomerByEmail(db, OASIS, "y@other.test"), Y.id, "the intake match reads without bravo__195");
      assert.equal(await store.isCustomerEmail(db, OASIS, "y@other.test"), true);
      assert.equal(await deliveryStore.deskCustomerExists(db, OASIS, Y.id), true);
      const list = await page(ClientsPage({ searchParams: Promise.resolve({}) }));
      assert.doesNotMatch(list, /Couldn.t load your client records/);
      assert.match(list, /Quiet Co/);
      assert.match(await page(record(X.id, "usage")), /Not linked to the client/);
      const r = await call(linkRoute.POST(req("POST", `/api/clients/${Y.id}/link-workspace`, { client_tenant_id: CLIENT_B, confirmed: true }), params({ id: Y.id })));
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.equal(r.body.error, "client_workspace_link_not_set_up");
      // The operator reads the cause in the log; the screen never names a migration (CS-16).
      assert.match(String(r.body.message), /isn't available right now\. Nothing was changed/);
      assert.doesNotMatch(String(r.body.message), /migration|bravo__/i);
    } finally {
      await db.execute("ALTER TABLE customers RENAME COLUMN client_tenant_id_unapplied TO client_tenant_id");
    }
  });

  // A record linked to a retired business's workspace is not a client
  // anywhere (lib/os/customers/retired.ts): no list shows it, Include archived
  // included, and opening it is a 404, so no tab ever reads the retired
  // workspace (Usage included). The same record linked to a live client's
  // workspace is the control.
  await check("a record linked to a retired business's workspace: the page alone on every tab and the layout alone are a 404, and no list shows it", async () => {
    await login(USERS.cc);
    const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
    const made = await store.createCustomer(db, OASIS, { ...base, display_name: "Retired Link Co", primary_email: "ops@retired-link.test" }, USERS.cc.id, T0);
    assert.ok(made.ok, JSON.stringify(made));
    const R = made.customer;
    await db.execute({ sql: "UPDATE customers SET client_tenant_id = ? WHERE id = ?", args: [SUNBIZ, R.id] });
    for (const tab of EVERY_TAB) assert.equal(await is404(pageAlone(R.id, tab)), true, `page ${tab ?? "overview"}`);
    assert.equal(await is404(layoutAlone(R.id)), true, "layout");
    for (const sp of [{}, { archived: "1" }]) {
      assert.doesNotMatch(await page(ClientsPage({ searchParams: Promise.resolve(sp) })), /Retired Link Co/, `the list ${JSON.stringify(sp)} shows it`);
    }
    // Control: linked to a live client's workspace, the same record opens on Usage and is listed.
    await db.execute({ sql: "UPDATE customers SET client_tenant_id = ? WHERE id = ?", args: [CLIENT_B, R.id] });
    assert.match(await page(record(R.id, "usage")), /Retired Link Co/);
    assert.match(await page(ClientsPage({ searchParams: Promise.resolve({}) })), /Retired Link Co/);
  });
  await check("the deal page's client card: none on a deal about a retired business or on one whose record is linked to its workspace; a live client's deal still gets its card", async () => {
    await login(USERS.cc);
    const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
    const { ClientRecordCard } = await import("../components/os/landings/clients-record-card");
    const card = async (leadId: string) => {
      const el = await ClientRecordCard({ tenantId: OASIS, leadId, stage: "won" });
      return el === null ? null : textOf(el).join("\n");
    };
    await db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES ('lead-card-sb', ?, 'lead', ?), ('lead-card-made', ?, 'lead', ?)",
      args: [
        OASIS,
        JSON.stringify({ stage: "won", company: "SunBiz", client_tenant_id: SUNBIZ.toUpperCase() }),
        OASIS,
        JSON.stringify({ stage: "won", company: "Card Made Co" }),
      ],
    });
    // A deal about SunBiz: no "Convert to client", which would answer 409 retired_business.
    assert.equal(await card("lead-card-sb"), null, "a SunBiz deal is offered Convert to client");
    // A record made from a deal and linked to SunBiz's workspace: no "Open client", which would open as not found.
    const made = await store.createCustomer(db, OASIS, { ...base, display_name: "Card Made Co", primary_email: "ops@card-made.test", source_lead_id: "lead-card-made" }, USERS.cc.id, T0);
    assert.ok(made.ok, JSON.stringify(made));
    await db.execute({ sql: "UPDATE customers SET client_tenant_id = ? WHERE id = ?", args: [SUNBIZ, made.customer.id] });
    assert.equal(await card("lead-card-made"), null, "a record linked to SunBiz's workspace is offered Open client");
    // Controls: the same record linked to a live client's workspace (a fresh one:
    // one workspace belongs to one record), and the deal once it names no retired business.
    const LIVE = "c0c0c0c0-0000-4000-8000-0000000000c1";
    await db.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'card-live', 'Card Live Co')", args: [LIVE] });
    await db.execute({ sql: "UPDATE customers SET client_tenant_id = ? WHERE id = ?", args: [LIVE, made.customer.id] });
    assert.match(String(await card("lead-card-made")), /Card Made Co[\s\S]*Open client/);
    await db.execute({ sql: "UPDATE tenant_records SET data = ? WHERE id = 'lead-card-sb'", args: [JSON.stringify({ stage: "won", company: "Live Deal Co" })] });
    assert.match(String(await card("lead-card-sb")), /This deal is won/);
  });

  finish("clients-hub");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
