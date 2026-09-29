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

// ── Catalog shape ──────────────────────────────────────────────────────────

export type ConnectorCategoryKey =
  | "money"
  | "calendar_email"
  | "meetings"
  | "messaging"
  | "ads_social"
  | "crm_import";

/** Catalog groups, in the order the hub renders them. */
export const CONNECTOR_CATEGORIES: readonly { key: ConnectorCategoryKey; label: string }[] = [
  { key: "money", label: "Money" },
  { key: "calendar_email", label: "Calendar & email" },
  { key: "meetings", label: "Meetings" },
  { key: "messaging", label: "Messaging" },
  { key: "ads_social", label: "Ads & social" },
  { key: "crm_import", label: "CRM import" },
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
 */
export type ConnectorStatusSource =
  | { kind: "workspace_heartbeat"; service: "gws" | "telegram"; requireAll: readonly string[] }
  | {
      kind: "tenant_keys";
      service: string;
      requireAll: readonly string[];
      /** At least one of these must also be present (Twilio: a number OR a messaging service). */
      requireAny?: readonly string[];
      verifiable: boolean;
    }
  | { kind: "oauth_tokens"; service: string; requireAll: readonly string[] };

/** What clicking a live card does: open the flow that already exists. */
export type ConnectorConnect =
  | { kind: "link"; href: string; label: string }
  /** An OAuth start route opened in a popup that postMessages `{ source }` back. */
  | { kind: "popup"; href: string; label: string; messageSource: string };

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
  /** null = not built yet. The card says "Coming soon" and opens the drawer. */
  live: { source: ConnectorStatusSource; connect: ConnectorConnect } | null;
  /** When a not-yet-built connector is expected. */
  plannedFor?: "Phase 2" | "Later";
  /** Why it is not live yet, in plain English. */
  pendingNote?: string;
};

/** Where the shared key editor and your own Google connection live. */
export const CREDENTIALS_ANCHOR = "/settings/connections#integrations";

const keysLink = (label: string): ConnectorConnect => ({ kind: "link", href: CREDENTIALS_ANCHOR, label });

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
    reads: ["Payments, customers and subscriptions"],
    does: [
      "Shows revenue and recurring income in Finance",
      "Creates checkout links for the proposals you send and confirms they were paid",
    ],
    keywords: ["payments", "billing", "mrr", "invoices"],
    live: {
      source: { kind: "tenant_keys", service: "stripe", requireAll: ["secret_key"], verifiable: true },
      connect: keysLink("Add your Stripe key"),
    },
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
    plannedFor: "Phase 2",
    pendingNote: "Needs Intuit's app assessment before it can connect to live books.",
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
    plannedFor: "Phase 2",
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
    plannedFor: "Phase 2",
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
      connect: keysLink("Connect Google"),
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
    reads: ["Calls booked through your Calendly links"],
    does: ["Puts each booked call on the lead in Pipeline and on your schedule"],
    keywords: ["booking", "scheduling"],
    live: null,
    plannedFor: "Phase 2",
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
    plannedFor: "Phase 2",
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
    plannedFor: "Later",
    pendingNote: "Needs Zoom Marketplace review.",
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
    plannedFor: "Phase 2",
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
    plannedFor: "Phase 2",
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
    reads: ["Messages in the channels you add an AI teammate to, and messages sent to it directly"],
    does: [
      "Your department agents reply in those channels under their own names",
      "Approval requests arrive as buttons, and nothing goes out until someone approves",
      "Messages are never used for training",
    ],
    keywords: ["chat", "channels", "team"],
    live: null,
    plannedFor: "Phase 2",
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
      connect: { kind: "link", href: "/settings/chat-apps", label: "Set up Telegram" },
    },
  },
  {
    slug: "twilio",
    name: "Twilio",
    summary: "Text messaging",
    category: "messaging",
    departments: ["sales", "client_success"],
    brandColor: null,
    icon: { kind: "monogram", letters: "Tw", reason: "Removed from Simple Icons at Twilio's request" },
    reads: ["Delivery status of the texts OASIS sends"],
    does: ["Sends SMS from your Twilio number once the connection test passes"],
    keywords: ["sms", "text", "phone"],
    live: {
      source: {
        kind: "tenant_keys",
        service: "twilio",
        requireAll: ["account_sid", "auth_token"],
        requireAny: ["from_number", "messaging_service_sid"],
        verifiable: true,
      },
      connect: keysLink("Add your Twilio keys"),
    },
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
    plannedFor: "Later",
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
    plannedFor: "Later",
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
    plannedFor: "Later",
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
    plannedFor: "Phase 2",
    pendingNote: "Meta reviews every app that manages ads. Until that clears, OASIS can connect through partner access in your Business Manager.",
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
    plannedFor: "Phase 2",
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
    plannedFor: "Phase 2",
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
};

/** One row of listTenantIntegrationStatus — presence and test state, never a value. */
export type KeyRowFact = {
  service: string;
  field_key: string;
  has_value: boolean;
  last_tested_at: string | null;
  last_test_ok: boolean | null;
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
  const complete =
    source.requireAll.every(present) && (!requireAny || requireAny.some(present));
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
      detail: "The last connection test failed. Open Credentials and run Test again.",
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
        detail: "The key is saved but has not passed a connection test. Run Test in Credentials.",
      };
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
  if (!def.live) {
    return {
      kind: "coming_soon",
      label: def.plannedFor === "Later" ? "Planned" : "Coming soon",
      detail: def.pendingNote,
    };
  }

  const source = def.live.source;
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
