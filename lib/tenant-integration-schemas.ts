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
  validation?: "phone_e164" | "url" | "email" | "alphanum_uppercase";
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
};

export const INTEGRATION_SCHEMAS: IntegrationSchema[] = [
  {
    service: "twilio",
    label: "Twilio",
    description: "SMS dispatch via Twilio. Required for the Send SMS button on the lead drawer.",
    fields: [
      { key: "account_sid", label: "Account SID", sensitive: false, validation: "alphanum_uppercase" },
      { key: "auth_token", label: "Auth Token", sensitive: true, hint: "Find this under Twilio → Account Info." },
      { key: "from_number", label: "From Number", sensitive: false, validation: "phone_e164", hint: "E.164 format, e.g. +14165551212" },
    ],
  },
  {
    service: "texttorrent",
    label: "TextTorrent",
    description: "TT API for the Text Torrent button on the lead drawer + bulk sequences.",
    fields: [
      { key: "api_key", label: "API Key", sensitive: true },
      { key: "from_number", label: "From Number (optional)", sensitive: false, validation: "phone_e164" },
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
      { key: "default_agent_email", label: "Default Agent Email", sensitive: false, validation: "email", hint: "Kixie agent that rings when no per-employee agent is specified. Usually Ezra's Kixie login (submissions@sunbizfunding.com)." },
      { key: "webhook_secret", label: "Webhook Secret (HMAC-SHA256)", sensitive: true, hint: "Shared secret Kixie signs inbound webhooks with — set the same value in Kixie's webhook config UI. Required so we can verify webhook authenticity." },
    ],
  },
  {
    service: "gws",
    label: "Google Workspace (Gmail)",
    description: "Outbound email via Gmail App Password. Consumed by send_gateway.py on the operator machine.",
    fields: [
      { key: "app_password", label: "App Password", sensitive: true, hint: "Generate at myaccount.google.com/apppasswords" },
      { key: "from_address", label: "From Address", sensitive: false, validation: "email" },
    ],
  },
  {
    service: "smtp",
    label: "Custom SMTP",
    description: "Direct SMTP for outbound email (alternative to Gmail App Password).",
    fields: [
      { key: "host", label: "Host", sensitive: false, hint: "e.g. smtp.sendgrid.net" },
      { key: "port", label: "Port", sensitive: false, hint: "Usually 587 (STARTTLS) or 465 (SSL)" },
      { key: "user", label: "Username", sensitive: false },
      { key: "password", label: "Password", sensitive: true },
      { key: "from_address", label: "From Address", sensitive: false, validation: "email" },
    ],
  },
  {
    service: "n8n",
    label: "n8n",
    description: "Inbound webhook bridge (the Inbound Qualifier workflow posts here).",
    fields: [
      { key: "outbound_url", label: "Outbound URL", sensitive: false, validation: "url" },
      { key: "outbound_secret", label: "Webhook Secret", sensitive: true },
    ],
  },
  {
    service: "stripe",
    label: "Stripe",
    description: "Subscription billing + ARR widget.",
    fields: [
      { key: "secret_key", label: "Secret Key", sensitive: true, hint: "starts with sk_live_ or sk_test_" },
      { key: "publishable_key", label: "Publishable Key", sensitive: false, hint: "starts with pk_" },
    ],
  },
  {
    service: "late",
    label: "Late / Zernio",
    description: "Multi-platform social media scheduling.",
    fields: [{ key: "api_key", label: "API Key", sensitive: true }],
  },
  {
    service: "telegram",
    label: "Telegram Bridge",
    description: "Mobile notifications via BotFather.",
    fields: [{ key: "bot_token", label: "Bot Token", sensitive: true, hint: "Format: <digits>:<base64>" }],
  },
  // Per-user OAuth integration. Migration 076 added the
  // user_integration_credentials table that backs this; the OAuth
  // start/callback routes (app/api/auth/google-oauth/*) populate the
  // fields automatically — the operator never pastes them by hand,
  // so all fields are marked sensitive=true but only refresh_token
  // is rendered as a password input in the rare manual-edit path.
  {
    service: "gmail_oauth",
    label: "Gmail (your personal account)",
    description:
      "Connect your own Gmail so outbound emails from the dashboard go from your address, not the workspace owner. Required scope: gmail.send (we cannot read your inbox).",
    scope: "user_only",
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
    default:
      return null;
  }
}
