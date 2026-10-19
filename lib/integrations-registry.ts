/**
 * Canonical list of integrations the OASIS Command Center cares about.
 *
 * Each row carries:
 *   - connection_kind: HOW the user connects this thing
 *       api_key       — paste a key, we encrypt + store it
 *       oauth         — sign in with the provider, we get tokens
 *       local_install — installed on the operator's machine, the local
 *                       bridge daemon pings to confirm presence
 *       built_in      — bundled as a skill in the cloned repo (no setup)
 *       account_only  — needs a logged-in account but no key (Skool, etc.)
 *   - signup_url + api_key_url for the kinds that need them
 *   - setup_complexity: trivial | simple | moderate | advanced
 *
 * The agents' bridge reads this list from /api/integrations/registry and writes
 * tenant-scoped integrations_health checks. Connections is the only UI that
 * presents those checks (2026-10-18); this registry is not a second catalog.
 */

export type IntegrationCategory =
  | "core"
  | "comms"
  | "finance"
  | "content"
  | "social"
  | "data"
  | "ai"
  | "infra";

export type SetupComplexity = "trivial" | "simple" | "moderate" | "advanced";
export type ConnectionKind =
  | "api_key"
  | "oauth"
  | "local_install"
  | "built_in"
  | "account_only";

export type IntegrationDef = {
  service: string;
  label: string;
  category: IntegrationCategory;
  description: string;
  connection_kind: ConnectionKind;
  signup_url?: string;
  api_key_url?: string;
  setup_doc_url?: string;
  setup_complexity: SetupComplexity;
  /** Which agent(s) actually use this integration. */
  used_by?: ("bravo" | "atlas" | "maven" | "aura" | "hermes" | "solara" | "helios")[];
  /** For api_key kind: which env var the key-paste modal writes to in
   *  .env.agents. If omitted, modal won't appear and the user falls back
   *  to the manual signup_url + api_key_url affordance. */
  env_key?: string;
};

export const KNOWN_INTEGRATIONS: IntegrationDef[] = [
  // ── Core infra ─────────────────────────────────────────────────
  {
    service: "cloudflare",
    label: "Cloudflare",
    category: "core",
    description: "DNS, the edge, and the Workers that host the Command Center",
    connection_kind: "api_key",
    signup_url: "https://dash.cloudflare.com/sign-up",
    api_key_url: "https://dash.cloudflare.com/profile/api-tokens",
    setup_complexity: "moderate",
    env_key: "CLOUDFLARE_API_TOKEN",
  },
  {
    service: "hostinger",
    label: "Hostinger",
    category: "core",
    description: "VPS and GPU server host",
    connection_kind: "api_key",
    signup_url: "https://www.hostinger.com/",
    api_key_url: "https://hpanel.hostinger.com/profile/api",
    setup_complexity: "moderate",
    env_key: "HOSTINGER_API_KEY",
  },
  {
    service: "github",
    label: "GitHub",
    category: "core",
    description: "Source control; a merge to main deploys the Command Center",
    connection_kind: "api_key",
    signup_url: "https://github.com/signup",
    api_key_url: "https://github.com/settings/tokens",
    setup_complexity: "simple",
    used_by: ["bravo"],
    env_key: "GITHUB_TOKEN",
  },

  // ── Comms ──────────────────────────────────────────────────────
  {
    // Single Google Workspace entry — Gmail + Calendar + Drive + Docs +
    // Meet all run through `python scripts/google_tool.py` using one
    // App Password (GMAIL_APP_PASSWORD). The dashboard previously had
    // separate google_drive/google_calendar/google_docs OAuth rows
    // which were misleading: there's no per-service OAuth, just one
    // App Password granting full Workspace access via the CLI tool.
    service: "gws",
    label: "Google Workspace",
    category: "comms",
    // What OASIS checks and uses (2026-10-08): the shared mailbox's Gmail
    // sign-in. Nothing in OASIS uses Drive or Docs through it, and an App
    // Password cannot reach those APIs, so the card claims neither (PR #558).
    description: "Shared Gmail mailbox (App Password)",
    connection_kind: "api_key",
    signup_url: "https://workspace.google.com/signup",
    api_key_url: "https://myaccount.google.com/apppasswords",
    setup_doc_url: "https://support.google.com/mail/answer/185833",
    setup_complexity: "simple",
    used_by: ["bravo", "maven", "aura"],
    env_key: "GMAIL_APP_PASSWORD",
  },
  {
    service: "telegram",
    label: "Telegram Bridge",
    category: "comms",
    description: "Mobile notifications via BotFather",
    connection_kind: "api_key",
    signup_url: "https://telegram.org/",
    api_key_url: "https://t.me/BotFather",
    setup_doc_url: "https://core.telegram.org/bots/tutorial",
    setup_complexity: "simple",
    used_by: ["bravo"],
    env_key: "TELEGRAM_BOT_TOKEN",
  },
  {
    service: "twilio",
    label: "Twilio",
    category: "comms",
    description: "Personalized 1:1 SMS from the workspace's Twilio account",
    connection_kind: "api_key",
    signup_url: "https://www.twilio.com/try-twilio",
    api_key_url: "https://console.twilio.com/",
    setup_doc_url: "https://www.twilio.com/docs/usage/api",
    setup_complexity: "simple",
    used_by: ["helios", "solara"],
    env_key: "TWILIO_ACCOUNT_SID",
  },

  // ── Finance ────────────────────────────────────────────────────
  {
    service: "stripe",
    label: "Stripe",
    category: "finance",
    description: "Payments, invoices, subscriptions",
    connection_kind: "api_key",
    signup_url: "https://dashboard.stripe.com/register",
    api_key_url: "https://dashboard.stripe.com/apikeys",
    setup_doc_url: "https://stripe.com/docs/keys",
    setup_complexity: "simple",
    used_by: ["bravo", "atlas"],
    env_key: "STRIPE_API_KEY",
  },
  {
    // Atlas's CCXT-based trade engine reads EXCHANGE_API_KEY +
    // EXCHANGE_SECRET (set in CFO-Agent/.env). Kraken is the default
    // exchange — DEFAULT_EXCHANGE=kraken in Atlas's env. Mapping the
    // env_key here lets the dashboard light up green when CC has
    // configured CCXT regardless of which exchange they pointed it at.
    service: "kraken",
    label: "Kraken (CCXT)",
    category: "finance",
    description: "Crypto trading via CCXT — Atlas trade engine (configures any CCXT-supported exchange)",
    connection_kind: "api_key",
    signup_url: "https://www.kraken.com/sign-up",
    api_key_url: "https://www.kraken.com/u/security/api",
    setup_doc_url: "https://docs.kraken.com/api/",
    setup_complexity: "moderate",
    used_by: ["atlas"],
    env_key: "EXCHANGE_API_KEY",
  },
  {
    service: "wise",
    label: "Wise",
    category: "finance",
    description: "Multi-currency banking + transfers",
    connection_kind: "api_key",
    signup_url: "https://wise.com/register",
    api_key_url: "https://wise.com/your-account/integrations-and-tools/api-tokens",
    setup_doc_url: "https://docs.wise.com/api-docs",
    setup_complexity: "moderate",
    used_by: ["atlas"],
    env_key: "WISE_API_TOKEN",
  },
  {
    // IBKR uses TWS desktop with a local socket — no API key paste flow.
    // Connection kind reflects the actual mechanism so the dashboard
    // doesn't ask for a key that doesn't exist.
    service: "interactive_brokers",
    label: "Interactive Brokers",
    category: "finance",
    description: "Equities + options via TWS desktop (local socket — no API key)",
    connection_kind: "local_install",
    signup_url: "https://www.interactivebrokers.com/en/index.php?f=46385",
    setup_doc_url: "https://interactivebrokers.github.io/tws-api/introduction.html",
    setup_complexity: "advanced",
    used_by: ["atlas"],
  },
  {
    // Forex broker — Atlas reads OANDA_TOKEN.
    service: "oanda",
    label: "OANDA",
    category: "finance",
    description: "Forex broker — Atlas FX strategies",
    connection_kind: "api_key",
    signup_url: "https://www.oanda.com/forex-trading/",
    api_key_url: "https://www.oanda.com/account/tpa/personal_token",
    setup_complexity: "moderate",
    used_by: ["atlas"],
    env_key: "OANDA_TOKEN",
  },
  {
    // Atlas market-data feeds. None of these are required for trading;
    // they power research signals + reports. Each lights up only when
    // the matching key is present.
    service: "alpha_vantage",
    label: "Alpha Vantage",
    category: "finance",
    description: "Equity + FX market data",
    connection_kind: "api_key",
    signup_url: "https://www.alphavantage.co/support/#api-key",
    api_key_url: "https://www.alphavantage.co/support/#api-key",
    setup_complexity: "trivial",
    used_by: ["atlas"],
    env_key: "ALPHA_VANTAGE_KEY",
  },
  {
    service: "finnhub",
    label: "Finnhub",
    category: "finance",
    description: "Real-time quotes + earnings + news",
    connection_kind: "api_key",
    signup_url: "https://finnhub.io/register",
    api_key_url: "https://finnhub.io/dashboard",
    setup_complexity: "trivial",
    used_by: ["atlas"],
    env_key: "FINNHUB_KEY",
  },
  {
    service: "fmp",
    label: "Financial Modeling Prep",
    category: "finance",
    description: "Fundamentals + ratios + macro",
    connection_kind: "api_key",
    signup_url: "https://site.financialmodelingprep.com/developer",
    api_key_url: "https://site.financialmodelingprep.com/developer/docs/dashboard",
    setup_complexity: "trivial",
    used_by: ["atlas"],
    env_key: "FMP_KEY",
  },
  {
    service: "newsapi",
    label: "NewsAPI",
    category: "finance",
    description: "News headlines for sentiment + signals",
    connection_kind: "api_key",
    signup_url: "https://newsapi.org/register",
    api_key_url: "https://newsapi.org/account",
    setup_complexity: "trivial",
    used_by: ["atlas"],
    env_key: "NEWSAPI_KEY",
  },

  // ── Content / video ────────────────────────────────────────────
  {
    // SINGLE social connector — one Zernio (Late) key handles LinkedIn,
    // Instagram, TikTok, YouTube, X/Twitter, Facebook, Threads. The
    // dashboard previously listed each platform as its own row with
    // "auth via Zernio" but that was misleading: there is no per-
    // platform setup step beyond pasting this one key. Operators who
    // care about specific platforms toggle them inside Zernio's UI.
    service: "late",
    label: "Zernio (Late)",
    category: "social",
    description:
      "All-in-one social scheduler — one key publishes to LinkedIn, Instagram, TikTok, YouTube, X/Twitter, Facebook, Threads, Pinterest. Set platform-specific OAuth inside Zernio.",
    connection_kind: "api_key",
    signup_url: "https://zernio.com/signup",
    api_key_url: "https://zernio.com/dashboard/api",
    setup_complexity: "simple",
    used_by: ["maven"],
    env_key: "LATE_API_KEY",
  },
  {
    service: "elevenlabs",
    label: "ElevenLabs",
    category: "content",
    description: "Voiceover generation",
    connection_kind: "api_key",
    signup_url: "https://elevenlabs.io/sign-up",
    api_key_url: "https://elevenlabs.io/app/settings/api-keys",
    setup_complexity: "trivial",
    used_by: ["maven"],
    env_key: "ELEVENLABS_API_KEY",
  },

  // (Per-platform social rows — LinkedIn, Instagram, TikTok, YouTube,
  // X/Twitter — were collapsed into the single Zernio entry above.
  // Per-platform OAuth happens inside Zernio's UI, not here. Reduces
  // 5 cards to 1 and matches the actual setup flow.)

  // ── Data / automation ──────────────────────────────────────────
  // JotForm entry removed 2026-06-06 — SunBiz uses the dashboard's
  // native /forms designer + /f/<tenant>/<form>/<lead_token> public flow
  // for intake (lib/forms-render/). No third-party form vendor.
  {
    service: "turso",
    // Renamed from "Local Brain" 2026-05-15 — the prior label was internal
    // jargon. Turso is the per-tenant database, provisioned by Bravo when
    // the tenant is created; SunBiz / SUGA / future-client operators don't
    // configure it themselves.
    label: "Tenant Database (Turso)",
    category: "data",
    description: "Per-tenant SQLite-compatible database. Provisioned by Bravo.",
    connection_kind: "api_key",
    signup_url: "https://app.turso.tech/",
    api_key_url: "https://app.turso.tech/account/tokens",
    setup_complexity: "simple",
    env_key: "TURSO_AUTH_TOKEN",
  },
  {
    service: "firecrawl",
    label: "Firecrawl",
    category: "data",
    description: "Web scrape + structured extraction",
    connection_kind: "api_key",
    signup_url: "https://www.firecrawl.dev/signup",
    api_key_url: "https://www.firecrawl.dev/app/api-keys",
    setup_complexity: "trivial",
    used_by: ["bravo", "maven"],
    env_key: "FIRECRAWL_API_KEY",
  },

  // ── AI providers ───────────────────────────────────────────────
  {
    service: "openrouter",
    label: "OpenRouter",
    category: "ai",
    description: "★ One key, every model — recommended for chat",
    connection_kind: "api_key",
    signup_url: "https://openrouter.ai/sign-up",
    api_key_url: "https://openrouter.ai/keys",
    setup_doc_url: "https://openrouter.ai/docs/quick-start",
    setup_complexity: "trivial",
    used_by: ["bravo", "atlas", "maven", "aura", "hermes"],
    env_key: "OPENROUTER_API_KEY",
  },
  {
    service: "anthropic",
    label: "Anthropic Claude",
    category: "ai",
    description: "Direct Claude API — Opus / Sonnet / Haiku",
    connection_kind: "api_key",
    signup_url: "https://console.anthropic.com/signup",
    api_key_url: "https://console.anthropic.com/settings/keys",
    setup_doc_url: "https://docs.anthropic.com/en/api/getting-started",
    setup_complexity: "trivial",
    env_key: "ANTHROPIC_API_KEY",
    used_by: ["bravo"],
  },
  {
    service: "google_ai",
    label: "Google Gemini",
    category: "ai",
    // No version numbers: Google stopped offering Gemini 2.5 to new accounts
    // on 2026-09-18, and the models offered live in lib/ai/model-registry.ts.
    description: "Direct Gemini API: Flash / Flash-Lite / Pro, key from AI Studio",
    connection_kind: "api_key",
    signup_url: "https://aistudio.google.com/",
    api_key_url: "https://aistudio.google.com/apikey",
    setup_complexity: "trivial",
    used_by: ["bravo"],
    env_key: "GEMINI_API_KEY",
  },

  // (Google Drive / Calendar / Docs were previously listed as separate
  // OAuth integrations. Reality: they're all accessed through ONE App
  // Password via scripts/google_tool.py — there's no per-service auth.
  // Collapsed into the single `gws` entry under "Comms" above.)
];
