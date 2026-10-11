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
 * NEVER A FAKE GREEN. A connector is "connected" only when a real check proved
 * it: a passing connection test that actually called the provider (under a
 * week old, KEY_CHECK_FRESH_MS), a send OASIS's own sender made from its
 * mailbox, or a live health check of a Connections-framework connection. A
 * saved key that nothing checked is "set up", a failed lookup is "status
 * unavailable" (unknown is not disconnected), and an app with no status source
 * is "coming soon" whatever the facts say — the resolver returns before it ever
 * reads them.
 *
 * ONE ANSWER PER INTEGRATION (2026-10-08). Every screen that says whether an
 * app is connected reads it from here: the hub, Chat apps, Notifications, AI
 * brain, the setup wizard, the department tabs, the AI Team roster and the
 * rail. A heartbeat from OASIS's own computer only says a key NAME is in its
 * env file, so it never proves anything here (it used to turn Telegram and
 * Google "Connected, verified just now" while nothing had checked them). The
 * per-person connections (your own Google account, your own Telegram bot) have
 * their own resolvers below, so a screen about you and a screen about the
 * workspace say which one they mean.
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
import { isVerifiedHealthy } from "@/lib/connections/rules";
import { SLACK_APPROVAL_RULE } from "@/lib/slack/copy";
import { TWILIO_FAILURE_STATES } from "@/lib/twilio/shared";

// ── Catalog shape ──────────────────────────────────────────────────────────

export type ConnectorCategoryKey =
  | "payments"
  | "accounting"
  | "banking"
  | "calendar_email"
  | "meetings"
  | "messaging"
  | "ads_social"
  | "crm_import"
  | "ai_models";

/** Catalog groups, in the order the hub renders them. */
export const CONNECTOR_CATEGORIES: readonly { key: ConnectorCategoryKey; label: string }[] = [
  { key: "payments", label: "Payments" },
  { key: "accounting", label: "Accounting" },
  { key: "banking", label: "Banking" },
  { key: "calendar_email", label: "Calendar & email" },
  { key: "meetings", label: "Meetings" },
  { key: "messaging", label: "Messaging & chat" },
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
 *   tenant_keys          the shared key store's per-field presence and its last
 *                        connection test (Google's mailbox, the Telegram team
 *                        bot, Twilio). `verifiable: false` means the "test"
 *                        for this service only checks presence, so it can never
 *                        prove a connection. Values OASIS sets on its own
 *                        server have no saved row: their checks come from
 *                        lib/integrations/server-checks.ts (ServerCheckFact).
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
   * The vendor's own sign-in page, opened in a popup from
   * /api/connections/[provider]/authorize (QuickBooks, Xero, Zoom, WhatsApp).
   * The provider is registered in lib/connections/registry.ts with OASIS's app
   * secrets named; the callback stores the encrypted tokens for the session's
   * workspace, and the card says which secrets are missing until they exist.
   */
  | { kind: "oauth"; label: string; provider: string }
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
  /** Sub-products shown in the drawer: only ones OASIS uses (Google: Gmail, Calendar, Meet). */
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
   * OASIS's own app for this vendor is private to OASIS's own login (Constant
   * Contact's), so a CLIENT workspace that has not connected is told it is
   * "Not available on this workspace yet" (unavailableStatus) instead of being
   * offered a button that answers "not enabled". OASIS's own workspace connects.
   */
  clientsUnavailable?: boolean;
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

/**
 * The `source` the sign-in popup page posts back to the hub with
 * (lib/connections/popup.ts CONNECTION_POPUP_SOURCE is this same value; a test
 * holds the two together). Client-safe, so the hub can import it.
 */
export const OAUTH_POPUP_SOURCE = "oasis_connection";

/** Where an `oauth` card's button goes: the route that sends the browser to the vendor's own sign-in page. */
export function oauthStartHref(provider: string): string {
  return `/api/connections/${encodeURIComponent(provider)}/authorize`;
}

/** Settings › Connections with this app's drawer open. */
export function connectorHref(slug: string): string {
  return `/settings/connections?app=${encodeURIComponent(slug)}`;
}

export type TestState = { kind: "attention" | "configured"; label: string; detail: string };

/**
 * The Google mailbox card's words for a FAILED Test, keyed by the code the Test
 * stored (app/api/integrations/keys/test probeSmtp). The Test signs in to Gmail
 * with the saved address and App Password; any refusal or timeout is stored as
 * the one code below, so the words say only what is known.
 */
export const GOOGLE_TEST_STATES: Readonly<Record<string, TestState>> = {
  smtp_auth_failed: {
    kind: "attention",
    label: "Could not sign in to Gmail",
    detail:
      "The last Test could not sign in to Gmail with this address and App Password. Check both (2-Step Verification must be on for an App Password), save them again, then run Test.",
  },
  // OASIS's own email sender was refused at sign-in the last time it sent from
  // the mailbox (lib/integrations/server-checks.ts mailboxSendCheck).
  send_auth_failed: {
    kind: "attention",
    label: "Could not sign in to Gmail",
    detail:
      "Gmail refused the App Password the last time OASIS sent an email from this mailbox. Check it (2-Step Verification must be on for an App Password), save it again, then run Test.",
  },
  missing_smtp_fields: {
    kind: "attention",
    label: "Needs attention",
    detail: "Setup is incomplete: the address or the App Password is missing.",
  },
};

/**
 * The Telegram team bot card's words for a FAILED Test, keyed by the code the
 * Test stored (probeTelegram: getMe for the bot, getChat for the chat). A code
 * with a detail after a colon ("network_error: ...") is looked up by the part
 * before it.
 */
export const TELEGRAM_TEST_STATES: Readonly<Record<string, TestState>> = {
  telegram_http_401: {
    kind: "attention",
    label: "Bot token not accepted",
    detail: "Telegram refused this bot token. Copy it again from BotFather, save it, then run Test.",
  },
  telegram_http_404: {
    kind: "attention",
    label: "Bot token not accepted",
    detail: "Telegram does not know this bot token. Copy it again from BotFather, save it, then run Test.",
  },
  telegram_returned_not_ok: {
    kind: "attention",
    label: "Bot token not accepted",
    detail: "Telegram did not accept this bot token. Copy it again from BotFather, save it, then run Test.",
  },
  telegram_chat_http_400: {
    kind: "attention",
    label: "Chat not found",
    detail: "Telegram could not find this chat for this bot. Send the bot a message from the chat, check the chat ID, then run Test.",
  },
  telegram_chat_http_403: {
    kind: "attention",
    label: "Bot not in the chat",
    detail: "The bot was removed from this chat or blocked there. Add it back, then run Test.",
  },
  telegram_chat_returned_not_ok: {
    kind: "attention",
    label: "Chat not found",
    detail: "Telegram did not return this chat for this bot. Check the chat ID, then run Test.",
  },
  network_error: {
    kind: "configured",
    label: "Set up · Telegram did not answer the last Test",
    detail: "OASIS could not reach Telegram during the last Test, so nothing is known about the bot. Run Test again.",
  },
};

/**
 * The words for a FAILED Test of an app connected with a pasted key, keyed by
 * the shared codes every such Test answers with (lib/integrations/key-probes.ts).
 * `notFound` says what the Test could not find for this app (GoHighLevel's
 * sub-account); an app whose Test never answers it omits it.
 */
export function keyTestStates(
  appName: string,
  extra: { notFound?: string; keyWord?: string } = {},
): Readonly<Record<string, TestState>> {
  const key = extra.keyWord ?? "key";
  const states: Record<string, TestState> = {
    key_rejected: {
      kind: "attention",
      label: `${appName} refused the ${key}`,
      detail: `${appName} did not accept this ${key}. It may have been deleted or mistyped. Copy a new one from ${appName}, save it, then run Test.`,
    },
    missing_permission: {
      kind: "attention",
      label: `${appName} ${key} lacks access`,
      detail: `${appName} accepted the ${key}, but it is not allowed to read what OASIS checks. Give it read access in ${appName}, save it again, then run Test.`,
    },
    plan_required: {
      kind: "attention",
      label: `${appName} plan has no API access`,
      detail: `${appName} says this account's plan does not include API access. Upgrade the plan in ${appName}, then run Test.`,
    },
    rate_limited: {
      kind: "configured",
      label: `Set up · ${appName} asked OASIS to wait`,
      detail: `${appName} asked OASIS to slow down during the last Test, so nothing is known about the ${key} yet. Run Test again in a few minutes.`,
    },
    provider_unreachable: {
      kind: "configured",
      label: `Set up · ${appName} did not answer the last Test`,
      detail: `OASIS could not reach ${appName} during the last Test, so nothing is known about the ${key}. Run Test again.`,
    },
    provider_error: {
      kind: "configured",
      label: `Set up · ${appName} gave an unexpected answer`,
      detail: `${appName} answered the last Test in a way OASIS did not expect, so nothing is known about the ${key}. Run Test again; if it repeats, tell OASIS support.`,
    },
    missing_fields: {
      kind: "attention",
      label: "Needs attention",
      detail: "Setup is incomplete: some required details are missing.",
    },
  };
  if (extra.notFound) states.not_found = { kind: "attention", label: "Not found", detail: extra.notFound };
  return states;
}

/**
 * A channel webhook (Discord, Microsoft Teams): the shared key words, plus the
 * one a webhook adds - an address that is not the vendor's own, which OASIS
 * never calls (lib/tenant-integration-schemas.ts parseDiscordWebhookUrl).
 */
function webhookTestStates(appName: string): Readonly<Record<string, TestState>> {
  const states = { ...keyTestStates(appName, { keyWord: "webhook" }) };
  states.key_rejected = {
    kind: "attention",
    label: `${appName} no longer has this webhook`,
    detail: `${appName} does not accept this webhook. It may have been deleted or its sign-in setting changed. Create a new webhook for the channel, save it, then run Test.`,
  };
  states.blocked_host = {
    kind: "attention",
    label: `Not a ${appName} address`,
    detail: `This is not a ${appName} webhook address, so OASIS will not call it. Copy the webhook URL again from ${appName}, save it, then run Test.`,
  };
  return states;
}

/**
 * A self-hosted mail server that OASIS's
 * servers cannot connect to safely: they cannot lock the connection to the
 * address they checked (lib/integrations/host-safety.ts), so nothing was sent.
 */
const SELF_HOSTED_CANNOT_PIN: TestState = {
  kind: "configured",
  label: "Set up · this address can't be tested from OASIS yet",
  detail:
    "OASIS only tests a self-hosted address when it can lock the connection to the address it checked, and its servers can't do that yet, so nothing was sent. A big mail provider's own server name (Microsoft 365, Gmail, SendGrid and the like) tests normally.",
};

/** The workspace's own mail server: a sign-in refused, or an address OASIS never connects to. */
const SMTP_TEST_STATES: Readonly<Record<string, TestState>> = {
  missing_fields: {
    kind: "attention",
    label: "Needs attention",
    detail: "Setup is incomplete: some required details are missing.",
  },
  smtp_auth_failed: {
    kind: "attention",
    label: "Could not sign in to the mail server",
    detail: "The mail server refused this username and password. Check both with your email provider, save them again, then run Test.",
  },
  provider_unreachable: {
    kind: "attention",
    label: "Could not reach the mail server",
    detail: "OASIS could not open a secure connection to this server and port. Check the server name and port with your email provider, then run Test.",
  },
  blocked_host: {
    kind: "attention",
    label: "Server name not allowed",
    detail: "OASIS only connects to a public server name on a standard mail port (587, 465, 2525 or 25) whose addresses are all on the public internet. Use the name your email provider gives you.",
  },
  not_found: {
    kind: "attention",
    label: "Server name not found",
    detail: "OASIS could not find an address for this server name. Check the name with your email provider, then run Test.",
  },
  cannot_pin: SELF_HOSTED_CANNOT_PIN,
};

// ── The catalog ────────────────────────────────────────────────────────────

export const CONNECTOR_CATALOG: readonly ConnectorDef[] = [
  // Money
  {
    slug: "stripe",
    name: "Stripe",
    summary: "Payments and subscriptions",
    category: "payments",
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
    keywords: ["money", "payments", "billing", "mrr", "invoices", "restricted key"],
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
    category: "accounting",
    departments: ["finance"],
    brandColor: "#2CA01C",
    icon: { kind: "svg", file: "quickbooks.svg" },
    reads: ["The name of the QuickBooks company you approve, when OASIS checks the connection"],
    does: [
      "Checks the connection with QuickBooks every hour and keeps the sign-in renewed",
      "Your books do not flow into Finance from this connection yet: that sync is not built",
      "OASIS only reads. Intuit has no read-only permission, so this is kept by OASIS's code and not by QuickBooks; Disconnect also tells Intuit to forget OASIS",
    ],
    keywords: ["money", "accounting", "intuit", "qbo", "bookkeeping"],
    live: {
      source: { kind: "tenant_connection", provider: "quickbooks" },
      connect: { kind: "oauth", label: "Connect QuickBooks", provider: "quickbooks" },
    },
  },
  {
    slug: "xero",
    name: "Xero",
    summary: "Accounting books",
    category: "accounting",
    departments: ["finance"],
    brandColor: "#13B5EA",
    icon: { kind: "svg", file: "xero.svg" },
    reads: ["The name of the Xero organisation you approve, when OASIS checks the connection"],
    does: [
      "Checks the connection with Xero every hour and keeps the sign-in renewed",
      "Your books do not flow into Finance from this connection yet: that sync is not built",
      "Asks Xero for read access only; Disconnect also tells Xero to forget OASIS",
    ],
    keywords: ["money", "accounting", "bookkeeping"],
    live: {
      source: { kind: "tenant_connection", provider: "xero" },
      connect: { kind: "oauth", label: "Connect Xero", provider: "xero" },
    },
  },
  {
    slug: "plaid",
    name: "Plaid",
    summary: "Bank accounts",
    category: "banking",
    departments: ["finance"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Pl", reason: "Not in Simple Icons" },
    reads: ["Whether Plaid accepts your client ID and secret, when you run Test (Test asks for one supported bank and reads no account)"],
    does: [
      "Checks your Plaid credentials when you press Test, and changes nothing in your Plaid",
      "Linking a bank account through Plaid Link is not built yet, so no balances or transactions are read",
    ],
    keywords: ["money", "bank", "banking", "cash", "transactions", "client id", "secret"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "plaid",
        requireAll: ["client_id", "secret", "environment"],
        failureStates: keyTestStates("Plaid", { keyWord: "secret" }),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Plaid", service: "plaid" },
    },
  },

  // Calendar & email
  {
    slug: "google-workspace",
    name: "Google Workspace",
    // Only what is connected here (2026-10-08): the workspace's shared Gmail
    // mailbox, which its status checks, and each person's own Google account
    // (Gmail, and Calendar invites with Google Meet), reported beside it. No
    // part of OASIS uses Google Drive, and no calendar is read for free time.
    summary: "Shared Gmail mailbox, and your own Calendar",
    category: "calendar_email",
    departments: ["chief_of_staff", "sales", "client_success"],
    brandColor: "#4285F4",
    icon: { kind: "svg", file: "google.svg" },
    includes: [
      { name: "Gmail", file: "gmail.svg", color: "#EA4335" },
      { name: "Google Calendar", file: "googlecalendar.svg", color: "#4285F4" },
      { name: "Google Meet", file: "googlemeet.svg", color: "#00897B" },
    ],
    reads: ["The address of the Google account you connect, so client invitations only come from your work email"],
    does: [
      "Sends the workspace's email from its shared Gmail address",
      "Adds the calls you book to your own Google Calendar, with a Google Meet link, once you connect your account",
    ],
    keywords: ["gmail", "calendar", "email", "meet", "google"],
    live: {
      // Proven only by its own Test (a Gmail sign-in with the saved address and
      // App Password), never by a heartbeat from OASIS's computer.
      source: {
        kind: "tenant_keys",
        service: "gws",
        requireAll: ["app_password", "from_address"],
        failureStates: GOOGLE_TEST_STATES,
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Google", service: "gws" },
    },
    yourAccount: "google",
    docs: { href: "https://support.google.com/accounts/answer/185833", label: "Google's guide to App Passwords" },
  },
  {
    // The workspace's own mail server (its email host, Microsoft 365, SendGrid,
    // Amazon SES): for a business not on Google Workspace.
    slug: "smtp",
    name: "Email server (SMTP)",
    summary: "Your own mail server, if you are not on Google",
    category: "calendar_email",
    departments: ["chief_of_staff", "sales", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "SM", reason: "SMTP is a mail standard, not a brand" },
    reads: ["Whether your mail server accepts the sign-in, when you run Test (Test signs in and sends nothing)"],
    does: [
      "Signs in to your mail server when you press Test, over an encrypted connection, and sends nothing",
      "OASIS does not send your workspace's email through this server yet: that sender is not built",
    ],
    keywords: ["email", "smtp", "outlook", "microsoft 365", "office 365", "sendgrid", "ses", "mail server"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "smtp",
        requireAll: ["host", "port", "user", "password", "from_address"],
        failureStates: SMTP_TEST_STATES,
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect your mail server", service: "smtp" },
    },
  },
  {
    slug: "calendly",
    name: "Calendly",
    summary: "Booking links",
    category: "calendar_email",
    departments: ["sales"],
    brandColor: "#006BFF",
    icon: { kind: "svg", file: "calendly.svg" },
    reads: ["The name and email of the Calendly account the token belongs to, when you run Test"],
    does: [
      "Checks the token with Calendly when you press Test, and changes nothing in your Calendly",
      "Bookings do not flow into Pipeline or your schedule from this token yet: that sync is not built",
    ],
    keywords: ["booking", "scheduling", "token", "api key"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "calendly",
        requireAll: ["access_token"],
        failureStates: keyTestStates("Calendly", { keyWord: "token" }),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Calendly", service: "calendly" },
    },
  },
  {
    slug: "cal-com",
    name: "Cal.com",
    summary: "Booking links",
    category: "calendar_email",
    departments: ["sales"],
    brandColor: "#292929",
    icon: { kind: "svg", file: "caldotcom.svg" },
    reads: ["The name and email of the Cal.com account the key belongs to, when you run Test"],
    does: [
      "Checks the key with Cal.com when you press Test, and changes nothing in your Cal.com",
      "Bookings do not flow into Pipeline or your schedule from this key yet: that sync is not built",
    ],
    keywords: ["booking", "scheduling", "cal", "api key"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "cal_com",
        requireAll: ["api_key"],
        failureStates: keyTestStates("Cal.com"),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Cal.com", service: "cal_com" },
    },
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
    reads: ["The email of the Zoom account you approve, when OASIS checks the connection"],
    does: [
      "Checks the connection with Zoom every hour and keeps the sign-in renewed",
      "Transcripts and call notes do not flow from this connection yet: that sync is not built",
      "Disconnect also tells Zoom to forget OASIS",
    ],
    keywords: ["video", "calls", "recording", "transcript"],
    live: {
      source: { kind: "tenant_connection", provider: "zoom" },
      connect: { kind: "oauth", label: "Connect Zoom", provider: "zoom" },
    },
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
    reads: ["Whether Fathom accepts the key, when you run Test (Test lists your recent meetings and keeps nothing)"],
    does: [
      "Checks the key with Fathom when you press Test, and changes nothing in your Fathom",
      "Call notes do not reach your leads or clients from this key yet: that sync is not built",
    ],
    keywords: ["notetaker", "transcript", "recording", "api key"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "fathom",
        requireAll: ["api_key"],
        failureStates: keyTestStates("Fathom"),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Fathom", service: "fathom" },
    },
  },
  {
    slug: "fireflies",
    name: "Fireflies",
    summary: "Meeting notes",
    category: "meetings",
    departments: ["sales", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Ff", reason: "Not in Simple Icons" },
    reads: ["The name and email of the Fireflies account the key belongs to, when you run Test"],
    does: [
      "Checks the key with Fireflies when you press Test, and changes nothing in your Fireflies",
      "Call notes do not reach your leads or clients from this key yet: that sync is not built",
    ],
    keywords: ["notetaker", "transcript", "recording", "api key"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "fireflies",
        requireAll: ["api_key"],
        failureStates: keyTestStates("Fireflies"),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Fireflies", service: "fireflies" },
    },
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
    seeAlso: { href: "/settings/chat-apps", label: "Install Slack and map channels under Chat apps" },
    // CC, 2026-10-02: every workspace connects through the vendor's standard
    // Connect, and clients never create a developer app. So a client uses the
    // same OASIS Slack app as OASIS's own workspace (Add to Slack, approve in
    // Slack). Slack's terms also make its Marketplace the channel for apps a
    // company distributes to customers, which rules out a per-client app.
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
        title: "The OASIS Slack app",
        body: "An owner or admin presses Add to Slack under Chat apps and approves the OASIS app in your Slack. You never create a Slack app yourself. Disconnect deletes the token OASIS holds.",
        built: true,
        needsOasisApp: true,
      },
    ],
  },
  {
    slug: "telegram",
    name: "Telegram",
    // Alerts only: Telegram teammates are not built (Settings > Chat apps says so).
    summary: "Team alerts in a Telegram chat",
    category: "messaging",
    departments: ["chief_of_staff", "sales"],
    brandColor: "#26A5E4",
    icon: { kind: "svg", file: "telegram.svg" },
    reads: ["The bot's name and the chat it writes to, when you run Test"],
    does: ["Sends your team's alerts to Telegram"],
    keywords: ["chat", "alerts", "bot"],
    live: {
      // The workspace's team bot. Proven only by its own Test (Telegram's getMe
      // for the bot and getChat for the chat), never by a heartbeat from
      // OASIS's computer, which only says a key name is in its env file.
      source: {
        kind: "tenant_keys",
        service: "telegram",
        requireAll: ["bot_token", "chat_id"],
        failureStates: TELEGRAM_TEST_STATES,
        verifiable: true,
      },
      connect: { kind: "keys", label: "Set up Telegram", service: "telegram" },
    },
    seeAlso: { href: "/settings/chat-apps", label: "Your own Telegram bot, separate from this team bot, is under Chat apps" },
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
      "Sends texts from your own Twilio number or messaging service. Run Test first: a failed Test does not stop texts on its own",
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
    reads: ["The name of the WhatsApp Business Account you approve, when OASIS checks the connection"],
    does: [
      "Checks the connection with WhatsApp every hour and keeps the sign-in renewed",
      "OASIS does not read or send WhatsApp messages from this connection yet: that is not built",
      "Disconnect also tells Meta to withdraw OASIS's access",
    ],
    keywords: ["chat", "messages", "meta", "whatsapp business"],
    live: {
      source: { kind: "tenant_connection", provider: "whatsapp" },
      connect: { kind: "oauth", label: "Connect WhatsApp", provider: "whatsapp" },
    },
  },
  {
    slug: "discord",
    name: "Discord",
    summary: "Post to one channel",
    category: "messaging",
    departments: ["chief_of_staff", "marketing"],
    brandColor: "#5865F2",
    icon: { kind: "svg", file: "discord.svg" },
    reads: ["Whether Discord still has the webhook, when you run Test. OASIS cannot read any message in your server"],
    does: [
      "Can post messages to the one channel the webhook belongs to",
      "Test asks Discord whether the webhook exists and posts nothing",
      "No department posts to this channel yet: that is not built",
    ],
    keywords: ["chat", "community", "webhook", "channel"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "discord",
        requireAll: ["webhook_url"],
        failureStates: webhookTestStates("Discord"),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Discord", service: "discord" },
    },
  },
  {
    slug: "microsoft-teams",
    name: "Microsoft Teams",
    summary: "Post to one channel",
    category: "messaging",
    departments: ["chief_of_staff", "sales", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Te", reason: "Removed from Simple Icons at Microsoft's request" },
    reads: ["Nothing. A Teams webhook can only be posted to, so OASIS cannot read any message in your channel"],
    does: [
      "Can post messages to the one channel the Workflows webhook belongs to",
      "Test posts one short message that says OASIS is connected, because Microsoft gives a webhook no other way to be checked",
      "No department posts to this channel yet: that is not built",
    ],
    keywords: ["chat", "microsoft", "teams", "webhook", "workflows", "channel"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "microsoft_teams",
        requireAll: ["webhook_url"],
        failureStates: webhookTestStates("Microsoft Teams"),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Microsoft Teams", service: "microsoft_teams" },
    },
  },

  // Ads & social
  {
    slug: "meta",
    name: "Meta",
    summary: "Ad account access, with a system user token",
    category: "ads_social",
    departments: ["marketing"],
    brandColor: "#0467DF",
    icon: { kind: "svg", file: "meta.svg" },
    includes: [
      { name: "Facebook", file: "facebook.svg", color: "#0866FF" },
      { name: "Instagram", file: "instagram.svg", color: "#FF0069" },
    ],
    reads: ["The name and status of the ad account the token can read, when you run Test"],
    does: [
      "Checks the token with Meta when you press Test, and changes nothing in your ad account",
      "Campaign results and Lead Ads do not flow into Marketing from this token yet: that sync is not built",
      "Never creates, pauses or edits an ad: give the system user read access (ads_read) only",
    ],
    keywords: ["facebook", "instagram", "ads", "lead ads", "advertising", "system user", "business manager"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "meta_ads",
        requireAll: ["access_token", "ad_account_id"],
        failureStates: keyTestStates("Meta", {
          keyWord: "token",
          notFound:
            "Meta could not find that ad account for this token. Check the ad account ID, and that the system user is assigned to it in Business Settings, then run Test.",
        }),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Meta Ads", service: "meta_ads" },
    },
  },
  {
    slug: "zernio",
    name: "Zernio",
    summary: "Social posting (formerly Late)",
    category: "ads_social",
    departments: ["marketing"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Ze", reason: "Not in Simple Icons" },
    reads: ["How many Zernio profiles the key can see, when you run Test"],
    does: [
      "Checks the key with Zernio when you press Test, and posts nothing",
      "Posts and their results do not flow into Marketing from this key yet: that sync is not built",
    ],
    keywords: ["late", "social", "instagram", "tiktok", "linkedin", "posting", "api key"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "late",
        requireAll: ["api_key"],
        failureStates: keyTestStates("Zernio"),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect Zernio", service: "late" },
    },
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
    // OASIS's Constant Contact app is private to the login that created it
    // until Constant Contact's support approves it for all users, and the
    // authorize route answers a client workspace "not configured": a client
    // card says it is not available here yet instead of offering a dead button.
    clientsUnavailable: true,
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
    reads: ["The name of the sub-account the token opens, when you run Test"],
    does: [
      "Checks the token with GoHighLevel when you press Test, and changes nothing in your GoHighLevel",
      "Contacts and opportunities are not imported into Pipeline from this token yet: that import is not built",
    ],
    keywords: ["ghl", "highlevel", "crm", "import", "private integration", "token"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "gohighlevel",
        requireAll: ["private_token", "location_id"],
        failureStates: keyTestStates("GoHighLevel", {
          keyWord: "token",
          notFound:
            "GoHighLevel could not find that sub-account for this token. Check the sub-account ID, and that the token was made in (or can open) that sub-account, then run Test.",
        }),
        verifiable: true,
      },
      connect: { kind: "keys", label: "Connect GoHighLevel", service: "gohighlevel" },
    },
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
  /**
   * Connected, but OASIS's own app for it is missing on THIS deployment: a
   * Reconnect or a Test again would only end in a refusal (the app can't be
   * reached here at all), so the drawer and panel hide both and keep only
   * Disconnect (Codex review, PR #574).
   */
  appMissing?: boolean;
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

/**
 * The viewer's own Google connection (user_integration_credentials
 * gmail_oauth), as presence and non-secret fields only. Read by
 * lib/integrations/personal-google.ts readPersonalGoogleFact, the one reader
 * every screen about "your Google" uses.
 */
export type PersonalGoogleFact = {
  /** A refresh token is saved: the account was authorized. */
  linked: boolean;
  /** The saved grant includes Google Calendar events. */
  calendarScope: boolean;
  /** The Google address that authorized it, as Google named it. */
  address: string | null;
  /** The viewer's own work email: client invitations must come from this address. */
  workEmail: string | null;
};

/**
 * A real check of the details OASIS sets on its own server, which have no saved
 * key row for a Test result to land on (lib/integrations/server-checks.ts):
 * the workspace's latest Test of the app ("test"), or, for the Google mailbox,
 * the last time OASIS's own email sender signed in to Gmail to send ("send").
 * Never a heartbeat that only says a key name is on OASIS's computer.
 */
export type ServerCheckFact = {
  service: string;
  via: "test" | "send";
  checked_at: string;
  ok: boolean;
  /** The failed check's code, looked up in the card's failureStates. */
  code: string | null;
  /**
   * A Test of values OASIS's server no longer holds (a secret changed after
   * it ran: server-checks.ts serverValuesFingerprint). It describes nothing in
   * use, pass or failure: the card ignores it and says the details changed.
   */
  outdated?: boolean;
};

/** The viewer's own Telegram bot (user_integration_credentials telegram_bot): presence only. */
export type PersonalTelegramFact = {
  /** A bot token Telegram accepted is saved. */
  botSaved: boolean;
  /** The chat the bot will write to is linked. */
  chatLinked: boolean;
  username: string | null;
};

/**
 * Everything the resolver may look at. Each field is null when its lookup
 * FAILED — which must read as "status unavailable", never as "not connected".
 */
export type ConnectorFacts = {
  keyRows: readonly KeyRowFact[] | null;
  /**
   * The real checks of the values OASIS sets on its own server (ServerCheckFact),
   * read for OASIS's own workspaces only. Null when that read failed: a card
   * whose values are on the server then says "status unavailable". Absent: none.
   */
  serverChecks?: readonly ServerCheckFact[] | null;
  /**
   * The viewer's own Google connection, or null when it could not be read.
   * Absent: not read for this screen (a count or a card that is not Google's),
   * so no card says anything about it.
   */
  personalGoogle?: PersonalGoogleFact | null;
  /** The tenant's live Connections-framework connections. */
  connections: readonly ConnectionFact[] | null;
  /**
   * Providers that need OASIS's own app and do not have it on this deployment
   * (Slack without its Worker secrets). Their cards say so and offer nothing.
   */
  appNotConfigured?: readonly string[] | null;
  /**
   * For a VERIFIED platform operator in OASIS's own workspace ONLY: the Worker
   * secret NAMES each missing app still needs (provider id -> names, never
   * values). That operator's card says exactly which to add; a client, and any
   * other member of OASIS's workspace, is never shown a secret name
   * (components/os/connections/connector-facts.ts secretNamesFor).
   */
  appSecretsMissing?: Readonly<Record<string, readonly string[]>> | null;
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

/** "Oct 1, 2026": the day a check ran, for a pass too old to count as connected. */
function formatCheckDate(iso: string): string {
  return new Date(Date.parse(iso)).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * How long a passing check of an app's keys counts as "Connected" (2026-10-08).
 * Nothing re-checks these keys on its own: a Test runs when a person presses
 * it, and OASIS's mailbox is re-checked only when it sends. Stripe's card,
 * which OASIS re-checks every hour, allows a day; a day here would turn every
 * card grey the morning after its Test though nothing changed. A week bounds
 * how long a token revoked at the provider (a bot token reset in BotFather, an
 * App Password removed in Google) can still read "Connected" to seven days, for
 * at most one Test a week. Past it the card says when it was last checked.
 */
export const KEY_CHECK_FRESH_MS = 7 * 24 * 60 * 60 * 1000;

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

/**
 * A stored test code's lookup key: "network_error: getaddrinfo ..." is looked
 * up as "network_error". Twilio's states carry no colon and pass unchanged.
 */
function testCodeKey(code: string | null | undefined): string | null {
  const key = (code ?? "").split(":")[0].trim();
  return key || null;
}

/**
 * A failed Test's plain words for one app's keys, from the code the Test
 * returned: the same words the app's card shows once the result is recorded.
 * Null when the app names no words for that code.
 */
export function testFailureWords(service: string, code: string | null | undefined): TestState | null {
  const key = testCodeKey(code);
  if (!key) return null;
  for (const def of CONNECTOR_CATALOG) {
    const source = def.live?.source;
    if (source?.kind !== "tenant_keys" || source.service !== service || !source.failureStates) continue;
    if (Object.prototype.hasOwnProperty.call(source.failureStates, key)) return source.failureStates[key];
  }
  return null;
}

/** The newest real check of one app's server-set values that still describes them, or null. */
function newestServerCheck(checks: readonly ServerCheckFact[], service: string): ServerCheckFact | null {
  let best: ServerCheckFact | null = null;
  let bestMs = -Infinity;
  for (const c of checks) {
    const ms = Date.parse(c.checked_at);
    if (c.service !== service || c.outdated || !Number.isFinite(ms) || ms <= bestMs) continue;
    best = c;
    bestMs = ms;
  }
  return best;
}

function keyedStatus(
  source: Extract<ConnectorStatusSource, { kind: "tenant_keys" | "oauth_tokens" }>,
  keyRows: readonly KeyRowFact[],
  serverChecks: readonly ServerCheckFact[] | null,
  nowMs: number,
  appName: string,
): ConnectorStatus {
  const own = keyRows.filter((r) => r.service === source.service);
  if (!own.some((r) => r.has_value)) return { kind: "not_connected", label: "Not connected" };

  // Values OASIS sets on its own server (source "environment") have no saved
  // row for a Test to record on. Their newest real check stands in as their
  // result (lib/integrations/server-checks.ts): the workspace's last Test of
  // them or, for Google, the last time OASIS's own sender signed in to send. A
  // saved value keeps its own result. A check that could not be read leaves
  // the card unknown, never "not tested".
  const onServer = source.kind === "tenant_keys" && own.some((r) => r.has_value && r.source === "environment");
  if (onServer && serverChecks === null) return UNKNOWN;
  const check = onServer ? newestServerCheck(serverChecks ?? [], source.service) : null;
  const rows: readonly KeyRowFact[] = check
    ? own.map((r) =>
        r.has_value && r.source === "environment"
          ? { ...r, last_tested_at: check.checked_at, last_test_ok: check.ok, last_test_error: check.code }
          : r,
      )
    : own;
  const present = (field: string) => rows.some((r) => r.field_key === field && r.has_value);

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
    const code = testCodeKey(failed.find((r) => r.last_tested_at === newest)?.last_test_error);
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
  if (verifiedAt) {
    // The pass is OASIS's own sender's last send (Google on OASIS's server),
    // not a Test: the card says which.
    const bySend = check?.via === "send" && check.ok && check.checked_at === verifiedAt;
    // An old pass is not "Connected" forever (KEY_CHECK_FRESH_MS).
    if (nowMs - Date.parse(verifiedAt) > KEY_CHECK_FRESH_MS) {
      const day = formatCheckDate(verifiedAt);
      return bySend
        ? {
            kind: "configured",
            label: `Set up · last send worked ${day}`,
            detail: `OASIS last sent an email from this mailbox on ${day}, more than a week ago. Run Test to check it now.`,
          }
        : {
            kind: "configured",
            label: `Set up · last tested ${day}`,
            detail: `The last Test passed on ${day}, more than a week ago. Nothing re-checks these keys on its own: run Test to check them now.`,
          };
    }
    const ago = formatVerifiedAgo(verifiedAt, nowMs);
    if (bySend) {
      return {
        kind: "connected",
        label: `Connected · last send worked ${ago}`,
        detail: `OASIS's own email sender signed in to Gmail and sent an email from this mailbox ${ago}.`,
      };
    }
    return {
      kind: "connected",
      label: `Connected · verified ${ago}`,
      detail:
        check?.ok && check.checked_at === verifiedAt
          ? `The last Test checked the ${appName} details set on OASIS's own server and passed.`
          : "The last connection test called the provider and passed.",
    };
  }
  // Every value is OASIS's own, set on its server (an OASIS workspace with
  // nothing saved here), and no check of them is recorded yet, or the last
  // Test checked values the server has since changed (a rotated secret): that
  // result, a pass or a failure, says nothing about the values in use.
  if (rows.filter((r) => r.has_value).every((r) => r.source === "environment")) {
    const outdated = onServer ? (serverChecks ?? []).find((c) => c.service === source.service && c.via === "test" && c.outdated) : undefined;
    if (outdated) {
      const day = formatCheckDate(outdated.checked_at);
      return {
        kind: "configured",
        label: "Set up on OASIS's server · changed since the last Test",
        detail: `The ${appName} details set on OASIS's own server changed after the last Test (${day}), so its result no longer applies. Run Test to check the details in use.`,
      };
    }
    return {
      kind: "configured",
      label: "Set up on OASIS's server · not tested yet",
      detail: `This workspace uses ${appName} details set on OASIS's own server. Run Test so OASIS checks them with ${appName}.`,
    };
  }
  return {
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
    // Stripe only: the key store may also hold a separate secret key
    // (checkout links, and OASIS's own books). It is not this connection and
    // never makes it green, but an owner deserves to know both exist, and where
    // the other one's state is shown.
    const legacyKey =
      provider === "stripe"
        ? keyRows?.find((r) => r.service === "stripe" && r.field_key === "secret_key" && r.has_value) ?? null
        : null;
    return {
      kind: "not_connected",
      label: "Not connected",
      detail: !legacyKey
        ? undefined
        : legacyKey.source === "environment"
          ? "This card is the read-only connection, and it is not connected. OASIS's own Stripe secret key is set on its server for its books and checkout links: whether the books are reading Stripe is shown under Money > Settings."
          : "This card is the read-only connection, and it is not connected. A Stripe secret key is also saved for checkout links; that key is separate and is never used as this connection.",
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
      // A sign-in at the vendor's own page never had a "key"; it had a
      // consent that expired or was refused (Codex review, PR #574).
      return def.live?.connect.kind === "oauth"
        ? {
            kind: "attention",
            label: "Sign-in expired · reconnect",
            detail: row.last_health_detail ?? `${def.name} stopped accepting this sign-in. Reconnect it.`,
            account,
          }
        : {
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
  const waiting = p.built && p.needsOasisApp && oasisAppMissing;
  const state = !p.built ? "Not built yet" : waiting ? "Not set up on this deployment" : "Available";
  // While OASIS's app is missing the drawer hides the button the body names,
  // so the body says it describes how it WILL work, not a button to press now.
  // A leading sentence, never a re-cased splice ("oASIS's" when a body opens
  // with a proper noun).
  const body = waiting ? `Available once OASIS's app is set up here. ${p.body}` : p.body;
  return { title: p.title, body, state, requestable: !p.built };
}

/**
 * The status a card shows. Pure: the same facts and `nowMs` always give the
 * same words, which is what lets the test feed it hostile inputs.
 */
/**
 * A card that cannot connect on THIS deployment because OASIS's own app for the
 * vendor is not set up here (Worker secrets missing), or is private to OASIS's
 * login (ConnectorDef.clientsUnavailable). It claims nothing about a vendor
 * registration or a date: it says the state.
 *
 *   A verified platform operator (`missing` given): which Worker secret names
 *   to add.
 *   Anyone else, a client or a member of OASIS's own workspace: "Not available
 *   on this workspace yet", and that nothing is wrong on their side. A secret
 *   name is never shown to them.
 */
export const UNAVAILABLE_LABEL = "Not available on this workspace yet";

export function unavailableStatus(def: ConnectorDef, missing?: readonly string[]): ConnectorStatus {
  return {
    kind: "coming_soon",
    label: UNAVAILABLE_LABEL,
    detail:
      missing && missing.length > 0
        ? `OASIS's ${def.name} app is not set up on this deployment. Missing Worker secrets: ${missing.join(", ")}. Add them in Cloudflare, then this card connects with one click.`
        : `${def.name} isn't available yet for this workspace. Nothing is wrong on your side: OASIS has to switch it on first.`,
  };
}

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
    // A workspace that already connected is never told the app is unavailable:
    // its connection is real, it needs to see it and keep its Disconnect, and
    // the missing app is an attention state.
    const connectedRow = facts.connections?.find((c) => c.provider === source.provider && c.status !== "revoked") ?? null;
    const alreadyConnected = !!connectedRow;
    if (oasisAppMissing && alreadyConnected) {
      return withPaths({
        kind: "attention",
        label: "Connected · needs attention",
        // Provider-neutral: "messages may not arrive" was Slack-only wording
        // and means nothing for QuickBooks, Xero or Zoom (Codex review, PR
        // #574). Also carries the account name on, same as every other status.
        detail: `OASIS can't check or renew this connection here until ${def.name}'s app is set up again on this deployment. You can still disconnect.`,
        account: accountLine(connectedRow),
        appMissing: true,
      });
    }
    if (oasisAppMissing && (mine.length === 0 || mine.every((p) => p.needsOasisApp))) {
      return withPaths(unavailableStatus(def, facts.appSecretsMissing?.[source.provider]));
    }
    if (!facts.connections) return withPaths(UNKNOWN);
    // A workspace whose every way in is not built yet cannot connect, unless it
    // already is: the state, with the request in the drawer, never "Not connected".
    if (!alreadyConnected && mine.length > 0 && mine.every((p) => !p.built)) {
      const how = mine[0].title.charAt(0).toLowerCase() + mine[0].title.slice(1);
      return withPaths({ kind: "coming_soon", label: "Not built yet", detail: `Connecting ${def.name} with ${how} is not built yet.` });
    }
    return withPaths(frameworkStatus(def, source.provider, facts.connections, facts.keyRows, nowMs));
  }
  if (!facts.keyRows) return UNKNOWN;
  // OASIS's app is private to OASIS's own login (Constant Contact): a client
  // workspace that has not connected is told it is not available here yet,
  // instead of a Connect button that answers "not enabled for your workspace".
  if (def.clientsUnavailable && facts.oasisWorkspace === false) {
    const own = keyedStatus(source, facts.keyRows, [], nowMs, def.name);
    if (own.kind === "not_connected") return unavailableStatus(def);
  }
  const workspace = keyedStatus(source, facts.keyRows, facts.serverChecks === undefined ? [] : facts.serverChecks, nowMs, def.name);
  if (def.yourAccount !== "google" || facts.personalGoogle === undefined) return workspace;
  // Google also has a per-person connection. The card is the WORKSPACE's
  // shared mailbox, and its state is only that; the viewer's own account is
  // reported beside it, in the same words Settings and Today use for it
  // (personalGoogleStatus), never folded into the card's state.
  const yours = personalGoogleStatus(facts.personalGoogle);
  const mailbox: ConnectorStatus =
    workspace.kind === "not_connected"
      ? {
          ...workspace,
          label: yours.state === "ready" ? "Your account connected · no shared mailbox" : "No shared mailbox",
          detail: "No shared workspace mailbox is set up.",
        }
      : workspace;
  return { ...mailbox, detail: [mailbox.detail, `Your own Google account: ${yours.label}.`].filter(Boolean).join(" ") };
}

/**
 * A card status that must override a line elsewhere claiming the app works.
 * The department tab and the AI Team say where a department answers in Slack
 * from lib/slack/status.ts, which only knows that a connection row exists,
 * whatever its state: an expired or failing connection still read "Answers
 * @mentions in #sales" while its card said "Key no longer accepted". When the
 * card's own status is a problem or could not be read, those lines say so
 * instead of the channels (null: the card is fine, the line stands):
 *
 *   attention  the card's problem, in its own words: the app answers nobody
 *              until it is fixed
 *   unknown    the card could not be checked: said as that, never as the app
 *              being broken
 */
export type ConnectionProblem = { kind: "attention" | "unknown"; label: string };

export function connectionProblem(status: ConnectorStatus | null): ConnectionProblem | null {
  if (!status) return null;
  return status.kind === "attention" || status.kind === "unknown" ? { kind: status.kind, label: status.label } : null;
}

/** The workspace has this app set up (whatever its last check said): a line may name it. */
export function connectionSetUp(status: ConnectorStatus | null): boolean {
  return !!status && (status.kind === "connected" || status.kind === "configured" || status.kind === "attention");
}

// -- Your own connections ------------------------------------------------------

/**
 * Where the viewer's own Google account stands, in one word set:
 *
 *   ready          authorized with Calendar access, as the viewer's work email
 *   wrong_account  authorized as a different address than the work email, so
 *                  client invitations refuse it (calendar_organizer_mismatch)
 *   reconnect      authorized, but without Calendar access (or without an
 *                  address OASIS can match), so it must be granted once more
 *   not_linked     nothing authorized for this login
 *   unknown        the read failed: never "not connected"
 *
 * The same predicate the booking path enforces (lib/integrations/
 * google-calendar.ts): a refresh token, the Calendar events scope, and the
 * connected address equal to the viewer's work email.
 */
export type PersonalGoogleState = "ready" | "wrong_account" | "reconnect" | "not_linked" | "unknown";

export function personalGoogleState(fact: PersonalGoogleFact | null): PersonalGoogleState {
  if (!fact) return "unknown";
  if (!fact.linked) return "not_linked";
  const address = (fact.address ?? "").trim().toLowerCase();
  const work = (fact.workEmail ?? "").trim().toLowerCase();
  if (work && address && address !== work) return "wrong_account";
  if (fact.calendarScope && work && address === work) return "ready";
  return "reconnect";
}

/** The viewer's own Google account, as every screen about it says it. Never green: nothing re-checks the grant on page load. */
export function personalGoogleStatus(fact: PersonalGoogleFact | null): ConnectorStatus & { state: PersonalGoogleState } {
  const state = personalGoogleState(fact);
  const address = fact?.address?.trim() || "an address OASIS could not read";
  switch (state) {
    case "ready":
      return {
        state,
        kind: "configured",
        label: "Connected",
        detail: `Connected as ${address}. Your Gmail sends and Calendar invites with Google Meet use this account. OASIS does not re-check it on every visit.`,
      };
    case "wrong_account":
      return {
        state,
        kind: "attention",
        label: "Wrong Google account",
        detail: `Connected as ${address}, but your invitations must come from ${fact?.workEmail?.trim() || "your work email"}. Reconnect with that account.`,
      };
    case "reconnect":
      // One state, said by its cause: only a grant without Calendar is
      // "without Calendar access" (the same predicate as before; only the words).
      return {
        state,
        kind: "attention",
        label: "Reconnect once",
        detail: !fact?.calendarScope
          ? `Connected as ${address}, but without Calendar access. Reconnect once so OASIS can send Calendar invites with Google Meet.`
          : !fact.address?.trim()
            ? "Connected, but Google did not say which address it is, so OASIS cannot match it to your work email. Reconnect once."
            : `Connected as ${address}, but your profile has no work email for OASIS to match it to, so client invitations cannot use it yet. Reconnect once with your work account after an owner or admin adds your work email.`,
      };
    case "not_linked":
      return { state, kind: "not_connected", label: "Not connected", detail: "No Google account is connected for your login." };
    default:
      return {
        state,
        kind: "unknown",
        label: "Status unavailable",
        detail: "OASIS could not check your Google account right now. That does not mean it is disconnected.",
      };
  }
}

/**
 * The viewer's own Telegram bot, in one word set for Settings > Notifications
 * and the bot's setup card. Nothing in OASIS sends to a personal bot yet (no
 * sender reads it), so a linked bot is "Linked", never "Connected" or a promise
 * of alerts.
 */
export function personalTelegramStatus(fact: PersonalTelegramFact | null): ConnectorStatus {
  if (!fact) {
    return {
      kind: "unknown",
      label: "Status unavailable",
      detail: "OASIS could not check your Telegram bot right now. That does not mean it is disconnected.",
    };
  }
  if (fact.botSaved && fact.chatLinked) {
    return {
      kind: "configured",
      label: fact.username ? `Linked · @${fact.username}` : "Linked",
      detail: "Your own bot is linked to your Telegram chat. OASIS does not send alerts to personal bots yet.",
    };
  }
  if (fact.botSaved) {
    return {
      kind: "attention",
      label: "Bot saved · chat not linked yet",
      detail: "Open your bot in Telegram, tap Start, then finish linking.",
    };
  }
  return {
    kind: "not_connected",
    label: "Not set up",
    detail: "You have no personal Telegram bot. OASIS does not send alerts to personal bots yet.",
  };
}

// -- The workspace at a glance ----------------------------------------------

/**
 * Every built connector's status, counted: how many apps the workspace has set
 * up (connected, set up but unverified, or needing attention), how many of
 * those need the owner, how many a live check has proven, and how many could
 * not be checked. From resolveConnectorStatus, so the rail's Connections dot,
 * the Operations tab and the hub's own cards can never tell different stories.
 * Apps not connected and apps not built yet are not counted: neither is a
 * problem. It is the WORKSPACE's count: a card's kind never depends on the
 * viewer's own accounts (those are reported in its detail line), so two people
 * in one workspace always get the same numbers.
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
