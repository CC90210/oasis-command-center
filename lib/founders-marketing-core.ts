/**
 * founders-marketing-core — pure calculation for the founders-portal Marketing hub.
 *
 * NO REACT IMPORTS IN THIS FILE. Same rule as lib/renewals-core.ts: mixing
 * these helpers into row UI makes Next treat them as client references and the
 * page crashes at render. Presentational code lives in components/founders/.
 *
 * Everything here is a pure function of its arguments so tests/marketing-core.test.ts
 * can exercise it with no DB, no session and no network.
 */

// ─────────────────────────────────────────────────────────── taxonomy

export const CHANNELS = [
  "organic-instagram",
  "organic-facebook",
  "organic-tiktok",
  "organic-youtube",
  "paid-meta",
  "paid-google",
  "seo-article",
  "seo-landing",
  "email",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const TRACKS = ["organic", "paid", "seo", "email"] as const;
export type Track = (typeof TRACKS)[number];

export const STATUSES = [
  "draft",
  "in_review",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "archived",
] as const;
export type AssetStatus = (typeof STATUSES)[number];

export const FORMATS = [
  "video",
  "image",
  "carousel",
  "html",
  "article",
  "copy",
  "audio",
] as const;
export type AssetFormat = (typeof FORMATS)[number];

/** Verdicts a founder can pass. `approve` and `comment` need no note; the rest do. */
export const DECISIONS = [
  "approve",
  "approve_with_changes",
  "request_changes",
  "reject",
  "comment",
] as const;
export type Decision = (typeof DECISIONS)[number];

const CHANNEL_TRACK: Record<Channel, Track> = {
  "organic-instagram": "organic",
  "organic-facebook": "organic",
  "organic-tiktok": "organic",
  "organic-youtube": "organic",
  "paid-meta": "paid",
  "paid-google": "paid",
  "seo-article": "seo",
  "seo-landing": "seo",
  email: "email",
};

const CHANNEL_LABEL: Record<Channel, string> = {
  "organic-instagram": "Instagram",
  "organic-facebook": "Facebook",
  "organic-tiktok": "TikTok",
  "organic-youtube": "YouTube",
  "paid-meta": "Meta ads",
  "paid-google": "Google ads",
  "seo-article": "Articles",
  "seo-landing": "Landing pages",
  email: "Email",
};

const TRACK_LABEL: Record<Track, string> = {
  organic: "Organic",
  paid: "Paid",
  seo: "SEO",
  email: "Lifecycle",
};

export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

export function isAssetStatus(v: unknown): v is AssetStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

export function isDecision(v: unknown): v is Decision {
  return typeof v === "string" && (DECISIONS as readonly string[]).includes(v);
}

/**
 * track is DERIVED, never passed in. The DB stores it so the UI can group
 * without a CASE in every query, but this function is the only authority —
 * a writer that sets track by hand can desync it from channel.
 */
export function trackForChannel(channel: Channel): Track {
  return CHANNEL_TRACK[channel];
}

export function channelLabel(channel: Channel): string {
  return CHANNEL_LABEL[channel];
}

export function trackLabel(track: Track): string {
  return TRACK_LABEL[track];
}

/** "Organic · Instagram" for headers and breadcrumbs. */
export function channelBreadcrumb(channel: Channel): string {
  return `${TRACK_LABEL[CHANNEL_TRACK[channel]]} · ${CHANNEL_LABEL[channel]}`;
}

export function channelsForTrack(track: Track): Channel[] {
  return CHANNELS.filter((c) => CHANNEL_TRACK[c] === track);
}

// ───────────────────────────────────────────────────── review policy

/**
 * A verdict that rejects or asks for changes without saying WHY is worthless as
 * training data — it tells the agent something was wrong but not where the
 * boundary is. Mirrored by a CHECK constraint in 133_marketing_hub.sql so the
 * rule holds even if a future caller skips this helper.
 */
export function decisionRequiresNote(decision: Decision): boolean {
  return decision !== "approve" && decision !== "comment";
}

/** The status an asset lands in once a verdict is recorded. */
export function statusAfterDecision(decision: Decision, current: AssetStatus): AssetStatus {
  switch (decision) {
    case "approve":
    case "approve_with_changes":
      return "approved";
    case "reject":
      return "rejected";
    case "request_changes":
      return "draft";
    case "comment":
      return current; // a comment is not a verdict, it moves nothing
  }
}

/**
 * Training value of a signal, high to low. Drives ordering in the corpus and in
 * the agent's retrieval budget. This inverts the naive design: most tools treat
 * an approval as the goal, but an approval locates no boundary.
 */
export function trainingWeight(decision: Decision): number {
  switch (decision) {
    case "request_changes":
      return 100; // says exactly where the line is
    case "reject":
      return 80; // negative knowledge, compounds
    case "approve_with_changes":
      return 60; // near-miss, the delta is the lesson
    case "comment":
      return 30;
    case "approve":
      return 10; // says "fine", teaches little
  }
}

// ────────────────────────────────────────────────── founders gate (pure)

/**
 * Who may see /marketing. Lives in this pure module — with zero imports — on
 * purpose: the security decision must be testable without a session, a database
 * or an env var, and importing it must never drag in the server chain.
 * lib/founders/gate.ts wraps these with the session lookup.
 *
 * THE BUG THIS PREVENTS: the obvious implementation gates on
 * `resolveSessionContext().isAdmin`, which derives from
 * `is_owner || team_role in ('admin','owner')`. Those flags are PER-TENANT, so
 * every SunBiz owner would have passed. Role says how much power someone has
 * inside their tenant; it never says which tenant they are in.
 */
export function isFounderTenant(
  tenantId: string | null | undefined,
  allowlist: readonly string[],
): boolean {
  if (!tenantId) return false;
  const id = tenantId.trim();
  if (!id) return false;
  // An empty allowlist must never mean "allow everyone".
  if (!allowlist.length) return false;
  return allowlist.some((entry) => entry.trim() === id);
}

/**
 * Tolerates whitespace, trailing commas and blank entries so a stray comma in
 * the Vercel env UI cannot silently widen the allowlist with an empty string
 * that would then match a blank tenant_id.
 */
export function parseFoundersAllowlist(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Whether the Founders nav tab may render in the CURRENTLY DISPLAYED shell.
 *
 * Being a founder is necessary but NOT sufficient. `app/layout.tsx` resolves
 * the shell from `pathOverrideSlug ?? tenantProfileSlug`, so a founder browsing
 * `/t/sun/...` gets the SunBiz-branded sidebar — and a founder-only check alone
 * would paint a "Marketing" tab onto SunBiz's own portal.
 *
 * Nothing leaks (the route still gates on tenant identity, and it is the
 * founder's own tab), but the SunBiz portal would visibly advertise that a
 * founders portal exists. That is precisely what choosing 404-over-403 was
 * meant to prevent, undone by a sidebar entry.
 *
 * Rule: the tab renders only while a founder is looking at their OWN shell.
 * Previewing another tenant, or any demo shell, hides it.
 */
export function shouldShowFoundersNav(input: {
  isFounder: boolean;
  isFullBleed: boolean;
  demoMode: boolean;
  /** Slug from a /t/<slug>/ URL, if any. */
  pathOverrideSlug: string | null;
  /** The viewer's own tenant slug. */
  tenantProfileSlug: string | null;
}): boolean {
  const { isFounder, isFullBleed, demoMode, pathOverrideSlug, tenantProfileSlug } = input;
  if (!isFounder) return false;
  if (isFullBleed) return false; // no sidebar on these routes at all
  if (demoMode) return false; // demo shells are public-facing previews
  // Previewing another tenant's shell: the sidebar is theirs, not ours.
  if (pathOverrideSlug && pathOverrideSlug !== tenantProfileSlug) return false;
  return true;
}

// ───────────────────────────────────────────────────────── formatting

export function fmtBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "";
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function fmtDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Freshness stamp for a metric tile. One wrong or stale number kills trust in
 * every other number on the page, so the age is always rendered next to the
 * value rather than assumed.
 */
export function freshnessLabel(capturedAt: string | null | undefined, now = new Date()): string {
  if (!capturedAt) return "never";
  const then = new Date(capturedAt);
  if (Number.isNaN(then.getTime())) return "unknown";
  const mins = Math.floor((now.getTime() - then.getTime()) / 60000);
  if (mins < 0) return "just now";
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Search Console data is not final for 2-4 days, so those days must render
 * greyed rather than being read as a real decline.
 */
export const GSC_PROVISIONAL_DAYS = 4;

export function isProvisional(source: string, date: string, now = new Date()): boolean {
  if (source !== "gsc-api") return false;
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const ageDays = (now.getTime() - d.getTime()) / 86_400_000;
  return ageDays < GSC_PROVISIONAL_DAYS;
}

// ───────────────────────────────────────────────────────── grouping

export type CountsByTrack = Record<Track, number>;

export function emptyCounts(): CountsByTrack {
  return { organic: 0, paid: 0, seo: 0, email: 0 };
}

export function countByTrack(rows: Array<{ track: string }>): CountsByTrack {
  const out = emptyCounts();
  for (const r of rows) {
    if ((TRACKS as readonly string[]).includes(r.track)) out[r.track as Track] += 1;
  }
  return out;
}

/**
 * Storage path convention, matching lib/chat-attachments.ts:
 *   {tenant_id}/{asset_id}/{timestamp}_{uuid}_{safeName}
 * Built server-side from verified ids so a client can never choose its own path.
 */
export function sanitizeStorageFilename(name: string): string {
  const cleaned = (name || "file")
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.]+/, "")
    .slice(0, 120);
  return cleaned || "file";
}

export function buildMediaPath(
  tenantId: string,
  assetId: string,
  filename: string,
  now = Date.now(),
  uuid = "",
): string {
  const safe = sanitizeStorageFilename(filename);
  const mid = uuid ? `${uuid}_` : "";
  return `${tenantId}/${assetId}/${now}_${mid}${safe}`;
}
