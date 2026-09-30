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

const MIG = (f: string) => readFileSync(join(__dirname, "..", "database", "turso", f), "utf8");
const MEMBER_A = { id: "0d000000-0000-4000-8000-0000000000a2", email: "helper@client-a.test" };
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
  const ClientsPage = (await import("../app/clients/page")).default;
  const record = (id: string, tab?: string) =>
    ClientRecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) });
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
    assert.match(t, /Sends from the OASIS mailbox/);
    assert.doesNotMatch(t, /mailto:/, "the record writes from the app, not a mailto link");
  });
  await login(USERS.clientA);
  await check("another workspace's client record is a 404, before anything of it is read", async () => {
    assert.equal(await is404(record(X.id, "conversations")), true);
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
  await check("reply route: a client workspace with no mailbox of its own is refused (never the OASIS mailbox)", async () => {
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${A.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: A.id })));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "no_mailbox");
    assert.match(String(r.body.message), /no mailbox connected for client email yet, so nothing was sent/);
    assert.equal((await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: X.id })))).status, 404, "OASIS's client is not A's");
  });
  await login(MEMBER_A);
  await check("reply route: a member below owner/admin may not write to clients", async () => {
    const r = await call(replyRoute.POST(req("POST", `/api/clients/${A.id}/reply`, { ...sentMsg, confirmed: true }), params({ id: A.id })));
    assert.equal(r.status, 403);
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
  await check("send: another workspace uses ITS OWN connected mailbox, never OASIS's; none connected is refused", async () => {
    const none = fakeDeps({ brandFor: async () => null });
    const refused = await conversations.sendClientEmail(db, none.deps, {
      tenantId: CLIENT_A, userId: USERS.clientA.id, userEmail: USERS.clientA.email, customer: A, reply: reply(A, [], { ...sentMsg, confirmed: true }), now: T0,
    });
    assert.deepEqual(refused, { ok: false, status: 409, error: "no_mailbox" });
    assert.equal(none.calls.length, 0);
    const noOwn = fakeDeps({ brandFor: async () => "sunbiz" });
    const refused2 = await conversations.sendClientEmail(db, noOwn.deps, {
      tenantId: CLIENT_A, userId: USERS.clientA.id, userEmail: USERS.clientA.email, customer: A, reply: reply(A, [], { ...sentMsg, confirmed: true }), now: T0,
    });
    assert.equal(refused2.ok, false, "a brand but no mailbox of the teammate's own is still refused");
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

  // ── An agent's draft ───────────────────────────────────────────────────────
  await login(USERS.cc);
  await check("an agent's draft creates exactly ONE send_email approval, and is never sent", async () => {
    const draft = { subject: "Check-in", body: "AGENT-DRAFT", drafted_by: "agent", drafted_by_agent: "client-success" };
    const r1 = await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, draft), params({ id: X.id })));
    assert.equal(r1.status, 200, JSON.stringify(r1.body));
    assert.equal(r1.body.status, "proposed");
    const r2 = await call(replyRoute.POST(req("POST", `/api/clients/${X.id}/reply`, draft), params({ id: X.id })));
    assert.equal(r2.body.created, false, "the same draft is the same approval");
    assert.equal(
      await count("SELECT COUNT(*) AS n FROM approvals WHERE tenant_id = ? AND action_kind = 'send_email' AND target_ref = ?", [OASIS, `customer:${X.id}`]),
      1,
    );
    assert.equal(await count("SELECT COUNT(*) AS n FROM lead_interactions WHERE content = 'AGENT-DRAFT'"), 0);
    const c = await conversations.loadClientConversation(db, OASIS, X, []);
    assert.deepEqual(c.drafts.map((d) => [d.status, d.subject]), [["pending", "Check-in"]]);
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

  // ── Last touch, health ─────────────────────────────────────────────────────
  await check("last touch is the latest activity, not updated_at: an edit is not a touch, an email is", async () => {
    const zr = await store.createCustomer(db, OASIS, { ...base, display_name: "Quiet Co", primary_email: "quiet@co.test" }, USERS.cc.id, new Date(ago(3)));
    assert.ok(zr.ok);
    await store.updateCustomer(db, OASIS, zr.customer.id, { tags: ["retainer"] }, T0, USERS.cc.id);
    const z = (await store.getCustomer(db, OASIS, zr.customer.id))!;
    assert.equal((await activity.lastTouchFor(db, OASIS, [z])).get(z.id), null, "creating and tagging the record touched nobody");
    await db.batch([li("li-z", OASIS, { preview: "hello quiet", to_email: "quiet@co.test", at: ago(1) })], "write");
    assert.equal((await activity.lastTouchFor(db, OASIS, [z])).get(z.id), ago(1));
    assert.match(await page(ClientsPage({ searchParams: Promise.resolve({ q: "Quiet" }) })), /Quiet Co/);
  });
  await check("the list and the record carry a health badge", async () => {
    await login(USERS.cc);
    const list = await page(ClientsPage({ searchParams: Promise.resolve({}) }));
    assert.match(list, /Health/);
    assert.match(list, /1 invoice is overdue\./, "X's badge carries its reason (an overdue invoice)");
    assert.match(await page(record(X.id, "health")), /1 invoice is overdue/);
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
    const list = await page(ClientsPage({ searchParams: Promise.resolve({}) }));
    const past = list.indexOf("Past clients");
    assert.ok(past > 0 && list.indexOf("Other Client") > past, "Y is listed under Past clients");
    assert.equal((await call(endRoute.POST(req("POST", `/api/clients/${A.id}/end-engagement`), params({ id: A.id })))).status, 404, "not OASIS's");
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
    await login(USERS.adon);
    const notOperator = await call(linkRoute.POST(req("POST", `/api/clients/${X.id}/link-workspace`, { client_tenant_id: CLIENT_A }), params({ id: X.id })));
    assert.equal(notOperator.status, 403);
    assert.equal(notOperator.body.error, "operator_only");
    await login(USERS.clientA);
    const notOasis = await call(linkRoute.POST(req("POST", `/api/clients/${A.id}/link-workspace`, { client_tenant_id: CLIENT_B }), params({ id: A.id })));
    assert.equal(notOasis.status, 403);
    await login(USERS.cc);
    const ok = await call(linkRoute.POST(req("POST", `/api/clients/${X.id}/link-workspace`, { client_tenant_id: CLIENT_A }), params({ id: X.id })));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal((await store.getCustomer(db, OASIS, X.id))!.client_tenant_id, CLIENT_A);
    const taken = await call(linkRoute.POST(req("POST", `/api/clients/${Y.id}/link-workspace`, { client_tenant_id: CLIENT_A }), params({ id: Y.id })));
    assert.equal(taken.status, 409);
    assert.equal(taken.body.error, "client_tenant_taken");
    const self = await call(linkRoute.POST(req("POST", `/api/clients/${Y.id}/link-workspace`, { client_tenant_id: OASIS }), params({ id: Y.id })));
    assert.equal(self.body.error, "client_tenant_is_this_workspace");
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
  await check("Stripe import: plan first; creates with a name and an email only, links by email, skips what it cannot know", async () => {
    const plan = await sync.planStripeImport(db, OASIS);
    const by = Object.fromEntries(plan.map((p) => [p.group.stripe_customer_id, p.action]));
    assert.deepEqual(by, { cus_ANON: "skip", cus_NEW: "create", cus_OLD: "create", cus_X: "skip", cus_Y: "link" }, "test-mode customers are not read");
    const customersBefore = await count("SELECT COUNT(*) AS n FROM customers WHERE tenant_id = ?", [OASIS]);
    const r = await sync.runStripeImport(db, OASIS, USERS.cc.id, T0);
    assert.equal(r.created.length, 2);
    assert.deepEqual(r.linked, [Y.id]);
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
  await check("Stripe import is idempotent: a second run creates and links nothing", async () => {
    const before = await count("SELECT COUNT(*) AS n FROM customers");
    const r = await sync.runStripeImport(db, OASIS, USERS.cc.id, T0);
    assert.deepEqual([r.created.length, r.linked.length, r.conflicts.length], [0, 0, 0]);
    assert.equal(await count("SELECT COUNT(*) AS n FROM customers"), before);
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

  finish("clients-hub");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
