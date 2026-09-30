/**
 * Industry templates — starter manifests the onboarding wizard offers.
 *
 * A template is a complete TenantManifest with sensible nav, sample agents,
 * suggested entities + pages, and default prompts that match what a typical
 * operator in that industry would want on day one. The wizard reads the
 * template, asks 6–10 industry-specific questions, applies the answers as
 * mutator calls, then persists the result as the tenant's manifest.
 *
 * Why TypeScript and not JSON: every field flows through tsc so a typo or
 * stale enum value breaks the build, not the runtime. JSON would silently
 * drift from the schema.
 *
 * Each template MUST pass parseManifest. The lib/manifest/__validate.ts
 * helper (called only from build-time check in 2c) verifies that.
 */

import type { TenantManifest } from "./schema";
import { MANIFEST_SCHEMA_VERSION } from "./schema";

const NOW = "2026-05-14T00:00:00.000Z";

export const REAL_ESTATE_TEMPLATE: TenantManifest = {
  version: 1,
  tenant_slug: "real-estate-template",
  brand: {
    name: "Your Real Estate Command",
    logo: "oasis",
    subtitle: "Real Estate Operations",
    footer_label: "Real estate brokerage · powered by OASIS AI",
    footer_tagline: "Every lead, every deal, one place.",
  },
  // No agents in a template. A workspace's teammates come from the departments
  // chosen at setup (lib/provisioning/team.ts), named for their department and
  // never for one of OASIS's own agents (2026-09-30).
  agents: [],
  nav: [
    { href: "/", label: "Today", icon: "LayoutDashboard", group: "Operations" },
    { href: "/pipeline", label: "Pipeline", icon: "GitBranch", group: "Operations" },
    { href: "/reasoning", label: "Reasoning", icon: "Brain", group: "Operations" },
    { href: "/leads", label: "Leads", icon: "Users", group: "Pipeline" },
    { href: "/properties", label: "Properties", icon: "BookUser", group: "Pipeline" },
    { href: "/deals", label: "Deals", icon: "HandCoins", group: "Pipeline" },
    { href: "/commissions", label: "Commissions", icon: "DollarSign", group: "Pipeline" },
    { href: "/contacts", label: "Contacts", icon: "BookUser", group: "Pipeline" },
    { href: "/sms", label: "SMS", icon: "MessageSquare", group: "Outreach" },
    { href: "/email-blast", label: "Email", icon: "Mail", group: "Outreach" },
    { href: "/integrations", label: "Integrations", icon: "Plug", group: "System" },
    { href: "/settings", label: "Settings", icon: "Settings", group: "System" },
  ],
  data_model: [
    {
      name: "lead",
      label: "Lead",
      fields: [
        { name: "name", type: "string", required: true },
        { name: "phone", type: "string" },
        { name: "email", type: "string" },
        { name: "source", type: "enum", enum_values: ["referral", "website", "open_house", "sign", "mls", "other"] },
        { name: "stage", type: "enum", enum_values: ["new", "qualified", "showing", "offer", "won", "lost"], required: true },
        { name: "budget", type: "number" },
        { name: "notes", type: "string" },
      ],
    },
    {
      name: "property",
      label: "Property",
      fields: [
        { name: "address", type: "string", required: true },
        { name: "type", type: "enum", enum_values: ["single_family", "condo", "multi_family", "townhouse", "land", "commercial"] },
        { name: "list_price", type: "number" },
        { name: "bedrooms", type: "number" },
        { name: "bathrooms", type: "number" },
        { name: "sqft", type: "number" },
        { name: "status", type: "enum", enum_values: ["active", "pending", "sold", "off_market"] },
      ],
    },
    {
      name: "deal",
      label: "Deal",
      fields: [
        { name: "property_id", type: "string", required: true },
        { name: "buyer_lead_id", type: "string" },
        { name: "seller_lead_id", type: "string" },
        { name: "offer_price", type: "number" },
        { name: "commission_pct", type: "number" },
        { name: "close_date", type: "date" },
        { name: "stage", type: "enum", enum_values: ["offer", "accepted", "under_contract", "closed", "cancelled"] },
      ],
    },
  ],
  pages: [
    { path: "reasoning", label: "Reasoning", kind: "reasoning" },
    { path: "leads", label: "Leads", kind: "kanban", entity: "lead", config: { group_by: "stage" } },
    { path: "properties", label: "Properties", kind: "table", entity: "property" },
    { path: "deals", label: "Deals", kind: "kanban", entity: "deal", config: { group_by: "stage" } },
  ],
  permissions: { local_files: false, computer_control: false, web_access: true },
  // No default prompts: the old ones were addressed to OASIS's own agents.
  default_prompts: [],
  onboarding_industry: "real_estate",
  data_backend: "supabase",
  deployment_mode: "shared",
  tier: {
    label: "Starter",
    setup_complexity: "Self-serve",
    monthly_price_hint: "$49/mo",
    summary: "Lead pipeline + property + deal tracking.",
  },
  meta: { created_at: NOW, updated_at: NOW, schema_version: MANIFEST_SCHEMA_VERSION },
};

export const ECOMMERCE_TEMPLATE: TenantManifest = {
  version: 1,
  tenant_slug: "ecommerce-template",
  brand: {
    name: "Your Store Command",
    logo: "oasis",
    subtitle: "E-commerce Operations",
    footer_label: "E-commerce · powered by OASIS AI",
    footer_tagline: "Move product. Stay sane.",
  },
  agents: [],
  nav: [
    { href: "/", label: "Dashboard", icon: "LayoutDashboard", group: "Operations" },
    { href: "/reasoning", label: "Reasoning", icon: "Brain", group: "Operations" },
    { href: "/orders", label: "Orders", icon: "ShoppingBag", group: "Commerce" },
    { href: "/products", label: "Products", icon: "BadgeDollarSign", group: "Commerce" },
    { href: "/customers", label: "Customers", icon: "Users", group: "Commerce" },
    { href: "/email-blast", label: "Email", icon: "Mail", group: "Outreach" },
    { href: "/sms", label: "SMS", icon: "MessageSquare", group: "Outreach" },
    { href: "/integrations", label: "Integrations", icon: "Plug", group: "System" },
    { href: "/settings", label: "Settings", icon: "Settings", group: "System" },
  ],
  data_model: [
    {
      name: "product",
      label: "Product",
      fields: [
        { name: "sku", type: "string", required: true },
        { name: "name", type: "string", required: true },
        { name: "price", type: "number" },
        { name: "stock", type: "number" },
        { name: "status", type: "enum", enum_values: ["active", "archived", "out_of_stock"] },
      ],
    },
    {
      name: "order",
      label: "Order",
      fields: [
        { name: "order_number", type: "string", required: true },
        { name: "customer_id", type: "string" },
        { name: "total", type: "number" },
        { name: "status", type: "enum", enum_values: ["new", "paid", "shipped", "delivered", "refunded"], required: true },
        { name: "placed_at", type: "datetime" },
      ],
    },
    {
      name: "customer",
      label: "Customer",
      fields: [
        { name: "name", type: "string" },
        { name: "email", type: "string" },
        { name: "lifetime_value", type: "number" },
      ],
    },
  ],
  pages: [
    { path: "reasoning", label: "Reasoning", kind: "reasoning" },
    { path: "orders", label: "Orders", kind: "table", entity: "order" },
    { path: "products", label: "Products", kind: "table", entity: "product" },
    { path: "customers", label: "Customers", kind: "table", entity: "customer" },
  ],
  permissions: { local_files: false, computer_control: false, web_access: true },
  default_prompts: [],
  onboarding_industry: "ecommerce",
  data_backend: "supabase",
  deployment_mode: "shared",
  tier: {
    label: "Starter",
    setup_complexity: "Self-serve",
    monthly_price_hint: "$49/mo",
    summary: "Orders, products, customers in one shell.",
  },
  meta: { created_at: NOW, updated_at: NOW, schema_version: MANIFEST_SCHEMA_VERSION },
};

export const AGENCY_TEMPLATE: TenantManifest = {
  version: 1,
  tenant_slug: "agency-template",
  brand: {
    name: "Your Agency Command",
    logo: "oasis",
    subtitle: "Agency Operations",
    footer_label: "Agency · powered by OASIS AI",
    footer_tagline: "Clients delivered.",
  },
  agents: [],
  nav: [
    { href: "/", label: "Today", icon: "LayoutDashboard", group: "Operations" },
    { href: "/reasoning", label: "Reasoning", icon: "Brain", group: "Operations" },
    { href: "/clients", label: "Clients", icon: "Users", group: "Pipeline" },
    { href: "/projects", label: "Projects", icon: "GitBranch", group: "Pipeline" },
    { href: "/retainers", label: "Retainers", icon: "RefreshCcw", group: "Pipeline" },
    { href: "/invoices", label: "Invoices", icon: "BadgeDollarSign", group: "Money" },
    { href: "/integrations", label: "Integrations", icon: "Plug", group: "System" },
    { href: "/settings", label: "Settings", icon: "Settings", group: "System" },
  ],
  data_model: [
    {
      name: "client",
      label: "Client",
      fields: [
        { name: "name", type: "string", required: true },
        { name: "primary_contact", type: "string" },
        { name: "monthly_retainer", type: "number" },
        { name: "status", type: "enum", enum_values: ["active", "paused", "churned"] },
      ],
    },
    {
      name: "project",
      label: "Project",
      fields: [
        { name: "client_id", type: "string", required: true },
        { name: "name", type: "string", required: true },
        { name: "stage", type: "enum", enum_values: ["discovery", "in_progress", "review", "done", "blocked"], required: true },
        { name: "due_date", type: "date" },
      ],
    },
  ],
  pages: [
    { path: "reasoning", label: "Reasoning", kind: "reasoning" },
    { path: "clients", label: "Clients", kind: "table", entity: "client" },
    { path: "projects", label: "Projects", kind: "kanban", entity: "project", config: { group_by: "stage" } },
  ],
  permissions: { local_files: false, computer_control: false, web_access: true },
  default_prompts: [],
  onboarding_industry: "agency",
  data_backend: "supabase",
  deployment_mode: "shared",
  tier: {
    label: "Pro",
    setup_complexity: "Guided",
    monthly_price_hint: "$99/mo",
    summary: "Clients, projects, retainers tracked end-to-end.",
  },
  meta: { created_at: NOW, updated_at: NOW, schema_version: MANIFEST_SCHEMA_VERSION },
};

export const CUSTOM_TEMPLATE: TenantManifest = {
  version: 1,
  tenant_slug: "custom-template",
  brand: {
    name: "Your Command Center",
    logo: "oasis",
    subtitle: "Agent Operations",
    footer_label: "Custom · powered by OASIS AI",
    footer_tagline: "Build it your way.",
  },
  // Teammates come from the departments chosen at setup, like every template.
  agents: [],
  nav: [
    { href: "/", label: "Dashboard", icon: "LayoutDashboard", group: "Operations" },
    { href: "/reasoning", label: "Reasoning", icon: "Brain", group: "Operations" },
    { href: "/settings", label: "Settings", icon: "Settings", group: "System" },
  ],
  permissions: { local_files: false, computer_control: false, web_access: true },
  onboarding_industry: "custom",
  data_backend: "supabase",
  deployment_mode: "shared",
  tier: {
    label: "Enterprise",
    setup_complexity: "Done-for-you",
    monthly_price_hint: "Custom",
    summary: "Your departments, set up around your business.",
  },
  meta: { created_at: NOW, updated_at: NOW, schema_version: MANIFEST_SCHEMA_VERSION },
};

export const TEMPLATES = {
  real_estate: REAL_ESTATE_TEMPLATE,
  ecommerce: ECOMMERCE_TEMPLATE,
  agency: AGENCY_TEMPLATE,
  custom: CUSTOM_TEMPLATE,
} as const;

export type TemplateKey = keyof typeof TEMPLATES;

export const TEMPLATE_KEYS: TemplateKey[] = ["real_estate", "ecommerce", "agency", "custom"];

/**
 * Wizard questions per template — the onboarding flow renders these step by
 * step. Each answer is later folded into the manifest as a mutator call.
 */
export type WizardQuestion = {
  id: string;
  prompt: string;
  hint?: string;
  kind: "text" | "longtext" | "single_choice" | "multi_choice" | "number";
  choices?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
};

export const WIZARD_QUESTIONS: Record<TemplateKey, WizardQuestion[]> = {
  real_estate: [
    { id: "brand_name", prompt: "What's your brokerage or team called?", kind: "text", placeholder: "Casa Lago Realty", required: true },
    { id: "primary_market", prompt: "Where do you mostly sell?", hint: "City, region, or 'national'.", kind: "text", required: true },
    { id: "deal_volume", prompt: "Roughly how many deals do you close per year?", kind: "single_choice", required: true, choices: [
      { value: "lt_10", label: "Under 10" },
      { value: "10_30", label: "10–30" },
      { value: "30_75", label: "30–75" },
      { value: "75_plus", label: "75+" },
    ]},
    { id: "lead_sources", prompt: "Where do most leads come from today?", kind: "multi_choice", choices: [
      { value: "referral", label: "Referrals" },
      { value: "open_house", label: "Open houses" },
      { value: "website", label: "Website / SEO" },
      { value: "social", label: "Social media" },
      { value: "paid_ads", label: "Paid ads" },
    ]},
    { id: "extra_fields", prompt: "Any custom fields you track on leads we should include?", hint: "Comma-separated, like 'referral_source, pre_approved, school_district'.", kind: "longtext" },
    { id: "tagline", prompt: "Pick a 3-5 word tagline to show in the footer.", kind: "text", placeholder: "Every door, every deal." },
  ],
  ecommerce: [
    { id: "brand_name", prompt: "What's the store called?", kind: "text", required: true },
    { id: "platform", prompt: "Where is the store hosted?", kind: "single_choice", choices: [
      { value: "shopify", label: "Shopify" },
      { value: "woocommerce", label: "WooCommerce" },
      { value: "custom", label: "Custom build" },
      { value: "other", label: "Other" },
    ]},
    { id: "skus", prompt: "Roughly how many SKUs do you carry?", kind: "single_choice", choices: [
      { value: "lt_50", label: "Under 50" },
      { value: "50_500", label: "50–500" },
      { value: "500_plus", label: "500+" },
    ]},
    { id: "tagline", prompt: "Short footer tagline.", kind: "text", placeholder: "Move product. Stay sane." },
  ],
  agency: [
    { id: "brand_name", prompt: "Agency name?", kind: "text", required: true },
    { id: "service_lines", prompt: "What kinds of work do you sell?", kind: "longtext", hint: "One per line — branding, paid social, dev, etc." },
    { id: "client_count", prompt: "How many active clients?", kind: "single_choice", choices: [
      { value: "lt_5", label: "Under 5" },
      { value: "5_15", label: "5–15" },
      { value: "15_plus", label: "15+" },
    ]},
    { id: "tagline", prompt: "Short footer tagline.", kind: "text", placeholder: "Clients delivered." },
  ],
  custom: [
    { id: "brand_name", prompt: "What's this Command Center called?", kind: "text", required: true },
    { id: "describe", prompt: "In one paragraph, describe your business and what you'd like the AI to help with.", kind: "longtext", required: true },
    { id: "tagline", prompt: "Short footer tagline (optional).", kind: "text" },
  ],
};
