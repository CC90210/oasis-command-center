/**
 * lib/os/connectors.ts — the Connections hub catalog (Settings › Connections).
 *
 * One declarative list of every app a client can see in the hub, with its real
 * logo, the departments that use it, and a plain-English account of what OASIS
 * reads and does with it. The hub renders from here; tests/os-connectors.test.ts
 * holds the contract.
 *
 * PURE AND CLIENT-SAFE. No server imports: the hub is a client component (search,
 * drawer), so this file ships to the browser. The facts a status is computed
 * from are loaded on the server (components/os/connections/connector-facts.ts)
 * and passed in; `resolveConnectorStatus` below is the only thing that turns
 * them into words.
 *
 * NEVER A FAKE GREEN. A connector is "connected" only when a real source proved
 * it: a fresh healthy heartbeat, or a passing connection test that actually
 * called the provider. A saved key that nothing checked is "set up", a failed
 * lookup is "status unavailable" (unknown is not disconnected), and an app with
 * no status source is "coming soon" whatever the facts say — the resolver
 * returns before it ever reads them.
 *
 * LOGOS. The SVGs in public/connectors/ are copied unmodified from Simple Icons
 * (simple-icons 16.33.0, CC0 — https://simpleicons.org). The marks themselves
 * remain their owners' trademarks and are shown as "works with" identification
 * only, never as an endorsement. Simple Icons removes brands on request (Slack,
 * Microsoft and Twilio are gone), and its "Fathom" is Fathom Analytics, not the
 * Fathom notetaker — every one of those renders a plain monogram tile instead of
 * an invented logo.
 */

import type { DepartmentKey } from "@/lib/os/types";
import {
  classifyWorkspaceConnection,
  isWorkspaceHeartbeatFresh,
} from "@/lib/integrations/workspace-connection-status";
import { isVerifiedHealthy } from "@/lib/connections/rules";
import { SLACK_APPROVAL_RULE } from "@/lib/slack/copy";
import { TWILIO_FAILURE_STATES } from "@/lib/twilio/shared";

// ── Catalog shape ──────────────────────────────────────────────────────────

export type ConnectorCategoryKey =
  | "money"
  | "calendar_email"
  | "meetings"
  | "messaging"
  | "ads_social"
  | "crm_import"
  | "ai_models";

/** Catalog groups, in the order the hub renders them. */
export const CONNECTOR_CATEGORIES: readonly { key: ConnectorCategoryKey; label: string }[] = [
  { key: "money", label: "Money" },
  { key: "calendar_email", label: "Calendar & email" },
  { key: "meetings", label: "Meetings" },
  { key: "messaging", label: "Messaging" },
  { key: "ads_social", label: "Ads & social" },
  { key: "crm_import", label: "CRM import" },
  { key: "ai_models", label: "AI models" },
];

export type ConnectorIcon =
  /** A Simple Icons SVG under public/connectors/. */
  | { kind: "svg"; file: string }
  /** No usable logo: a neutral tile with these letters, and why. */
  | { kind: "monogram"; letters: string; reason: string };

/**
 * Where a LIVE connector's status comes from. The only way to be "connected".
 *
 *   workspace_heartbeat  credential presence + the tenant's integrations_health
 *                        heartbeat, merged by classifyWorkspaceConnection — the
 *                        same rule the workspace summary has always used.
 *   tenant_keys          the shared key store's per-field presence and its last
 *                        connection test. `verifiable: false` means the "test"
 *                        for this service only checks presence, so it can never
 *                        prove a connection.
 *   oauth_tokens         OAuth tokens in the shared store. Authorised, but not
 *                        re-checked on page load (that would be a provider call
 *                        per render).
 *   tenant_connection    a Connections-framework connection (tenant_connections,
 *                        lib/connections/*): green only while its last LIVE
 *                        probe passed and is under a day old
 *                        (lib/connections/rules.ts isVerifiedHealthy).
 */
export type ConnectorStatusSource =
  | { kind: "tenant_connection"; provider: string }
  | { kind: "workspace_heartbeat"; service: "gws" | "telegram"; requireAll: readonly string[] }
  | {
      kind: "tenant_keys";
      service: string;
      requireAll: readonly string[];
      /** At least one of these must also be present (Twilio: a number OR a messaging service). */
      requireAny?: readonly string[];
      /** One of these field sets must be complete (Twilio: the Auth Token, OR an API key and its secret). */
      credentialAlternatives?: readonly (readonly string[])[];
      /**
       * The plain words for a failed test, keyed by the code the test stored
       * (Twilio: "needs_number" -> "Needs a number"). Set, the card reads only a
       * test that still describes the saved keys: a value saved after the test
       * clears its own result, and the card then says "not tested yet".
       */
      failureStates?: Readonly<Record<string, { kind: "attention" | "configured"; label: string; detail: string }>>;
      verifiable: boolean;
    }
  | { kind: "oauth_tokens"; service: string; requireAll: readonly string[] };

/** What clicking a live card does: open the flow that already exists. */
export type ConnectorConnect =
  | { kind: "link"; href: string; label: string }
  /** An OAuth start route opened in a popup that postMessages `{ source }` back. */
  | { kind: "popup"; href: string; label: string; messageSource: string }
  /**
   * A key pasted into the connector's drawer and posted to
   * /api/connections/[provider]/connect, which probes it live before saving.
   */
  | { kind: "key_form"; label: string; provider: string }
  /**
   * The app's fields in the shared key store (lib/tenant-integration-schemas.ts),
   * saved, tested and removed in the connector's drawer (ServiceKeysForm).
   */
  | { kind: "keys"; label: string; service: string };

export type ConnectorDef = {
  slug: string;
  name: string;
  /** One line under the name. */
  summary: string;
  category: ConnectorCategoryKey;
  departments: readonly DepartmentKey[];
  /** The brand's own colour (Simple Icons' hex), or null for a monogram. */
  brandColor: string | null;
  icon: ConnectorIcon;
  /** Sub-products shown in the drawer (Google: Gmail, Calendar, Drive, Meet). */
  includes?: readonly { name: string; file: string; color: string }[];
  /** What OASIS reads from it — plain English, no scopes or jargon. */
  reads: readonly string[];
  /** What OASIS does with it. */
  does: readonly string[];
  /** Extra search terms. */
  keywords?: readonly string[];
  /**
   * null = not built yet. The card says "Not built yet", and its drawer says
   * why (`pendingNote`) and files a request on OASIS's desk ("Ask OASIS for
   * it"): never a release date nobody set (S5-F01).
   */
  live: { source: ConnectorStatusSource; connect: ConnectorConnect } | null;
  /** Why it is not live (yet, or on this deployment), in plain English. Every not-built app has one. */
  pendingNote?: string;
  /**
   * A connection tied to each person's own login, shown in the drawer under
   * the workspace's (Google: your own Gmail and Calendar).
   */
  yourAccount?: "google";
  /** Where the rest of this app's setup lives, when it is not all here. */
  seeAlso?: { href: string; label: string };
  /** The provider's own setup documentation (opens in a new tab). */
  docs?: { href: string; label: string };
  /**
   * The ways a workspace connects this app, each for one kind of workspace
   * (Slack: OASIS's own workspace uses the OASIS app; a client workspace uses
   * its own app). A viewer is shown only its own (ConnectorStatus.paths), with
   * its state on this deployment; a path that is not built says so and offers
   * "Ask OASIS for it" in the drawer.
   */
  paths?: readonly ConnectorPath[];
};

export type ConnectorPath = {
  /** Whose workspace connects this way: OASIS's own, or a client's. */
  audience: "oasis" | "client";
  title: string;
  body: string;
  /** False: nothing is built for it yet. */
  built: boolean;
  /** It needs OASIS's own app on this deployment (Worker secrets), so appNotConfigured decides its state. */
  needsOasisApp: boolean;
};

/** Settings › Connections with this app's drawer open. */
export function connectorHref(slug: string): string {
  return `/settings/connections?app=${encodeURIComponent(slug)}`;
}

// ── The catalog ────────────────────────────────────────────────────────────

export const CONNECTOR_CATALOG: readonly ConnectorDef[] = [
  // Money
  {
    slug: "stripe",
    name: "Stripe",
    summary: "Payments and subscriptions",
    category: "money",
    departments: ["finance", "sales"],
    brandColor: "#635BFF",
    icon: { kind: "svg", file: "stripe.svg" },
    reads: [
      "Your balance, payments, refunds and payouts",
      "Customers, invoices and subscriptions",
    ],
    does: [
      "Re-checks the key with Stripe every hour, so this card shows within the hour if Stripe stops accepting it",
      "Will feed revenue and recurring income into Finance once the Finance sync exists; nothing flows from this key into Finance yet",
      "Never charges a card, issues a refund or moves money: the key it accepts is read-only",
    ],
    keywords: ["payments", "billing", "mrr", "invoices", "restricted key"],
    live: {
      source: { kind: "tenant_connection", provider: "stripe" },
      connect: { kind: "key_form", label: "Connect Stripe", provider: "stripe" },
    },
    docs: { href: "https://docs.stripe.com/keys", label: "Stripe's guide to API keys" },
  },
  {
    slug: "quickbooks",
    name: "QuickBooks",
    summary: "Accounting books",
    category: "money",
    departments: ["finance"],
    brandColor: "#2CA01C",
    icon: { kind: "svg", file: "quickbooks.svg" },
    reads: ["Your chart of accounts, invoices, bills and reports"],
    does: ["Mirrors your books so Finance matches what your accountant sees", "Read-only: nothing is posted to your books"],
    keywords: ["accounting", "intuit", "qbo", "bookkeeping"],
    live: null,
    pendingNote: "Nothing in OASIS connects to QuickBooks yet. Live books need an app that has passed Intuit's app assessment.",
  },
  {
    slug: "xero",
    name: "Xero",
    summary: "Accounting books",
    category: "money",
    departments: ["finance"],
    brandColor: "#13B5EA",
    icon: { kind: "svg", file: "xero.svg" },
    reads: ["Your chart of accounts, invoices, bills and reports"],
    does: ["Mirrors your books so Finance matches what your accountant sees", "Read-only: nothing is posted to your books"],
    keywords: ["accounting", "bookkeeping"],
    live: null,
    pendingNote: "Nothing in OASIS connects to Xero yet.",
  },
  {
    slug: "plaid",
    name: "Plaid",
    summary: "Bank accounts",
    category: "money",
    departments: ["finance"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Pl", reason: "Not in Simple Icons" },
    reads: ["Balances and transactions from the bank accounts you choose"],
    does: ["Shows cash on hand and runway in Finance", "Read-only: OASIS never moves money"],
    keywords: ["bank", "banking", "cash", "transactions"],
    live: null,
    pendingNote: "Nothing in OASIS connects to Plaid yet. Linking real bank accounts needs Plaid's production approval.",
  },

  // Calendar & email
  {
    slug: "google-workspace",
    name: "Google Workspace",
    summary: "Gmail, Calendar, Drive and Meet",
    category: "calendar_email",
    departments: ["chief_of_staff", "sales", "client_success"],
    brandColor: "#4285F4",
    icon: { kind: "svg", file: "google.svg" },
    includes: [
      { name: "Gmail", file: "gmail.svg", color: "#EA4335" },
      { name: "Google Calendar", file: "googlecalendar.svg", color: "#4285F4" },
      { name: "Google Drive", file: "googledrive.svg", color: "#4285F4" },
      { name: "Google Meet", file: "googlemeet.svg", color: "#00897B" },
    ],
    reads: ["Calendar events on the account you connect, so booked calls land in open slots"],
    does: ["Sends email from your own address", "Adds booked calls to your calendar"],
    keywords: ["gmail", "calendar", "email", "drive", "meet", "google"],
    live: {
      source: { kind: "workspace_heartbeat", service: "gws", requireAll: ["app_password", "from_address"] },
      connect: { kind: "keys", label: "Connect Google", service: "gws" },
    },
    yourAccount: "google",
    docs: { href: "https://support.google.com/accounts/answer/185833", label: "Google's guide to App Passwords" },
  },
  {
    slug: "calendly",
    name: "Calendly",
    summary: "Booking links",
    category: "calendar_email",
    departments: ["sales"],
    brandColor: "#006BFF",
    icon: { kind: "svg", file: "calendly.svg" },
    reads: ["Calls booked through your Calendly links"],
    does: ["Puts each booked call on the lead in Pipeline and on your schedule"],
    keywords: ["booking", "scheduling"],
    live: null,
    pendingNote: "Nothing in OASIS reads Calendly bookings yet.",
  },
  {
    slug: "cal-com",
    name: "Cal.com",
    summary: "Booking links",
    category: "calendar_email",
    departments: ["sales"],
    brandColor: "#292929",
    icon: { kind: "svg", file: "caldotcom.svg" },
    reads: ["Calls booked through your Cal.com links"],
    does: ["Puts each booked call on the lead in Pipeline and on your schedule"],
    keywords: ["booking", "scheduling", "cal"],
    live: null,
    pendingNote: "Nothing in OASIS reads Cal.com bookings yet.",
  },

  // Meetings
  {
    slug: "zoom",
    name: "Zoom",
    summary: "Video meetings",
    category: "meetings",
    departments: ["sales", "client_success"],
    brandColor: "#0B5CFF",
    icon: { kind: "svg", file: "zoom.svg" },
    reads: ["Meeting transcripts, after everyone is told the call is recorded"],
    does: ["Writes call notes and follow-ups for Sales and Client Success"],
    keywords: ["video", "calls", "recording", "transcript"],
    live: null,
    pendingNote: "Nothing in OASIS connects to Zoom yet. An app other Zoom accounts can install needs Zoom Marketplace review.",
  },
  {
    slug: "fathom",
    name: "Fathom",
    summary: "Meeting notes",
    category: "meetings",
    departments: ["sales", "client_success"],
    brandColor: null,
    icon: {
      kind: "monogram",
      letters: "Fa",
      reason: "Simple Icons' Fathom is Fathom Analytics, a different company",
    },
    reads: ["Transcripts and summaries of the calls Fathom recorded"],
    does: ["Attaches call notes to the right lead or client"],
    keywords: ["notetaker", "transcript", "recording"],
    live: null,
    pendingNote: "Nothing in OASIS reads Fathom's call notes yet.",
  },
  {
    slug: "fireflies",
    name: "Fireflies",
    summary: "Meeting notes",
    category: "meetings",
    departments: ["sales", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Ff", reason: "Not in Simple Icons" },
    reads: ["Transcripts and summaries of the calls Fireflies recorded"],
    does: ["Attaches call notes to the right lead or client"],
    keywords: ["notetaker", "transcript", "recording"],
    live: null,
    pendingNote: "Nothing in OASIS reads Fireflies' call notes yet.",
  },

  // Messaging
  {
    slug: "slack",
    name: "Slack",
    summary: "AI teammates in your channels",
    category: "messaging",
    departments: ["chief_of_staff", "sales", "marketing", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Sl", reason: "Removed from Simple Icons at Slack's request" },
    reads: [
      "Messages in the public channels you map to a department or a client",
      "Messages that @mention OASIS, and the name and email of the person who wrote them",
    ],
    does: [
      "Your department drafts a reply in the thread when someone @mentions it, under the department's name",
      SLACK_APPROVAL_RULE,
      "Messages in a channel mapped to a client show on that client's Conversations tab, and are deleted after 90 days",
      "Guests, people from other companies and channels shared with other companies are never read or answered",
    ],
    keywords: ["chat", "channels", "team"],
    live: {
      source: { kind: "tenant_connection", provider: "slack" },
      connect: { kind: "link", href: "/settings/chat-apps", label: "Set up in Chat apps" },
    },
    pendingNote: "OASIS's Slack app is not set up on this deployment yet, so Slack cannot be installed here.",
    seeAlso: { href: "/settings/chat-apps", label: "Install Slack and map channels under Chat apps" },
    // CC, 2026-10-01: a client brings its own Slack app ("the client is
    // responsible for obtaining the API key"); OASIS's own workspace uses the
    // OASIS app, which OASIS sets up. Each viewer is shown only its own path.
    paths: [
      {
        audience: "oasis",
        title: "The OASIS Slack app",
        body: "OASIS's own workspace connects with the OASIS Slack app, set up by OASIS on this deployment: an owner or admin presses Add to Slack under Chat apps and approves it in Slack. Disconnect deletes the token OASIS holds.",
        built: true,
        needsOasisApp: true,
      },
      {
        audience: "client",
        title: "Your own Slack app",
        body: "Your Slack admin creates a Slack app in your Slack and gives OASIS its client ID, client secret and signing secret.",
        built: false,
        needsOasisApp: false,
      },
    ],
  },
  {
    slug: "telegram",
    name: "Telegram",
    summary: "Alerts and AI teammates in chat",
    category: "messaging",
    departments: ["chief_of_staff", "sales"],
    brandColor: "#26A5E4",
    icon: { kind: "svg", file: "telegram.svg" },
    reads: ["Messages sent to your OASIS bot, so it can link your chat"],
    does: ["Sends your team's alerts to Telegram"],
    keywords: ["chat", "alerts", "bot"],
    live: {
      source: { kind: "workspace_heartbeat", service: "telegram", requireAll: ["bot_token", "chat_id"] },
      connect: { kind: "keys", label: "Set up Telegram", service: "telegram" },
    },
    seeAlso: { href: "/settings/chat-apps", label: "Your own Telegram alerts are under Chat apps" },
    docs: { href: "https://core.telegram.org/bots/tutorial", label: "Telegram's guide to creating a bot" },
  },
  {
    slug: "twilio",
    name: "Twilio",
    summary: "Text messaging",
    category: "messaging",
    departments: ["sales", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Tw", reason: "Removed from Simple Icons at Twilio's request" },
    reads: [
      "Texts your customers send to your Twilio number, once it points at OASIS",
      "Twilio's delivery report for each text OASIS sends",
    ],
    does: [
      "Sends texts from your own Twilio number or messaging service, once the connection test passes",
      "Sends only while live texting is switched on. While it is off, OASIS asks Twilio to send nothing, so no text leaves your number",
      "Checks Twilio's signature on every incoming text with your Auth Token and refuses any it cannot verify",
    ],
    keywords: ["sms", "text", "phone"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "twilio",
        requireAll: ["account_sid"],
        credentialAlternatives: [["auth_token"], ["api_key_sid", "api_key_secret"]],
        requireAny: ["from_number", "messaging_service_sid"],
        failureStates: TWILIO_FAILURE_STATES,
        verifiable: true,
      },
      connect: { kind: "keys", label: "Add your Twilio keys", service: "twilio" },
    },
    docs: { href: "https://www.twilio.com/docs/messaging", label: "Twilio's messaging docs" },
  },
  {
    slug: "whatsapp",
    name: "WhatsApp",
    summary: "Customer messaging",
    category: "messaging",
    departments: ["sales", "client_success"],
    brandColor: "#25D366",
    icon: { kind: "svg", file: "whatsapp.svg" },
    reads: ["Messages customers send to your business number"],
    does: ["Drafts replies for your approval"],
    keywords: ["chat", "messages"],
    live: null,
    pendingNote: "Nothing in OASIS sends or reads WhatsApp messages yet.",
  },
  {
    slug: "discord",
    name: "Discord",
    summary: "Community and team chat",
    category: "messaging",
    departments: ["chief_of_staff", "marketing"],
    brandColor: "#5865F2",
    icon: { kind: "svg", file: "discord.svg" },
    reads: ["Messages in the channels you add an AI teammate to"],
    does: ["Your department agents reply in those channels"],
    keywords: ["chat", "community"],
    live: null,
    pendingNote: "Nothing in OASIS reads or posts in Discord yet.",
  },
  {
    slug: "microsoft-teams",
    name: "Microsoft Teams",
    summary: "Team chat",
    category: "messaging",
    departments: ["chief_of_staff", "sales", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Te", reason: "Removed from Simple Icons at Microsoft's request" },
    reads: ["Messages in the channels you add an AI teammate to"],
    does: ["Your department agents reply in those channels"],
    keywords: ["chat", "microsoft", "teams"],
    live: null,
    pendingNote: "Nothing in OASIS reads or posts in Microsoft Teams yet.",
  },

  // Ads & social
  {
    slug: "meta",
    name: "Meta",
    summary: "Ads Manager, Facebook and Instagram Lead Ads",
    category: "ads_social",
    departments: ["marketing"],
    brandColor: "#0467DF",
    icon: { kind: "svg", file: "meta.svg" },
    includes: [
      { name: "Facebook", file: "facebook.svg", color: "#0866FF" },
      { name: "Instagram", file: "instagram.svg", color: "#FF0069" },
    ],
    reads: ["Campaign spend and results, and leads from your Facebook and Instagram forms"],
    does: [
      "Reports cost per lead and cost per paying customer",
      "Proposes pauses, budget changes and new ads — each one waits for your approval, and new ads start paused",
    ],
    keywords: ["facebook", "instagram", "ads", "lead ads", "advertising"],
    live: null,
    pendingNote: "Nothing in OASIS connects to Meta yet. An app that manages other businesses' ads needs Meta's App Review.",
  },
  {
    slug: "zernio",
    name: "Zernio",
    summary: "Social posting (formerly Late)",
    category: "ads_social",
    departments: ["marketing"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Ze", reason: "Not in Simple Icons" },
    reads: ["Your connected social profiles and the status of scheduled posts"],
    does: ["Schedules the posts you approve across your social accounts"],
    keywords: ["late", "social", "instagram", "tiktok", "linkedin", "posting"],
    live: null,
    pendingNote: "Nothing in OASIS posts with a workspace's own Zernio account yet.",
  },
  {
    slug: "constant-contact",
    name: "Constant Contact",
    summary: "Email campaigns",
    category: "ads_social",
    departments: ["marketing"],
    brandColor: null,
    icon: { kind: "monogram", letters: "CC", reason: "Not in Simple Icons" },
    reads: ["Your contact lists, and opens, clicks and bounces on campaigns"],
    does: ["Sends email campaigns from your Constant Contact account"],
    keywords: ["email", "newsletter", "campaigns", "blast"],
    live: {
      source: { kind: "oauth_tokens", service: "constant_contact", requireAll: ["access_token", "refresh_token"] },
      connect: {
        kind: "popup",
        href: "/api/integrations/constant-contact/authorize",
        label: "Connect Constant Contact",
        messageSource: "cc_oauth",
      },
    },
  },

  // CRM import
  {
    slug: "gohighlevel",
    name: "GoHighLevel",
    summary: "Contacts, pipelines and phone",
    category: "crm_import",
    departments: ["sales", "marketing"],
    brandColor: null,
    icon: { kind: "monogram", letters: "GH", reason: "Not in Simple Icons" },
    reads: ["Contacts, opportunities and conversation history"],
    does: ["Imports your leads and pipeline into OASIS", "Sends texts through your GoHighLevel number"],
    keywords: ["ghl", "highlevel", "crm", "import"],
    live: null,
    pendingNote: "Nothing in OASIS connects to GoHighLevel yet.",
  },

  // AI models
  {
    // Jev, TypeSafe's System One model: a fast classifier the workspace pays
    // for with its OWN TypeSafe key. Shadow only: it never decides anything
    // (lib/jev/mode.ts). Mode and agreement live on Settings > AI brain.
    slug: "jev",
    name: "Jev (TypeSafe)",
    summary: "A fast classifier, run beside OASIS in shadow",
    category: "ai_models",
    // Client Success: support-ticket triage. Chief of Staff: which department a
    // general Slack message belongs to. The two places it shadows.
    departments: ["client_success", "chief_of_staff"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Jv", reason: "Not in Simple Icons" },
    reads: ["Jev's answers to the questions OASIS asks it: a label and how sure it is"],
    does: [
      "Once OASIS lists TypeSafe as a processor: classifies new support tickets and general Slack messages in shadow, beside OASIS's normal path, and records only whether it agreed. Until then it only checks the key",
      "Never decides, sends or changes anything on its own",
      "The text it classifies goes to TypeSafe in the United States. TypeSafe's policy says it does not train on it",
    ],
    keywords: ["typesafe", "classifier", "system one", "shadow", "model"],
    live: {
      source: { kind: "tenant_connection", provider: "jev" },
      connect: { kind: "key_form", label: "Connect Jev", provider: "jev" },
    },
    seeAlso: { href: "/settings/ai", label: "Mode, cost and agreement are under AI brain" },
    docs: { href: "https://docs.typesafe.ai", label: "TypeSafe's documentation" },
  },
];

// ── Status ─────────────────────────────────────────────────────────────────

export type ConnectorStatusKind =
  | "connected"
  | "configured"
  | "attention"
  | "not_connected"
  | "unknown"
  | "coming_soon";

export type ConnectorStatus = {
  kind: ConnectorStatusKind;
  /** The one line the card shows. */
  label: string;
  /** A second line for the drawer and tooltips. */
  detail?: string;
  /** The connected account, as the provider named it (framework connections only). */
  account?: string;
  /**
   * The ways THIS workspace connects the app (ConnectorDef.paths for its kind
   * of workspace), each with its state on this deployment, for the drawer.
   */
  paths?: readonly ConnectorPathStatus[];
};

export type ConnectorPathStatus = {
  title: string;
  body: string;
  /** "Available", "Not set up on this deployment" or "Not built yet". */
  state: string;
  /** Not built: the drawer offers "Ask OASIS for it". */
  requestable: boolean;
};

/**
 * One live (not revoked) tenant_connections row, as the hub sees it: state and
 * health only, never a credential.
 */
export type ConnectionFact = {
  provider: string;
  status: string;
  account_id: string | null;
  account_label: string | null;
  environment: string | null;
  last_health_at: string | null;
  last_health_verdict: string | null;
  last_health_code: string | null;
  last_health_detail: string | null;
};

/** One row of listTenantIntegrationStatus — presence and test state, never a value. */
export type KeyRowFact = {
  service: string;
  field_key: string;
  has_value: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
  /** The failed test's code (Twilio: a plain state such as "needs_number"). */
  last_test_error?: string | null;
  /** "environment": OASIS's own deployment value, which a test never records on. */
  source?: "stored" | "environment" | null;
};

/** One integrations_health row, newest first per service. */
export type HeartbeatFact = {
  service: string;
  status: string | null;
  last_ping_at: string | null;
};

/**
 * Everything the resolver may look at. Each field is null when its lookup
 * FAILED — which must read as "status unavailable", never as "not connected".
 */
export type ConnectorFacts = {
  keyRows: readonly KeyRowFact[] | null;
  heartbeats: readonly HeartbeatFact[] | null;
  /** The viewer's own Google (gmail_oauth) link, or null when it could not be read. */
  personalGoogleLinked: boolean | null;
  /** The tenant's live Connections-framework connections. */
  connections: readonly ConnectionFact[] | null;
  /**
   * Providers that need OASIS's own app and do not have it on this deployment
   * (Slack without its Worker secrets). Their cards say so and offer nothing.
   */
  appNotConfigured?: readonly string[] | null;
  /**
   * The workspace is OASIS's own (true) or a client's (false), which decides
   * the connection paths it is shown (Slack: the OASIS app, or its own app).
   * Unknown (absent): no per-workspace path is shown.
   */
  oasisWorkspace?: boolean | null;
};

/** "5m ago" / "3h ago" / "Aug 3" — computed from an explicit now, so a test can pin it. */
export function formatVerifiedAgo(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const sec = Math.max(0, Math.round((nowMs - then) / 1000));
  if (sec < 60) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.round(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

const UNKNOWN: ConnectorStatus = {
  kind: "unknown",
  label: "Status unavailable",
  detail: "OASIS could not check this right now. That does not mean it is disconnected.",
};

function latestIso(values: readonly (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    const ms = v ? Date.parse(v) : NaN;
    if (Number.isFinite(ms) && ms > bestMs) {
      best = v;
      bestMs = ms;
    }
  }
  return best;
}

function keyedStatus(
  source: Extract<ConnectorStatusSource, { kind: "tenant_keys" | "oauth_tokens" }>,
  keyRows: readonly KeyRowFact[],
  nowMs: number,
): ConnectorStatus {
  const rows = keyRows.filter((r) => r.service === source.service);
  const present = (field: string) => rows.some((r) => r.field_key === field && r.has_value);
  if (!rows.some((r) => r.has_value)) return { kind: "not_connected", label: "Not connected" };

  const requireAny = source.kind === "tenant_keys" ? source.requireAny : undefined;
  const alternatives = source.kind === "tenant_keys" ? source.credentialAlternatives : undefined;
  const complete =
    source.requireAll.every(present) &&
    (!alternatives || alternatives.some((group) => group.every(present))) &&
    (!requireAny || requireAny.some(present));

  // A source that names its test's states (Twilio) says the newest one in the
  // owner's words, but only while it still describes the saved keys: saving a
  // value clears that value's own test result, so a stored value with no
  // result means the keys changed after the test. OASIS's deployment values
  // (source "environment") are never tested, so they never count as changed.
  const states = source.kind === "tenant_keys" ? source.failureStates : undefined;
  if (states) {
    const changedSinceTest = rows.some((r) => r.has_value && !r.last_tested_at && r.source !== "environment");
    if (changedSinceTest) {
      return complete
        ? {
            kind: "configured",
            label: "Set up · not tested yet",
            detail: "The keys changed after the last test. Run Test so OASIS checks them with the provider.",
          }
        : {
            kind: "attention",
            label: "Needs attention",
            detail: "Setup is incomplete: some required details are missing.",
          };
    }
    const failed = rows.filter((r) => r.last_test_ok === false && r.last_tested_at);
    const newest = latestIso(failed.map((r) => r.last_tested_at));
    const code = failed.find((r) => r.last_tested_at === newest)?.last_test_error ?? null;
    const state = code && Object.prototype.hasOwnProperty.call(states, code) ? states[code] : null;
    if (state) return { kind: state.kind, label: state.label, detail: state.detail };
  }
  if (!complete) {
    return {
      kind: "attention",
      label: "Needs attention",
      detail: "Setup is incomplete: some required details are missing.",
    };
  }

  if (source.kind === "oauth_tokens") {
    return {
      kind: "configured",
      label: "Authorized · not re-checked",
      detail: "The account was authorized. OASIS does not call the provider on every page load to re-check it.",
    };
  }

  if (rows.some((r) => r.last_test_ok === false)) {
    return {
      kind: "attention",
      label: "Needs attention",
      detail: "The last connection test failed. Open this app and run Test again.",
    };
  }
  if (!source.verifiable) {
    return {
      kind: "configured",
      label: "Key saved · not verifiable",
      detail: "This provider has no read-only check, so OASIS cannot confirm the key works until it is first used.",
    };
  }
  const verifiedAt = latestIso(
    rows.filter((r) => r.last_test_ok === true).map((r) => r.last_tested_at),
  );
  return verifiedAt
    ? {
        kind: "connected",
        label: `Connected · verified ${formatVerifiedAgo(verifiedAt, nowMs)}`,
        detail: "The last connection test called the provider and passed.",
      }
    : {
        kind: "configured",
        label: "Set up · not tested yet",
        detail: "The key is saved but has not passed a connection test. Open this app and run Test.",
      };
}

function accountLine(row: ConnectionFact): string | undefined {
  const name = row.account_label ?? row.account_id;
  if (!name) return undefined;
  return row.environment === "test" ? `${name} · test mode` : name;
}

/**
 * A Connections-framework card. Green comes ONLY from isVerifiedHealthy — a
 * connected row whose last live probe passed under a day ago. Everything else
 * says what is true in plain words, with the probe's own explanation.
 */
function frameworkStatus(
  def: ConnectorDef,
  provider: string,
  connections: readonly ConnectionFact[],
  keyRows: readonly KeyRowFact[] | null,
  nowMs: number,
): ConnectorStatus {
  const row = connections.find((c) => c.provider === provider && c.status !== "revoked");
  if (!row) {
    // Stripe only: the Credentials store may also hold a separate secret key
    // (checkout links for proposals). It is not this connection and never makes
    // it green, but an owner deserves to know both exist.
    const legacyKey =
      provider === "stripe" &&
      !!keyRows?.some((r) => r.service === "stripe" && r.field_key === "secret_key" && r.has_value);
    return {
      kind: "not_connected",
      label: "Not connected",
      detail: legacyKey
        ? "A Stripe secret key is also saved under Keys and accounts for checkout links. That key is separate and is not used as this read-only connection."
        : undefined,
    };
  }
  const account = accountLine(row);
  if (isVerifiedHealthy(row, nowMs)) {
    return {
      kind: "connected",
      label: `Connected · verified ${formatVerifiedAgo(row.last_health_at, nowMs)}`,
      detail: `The last live check with ${def.name} passed.`,
      account,
    };
  }
  switch (row.status) {
    case "connected":
      if (row.last_health_code === "provider_unreachable" || row.last_health_code === "unexpected_response") {
        return {
          kind: "configured",
          label: `Connected · ${def.name} did not answer the last check`,
          detail: row.last_health_detail ?? `OASIS could not reach ${def.name}. It will check again within the hour.`,
          account,
        };
      }
      return {
        kind: "configured",
        label: "Connected · waiting for a health check",
        detail: "No live check has passed in the last 24 hours. OASIS re-checks every hour; Test again runs one now.",
        account,
      };
    case "pending":
      return {
        kind: "configured",
        label: "Setting up · not verified yet",
        detail: "The connection has not passed a live check yet.",
        account,
      };
    case "pending_review":
      return {
        kind: "configured",
        label: "Pending platform approval",
        detail: row.last_health_detail ?? undefined,
        account,
      };
    case "expired":
      return {
        kind: "attention",
        label: "Key no longer accepted",
        detail: row.last_health_detail ?? `${def.name} stopped accepting this connection. Reconnect it.`,
        account,
      };
    case "degraded":
    case "error":
      return {
        kind: "attention",
        label: "Needs attention",
        detail: row.last_health_detail ?? "The last live check found a problem.",
        account,
      };
    default:
      return { ...UNKNOWN, account };
  }
}

/** The paths for the viewer's kind of workspace; none when it is not known. */
function viewerPaths(def: ConnectorDef, facts: ConnectorFacts): readonly ConnectorPath[] {
  if (!def.paths || typeof facts.oasisWorkspace !== "boolean") return [];
  const audience = facts.oasisWorkspace ? "oasis" : "client";
  return def.paths.filter((p) => p.audience === audience);
}

/**
 * A path's state from what is true on this deployment, never from the static
 * `built` flag alone: a built path that needs OASIS's app, where that app is
 * not set up, is not "Available".
 */
function pathStatus(p: ConnectorPath, oasisAppMissing: boolean): ConnectorPathStatus {
  const state = !p.built ? "Not built yet" : p.needsOasisApp && oasisAppMissing ? "Not set up on this deployment" : "Available";
  return { title: p.title, body: p.body, state, requestable: !p.built };
}

/**
 * The status a card shows. Pure: the same facts and `nowMs` always give the
 * same words, which is what lets the test feed it hostile inputs.
 */
export function resolveConnectorStatus(
  def: ConnectorDef,
  facts: ConnectorFacts,
  nowMs: number,
): ConnectorStatus {
  // No status source: nothing below may run, so no fact can turn it green.
  // The label is the state, never an era or a promise: Chat apps and the
  // drawer say "not built yet" for the same apps, and "Coming soon" /
  // "Planned" promised a release nobody had scheduled (S5-F01, W3A-R4).
  if (!def.live) {
    return {
      kind: "coming_soon",
      label: "Not built yet",
      detail: def.pendingNote,
    };
  }

  const source = def.live.source;
  if (source.kind === "tenant_connection") {
    // The ways THIS workspace connects (Slack: OASIS's own workspace uses the
    // OASIS app, a client its own app), each with its state here.
    const mine = viewerPaths(def, facts);
    const oasisAppMissing = !!facts.appNotConfigured?.includes(source.provider);
    const paths = mine.length > 0 ? mine.map((p) => pathStatus(p, oasisAppMissing)) : undefined;
    const withPaths = (s: ConnectorStatus): ConnectorStatus => (paths ? { ...s, paths } : s);
    // An app OASIS itself has not been given on this deployment cannot be
    // connected, whatever the facts say: say so rather than offer a dead button.
    // A workspace whose own way in does not need OASIS's app is not held to it.
    if (oasisAppMissing && (mine.length === 0 || mine.every((p) => p.needsOasisApp))) {
      return withPaths({
        kind: "coming_soon",
        label: `${def.name} app not configured yet`,
        detail: def.pendingNote ?? `OASIS's ${def.name} app is not set up on this deployment yet.`,
      });
    }
    if (!facts.connections) return withPaths(UNKNOWN);
    // A workspace whose every way in is not built yet cannot connect, unless it
    // already is: the state, with the request in the drawer, never "Not connected".
    const connected = facts.connections.some((c) => c.provider === source.provider && c.status !== "revoked");
    if (!connected && mine.length > 0 && mine.every((p) => !p.built)) {
      const how = mine[0].title.charAt(0).toLowerCase() + mine[0].title.slice(1);
      return withPaths({ kind: "coming_soon", label: "Not built yet", detail: `Connecting ${def.name} with ${how} is not built yet.` });
    }
    return withPaths(frameworkStatus(def, source.provider, facts.connections, facts.keyRows, nowMs));
  }
  if (source.kind === "tenant_keys" || source.kind === "oauth_tokens") {
    if (!facts.keyRows) return UNKNOWN;
    return keyedStatus(source, facts.keyRows, nowMs);
  }

  // workspace_heartbeat
  if (!facts.keyRows || !facts.heartbeats) return UNKNOWN;
  const rows = facts.keyRows.filter((r) => r.service === source.service);
  const configured = source.requireAll.every((f) =>
    rows.some((r) => r.field_key === f && r.has_value),
  );
  const health = facts.heartbeats.find((h) => h.service === source.service) ?? null;
  const state = classifyWorkspaceConnection({
    lookupAvailable: true,
    configured,
    healthStatus: health?.status ?? null,
    healthFresh: isWorkspaceHeartbeatFresh(health?.last_ping_at ?? null, nowMs),
  });

  // Google also has a per-person connection. It never makes the WORKSPACE look
  // connected, but it is real, so it is reported alongside.
  const personal =
    source.service === "gws" && facts.personalGoogleLinked !== null
      ? facts.personalGoogleLinked
        ? "Your own Google account is linked."
        : "Your own Google account is not linked yet."
      : undefined;

  switch (state) {
    case "connected":
      return {
        kind: "connected",
        label: `Connected · verified ${formatVerifiedAgo(health?.last_ping_at ?? null, nowMs)}`,
        detail: personal ?? "A health check passed in the last 24 hours.",
      };
    case "attention":
      return {
        kind: "attention",
        label: "Needs attention",
        detail: `The latest health check failed${health?.last_ping_at ? ` (${formatVerifiedAgo(health.last_ping_at, nowMs)})` : ""}.${personal ? ` ${personal}` : ""}`,
      };
    case "configured":
      return {
        kind: "configured",
        label: "Set up · waiting for a health check",
        detail: `The shared details are saved, but no health check has passed in the last 24 hours.${personal ? ` ${personal}` : ""}`,
      };
    case "not_configured":
      if (source.service === "gws" && facts.personalGoogleLinked === true) {
        return {
          kind: "configured",
          label: "Your account linked",
          detail: "Your own Google account is linked. No shared workspace mailbox is set up.",
        };
      }
      return { kind: "not_connected", label: "Not connected", detail: personal };
    default:
      return UNKNOWN;
  }
}

// -- The workspace at a glance ----------------------------------------------

/**
 * Every built connector's status, counted: how many apps the workspace has set
 * up (connected, set up but unverified, or needing attention), how many of
 * those need the owner, how many a live check has proven, and how many could
 * not be checked. From resolveConnectorStatus, so the rail's Connections dot,
 * the Operations tab and the hub's own cards can never tell different stories.
 * Apps not connected and apps not built yet are not counted: neither is a
 * problem.
 */
export type ConnectionsHealth = { setUp: number; attention: number; connected: number; unknown: number };

export function connectionsHealth(
  facts: ConnectorFacts,
  nowMs: number,
  catalog: readonly ConnectorDef[] = CONNECTOR_CATALOG,
): ConnectionsHealth {
  const out: ConnectionsHealth = { setUp: 0, attention: 0, connected: 0, unknown: 0 };
  for (const def of catalog) {
    if (!def.live) continue;
    const { kind } = resolveConnectorStatus(def, facts, nowMs);
    if (kind === "unknown") out.unknown += 1;
    if (kind === "connected" || kind === "configured" || kind === "attention") out.setUp += 1;
    if (kind === "connected") out.connected += 1;
    if (kind === "attention") out.attention += 1;
  }
  return out;
}

/**
 * The rail's Connections dot. "attention" when any app needs the owner; "ok"
 * only when at least one app is set up and every one of them is proven
 * connected; otherwise null, no dot: nothing set up, an app set up but not yet
 * verified, or a status that could not be read is not a green one.
 */
export function connectionsDot(h: ConnectionsHealth): "ok" | "attention" | null {
  if (h.attention > 0) return "attention";
  if (h.unknown === 0 && h.setUp > 0 && h.connected === h.setUp) return "ok";
  return null;
}

// ── Presentation helpers (pure) ────────────────────────────────────────────

/** Public URL of a connector SVG, or null for a monogram. */
export function connectorIconSrc(icon: ConnectorIcon): string | null {
  return icon.kind === "svg" ? `/connectors/${icon.file}` : null;
}

/** The tile the glyph sits on (bg-bg-raised, #131315). */
const TILE_RGB: readonly [number, number, number] = [19, 19, 21];
/** fg (#ededef), used when a brand colour would vanish on the tile. */
export const GLYPH_FALLBACK = "#EDEDEF";

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function hexRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG contrast ratio of a hex colour against the icon tile. */
export function contrastOnTile(hex: string): number {
  const rgb = hexRgb(hex);
  if (!rgb) return 1;
  const a = luminance(rgb);
  const b = luminance(TILE_RGB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * The glyph colour for a logo: the brand's own colour, which is how Simple Icons
 * intends its single-colour marks to be used — unless it would drop under 3:1
 * (the WCAG floor for graphics) on the dark tile, as Cal.com's near-black does.
 */
export function glyphColor(def: Pick<ConnectorDef, "brandColor">): string {
  if (!def.brandColor) return GLYPH_FALLBACK;
  return contrastOnTile(def.brandColor) >= 3 ? def.brandColor : GLYPH_FALLBACK;
}

/** Case-insensitive search over name, summary, category label and keywords. */
export function connectorMatches(def: ConnectorDef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const category = CONNECTOR_CATEGORIES.find((c) => c.key === def.category)?.label ?? "";
  const haystack = [def.name, def.summary, category, ...(def.keywords ?? [])]
    .join(" ")
    .toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export function connectorBySlug(slug: string): ConnectorDef | null {
  return CONNECTOR_CATALOG.find((c) => c.slug === slug) ?? null;
}
