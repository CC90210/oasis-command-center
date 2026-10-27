/**
 * lib/os/custom-keys.ts - the custom keys vault's pure half: what a typed name
 * is saved as, a pasted block of KEY=value lines, and what a key is for.
 *
 * CC, 2026-10-26: adding a custom key should be dynamic. The apps with a card
 * already say which agents they serve (lib/os/connectors.ts departments). This
 * recognises those apps, and common apps without a card, in a key's name
 * ("HUBSPOT_PRIVATE_APP_TOKEN" is HubSpot's) and suggests the agents a card
 * would: the app's departments plus the Chief of Staff, the rule of
 * connectorDefaultAccess (lib/os/agent-access.ts). An AI model's key is
 * suggested for every agent. A name nothing recognises suggests nothing, and
 * the key is for all agents unless the owner picks.
 *
 * When the name says nothing, a value's well-known prefix can ("sk-ant-" is
 * Anthropic's). The value is looked at in the browser only, and only for that.
 * Every hint is a suggestion the owner sees, by agent name, before saving.
 *
 * Pure and client-safe: the vault (components/settings/CustomCredentialsVault.tsx)
 * runs it as the owner types, the route (app/api/credentials/custom) parses a
 * paste with it, and tests/custom-keys.test.ts pins it.
 */

import { agentNamesSentence, connectorDefaultAccess, orderedDepartments, type AgentAccess, type AgentChoice } from "@/lib/os/agent-access";
import { CONNECTOR_CATALOG } from "@/lib/os/connectors";
import type { DepartmentKey } from "@/lib/os/types";

/** A saved key's name: VAULT_KEY_PATTERN in lib/tenant-integration-store.ts (a test keeps the two equal). */
export const VAULT_KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * The longest value the vault keeps: 8 KB. The route refuses longer. A value is
 * one line (the form's box and a pasted KEY=value line), so a multi-line PEM
 * key does not keep its line breaks.
 */
export const VAULT_MAX_VALUE_LENGTH = 8192;

/** The most keys one save takes; the vault says so before the route refuses more. */
export const VAULT_MAX_PASTE_ENTRIES = 100;

/**
 * What a typed name is saved as: upper case, with every run of other
 * characters turned into one underscore ("hubspot api-key" is HUBSPOT_API_KEY).
 * Empty when nothing is left.
 */
export function normalizeVaultKeyName(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** Why a typed name cannot be saved, in a few words; null when it can. */
export function keyNameProblem(raw: string): string | null {
  if (looksLikeSecret(raw)) return "That looks like the secret itself. Paste it under Value, and give the key a name.";
  const name = normalizeVaultKeyName(raw);
  if (!name) return raw.trim() ? "Use letters, numbers and underscores." : null;
  if (!/^[A-Z]/.test(name)) return "Start the name with a letter.";
  return VAULT_KEY_NAME.test(name) ? null : "Use letters, numbers and underscores.";
}

/** One KEY=value line of a paste. */
export type PastedLine = { key: string; value: string };

/**
 * A pasted block of KEY=value lines, the way a .env file is written: blank
 * lines and # comments skipped, an `export ` prefix and quotes around a value
 * allowed. A line without a key and an = is skipped.
 */
export function parseDotenvLines(text: string): PastedLine[] {
  const out: PastedLine[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const stripped = line.startsWith("export ") ? line.slice(7) : line;
    const eq = stripped.indexOf("=");
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out.push({ key, value });
  }
  return out;
}

/** The lines of a paste that are neither blank, a comment, nor a KEY=value line. */
export function unreadablePasteLines(text: string): number {
  const written = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith("#")).length;
  return Math.max(0, written - parseDotenvLines(text).length);
}

export type KnownApp = {
  /** As the owner reads it: "HubSpot". */
  name: string;
  /** Who it is suggested for: departments (the Chief of Staff is added), or every agent. */
  departments: readonly DepartmentKey[] | "all";
  /** Words in a key's name that mean this app, in UPPER_SNAKE ("GOOGLE_ADS" is two words). */
  words: readonly string[];
  /** Well-known starts of its keys' values. */
  prefixes?: readonly string[];
  /** What a key of this app is usually called, offered when only the value was recognised. */
  usualName?: string;
  /** Its card on Settings > Connections. */
  card?: string;
};

/** The apps with a card: their words. Names and departments come from the catalog. */
export const CARD_WORDS: Readonly<Record<string, Omit<KnownApp, "name" | "departments" | "card">>> = {
  // Not "whsec_": Clerk, Svix and Resend webhook secrets start that way too.
  stripe: { words: ["STRIPE"], prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_"], usualName: "STRIPE_SECRET_KEY" },
  quickbooks: { words: ["QUICKBOOKS", "QBO", "INTUIT"] },
  xero: { words: ["XERO"] },
  plaid: { words: ["PLAID"] },
  wise: { words: ["WISE"] },
  "google-workspace": { words: ["GMAIL", "GOOGLE_WORKSPACE", "GOOGLE_CALENDAR", "GCAL", "GSUITE", "GOOGLE_MEET"] },
  smtp: { words: ["SMTP", "IMAP", "SENDGRID", "MAILGUN", "POSTMARK", "SES"], prefixes: ["SG."], usualName: "SENDGRID_API_KEY" },
  calendly: { words: ["CALENDLY"] },
  "cal-com": { words: ["CAL_COM", "CALCOM"], prefixes: ["cal_live_", "cal_test_"], usualName: "CAL_COM_API_KEY" },
  zoom: { words: ["ZOOM"] },
  fathom: { words: ["FATHOM"] },
  fireflies: { words: ["FIREFLIES"] },
  slack: { words: ["SLACK"], prefixes: ["xoxb-", "xoxp-", "xapp-", "https://hooks.slack.com/"], usualName: "SLACK_BOT_TOKEN" },
  telegram: { words: ["TELEGRAM"] },
  twilio: { words: ["TWILIO"] },
  quo: { words: ["QUO", "OPENPHONE"] },
  whatsapp: { words: ["WHATSAPP"] },
  discord: { words: ["DISCORD"], prefixes: ["https://discord.com/api/webhooks/", "https://discordapp.com/api/webhooks/"], usualName: "DISCORD_WEBHOOK_URL" },
  // Not TEAMS alone: LINEAR_TEAMS_ID is Linear's.
  "microsoft-teams": { words: ["MSTEAMS", "MS_TEAMS", "MICROSOFT_TEAMS", "TEAMS_WEBHOOK"] },
  // Not META alone: META_LLAMA_API_KEY is a model key, not the Facebook app.
  meta: {
    words: ["FACEBOOK", "FB", "INSTAGRAM", "IG", "META_ACCESS", "META_APP", "META_ADS", "META_AD", "META_PIXEL", "META_PAGE", "META_GRAPH", "META_BUSINESS", "META_SYSTEM_USER", "META_CAPI"],
  },
  zernio: { words: ["ZERNIO", "LATE"] },
  "constant-contact": { words: ["CONSTANT_CONTACT", "CTCT"] },
  cloudflare: { words: ["CLOUDFLARE", "CF"] },
  hostinger: { words: ["HOSTINGER"] },
  github: { words: ["GITHUB", "GH"], prefixes: ["github_pat_", "ghp_", "gho_", "ghs_"], usualName: "GITHUB_TOKEN" },
  firecrawl: { words: ["FIRECRAWL"], prefixes: ["fc-"], usualName: "FIRECRAWL_API_KEY" },
  gohighlevel: { words: ["GOHIGHLEVEL", "HIGHLEVEL", "GHL"] },
  jev: { words: ["JEV", "TYPESAFE"] },
};

const SALES: readonly DepartmentKey[] = ["sales"];
const SALES_MARKETING: readonly DepartmentKey[] = ["sales", "marketing"];
const PHONES: readonly DepartmentKey[] = ["sales", "client_success"];
const MARKETING: readonly DepartmentKey[] = ["marketing"];
const SUPPORT: readonly DepartmentKey[] = ["client_success"];
const FINANCE: readonly DepartmentKey[] = ["finance"];
const PAYROLL: readonly DepartmentKey[] = ["finance", "operations"];
const PAYMENTS: readonly DepartmentKey[] = ["finance", "sales"];
const OPERATIONS: readonly DepartmentKey[] = ["operations"];

/** Common apps with no card, and who each is for. An AI model is for every agent. */
const OTHER_APPS: readonly KnownApp[] = [
  // AI models
  // Not a bare "sk-": DeepSeek and many other model APIs start their keys that way.
  { name: "OpenAI", departments: "all", words: ["OPENAI"], prefixes: ["sk-proj-", "sk-svcacct-"], usualName: "OPENAI_API_KEY" },
  { name: "Anthropic", departments: "all", words: ["ANTHROPIC", "CLAUDE"], prefixes: ["sk-ant-"], usualName: "ANTHROPIC_API_KEY" },
  { name: "Llama", departments: "all", words: ["LLAMA"] },
  { name: "Gemini", departments: "all", words: ["GEMINI", "GOOGLE_AI", "GOOGLE_GENERATIVE_AI"] },
  { name: "Groq", departments: "all", words: ["GROQ"], prefixes: ["gsk_"], usualName: "GROQ_API_KEY" },
  { name: "Mistral", departments: "all", words: ["MISTRAL"] },
  { name: "Perplexity", departments: "all", words: ["PERPLEXITY", "PPLX"], prefixes: ["pplx-"], usualName: "PERPLEXITY_API_KEY" },
  { name: "OpenRouter", departments: "all", words: ["OPENROUTER"], prefixes: ["sk-or-"], usualName: "OPENROUTER_API_KEY" },
  { name: "DeepSeek", departments: "all", words: ["DEEPSEEK"] },
  { name: "xAI", departments: "all", words: ["XAI", "GROK"], prefixes: ["xai-"], usualName: "XAI_API_KEY" },
  { name: "Cohere", departments: "all", words: ["COHERE"] },
  { name: "Replicate", departments: "all", words: ["REPLICATE"], prefixes: ["r8_"], usualName: "REPLICATE_API_TOKEN" },
  { name: "Hugging Face", departments: "all", words: ["HUGGINGFACE", "HUGGING_FACE", "HF"], prefixes: ["hf_"], usualName: "HF_TOKEN" },
  { name: "Together AI", departments: "all", words: ["TOGETHER", "TOGETHERAI"] },
  { name: "Fireworks AI", departments: "all", words: ["FIREWORKS"] },
  // Sales: CRMs, outreach, calls and texts, signatures, forms, shops
  { name: "HubSpot", departments: SALES_MARKETING, words: ["HUBSPOT"], prefixes: ["pat-na1-", "pat-na2-", "pat-eu1-"], usualName: "HUBSPOT_PRIVATE_APP_TOKEN" },
  { name: "Salesforce", departments: SALES, words: ["SALESFORCE", "SFDC"] },
  { name: "Pipedrive", departments: SALES, words: ["PIPEDRIVE"] },
  { name: "Close", departments: SALES, words: ["CLOSEIO", "CLOSE_IO", "CLOSE_CRM"] },
  { name: "Attio", departments: SALES, words: ["ATTIO"] },
  { name: "Zoho", departments: SALES, words: ["ZOHO"] },
  // Not APOLLO alone: APOLLO_KEY and APOLLO_GRAPH_REF are Apollo GraphQL's.
  { name: "Apollo.io", departments: SALES, words: ["APOLLO_IO", "APOLLOIO"] },
  { name: "Clay", departments: SALES, words: ["CLAY"] },
  { name: "Hunter", departments: SALES, words: ["HUNTER"] },
  { name: "ZoomInfo", departments: SALES, words: ["ZOOMINFO"] },
  { name: "Instantly", departments: SALES, words: ["INSTANTLY"] },
  { name: "Lemlist", departments: SALES, words: ["LEMLIST"] },
  { name: "Smartlead", departments: SALES, words: ["SMARTLEAD"] },
  { name: "DocuSign", departments: SALES, words: ["DOCUSIGN"] },
  { name: "PandaDoc", departments: SALES, words: ["PANDADOC"] },
  { name: "Kixie", departments: PHONES, words: ["KIXIE"] },
  { name: "TextTorrent", departments: PHONES, words: ["TEXTTORRENT", "TEXT_TORRENT"] },
  { name: "Aircall", departments: PHONES, words: ["AIRCALL"] },
  { name: "Dialpad", departments: PHONES, words: ["DIALPAD"] },
  { name: "RingCentral", departments: PHONES, words: ["RINGCENTRAL"] },
  { name: "Typeform", departments: SALES_MARKETING, words: ["TYPEFORM"] },
  { name: "Jotform", departments: SALES_MARKETING, words: ["JOTFORM"] },
  { name: "Tally", departments: SALES_MARKETING, words: ["TALLY"] },
  { name: "Shopify", departments: SALES_MARKETING, words: ["SHOPIFY"], prefixes: ["shpat_", "shpca_", "shpss_"], usualName: "SHOPIFY_ACCESS_TOKEN" },
  { name: "WooCommerce", departments: SALES_MARKETING, words: ["WOOCOMMERCE"] },
  // Marketing: email lists, ads, social, sites, analytics, media
  { name: "Mailchimp", departments: MARKETING, words: ["MAILCHIMP"] },
  { name: "Klaviyo", departments: MARKETING, words: ["KLAVIYO"] },
  { name: "ActiveCampaign", departments: SALES_MARKETING, words: ["ACTIVECAMPAIGN", "ACTIVE_CAMPAIGN"] },
  { name: "Kit", departments: MARKETING, words: ["CONVERTKIT"] },
  { name: "beehiiv", departments: MARKETING, words: ["BEEHIIV"] },
  { name: "Brevo", departments: MARKETING, words: ["BREVO", "SENDINBLUE"] },
  { name: "Google Ads", departments: MARKETING, words: ["GOOGLE_ADS", "ADWORDS"] },
  { name: "Google Analytics", departments: MARKETING, words: ["GOOGLE_ANALYTICS", "GA4"] },
  { name: "TikTok", departments: MARKETING, words: ["TIKTOK"] },
  { name: "LinkedIn", departments: SALES_MARKETING, words: ["LINKEDIN"] },
  { name: "YouTube", departments: MARKETING, words: ["YOUTUBE"] },
  { name: "X (Twitter)", departments: MARKETING, words: ["TWITTER"] },
  { name: "Pinterest", departments: MARKETING, words: ["PINTEREST"] },
  { name: "Reddit", departments: MARKETING, words: ["REDDIT"] },
  { name: "Canva", departments: MARKETING, words: ["CANVA"] },
  { name: "Buffer", departments: MARKETING, words: ["BUFFER"] },
  { name: "Hootsuite", departments: MARKETING, words: ["HOOTSUITE"] },
  { name: "Semrush", departments: MARKETING, words: ["SEMRUSH"] },
  { name: "Ahrefs", departments: MARKETING, words: ["AHREFS"] },
  { name: "Webflow", departments: MARKETING, words: ["WEBFLOW"] },
  { name: "WordPress", departments: MARKETING, words: ["WORDPRESS", "WP"] },
  { name: "Framer", departments: MARKETING, words: ["FRAMER"] },
  { name: "Bitly", departments: MARKETING, words: ["BITLY"] },
  { name: "PostHog", departments: MARKETING, words: ["POSTHOG"], prefixes: ["phc_", "phx_"], usualName: "POSTHOG_API_KEY" },
  { name: "Mixpanel", departments: MARKETING, words: ["MIXPANEL"] },
  { name: "Segment", departments: MARKETING, words: ["SEGMENT_WRITE", "SEGMENT_IO", "SEGMENTIO"] },
  { name: "Amplitude", departments: MARKETING, words: ["AMPLITUDE"] },
  { name: "Hotjar", departments: MARKETING, words: ["HOTJAR"] },
  { name: "ElevenLabs", departments: MARKETING, words: ["ELEVENLABS", "ELEVEN_LABS"] },
  { name: "HeyGen", departments: MARKETING, words: ["HEYGEN"] },
  { name: "Higgsfield", departments: MARKETING, words: ["HIGGSFIELD"] },
  // Client success: help desks, reviews
  { name: "Zendesk", departments: SUPPORT, words: ["ZENDESK"] },
  { name: "Intercom", departments: SUPPORT, words: ["INTERCOM"] },
  { name: "Freshdesk", departments: SUPPORT, words: ["FRESHDESK"] },
  { name: "Help Scout", departments: SUPPORT, words: ["HELPSCOUT", "HELP_SCOUT"] },
  { name: "Gorgias", departments: SUPPORT, words: ["GORGIAS"] },
  { name: "Crisp", departments: SUPPORT, words: ["CRISP"] },
  { name: "Front", departments: SUPPORT, words: ["FRONTAPP", "FRONT_APP"] },
  { name: "Trustpilot", departments: ["client_success", "marketing"], words: ["TRUSTPILOT"] },
  // Finance: books, spend, payroll, payments, billing
  { name: "FreshBooks", departments: FINANCE, words: ["FRESHBOOKS"] },
  { name: "Wave", departments: FINANCE, words: ["WAVEAPPS"] },
  { name: "BILL", departments: FINANCE, words: ["BILL_COM", "BILLCOM"] },
  { name: "Brex", departments: FINANCE, words: ["BREX"] },
  { name: "Ramp", departments: FINANCE, words: ["RAMP"] },
  { name: "Mercury", departments: FINANCE, words: ["MERCURY"] },
  { name: "Chargebee", departments: FINANCE, words: ["CHARGEBEE"] },
  { name: "Paddle", departments: FINANCE, words: ["PADDLE"] },
  { name: "Lemon Squeezy", departments: FINANCE, words: ["LEMONSQUEEZY", "LEMON_SQUEEZY"] },
  { name: "Gusto", departments: PAYROLL, words: ["GUSTO"] },
  { name: "Deel", departments: PAYROLL, words: ["DEEL"] },
  { name: "Rippling", departments: PAYROLL, words: ["RIPPLING"] },
  { name: "PayPal", departments: PAYMENTS, words: ["PAYPAL"] },
  { name: "Square", departments: PAYMENTS, words: ["SQUARE"] },
  // Operations: work tracking, automations, hosting, code, files
  { name: "Notion", departments: OPERATIONS, words: ["NOTION"], prefixes: ["ntn_"], usualName: "NOTION_API_KEY" },
  { name: "Airtable", departments: OPERATIONS, words: ["AIRTABLE"] },
  { name: "Asana", departments: OPERATIONS, words: ["ASANA"] },
  { name: "ClickUp", departments: OPERATIONS, words: ["CLICKUP"] },
  { name: "monday.com", departments: OPERATIONS, words: ["MONDAY"] },
  { name: "Trello", departments: OPERATIONS, words: ["TRELLO"] },
  { name: "Jira", departments: OPERATIONS, words: ["JIRA", "ATLASSIAN", "CONFLUENCE"] },
  { name: "Linear", departments: OPERATIONS, words: ["LINEAR"], prefixes: ["lin_api_"], usualName: "LINEAR_API_KEY" },
  { name: "Zapier", departments: OPERATIONS, words: ["ZAPIER"], prefixes: ["https://hooks.zapier.com/"], usualName: "ZAPIER_WEBHOOK_URL" },
  {
    name: "Make",
    departments: OPERATIONS,
    words: ["MAKE", "INTEGROMAT"],
    prefixes: ["https://hook.us1.make.com/", "https://hook.us2.make.com/", "https://hook.eu1.make.com/", "https://hook.eu2.make.com/"],
    usualName: "MAKE_WEBHOOK_URL",
  },
  { name: "n8n", departments: OPERATIONS, words: ["N8N"] },
  { name: "AWS", departments: OPERATIONS, words: ["AWS"], prefixes: ["AKIA"], usualName: "AWS_ACCESS_KEY_ID" },
  { name: "Google Cloud", departments: OPERATIONS, words: ["GCP", "GOOGLE_CLOUD"] },
  { name: "Azure", departments: OPERATIONS, words: ["AZURE"] },
  { name: "Vercel", departments: OPERATIONS, words: ["VERCEL"] },
  { name: "Netlify", departments: OPERATIONS, words: ["NETLIFY"] },
  { name: "Supabase", departments: OPERATIONS, words: ["SUPABASE"], prefixes: ["sbp_"], usualName: "SUPABASE_ACCESS_TOKEN" },
  { name: "Turso", departments: OPERATIONS, words: ["TURSO", "LIBSQL"] },
  { name: "Railway", departments: OPERATIONS, words: ["RAILWAY"] },
  { name: "Render", departments: OPERATIONS, words: ["RENDER_COM"] },
  { name: "DigitalOcean", departments: OPERATIONS, words: ["DIGITALOCEAN"], prefixes: ["dop_v1_"], usualName: "DIGITALOCEAN_TOKEN" },
  { name: "Docker", departments: OPERATIONS, words: ["DOCKER", "DOCKERHUB"] },
  { name: "Sentry", departments: OPERATIONS, words: ["SENTRY"], prefixes: ["sntrys_"], usualName: "SENTRY_AUTH_TOKEN" },
  { name: "Datadog", departments: OPERATIONS, words: ["DATADOG"] },
  { name: "GitLab", departments: OPERATIONS, words: ["GITLAB"], prefixes: ["glpat-"], usualName: "GITLAB_TOKEN" },
  { name: "Bitbucket", departments: OPERATIONS, words: ["BITBUCKET"] },
  { name: "Dropbox", departments: OPERATIONS, words: ["DROPBOX"] },
  { name: "Google Drive", departments: OPERATIONS, words: ["GOOGLE_DRIVE", "GDRIVE"] },
  { name: "OneDrive", departments: OPERATIONS, words: ["ONEDRIVE"] },
];

/** Every app a key can be recognised as: the cards first, then the rest. */
export const KNOWN_APPS: readonly KnownApp[] = [
  ...CONNECTOR_CATALOG.flatMap((def): KnownApp[] => {
    const w = CARD_WORDS[def.slug];
    return w ? [{ ...w, name: def.name, departments: def.departments, card: def.slug }] : [];
  }),
  ...OTHER_APPS,
];

/** What a key is for, as the vault shows it. */
export type KeyHint = {
  /** "HubSpot". */
  app: string;
  /** The agents it is suggested for. */
  access: AgentAccess;
  /** The app's card on Settings > Connections, when it has one. */
  card?: string;
  /** Recognised from the key's name, or from its value's start. */
  from: "name" | "value";
  /** What a key like it is usually called (offered when the name is empty). */
  usualName?: string;
};

function hintFor(app: KnownApp, from: KeyHint["from"]): KeyHint {
  const d = app.departments;
  // The same rule as a card's suggestion: its departments plus the Chief of Staff.
  const access: AgentAccess = d === "all" ? "all" : connectorDefaultAccess({ departments: d });
  return { app: app.name, access, from, ...(app.card ? { card: app.card } : {}), ...(app.usualName ? { usualName: app.usualName } : {}) };
}

/** Where `words` (a name's words) first holds `phrase` (one or more words) in a row, or -1. */
function positionOf(words: readonly string[], phrase: readonly string[]): number {
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phrase.every((p, j) => words[i + j] === p)) return i;
  }
  return -1;
}

/** The app whose well-known value start `value` has (the longest prefix wins), or null. */
function appByValue(value: string): KnownApp | null {
  const v = value.trim();
  let best: { app: KnownApp; length: number } | null = null;
  for (const app of KNOWN_APPS) {
    for (const p of app.prefixes ?? []) {
      if (v.startsWith(p) && v.length > p.length && (!best || p.length > best.length)) best = { app, length: p.length };
    }
  }
  return best?.app ?? null;
}

/**
 * What a key is for: its name first, then its value's start. In the name the
 * longest phrase wins (GOOGLE_ADS beats any one-word match); at equal length
 * the one that comes first in the name wins (LINEAR_TEAMS_ID is Linear's),
 * then the first app listed, cards first. In the value the longest prefix wins
 * ("sk-ant-" is Anthropic's). Null when neither says.
 */
export function recognizeCustomKey(name: string, value = ""): KeyHint | null {
  const words = normalizeVaultKeyName(name).split("_").filter(Boolean);
  let best: { app: KnownApp; length: number; at: number } | null = null;
  for (const app of KNOWN_APPS) {
    for (const w of app.words) {
      const phrase = w.split("_");
      const at = positionOf(words, phrase);
      if (at < 0) continue;
      if (!best || phrase.length > best.length || (phrase.length === best.length && at < best.at)) best = { app, length: phrase.length, at };
    }
  }
  if (best) return hintFor(best.app, "name");
  const byValue = appByValue(value);
  return byValue ? hintFor(byValue, "value") : null;
}

/**
 * Does this read as a secret rather than a name? A known key's start
 * ("sk-ant-..."), or one long unbroken run of letters and digits (a token,
 * base64). Pasted into the name box, or a bare secret in a paste whose "="
 * padding looked like KEY=value, it would otherwise be saved as a key's name,
 * which is stored and listed in the clear.
 */
export function looksLikeSecret(raw: string): boolean {
  const t = raw.trim();
  // Words joined by _ - or . are a name, even one that starts like a key: hf_token,
  // xai-api-key and AKIA_PROD_KEY were refused before (final review of OCC #748).
  if (!t || /\s/.test(t) || readsAsWords(t)) return false;
  // A known key's start with a key's worth after it.
  const prefixed = KNOWN_APPS.some((app) => (app.prefixes ?? []).some((p) => t.startsWith(p) && t.length - p.length >= 16));
  if (prefixed) return true;
  if (!/\d/.test(t)) return false;
  if (t.length >= 32 && /^[A-Za-z0-9+/=._-]+$/.test(t)) return true;
  const digits = (t.match(/\d/g) || []).length;
  return t.length >= 24 && digits >= 2 && /^[A-Za-z0-9+/=]+$/.test(t) && /[a-z]/.test(t) && /[A-Z]/.test(t);
}

/**
 * Does it read as words joined by _ - or . (a name), rather than one random run
 * (a token)? At least two parts are plain words, and the words are at least
 * half of its letters and digits. A UUID has one word-like part at most.
 */
function readsAsWords(t: string): boolean {
  const parts = t.split(/[_.-]+/).filter(Boolean);
  const words = parts.filter((s) => /^[A-Za-z]{2,}$/.test(s));
  return words.length >= 2 && words.join("").length * 2 >= parts.join("").length;
}

/**
 * A warning for a value that can move money: a full Stripe secret key (sk_).
 * Stripe's card connects with a read-only restricted key (rk_), and a key saved
 * here goes to whichever agents it is assigned, so the vault suggests no agents
 * for it: the owner picks, knowing.
 */
export function valueCaution(value: string): string | null {
  const v = value.trim();
  return /^sk_(live|test)_./.test(v)
    ? "This is a full Stripe secret key: it can move money, and so can any agent given it. Stripe's own card connects with a read-only restricted key (rk_live_...)."
    : null;
}

/** Where a picker choice was made: for which name, and whether that name was a saved key. */
export type DraftScope = { key: string; saved: boolean };

/**
 * Does a picker choice still apply once the name has changed? One made for a
 * saved key is for that key alone: typing another name must not carry it to a
 * different saved key (review of OCC #748). One made for a new key, or before
 * any name, carries to any new name, so an owner can pick first and type after.
 */
export function draftApplies(scope: DraftScope | null, keyName: string, saved: boolean): boolean {
  if (!scope) return false;
  return scope.saved ? scope.key === keyName : !saved;
}

/**
 * What a save sends about agents. The owner's choice goes as `agents` and is
 * saved as it is. Untouched, the app's suggestion goes as `suggested_agents`,
 * which the route applies only to a key with no saved value and no saved
 * choice at the moment it writes (review of OCC #748): the browser's list can
 * be stale, so the browser never decides that a key is new. With neither,
 * nothing is sent: a saved key keeps its agents, a new one is for all agents.
 */
export function agentsToSend(input: { touched: boolean; draft: AgentAccess; hint: KeyHint | null }): {
  agents?: AgentAccess;
  suggested_agents?: AgentAccess;
} {
  if (input.touched) return { agents: input.draft };
  return input.hint ? { suggested_agents: input.hint.access } : {};
}

/**
 * Why a pasted line's name cannot be saved, or null. Stricter than the name
 * box: a paste is saved as written (letters, numbers, underscores), never
 * reshaped, so a secret's fragment cannot become a name.
 */
export function pastedNameProblem(rawKey: string, value: string): string | null {
  if (looksLikeSecret(rawKey) || /^=+$/.test(value.trim())) return "This looks like a secret without a name. Write it as NAME=secret.";
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(rawKey.trim())) return "Use letters, numbers and underscores, starting with a letter.";
  return rawKey.trim().length > 64 ? "64 characters at most." : null;
}

/**
 * The Custom keys card's line on Settings > Connections: how many keys, and
 * whom they are assigned to ("3 keys, assigned to Bravo and SDR; 1 for all
 * agents"). Each part is said, so an open key does not hide the narrow ones and
 * a key whose agents cannot be read is counted as such (final review of OCC
 * #748). Where the workspace's agents cannot use custom keys, or the choices
 * could not be read, it says only that.
 */
export function customKeysLine(
  entries: ReadonlyArray<{ agents: AgentAccess | null }>,
  choices?: ReadonlyArray<AgentChoice>,
  opts: { assignable?: boolean; agentsUnreadable?: boolean } = {},
): string {
  if (entries.length === 0) return "No keys yet";
  const count = `${entries.length} key${entries.length === 1 ? "" : "s"}`;
  if (opts.assignable === false) return count;
  if (opts.agentsUnreadable) return `${count}; whom they are assigned to can't be read right now`;
  const forAll = entries.filter((e) => e.agents === "all").length;
  const unreadable = entries.filter((e) => e.agents === null).length;
  const departments = orderedDepartments(entries.flatMap((e) => (e.agents && e.agents !== "all" ? e.agents : [])));
  const parts: string[] = [];
  if (departments.length > 0) parts.push(`assigned to ${agentNamesSentence(departments, choices)}`);
  if (forAll > 0) parts.push(forAll === entries.length ? "each for all agents" : `${forAll} for all agents`);
  // A key for no agent is the narrowest of all: it is said too, not hidden by the others (CodeRabbit, #750).
  const none = entries.filter((e) => Array.isArray(e.agents) && e.agents.length === 0).length;
  if (none > 0) parts.push(none === entries.length ? "assigned to no agents" : `${none} for no agents`);
  if (unreadable > 0) parts.push(`${unreadable} can't be read`);
  return `${count}, ${parts.join("; ")}`;
}

/**
 * What the picker shows before the owner touches it: a saved key's agents
 * (no agents when they cannot be read, which is what is enforced), a new
 * key's suggestion, or all agents.
 */
export function agentsShown(input: { saved: boolean; existing: AgentAccess | null | undefined; hint: KeyHint | null }): AgentAccess {
  if (input.saved) return input.existing ?? [];
  return input.hint ? input.hint.access : "all";
}

/**
 * The one website a custom key may be sent to (CC, 2026-10-27: client
 * workspaces' agents get their custom keys). An agent never sees a key's
 * value through use_custom_key (lib/cloud-tool-runner.ts): the server attaches
 * it to a GET request, and only to this host, so a key cannot be sent anywhere
 * the owner did not name, whatever a web page tells the agent.
 *
 * A host name, or a URL to take it from: "api.example.com" and
 * "https://api.example.com/crm/v3" are both api.example.com. Refused: an IP
 * address, a name without a dot, a local or internal name, a port, and
 * anything that is not a plain public host name.
 */
export type KeyHostProblem = "empty" | "not_a_host" | "ip_address" | "local_name" | "has_port" | "too_long";

const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const LOCAL_SUFFIXES = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "test", "invalid", "example"];

/** The host a key may be sent to, or why `raw` is not one. */
export function keyHost(raw: string): { ok: true; host: string } | { ok: false; problem: KeyHostProblem } {
  let text = (raw ?? "").trim().toLowerCase();
  if (!text) return { ok: false, problem: "empty" };
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return { ok: false, problem: "not_a_host" };
    }
    if (url.protocol !== "https:" || url.username || url.password) return { ok: false, problem: "not_a_host" };
    if (url.port) return { ok: false, problem: "has_port" };
    text = url.hostname;
  } else if (/[/?#@\s]/.test(text)) {
    return { ok: false, problem: "not_a_host" };
  }
  text = text.replace(/\.$/, "");
  if (/:\d*$/.test(text) && !text.includes("[")) return { ok: false, problem: "has_port" };
  if (text.startsWith("[") || /^[\d.]+$/.test(text) || text.includes(":")) return { ok: false, problem: "ip_address" };
  if (text.length > 253) return { ok: false, problem: "too_long" };
  const labels = text.split(".");
  if (labels.length < 2 || !labels.every((l) => HOST_LABEL.test(l))) return { ok: false, problem: "not_a_host" };
  if (/^\d+$/.test(labels[labels.length - 1])) return { ok: false, problem: "ip_address" };
  if (LOCAL_SUFFIXES.includes(labels[labels.length - 1])) return { ok: false, problem: "local_name" };
  return { ok: true, host: text };
}

/** keyHost's refusal, in the words the vault shows. */
export function keyHostProblemWords(problem: KeyHostProblem): string {
  switch (problem) {
    case "empty":
      return "Type the website this key is for, like api.example.com.";
    case "ip_address":
      return "Use the website's name, like api.example.com, not an IP address.";
    case "local_name":
      return "That name is for a private network. Agents can only send a key to a public website.";
    case "has_port":
      return "Leave out the port: type just the website, like api.example.com.";
    case "too_long":
      return "That website name is too long.";
    default:
      return "That doesn't look like a website. Type its name, like api.example.com, or paste an https:// link to it.";
  }
}
