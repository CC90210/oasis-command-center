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
 * fill each dynamic route ({ "/pipeline/[id]": [{ id }] ... }).
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
const now = new Date().toISOString();
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString();

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
  await insert("tenant_manifests", { id: "qa-manifest-acme", tenant_id: CLIENT_TENANT, slug: "acme-plumbing", manifest: JSON.stringify(manifest), version: 1, schema_version: manifest.meta?.schema_version ?? 1, created_at: daysAgo(29), updated_at: daysAgo(29) }, { required: true });
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
  const params = {};
  const addParam = (pattern, values) => {
    (params[pattern] ??= []).push(values);
  };

  for (const [tenant, prefix, owner] of [
    [OASIS_TENANT, "oasis", IDS.cc],
    [CLIENT_TENANT, "acme", IDS.client],
  ]) {
    const customer = await insert("customers", {
      id: `qa-customer-${prefix}-1`,
      tenant_id: tenant,
      display_name: prefix === "oasis" ? "Northshore Renovations and Custom Millwork Inc." : "Dorval Family Dental Clinic",
      company_name: prefix === "oasis" ? "Northshore Renovations and Custom Millwork Inc." : "Dorval Family Dental Clinic",
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

    const record = await insert("tenant_records", {
      id: `qa-record-${prefix}-1`,
      tenant_id: tenant,
      entity_type: "lead",
      data: JSON.stringify({
        name: "Pointe-Claire Heating, Ventilation and Air Conditioning Services",
        business_name: "Pointe-Claire Heating, Ventilation and Air Conditioning Services",
        contact_name: "Jordan Example",
        email: `jordan@${prefix}-lead.test`,
        phone: "+15145550199",
        stage: "new",
        status: "new",
        source: "website",
        assigned_to: owner,
      }),
      created_at: daysAgo(6),
      updated_at: daysAgo(1),
    });
    if (record) addParam("/pipeline/[id]", { id: record });

    const lead = await insert("leads", {
      id: `qa-lead-${prefix}-1`,
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
    const interaction = lead
      ? await insert("lead_interactions", {
          id: `qa-interaction-${prefix}-1`,
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
        })
      : null;
    if (interaction) addParam("/interactions/[id]", { id: interaction });

    const form = await insert("forms", {
      id: `qa-form-${prefix}-1`,
      tenant_id: tenant,
      slug: "quote-request",
      name: "Quote request",
      description: "Synthetic form for the QA crawl",
      steps: JSON.stringify([]),
      enabled: 1,
      created_by: owner,
      created_at: daysAgo(15),
      updated_at: daysAgo(15),
    });
    if (form) addParam("/forms/[id]/edit", { id: form });

    const sequence = await insert("drip_sequences", {
      id: `qa-sequence-${prefix}-1`,
      tenant_id: tenant,
      name: "New quote follow-up",
      description: "Synthetic sequence for the QA crawl",
      trigger_event: "manual",
      steps: JSON.stringify([]),
      enabled: 0,
      created_by: owner,
      created_at: daysAgo(15),
      updated_at: daysAgo(15),
    });
    if (sequence) addParam("/sequences/[id]/edit", { id: sequence });
  }

  const asset = await insert("marketing_asset", {
    id: "qa-asset-oasis-1",
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

  // Workspace-addressed pages: each workspace's own /t/<slug>, and an agent from its setup.
  for (const slug of ["oasis-ai-cc", "acme-plumbing"]) {
    for (const pattern of ["/t/[slug]", "/t/[slug]/editor", "/t/[slug]/marketplace", "/t/[slug]/marketplace/new"]) addParam(pattern, { slug });
  }
  if (clientAgents[0]) {
    addParam("/t/[slug]/agent/[agent]", { slug: "acme-plumbing", agent: clientAgents[0] });
    addParam("/t/[slug]/marketplace/[agent]", { slug: "acme-plumbing", agent: clientAgents[0] });
    addParam("/agents/[slug]", { slug: clientAgents[0] });
  }
  addParam("/agents/[slug]", { slug: "bravo" });

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
