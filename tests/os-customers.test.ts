/**
 * os-customers.test.ts — Clients (the business's OWN customers) and the
 * per-workspace support desk.
 * Run: node --conditions=react-server --import tsx tests/os-customers.test.ts
 *
 * WHY. "Clients" became a first-class `customers` table (migration
 * bravo__188, docs/os-revamp/PLAN.md decision 5) and every workspace got its
 * own support desk (tenant_id = the business, the requester = its customer),
 * where before there was one desk pinned to OASIS. libSQL has no row-level
 * security: the WHERE clause the store builds from the SESSION's tenant is the
 * only thing between one business's customers and another's. So this test
 * drives the REAL migrations (183 + bravo__188), the real stores and the real
 * route handlers with real signed sessions, and pins:
 *
 *   - customers CRUD, the lifecycle vocabulary, and per-workspace uniqueness of
 *     email / Stripe customer / source lead (a unique index, not a pre-check);
 *   - "Convert to client" from a WON lead: idempotent under repeats and a race,
 *     refused for a lead that has not been won or belongs to another workspace,
 *     merges into a hand-made record with the same email, and links the deal's
 *     existing projects and tickets;
 *   - tenant isolation: workspace B can neither read nor change A's customers,
 *     contacts, desk tickets or support submissions — through the store AND
 *     through every API route — and a tenant_id in a request body is ignored;
 *   - the per-workspace support form: turned on per workspace, a submission to
 *     /f/<slug>/support (through the real /api/forms/submit route) becomes a
 *     ticket on THAT workspace's desk, linked to the client whose email it
 *     came from, never a lead and never an OASIS notification; a workspace's
 *     ordinary `support` lead form is not hijacked;
 *   - OASIS's desk unchanged: its form, its lanes, its vendor view for client
 *     workspaces, and the SLA cron alerting only through OASIS's lanes.
 */
import "./_delivery-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import { createElement, type ReactNode } from "react";
import { CLIENT_A, CLIENT_B, OASIS, USERS, check, finish, login, setupDatabase, splitSql } from "./_delivery-harness";

type Json = Record<string, unknown>;

// Pages are called as server components: tsconfig's jsx:"preserve" makes tsx
// use the classic runtime (a global React), and next/link needs the browser
// router, so it stands in as a plain anchor (as in tests/delivery-pages.test.ts).
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

/**
 * Every string in an element tree, props included — what the page fetched and
 * would ship. Plain server function components are rendered so their own text
 * counts; a client component calls hooks, which do not exist under
 * react-server and throw, so for those the props (what would be serialized to
 * the browser) are walked instead.
 */
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

const MIGRATION_188 = join(__dirname, "..", "database", "turso", "bravo__188_os_customers.sql");
const CLIENT_C = "cccccccc-0000-4000-8000-00000000000c";
const MEMBER_A = { id: "0d000000-0000-4000-8000-0000000000a2", email: "helper@client-a.test" };
const OWNER_C = { id: "0d000000-0000-4000-8000-00000000000c", email: "owner@client-c.test" };

async function main() {
  const db = await setupDatabase();
  for (const stmt of splitSql(readFileSync(MIGRATION_188, "utf8"))) await db.execute(stmt);
  await db.executeMultiple(`
    CREATE TABLE lead_documents (id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, filename TEXT, mime_type TEXT,
      size_bytes INTEGER, doc_type TEXT, storage_path TEXT, uploaded_by TEXT, uploaded_at TEXT, metadata TEXT);
    CREATE TABLE tenant_manifests (id TEXT PRIMARY KEY, tenant_id TEXT, slug TEXT UNIQUE, manifest TEXT,
      version INTEGER, schema_version INTEGER, created_at TEXT, updated_at TEXT);
  `);
  // A provisioned workspace for each client tenant, so the OS page gate
  // (requireOsRoute) admits their owners to /clients as it does in production.
  const { parseManifest } = await import("../lib/manifest/schema");
  const { finalizeManifestFromWizard } = await import("../lib/manifest/wizard-finalize");
  for (const [id, tenant, slug] of [["m-a", CLIENT_A, "client-a"], ["m-b", CLIENT_B, "client-b"]] as const) {
    await db.execute({
      sql: "INSERT INTO tenant_manifests VALUES (?, ?, ?, ?, 1, 1, '2026-01-01', '2026-01-01')",
      args: [id, tenant, slug, JSON.stringify(parseManifest(finalizeManifestFromWizard({ template: "custom", slug, answers: {} })))],
    });
  }
  const profile = (u: { id: string; email: string }, tenant: string, role: string, owner: 0 | 1) => [
    { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [u.id, u.email] },
    {
      sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, '2026-09-01T00:00:00Z', ?, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
      args: [`p-${u.id}`, u.id, u.email, tenant, role, owner, u.email.split("@")[0]],
    },
  ];
  await db.batch(
    [
      { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'client-c', 'Client C Studio')", args: [CLIENT_C] },
      ...profile(MEMBER_A, CLIENT_A, "member", 0),
      ...profile(OWNER_C, CLIENT_C, "owner", 1),
    ],
    "write",
  );

  const rules = await import("../lib/os/customers/rules");
  const store = await import("../lib/os/customers/store");
  const delivery = await import("../lib/delivery/store");
  const desks = await import("../lib/delivery/desks");
  const intake = await import("../lib/delivery/support-intake");
  const notify = await import("../lib/delivery/notify");
  const { runSlaCheck } = await import("../lib/delivery/sla-cron");
  const { NextRequest } = await import("next/server");
  const customersRoute = await import("../app/api/customers/route");
  const customerRoute = await import("../app/api/customers/[id]/route");
  const contactsRoute = await import("../app/api/customers/[id]/contacts/route");
  const convertRoute = await import("../app/api/customers/convert/route");
  const deskRoute = await import("../app/api/support-desk/route");
  const tickets = await import("../app/api/tickets/route");
  const ticket = await import("../app/api/tickets/[id]/route");
  const comments = await import("../app/api/tickets/[id]/comments/route");
  const submitRoute = await import("../app/api/forms/submit/route");
  const formByIdRoute = await import("../app/api/forms/[id]/route");

  const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    new NextRequest(`http://localhost${url}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (p: Promise<Response>) => {
    const res = await p;
    return { status: res.status, body: (await res.json()) as Json };
  };
  const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
  const count = async (sql: string, args: unknown[] = []) => Number((await db.execute({ sql, args: args as never })).rows[0].n);
  const T0 = new Date("2026-09-28T12:00:00.000Z");
  const input = (over: Partial<Parameters<typeof store.createCustomer>[2]> = {}) => ({
    display_name: "Acme Roofing",
    company_name: "Acme Roofing Ltd",
    primary_email: "ops@acme.test",
    primary_phone: "+15145550100",
    lifecycle: "active" as const,
    owner_user_id: null,
    stripe_customer_id: null,
    tags: [],
    custom_fields: {},
    ...over,
  });

  console.log("os-customers:");

  // ── rules ──────────────────────────────────────────────────────────────
  await check("rules: the lifecycle vocabulary is exactly the design's, labelled once", () => {
    assert.deepEqual([...rules.CUSTOMER_LIFECYCLES], ["prospect", "onboarding", "active", "paused", "churned"]);
    for (const l of rules.CUSTOMER_LIFECYCLES) assert.ok(rules.CUSTOMER_LIFECYCLE_LABELS[l]);
    assert.deepEqual([...rules.CONVERTIBLE_LEAD_STAGES], ["won", "onboarding", "in_build", "client_review", "launched"]);
    assert.equal(rules.lifecycleForLeadStage("won"), "onboarding");
    assert.equal(rules.lifecycleForLeadStage("launched"), "active");
  });
  await check("rules: create validation normalises email and phone, refuses unknown values, never reads tenant from the body", () => {
    const v = rules.validateCustomerCreate({
      display_name: "  ", company_name: "Brio Dental", primary_email: "  Front@Brio.TEST ", primary_phone: "(514) 555-0199",
      tags: "vip, retainer, VIP", tenant_id: CLIENT_B, source_lead_id: "x",
    });
    assert.ok(v.ok, JSON.stringify(v));
    if (!v.ok) return;
    assert.equal(v.value.display_name, "Brio Dental", "a blank name falls back to the company");
    assert.equal(v.value.primary_email, "front@brio.test");
    assert.equal(v.value.primary_phone, "+15145550199");
    assert.deepEqual(v.value.tags, ["vip", "retainer"]);
    assert.equal("tenant_id" in v.value, false);
    assert.equal("source_lead_id" in v.value, false);
    assert.deepEqual(rules.validateCustomerCreate({ display_name: "X", lifecycle: "vip" }), { ok: false, error: "lifecycle_invalid", field: "lifecycle" });
    assert.deepEqual(rules.validateCustomerCreate({ display_name: "X", primary_email: "nope" }), { ok: false, error: "primary_email_invalid", field: "primary_email" });
    assert.equal(rules.validateCustomerCreate({}).ok, false, "a client needs a name, a company or an email");
    assert.deepEqual(rules.validateCustomerPatch({}), { ok: false, error: "no_changes" });
  });

  // ── CRUD + uniqueness (store) ──────────────────────────────────────────
  const a1 = await store.createCustomer(db, CLIENT_A, input(), USERS.clientA.id, T0);
  assert.ok(a1.ok, JSON.stringify(a1));
  const acme = a1.ok ? a1.customer : null!;
  await check("create: the record is the workspace's, with what was given and nothing invented", async () => {
    assert.equal(acme.display_name, "Acme Roofing");
    assert.equal(acme.primary_email, "ops@acme.test");
    assert.equal(acme.lifecycle, "active");
    assert.equal(acme.source_lead_id, null);
    const row = (await db.execute({ sql: "SELECT tenant_id FROM customers WHERE id = ?", args: [acme.id] })).rows[0];
    assert.equal(row.tenant_id, CLIENT_A);
  });
  await check("uniqueness: one email per workspace, enforced by the index, naming the holder", async () => {
    const dup = await store.createCustomer(db, CLIENT_A, input({ display_name: "Acme again" }), null, T0);
    assert.deepEqual(dup, { ok: false, error: "email_taken", existingId: acme.id });
    const race = await Promise.all([
      store.createCustomer(db, CLIENT_A, input({ display_name: "R1", primary_email: "race@acme.test" }), null, T0),
      store.createCustomer(db, CLIENT_A, input({ display_name: "R2", primary_email: "race@acme.test" }), null, T0),
    ]);
    assert.equal(race.filter((r) => r.ok).length, 1, "two racing creates: exactly one wins");
    assert.equal(await count("SELECT count(*) AS n FROM customers WHERE tenant_id = ? AND primary_email = 'race@acme.test'", [CLIENT_A]), 1);
    const otherWorkspace = await store.createCustomer(db, CLIENT_B, input({ display_name: "Acme (B's)" }), null, T0);
    assert.ok(otherWorkspace.ok, "the same address is a separate client in another workspace");
    const stripe1 = await store.createCustomer(db, CLIENT_A, input({ display_name: "S1", primary_email: null, stripe_customer_id: "cus_A1" }), null, T0);
    const stripe2 = await store.createCustomer(db, CLIENT_A, input({ display_name: "S2", primary_email: null, stripe_customer_id: "cus_A1" }), null, T0);
    assert.ok(stripe1.ok);
    assert.equal(stripe2.ok ? "created" : stripe2.error, "stripe_customer_taken");
    const noEmail = await store.createCustomer(db, CLIENT_A, input({ display_name: "No email 2", primary_email: null }), null, T0);
    assert.ok(noEmail.ok, "many clients may have no email (the index is partial)");
  });
  await check("update: fields change, a stolen email is refused, archive hides from the list", async () => {
    const r = await store.updateCustomer(db, CLIENT_A, acme.id, { lifecycle: "paused", tags: ["retainer"] }, T0);
    assert.ok(r.ok && r.customer.lifecycle === "paused" && r.customer.tags[0] === "retainer", JSON.stringify(r));
    assert.deepEqual(r.ok ? r.changed.sort() : null, ["lifecycle", "tags"]);
    const steal = await store.updateCustomer(db, CLIENT_A, acme.id, { primary_email: "race@acme.test" }, T0);
    assert.equal(steal.ok ? "changed" : steal.error, "email_taken");
    const made = await store.createCustomer(db, CLIENT_A, input({ display_name: "Gone Co", primary_email: "gone@acme.test" }), null, T0);
    assert.ok(made.ok);
    if (!made.ok) return;
    await store.updateCustomer(db, CLIENT_A, made.customer.id, { archived: true }, T0);
    const list = await store.listCustomers(db, CLIENT_A);
    assert.equal(list.rows.some((c) => c.id === made.customer.id), false);
    const all = await store.listCustomers(db, CLIENT_A, { includeArchived: true });
    assert.equal(all.rows.some((c) => c.id === made.customer.id), true);
    const paused = await store.listCustomers(db, CLIENT_A, { lifecycle: "paused" });
    assert.deepEqual(paused.rows.map((c) => c.id), [acme.id]);
    assert.equal(paused.rows[0].open_ticket_count, null, "without withDelivery a count is unknown, not 0");
  });
  await check("contacts: added and removed on the workspace's own client only", async () => {
    const c = await store.addContact(db, CLIENT_A, acme.id, { name: "Dana", email: "dana@acme.test", phone: null, role: "Office manager" }, T0);
    assert.ok(c);
    assert.deepEqual((await store.listContacts(db, CLIENT_A, acme.id)).map((x) => x.name), ["Dana"]);
    assert.equal(await store.matchCustomerByEmail(db, CLIENT_A, "DANA@acme.test"), acme.id, "a contact's email matches the client");
    assert.equal(await store.isCustomerEmail(db, CLIENT_A, "DANA@acme.test"), true, "a contact's email is a client's address");
  });
  await check("a contact listed at two clients: no single match, but a client's address", async () => {
    const made = await store.createCustomer(db, CLIENT_A, input({ display_name: "Birch Plumbing", primary_email: "office@birch.test" }), null, T0);
    assert.ok(made.ok);
    const other = made.ok ? made.customer : null!;
    assert.ok(await store.addContact(db, CLIENT_A, acme.id, { name: "Lee", email: "books@ledger.test", phone: null, role: "Bookkeeper" }, T0));
    assert.ok(await store.addContact(db, CLIENT_A, other.id, { name: "Lee", email: "books@ledger.test", phone: null, role: "Bookkeeper" }, T0));
    assert.equal(await store.matchCustomerByEmail(db, CLIENT_A, "books@ledger.test"), null, "which client is never guessed");
    assert.equal(await store.isCustomerEmail(db, CLIENT_A, "Books@Ledger.test"), true, "but it is a client's address");
    assert.equal(await store.isCustomerEmail(db, CLIENT_A, "office@birch.test"), true, "a client's primary address");
    assert.equal(await store.isCustomerEmail(db, CLIENT_A, "stranger@nowhere.test"), false);
    assert.equal(await store.isCustomerEmail(db, CLIENT_A, ""), false);
    await store.updateCustomer(db, CLIENT_A, other.id, { archived: true }, T0);
    assert.equal(await store.isCustomerEmail(db, CLIENT_A, "office@birch.test"), false, "an archived client's address is not a current client's");
    assert.equal(await store.isCustomerEmail(db, CLIENT_A, "books@ledger.test"), true, "still a contact at a current client");
  });

  // ── isolation, store level ─────────────────────────────────────────────
  await check("isolation (store): workspace B cannot read, list, change or match A's clients", async () => {
    assert.equal(await store.getCustomer(db, CLIENT_B, acme.id), null);
    assert.equal((await store.listCustomers(db, CLIENT_B)).rows.some((c) => c.id === acme.id), false);
    assert.deepEqual(await store.updateCustomer(db, CLIENT_B, acme.id, { display_name: "Pwned" }, T0), { ok: false, error: "not_found" });
    assert.equal(await store.addContact(db, CLIENT_B, acme.id, { name: "Eve", email: null, phone: null, role: null }, T0), null);
    const contactId = (await store.listContacts(db, CLIENT_A, acme.id))[0].id;
    assert.equal(await store.removeContact(db, CLIENT_B, acme.id, contactId), false);
    assert.equal(await store.matchCustomerByEmail(db, CLIENT_B, "dana@acme.test"), null);
    assert.equal(await store.isCustomerEmail(db, CLIENT_B, "dana@acme.test"), false, "A's client is not B's");
    assert.deepEqual(await store.listContacts(db, CLIENT_B, acme.id), []);
    assert.equal((await store.getCustomer(db, CLIENT_A, acme.id))!.display_name, "Acme Roofing", "A's record is untouched");
    await assert.rejects(store.listCustomers(db, "", {}), /a tenant id is required/, "an unscoped read refuses to run");
  });

  // ── convert a won lead ─────────────────────────────────────────────────
  const lead = (id: string, tenant: string, data: Json) =>
    db.execute({
      sql: "INSERT INTO tenant_records (id, tenant_id, entity_type, data) VALUES (?, ?, 'lead', ?)",
      args: [id, tenant, JSON.stringify(data)],
    });
  await lead("lead-won-1", CLIENT_A, { stage: "won", company: "Harbour Dental", name: "Dr. Lee", email: "Lee@Harbour.test", phone: "514 555 0142" });
  await lead("lead-won-2", CLIENT_A, { stage: "in_build", company: "Pine Bakery", email: "hello@pine.test" });
  await lead("lead-open", CLIENT_A, { stage: "qualified", company: "Maybe Co", email: "maybe@co.test" });
  await lead("lead-merge", CLIENT_A, { stage: "launched", name: "Solo Sam", email: "ops@acme.test" });
  await lead("lead-b", CLIENT_B, { stage: "won", company: "B's deal", email: "deal@b.test" });
  // Work that already exists for the deal, before it is a client.
  const projectForDeal = await delivery.createProject(db, CLIENT_A, {
    title: "Harbour site", description: null, client_tenant_id: null, client_name: "Harbour Dental", client_email: "lee@harbour.test",
    lead_id: "lead-won-1", stage: "building", priority: "medium", assigned_to: null, due_date: null,
  }, { userId: USERS.clientA.id, name: "Alice" }, T0);
  const ticketBase = {
    description: null, category: "bug" as const, severity: "medium" as const, source: "internal" as const,
    client_tenant_id: null, client_name: null, client_company: null, client_match: "none", project_hint: null,
    reporter_user_id: null, assigned_to: null,
  };
  const onProject = (await delivery.createTicket(db, CLIENT_A, { ...ticketBase, title: "On the project", project_id: projectForDeal, client_email: null }, T0)).ticket;
  const byEmail = (await delivery.createTicket(db, CLIENT_A, { ...ticketBase, title: "From their email", project_id: null, client_email: "lee@harbour.test" }, T0)).ticket;

  let harbourId = "";
  await check("convert: a won lead becomes a client linked by source_lead_id, with its contact and its work", async () => {
    const r = await store.convertLeadToCustomer(db, CLIENT_A, "lead-won-1", USERS.clientA.id, T0);
    assert.ok(r.ok && r.created, JSON.stringify(r));
    if (!r.ok) return;
    harbourId = r.customer.id;
    assert.equal(r.customer.display_name, "Harbour Dental");
    assert.equal(r.customer.primary_email, "lee@harbour.test");
    assert.equal(r.customer.primary_phone, "+15145550142");
    assert.equal(r.customer.lifecycle, "onboarding");
    assert.equal(r.customer.source_lead_id, "lead-won-1");
    assert.deepEqual((await store.listContacts(db, CLIENT_A, harbourId)).map((c) => c.name), ["Dr. Lee"]);
    const p = (await db.execute({ sql: "SELECT customer_id FROM delivery_projects WHERE id = ?", args: [projectForDeal] })).rows[0];
    assert.equal(p.customer_id, harbourId, "the deal's project is linked");
    const t1 = (await db.execute({ sql: "SELECT customer_id FROM support_tickets WHERE id = ?", args: [onProject.id] })).rows[0];
    const t2 = (await db.execute({ sql: "SELECT customer_id FROM support_tickets WHERE id = ?", args: [byEmail.id] })).rows[0];
    assert.equal(t1.customer_id, harbourId, "a ticket on the project is linked");
    assert.equal(t2.customer_id, harbourId, "a ticket from the client's email is linked");
    const stage = JSON.parse(String((await db.execute({ sql: "SELECT data FROM tenant_records WHERE id = 'lead-won-1'", args: [] })).rows[0].data)).stage;
    assert.equal(stage, "won", "the pipeline is untouched");
  });
  await check("convert is idempotent: again, and racing, return the same one record", async () => {
    const again = await store.convertLeadToCustomer(db, CLIENT_A, "lead-won-1", USERS.clientA.id, T0);
    assert.ok(again.ok && !again.created && again.customer.id === harbourId, JSON.stringify(again));
    const race = await Promise.all([1, 2, 3].map(() => store.convertLeadToCustomer(db, CLIENT_A, "lead-won-2", null, T0)));
    assert.ok(race.every((r) => r.ok));
    const ids = new Set(race.map((r) => (r.ok ? r.customer.id : "")));
    assert.equal(ids.size, 1, "three converts, one client");
    assert.equal(race.filter((r) => r.ok && r.created).length, 1);
    assert.equal(await count("SELECT count(*) AS n FROM customers WHERE tenant_id = ? AND source_lead_id = 'lead-won-2'", [CLIENT_A]), 1);
  });
  await check("convert refuses a lead that is not won, and another workspace's lead", async () => {
    assert.deepEqual(await store.convertLeadToCustomer(db, CLIENT_A, "lead-open", null, T0), { ok: false, status: 409, error: "lead_not_won" });
    assert.deepEqual(await store.convertLeadToCustomer(db, CLIENT_B, "lead-won-1", null, T0), { ok: false, status: 404, error: "lead_not_found" });
    assert.deepEqual(await store.convertLeadToCustomer(db, CLIENT_A, "lead-b", null, T0), { ok: false, status: 404, error: "lead_not_found" });
    assert.equal(await count("SELECT count(*) AS n FROM customers WHERE tenant_id = ? AND source_lead_id = 'lead-won-1'", [CLIENT_B]), 0);
  });
  await check("convert merges into a hand-made client with the same email instead of duplicating", async () => {
    const r = await store.convertLeadToCustomer(db, CLIENT_A, "lead-merge", null, T0);
    assert.ok(r.ok && !r.created && r.linkedBy === "email" && r.customer.id === acme.id, JSON.stringify(r));
    assert.equal((await store.getCustomer(db, CLIENT_A, acme.id))!.source_lead_id, "lead-merge");
    await lead("lead-merge-2", CLIENT_A, { stage: "won", email: "ops@acme.test" });
    const other = await store.convertLeadToCustomer(db, CLIENT_A, "lead-merge-2", null, T0);
    assert.deepEqual(other, { ok: false, status: 409, error: "email_belongs_to_another_client", existingId: acme.id });
  });
  await check("converted deals: an archived client still counts as converted, and only in its own workspace", async () => {
    const won2 = (await store.getCustomerBySourceLead(db, CLIENT_A, "lead-won-2"))!;
    const archived = await store.updateCustomer(db, CLIENT_A, won2.id, { archived: true }, T0);
    assert.ok(archived.ok);
    try {
      const a = await store.customerIdsBySourceLead(db, CLIENT_A, ["lead-won-1", "lead-won-2", "lead-open", "lead-b"]);
      assert.deepEqual(
        [...a.entries()].sort(),
        [["lead-won-1", harbourId], ["lead-won-2", won2.id]].sort(),
        "archived lead-won-2 is still converted; unconverted and foreign leads are absent",
      );
      assert.equal((await store.customerIdsBySourceLead(db, CLIENT_B, ["lead-won-1", "lead-won-2"])).size, 0, "B never sees A's conversions");
      assert.equal((await store.customerIdsBySourceLead(db, CLIENT_A, [])).size, 0);
    } finally {
      await store.updateCustomer(db, CLIENT_A, won2.id, { archived: false }, T0);
    }
  });

  // ── API routes: customers ──────────────────────────────────────────────
  await login(null);
  await check("API: signed out is 401 on every customers route", async () => {
    assert.equal((await call(customersRoute.GET(req("GET", "/api/customers")))).status, 401);
    assert.equal((await call(customersRoute.POST(req("POST", "/api/customers", { display_name: "x" })))).status, 401);
    assert.equal((await call(convertRoute.POST(req("POST", "/api/customers/convert", { lead_id: "lead-won-1" })))).status, 401);
  });
  await login(USERS.clientB);
  let bOwnId = "";
  await check("API: B creates in B whatever the body claims; B's list never contains A's clients", async () => {
    const r = await call(customersRoute.POST(req("POST", "/api/customers", { display_name: "Bayview", primary_email: "bay@view.test", tenant_id: CLIENT_A })));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    bOwnId = String(r.body.id);
    const row = (await db.execute({ sql: "SELECT tenant_id FROM customers WHERE id = ?", args: [bOwnId] })).rows[0];
    assert.equal(row.tenant_id, CLIENT_B, "tenant_id in the body is ignored");
    const list = await call(customersRoute.GET(req("GET", "/api/customers?archived=1")));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const ids = (list.body.customers as Json[]).map((c) => c.id);
    assert.ok(ids.includes(bOwnId));
    assert.equal(ids.includes(acme.id) || ids.includes(harbourId), false);
  });
  await check("API: B cannot read, change, add contacts to, or convert into A's clients (404, no leak)", async () => {
    const g = await call(customerRoute.GET(req("GET", `/api/customers/${acme.id}`), params({ id: acme.id })));
    assert.equal(g.status, 404);
    assert.equal(JSON.stringify(g.body).includes("Acme"), false);
    const p = await call(customerRoute.PATCH(req("PATCH", `/api/customers/${acme.id}`, { display_name: "Pwned" }), params({ id: acme.id })));
    assert.equal(p.status, 404);
    const c = await call(contactsRoute.POST(req("POST", `/api/customers/${acme.id}/contacts`, { name: "Eve" }), params({ id: acme.id })));
    assert.equal(c.status, 404);
    const cv = await call(convertRoute.POST(req("POST", "/api/customers/convert", { lead_id: "lead-won-1" })));
    assert.equal(cv.status, 404);
    assert.equal(cv.body.error, "lead_not_found");
    assert.equal((await store.getCustomer(db, CLIENT_A, acme.id))!.display_name, "Acme Roofing");
  });
  await check("API: convert via the route is idempotent (201 then 200, same id)", async () => {
    const first = await call(convertRoute.POST(req("POST", "/api/customers/convert", { lead_id: "lead-b" })));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await call(convertRoute.POST(req("POST", "/api/customers/convert", { lead_id: "lead-b" })));
    assert.equal(second.status, 200);
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.created, false);
  });
  await login(MEMBER_A);
  await check("API: a member below owner/admin reads clients but cannot create, edit or convert", async () => {
    const list = await call(customersRoute.GET(req("GET", "/api/customers")));
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const row = (list.body.customers as Json[]).find((c) => c.id === acme.id)!;
    assert.equal(row.open_ticket_count, null, "desk counts are unknown for a non-owner, never 0");
    assert.equal((await call(customersRoute.POST(req("POST", "/api/customers", { display_name: "x" })))).status, 403);
    assert.equal((await call(customerRoute.PATCH(req("PATCH", `/api/customers/${acme.id}`, { lifecycle: "churned" }), params({ id: acme.id })))).status, 403);
    assert.equal((await call(convertRoute.POST(req("POST", "/api/customers/convert", { lead_id: "lead-open" })))).status, 403);
  });
  await login(USERS.clientA);
  await check("API: A's owner edits A's client; a duplicate email is a 409 naming the holder", async () => {
    const p = await call(customerRoute.PATCH(req("PATCH", `/api/customers/${harbourId}`, { lifecycle: "active", owner_user_id: USERS.clientA.id }), params({ id: harbourId })));
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal((p.body.customer as Json).owner_user_id, USERS.clientA.id);
    const bad = await call(customerRoute.PATCH(req("PATCH", `/api/customers/${harbourId}`, { owner_user_id: USERS.clientB.id }), params({ id: harbourId })));
    assert.equal(bad.status, 400, "an owner from another workspace is not on this team");
    assert.equal(bad.body.error, "owner_not_on_team");
    const dup = await call(customersRoute.POST(req("POST", "/api/customers", { display_name: "Dup", primary_email: "OPS@acme.test" })));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.existing_id, acme.id);
    const list = await call(customersRoute.GET(req("GET", "/api/customers")));
    const harbour = (list.body.customers as Json[]).find((c) => c.id === harbourId)!;
    assert.equal(harbour.open_ticket_count, 2, "the owner sees the desk's open tickets for the client");
    assert.equal(harbour.active_project_count, 1);
  });

  // ── API routes: the desk, isolated ─────────────────────────────────────
  let aDeskTicket = "";
  await check("desk API: A files a ticket on A's desk, for A's client; client-workspace links are refused", async () => {
    const r = await call(tickets.POST(req("POST", "/api/tickets?scope=desk", { title: "Gutter quote wrong", customer_id: acme.id, severity: "high" })));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    aDeskTicket = String(r.body.id);
    const row = (await db.execute({ sql: "SELECT tenant_id, customer_id, ticket_number FROM support_tickets WHERE id = ?", args: [aDeskTicket] })).rows[0];
    assert.equal(row.tenant_id, CLIENT_A);
    assert.equal(row.customer_id, acme.id);
    const ws = await call(tickets.POST(req("POST", "/api/tickets?scope=desk", { title: "x", client_tenant_id: CLIENT_B })));
    assert.equal(ws.status, 400);
    assert.equal(ws.body.error, "client_workspace_links_are_oasis_only");
    const foreign = await call(tickets.POST(req("POST", "/api/tickets?scope=desk", { title: "x", customer_id: bOwnId })));
    assert.equal(foreign.status, 400, "B's client is not a client of A's desk");
    assert.equal(foreign.body.error, "customer_not_found");
  });
  await check("desk numbering is per workspace: A's first ticket is T-0001 whatever OASIS holds", async () => {
    const first = (await db.execute({ sql: "SELECT ticket_number FROM support_tickets WHERE tenant_id = ? ORDER BY ticket_seq LIMIT 1", args: [CLIENT_A] })).rows[0];
    assert.equal(first.ticket_number, "T-0001");
  });
  await check("desk API: A's legacy (vendor) list still shows only OASIS's tickets about A, never A's own desk", async () => {
    const vendor = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    assert.equal(vendor.status, 200);
    assert.equal((vendor.body.tickets as Json[]).some((t) => t.id === aDeskTicket), false);
    const deskList = await call(tickets.GET(req("GET", "/api/tickets?scope=desk&status=all")));
    assert.ok((deskList.body.tickets as Json[]).some((t) => t.id === aDeskTicket));
    const own = await call(ticket.GET(req("GET", `/api/tickets/${aDeskTicket}`), params({ id: aDeskTicket })));
    assert.equal(own.status, 200);
    assert.equal((own.body.ticket as Json).customer_id, acme.id, "the team reads the full ticket");
  });
  await login(USERS.clientB);
  await check("isolation (API): B cannot read, list, change or comment on A's desk tickets", async () => {
    const deskList = await call(tickets.GET(req("GET", "/api/tickets?scope=desk&status=all")));
    assert.equal(deskList.status, 200);
    assert.equal((deskList.body.tickets as Json[]).some((t) => t.id === aDeskTicket), false);
    assert.equal((await call(ticket.GET(req("GET", `/api/tickets/${aDeskTicket}`), params({ id: aDeskTicket })))).status, 404);
    assert.equal((await call(ticket.PATCH(req("PATCH", `/api/tickets/${aDeskTicket}`, { status: "closed" }), params({ id: aDeskTicket })))).status, 404);
    assert.equal((await call(comments.POST(req("POST", `/api/tickets/${aDeskTicket}/comments`, { body: "hi" }), params({ id: aDeskTicket })))).status, 404);
    const filtered = await call(tickets.GET(req("GET", `/api/tickets?scope=desk&status=all&customer_id=${acme.id}`)));
    assert.deepEqual(filtered.body.tickets, [], "naming A's client id in a filter reads nothing");
    const row = (await db.execute({ sql: "SELECT status FROM support_tickets WHERE id = ?", args: [aDeskTicket] })).rows[0];
    assert.equal(row.status, "open");
  });
  await check("store: B's desk reader and writers cannot reach A's ticket by id", async () => {
    const bDesk = delivery.deskReader(CLIENT_B);
    assert.equal(await delivery.getTicket(db, bDesk, aDeskTicket), null);
    const u = await delivery.updateTicket(db, CLIENT_B, aDeskTicket, { status: "closed" }, { userId: "u", name: "B" }, T0);
    assert.deepEqual(u, { ok: false, status: 404, error: "not_found" });
    const c = await delivery.addTicketComment(db, CLIENT_B, aDeskTicket, { body: "x", is_internal: false, author_type: "team", author: { userId: "u", name: "B" } }, T0);
    assert.deepEqual(c, { ok: false, status: 404, error: "not_found" });
    const link = await delivery.updateTicket(db, CLIENT_A, aDeskTicket, { customer_id: bOwnId }, { userId: "u", name: "A" }, T0);
    assert.deepEqual(link, { ok: false, status: 409, error: "customer_not_found" }, "A cannot link B's client to its ticket");
  });

  // ── the per-workspace support form ─────────────────────────────────────
  await login(USERS.clientA);
  await check("support desk: A turns its form on (idempotent) at /f/client-a/support, with no OASIS branding", async () => {
    const on = await call(deskRoute.POST());
    assert.equal(on.status, 201, JSON.stringify(on.body));
    assert.equal(on.body.path, "/f/client-a/support");
    const again = await call(deskRoute.POST());
    assert.equal(again.status, 200);
    assert.equal(again.body.created, false);
    const form = (await db.execute({ sql: "SELECT tenant_id, branding, steps FROM forms WHERE tenant_id = ? AND slug = 'support'", args: [CLIENT_A] })).rows[0];
    assert.equal(form.tenant_id, CLIENT_A);
    assert.doesNotMatch(String(form.branding) + String(form.steps), /OASIS|#e8c547/i, "another business's form carries no OASIS name or colour");
    assert.match(String(form.branding), /Client A Plumbing Support/);
    assert.equal(await count("SELECT count(*) AS n FROM support_desks WHERE tenant_id = ?", [CLIENT_A]), 1);
  });
  await login(USERS.clientB);
  await check("support desk: B turns on its own; a member below owner cannot", async () => {
    const on = await call(deskRoute.POST());
    assert.equal(on.status, 201, JSON.stringify(on.body));
    assert.equal(on.body.path, "/f/client-b/support");
    await login(MEMBER_A);
    assert.equal((await call(deskRoute.POST())).status, 403);
  });
  await check("support desk: a workspace's own `support` LEAD form is never hijacked", async () => {
    await db.execute({
      sql: `INSERT INTO forms (tenant_id, slug, name, steps, enabled) VALUES (?, 'support', 'Get support pricing', '[{"key":"a","title":"A","fields":[]}]', 1)`,
      args: [CLIENT_C],
    });
    assert.equal(
      await intake.matchWorkspaceSupportDesk({ step_index: 0, anonymous_init: { tenant_slug: "client-c", form_slug: "support" } }, { db }),
      null,
      "an unregistered `support` form keeps the lead path",
    );
    assert.deepEqual(await desks.enableSupportDesk(db, CLIENT_C, OWNER_C.id, T0), { ok: false, status: 409, error: "support_slug_taken" });
    assert.equal(await intake.matchWorkspaceSupportDesk({ anonymous_init: { tenant_slug: "client-a", form_slug: "start" } }, { db }), null);
    assert.equal(await intake.matchWorkspaceSupportDesk({ token: "t", anonymous_init: { tenant_slug: "client-a", form_slug: "support" } }, { db }), null);
    const desk = await intake.matchWorkspaceSupportDesk({ anonymous_init: { tenant_slug: " Client-A ", form_slug: "SUPPORT" } }, { db });
    assert.equal(desk?.tenantId, CLIENT_A);
  });
  // Codex, PR #473: deleting the desk's form through the Forms page left a
  // registration with no form behind it — the desk still read "on", enabling
  // was a no-op, and the public URL stopped filing tickets for good.
  const deskFormOf = async (tenantId: string) =>
    String((await db.execute({ sql: "SELECT form_id FROM support_desks WHERE tenant_id = ?", args: [tenantId] })).rows[0]?.form_id ?? "");
  await login(USERS.clientA);
  await check("support desk: its intake form cannot be deleted through the Forms page (409), and stays", async () => {
    const formId = await deskFormOf(CLIENT_A);
    assert.ok(formId, "precondition: A's desk is registered");
    const r = await call(formByIdRoute.DELETE(req("DELETE", `/api/forms/${formId}`), { params: Promise.resolve({ id: formId }) }));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "support_desk_form");
    assert.equal(await count("SELECT count(*) AS n FROM forms WHERE id = ?", [formId]), 1, "the desk's form survived");
  });
  await login(USERS.clientB);
  await check("support desk: a desk whose form vanished reads as off; turning it on re-creates and re-registers it", async () => {
    const stale = await deskFormOf(CLIENT_B);
    await db.execute({ sql: "DELETE FROM forms WHERE id = ?", args: [stale] }); // as the Forms page could before the 409
    assert.equal((await desks.getDeskForm(db, CLIENT_B, "client-b")).state, "off", "a registration with no form is not a desk that is on");
    const on = await call(deskRoute.POST());
    assert.equal(on.status, 201, JSON.stringify(on.body));
    const fresh = await deskFormOf(CLIENT_B);
    assert.ok(fresh && fresh !== stale, "the stale registration was replaced by the new form");
    assert.equal(await count("SELECT count(*) AS n FROM support_desks WHERE tenant_id = ?", [CLIENT_B]), 1);
    const desk = await intake.matchWorkspaceSupportDesk({ anonymous_init: { tenant_slug: "client-b", form_slug: "support" } }, { db });
    assert.equal(desk?.tenantId, CLIENT_B, "the public URL files tickets again");
  });

  const leadsBefore = await count("SELECT count(*) AS n FROM tenant_records");
  const submit = async (tenantSlug: string, payload: Json, ip: string) =>
    call(
      submitRoute.POST(
        req("POST", "/api/forms/submit", { step_index: 0, anonymous_init: { tenant_slug: tenantSlug, form_slug: "support" }, payload }, { "x-forwarded-for": ip }),
      ),
    );
  let aFormTicket = "";
  await check("real route: /f/client-a/support files a ticket on A's desk, linked to A's client by email, and no lead", async () => {
    const r = await submit("client-a", {
      name: "Dana", email: "Dana@Acme.test", company: "Acme", category: "bug", priority: "critical",
      description: "The quote page is blank.",
    }, "10.8.0.1");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.match(String(r.body.ticket_number), /^T-\d{4}$/);
    const row = (await db.execute({
      sql: "SELECT id, tenant_id, customer_id, source, client_tenant_id, client_email FROM support_tickets WHERE form_submission_id = ?",
      args: [String(r.body.submission_id)],
    })).rows[0];
    aFormTicket = String(row.id);
    assert.equal(row.tenant_id, CLIENT_A);
    assert.equal(row.customer_id, acme.id, "matched through the client's contact email");
    assert.equal(row.source, "form");
    assert.equal(row.client_tenant_id, null, "a workspace desk never names a client workspace");
    const sub = (await db.execute({ sql: "SELECT tenant_id, lead_id FROM form_submissions WHERE id = ?", args: [String(r.body.submission_id)] })).rows[0];
    assert.equal(sub.tenant_id, CLIENT_A);
    assert.equal(sub.lead_id, `ticket:${aFormTicket}`);
    assert.equal(await count("SELECT count(*) AS n FROM tenant_records"), leadsBefore, "no lead was created");
  });
  await check("real route: B's form files on B's desk, and A's client email does not match in B", async () => {
    const r = await submit("client-b", { name: "Dana", email: "dana@acme.test", category: "question", priority: "low", description: "Hours?" }, "10.8.0.2");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const row = (await db.execute({ sql: "SELECT tenant_id, customer_id FROM support_tickets WHERE form_submission_id = ?", args: [String(r.body.submission_id)] })).rows[0];
    assert.equal(row.tenant_id, CLIENT_B);
    assert.equal(row.customer_id, null);
  });
  await check("isolation: A's form ticket is on A's desk only — B's desk, B's reader and B's owner see none of it", async () => {
    await login(USERS.clientB);
    const list = await call(tickets.GET(req("GET", "/api/tickets?scope=desk&status=all")));
    assert.equal((list.body.tickets as Json[]).some((t) => t.id === aFormTicket), false);
    assert.equal((await call(ticket.GET(req("GET", `/api/tickets/${aFormTicket}`), params({ id: aFormTicket })))).status, 404);
    await login(USERS.cc);
    const oasis = await call(tickets.GET(req("GET", "/api/tickets?status=all")));
    assert.equal((oasis.body.tickets as Json[]).some((t) => t.id === aFormTicket), false, "OASIS's desk does not hold a client's customers' tickets");
  });
  await check("a workspace desk's intake notifications never use OASIS's lanes; the outcome is recorded honestly", async () => {
    const sent: string[] = [];
    const fake = {
      telegram: async (t: string) => (sent.push(`tg:${t}`), { ok: true }),
      email: async (m: { to: string }) => (sent.push(`mail:${m.to}`), { ok: true }),
      founderEmails: ["conaugh@oasisai.work"],
      appOrigin: "https://app.test",
    };
    const scheduled: Array<() => Promise<void>> = [];
    const desk = (await intake.matchWorkspaceSupportDesk({ anonymous_init: { tenant_slug: "client-a", form_slug: "support" } }, { db }))!;
    const res = await intake.handleWorkspaceSupportSubmission(
      new NextRequest("http://localhost/api/forms/submit", { method: "POST", headers: { "x-forwarded-for": "10.8.0.3" } }),
      { step_index: 0, anonymous_init: { tenant_slug: "client-a", form_slug: "support" }, payload: { name: "Ann", email: "ann@x.test", category: "other", priority: "low", description: "hi" } },
      desk,
      { db, notify: fake, schedule: (t) => void scheduled.push(t), now: () => T0 },
    );
    const body = (await res.json()) as Json;
    assert.equal(res.status, 200, JSON.stringify(body));
    for (const t of scheduled) await t();
    assert.deepEqual(sent, [], "no Telegram, no OASIS mailbox for another business's ticket");
    const row = (await db.execute({ sql: "SELECT founder_alert_status, client_ack_status FROM support_tickets WHERE ticket_number = ? AND tenant_id = ?", args: [String(body.ticket_number), CLIENT_A] })).rows[0];
    assert.equal(row.founder_alert_status, notify.NO_ALERT_LANE);
    assert.equal(row.client_ack_status, notify.NO_MAILBOX);
    assert.doesNotMatch(String(row.founder_alert_status), /FAILED/, "nothing failed; there is no lane");
  });

  // ── OASIS's desk unchanged ─────────────────────────────────────────────
  await check("OASIS's form still files on OASIS's desk through OASIS's lanes", async () => {
    const sent: string[] = [];
    const fake = {
      telegram: async (t: string) => (sent.push(`tg:${t.slice(0, 20)}`), { ok: true }),
      email: async (m: { to: string }) => (sent.push(`mail:${m.to}`), { ok: true }),
      founderEmails: ["conaugh@oasisai.work", "adon@oasisai.work"],
      appOrigin: "https://app.test",
    };
    const scheduled: Array<() => Promise<void>> = [];
    const res = await intake.handleSupportFormSubmission(
      new NextRequest("http://localhost/api/forms/submit", { method: "POST", headers: { "x-forwarded-for": "10.8.0.4" } }),
      { step_index: 0, anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: "support" }, payload: { name: "Alice", email: "owner@client-a.test", category: "bug", priority: "high", description: "Site down" } },
      { db, notify: fake, schedule: (t) => void scheduled.push(t), now: () => T0 },
    );
    const body = (await res.json()) as Json;
    assert.equal(res.status, 200, JSON.stringify(body));
    for (const t of scheduled) await t();
    const row = (await db.execute({ sql: "SELECT tenant_id, client_tenant_id, client_match FROM support_tickets WHERE form_submission_id = ?", args: [String(body.submission_id)] })).rows[0];
    assert.equal(row.tenant_id, OASIS);
    assert.equal(row.client_tenant_id, CLIENT_A, "OASIS's vendor match to a client workspace is unchanged");
    assert.equal(row.client_match, "email_tenant");
    assert.equal(sent.filter((s) => s.startsWith("tg:")).length, 1);
    assert.equal(sent.filter((s) => s.startsWith("mail:")).length, 2, "founders + the client's confirmation");
    assert.ok(intake.isSupportFormSubmission({ anonymous_init: { tenant_slug: "oasis-ai-cc", form_slug: "support" } }));
    assert.equal(intake.isSupportFormSubmission({ anonymous_init: { tenant_slug: "client-a", form_slug: "support" } }), false);
  });
  await check("OASIS's desk never matches a requester to a retired business's workspace; a live client's workspace still matches", async () => {
    const SUNBIZ = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
    await db.batch(
      [
        { sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'submissions', 'SunBiz')", args: [SUNBIZ] },
        {
          sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role) VALUES
                  ('p-sb-rep', 'u-sb-rep', 'rep@sunbiz.test', ?, 'owner'),
                  ('p-sb-both', 'u-sb-both', 'both@either.test', ?, 'member'),
                  ('p-a-both', 'u-a-both', 'both@either.test', ?, 'member')`,
          args: [SUNBIZ, SUNBIZ, CLIENT_A],
        },
      ],
      "write",
    );
    try {
      const none = { client_tenant_id: null, project_id: null, client_match: "none" };
      assert.deepEqual(await delivery.matchClientByEmail(db, "rep@sunbiz.test", null), none, "a SunBiz user's ticket names SunBiz's workspace");
      // In SunBiz and in client A: client A is the one client workspace among them.
      assert.deepEqual(await delivery.matchClientByEmail(db, "both@either.test", null), { client_tenant_id: CLIENT_A, project_id: null, client_match: "email_tenant" });
      assert.deepEqual(await delivery.matchClientByEmail(db, "owner@client-a.test", null), { client_tenant_id: CLIENT_A, project_id: null, client_match: "email_tenant" }, "control");
    } finally {
      await db.execute("DELETE FROM user_profiles WHERE id IN ('p-sb-rep', 'p-sb-both', 'p-a-both')");
      await db.execute({ sql: "DELETE FROM tenants WHERE id = ?", args: [SUNBIZ] });
    }
  });
  await check("SLA cron: a workspace desk's breach is flagged (its Breaching view) but alerted through no lane; OASIS's alerts", async () => {
    const sent: string[] = [];
    const fake = {
      telegram: async (t: string) => (sent.push(t), { ok: true }),
      email: async (m: { to: string; subject: string }) => (sent.push(m.subject), { ok: true }),
      founderEmails: ["conaugh@oasisai.work"],
      appOrigin: "https://app.test",
    };
    // The route took its tickets on the real clock; three hours on, the critical one is past its 1h target.
    const later = new Date(Date.now() + 3 * 60 * 60_000);
    const r = await runSlaCheck(db, fake, later);
    assert.equal(r.desks, 3, "OASIS + A + B");
    const aBreached = (await db.execute({ sql: "SELECT sla_breached_at, sla_breach_alert_at FROM support_tickets WHERE id = ?", args: [aFormTicket] })).rows[0];
    assert.ok(aBreached.sla_breached_at, "A's critical ticket is flagged");
    assert.equal(aBreached.sla_breach_alert_at, null, "and not claimed: nothing was sent for it");
    assert.ok(r.flagged_without_lane >= 1, JSON.stringify(r));
    assert.equal(sent.some((s) => s.includes("quote page")), false, "A's ticket text never reached OASIS's lanes");
    assert.ok(r.alerted >= 1, "OASIS's own breaches still alert");
    assert.deepEqual(r.alert_failures, []);
  });

  // ── the pages, server side ─────────────────────────────────────────────
  const ClientsPage = (await import("../app/clients/page")).default;
  const ClientRecordPage = (await import("../app/clients/[id]/page")).default;
  const ClientRecordLayout = (await import("../app/clients/[id]/layout")).default;
  const TicketsPage = (await import("../app/tickets/page")).default;
  const page = async (el: Promise<unknown>) => textOf(await el).join("\n");
  const is404 = async (el: Promise<unknown>) => {
    try {
      await el;
      return false;
    } catch (err) {
      return /NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message);
    }
  };
  // The record as Next draws it: the layout (header, New ticket, tab bar)
  // around the open tab. The tab renders first: a tab switch renders it alone,
  // so it must refuse on its own.
  const record = async (id: string, tab?: string) => {
    const body = await ClientRecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) });
    return ClientRecordLayout({ params: Promise.resolve({ id }), children: body as never });
  };

  await login(USERS.clientA);
  await check("/clients: A's owner sees A's client records, never B's", async () => {
    const t = await page(ClientsPage({ searchParams: Promise.resolve({}) }));
    assert.match(t, /Acme Roofing/);
    assert.match(t, /Harbour Dental/);
    assert.doesNotMatch(t, /Bayview|B's deal/);
  });
  await check("/clients/[id]: A's owner opens the record and each tab carries that client's real data", async () => {
    assert.match(await page(record(harbourId)), /Dr\. Lee/, "Overview: the contact");
    const ticketsTab = await page(record(harbourId, "tickets"));
    assert.match(ticketsTab, /On the project/);
    assert.match(ticketsTab, /From their email/);
    assert.doesNotMatch(ticketsTab, /Gutter quote wrong/, "another client's ticket is not on this record");
    assert.match(await page(record(harbourId, "projects")), /Harbour site/);
  });
  await check("/clients/[id]: New ticket can link the client's project from EVERY tab (Codex, #473)", async () => {
    // Activity lists no projects itself; before the fix the header form got
    // an empty project list on every tab but Overview and Projects.
    const activity = await page(record(harbourId, "activity"));
    assert.match(activity, /Harbour site/, "the form's project options carry the client's project");
    assert.ok(activity.includes(projectForDeal), "…by its id, as the option value");
  });
  await check("/clients/[id]: counts from a capped ticket read print as floors, and each tab says it was cut off", async () => {
    const many = Array.from({ length: 501 }, (_, i) => ({
      sql: `INSERT INTO support_tickets (id, tenant_id, ticket_seq, ticket_number, title, status, severity, sla_target, customer_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'Bulk', 'open', 'low', ?, ?, ?, ?)`,
      args: [`bulk-${i}`, CLIENT_A, 50_000 + i, `T-B${i}`, "2099-01-01T00:00:00.000Z", harbourId, T0.toISOString(), T0.toISOString()],
    }));
    await db.batch(many, "write");
    try {
      const overview = await page(record(harbourId));
      assert.match(overview, /\b\d{2,3}\+/, "the open-ticket tile is a floor, never an exact-looking total");
      assert.match(overview, /at least: the first 500 tickets were read/);
      assert.match(await page(record(harbourId, "files")), /Only attachments on the first 500 tickets are listed\./);
    } finally {
      await db.execute("DELETE FROM support_tickets WHERE id LIKE 'bulk-%'");
    }
  });
  // A tab click renders the PAGE alone (the layout is not rendered again), and
  // a first load runs page and layout side by side: each must refuse on its
  // own. Rendered together, the layout's own 404 would hide a page that leaked.
  const pageAlone = (id: string, tab?: string) =>
    ClientRecordPage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) });
  const layoutAlone = (id: string) => ClientRecordLayout({ params: Promise.resolve({ id }), children: null as never });
  const RECORD_TABS = [undefined, "conversations", "tickets", "activity", "files"] as const;
  await check("/clients/[id]: control: A's owner gets the page alone on every tab, and the layout alone", async () => {
    for (const tab of RECORD_TABS) await assert.doesNotReject(pageAlone(harbourId, tab), `page ${tab ?? "overview"}`);
    assert.match(await page(layoutAlone(harbourId)), /Harbour Dental/);
  });
  await check("/clients/[id]: another workspace's client is a 404 from the page alone on every tab, and from the layout alone", async () => {
    await login(USERS.clientB);
    for (const id of [acme.id, harbourId]) {
      for (const tab of RECORD_TABS) assert.equal(await is404(pageAlone(id, tab)), true, `page ${tab ?? "overview"} of ${id}`);
      assert.equal(await is404(layoutAlone(id)), true, `layout of ${id}`);
    }
    // And together, as before.
    assert.equal(await is404(record(acme.id)), true);
    assert.equal(await is404(record(harbourId, "tickets")), true);
  });
  await check("/clients/[id]: a member below owner sees the record, not its tickets (owners and admins only)", async () => {
    await login(MEMBER_A);
    const overview = await page(record(harbourId));
    assert.match(overview, /Harbour Dental/);
    const ticketsTab = await page(record(harbourId, "tickets"));
    assert.doesNotMatch(ticketsTab, /On the project|From their email/);
    assert.match(ticketsTab, /owners and admins/);
  });
  await check("/tickets: A's desk shows A's tickets in its views, plus 'Your requests to OASIS'; B's shows none of A's", async () => {
    await login(USERS.clientA);
    const a = await page(TicketsPage({ searchParams: Promise.resolve({ view: "breaching" }) }));
    assert.match(a, /Support desk/);
    assert.match(a, /Your requests to OASIS/);
    assert.match(a, /\/f\/client-a\/support/, "the desk shows its own public form");
    const all = await page(TicketsPage({ searchParams: Promise.resolve({ status: "all" }) }));
    assert.match(all, /Gutter quote wrong/);
    await login(USERS.clientB);
    const b = await page(TicketsPage({ searchParams: Promise.resolve({ status: "all" }) }));
    assert.doesNotMatch(b, /Gutter quote wrong|The quote page is blank/);
    assert.match(b, /\/f\/client-b\/support/);
  });

  // ── the submit route's shape ───────────────────────────────────────────
  const routeSource = readFileSync(join(__dirname, "..", "app", "api", "forms", "submit", "route.ts"), "utf8");
  await check("static guard: the workspace-desk branch sits right after OASIS's, before ANY lead code", () => {
    const handler = routeSource.slice(routeSource.indexOf("async function handleSubmit("));
    const branch = handler.search(/const supportDesk = await matchWorkspaceSupportDesk\(body\);\s*if \(supportDesk\) \{\s*return handleWorkspaceSupportSubmission\(req, body, supportDesk\);\s*\}/);
    assert.ok(branch > 0, "the workspace branch must be present verbatim");
    assert.ok(handler.indexOf("return handleSupportFormSubmission(req, body);") < branch, "OASIS's branch stays first");
    for (const marker of ["verifyFormLink(", "initAnonymousLead(", "rateLimit(", "uploadLeadDocument(", "dispatchLeadStageEvent(", "createRecord(", "updateRecord("]) {
      const at = handler.indexOf(marker);
      if (at >= 0) assert.ok(branch < at, `the workspace branch must come before ${marker}`);
    }
  });

  // ── a ticket on a project belongs to the project's client (Codex, #473) ──
  const cx = await store.createCustomer(db, CLIENT_A, input({ display_name: "Link X", primary_email: "x@link.test", company_name: null }), null, T0);
  const cy = await store.createCustomer(db, CLIENT_A, input({ display_name: "Link Y", primary_email: "y@link.test", company_name: null }), null, T0);
  assert.ok(cx.ok && cy.ok, "precondition: two client records");
  const X = cx.ok ? cx.customer.id : "";
  const Y = cy.ok ? cy.customer.id : "";
  const pX = await delivery.createProject(db, CLIENT_A, {
    title: "Link project", description: null, client_tenant_id: null, client_name: null, client_email: null,
    lead_id: null, stage: "building", priority: "medium", assigned_to: null, due_date: null, customer_id: X,
  }, { userId: USERS.clientA.id, name: "Alice" }, T0);
  const loose = (await delivery.createTicket(db, CLIENT_A, { ...ticketBase, title: "Link ticket", project_id: null, client_email: null }, T0)).ticket;
  const author = { userId: USERS.clientA.id, name: "Alice" };
  const customerOf = async (ticketId: string) =>
    String((await db.execute({ sql: "SELECT customer_id FROM support_tickets WHERE id = ?", args: [ticketId] })).rows[0]?.customer_id ?? "");
  await check("links: a ticket put on a project inherits the project's client record", async () => {
    const r = await delivery.updateTicket(db, CLIENT_A, loose.id, { project_id: pX }, author, T0);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(await customerOf(loose.id), X);
  });
  await check("links: re-pointing that ticket to another client is refused while it sits on the project", async () => {
    const r = await delivery.updateTicket(db, CLIENT_A, loose.id, { customer_id: Y }, author, T0);
    assert.deepEqual(r, { ok: false, status: 409, error: "project_belongs_to_another_customer" });
    assert.equal(await customerOf(loose.id), X, "nothing changed");
  });
  await check("links: moving the project to another client moves its tickets with it", async () => {
    assert.equal(await delivery.updateProject(db, CLIENT_A, pX, { customer_id: Y }, author, T0), true);
    assert.equal(await customerOf(loose.id), Y);
  });
  // The editor saves one field at a time (TicketForms patch), so moving a
  // ticket arrives as { project_id } alone (CodeRabbit, #473).
  const projectFor = (title: string, customerId: string | null, clientEmail: string | null = null) =>
    delivery.createProject(db, CLIENT_A, {
      title, description: null, client_tenant_id: null, client_name: null, client_email: clientEmail,
      lead_id: null, stage: "building", priority: "medium", assigned_to: null, due_date: null, customer_id: customerId,
    }, author, T0);
  const pX2 = await projectFor("Link project X2", X);
  const pNone = await projectFor("Link project, no client", null);
  await check("links: moving a ticket to another client's project takes that project's client", async () => {
    const r = await delivery.updateTicket(db, CLIENT_A, loose.id, { project_id: pX2 }, author, T0, { customer: () => "Link X" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(await customerOf(loose.id), X);
    const note = (await db.execute({ sql: "SELECT body FROM ticket_comments WHERE ticket_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", args: [loose.id] })).rows[0];
    assert.match(String(note?.body), /Linked to client "Link X", the project's client\./);
  });
  await check("links: clearing the client while the ticket sits on a client's project is refused", async () => {
    const r = await delivery.updateTicket(db, CLIENT_A, loose.id, { customer_id: null }, author, T0);
    assert.deepEqual(r, { ok: false, status: 409, error: "project_belongs_to_another_customer" });
    assert.equal(await customerOf(loose.id), X, "nothing changed");
  });
  await check("links: a project with no client leaves the ticket's own, which can then change freely", async () => {
    const moved = await delivery.updateTicket(db, CLIENT_A, loose.id, { project_id: pNone }, author, T0);
    assert.ok(moved.ok, JSON.stringify(moved));
    assert.equal(await customerOf(loose.id), X);
    assert.ok((await delivery.updateTicket(db, CLIENT_A, loose.id, { customer_id: Y }, author, T0)).ok);
    assert.equal(await customerOf(loose.id), Y);
    assert.ok((await delivery.updateTicket(db, CLIENT_A, loose.id, { customer_id: null }, author, T0)).ok);
    assert.equal(await customerOf(loose.id), "");
  });
  await check("intake: a failed project-client lookup keeps the request and the email match (CodeRabbit, #473)", async () => {
    const cz = await store.createCustomer(db, CLIENT_A, input({ display_name: "Intake Z", primary_email: "intake@link.test", company_name: null }), null, T0);
    assert.ok(cz.ok, "precondition: the requester has a client record");
    await projectFor("Intake project", X, "intake@link.test");
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "execute") {
          return async (stmt: Parameters<typeof db.execute>[0]) => {
            const sql = typeof stmt === "string" ? stmt : stmt.sql;
            if (/^SELECT customer_id FROM delivery_projects/.test(sql)) throw new Error("SQLITE_BUSY: database is locked");
            return target.execute(stmt);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const desk = (await intake.matchWorkspaceSupportDesk({ anonymous_init: { tenant_slug: "client-a", form_slug: "support" } }, { db }))!;
    const res = await intake.handleWorkspaceSupportSubmission(
      new NextRequest("http://localhost/api/forms/submit", { method: "POST", headers: { "x-forwarded-for": "10.8.0.9" } }),
      { step_index: 0, anonymous_init: { tenant_slug: "client-a", form_slug: "support" }, payload: { name: "Ivy", email: "intake@link.test", category: "other", priority: "low", description: "Lookup fails" } },
      desk,
      { db: flaky, notify: { telegram: async () => ({ ok: true }), email: async () => ({ ok: true }), founderEmails: [], appOrigin: "https://app.test" }, schedule: () => undefined, now: () => T0 },
    );
    const body = (await res.json()) as Json;
    assert.equal(res.status, 200, JSON.stringify(body));
    const row = (await db.execute({ sql: "SELECT customer_id FROM support_tickets WHERE form_submission_id = ?", args: [String(body.submission_id)] })).rows[0];
    assert.equal(String(row?.customer_id), cz.ok ? cz.customer.id : "", "the email match stands in for the lookup that failed");
  });
  await login(USERS.clientA);
  await check("links: the desk API refuses a new ticket naming a project AND a different client", async () => {
    const r = await call(tickets.POST(req("POST", "/api/tickets?scope=desk", { title: "Mismatch", project_id: pX, customer_id: X })));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "project_belongs_to_another_customer");
    const ok = await call(tickets.POST(req("POST", "/api/tickets?scope=desk", { title: "Inherits", project_id: pX })));
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(await customerOf(String(ok.body.id)), Y, "no client given: the project's is inherited");
  });

  finish("os-customers");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
