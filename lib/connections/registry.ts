/**
 * lib/connections/registry.ts — the providers a CLIENT tenant can connect
 * through the Connections framework (docs/os-revamp/03 §a.3).
 *
 * Operator-only integrations (kraken, oanda, obsidian, …) stay in
 * lib/integrations-registry.ts and never appear here. The hub's card copy and
 * logos live in lib/os/connectors.ts, keyed by the same slug: a ProviderDef's
 * `id` IS its catalog slug and its /api/connections/[provider] segment, and
 * tests/os-connections.test.ts holds the two lists together.
 *
 * AVAILABILITY IS HONEST. A provider is "live" only when OASIS can complete a
 * real connection for it on this deployment. An OAuth provider needs OASIS's
 * own app for that vendor (its client id and secret, Worker secrets), so its
 * static row is "coming_soon": the connect route refuses it with a 409, and no
 * button anywhere pretends otherwise. Their scopes are recorded so the
 * minimum-scope decision (doc 03 a.5) is made once, in review.
 *
 * Slack, QuickBooks, Xero, Zoom and WhatsApp name the Worker secrets that hold
 * OASIS's app for that vendor (`liveWhenEnv`), and providerAvailability() makes
 * each live only on a deployment where all of them are set. Every caller that
 * decides "can this connect here?" asks providerForEnv(), never the static row.
 * Plaid, Meta Ads, Discord and Microsoft Teams do not connect through this
 * file at all: they take a key or webhook the client pastes into the key store
 * (lib/tenant-integration-schemas.ts), and their rows below are not offered.
 *
 * PURE DATA. No fetch, no server import, and no env read of its own (the env
 * is passed in) — the probes live in lib/connections/health.ts, keyed by
 * provider id.
 */

import type { DepartmentKey } from "@/lib/os/types";
import { isExclusiveProvider, type AuthKind, type ScopeKind } from "@/lib/connections/rules";

export type ProviderAvailability = "live" | "coming_soon";

export type OAuthAppConfig = {
  authorizeUrl: string;
  tokenUrl: string;
  /** Worker secret NAMES (never values). App credentials come from Worker secrets only (doc 03 a.1 principle 2). */
  clientIdEnv: string;
  clientSecretEnv: string;
  /** Send an S256 PKCE challenge. */
  pkce: boolean;
  /** Joined with this when the provider wants something other than a space. */
  scopeSeparator?: string;
  extraAuthorizeParams?: Readonly<Record<string, string>>;
};

export type RestrictedKeyConfig = {
  /** The field_key the key is stored under, inside the connection's credential service. */
  credentialField: string;
  /** What the owner turns on, in the provider's own words. */
  readPermissions: readonly string[];
  /** Step-by-step, in plain English. */
  setupSteps: readonly string[];
  /** One sentence on what the key can and cannot do. */
  accessSummary: string;
  /** The key field's label, when it is not a Stripe "Restricted key". */
  inputLabel?: string;
  placeholder?: string;
  /** The line under the field: how the key is checked before it is saved. */
  checkNote?: string;
};

export type ProviderDef = {
  /** = lib/os/connectors.ts slug = the [provider] route segment. */
  id: string;
  label: string;
  /** Doc 03 b.2 wave. */
  wave: 1 | 2 | 3;
  availability: ProviderAvailability;
  authKind: AuthKind;
  scopeKind: ScopeKind;
  /** One external account → one tenant. Derived from rules.EXCLUSIVE_PROVIDERS. */
  exclusive: boolean;
  departments: readonly DepartmentKey[];
  /**
   * Minimum scopes, requested incrementally by department (doc 03 a.1 principle
   * 3): `base` always, plus the union of `byDepartment` for the departments the
   * tenant turned on.
   */
  scopes: {
    base: readonly string[];
    byDepartment: Readonly<Partial<Record<DepartmentKey, readonly string[]>>>;
  };
  /** Why a coming-soon provider cannot connect yet. */
  blockedOn?: string;
  /**
   * Worker secret NAMES that, all present, make a coming_soon provider live on
   * this deployment (providerAvailability). Slack: OASIS's own Slack app. Absent
   * any one, the provider stays coming_soon and every surface says why.
   */
  liveWhenEnv?: readonly string[];
  oauth?: OAuthAppConfig;
  restrictedKey?: RestrictedKeyConfig;
};

/**
 * The Read permissions a client's Stripe restricted key needs (doc 03 a.5).
 * Everything else stays at None — above all, nothing with Write.
 */
export const STRIPE_READ_PERMISSIONS: readonly string[] = [
  "Balance",
  "Balance transactions",
  "Charges",
  "Refunds",
  "Customers",
  "Disputes",
  "Events",
  "Invoices",
  "Payouts",
  "Prices",
  "Products",
  "Subscriptions",
];

const def = (d: Omit<ProviderDef, "exclusive">): ProviderDef => ({ ...d, exclusive: isExclusiveProvider(d.id) });

export const PROVIDERS: readonly ProviderDef[] = [
  def({
    id: "stripe",
    label: "Stripe",
    wave: 1,
    availability: "live",
    authKind: "restricted_key",
    scopeKind: "tenant",
    departments: ["finance", "sales"],
    // Scope ids for the audit trail: resource:read, one per permission above.
    scopes: {
      base: STRIPE_READ_PERMISSIONS.map((p) => `${p.toLowerCase().replace(/\s+/g, "_")}:read`),
      byDepartment: {},
    },
    restrictedKey: {
      credentialField: "restricted_key",
      readPermissions: STRIPE_READ_PERMISSIONS,
      setupSteps: [
        "In Stripe, open Developers › API keys and choose Create restricted key.",
        "Name it OASIS.",
        "Set each permission listed below to Read. Stripe groups a few of them together — Read on the group is fine.",
        "Leave every other permission at None. OASIS never needs Write.",
        "Create the key, copy it (it starts with rk_live_ or rk_test_) and paste it here.",
      ],
      accessSummary:
        "Read-only. OASIS can see your balance, payments, customers, invoices, subscriptions and payouts. It cannot charge a card, issue a refund or move money, and it refuses full secret keys (sk_…) so it never could.",
    },
  }),
  def({
    id: "quickbooks",
    label: "QuickBooks",
    wave: 1,
    availability: "coming_soon",
    authKind: "oauth2",
    scopeKind: "tenant",
    departments: ["finance"],
    // Intuit has no read-only accounting scope; OASIS's client will issue GET
    // only, enforced in code and by test when this goes live (doc 03 a.5).
    scopes: { base: ["com.intuit.quickbooks.accounting"], byDepartment: {} },
    blockedOn: "OASIS's Intuit app and Intuit's app assessment.",
    liveWhenEnv: ["INTUIT_CLIENT_ID", "INTUIT_CLIENT_SECRET", "CONNECTIONS_OAUTH_STATE_SECRET"],
    oauth: {
      authorizeUrl: "https://appcenter.intuit.com/connect/oauth2",
      tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
      clientIdEnv: "INTUIT_CLIENT_ID",
      clientSecretEnv: "INTUIT_CLIENT_SECRET",
      pkce: false,
    },
  }),
  def({
    id: "xero",
    label: "Xero",
    wave: 1,
    availability: "coming_soon",
    authKind: "oauth2",
    scopeKind: "tenant",
    departments: ["finance"],
    // Read-only granular scopes (Xero assigned them to every web app in March
    // 2026; the broad accounting.transactions.read is deprecated) plus
    // offline_access for a refresh token. Confirmed against
    // developer.xero.com/documentation/guides/oauth2/scopes, 2026-10-10.
    scopes: {
      base: [
        "openid",
        "offline_access",
        "accounting.invoices.read",
        "accounting.payments.read",
        "accounting.banktransactions.read",
        "accounting.contacts.read",
        "accounting.settings.read",
        "accounting.reports.profitandloss.read",
        "accounting.reports.balancesheet.read",
      ],
      byDepartment: {},
    },
    blockedOn: "OASIS's Xero app credentials.",
    liveWhenEnv: ["XERO_CLIENT_ID", "XERO_CLIENT_SECRET", "CONNECTIONS_OAUTH_STATE_SECRET"],
    // A web app with a client secret uses the standard code flow (Basic auth at
    // the token endpoint); PKCE is Xero's flow for apps that hold no secret.
    oauth: {
      authorizeUrl: "https://login.xero.com/identity/connect/authorize",
      tokenUrl: "https://identity.xero.com/connect/token",
      clientIdEnv: "XERO_CLIENT_ID",
      clientSecretEnv: "XERO_CLIENT_SECRET",
      pkce: false,
    },
  }),
  def({
    id: "plaid",
    label: "Plaid",
    wave: 1,
    availability: "coming_soon",
    authKind: "bank_link",
    scopeKind: "tenant",
    departments: ["finance"],
    // Plaid "products", not OAuth scopes: balances and transactions, read-only.
    scopes: { base: ["transactions", "balance"], byDepartment: {} },
    blockedOn: "OASIS's Plaid team (Trial) credentials.",
  }),
  def({
    id: "meta",
    label: "Meta",
    wave: 2,
    availability: "coming_soon",
    authKind: "system_user",
    scopeKind: "tenant",
    departments: ["marketing"],
    scopes: {
      base: ["ads_read", "pages_show_list"],
      byDepartment: {
        marketing: [
          "ads_management",
          "leads_retrieval",
          "pages_read_engagement",
          "pages_manage_ads",
          "pages_manage_metadata",
        ],
      },
    },
    blockedOn: "OASIS's Meta app, Business Verification and App Review.",
  }),
  def({
    id: "slack",
    label: "Slack",
    wave: 2,
    // Live only on a deployment that holds OASIS's Slack app (liveWhenEnv):
    // the install needs the client id and secret, every event and button press
    // is verified with the signing secret, and the consent state is signed with
    // its own secret (lib/connections/oauth.ts, no fallback).
    availability: "coming_soon",
    authKind: "app_install",
    scopeKind: "tenant",
    departments: ["chief_of_staff", "sales", "marketing", "client_success"],
    // Read the channels it is added to and the mentions of it, name the people
    // who wrote (users:read, and users:read.email to link a teammate), post
    // replies. No private channels, no DMs, no admin scopes.
    scopes: {
      base: [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "users:read",
        "users:read.email",
        "team:read",
        "commands",
      ],
      byDepartment: {},
    },
    blockedOn: "OASIS's Slack app credentials.",
    liveWhenEnv: ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET", "CONNECTIONS_OAUTH_STATE_SECRET"],
    oauth: {
      authorizeUrl: "https://slack.com/oauth/v2/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.access",
      clientIdEnv: "SLACK_CLIENT_ID",
      clientSecretEnv: "SLACK_CLIENT_SECRET",
      pkce: false,
      scopeSeparator: ",",
    },
  }),
  def({
    id: "gohighlevel",
    label: "GoHighLevel",
    wave: 1,
    availability: "coming_soon",
    authKind: "oauth2",
    scopeKind: "tenant",
    departments: ["sales", "marketing"],
    // Read by default. Write scopes are added only when a tenant turns on
    // "send through GoHighLevel" (doc 03 a.5).
    scopes: {
      base: [
        "contacts.readonly",
        "opportunities.readonly",
        "calendars.readonly",
        "calendars/events.readonly",
        "conversations.readonly",
        "locations.readonly",
      ],
      byDepartment: {},
    },
    blockedOn: "OASIS's GoHighLevel app credentials.",
    oauth: {
      authorizeUrl: "https://marketplace.gohighlevel.com/oauth/chooselocation",
      tokenUrl: "https://services.leadconnectorhq.com/oauth/token",
      clientIdEnv: "GHL_CLIENT_ID",
      clientSecretEnv: "GHL_CLIENT_SECRET",
      pkce: false,
    },
  }),
  def({
    id: "zoom",
    label: "Zoom",
    wave: 2,
    availability: "coming_soon",
    authKind: "oauth2",
    scopeKind: "tenant",
    departments: ["sales", "client_success"],
    // Scopes are fixed on the Zoom app itself at creation and Marketplace
    // review, so the authorize URL carries none.
    scopes: { base: [], byDepartment: {} },
    blockedOn: "OASIS's Zoom app and Zoom Marketplace review.",
    liveWhenEnv: ["ZOOM_CLIENT_ID", "ZOOM_CLIENT_SECRET", "CONNECTIONS_OAUTH_STATE_SECRET"],
    oauth: {
      authorizeUrl: "https://zoom.us/oauth/authorize",
      tokenUrl: "https://zoom.us/oauth/token",
      clientIdEnv: "ZOOM_CLIENT_ID",
      clientSecretEnv: "ZOOM_CLIENT_SECRET",
      pkce: false,
    },
  }),
  def({
    // WhatsApp Business Platform (Cloud API) through Meta's Facebook Login: a
    // business approves OASIS's Meta app for its WhatsApp Business Account.
    // Meta issues a token and no refresh token; it is extended by exchanging
    // the current one (lib/connections/oauth-adapters.ts).
    id: "whatsapp",
    label: "WhatsApp",
    wave: 2,
    availability: "coming_soon",
    authKind: "oauth2",
    scopeKind: "tenant",
    departments: ["sales", "client_success"],
    scopes: { base: ["whatsapp_business_management", "whatsapp_business_messaging"], byDepartment: {} },
    blockedOn: "OASIS's Meta app with WhatsApp access.",
    liveWhenEnv: ["META_APP_ID", "META_APP_SECRET", "CONNECTIONS_OAUTH_STATE_SECRET"],
    oauth: {
      authorizeUrl: "https://www.facebook.com/v23.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v23.0/oauth/access_token",
      clientIdEnv: "META_APP_ID",
      clientSecretEnv: "META_APP_SECRET",
      pkce: false,
      scopeSeparator: ",",
    },
  }),
  def({
    // Jev: TypeSafe's System One model, a fast classifier. Each workspace pastes
    // its OWN TypeSafe key; OASIS holds no key for anyone. It only ever answers
    // "which one of these" questions in shadow (lib/jev/mode.ts): it never
    // decides, sends or changes anything.
    id: "jev",
    label: "Jev (TypeSafe)",
    wave: 3,
    availability: "live",
    authKind: "restricted_key",
    scopeKind: "tenant",
    departments: [],
    scopes: { base: [], byDepartment: {} },
    restrictedKey: {
      credentialField: "api_key",
      readPermissions: [],
      setupSteps: [
        "Create an API key in your TypeSafe account (docs.typesafe.ai describes where). Name it OASIS so you can revoke it on its own.",
        "Copy it and paste it here.",
      ],
      accessSummary:
        "OASIS can ask Jev to classify text. OASIS never lets Jev's answer send, decide or change anything on its own.",
      inputLabel: "TypeSafe API key",
      placeholder: "Paste your TypeSafe API key",
      checkNote:
        "OASIS checks the key by listing the models it may use, which sends none of your data, then stores it encrypted.",
    },
  }),
];

/**
 * A provider connected through the generic OAuth sign-in over OASIS's own app
 * (lib/connections/oauth-connect.ts): OAuth 2, with app secrets named for this
 * deployment. Slack has its own install (authKind app_install); GoHighLevel's
 * card connects with a token, so it has no secrets named here.
 */
export function isGenericOAuthProvider(p: ProviderDef): boolean {
  return p.authKind === "oauth2" && !!p.oauth && (p.liveWhenEnv?.length ?? 0) > 0;
}

export const GENERIC_OAUTH_PROVIDER_IDS: readonly string[] = PROVIDERS.filter(isGenericOAuthProvider).map((p) => p.id);

export function providerById(id: string): ProviderDef | null {
  return PROVIDERS.find((p) => p.id === id) ?? null;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Whether a provider can be connected on THIS deployment. A provider marked
 * live is live. A coming_soon provider with `liveWhenEnv` becomes live only
 * while every named Worker secret is set (non-blank); otherwise it stays
 * coming_soon. Pure: the caller passes the env (process.env on the server).
 */
export function providerAvailability(provider: ProviderDef, env: Env): ProviderAvailability {
  if (provider.availability === "live") return "live";
  const needs = provider.liveWhenEnv ?? [];
  if (needs.length === 0) return "coming_soon";
  return needs.every((name) => (env[name] || "").trim().length > 0) ? "live" : "coming_soon";
}

/** The provider as this deployment sees it: `availability` resolved against the env. */
export function providerForEnv(id: string, env: Env): ProviderDef | null {
  const p = providerById(id);
  if (!p) return null;
  const availability = providerAvailability(p, env);
  return availability === p.availability ? p : { ...p, availability };
}

/** The secret names a coming_soon provider still needs here, for the "not configured yet" copy. Names only. */
export function missingProviderEnv(provider: ProviderDef, env: Env): string[] {
  return (provider.liveWhenEnv ?? []).filter((name) => !(env[name] || "").trim());
}

/**
 * The scopes to request for the departments a tenant uses: `base` plus each
 * department's extras, de-duplicated, in a stable order.
 */
export function scopesForDepartments(provider: ProviderDef, departments: readonly DepartmentKey[]): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  provider.scopes.base.forEach(add);
  for (const d of departments) (provider.scopes.byDepartment[d] ?? []).forEach(add);
  return out;
}
