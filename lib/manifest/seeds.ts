/**
 * Seed manifests — in-code source of truth that mirrors the legacy
 * lib/client-profiles.ts registry. These are the manifests we serve when:
 *
 *   1. the `tenant_manifests` Supabase table is empty (fresh install), OR
 *   2. the DB is unreachable from a Vercel function for this request, OR
 *   3. the requested slug isn't in the DB but we want a sensible default.
 *
 * Once Phase 2's AI editor lands and writes to Supabase, seeds become the
 * "shipped defaults" — the DB row overrides per tenant. Until then, the seeds
 * ARE the manifests, just loaded through the same pipeline a DB-backed
 * manifest would use, so the cutover in 1b is a no-op for the renderer.
 */

import { CC_NAV, type NavItem } from "../nav-config";
import { HELIOS_TOOL_PALETTE } from "../chat-tool-palettes";
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
  agents: [
    { slug: "bravo", display_name: "Bravo", enabled: true, primary: true, core: true },
    { slug: "atlas", display_name: "Atlas", enabled: true, core: true },
    { slug: "maven", display_name: "Maven", enabled: true, core: true },
    // Aura — voice / sensory persona. Owns scripts/aura/ (morning pow
    // wow + future voice automations). Enabled 2026-05-17 when Aura got
    // her own home directory and first cron. See agents/aura.md.
    { slug: "aura", display_name: "Aura", enabled: true, core: true },
    // Lex — in-house counsel (legal/contracts). Non-core add-on: shows on
    // /agents, operator can toggle off. Multi-tenant product surface; never
    // gives legal advice (UPL gate in Lex-Agent/brain/COMPLIANCE.md).
    { slug: "lex", display_name: "Lex", enabled: true, core: false },
  ],
  // OASIS Setup Readiness opinion — CC's empire stack. Distinct from
  // SunBiz: includes Stripe (CC bills through OASIS), n8n for inbound
  // webhooks. No Kixie / TextTorrent (CC doesn't use them for the
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
    {
      service: "n8n",
      label: "n8n (inbound webhook bridge)",
      kind: "tenant_credential",
      detail: "Inbound qualifier workflow posts here.",
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
        { name: "source", type: "enum", enum_values: ["referral", "inbound", "outbound", "event", "cold_outreach", "other"] },
        // OASIS lead lifecycle (AI agency client funnel). 11 stages cover
        // every state a prospect or client can be in — from first contact
        // through active retainer and beyond. Stage metadata (colours,
        // labels) lives in lib/oasis-stage-meta.ts → OASIS_LEAD_STAGES.
        // Keep this enum in lock-step with that file; the StageRail reads
        // the meta but the Supabase column validates against this enum.
        //
        //   new_contact    — fresh lead, no outreach sent
        //   outreach       — first touch sent (cold email / DM / call)
        //   discovery      — discovery call scheduled or completed
        //   qualified      — replied with intent and confirmed as a fit
        //   proposal       — SOW / proposal delivered, awaiting response
        //   negotiation    — back-and-forth on scope, terms, or price
        //   onboarding     — deal closed, client being onboarded
        //   active_client  — live retainer / project in delivery
        //   churned        — was an active client, now departed
        //   lost           — never closed (passed, ghosted, not a fit)
        //   archived       — permanently inactive (no follow-up expected)
        //
        // Migration from the prior 7-stage shape (see
        // database/047_oasis_lead_lifecycle_v2.sql for the SQL):
        //   new        → new_contact
        //   contacted  → outreach
        //   won        → active_client
        //   qualified / proposal / negotiation / lost → same key (no-op)
        {
          name: "stage",
          type: "enum",
          enum_values: [
            "new_contact",
            "outreach",
            "discovery",
            "qualified",
            "proposal",
            "negotiation",
            "onboarding",
            "active_client",
            "churned",
            "lost",
            "archived",
          ],
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

// SunBiz Funding — fully populated tenant. Used at /t/sun/* as the
// authoritative source. The nav hrefs target the /t/sun/<path> namespace
// so every click lands on a manifest-driven page; the catch-all renderer
// dispatches by `pages[].kind`.
export const SUN_SEED: TenantManifest = {
  version: 1,
  tenant_slug: "sun",
  brand: {
    name: "Sun Biz Funding",
    logo: "sunbiz",
    subtitle: "Agent Command Center",
    footer_label: "Sun Biz Funding · Agent Command Center · v1.0",
    footer_tagline: "Funded deals over noise.",
  },
  agents: [
    // Operational primary — backend admin, Chrome jobs, data collection, workflow runner.
    // Where Ezra goes when they need work done. CORE: locked, cannot
    // be toggled off; the SunBiz CRM depends on Solara's data model.
    { slug: "solara", display_name: "Solara", enabled: true, primary: true, core: true },
    // Brand-facing sales persona — personable, sales-driven outreach, SMS follow-ups.
    // The voice SunBiz leads experience. Name TBD with CC; helios is the working default
    // (sun-themed, matches the Solara linguistic family). CORE: locked.
    // Phase 3d (2026-06-02): Helios gets the Kixie/TextTorrent comms send
    // tools. tool_palette is an allowlist REPLACE, so HELIOS_TOOL_PALETTE
    // = safe base + comms tools. Solara has NO palette → safe default
    // (no comms tools) = "opt-in" for the back-office persona.
    { slug: "helios", display_name: "Helios", enabled: true, core: true, tool_palette: HELIOS_TOOL_PALETTE },
    // Non-core add-ons (Bravo, Atlas, Maven, Aura, Hermes) can be appended
    // by the operator via /t/sun/settings#agents — they render in the
    // standard agent grid but stay clearly opt-in.
  ],
  // SunBiz Setup Readiness opinion. The card on /t/sun/settings reads
  // this list (NOT a global hardcoded one) so the funding-shop stack
  // surfaces: AI key for backend automations, the shared submissions@
  // Gmail App Password, Kixie click-to-call, TextTorrent SMS. Stripe
  // + JotForm are intentionally absent — SunBiz uses custom forms and
  // doesn't run billing through Stripe today. The Lender catalog and
  // Bridge are universal infra checks added automatically — they
  // don't need to be declared here.
  required_services: [
    {
      service: "ai_provider",
      label: "AI provider key (Anthropic / OpenRouter / Gemini / OpenAI)",
      kind: "ai_provider",
      detail:
        "Powers Solara + Helios backend automations (drip cadence, lender response classifier, daily plan generator). Chat itself uses the local bridge + Claude Code; this key is for cron / autonomous loops.",
    },
    {
      service: "gws",
      label: "Gmail App Password (shared submissions@)",
      kind: "tenant_credential",
      detail:
        "Shared outbound identity for shop-out + drawer email; assigned rep is auto-CC'd per deal. send_gateway.py on the bridge reads from the local secrets file today — adding the key to the tenant store here is required before the SunBiz VPS deploy so credentials migrate with the workspace.",
    },
    {
      service: "kixie",
      label: "Kixie (click-to-call + business SMS)",
      kind: "tenant_credential",
      detail:
        "Centralizes Kixie so operators never need to open the Kixie app — call buttons, dialer, SMS, and call logs all surface in the lead drawer.",
    },
    {
      service: "texttorrent",
      label: "TextTorrent (bulk + 1:1 SMS)",
      kind: "tenant_credential",
      detail:
        "TT API powers the Text Torrent button on the lead drawer + bulk sequences. The goal is full embedding — every TT feature reachable from the command center.",
    },
  ],
  // Nav reorganized per the Jordan/Oasis 2026-05-23 meeting (migration 064):
  //   OPERATIONS  Dashboard · Agents · Reasoning · Playbook
  //   PIPELINE    Leads · Shopping Out · Applications
  //   DEALS       Offers · Renewals · Commissions · Lenders
  //   SYSTEM      Import · Forms · Sequences · Team · Automations · Settings
  // Funded Deals removed from the sidebar (the page route at /t/sun/funded-
  // deals still resolves via the manifest entry below — Applications-filtered-
  // by-Funded + Renewals cover the same surface in the operator workflow).
  // Network group dropped; Lenders moved into Deals where it belongs alongside
  // Offers + Renewals + Commissions.
  nav: [
    { href: "/t/sun", label: "Dashboard", icon: "LayoutDashboard", group: "Operations" },
    // Top-level /agent chat — Ezra picks between Solara (operational) and
    // Helios (sales) via the in-widget switcher. Lives outside the /t/sun
    // namespace because chat is a shared dashboard surface, not a manifest
    // primitive — this is just the entry point.
    { href: "/agent", label: "Agents", icon: "Bot", group: "Operations" },
    { href: "/t/sun/reasoning", label: "Reasoning", icon: "Brain", group: "Operations" },
    // Playbook -> top-level /playbook (not the manifest markdown page) so SunBiz
    // gets the same clickable card-grid operating manual the OASIS portal has.
    // /playbook resolves profile slug "sun" -> SunBizPlaybookIndex (cards link to
    // content/playbooks/sun-*.md guides).
    { href: "/playbook", label: "Playbook", icon: "BookOpen", group: "Operations" },
    // Pipeline — top-of-funnel through funding shop. Shopping Out is the
    // new (Phase 4) multi-lender outreach surface; sits between Leads and
    // Applications to mirror the operator's real workflow order.
    { href: "/t/sun/leads", label: "Leads", icon: "Users", group: "Pipeline" },
    { href: "/t/sun/shopping-out", label: "Shopping Out", icon: "ShoppingBag", group: "Pipeline" },
    { href: "/t/sun/applications", label: "Applications", icon: "FileText", group: "Pipeline" },
    // Phase 3b/3c (2026-06-02). Unified inbox + bulk-campaign analytics.
    { href: "/t/sun/conversations", label: "Conversations", icon: "MessageSquare", group: "Pipeline" },
    { href: "/t/sun/campaigns", label: "Campaigns", icon: "Megaphone", group: "Pipeline" },
    // Deals — post-shop lifecycle: offers in, renewals tracked, commissions
    // booked, lenders managed. Lenders moved here from the (now-deleted)
    // Network group — it's a deal-context entity, not a separate domain.
    { href: "/t/sun/offers", label: "Offers", icon: "HandCoins", group: "Deals" },
    { href: "/t/sun/renewals", label: "Renewals", icon: "RefreshCcw", group: "Deals" },
    { href: "/t/sun/commissions", label: "Commissions", icon: "DollarSign", group: "Deals" },
    { href: "/t/sun/lenders", label: "Lenders", icon: "Landmark", group: "Deals" },
    // System — data ingest + drip/cron infrastructure + admin. Import +
    // Forms + Sequences moved here from Pipeline (they're plumbing for the
    // pipeline, not pipeline stages themselves).
    { href: "/t/sun/import", label: "Import", icon: "Upload", group: "System" },
    // /forms is top-level (tenant-aware on the server via user.tenant_id).
    // Same shared surface every tenant gets — design forms, mint
    // personalized lead links, replace JotForm.
    { href: "/forms", label: "Forms", icon: "FileCode2", group: "System" },
    // /sequences is the drip-campaign control panel — same Outreach
    // lane as SMS / Email Blast but for status-triggered automation.
    { href: "/sequences", label: "Sequences", icon: "Sparkles", group: "System" },
    // Top-level /team — admins mint invite URLs that drop a teammate
    // straight into this tenant's onboarding wizard. Owner/admin sees
    // the mint UI; non-admins see the member roster. Without this entry
    // SunBiz operators had no way to find the invite flow (the page
    // existed but wasn't linked in the manifest nav).
    { href: "/team", label: "Team", icon: "UsersRound", group: "System" },
    // Automations — routed through the catch-all (kind="automations")
    // since 2026-05-25 (Option A, same pattern as Settings). Closes
    // the operator-data leak where the top-level /automations link
    // rendered the signed-in operator's cron jobs + empire background
    // workers regardless of which tenant shell the user was viewing.
    { href: "/t/sun/automations", label: "Automations", icon: "RefreshCcw", group: "System" },
    // Settings — routed through the catch-all (kind="settings") since
    // 2026-05-25 to close the cross-tenant leak where the prior
    // top-level /settings link rendered the SIGNED-IN operator's data
    // inside whichever tenant shell they were viewing. Now /t/sun/
    // settings hits TenantSettings which uses resolveDataTenant() to
    // gate previewMode — operator previewing a non-owned tenant sees
    // an empty scaffold with no sub-components mounted (no fetches,
    // no leaks). Tenant owner sees full settings as before.
    { href: "/t/sun/settings", label: "Settings", icon: "Settings", group: "System" },
  ],
  data_model: [
    {
      name: "lead",
      label: "Lead",
      fields: [
        { name: "business_name", type: "string", required: true },
        { name: "contact_name", type: "string" },
        { name: "phone", type: "string" },
        { name: "email", type: "string" },
        { name: "monthly_revenue", type: "number" },
        // Lead Pipeline stages — slimmed per Jordan/Oasis 2026-05-23
        // meeting (migration 064). Dropped imported / not_interested /
        // approved; existing rows were remapped (imported→hot_lead,
        // not_interested→declined, approved→submitted) so no data is
        // lost. Order = left-to-right arrow flow on the pipeline bar.
        // Colors live in lib/sunbiz-stage-meta.ts.
        //
        //   hot_lead            — actively engaging, replied / called back
        //   missing_info        — needs additional data before progressing
        //                         (auto-tagged by Phase 20 classifier)
        //   follow_up           — nurture cadence, waiting on next touch
        //   sent_application    — Solara dispatched the application link
        //   viewed_application  — prospect opened the link (engagement)
        //   signed_application  — prospect completed the application form
        //   submitted           — submitted to underwriting (graduates to
        //                         Opportunity Pipeline; see application.status)
        //   declined            — lender or operator passed (terminal)
        //   default             — repayment failure / bankruptcy (terminal)
        // 2026-06-18 (CC): dropped `submitted` + `declined`; added `ghost`
        // (negative-reply/no-response leads now route here, re-engageable).
        // Matches LEAD_PIPELINE_STAGES. `funded`/`opted_out` were never in this
        // enum (display-only); opt-out compliance is the data.opted_out flag.
        // 2026-06-22 (Adon): re-added `submitted_application` directly after
        // `signed_application` (submitted to underwriting; the entry stage for
        // the signed-application email drip). Matches LEAD_PIPELINE_STAGES.
        { name: "stage", type: "enum", enum_values: ["intent_inquiry_submitted", "hot_lead", "missing_info", "follow_up", "sent_application", "viewed_application", "signed_application", "submitted_application", "ghost", "default"], required: true },
        // missing_info — Phase 20 (2026-05-17) classifier output. Array
        // of canonical doc-type strings the lead still owes us before
        // an application can advance. Populated by
        // scripts/lender_response_classifier.py's second LLM pass when
        // an inbound lender email is classified as info_request. The
        // Documents tab on the lead drawer auto-clears entries here
        // when a matching lead_document is uploaded (Phase 20.4).
        // Renders as a red "🔴 Missing: bank_statements_3mo" chip on
        // the lead Kanban card.
        { name: "missing_info", type: "json" },
      ],
    },
    {
      name: "application",
      label: "Application",
      fields: [
        { name: "business_name", type: "string", required: true },
        { name: "contact_name", type: "string" },
        { name: "lead_id", type: "string" },
        { name: "lender_id", type: "string" },
        { name: "requested_amount", type: "number" },
        { name: "submitted_at", type: "datetime" },
        // Opportunity Pipeline status — slimmed to 10 stages per the
        // Jordan/Oasis 2026-05-23 meeting (migration 064). Dropped
        // approved* / selling / submitted_to_underwriting / contracts_
        // ordered / no_offers_available (Offers page owns the offer
        // intelligence layer now; statuses that duplicated other steps
        // were collapsed). Existing rows were remapped in migration
        // 064. Order = left-to-right arrow flow.
        //
        //   application_in   — application received; pre-shop
        //   shopping         — out to multiple lenders (was also:
        //                      submitted_to_underwriting, approved,
        //                      approved_open_offers, selling)
        //   missing_info     — needs additional info before progressing
        //   requested_docs   — operator asked lender / client for docs
        //   docs_out         — contract / docs sent to client (was also:
        //                      contracts_ordered)
        //   login            — lender portal / signing portal step
        //   funded           — wire complete; rolls into funded_deals
        //   follow_ups       — long-tail follow-up after approval
        //   declined         — lender or operator passed (was also:
        //                      no_offers_available)
        //   dead_file        — client killed the deal (was also:
        //                      approved_never_funded)
        { name: "status", type: "enum", enum_values: ["application_in", "shopping", "missing_info", "requested_docs", "docs_out", "login", "funded", "follow_ups", "declined", "dead_file"], required: true },
        // Owner address — Phase 3 of Jordan/Oasis restructure. Lives in
        // JSONB on the application record (no DDL needed). OwnerTab in
        // the lead drawer renders these. Optional; legacy applications
        // without an address gracefully render as "—".
        { name: "owner_address_line1", type: "string" },
        { name: "owner_address_line2", type: "string" },
        { name: "owner_address_city", type: "string" },
        { name: "owner_address_state", type: "string" },
        { name: "owner_address_zip", type: "string" },
      ],
    },
    {
      name: "offer",
      label: "Offer",
      fields: [
        { name: "business_name", type: "string", required: true },
        { name: "application_id", type: "string" },
        { name: "lender_id", type: "string" },
        { name: "lender_name", type: "string" },
        { name: "amount", type: "number" },
        { name: "term_months", type: "number" },
        { name: "factor_rate", type: "number" },
        // Offer stage — same consolidated list as application.status
        // post-migration 064 (Jordan/Oasis 2026-05-23). Kept in sync so
        // the Offers page can group by either entity's stage without a
        // mismatched enum.
        { name: "stage", type: "enum", enum_values: ["application_in", "shopping", "missing_info", "requested_docs", "docs_out", "login", "funded", "follow_ups", "declined", "dead_file"], required: true },
      ],
    },
    {
      name: "funded_deal",
      label: "Funded Deal",
      fields: [
        { name: "business_name", type: "string", required: true },
        { name: "lead_id", type: "string" },
        { name: "lender_id", type: "string" },
        { name: "lender_name", type: "string" },
        { name: "product_type", type: "enum", enum_values: ["same_day_funding", "mca", "term_loan", "long_term_loan", "line_of_credit", "equipment", "invoice_factoring", "sba"] },
        { name: "amount_funded", type: "number", required: true },
        { name: "funded_at", type: "date" },
        { name: "term_months", type: "number" },
        { name: "factor_rate", type: "number" },
        { name: "repayment_amount", type: "number" },
        { name: "commission_amount", type: "number" },
        { name: "renewal_eligible_at", type: "date" },
        { name: "status", type: "enum", enum_values: ["funded", "renewal_due", "renewed", "lost", "default"] },
      ],
    },
    {
      name: "renewal",
      label: "Renewal",
      fields: [
        { name: "business_name", type: "string", required: true },
        { name: "funded_deal_id", type: "string" },
        { name: "amount_available", type: "number" },
        { name: "due_date", type: "date" },
        { name: "last_contacted_at", type: "date" },
        { name: "next_action", type: "string" },
        { name: "status", type: "enum", enum_values: ["upcoming", "due", "overdue", "renewed", "lost"], required: true },
      ],
    },
    {
      name: "commission",
      label: "Commission",
      fields: [
        { name: "business_name", type: "string", required: true },
        { name: "funded_deal_id", type: "string" },
        { name: "lender_name", type: "string" },
        { name: "broker_share_pct", type: "number" },
        { name: "amount", type: "number" },
        { name: "paid", type: "boolean" },
        { name: "paid_at", type: "date" },
      ],
    },
    {
      name: "lender",
      label: "Lender",
      fields: [
        { name: "name", type: "string", required: true },
        { name: "contact", type: "string" },
        // Phase 6.1 — match-fitness fields per Jordan's 2026-05-15
        // meeting. Operator UI on /lenders/[id]/edit lets the operator
        // populate these; the shop-out flow pre-ranks lenders against
        // each application's profile before the operator picks.
        { name: "product_type", type: "enum", enum_values: ["same_day_funding", "mca", "term_loan", "long_term_loan", "line_of_credit", "equipment", "invoice_factoring", "sba"] },
        { name: "min_monthly_revenue", type: "number" },
        { name: "max_funded_amount", type: "number" },
        { name: "min_time_in_business_months", type: "number" },
        { name: "fico_floor", type: "number" },
        { name: "sla_response_days", type: "number" },
        { name: "notes", type: "string" },
        // Phase 7 — knowledge-base fields per Jordan/Oasis 2026-05-23.
        // Live in tenant_records.data JSONB; no DDL needed. The Lender
        // Matching Agent + Shopping Out lender ranker consume these.
        { name: "portal_url", type: "string" },
        { name: "buy_rate_avg", type: "number" },
        { name: "funding_range_min", type: "number" },
        { name: "funding_range_max", type: "number" },
        { name: "term_range_min_months", type: "number" },
        { name: "term_range_max_months", type: "number" },
        { name: "industry_preferences", type: "json" },     // array of strings
        // Adon MCA SOP §4 (2026-06-11): name MUST be 'restricted_industries'
        // — match-fitness scorer + scripts/adon_seed_lender_constraints.py
        // both read this exact key. Was 'industry_restrictions' until
        // 2026-06-11; rename caught a silent bug where Adon could populate
        // via the manifest editor and the filter would never fire.
        { name: "restricted_industries", type: "json" },    // array of lowercase industry slugs
        { name: "restricted_states", type: "json" },        // array of state codes
        { name: "required_documents", type: "json" },       // array of doc-type keys
        { name: "common_decline_reasons", type: "json" },   // array of strings
        { name: "active", type: "boolean", default: true },
        // SOP §1 shop_list(deal) filter fields (2026-05-31). The Lender
        // List SOP encodes hard requirements as tier, paper-grade fit,
        // position-count range, defaults policy, and max negative days.
        // The match-fitness scorer reads these directly so the filter
        // applies at recommendation time, not just at notes-field text.
        { name: "tier", type: "enum", enum_values: ["A", "B", "C", "D", "Micro"] },
        { name: "paper_grades", type: "json" },             // array of A/B/C/D/JUNK
        { name: "position_min", type: "number" },           // 1 = 1st position; 0 = any
        { name: "position_max", type: "number" },           // 0 = no cap
        { name: "defaults_policy", type: "enum", enum_values: ["none", "satisfied_only", "accepts"] },
        { name: "max_negative_days", type: "number" },
        { name: "submission_cc_emails", type: "json" },     // array of strings
        { name: "reverses_only", type: "boolean", default: false },
      ],
    },
  ],
  pages: [
    // CRM dashboard. Label kept neutral so the heading is product-shaped
    // ("Today") not agent-shaped ("Solara — Today"). The agent the operator
    // works WITH is shown in the chat picker; the dashboard itself is just
    // the daily metrics surface. Per CC 2026-06-09.
    { path: "", label: "Today", kind: "dashboard" },
    { path: "reasoning", label: "Reasoning", kind: "reasoning" },
    // Two-pipeline superview — Salesforce-replacement overview per the
    // 2026-05-16 meeting. Renders Lead Pipeline (lead.stage) over
    // Opportunity Pipeline (offer.stage) with the submitted→offered
    // graduation visualised. Operators still drill into /leads or
    // /offers individually for full-board interaction.
    // Stacked overview — Lead Pipeline above Opportunity Pipeline.
    // Useful for the morning glance; daily-driving happens on /leads
    // and /applications individually.
    { path: "pipeline", label: "Pipeline", kind: "pipeline", config: { lead_entity: "lead", opportunity_entity: "application" } },
    // Lead Pipeline — the chevron arrow bar + filtered records table,
    // verbatim Salesforce per Adon's screenshots. Replaces the prior
    // /leads Kanban (2026-05-17). Filter by ?stage=<key>.
    { path: "leads", label: "Lead Pipeline", kind: "pipeline_entity", entity: "lead", config: { stage_field: "stage" } },
    // Opportunity Pipeline — same chevron pattern keyed on
    // application.status. Verbatim Salesforce stages (submitted_to_
    // underwriting → funded → dead_file). Replaces the prior
    // /applications Kanban (2026-05-17). Filter by ?stage=<key>.
    {
      path: "applications",
      label: "Opportunity Pipeline",
      kind: "pipeline_entity",
      entity: "application",
      config: { stage_field: "status" },
    },
    // Shopping Out — Phase 4 (Jordan/Oasis 2026-05-23). Multi-lender
    // outreach UI on top of the existing shop-out engine (POST
    // /api/applications/[id]/shop-out + lib/lenders/match-fitness +
    // lib/lenders/shop-out → application_lender_threads). Renders
    // <ShoppingOutClient> via the catch-all dispatcher.
    { path: "shopping-out", label: "Shopping Out", kind: "shopping_out", entity: "application" },
    // Offers — Phase 6 (Jordan/Oasis 2026-05-23). Deal-first intelligence
    // view (accordion + kanban toggle) replacing the generic
    // kind="kanban" rendering. Reads application_lender_threads grouped
    // by application; flags info_requested / last_error as Needs Review.
    { path: "offers", label: "Offers", kind: "offers_v2", entity: "offer" },
    {
      path: "funded-deals",
      label: "Funded Deals",
      kind: "kanban",
      entity: "funded_deal",
      // Synthetic Kanban bucketing — server computes renewal_window from
      // funded_at + term_months on every row read. Columns:
      //   upcoming (0-40%) → due (40-50%) → overdue (50%+) → renewed → lost
      // Matches the meeting decision (CC + Adon, 2026-05-15) that funded
      // deals get a renewal-window-driven pipeline view instead of a flat
      // table. Operator can flip to ?view=table for sorting/filtering.
      config: { compute_group_by: "renewal_window" },
    },
    // Renewals — Phase 8 (Jordan/Oasis 2026-05-23). Funded-deals-backed
    // view with progress bars, urgency sort, Needs Data badge, wired
    // tel:/mailto: buttons. Replaces the generic kind="kanban" rendering
    // of the (unused) `renewal` entity in tenant_records — the actual
    // renewal data is computed from funded_deals.
    { path: "renewals", label: "Renewals", kind: "renewals_v2" },
    { path: "commissions", label: "Commissions", kind: "table", entity: "commission" },
    // Lenders — Phase 7 (Jordan/Oasis 2026-05-23). Knowledge-base shell
    // with the expanded field set (buy rate, funding range, restricted
    // states, decline reasons) and the LenderDetailDrawer. Replaces the
    // generic kind="table" rendering for SunBiz; other tenants still
    // get the generic table primitive.
    { path: "lenders", label: "Lenders", kind: "lenders_v2", entity: "lender" },
    { path: "import", label: "Import leads", kind: "import" },
    // Phase 3b/3c (2026-06-02). Rendered by the catch-all dispatcher.
    { path: "conversations", label: "Conversations", kind: "conversations" },
    { path: "campaigns", label: "Campaigns", kind: "campaigns" },
    // Settings — tenant-scoped, routed via the catch-all so
    // resolveDataTenant() can gate previewMode for non-owners. See
    // schema.ts ManifestPageKind / TenantSettings for the full rules.
    { path: "settings", label: "Settings", kind: "settings" },
    // Automations — Option A pattern, same as Settings (2026-05-25).
    { path: "automations", label: "Automations", kind: "automations" },
    { path: "playbook", label: "Operating Manual", kind: "markdown", config: { body: "Welcome to the SunBiz Agent Command Center — your cockpit for running a funding deal from first contact to funded and renewed. This page is your map: what every tab does, the buttons you'll actually press, and the order to use them. Read **The Golden Path** first — it's the whole job in eight steps. Everything else is detail.\n\n## The Golden Path — the whole job, start to finish\n\n1. **A prospect fills out your interest form.** You share your personal link (see Forms). They enter business name, their name, phone, email, and monthly revenue.\n2. **They land in Leads as a \"Hot Lead,\" assigned to you** — by name, automatically, because they used your link.\n3. **The system texts + emails them the full-application link**, signed by you. (This is the Inquiry Welcomer drip in Sequences.)\n4. **They complete the Full Application and upload 3 months of bank statements.**\n5. **An Application appears** in the Applications board at \"Application In,\" and **underwriting runs automatically** — the system grades the deal.\n6. **You shop it out.** Open Shopping Out, pick the deal, review the lenders ranked by fit, attach the statements, CC your teammates, and hit Send.\n7. **Lender replies land in Conversations and Offers.** You compare offers and present the best one.\n8. **The deal funds, Commissions are booked, and Renewals watches the clock** for the re-up.\n\nEverything below supports that spine. The four sidebar groups follow the deal's life: Operations (your cockpit + AI help), Pipeline (prospect to application), Deals (offers to funded to renewal), System (the plumbing).\n\n## Meet your agents\n\nYou have two AI teammates. Talk to them like a coworker on the Agents tab.\n\n- **Solara** — your funding-shop operator. She watches the pipeline, drafts follow-ups in your voice over text and email, scores applications against the lender book, explains underwriting results, and surfaces renewals before they close.\n- **Helios** — your sales voice. He runs first-touch outreach, revives ghosted deals, handles objections, and chases missing documents — the same human-sounding cadence you'd send yourself, just faster.\n\n## Operations\n\n### Dashboard\nYour morning starting line — a live snapshot of the business with click-through to the work.\n\n- **The five KPI cards** — Hot Leads, Missing Info, In Motion, Funded This Month (count + dollars), Renewals Due. **Each card is a button** — click it to jump to that filtered list.\n- **The SunBiz action band** — Renewal Alerts, Offers Needing Review, Shopping Out (last 7 days). Click any to go to that tab.\n- **Lead Pipeline & Opportunity Pipeline bars** — colored stage bars; click a segment (or \"Open\") to open that stage filtered.\n- **Today's Focus** — your 5 most urgent leads (most dollars + most overdue). Click a name to open it.\n- **Renewals Due Soon** — top 3 deals nearing renewal. Click the amount to open the deal.\n- **System Health** — alerts that need a human; **Dismiss** clears one.\n- **Your Agents** — **Chat** opens that agent.\n\n**Start here every day.** Work the top cards left to right, then Today's Focus.\n\n### Agents\nChat with Solara or Helios — like ChatGPT, but wired into your data.\n\n- **Agent picker (top)** — switch between Solara and Helios. Switching starts a fresh chat.\n- **Message box + Send** — type your question (Enter to send). Ask plainly: \"What funding leads need action today?\"\n- **Attach files (paperclip)** — drop in up to 5 files (e.g. a call transcript to score).\n- **Plan / Execute toggle** — Plan lets the agent only look (safe); Execute lets it take actions. Leave on Plan unless you want it to do something.\n- **History (top-left menu)** — reopen past chats or start a new one.\n- **Copy / Export** on any reply — save an answer as PDF or Markdown.\n\n**When in doubt, ask the agent.** It can read the same dashboard you see.\n\n### Reasoning\nA launchpad of one-click prompts for the agents. Each card drops a ready-made request into chat with the right agent already selected — hit Enter to send. Solara cards cover the funding briefing, qualifying submissions, matching lenders, recording funded deals, and renewal sweeps. Helios cards cover first-touch SMS, revival cadences, expired-offer saves, blast drafts, and objection handling.\n\n**Faster than typing.** Click a card, review the prompt, hit Enter.\n\n### Playbook\nThis page. Your operating manual. Come back any time you forget where a button lives.\n\n## Pipeline\n\n### Leads\nYour prospect board — everyone who's shown interest but hasn't been shopped to lenders yet, grouped by stage.\n\n- **Stages, left to right:** Hot Lead, Missing Info, Follow Up, Sent Application, Viewed Application, Signed Application, Submitted, Funded, Ghost, Declined, Default, Opted Out. Click a stage header to expand or collapse it.\n- **New Lead** (top right) — add a prospect by hand.\n- **Search box** — filter by business, contact, or email.\n- **\"Touch first\" callout** — the single most urgent overdue lead; click **Open** to jump to it.\n- **Click any lead name** to open the detail drawer with everything about them.\n\nInside the lead drawer:\n\n- **Tabs:** Activity (full timeline), Owner (guarantor details), Lenders (shop-out results once sent), Bank (underwriting + risk flags), Docs (uploads + what's missing — a red badge means a required doc is missing), Notes (internal notes).\n- **Footer actions:** **Send Email**, **Send SMS**, **Call** (rings your Kixie line then bridges to them), **Text Torrent** (enroll them in a drip sequence).\n- **Assignment dropdown** — reassign the lead to a teammate.\n- **Edit full record** — open the complete editable form.\n- **Docs tab** — pick a document type, upload a file; uploading the last required doc can auto-advance the stage.\n- **Notes tab** — type a note, then Save.\n\n### Shopping Out\nThe money tab. Broadcast one application to multiple lenders in a single, professional outreach. The page walks left to right:\n\n1. **Pick an application** — search and click one. Lenders re-rank for that deal.\n2. **Choose lenders** — each has a checkbox; the **top 5 best-fit lenders are pre-checked**, and lenders that don't fit the deal's state or industry are flagged. Adjust as needed.\n3. **Choose documents** — checkboxes for each file (bank statements, etc.); all on by default.\n4. **CC teammates** — check Jordan or Alex to CC them, or type a Custom CC email (e.g. a processor).\n5. **Add notes** (optional) — context injected into the lender email.\n6. **Send to X lenders** — fires the outreach.\n\n- **Refresh** — re-rank lenders and reload thread status.\n- **High-risk send** — if a flagged lender is selected, a confirmation pops; type an override note and **Proceed Anyway** (it's logged), or **Cancel**.\n- **Retry** — on any thread that errored, resets it so it re-sends.\n\n**This is where deals become money.** Trust the ranking, attach the statements, CC the right people, send.\n\n### Applications\nYour deal board — full applications moving through underwriting and shopping, grouped by status.\n\n- **Statuses:** Application In, Shopping, Missing Info, Requested Docs, Docs Out, Login, Funded, Follow Ups, Declined, Dead. Click a stage to expand or collapse.\n- **New Application** — add one manually.\n- **Search box** and **\"Touch first\"** alert, same as Leads.\n- **Click any row** to open the detail drawer (same tabs as Leads: Activity, Owner, Lenders, Bank, Documents, Notes).\n- **Shop Out** (drawer header) — jumps to Shopping Out with this deal pre-selected.\n- **Bank tab, Re-run Underwriting** — re-grade the deal; **View full underwriting report** opens the detail page (grade, verified positions, leverage, red flags).\n\n**Underwriting usually runs on its own** when the application + statements arrive. Re-run only if something changed.\n\n### Conversations\nYour unified inbox. Every SMS, call, and email with a merchant, threaded by contact.\n\n- **Filter buttons:** All, SMS, Calls, Email.\n- **Search** — find a contact by name, number, email, or message text.\n- **Click a contact** to see the full thread on the right.\n- **Open lead** — jump to that contact's lead.\n- **Reply** — pick a provider (TextTorrent or Kixie), type in the composer, **Send**. **AI reply** drafts a suggested response you can edit before sending.\n- **Recording / Transcript** links appear on calls.\n\n### Campaigns\nBulk SMS to a list (via TextTorrent), with delivery analytics.\n\n- **New campaign** — opens the form: pick a Contact list, optionally a Template (auto-fills the message), write or edit the Message (include STOP opt-out language), optionally Schedule it, then **Create campaign**.\n- The table below shows send, delivery, and engagement stats per campaign.\n\n**Use deliberately** — these are real texts to real people. Respect opt-outs.\n\n## Deals\n\n### Offers\nLender responses, organized by deal. Every application with active lender threads or recorded offers.\n\n- **Accordion / Kanban toggle** — Accordion lists one row per deal (expand to see every lender thread: status, amount, term, factor, dates); Kanban shows threads as cards across 8 columns (Pending, Sent, Responded, Approved, Needs Review, Declined, No Response, Error).\n- **Needs Review badge** (orange) — a lender asked for info or a send errored; handle these first.\n- **Status pills and counts** show where each thread stands.\n\n**This is where you read what came back** and pick the offer to present.\n\n### Renewals\nFunded deals approaching their re-up, ranked by urgency. This is the only place renewals live.\n\n- **KPI cards:** Past Due, This Week, This Month (with potential volume), Est. Commission.\n- **Buckets:** Past Due, Next 60 Days, Later, No Date Set (automatic).\n- **Phone / Email icons** — call or email the merchant about renewing (email subject pre-filled).\n- **Progress bar** — how far through the term they are; **Needs Data** means a date is missing.\n\n**Anything 50%+ through term** is your re-funding focus this week.\n\n### Commissions\nYour commission ledger — one row per funded deal's payout.\n\n- **New commission** — record a payout (business name, funded deal, lender, broker share %, amount).\n- **Columns:** Business, Funded Deal, Lender, Broker Share %, Amount, **Paid** (checkmark toggle), Paid At.\n- **Open** (on a row) — edit the record. **Search** filters the table.\n\n**Empty until deals fund** — it fills as you close.\n\n### Lenders\nYour lender book — the criteria that powers the Shopping Out ranking. Keep it accurate and matches get better.\n\n- **Search**, **Active only** toggle, **Product type** filter.\n- **New lender** — opens the form drawer. **Click any row** to edit. **Active toggle** turns a lender on or off inline.\n- Inside the lender drawer, what defines a lender:\n- Identity: name, contact email, portal URL, product type, active.\n- Match gates: min monthly revenue, max funded amount, min time in business, FICO floor, SLA days.\n- Hard requirements: tier, defaults policy, position min/max, max negative days, reverses-only, paper grades accepted, submission CC emails.\n- Buy rate & range: buy rate, funding min/max, term min/max.\n- Restrictions: industry preferences, industry restrictions, restricted states, required documents, common decline reasons, notes.\n- **Save** or **Delete** at the bottom.\n\n**The restricted states + industries here** are exactly what auto-flags a bad lender match in Shopping Out.\n\n## System\n\n### Import\nBring in leads by CSV — two lanes.\n\n- **Warm pipeline tab** — paste or upload a CSV straight into Leads. Set a default source, choose Skip duplicates by email / phone / business, then **Import N leads**. **Insert sample** shows the expected columns; **View leads** opens the result.\n- **Cold list tab** — a holding pen for prospecting. Pick or create a list, upload a CSV, map each column (Business / Contact / Phone / Email / Skip), then **Import**. Work them through the stage rail (Imported, Contacted, Replied, Qualified, Promoted, Dead); **Promote** moves a contact into the warm pipeline.\n\n### Forms\nYour three application forms plus your personal links. This replaced JotForm.\n\n- **Three step cards:** Initial Lead Capture (the short interest form), Full Application (the full app), Bank Statement Upload. Each has **Open form editor** and **Preview live form**.\n- **Per-agent links** — **Copy** buttons for Jordan, Alex, and Ezra. This is the link you share with prospects — a lead from your link is assigned to you automatically.\n\n**95% of your time here** is just clicking Copy on your own link.\n\n### Sequences\nThe automatic drip campaigns — welcome messages, reminders, nudges that fire on stage changes.\n\n- **The list** shows each sequence with a **Live / Paused** toggle, **Edit**, and **Delete**.\n- **New sequence** — start one from a template.\n- The **Inquiry Welcomer** is the auto-welcome that texts + emails new leads their application link, signed by their agent.\n\n**Mostly set-and-forget.** You'll rarely touch this beyond toggling one on or off.\n\n### Team\nAdd and manage teammates.\n\n- **Generate link** creates a one-time, 7-day invite link; **Copy** it to send. Optionally set the email and a Role (Admin, Loan officer, Processor, Read only, Member).\n- **Revoke** kills a pending invite; **Remove** takes a member off the tenant.\n\n### Automations\nThe scheduled background jobs running for SunBiz (lead scoring, follow-up checks, daily briefs).\n\n- **New automation** — name it, pick an agent, set a schedule (friendly Preset or raw Custom cron).\n- **Draft with AI** — describe what you want in plain English (\"every Monday 7am, pull funded deals and text me a summary\") and the agent writes the script; **Inspect generated Python** to see it; Save, then flip the toggle on.\n- **Toggle / Edit / Delete** existing jobs.\n- **Background workers** — health of the system daemons; mostly informational.\n\n**Agents rarely need this.** It's here for power moves later.\n\n### Settings\nConfiguration — owner-level.\n\n- **Profile** — your name, phone, targets. Save profile.\n- **Branding** — upload the SunBiz logo.\n- **Integrations** — API keys for the tools (TextTorrent, Kixie, email, etc.): Save, Test, Clear.\n- Team invites, password, device pairing, and AI provider keys also live here.\n\n**Ezra (owner) handles this.** Alex and Jordan rarely need it.\n\n## Your login and personal link\n\n- **Ezra** — Submissions@sunbizfunding.com (owner). **Alex** — alex@sunbizfunding.com. **Jordan** — jordan@sunbizfunding.com.\n- Your personal interest-form link is on the Forms tab (Copy next to your name). Share that link so every lead routes to you and you're CC'd on its lender emails.\n\n## Your daily rhythm\n\n1. **Dashboard** — clear the top cards + Today's Focus.\n2. **Conversations** — reply to anything inbound.\n3. **Leads** — move warm ones forward; chase missing docs.\n4. **Applications** — anything ready? Send it to Shopping Out.\n5. **Offers** — handle \"Needs Review,\" present offers.\n6. **Renewals** — work anything 50%+ through term.\n\n## Golden rules\n\n- **Bank statements are the gate.** No underwriting fires without the 3 months. Chase them first.\n- **Use your own link** so leads route to you.\n- **Trust the lender ranking** — restricted states and industries are auto-flagged for a reason.\n- **Keep the Lenders book accurate** — it's the engine behind every match.\n- **Campaigns are real sends** — respect opt-outs, include STOP language.\n- **Stuck? Ask Solara or Helios** on the Agents tab — they see what you see.\n" } },
  ],
  default_prompts: [
    // Solara — operational
    { agent_slug: "solara", label: "Morning briefing", prompt: "Pull leads that haven't been touched in 24h, applications waiting on docs, and offers expiring this week." },
    { agent_slug: "solara", label: "Renewal sweep", prompt: "Which funded deals are within 60 days of renewal? Surface the top 3 by amount." },
    { agent_slug: "solara", label: "Lender match", prompt: "For the top 3 qualified leads, recommend the best-fit lender based on monthly revenue and product type." },
    { agent_slug: "solara", label: "Record funded deal", prompt: "Create a funded deal from this note: ABC Corp funded $50,000 today with XYZ Capital on a 12-month term. If anything required is missing, ask one clear question before writing." },
    { agent_slug: "solara", label: "Update renewal status", prompt: "Find the renewal record for ABC Corp and mark the next action as call owner today. If there are multiple matches, show them before updating." },
    // Helios — sales / outreach
    { agent_slug: "helios", label: "Draft cold outreach", prompt: "Draft a first-touch SMS for a freshly qualified lead. Sound human, not corporate. Open with their business pain, not our offer." },
    { agent_slug: "helios", label: "Follow-up cadence", prompt: "For leads that ghosted after the application step, draft a 3-touch revival sequence over 7 days." },
    { agent_slug: "helios", label: "Close the loop", prompt: "An approved offer just expired. Draft the SMS to bring them back to the table without sounding salesy." },
  ],
  // Universal default 2026-05-15 — all tenant data lives in CC's Supabase
  // project, scoped by tenant_id + RLS. Lower onboarding friction (no
  // per-tenant Turso provisioning step). Clients who outgrow the shared
  // tier and want physical isolation can self-host Turso later.
  data_backend: "supabase",
  deployment_mode: "dedicated",
  permissions: { local_files: true, computer_control: false, web_access: true },
  onboarding_industry: "business_funding",
  tier: {
    label: "Pro",
    setup_complexity: "Guided",
    monthly_price_hint: "Custom",
    summary: "Funding shop: Solara + Helios, full pipeline.",
  },
  compliance: {
    tcpa: {
      send_window_local: "9am-9pm",
      honor_opt_outs: true,
      weekend_sends: false,
      opt_out_phrase: "Reply STOP to opt out.",
    },
  },
  // jotform integration removed 2026-06-06 — SunBiz intake is the
  // dashboard's native /forms designer + /f/<tenant>/<form>/<lead_token>
  // public flow. Twilio is kept for SMS; Turso for the per-tenant cache.
  integrations: [
    { kind: "twilio", enabled: true, credential_env_key: "SUNBIZ_AGENT_HMAC_SECRET" },
    { kind: "turso", enabled: true },
  ],
  // SunBiz employees run the shared VPS bridge across Claude Code / Codex /
  // Gemini and need to pick the runtime per chat — expose the picker (was
  // hidden when SunBiz was single-operator). The CLI selector still only
  // renders once the bridge is reachable (NEXT_PUBLIC_BRIDGE_CHAT_BASE -> the
  // VPS bridge); Auto-mode is the fallback when offline.
  ui: {
    advanced_picker: true,
  },
  meta: {
    created_at: FROZEN_AT,
    updated_at: FROZEN_AT,
    schema_version: MANIFEST_SCHEMA_VERSION,
  },
};

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
    // Maven (CMO) owns brand work — content, fans, sponsorships, drops.
    // Previously this seed had a 4-agent Lyra package; collapsed 2026-05-14
    // because the brand-command capabilities fold cleanly into Maven, and
    // a tenant-specific agent fork is over-engineering for one client.
    { slug: "maven", display_name: "Maven", enabled: true, primary: true },
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
    { agent_slug: "maven", label: "Fan check-in", prompt: "Pull the most engaged 10 subscribers this week. Suggest a personalised DM I can send." },
    { agent_slug: "maven", label: "Post idea", prompt: "What's a high-engagement post angle I haven't run this month?" },
    { agent_slug: "maven", label: "Merch drop sweep", prompt: "Which merch drops are due to go live this month? Anything understocked?" },
    { agent_slug: "maven", label: "Weekly brand pulse", prompt: "Summarise this week's posts, subscriber growth, and any sponsorship movement in 5 bullets." },
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
 * Slug map for synchronous lookups. The loader uses this as the fallback when
 * Supabase has no row for a slug; the AI editor writes new manifests to DB,
 * never to this map.
 */
export const SEED_MANIFESTS: Record<string, TenantManifest> = {
  default: OASIS_SEED,
  oasis: OASIS_SEED,
  sun: SUN_SEED,
  suga: SUGA_SEED,
};

export function getSeedManifest(slug: string | null | undefined): TenantManifest {
  const key = (slug || "").trim().toLowerCase();
  return SEED_MANIFESTS[key] || OASIS_SEED;
}
