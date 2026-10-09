/**
 * lib/tenant-integration-schemas.ts — pure type + constants module
 * describing each integration's field shape. Safe to import from
 * client components: no "server-only", no DB calls, no env access.
 *
 * Split out of lib/tenant-integration-store.ts (which is
 * "server-only") so the Settings paste UI can render the schema
 * list in the browser without dragging field-encryption + supabase
 * imports into the client bundle.
 */

export type IntegrationFieldDef = {
  key: string;
  label: string;
  hint?: string;
  /** Render as a password input (masked). */
  sensitive: boolean;
  /** Server-side pattern check applied at upsert. */
  validation?:
    | "phone_e164"
    | "url"
    | "email"
    | "alphanum_uppercase"
    | "twilio_sid"
    | "public_hostname"
    | "smtp_port"
    | "single_line_token";
  /** twilio_sid: the two letters this SID starts with (AC account, SK API key, MG messaging service). */
  sidPrefix?: "AC" | "SK" | "MG";
  /** Not needed for the app to work (a label that says "(optional)" counts too). */
  optional?: boolean;
  /** Shown inside the empty input, never a real value. */
  placeholder?: string;
  /**
   * Where the saved secret(s) named here are SENT (a mail server's host and
   * port). Changing this field clears those secrets in
   * the same save, so a secret is never sent anywhere it was not entered for:
   * it must be pasted again for the new address (app/api/integrations/keys).
   */
  bindsSecrets?: readonly string[];
};

export type IntegrationSchema = {
  service: string;
  label: string;
  description: string;
  fields: IntegrationFieldDef[];
  /**
   * Storage scope. Phase 4 of multi-employee personalization
   * (2026-05-29):
   *
   *   - "tenant" (default) — credential lives in the tenant_integration_
   *     credentials table. Shared by every team member. Used for
   *     services where billing/identity goes through the tenant owner
   *     (Twilio, TextTorrent, Kixie, Stripe, etc.).
   *
   *   - "user_only" — credential lives in user_integration_credentials.
   *     Per-employee, never tenant-shared. Used when each employee
   *     MUST authenticate as themselves (Gmail OAuth — sends come
   *     from the employee's own address, not the owner's). The
   *     Settings UI renders these under the "Personal integrations"
   *     section instead of the tenant integrations grid.
   */
  scope?: "tenant" | "user_only";
  /**
   * How credentials are provisioned. OAuth-managed credentials are written by
   * their callback route and must never be pasted into the tenant key editor.
   */
  setup?: "manual" | "oauth";
  /**
   * 2026-06-08 — collapse advanced/edge-case integrations behind a
   * "Show advanced" toggle so the default view is clean for non-
   * technical operators. CC pass: Custom SMTP creates redundancy with
   * Google Workspace (Gmail) for most tenants; ngrok / self-hosted
   * SMTP / etc. only matter to operators who explicitly need them.
   */
  advanced?: boolean;
  /**
   * Where the owner creates the key in the vendor's own account, linked as
   * "Get your key" beside the fields (opens in a new tab).
   */
  getKey?: { href: string; label: string };
};

export const INTEGRATION_SCHEMAS: IntegrationSchema[] = [
  {
    service: "twilio",
    label: "Twilio",
    description:
      "Your own Twilio account: the Account SID, the Auth Token (or an API key), and a From Number or Messaging Service SID. Texts go out only while live texting is switched on; run Test before that, because a failed Test does not stop them.",
    fields: [
      // Twilio SIDs are two letters and 32 hex characters, usually lower case
      // (^AC[0-9a-fA-F]{32}$ in Twilio's API spec). alphanum_uppercase refused
      // every real one pasted from Twilio's console.
      { key: "account_sid", label: "Account SID", sensitive: false, validation: "twilio_sid", sidPrefix: "AC", hint: "Starts with AC. In Twilio: Account Info on the console home page." },
      { key: "auth_token", label: "Auth Token", sensitive: true, hint: "Account Info in Twilio. Needed for incoming texts: Twilio signs each one with it, and OASIS refuses any it cannot verify." },
      { key: "api_key_sid", label: "API key SID (optional)", sensitive: false, validation: "twilio_sid", sidPrefix: "SK", hint: "Starts with SK. With its secret below, OASIS sends with the key instead of the Auth Token." },
      { key: "api_key_secret", label: "API key secret (optional)", sensitive: true, hint: "Shown once when the key is created in Twilio (API keys & tokens)." },
      { key: "from_number", label: "From Number", sensitive: false, validation: "phone_e164", hint: "A number on this Twilio account that can text. E.164 format, e.g. +14165551212" },
      { key: "messaging_service_sid", label: "Messaging Service SID", sensitive: false, validation: "twilio_sid", sidPrefix: "MG", hint: "Optional MG... SID. When set, it replaces From Number for outbound sends." },
    ],
  },
  {
    service: "texttorrent",
    label: "TextTorrent",
    description:
      "TT API for the Text Torrent button on the lead drawer + bulk sequences. Text Torrent authenticates with TWO keys — the API SID (X-API-SID) and the API Public Key (X-API-PUBLIC-KEY), both under Text Torrent → Account → API. One shared pair across the team; each rep sets their own sending number under Settings → Personal integrations.",
    fields: [
      { key: "api_sid", label: "API SID (X-API-SID)", sensitive: true, hint: "Text Torrent → Account → API. The X-API-SID value." },
      { key: "api_public_key", label: "API Public Key (X-API-PUBLIC-KEY)", sensitive: true, hint: "Text Torrent → Account → API. The X-API-PUBLIC-KEY value." },
      { key: "api_key", label: "API Key (legacy)", sensitive: true, hint: "Legacy single-key field. Leave blank when the SID + Public Key above are set." },
      { key: "from_number", label: "Default Business Number", sensitive: false, validation: "phone_e164", hint: "E.164 format, e.g. +14165551212. Used for automated (Helios) sends and when a rep hasn't set their own number." },
    ],
  },
  {
    service: "kixie",
    label: "Kixie",
    description:
      "Click-to-call + SMS via Kixie. Powers the call button on the lead drawer, per-employee outbound numbers, and every call/SMS lifecycle webhook. Goal is full centralization — operators never need to open the Kixie app.",
    fields: [
      { key: "api_key", label: "API Key", sensitive: true, hint: "Kixie PowerCall → Settings → Integrations → REST API." },
      { key: "business_id", label: "Business ID", sensitive: false, hint: "Numeric tenant identifier shown next to the API key." },
      { key: "from_number", label: "Default Business Number", sensitive: false, validation: "phone_e164", hint: "E.164 format, e.g. +14165551212. Used when no per-employee Kixie line is set." },
      { key: "default_agent_email", label: "Default Agent Email", sensitive: false, validation: "email", hint: "Kixie agent that rings when no per-employee agent is specified. Usually Matt's Kixie login (submissions@sunbizfunding.com)." },
      { key: "webhook_secret", label: "Webhook Secret (HMAC-SHA256)", sensitive: true, hint: "Shared secret Kixie signs inbound webhooks with — set the same value in Kixie's webhook config UI. Required so we can verify webhook authenticity." },
    ],
  },
  {
    service: "gws",
    label: "Google Workspace (Gmail)",
    description:
      "The workspace's shared mailbox: email goes out from the Google Workspace address that owns the App Password. Test signs in to Gmail with both.",
    fields: [
      { key: "app_password", label: "App Password", sensitive: true, hint: "Generate at myaccount.google.com/apppasswords" },
      { key: "from_address", label: "Workspace email address", sensitive: false, validation: "email", hint: "The Google Workspace address that created this App Password." },
    ],
  },
  // Any mail server the workspace already sends from (its email host, Microsoft
  // 365, SendGrid, Amazon SES). Test signs in over SMTP (RFC 4954 AUTH) and sends
  // nothing. Only a public host name and a standard submission port are
  // accepted, so the Test can never be pointed at an internal address.
  {
    service: "smtp",
    label: "Email server (SMTP)",
    description:
      "The mail server your business already sends from: your email host, Microsoft 365, SendGrid or Amazon SES. Test signs in to it with these details and sends nothing.",
    fields: [
      { key: "host", label: "Server", sensitive: false, validation: "public_hostname", bindsSecrets: ["password"], placeholder: "smtp.example.com", hint: "Your provider's SMTP server name, e.g. smtp.office365.com or smtp.sendgrid.net. A public name, not an IP address." },
      { key: "port", label: "Port", sensitive: false, validation: "smtp_port", bindsSecrets: ["password"], placeholder: "587", hint: "587 (most providers), 465, 2525 or 25." },
      { key: "user", label: "Username", sensitive: false, hint: "Usually your full email address. SendGrid uses the word apikey." },
      { key: "password", label: "Password", sensitive: true, hint: "Your mailbox password, an app password, or the provider's SMTP key." },
      { key: "from_address", label: "Send from", sensitive: false, validation: "email", placeholder: "you@yourbusiness.com", hint: "The address your emails come from." },
    ],  },
  {
    service: "stripe",
    label: "Stripe",
    description: "Subscription billing + ARR widget.",
    fields: [
      { key: "secret_key", label: "Secret Key", sensitive: true, hint: "starts with sk_live_ or sk_test_" },
      { key: "publishable_key", label: "Publishable Key", sensitive: false, hint: "starts with pk_" },
    ],
  },
  // Zernio (formerly Late): Bearer API key, base https://zernio.com/api/v1;
  // GET /v1/profiles is the read-only check. https://docs.zernio.com and
  // https://docs.zernio.com/profiles/list-profiles.mdx (read 2026-10-09).
  {
    service: "late",
    label: "Zernio",
    description:
      "Your own Zernio (formerly Late) account: one API key. Test lists your Zernio profiles with it, which changes nothing.",
    fields: [
      { key: "api_key", label: "API key", sensitive: true, validation: "single_line_token", placeholder: "sk_...", hint: "In Zernio: Dashboard > API keys > Create API key. It starts with sk_ and is shown once." },
    ],
    getKey: { href: "https://zernio.com/dashboard/api-keys", label: "Get your Zernio API key" },
  },
  // Calendly Personal Access Token: Bearer; GET https://api.calendly.com/users/me
  // (scope users:read). https://developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens.md
  // and https://developer.calendly.com/openapi/calendly-api.yaml (read 2026-10-09).
  {
    service: "calendly",
    label: "Calendly",
    description:
      "A personal access token from your own Calendly account. Test asks Calendly who the token belongs to, which changes nothing.",
    fields: [
      { key: "access_token", label: "Personal access token", sensitive: true, validation: "single_line_token", hint: "In Calendly: Integrations > API & Webhooks > Generate new token. Calendly shows it once." },
    ],
    getKey: { href: "https://developer.calendly.com/docs/authentication/how-to-authenticate-with-personal-access-tokens", label: "Calendly's guide to personal access tokens" },
  },
  // Cal.com API v2: Bearer key (cal_live_... or cal_... for test);
  // GET https://api.cal.com/v2/me. https://cal.com/docs/api-reference/v2/introduction
  // and https://cal.com/docs/api-reference/v2/me/get-my-profile (read 2026-10-09).
  {
    service: "cal_com",
    label: "Cal.com",
    description:
      "An API key from your own Cal.com account. Test asks Cal.com whose key it is, which changes nothing.",
    fields: [
      { key: "api_key", label: "API key", sensitive: true, validation: "single_line_token", placeholder: "cal_live_...", hint: "In Cal.com: Settings > Developer > API keys > New. It starts with cal_live_." },
    ],
    getKey: { href: "https://cal.com/docs/api-reference/v2/introduction", label: "Cal.com's guide to API keys" },
  },
  // Fathom (the meeting notetaker, fathom.ai): X-Api-Key header, base
  // https://api.fathom.ai/external/v1; GET /meetings is the read-only check.
  // https://developers.fathom.ai/quickstart.md and
  // https://developers.fathom.ai/api-reference/meetings/list-meetings.md (read 2026-10-09).
  {
    service: "fathom",
    label: "Fathom",
    description:
      "An API key from your own Fathom account. Test lists your recent meetings with it, which changes nothing. A key sees only meetings you recorded or that were shared with you.",
    fields: [
      { key: "api_key", label: "API key", sensitive: true, validation: "single_line_token", hint: "In Fathom: Settings > API Access > Generate API key." },
    ],
    getKey: { href: "https://fathom.video/customize#api-access-header", label: "Get your Fathom API key" },
  },
  // Fireflies.ai GraphQL: POST https://api.fireflies.ai/graphql, Bearer key;
  // the `user` query with no id returns the key's owner.
  // https://docs.fireflies.ai/getting-started/quickstart and
  // https://docs.fireflies.ai/graphql-api/query/user (read 2026-10-09).
  {
    service: "fireflies",
    label: "Fireflies",
    description:
      "An API key from your own Fireflies account. Test asks Fireflies whose key it is, which changes nothing.",
    fields: [
      { key: "api_key", label: "API key", sensitive: true, validation: "single_line_token", hint: "In Fireflies: Integrations > Fireflies API > copy your API key." },
    ],
    getKey: { href: "https://docs.fireflies.ai/getting-started/quickstart", label: "Fireflies' guide to API keys" },
  },
  // GoHighLevel Private Integration Token: Bearer, Version 2021-07-28, base
  // https://services.leadconnectorhq.com; GET /locations/{locationId}.
  // https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken
  // and https://marketplace.gohighlevel.com/docs/ghl/locations/get-location (read 2026-10-09).
  {
    service: "gohighlevel",
    label: "GoHighLevel",
    description:
      "A private integration token from your own GoHighLevel account, and the sub-account it reads. Test asks GoHighLevel for that sub-account's name, which changes nothing.",
    fields: [
      { key: "private_token", label: "Private integration token", sensitive: true, validation: "single_line_token", placeholder: "pit-...", hint: "In GoHighLevel: Settings > Private Integrations > create one named OASIS. Give it read access to locations (sub-accounts), contacts and opportunities. GoHighLevel shows the token once." },
      { key: "location_id", label: "Sub-account (location) ID", sensitive: false, validation: "single_line_token", hint: "In the sub-account: Settings > Business Profile, or the part of the address after /location/." },
    ],
    getKey: { href: "https://marketplace.gohighlevel.com/docs/Authorization/PrivateIntegrationsToken", label: "GoHighLevel's guide to private integration tokens" },
  },
  {
    service: "telegram",
    label: "Telegram Bridge",
    description: "The workspace's team bot: one bot made in BotFather and the one chat it writes to. Test asks Telegram for both.",
    fields: [
      { key: "bot_token", label: "Bot Token", sensitive: true, hint: "BotFather sends it when you create the bot. It looks like 123456789:AAE... (numbers, a colon, then letters)." },
      { key: "chat_id", label: "Destination Chat ID", sensitive: false, hint: "The numeric user, group, or channel ID that receives workspace notifications (often starts with -100 for channels)." },
    ],
  },
  // Per-user OAuth integration. Migration 076 added the
  // user_integration_credentials table that backs this; the OAuth
  // start/callback routes (app/api/auth/google-oauth/*) populate the
  // fields automatically — the operator never pastes them by hand,
  // so all fields are marked sensitive=true but only refresh_token
  // is rendered as a password input in the rare manual-edit path.
  // OAuth integration, tenant-scoped: SunBiz sends email blasts from ONE
  // Constant Contact account (the org's), so the tokens are shared, not
  // per-employee. The connect flow (app/api/integrations/constant-contact/*)
  // auto-populates these — never pasted by hand.
  {
    service: "constant_contact",
    label: "Constant Contact",
    description:
      "Email blasts (templates, lists, open/click/bounce tracking). Connect once via OAuth; the API key + app secret come from the server env.",
    setup: "oauth",
    fields: [
      { key: "access_token", label: "Access Token", sensitive: true, hint: "Auto-populated by the OAuth flow." },
      { key: "refresh_token", label: "Refresh Token", sensitive: true, hint: "Auto-populated; rotates on each refresh." },
      { key: "expires_at", label: "Expires At", sensitive: false, hint: "epoch ms of access_token expiry." },
    ],
  },
  {
    service: "gmail_oauth",
    label: "Gmail (your personal account)",
    description:
      "Connect your own Gmail so outbound emails from the dashboard go from your address, not the workspace owner. Required scope: gmail.send (we cannot read your inbox).",
    scope: "user_only",
    setup: "oauth",
    fields: [
      { key: "refresh_token", label: "Refresh Token", sensitive: true, hint: "Auto-populated by the OAuth flow." },
      { key: "access_token", label: "Access Token", sensitive: true, hint: "Short-lived, refreshed on demand." },
      { key: "expires_at", label: "Expires At", sensitive: false, hint: "ISO timestamp of access_token expiry." },
      { key: "scope", label: "Granted Scope", sensitive: false },
      { key: "gmail_address", label: "Your Gmail Address", sensitive: false, validation: "email" },
    ],
  },
];

export function findIntegrationSchema(service: string): IntegrationSchema | null {
  return INTEGRATION_SCHEMAS.find((s) => s.service === service) || null;
}

/**
 * The tenant paste-and-save editor is only for shared, manually provisioned
 * credentials. Personal credentials and OAuth-owned tokens have dedicated
 * flows whose storage and rotation rules must not be bypassed by this API.
 */
export function isTenantManuallyEditableIntegrationSchema(
  schema: IntegrationSchema,
): boolean {
  return (schema.scope ?? "tenant") === "tenant" && (schema.setup ?? "manual") === "manual";
}

export const TENANT_MANUALLY_EDITABLE_INTEGRATION_SCHEMAS = INTEGRATION_SCHEMAS.filter(
  isTenantManuallyEditableIntegrationSchema,
);

export function findTenantManuallyEditableIntegrationSchema(
  service: string,
): IntegrationSchema | null {
  const schema = findIntegrationSchema(service);
  return schema && isTenantManuallyEditableIntegrationSchema(schema) ? schema : null;
}

/**
 * Validate a value against a field's `validation` pattern. Returns
 * an error string when the value is bad; null when ok or when the
 * field has no validation declared. Server uses this at upsert time;
 * client could reuse for instant feedback if desired.
 */
export function validateIntegrationValue(
  field: IntegrationFieldDef,
  value: string,
): string | null {
  if (!field.validation) return null;
  switch (field.validation) {
    case "phone_e164":
      return /^\+[1-9]\d{6,14}$/.test(value) ? null : "expected E.164 phone (e.g. +14165551212)";
    case "url":
      try {
        const u = new URL(value);
        return u.protocol === "http:" || u.protocol === "https:" ? null : "url must be http(s)";
      } catch {
        return "invalid url";
      }
    case "email":
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? null : "invalid email";
    case "alphanum_uppercase":
      return /^[A-Z0-9_]+$/.test(value) ? null : "expected uppercase letters / digits / underscore";
    case "twilio_sid": {
      const prefix = field.sidPrefix ?? "";
      return /^(AC|SK|MG)[0-9a-fA-F]{32}$/.test(value.trim()) && value.trim().startsWith(prefix)
        ? null
        : `expected a Twilio SID: ${prefix || "two letters"} followed by 32 letters and digits (0-9, a-f)`;
    }
    case "single_line_token": {
      const v = value.trim();
      return v.length >= 8 && v.length <= 4096 && /^[\x21-\x7e]+$/.test(v)
        ? null
        : "That does not look like a key: paste it as one line, with no spaces.";
    }
    case "public_hostname":
      return isPublicHostname(value) ? null : "Use the server's public name (like smtp.example.com), not an IP address or an internal name.";
    case "smtp_port":
      return SMTP_PORTS.has(value.trim()) ? null : "Use one of the standard mail ports: 587, 465, 2525 or 25.";
    default:
      return null;
  }
}

/** The submission ports a mail server listens on (RFC 6409 587, RFC 8314 465, 25, and 2525 by convention). */
export const SMTP_PORTS: ReadonlySet<string> = new Set(["587", "465", "2525", "25"]);

/**
 * A host name OASIS may connect to for an owner's self-hosted app (their mail
 * server): a DNS name with a letter top-level label. That refuses
 * every IP literal (an IPv4 address ends in a number, an IPv6 one has colons),
 * localhost and the internal suffixes, so a Test can never be aimed at an
 * address inside a network. A public name that resolves to a private address is
 * not reachable from the Worker's edge network either.
 */
export function isPublicHostname(raw: string): boolean {
  const host = raw.trim().toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.some((l) => !l || l.length > 63 || l.startsWith("-") || l.endsWith("-"))) return false;
  if (!/^[a-z][a-z0-9-]*$/.test(labels[labels.length - 1])) return false;
  return !/(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa|in-addr\.arpa|ip6\.arpa)$/.test(host);
}

/**
 * The fields an app needs before it can be tested: every field not marked
 * optional (a label saying "(optional)" counts as marked, as Twilio's do).
 */
export function isOptionalIntegrationField(field: IntegrationFieldDef): boolean {
  return field.optional === true || field.label.toLowerCase().includes("(optional)");
}

export function requiredIntegrationFieldKeys(schema: IntegrationSchema): string[] {
  return schema.fields.filter((f) => !isOptionalIntegrationField(f)).map((f) => f.key);
}

/** True when the app sends a saved secret to an address the owner typed (its own mail server). */
export function hasHostBoundSecrets(schema: IntegrationSchema): boolean {
  return schema.fields.some((f) => (f.bindsSecrets?.length ?? 0) > 0);
}

/**
 * The order to save several fields in one go: every field that clears a
 * secret (an address) before the fields it clears, so a new address and a
 * new key typed together both survive the save.
 */
export function orderForSave(schema: IntegrationSchema, keys: readonly string[]): string[] {
  const binders = new Set(schema.fields.filter((f) => (f.bindsSecrets?.length ?? 0) > 0).map((f) => f.key));
  const rank = (k: string) => (binders.has(k) ? 0 : 1);
  const index = (k: string) => {
    const i = schema.fields.findIndex((f) => f.key === k);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || index(a) - index(b));
}
