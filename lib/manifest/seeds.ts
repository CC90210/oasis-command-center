/**
 * Seed manifests — in-code source of truth that mirrors the legacy
 * lib/client-profiles.ts registry. These are the manifests we serve when:
 *
 *   1. the `tenant_manifests` Supabase table is empty (fresh install), OR
 *   2. the DB is unreachable from a Vercel function for this request, OR
 *   3. the requested slug isn't in the DB. A slug with no seed of its own
 *      gets UNPROVISIONED_SEED (below), never OASIS's workspace.
 *
 * Once Phase 2's AI editor lands and writes to Supabase, seeds become the
 * "shipped defaults" — the DB row overrides per tenant. Until then, the seeds
 * ARE the manifests, just loaded through the same pipeline a DB-backed
 * manifest would use, so the cutover in 1b is a no-op for the renderer.
 */

import { CC_NAV, WEBDEV_NAV, type NavItem } from "../nav-config";
import { OASIS_LEAD_STAGE_KEYS } from "../oasis-stage-meta";
import {
  MANIFEST_SCHEMA_VERSION,
  type ManifestNavItem,
  type TenantManifest,
} from "./schema";

function navToManifest(items: NavItem[]): ManifestNavItem[] {
  return items.map((item) => ({
    href: item.href,
    label: item.label,
    icon: item.icon,
    group: item.group,
    badge_key: item.badgeKey,
    expandable: item.expandable,
  }));
}

const FROZEN_AT = "2026-05-13T00:00:00.000Z";

// OASIS AI — CC's own home tenant. Nav still uses bare-path legacy routes
// (which work because the rest of the dashboard has legacy pages at those
// paths) but the manifest now declares pages + entities so /t/oasis renders
// real manifest-driven content for cross-tenant consistency. When the
// legacy bare-path pages get migrated to manifest-driven, we flip the nav
// hrefs to /t/oasis/<path> too.
export const OASIS_SEED: TenantManifest = {
  version: 1,
  tenant_slug: "oasis",
  brand: {
    name: "OASIS AI",
    logo: "oasis",
    subtitle: "Agent Command Center",
    footer_label: "OASIS AI · Agent Command Center · v1.0",
    footer_tagline: '"Only good things from now on."',
  },
  // OASIS's AI team (W4a, 2026-10-01): one lead per department, the bindings
  // components/os/department/config.ts reads for every channel, the AI Team
  // page and Settings. Each is named for the departments it leads; the persona
  // behind it never reaches a screen. OASIS has no tenant_manifests row, so
  // this seed IS OASIS's roster; a teammate its owner builds is stored as a
  // seed overlay on top of it (lib/manifest/seed-overlay.ts), so an edit here
  // still reaches OASIS after that. CC's own agents (aura, lex, hermes,
  // life-preservation) lead no department and are not business teammates:
  // they live in Admin > Fleet (components/os/landings/fleet-data.ts).
  agents: [
    { slug: "bravo", display_name: "Chief of Staff · Operations", enabled: true, primary: true, core: true, departments: ["chief_of_staff", "operations"] },
    { slug: "sdr", display_name: "Sales", enabled: true, core: true, departments: ["sales"] },
    { slug: "maven", display_name: "Marketing", enabled: true, core: true, departments: ["marketing"] },
    { slug: "customer-support", display_name: "Client Success", enabled: true, core: true, departments: ["client_success"] },
    { slug: "atlas", display_name: "Finance", enabled: true, core: true, departments: ["finance"] },
  ],
  // OASIS Setup Readiness opinion — CC's empire stack. Distinct from
  // SunBiz: includes Stripe (CC bills through OASIS). No Kixie / TextTorrent (CC doesn't use them for the
  // agency motion).
  required_services: [
    {
      service: "ai_provider",
      label: "AI provider key (Anthropic / OpenRouter / Gemini / OpenAI)",
      kind: "ai_provider",
      detail:
        "Powers backend automations + chat fallback when the bridge is offline. Most callers go through the local Claude Code bridge first.",
    },
    {
      service: "gws",
      label: "Gmail App Password",
      kind: "tenant_credential",
      detail: "Outbound from conaugh@oasisai.work via send_gateway.py.",
    },
    {
      service: "stripe",
      label: "Stripe (billing)",
      kind: "tenant_credential",
      detail: "Subscription billing + ARR widget on the dashboard.",
    },
  ],
  nav: navToManifest(CC_NAV),
  data_model: [
    {
      name: "lead",
      label: "Lead",
      fields: [
        { name: "name", type: "string", required: true },
        { name: "company", type: "string" },
        { name: "email", type: "string" },
        { name: "phone", type: "string" },
        // LEADGEN FIELDS. The OSM importer already WRITES these on every lead
        // it creates (source=oasis_webdev_leadgen:osm) — website, the site's
        // condition, industry and location. They were absent from this entity,
        // and ManifestRecordForm renders the ENTITY, not the row, so the data
        // was in the database and invisible on the lead profile. A rep opening
        // "Mango Rain" could not see https://www.mangorain.ca/ even though it
        // was stored on the record.
        //
        // Website condition is the single most useful field on a cold call for
        // this offer — "no site" and "has a site, not reviewed" are completely
        // different openers — so it goes on the profile, not just in the
        // /web-leads browser.
        { name: "website", type: "string" },
        { name: "website_condition", type: "string" },
        { name: "audit_findings", type: "string" },
        { name: "industry", type: "string" },
        { name: "business_city", type: "string" },
        { name: "state", type: "string" },
        { name: "source", type: "enum", enum_values: ["referral", "inbound", "outbound", "event", "cold_outreach", "other"] },
        // OASIS lead lifecycle (Website Sales Engine v2). 14 stages cover
        // every state a prospect or client can be in — from researched lead
        // through launched website. The canonical list (keys, labels,
        // colours) lives in lib/oasis-stage-meta.ts → OASIS_LEAD_STAGES;
        // this enum references it directly so the New Lead / edit-form
        // dropdowns can never drift from the StageRail.
        //
        //   researched → assigned → attempting_contact → connected →
        //   qualified → founder_meeting_booked → demo_completed →
        //   proposal_sent → won | lost → onboarding → in_build →
        //   client_review → launched
        //
        // Migration from the prior 11-stage shape:
        // database/146 + database/turso/147_website_sales_engine.turso.sql.
        {
          name: "stage",
          type: "enum",
          enum_values: [...OASIS_LEAD_STAGE_KEYS],
          required: true,
        },
        { name: "score", type: "number" },
        { name: "value_estimate", type: "number" },
        { name: "last_contacted_at", type: "date" },
        { name: "notes", type: "string" },
        // AI scoring fields (Phase 5a). Written by POST /api/leads/[id]/score
        // when an operator clicks "Score with AI" on the lead detail page,
        // OR by a daily cron that scores unscored leads in batches.
        // ai_score: 0-100 fit + close-likelihood + urgency
        // ai_reasoning: 1-2 sentence Claude rationale for the score
        // ai_scored_at: timestamp so the UI can show staleness
        { name: "ai_score", type: "number" },
        { name: "ai_reasoning", type: "string" },
        { name: "ai_scored_at", type: "datetime" },
        // AI next-action fields (Phase 5b). Written by POST
        // /api/leads/[id]/next-action — Claude reads the lead + last 10
        // interactions and recommends a single concrete next move.
        { name: "ai_next_action", type: "string" },
        { name: "ai_next_action_rationale", type: "string" },
        { name: "ai_next_action_at", type: "datetime" },
      ],
    },
    {
      name: "contact",
      label: "Contact",
      fields: [
        { name: "name", type: "string", required: true },
        { name: "email", type: "string" },
        { name: "phone", type: "string" },
        { name: "company", type: "string" },
        { name: "role", type: "string" },
        { name: "lead_id", type: "string" },
        { name: "last_contacted_at", type: "date" },
        { name: "notes", type: "string" },
      ],
    },
    {
      name: "proposal",
      label: "Proposal",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "lead_id", type: "string" },
        // OASIS sells AI agent builds. Proposal lifecycle:
        //   draft       — operator is composing
        //   sent        — link delivered, awaiting view
        //   viewed      — prospect opened the proposal page
        //   signed      — accepted (kicks the "won" stage on the lead)
        //   declined    — passed
        //   expired     — TTL elapsed without action
        { name: "stage", type: "enum", enum_values: ["draft", "sent", "viewed", "signed", "declined", "expired"], required: true },
        { name: "value_usd", type: "number" },
        { name: "monthly_retainer_usd", type: "number" },
        { name: "sent_at", type: "date" },
        { name: "signed_at", type: "date" },
        { name: "notes", type: "string" },
      ],
    },
    {
      name: "task",
      label: "Task",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "agent_slug", type: "string" },
        { name: "status", type: "enum", enum_values: ["pending", "in_progress", "blocked", "done"], required: true },
        { name: "due_date", type: "date" },
      ],
    },
  ],
  pages: [
    { path: "", label: "Today", kind: "dashboard" },
    { path: "reasoning", label: "Reasoning", kind: "reasoning" },
    { path: "leads", label: "Leads (manifest view)", kind: "kanban", entity: "lead", config: { group_by: "stage" } },
    { path: "contacts", label: "Contacts", kind: "table", entity: "contact" },
    { path: "proposals", label: "Proposals", kind: "kanban", entity: "proposal", config: { group_by: "stage" } },
    { path: "tasks", label: "Tasks", kind: "kanban", entity: "task", config: { group_by: "status" } },
  ],
  default_prompts: [
    { agent_slug: "bravo", label: "Daily standup", prompt: "Give me a 5-bullet brief: hot leads, deals closing this week, today's blocks, top priority, anything past-due." },
    { agent_slug: "maven", label: "Draft content drop", prompt: "Pick the highest-leverage move from this week's pipeline and draft a social post in my voice." },
    { agent_slug: "atlas", label: "Cash position", prompt: "Net MRR, current burn, projected runway, anything that looks off in the last 7 days." },
  ],
  data_backend: "supabase",
  deployment_mode: "shared",
  permissions: { local_files: true, computer_control: true, web_access: true },
  onboarding_industry: "custom",
  tier: {
    label: "Enterprise",
    setup_complexity: "Done-for-you",
    monthly_price_hint: "Internal",
    summary: "OASIS HQ · operator chrome · all agents enabled.",
  },
  // CC is the operator — keep the 4-mode chat picker (Phase 3) visible so
  // he can pin CLI / cloud_only / cloud_bridge_tools per turn. End-user
  // tenants below get advanced_picker=false so the dropdown is hidden.
  ui: {
    advanced_picker: true,
  },
  meta: {
    created_at: FROZEN_AT,
    updated_at: FROZEN_AT,
    schema_version: MANIFEST_SCHEMA_VERSION,
  },
};

// OASIS AI, `oasis-ai-cc` slug — the ACTUAL live agency-CRM tenant (the
// `oasis` slug above is historical; see lib/role-surfaces.ts). This is
// getManifest()'s real fallback target for Adon's session, so it — not
// lib/client-profiles.ts's WEBDEV_PROFILE.nav — is what the sidebar
// actually renders (app/layout.tsx resolves `manifest = getManifest(slug)`,
// which checks the Supabase tenant_manifests table for this slug and
// otherwise falls back here via getSeedManifest; it never reads
// lib/client-profiles.ts). Everything else is identical to OASIS_SEED —
// only `nav` changes, adding the Web Leads browser tab (2026-08-20 fix:
// the tab previously only existed in the unused WEBDEV_PROFILE, bound to a
// zero-user tenant slug, so no real operator ever saw it).
export const OASIS_AI_CC_SEED: TenantManifest = {
  ...OASIS_SEED,
  tenant_slug: "oasis-ai-cc",
  nav: navToManifest(WEBDEV_NAV),
};

// SUN_SEED, the SunBiz Funding shell served at /t/sun/*, was deleted 2026-10-01
// (OS plan W0). The tenant was retired 2026-09-28; the seed carried its nav,
// the Solara/Helios personas, the funding data model and an operating manual
// naming its reps, in every build. /t/sun/* is a 404 now: manifestExists()
// finds no seed and the slug stays protected (lib/manifest/guards.ts), so no
// tenant can write a manifest row under it.

export const SUGA_SEED: TenantManifest = {
  version: 1,
  tenant_slug: "suga",
  brand: {
    name: "Suga · Brand Command",
    logo: "suga",
    subtitle: "Agent Command Center",
    footer_label: "Suga · Brand Command · v0.1",
    footer_tagline: "Fans first. Always.",
  },
  agents: [
    // A client workspace runs neutral teammates only (W4a, 2026-10-01): the
    // library templates OASIS provisions for Sales and Client Success
    // (lib/provisioning/team.ts neutralTeamFor). It used to bind Maven, an
    // OASIS house agent, which no client binding may name. There is no neutral
    // marketing lead yet, so Marketing says "not set up".
    { slug: "sdr", display_name: "Sales lead", enabled: true, primary: true, departments: ["sales"] },
    { slug: "customer-support", display_name: "Client Success lead", enabled: true, departments: ["client_success"] },
  ],
  nav: [
    { href: "/t/suga", label: "Dashboard", icon: "LayoutDashboard", group: "Operations" },
    // Top-level /agent chat — Maven as the primary brand agent.
    { href: "/agent", label: "Agents", icon: "Bot", group: "Operations" },
    { href: "/t/suga/subscribers", label: "Subscribers", icon: "Users", group: "Fans" },
    { href: "/t/suga/posts", label: "Posts", icon: "Megaphone", group: "Brand" },
    { href: "/t/suga/drafts", label: "Drafts", icon: "FileText", group: "Brand" },
    // /forms intentionally absent from SUGA — the form builder is the
    // SunBiz funding-shop workflow (3-step funnel with bank-statement
    // upload + lead.stage transitions). SUGA's fan-signup model uses a
    // different pattern; not the same surface.
    { href: "/t/suga/merch", label: "Merch", icon: "ShoppingBag", group: "Commerce" },
    { href: "/t/suga/sponsorship", label: "Sponsorships", icon: "HandCoins", group: "Sponsorship" },
    // Same shared admin surfaces every tenant gets: /team (invite +
    // member management), /automations (cron jobs), /settings.
    { href: "/team", label: "Team", icon: "UsersRound", group: "System" },
    { href: "/automations", label: "Automations", icon: "RefreshCcw", group: "System" },
    { href: "/settings", label: "Settings", icon: "Settings", group: "System" },
  ],
  data_model: [
    {
      name: "subscriber",
      label: "Subscriber",
      fields: [
        { name: "email", type: "string", required: true },
        { name: "name", type: "string" },
        { name: "tier", type: "enum", enum_values: ["free", "vip", "patron"] },
      ],
    },
    {
      name: "post",
      label: "Post",
      fields: [
        { name: "title", type: "string", required: true },
        { name: "platform", type: "enum", enum_values: ["instagram", "x", "tiktok", "youtube", "email"] },
        { name: "status", type: "enum", enum_values: ["draft", "scheduled", "published"], required: true },
      ],
    },
    {
      name: "merch_drop",
      label: "Merch Drop",
      fields: [
        { name: "name", type: "string", required: true },
        { name: "stock", type: "number" },
        { name: "status", type: "enum", enum_values: ["upcoming", "live", "sold_out", "archived"] },
      ],
    },
    {
      name: "sponsorship",
      label: "Sponsorship",
      fields: [
        { name: "brand", type: "string", required: true },
        { name: "value", type: "number" },
        { name: "stage", type: "enum", enum_values: ["outreach", "negotiating", "signed", "delivered", "lost"], required: true },
      ],
    },
  ],
  pages: [
    { path: "", label: "Fans · Today", kind: "dashboard" },
    { path: "reasoning", label: "Reasoning", kind: "reasoning" },
    { path: "subscribers", label: "Subscribers", kind: "table", entity: "subscriber" },
    { path: "posts", label: "Posts", kind: "kanban", entity: "post", config: { group_by: "status" } },
    { path: "drafts", label: "Drafts", kind: "table", entity: "post" },
    { path: "merch", label: "Merch Drops", kind: "kanban", entity: "merch_drop", config: { group_by: "status" } },
    { path: "sponsorship", label: "Sponsorships", kind: "kanban", entity: "sponsorship", config: { group_by: "stage" } },
  ],
  default_prompts: [
    // The seed's primary teammate, the role Maven held when these were
    // written. A client seed names its own bindings only (W4a), and there
    // is no neutral Marketing lead yet.
    { agent_slug: "sdr", label: "Fan check-in", prompt: "Pull the most engaged 10 subscribers this week. Suggest a personalised DM I can send." },
    { agent_slug: "sdr", label: "Post idea", prompt: "What's a high-engagement post angle I haven't run this month?" },
    { agent_slug: "sdr", label: "Merch drop sweep", prompt: "Which merch drops are due to go live this month? Anything understocked?" },
    { agent_slug: "sdr", label: "Weekly brand pulse", prompt: "Summarise this week's posts, subscriber growth, and any sponsorship movement in 5 bullets." },
  ],
  // Universal default 2026-05-15 — all tenant data lives in CC's Supabase
  // project, scoped by tenant_id + RLS. Lower onboarding friction (no
  // per-tenant Turso provisioning step). Clients who outgrow the shared
  // tier and want physical isolation can self-host Turso later.
  data_backend: "supabase",
  deployment_mode: "dedicated",
  permissions: { local_files: false, computer_control: false, web_access: true },
  onboarding_industry: "agency",
  tier: {
    label: "Pro",
    setup_complexity: "Guided",
    monthly_price_hint: "$99/mo",
    summary: "Brand command: posts, fans, merch, sponsorships.",
  },
  // End-user tenant — hide the 4-mode chat picker. SUGA operators see one
  // chat that just works; Auto-mode handles routing.
  ui: {
    advanced_picker: false,
  },
  meta: {
    created_at: FROZEN_AT,
    updated_at: FROZEN_AT,
    schema_version: MANIFEST_SCHEMA_VERSION,
  },
};

/**
 * The slug UNPROVISIONED_SEED answers to. No workspace can hold it:
 * lib/manifest/guards.ts PROTECTED_SLUGS reserves it, so a stored manifest
 * named "unprovisioned" can never be written and mistaken for this seed.
 */
export const UNPROVISIONED_SLUG = "unprovisioned";

/**
 * What a workspace sees before OASIS has set it up: Today, which says so, and
 * Settings for the viewer's own profile. Nothing else.
 *
 * WHY (2026-09-28, P0-4). getSeedManifest answered every slug it did not
 * recognise with OASIS_SEED, which is CC's own workspace: his nav (Operations,
 * Automations, Health, Analytics ...), OASIS's lead data model, OASIS's agent
 * roster, the operator chat picker, and local_files + computer_control
 * permissions. 46 self-signup workspaces had no manifest row and no seed, so
 * every one of them rendered it. A slug nobody has set up is not a request for
 * OASIS's workspace, so it gets an empty one.
 *
 * No agents, no data model, no prompts, every permission off. Those arrive
 * with the workspace's own manifest when OASIS provisions it.
 */
export const UNPROVISIONED_SEED: TenantManifest = {
  version: 1,
  tenant_slug: UNPROVISIONED_SLUG,
  brand: {
    name: "Your workspace",
    logo: "oasis",
    subtitle: "Being set up by OASIS",
    footer_label: "OASIS OS",
    footer_tagline: "Your workspace is being set up.",
  },
  agents: [],
  nav: [
    { group: "Workspace", href: "/", label: "Today", icon: "LayoutDashboard" },
    { group: "Workspace", href: "/settings", label: "Settings", icon: "Settings" },
  ],
  pages: [
    {
      path: "",
      label: "Today",
      kind: "markdown",
      config: {
        body: [
          "## Your workspace is being set up",
          "OASIS is setting up this workspace for you. Your pipeline, your team and your agents appear here once that is done.",
          "Nothing here needs your attention in the meantime. You can update your profile under Settings.",
        ].join("\n\n"),
      },
    },
  ],
  data_model: [],
  default_prompts: [],
  permissions: { local_files: false, computer_control: false, web_access: false },
  onboarding_industry: "custom",
  ui: {
    advanced_picker: false,
  },
  meta: {
    created_at: "2026-09-28T00:00:00.000Z",
    updated_at: "2026-09-28T00:00:00.000Z",
    schema_version: MANIFEST_SCHEMA_VERSION,
  },
};

/** True when `manifest` is the set-up placeholder rather than a real workspace. */
export function isUnprovisionedManifest(manifest: Pick<TenantManifest, "tenant_slug"> | null | undefined): boolean {
  return manifest?.tenant_slug === UNPROVISIONED_SLUG;
}

/**
 * Slug map for synchronous lookups. The loader uses this as the fallback when
 * Supabase has no row for a slug; the AI editor writes new manifests to DB,
 * never to this map.
 *
 * `default` and `oasis` stay listed so manifestExists(), the onboarding
 * wizard's reserved-slug check and the slug-claim guard keep treating them as
 * platform names. They are NOT served from here: getSeedManifest gates both
 * on the viewer's tenant id. Read this map for existence only.
 */
export const SEED_MANIFESTS: Record<string, TenantManifest> = {
  default: OASIS_SEED,
  oasis: OASIS_SEED,
  "oasis-ai-cc": OASIS_AI_CC_SEED,
  suga: SUGA_SEED,
};

/**
 * OASIS's own tenants, by id. The only viewers the alias slugs below render
 * OASIS_SEED for.
 *
 * Keyed by id, not slug: a slug is text a workspace can end up holding (a
 * self-signup's slug is derived from its email, so "oasis" is one signup away).
 * Verified against the live `tenants` table 2026-09-28. Mirrors the "oasis"
 * rows of TENANT_ID_BRAND in lib/email/brand-for-tenant.ts;
 * tests/manifest-unknown-slug-fail-closed.test.ts asserts they match.
 */
export const OASIS_SEED_TENANT_IDS: ReadonlySet<string> = new Set([
  "ef8d389e-3f15-43f2-ae00-3660f69a1452", // slug "oasis-ai-cc"
  "42423fde-be8b-454f-932a-750e8c9b743d", // slug "oasis-webdev"
]);

/**
 * Slugs that name OASIS but belong to no tenant: "default" is what the loader
 * uses when there is no slug at all, and "oasis" is the historical slug, which
 * no tenant holds (2026-09-28). Neither says whose workspace this is, so
 * OASIS_SEED is served under them only when the caller passes an OASIS
 * tenant id.
 */
const OASIS_ALIAS_SLUGS: ReadonlySet<string> = new Set(["default", "oasis"]);

/**
 * OASIS workspaces that have no seed and no manifest row of their own.
 *
 * `oasis-webdev` is the website-sales tenant's own `tenants.slug` (tenant
 * 42423fde…, the same value as OASIS_WEBSITE_TENANT_SLUG in
 * lib/website-sales-workflow.ts, which is not imported here to keep this
 * module's import graph small). It rendered OASIS_SEED through the old
 * catch-all fallback, and invite redemption into it reads the seed's agent
 * roster, so it keeps that seed explicitly. `tenants.slug` is UNIQUE, so no
 * other tenant can hold it.
 */
const ROWLESS_OASIS_SEEDS: Readonly<Record<string, TenantManifest>> = {
  "oasis-webdev": OASIS_SEED,
};

/**
 * The in-code manifest for `slug`, or UNPROVISIONED_SEED.
 *
 * `viewerTenantId` is the SESSION tenant, and it only matters for the alias
 * slugs: pass it where the caller has one, so an OASIS viewer whose slug did
 * not resolve still gets OASIS_SEED. Every other slug ignores it.
 */
export function getSeedManifest(
  slug: string | null | undefined,
  viewerTenantId?: string | null,
): TenantManifest {
  const key = (slug || "").trim().toLowerCase() || "default";
  if (OASIS_ALIAS_SLUGS.has(key)) {
    return typeof viewerTenantId === "string" && OASIS_SEED_TENANT_IDS.has(viewerTenantId)
      ? OASIS_SEED
      : UNPROVISIONED_SEED;
  }
  return SEED_MANIFESTS[key] ?? ROWLESS_OASIS_SEEDS[key] ?? UNPROVISIONED_SEED;
}
