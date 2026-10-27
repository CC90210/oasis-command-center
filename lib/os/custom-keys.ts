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
  stripe: { words: ["STRIPE"], prefixes: ["sk_live_", "sk_test_", "rk_live_", "rk_test_", "whsec_"], usualName: "STRIPE_SECRET_KEY" },
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
  "microsoft-teams": { words: ["TEAMS", "MSTEAMS", "MICROSOFT_TEAMS"] },
  meta: { words: ["META", "FACEBOOK", "FB", "INSTAGRAM", "IG"], prefixes: ["EAA"], usualName: "META_ACCESS_TOKEN" },
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
  { name: "OpenAI", departments: "all", words: ["OPENAI"], prefixes: ["sk-proj-", "sk-svcacct-", "sk-"], usualName: "OPENAI_API_KEY" },
  { name: "Anthropic", departments: "all", words: ["ANTHROPIC", "CLAUDE"], prefixes: ["sk-ant-"], usualName: "ANTHROPIC_API_KEY" },
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
  { name: "Apollo", departments: SALES, words: ["APOLLO"] },
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
  { name: "Segment", departments: MARKETING, words: ["SEGMENT"] },
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
  { name: "AWS", departments: OPERATIONS, words: ["AWS", "AMAZON"], prefixes: ["AKIA"], usualName: "AWS_ACCESS_KEY_ID" },
  { name: "Google Cloud", departments: OPERATIONS, words: ["GCP", "GOOGLE_CLOUD"] },
  { name: "Azure", departments: OPERATIONS, words: ["AZURE"] },
  { name: "Vercel", departments: OPERATIONS, words: ["VERCEL"] },
  { name: "Netlify", departments: OPERATIONS, words: ["NETLIFY"] },
  { name: "Supabase", departments: OPERATIONS, words: ["SUPABASE"], prefixes: ["sbp_"], usualName: "SUPABASE_ACCESS_TOKEN" },
  { name: "Turso", departments: OPERATIONS, words: ["TURSO", "LIBSQL"] },
  { name: "Railway", departments: OPERATIONS, words: ["RAILWAY"] },
  { name: "Render", departments: OPERATIONS, words: ["RENDER"] },
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

/** Does `words` (a name's words) hold `phrase` (one or more words) in a row? */
function holds(words: readonly string[], phrase: readonly string[]): boolean {
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phrase.every((p, j) => words[i + j] === p)) return true;
  }
  return false;
}

/**
 * What a key is for: its name first (the longest matching phrase wins, so a
 * two-word phrase like GOOGLE_ADS beats any one-word match; at equal length
 * the first app listed wins, cards first), then its value's start
 * (the longest prefix wins, so "sk-ant-" is Anthropic before "sk-" is OpenAI).
 * Null when neither says.
 */
export function recognizeCustomKey(name: string, value = ""): KeyHint | null {
  const words = normalizeVaultKeyName(name).split("_").filter(Boolean);
  let best: { app: KnownApp; length: number } | null = null;
  if (words.length > 0) {
    for (const app of KNOWN_APPS) {
      for (const w of app.words) {
        const phrase = w.split("_");
        if (holds(words, phrase) && (!best || phrase.length > best.length)) best = { app, length: phrase.length };
      }
    }
  }
  if (best) return hintFor(best.app, "name");
  const v = value.trim();
  if (!v) return null;
  let byValue: { app: KnownApp; length: number } | null = null;
  for (const app of KNOWN_APPS) {
    for (const p of app.prefixes ?? []) {
      if (v.startsWith(p) && v.length > p.length && (!byValue || p.length > byValue.length)) byValue = { app, length: p.length };
    }
  }
  return byValue ? hintFor(byValue.app, "value") : null;
}

/**
 * The agents a save sends for a key. A choice the owner made is sent. A new
 * value for a key already saved sends none, so the key keeps its agents. A new
 * key takes its suggestion, and with none it is for all agents (nothing sent).
 */
export function agentsToSend(input: { exists: boolean; touched: boolean; draft: AgentAccess; hint: KeyHint | null }): AgentAccess | undefined {
  if (input.touched) return input.draft;
  if (input.exists) return undefined;
  return input.hint ? input.hint.access : undefined;
}

/**
 * The Custom keys card's line on Settings > Connections: how many keys, and
 * who uses them ("3 keys, used by SDR, Maven and Bravo"). One key open to all
 * agents makes it all agents. A key whose agents cannot be read adds no one.
 */
export function customKeysLine(entries: ReadonlyArray<{ agents: AgentAccess | null }>, choices?: ReadonlyArray<AgentChoice>): string {
  if (entries.length === 0) return "No keys yet";
  const count = `${entries.length} key${entries.length === 1 ? "" : "s"}`;
  if (entries.some((e) => e.agents === "all")) return `${count}, used by all agents`;
  const departments = orderedDepartments(entries.flatMap((e) => (e.agents && e.agents !== "all" ? e.agents : [])));
  return departments.length === 0 ? `${count}, used by no agents` : `${count}, used by ${agentNamesSentence(departments, choices)}`;
}

/** What the picker shows before the owner touches it: the key's agents, its suggestion, or all agents. */
export function agentsShown(input: { existing: AgentAccess | null | undefined; unreadable?: boolean; hint: KeyHint | null }): AgentAccess {
  if (input.unreadable) return [];
  if (input.existing !== undefined && input.existing !== null) return input.existing;
  return input.hint ? input.hint.access : "all";
}
