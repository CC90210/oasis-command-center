#!/usr/bin/env node
/**
 * scripts/qa/seed.mjs - SYNTHETIC rows for the QA crawl's LOCAL database.
 *
 *   node --conditions=react-server --import tsx scripts/qa/seed.mjs <local.db> <seed.json>
 *
 * Never production data: every name, email domain and amount below is made up
 * (.test domains), except the two founder addresses the app's own gates are
 * keyed on (lib/operator-credentials.ts, lib/founders-finances/access.ts),
 * without which no local session could hold CC's or Adon's role.
 *
 * Writes <seed.json>: the four viewers the crawl signs in as, and the ids that
 * fill each dynamic route ({ "/pipeline/[id]": [{ id }] ... }). Each row is the
 * one its page reads (table, id shape, tenant scope), so the page renders a
 * record rather than its not-found state:
 *   /clients/[id] customers; /pipeline/[id] + /web-leads/[id] tenant_records
 *   (entity lead); /interactions/[id] lead_interactions (uuid ids);
 *   /projects/[id] delivery_projects; /tickets/[id] support_tickets;
 *   /forms/[id]/edit forms (a valid step); /sequences/[id]/edit drip_sequences
 *   (a valid step); /founders/marketing/asset/[id] marketing_asset;
 *   /founders/finances/invoices/[id] fin_invoices (after the app's own
 *   ensureFinanceSeed); /agents/[slug] a custom OASIS agent.
 *
 * The client workspace's manifest is built by the app's own provisioning
 * builder (lib/provisioning/manifest.ts), so the client sees what a workspace
 * OASIS set up would show.
 *
 * Refuses any database URL: the target must be a local file. Network is cut
 * inside this process (fetch throws) and, in CI, by scripts/qa/egress-guard.cjs.
 */
import { createClient } from "@libsql/client";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const [dbFile, seedOut] = process.argv.slice(2);
if (!dbFile || !seedOut || /^(libsql|https?|wss?|file):/i.test(dbFile)) {
  console.error("usage: node --conditions=react-server --import tsx scripts/qa/seed.mjs <local.db> <seed.json>");
  process.exit(2);
}
for (const key of ["TURSO_DATABASE_URL", "TURSO_DB_URL", "OASIS_TURSO_DATABASE_URL", "BREEZE_TURSO_DATABASE_URL"]) {
  const v = process.env[key];
  if (v && !v.startsWith("file:")) {
    console.error(`refusing: ${key} names a remote database; the QA seed only writes a local file`);
    process.exit(2);
  }
}
// The app modules used below (ensureFinanceSeed) read the database through lib/turso.ts.
process.env.TURSO_DB_PATH = path.resolve(dbFile);
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
globalThis.fetch = async (input) => {
  throw new Error(`network is off in the QA seed: ${String(input).slice(0, 80)}`);
};

export const OASIS_TENANT = "ef8d389e-3f15-43f2-ae00-3660f69a1452"; // slug oasis-ai-cc
export const CLIENT_TENANT = "a0c3e000-0000-4000-8000-00000000ac3e";
const IDS = {
  cc: "0a515000-0000-4000-8000-000000000001",
  adon: "0a515000-0000-4000-8000-000000000003",
  rep: "0a515000-0000-4000-8000-000000000002",
  client: "0a515000-0000-4000-8000-0000000000c1",
  clientMember: "0a515000-0000-4000-8000-0000000000c2",
};
/** Deterministic uuid-shaped ids: some pages refuse an id that is not a uuid. */
let nextId = 0;
const uuid = () => `5eed0000-0000-4000-8000-${(++nextId).toString(16).padStart(12, "0")}`;
const now = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();
const day = (offset) => new Date(Date.now() + offset * 864e5).toISOString().slice(0, 10);

const db = createClient({ url: `file:${path.resolve(dbFile)}` });
const columnsCache = new Map();
const failures = [];

async function columns(table) {
  if (!columnsCache.has(table)) {
    const rs = await db.execute(`PRAGMA table_info("${table}")`);
    columnsCache.set(table, rs.rows.map((r) => ({ name: String(r.name), type: String(r.type || "").toUpperCase(), notnull: Number(r.notnull) === 1, dflt: r.dflt_value, pk: Number(r.pk) > 0 })));
  }
  return columnsCache.get(table);
}

/** A neutral value for a NOT NULL column the row did not name (the schema decides what is required). */
function filler(col) {
  const n = col.name.toLowerCase();
  if (/_at$|_on$|date$/.test(n)) return now;
  if (/(json|custom_fields|metadata|meta|data|config|settings|branding)$/.test(n)) return "{}";
  if (/(tags|steps|agents_enabled|prospect_focus|platforms|media_urls|list|items)$/.test(n)) return "[]";
  if (/INT|REAL|NUM|BOOL/.test(col.type)) return 0;
  return "";
}

/** INSERT a row, filling required columns it did not name; records (never hides) a refusal. */
async function insert(table, row, { required = false } = {}) {
  const cols = await columns(table);
  if (cols.length === 0) {
    failures.push(`${table}: no such table`);
    if (required) throw new Error(`seed: required table ${table} is missing from the schema`);
    return null;
  }
  const known = new Set(cols.map((c) => c.name));
  const values = {};
  for (const [k, v] of Object.entries(row)) if (known.has(k)) values[k] = v;
  for (const c of cols) {
    if (values[c.name] !== undefined || !c.notnull || c.dflt !== null || c.pk) continue;
    values[c.name] = filler(c);
  }
  const names = Object.keys(values);
  const sql = `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`;
  const args = names.map((n) => (values[n] !== null && typeof values[n] === "object" ? JSON.stringify(values[n]) : values[n]));
  try {
    await db.execute({ sql, args });
    return values.id ?? null;
  } catch (err) {
    const message = `${table}: ${String(err && err.message ? err.message : err).slice(0, 200)}`;
    failures.push(message);
    if (required) throw new Error(`seed: ${message}`);
    return null;
  }
}

const appModule = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

async function main() {
  const params = {};
  const addParam = (pattern, values) => {
    (params[pattern] ??= []).push(values);
  };

  // Workspaces.
  await insert("tenants", { id: OASIS_TENANT, slug: "oasis-ai-cc", name: "OASIS AI", plan_tier: "enterprise", purchase_status: "active", custom_fields: "{}", created_at: daysAgo(400), updated_at: now }, { required: true });
  await insert("tenants", { id: CLIENT_TENANT, slug: "acme-plumbing", name: "Acme Plumbing", plan_tier: "starter", purchase_status: "active", custom_fields: "{}", created_at: daysAgo(30), updated_at: now }, { required: true });

  // The client workspace's setup, built by the app's own provisioning builder.
  const { buildProvisionedManifest } = await appModule("lib/provisioning/manifest.ts");
  const manifest = buildProvisionedManifest({
    slug: "acme-plumbing",
    name: "Acme Plumbing",
    departments: ["chief_of_staff", "sales", "marketing", "client_success", "operations"],
    modules: [],
    now: daysAgo(29),
  });
  await insert("tenant_manifests", { id: uuid(), tenant_id: CLIENT_TENANT, slug: "acme-plumbing", manifest: JSON.stringify(manifest), version: 1, schema_version: manifest.meta?.schema_version ?? 1, created_at: daysAgo(29), updated_at: daysAgo(29) }, { required: true });
  await insert("provisioning_runs", { id: "qaprovisionrun0001", tenant_id: CLIENT_TENANT, tenant_slug: "acme-plumbing", status: "complete", steps_json: JSON.stringify([{ title: "Workspace ready", time: daysAgo(29) }]), started_at: daysAgo(29), completed_at: daysAgo(29), created_at: daysAgo(29) });
  const clientAgents = manifest.agents.map((a) => a.slug);

  // People. Passwords are never set: sessions are minted, nobody logs in.
  const people = [
    { key: "cc", email: "conaugh@oasisai.work", name: "Conaugh McKenna", display: "CC", tenant: OASIS_TENANT, team_role: "owner", is_owner: 1, admin_access: 0, agents: ["bravo", "atlas", "maven", "aura"], brand: "OASIS AI" },
    { key: "adon", email: "adon@oasisai.work", name: "Adon", display: "Adon", tenant: OASIS_TENANT, team_role: "admin", is_owner: 0, admin_access: 1, agents: ["bravo"], brand: "OASIS AI" },
    { key: "rep", email: "riley.rep@oasis-qa.test", name: "Riley Rep", display: "Riley", tenant: OASIS_TENANT, team_role: "closer", is_owner: 0, admin_access: 0, agents: ["bravo"], brand: "OASIS AI", invited_by: IDS.cc },
    { key: "client", email: "alex@acme-plumbing.test", name: "Alex Acme", display: "Alex", tenant: CLIENT_TENANT, team_role: "owner", is_owner: 1, admin_access: 0, agents: clientAgents, brand: "Acme Plumbing" },
    { key: "clientMember", email: "sam@acme-plumbing.test", name: "Sam Dispatcher", display: "Sam", tenant: CLIENT_TENANT, team_role: "member", is_owner: 0, admin_access: 0, agents: clientAgents, brand: "Acme Plumbing", invited_by: IDS.client },
  ];
  for (const p of people) {
    const id = IDS[p.key];
    await insert("_supabase_auth_users", { id, email: p.email, email_confirmed_at: daysAgo(60), raw_user_meta_data: JSON.stringify({ full_name: p.name }), created_at: daysAgo(60), updated_at: now, session_version: 0 }, { required: true });
    await insert(
      "user_profiles",
      {
        id: `qa-profile-${p.key}`,
        auth_user_id: id,
        email: p.email,
        full_name: p.name,
        display_name: p.display,
        brand: p.brand,
        role: "operator",
        agents_enabled: JSON.stringify(p.agents),
        primary_agent: p.agents[0] ?? "",
        tenant_id: p.tenant,
        prospect_focus: JSON.stringify(["service_trades"]),
        onboarding_completed_at: daysAgo(59),
        team_role: p.team_role,
        is_owner: p.is_owner,
        admin_access: p.admin_access,
        invited_by: p.invited_by ?? null,
        joined_at: daysAgo(59),
        custom_fields: JSON.stringify({ timezone: "America/Toronto" }),
        created_at: daysAgo(59),
        updated_at: now,
      },
      { required: true },
    );
  }

  // Business rows, a few per workspace, with the long names real data has.
  for (const [tenant, prefix, owner] of [
    [OASIS_TENANT, "oasis", IDS.cc],
    [CLIENT_TENANT, "acme", IDS.client],
  ]) {
    const customerName = prefix === "oasis" ? "Northshore Renovations and Custom Millwork Inc." : "Dorval Family Dental Clinic";
    const customer = await insert("customers", {
      id: uuid(),
      tenant_id: tenant,
      display_name: customerName,
      company_name: customerName,
      primary_email: `office@${prefix}-customer.test`,
      primary_phone: "+15145550147",
      lifecycle: "active",
      owner_user_id: owner,
      tags: JSON.stringify(["synthetic"]),
      custom_fields: "{}",
      created_by: owner,
      created_at: daysAgo(20),
      updated_at: daysAgo(2),
    });
    if (customer) addParam("/clients/[id]", { id: customer });

    // Pipeline leads (tenant_records, entity lead). On OASIS one is the rep's own,
    // so the rep's view of a record is crawled too, and both feed /web-leads/[id].
    const leadOwners = prefix === "oasis" ? [owner, IDS.rep] : [owner];
    for (const [i, assignee] of leadOwners.entries()) {
      const record = await insert("tenant_records", {
        id: uuid(),
        tenant_id: tenant,
        entity_type: "lead",
        data: JSON.stringify({
          name: i === 0 ? "Pointe-Claire Heating, Ventilation and Air Conditioning Services" : "Lachine Waterfront Bakery and Catering Company",
          business_name: i === 0 ? "Pointe-Claire Heating, Ventilation and Air Conditioning Services" : "Lachine Waterfront Bakery and Catering Company",
          contact_name: i === 0 ? "Jordan Example" : "Morgan Example",
          email: `contact${i}@${prefix}-lead.test`,
          phone: "+15145550199",
          website: `https://www.${prefix}-lead-${i}.test`,
          city: "Montreal",
          stage: "new",
          status: "new",
          source: "website",
          assigned_to: assignee,
        }),
        created_at: daysAgo(6 + i),
        updated_at: daysAgo(1),
      });
      if (record) {
        addParam("/pipeline/[id]", { id: record });
        if (prefix === "oasis") addParam("/web-leads/[id]", { id: record });
      }
    }

    const lead = await insert("leads", {
      id: uuid(),
      tenant_id: tenant,
      name: "Jordan Example",
      email: `jordan@${prefix}-lead.test`,
      phone: "+15145550199",
      company: "Pointe-Claire Heating, Ventilation and Air Conditioning Services",
      source: "website",
      status: "new",
      assigned_to: owner,
      created_at: daysAgo(6),
      updated_at: daysAgo(1),
    });
    const interaction = await insert("lead_interactions", {
      id: uuid(),
      tenant_id: tenant,
      lead_id: lead,
      type: "email",
      channel: "email",
      direction: "outbound",
      subject: "Following up on your quote request for the furnace replacement",
      content: "Hi Jordan, following up on the quote you asked for last week.",
      content_preview: "Hi Jordan, following up on the quote you asked for last week.",
      created_at: daysAgo(3),
      sent_at: daysAgo(3),
      actor_user_id: owner,
    });
    if (interaction) addParam("/interactions/[id]", { id: interaction });

    // A form and a sequence with one valid step each: an empty definition renders "corrupt".
    const form = await insert("forms", {
      id: uuid(),
      tenant_id: tenant,
      slug: "quote-request",
      name: "Quote request",
      description: "Synthetic form for the QA crawl",
      steps: JSON.stringify([{ key: "contact", title: "Contact", fields: [{ name: "email", label: "Email", type: "email" }] }]),
      enabled: 1,
      created_by: owner,
      created_at: daysAgo(15),
      updated_at: daysAgo(15),
    });
    if (form) addParam("/forms/[id]/edit", { id: form });

    const sequence = await insert("drip_sequences", {
      id: uuid(),
      tenant_id: tenant,
      name: "New quote follow-up",
      description: "Synthetic sequence for the QA crawl",
      trigger_event: "manual",
      steps: JSON.stringify([{ channel: "email", delay_minutes: 0, subject: "Thanks for asking about a quote", body: "We will call you within one business day." }]),
      enabled: 0,
      created_by: owner,
      created_at: daysAgo(15),
      updated_at: daysAgo(15),
    });
    if (sequence) addParam("/sequences/[id]/edit", { id: sequence });

    // Delivery: a project and a ticket on the workspace's own desk.
    const project = await insert("delivery_projects", {
      id: uuid(),
      tenant_id: tenant,
      title: prefix === "oasis" ? "Website rebuild and booking flow for Northshore Renovations" : "Patient reminder texts for the Dorval clinic",
      description: "Synthetic project for the QA crawl",
      client_name: customerName,
      client_email: `office@${prefix}-customer.test`,
      stage: "building",
      priority: "high",
      assigned_to: owner,
      due_date: day(14),
      started_at: daysAgo(10),
      created_by: owner,
      created_at: daysAgo(12),
      updated_at: daysAgo(1),
      customer_id: customer,
    });
    if (project) addParam("/projects/[id]", { id: project });
    const ticket = await insert("support_tickets", {
      id: uuid(),
      tenant_id: tenant,
      ticket_seq: 1,
      ticket_number: prefix === "oasis" ? "OAS-0001" : "ACM-0001",
      title: "The booking form does not send a confirmation email to the customer after they pick a time",
      description: "Synthetic ticket for the QA crawl",
      category: "bug",
      severity: "high",
      status: "open",
      source: "internal",
      project_id: project,
      client_name: customerName,
      client_email: `office@${prefix}-customer.test`,
      sla_target: new Date(Date.now() + 864e5).toISOString(),
      created_at: daysAgo(2),
      updated_at: daysAgo(1),
      customer_id: customer,
    });
    if (ticket) addParam("/tickets/[id]", { id: ticket });
  }

  // OASIS's delivery FOR the client: what the client owner sees as OASIS's work for them.
  const forClientProject = await insert("delivery_projects", {
    id: uuid(),
    tenant_id: OASIS_TENANT,
    title: "Acme Plumbing: dispatch board and quote follow-up automation",
    description: "Synthetic project OASIS runs for the client",
    client_tenant_id: CLIENT_TENANT,
    client_name: "Acme Plumbing",
    client_email: "alex@acme-plumbing.test",
    stage: "review",
    priority: "medium",
    assigned_to: IDS.cc,
    due_date: day(7),
    started_at: daysAgo(20),
    created_by: IDS.cc,
    created_at: daysAgo(21),
    updated_at: daysAgo(1),
  });
  if (forClientProject) addParam("/projects/[id]", { id: forClientProject });
  const forClientTicket = await insert("support_tickets", {
    id: uuid(),
    tenant_id: OASIS_TENANT,
    ticket_seq: 2,
    ticket_number: "OAS-0002",
    title: "Change the quote follow-up wording on the dispatch board",
    description: "Synthetic ticket the client opened with OASIS",
    category: "change_request",
    severity: "medium",
    status: "in_progress",
    source: "portal",
    project_id: forClientProject,
    client_tenant_id: CLIENT_TENANT,
    client_name: "Alex Acme",
    client_email: "alex@acme-plumbing.test",
    client_company: "Acme Plumbing",
    client_match: "session",
    reporter_user_id: IDS.client,
    sla_target: new Date(Date.now() + 2 * 864e5).toISOString(),
    created_at: daysAgo(1),
    updated_at: now,
  });
  if (forClientTicket) addParam("/tickets/[id]", { id: forClientTicket });

  const asset = await insert("marketing_asset", {
    id: uuid(),
    tenant_id: OASIS_TENANT,
    title: "Spring furnace tune-up reminder for homeowners across the West Island",
    channel: "organic-instagram",
    format: "image",
    status: "draft",
    hook: "Is your furnace ready?",
    body: "Synthetic marketing asset for the QA crawl.",
    author_agent: "human",
    author_email: "conaugh@oasisai.work",
    created_at: daysAgo(4),
    updated_at: daysAgo(4),
  });
  if (asset) addParam("/founders/marketing/asset/[id]", { id: asset });

  // A custom AI teammate in OASIS's workspace (seed agents 404 on /agents/[slug]).
  const agentSlug = "qa-dispatch-desk";
  const agent = await insert("agents", {
    id: uuid(),
    slug: agentSlug,
    name: "Dispatch Desk",
    category: "operations",
    short_description: "Answers where a crew is and when it will arrive",
    description: "Synthetic teammate for the QA crawl.",
    base_prompt: "You help the dispatch team answer customer questions about arrival times.",
    is_public: 0,
    is_oasis_managed: 0,
    created_by: IDS.cc,
    tenant_id: OASIS_TENANT,
    created_at: daysAgo(9),
    updated_at: daysAgo(9),
  });
  if (agent) addParam("/agents/[slug]", { slug: agentSlug });

  // Finances: the app's own book setup, then one invoice to a customer.
  try {
    const { ensureFinanceSeed } = await appModule("lib/founders-finances/seed-io.ts");
    await ensureFinanceSeed();
    const contact = await insert("fin_contacts", { id: uuid(), entity_id: "fin_ent_oasis", kind: "customer", name: "Northshore Renovations and Custom Millwork Inc.", email: "billing@oasis-customer.test", company: "Northshore Renovations and Custom Millwork Inc.", archived: 0, created_at: daysAgo(30) });
    const invoice = contact
      ? await insert("fin_invoices", {
          id: uuid(),
          entity_id: "fin_ent_oasis",
          contact_id: contact,
          number: "INV-QA-0001",
          status: "sent",
          issue_date: day(-10),
          due_date: day(20),
          currency: "CAD",
          subtotal_cents: 250000,
          gst_cents: 12500,
          qst_cents: 24938,
          total_cents: 287438,
          amount_paid_cents: 0,
          sent_at: daysAgo(10),
          sent_to: "billing@oasis-customer.test",
          created_by: "qa-seed",
          created_at: daysAgo(10),
          updated_at: daysAgo(10),
        })
      : null;
    if (invoice) addParam("/founders/finances/invoices/[id]", { id: invoice });
  } catch (err) {
    failures.push(`finance seed: ${String(err && err.message ? err.message : err).slice(0, 200)}`);
  }

  // Workspace-addressed pages: each workspace's own /t/<slug>, and a teammate.
  for (const slug of ["oasis-ai-cc", "acme-plumbing"]) {
    for (const pattern of ["/t/[slug]", "/t/[slug]/editor", "/t/[slug]/marketplace", "/t/[slug]/marketplace/new"]) addParam(pattern, { slug });
    // "sdr" is one of the app's built-in teammates (lib/agents/library.ts), neutral in name.
    addParam("/t/[slug]/marketplace/[agent]", { slug, agent: "sdr" });
    addParam("/t/[slug]/agent/[agent]", { slug, agent: "sdr" });
  }

  const seed = {
    note: "Synthetic data for the QA crawl (scripts/qa/seed.mjs). Not production.",
    viewers: [
      { key: "founder_owner", label: "OASIS founder owner (CC's role)", authUserId: IDS.cc, email: "conaugh@oasisai.work", checkPersona: false },
      { key: "founder_second", label: "Second founder (Adon's role)", authUserId: IDS.adon, email: "adon@oasisai.work", checkPersona: false },
      { key: "client_owner", label: "Client workspace owner (Acme Plumbing)", authUserId: IDS.client, email: "alex@acme-plumbing.test", checkPersona: true },
      { key: "sales_rep", label: "OASIS sales rep (closer)", authUserId: IDS.rep, email: "riley.rep@oasis-qa.test", checkPersona: true },
    ],
    params,
    failures,
  };
  writeFileSync(seedOut, JSON.stringify(seed, null, 1));
  console.log(JSON.stringify({ ok: true, viewers: seed.viewers.length, patterns: Object.keys(params).length, failures }));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.close());
