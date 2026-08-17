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

/**
 * The founders portal is OASIS's OWN surface — `docs/PORTALS.md`: "OASIS's own
 * tooling. Not a tenant surface." It deliberately serves no tenant slug.
 *
 * The library was rendering every brand on the founders tenant, so four client
 * deliverables (Warner x2, Arthrisil, blyss) sat alongside OASIS's own nine.
 * That is NOT a cross-tenant leak — every row is on the founders tenant and the
 * readers all carry `.eq("tenant_id", …)` — but it is the same boundary in the
 * taxonomy: client work is not our own marketing, and the portal that promises
 * "not a tenant surface" should not be the place you review a client's ad.
 *
 * So founders readers scope to this brand unless a caller explicitly opts out
 * with `scope: "all"`, which exists for a future client/deliverables surface.
 */
export const FOUNDERS_OWN_BRAND = "oasis-ai";

/**
 * ─────────────────────────────────────────────────────────── brand groups
 *
 * CC, 2026-08-16: *"We should have personal brands, so it should be like:
 * Oasis AI / CC / Adon / Music / stuff like that. There need to be separate
 * tabs for this within the marketing page."*
 *
 * The Library was scoped to `oasis-ai` alone, so four client deliverables
 * (Warner x2, Arthrisil, blyss) had been in the table the whole time and CC had
 * never seen one of them. The header said "43 assets across every channel",
 * which was true of one brand only.
 *
 * WHY `clients` IS RESIDUAL AND NOT A LIST.
 * The obvious shape is `slugs: ["warner", "blyss", "arthrisil", "sunbiz-funding"]`.
 * That reintroduces the exact bug this replaces, one client later: Maven
 * registers `brand_slug='newco'`, it matches no group, and it renders in no tab
 * — invisible again, and this time silently, because the row IS in the table and
 * every total includes it. A residual group cannot orphan a brand: every slug
 * that no named group claims belongs to Clients by construction.
 *
 * So adding a CLIENT is a Maven-side registration that needs no deploy here.
 * Adding a PERSONAL brand — a new tab — is a deliberate edit to this list.
 *
 * ADON IS NOT HERE, deliberately. CC's voice note said "CC Adon", which read as
 * either two brands or one phrase; his call on 2026-08-16 was that Adon co-works
 * the Library rather than owning a brand, so he belongs in an author facet and
 * not a tab. See the author note in lib/founders/marketing-queries.ts.
 */
export type BrandGroupKey = "oasis-ai" | "conaugh" | "music" | "clients";

export type BrandGroup = {
  key: BrandGroupKey;
  label: string;
  /** Slugs this group claims. `null` means RESIDUAL — see the note above. */
  slugs: readonly string[] | null;
  /** Copy for the group when it holds nothing yet. */
  empty: string;
};

export const BRAND_GROUPS: readonly BrandGroup[] = [
  {
    key: "oasis-ai",
    label: "OASIS AI",
    slugs: [FOUNDERS_OWN_BRAND],
    empty: "Nothing registered for OASIS yet.",
  },
  {
    // "Personal", not "Conaugh McKenna". CC, 2026-08-16: *"I think you're
    // confusing the like music and Kona McKenna and Oasis AI ... we should just
    // do like personal so it should be Oasis AI personal music and then
    // clients."* Naming a tab after a person reads as "posts about Conaugh"
    // beside a company tab and a genre tab; naming it after its ROLE puts all
    // four on one axis — whose brand is this for. The slug stays `conaugh`
    // because it is a stored value and renaming it would orphan every row.
    key: "conaugh",
    label: "Personal",
    slugs: ["conaugh"],
    empty: "Nothing under the personal brand yet — Maven registers here with brand_slug='conaugh'.",
  },
  {
    key: "music",
    label: "Music",
    slugs: ["nostalgic-requests"],
    empty: "Nothing under the music brand yet — Maven registers here with brand_slug='nostalgic-requests'.",
  },
  {
    key: "clients",
    label: "Clients",
    slugs: null,
    empty: "No client deliverables in the library.",
  },
];

/**
 * The tab you land on. OASIS's own work stays the default view, which is what
 * the founders portal has always shown — widening the taxonomy must not quietly
 * change what the page opens on.
 */
export const DEFAULT_BRAND_GROUP: BrandGroupKey = "oasis-ai";

export function isBrandGroupKey(v: unknown): v is BrandGroupKey {
  return typeof v === "string" && BRAND_GROUPS.some((g) => g.key === v);
}

export function brandGroup(key: BrandGroupKey): BrandGroup {
  const found = BRAND_GROUPS.find((g) => g.key === key);
  // Unreachable via isBrandGroupKey, but throwing beats returning the WRONG
  // group: every caller uses the result to decide which rows a founder sees.
  if (!found) throw new Error(`unknown brand group: ${key}`);
  return found;
}

/** Every slug a named group claims — the complement of this is the Clients group. */
export function claimedBrandSlugs(): string[] {
  return BRAND_GROUPS.flatMap((g) => (g.slugs ? [...g.slugs] : []));
}

/**
 * Which tab a brand belongs in. Unclaimed slugs fall to the residual group
 * rather than to nothing, so a brand can never be registered into invisibility.
 */
export function brandGroupFor(slug: string | null | undefined): BrandGroupKey {
  if (!slug) return "clients";
  const named = BRAND_GROUPS.find((g) => g.slugs?.includes(slug));
  return named ? named.key : "clients";
}

/**
 * May a `?brand=` from the URL be applied while viewing this tab?
 *
 * The sub-filter narrows WITHIN a group; it must never widen ACROSS one.
 * Without this, `?group=oasis-ai&brand=warner` typed into the address bar would
 * put a client's ad on the OASIS tab — the same hole the old `scope !== "all"`
 * check existed to close, which is why the rule lives in one tested function
 * rather than being re-derived at each call site.
 */
export function brandFilterAllowed(slug: string, group: BrandGroupKey): boolean {
  return brandGroupFor(slug) === group;
}

/** Is this asset OASIS's own work rather than a client deliverable? */
export function isOwnBrand(brandSlug: string | null | undefined): boolean {
  return brandSlug === FOUNDERS_OWN_BRAND;
}

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

/**
 * An operator verdict, translated into a value `marketing_review.decision` will
 * actually accept.
 *
 * These are two different vocabularies and they do not overlap. The asset STATUS
 * is where the work now sits ("approved", "archived"); the review DECISION is
 * what the human did, and database/133_marketing_hub.sql constrains it:
 *
 *   check (decision in ('approve','approve_with_changes','request_changes','reject','comment'))
 *
 * Writing a status into that column violates the check, so every verdict insert
 * failed. It was invisible because the insert is deliberately best-effort — the
 * status change still landed, and only the audit trail silently went missing,
 * which is the half you do not notice until you need it.
 *
 * Returns null when a status has no meaningful verdict (moving something back to
 * in_review is a retraction, not a decision), and the caller then records nothing
 * rather than inventing one.
 */
export function reviewDecisionFor(status: AssetStatus): string | null {
  switch (status) {
    case "approved":
      return "approve";
    case "rejected":
      return "reject";
    case "archived":
      return "comment";   // shelved, not judged — the only honest fit in the enum
    default:
      return null;        // in_review, draft, scheduled, published: no verdict
  }
}

/**
 * Read the `platforms` column, whatever shape the driver hands back.
 *
 * Turso stores it as TEXT holding JSON; a PostgREST/jsonb path would hand back a
 * real array. Both are normal, so both are accepted. A malformed value degrades
 * to an empty list rather than throwing — losing the platform list must not cost
 * the caller the whole asset, which is the same lesson as the publish-intent
 * reader.
 */
export function parseStringArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((x): x is string => typeof x === "string");
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

/** Where the asset went. */
export const parsePlatforms = parseStringArray;

/**
 * Ordered slide storage paths.
 *
 * Same tolerant reader, named for what it is at the call site — one
 * implementation, so a fix to the parsing reaches both. ORDER IS PRESERVED
 * exactly as stored: a carousel read out of order is a different post.
 */
export const parseSlideUrls = parseStringArray;

/**
 * Who added an asset, as a person rather than a mailbox.
 *
 * CC, 2026-08-16: *"When I mentioned Adon, you have to remember he's our
 * co-founder for OASIS AI, so Adon will contribute to this. We need to make sure
 * that he's getting listed in the metadata in terms of what it says and whose it
 * added by."*
 *
 * The detail page rendered `author_email` raw, so provenance on a co-founded
 * library read as an address. Both founders are named here; anything else falls
 * back to the local part, and an unknown address is still shown rather than
 * hidden — provenance you cannot read beats provenance you cannot see.
 *
 * This is DISPLAY ONLY. The stored value stays the email, because that is the
 * identity you can still argue with in six months.
 */
const FOUNDER_NAMES: Record<string, string> = {
  "conaugh@oasisai.work": "CC",
  "adon@oasisai.work": "Adon",
};

export function authorName(email: string | null | undefined): string {
  const e = (email || "").trim().toLowerCase();
  if (!e) return "unknown";
  return FOUNDER_NAMES[e] || e.split("@")[0] || e;
}

/** Display label for a platform key. Falls back to the key rather than hiding it. */
export function platformLabel(key: string): string {
  const NAMES: Record<string, string> = {
    instagram: "Instagram",
    tiktok: "TikTok",
    youtube: "YouTube",
    twitter: "X",
    x: "X",
    threads: "Threads",
    linkedin: "LinkedIn",
    facebook: "Facebook",
    meta: "Meta",
    google: "Google",
  };
  return NAMES[key] || key;
}

/** The asset shapes the Library knows how to render. */
export const ASSET_TYPES = ["video", "single_image", "carousel"] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/**
 * Is this asset a carousel WE CAN ACTUALLY RENDER?
 *
 * Deliberately not `asset_type === "carousel"` alone. A row can claim to be a
 * carousel and have one slide registered — that is exactly the state the Library
 * was in before the backfill, six rows printed "01/05 · swipe →" on the cover
 * while the database held a single image. Claiming is not having, so the slide
 * list has to actually be there.
 */
export function isRenderableCarousel(assetType: unknown, slides: readonly unknown[]): boolean {
  return assetType === "carousel" && slides.length > 1;
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
 * ─────────────────────────────────────── review state vs distribution state
 *
 * CC, 2026-08-16: *"Are these videos that we haven't posted yet? ... We have 43
 * assets. Are all of these not posted yet? Have they not been posted at all,
 * ever?"*
 *
 * He could not tell, and the page was the reason. `status` conflates two
 * unrelated questions into one column:
 *
 *   1. Has CC passed a verdict on this?      draft / in_review / approved / rejected
 *   2. Has it actually gone out?             published / (nothing)
 *
 * A grid where all 41 read IN REVIEW answers neither. It looks like a backlog of
 * work waiting on him, when what it mostly means is "produced, never scheduled".
 *
 * WHAT THE DATA ACTUALLY SAYS (live, 2026-08-16). Of 43 OASIS assets: one has a
 * `published_at`, none have a linked `post_analytics` row. Meanwhile
 * `post_analytics` holds 100 real posts across five accounts with genuine view
 * counts. Those are not the same content — the Library is Maven's produced ad
 * creative, and the 100 live posts come from the daily poster reading
 * data/post_queue. TWO PIPELINES THAT HAVE NEVER BEEN JOINED, which is why the
 * Library can honestly say "none of this has been posted" while the accounts are
 * clearly active.
 *
 * So distribution is derived from EVIDENCE, never from `status`:
 * a publish timestamp, or an analytics row proving the platform accepted it.
 * `platforms` alone does NOT count — it was backfilled from `channel` and holds
 * single-element copies of it, so it records intent, not delivery.
 */
export type Distribution = "live" | "never_posted";

/**
 * ONE SIGNAL, DELIBERATELY: `published_at`.
 *
 * This briefly also accepted an `analytics_posts` count, on the theory that a
 * linked post_analytics row proves a platform took it. True, and still the wrong
 * design, for two reasons found in review:
 *
 *  1. IT WAS DEAD. No reader ever populated the field, so the branch could not
 *     fire — code that reads as live logic and is unreachable, which is how a
 *     future change "fixes" something that was never running.
 *
 *  2. IT WOULD HAVE DESYNCED THE PAGE. getLifecycleCounts buckets in JS through
 *     this function, while getMarketingAssets filters in SQL on `published_at`
 *     alone. A second signal here that SQL cannot see makes the pills and the
 *     grid disagree — "Posted 3" over an empty grid — and they agreed only
 *     because the field was always undefined. Two code paths deciding one
 *     question have to consult the same column.
 *
 * If analytics should ever confer "posted", the fix is to backfill
 * `published_at` from post_analytics — a DATA correction both paths already
 * read — never a second predicate in the one path that happens to be JavaScript.
 */
export function distributionOf(asset: { published_at?: string | null }): Distribution {
  return asset.published_at ? "live" : "never_posted";
}

/**
 * The lifecycle buckets the Library filters on — the "proper organisation" CC
 * asked for, with review and distribution kept apart.
 *
 * `archived` is FIRST-CLASS and reachable, which it was not: archiving removed an
 * asset from every view with no filter that could show it again and no button to
 * bring it back. CC archived a video and reported it "completely gone". It was
 * never gone — the row was intact the whole time and the UI simply had no way to
 * look at it. A destructive-looking action with no inverse is a bug even when the
 * data survives.
 */
export const LIFECYCLE = ["needs_review", "approved", "live", "archived"] as const;
export type Lifecycle = (typeof LIFECYCLE)[number];

export function isLifecycle(v: unknown): v is Lifecycle {
  return typeof v === "string" && (LIFECYCLE as readonly string[]).includes(v);
}

const LIFECYCLE_LABEL: Record<Lifecycle, string> = {
  needs_review: "Needs review",
  approved: "Approved",
  live: "Posted",
  archived: "Archived",
};

const LIFECYCLE_HINT: Record<Lifecycle, string> = {
  needs_review: "produced, no verdict yet",
  approved: "cleared to post, not sent",
  live: "confirmed out on a platform",
  archived: "shelved — restorable",
};

export function lifecycleLabel(l: Lifecycle): string {
  return LIFECYCLE_LABEL[l];
}
export function lifecycleHint(l: Lifecycle): string {
  return LIFECYCLE_HINT[l];
}

/**
 * Which bucket an asset sits in. Distribution WINS over review state — something
 * that has actually gone out is "Posted" regardless of what its status column
 * says, because the world is the authority, not our bookkeeping.
 */
export function lifecycleOf(asset: {
  status: string;
  published_at?: string | null;
}): Lifecycle {
  if (asset.status === "archived" || asset.status === "rejected") return "archived";
  if (distributionOf(asset) === "live") return "live";
  if (asset.status === "approved") return "approved";
  return "needs_review";
}

/**
 * A link to the post as it exists on the platform.
 *
 * CC: *"on our performance page, where we can see the most seen, it should be a
 * clickable link that takes me to that Instagram post."* The Performance tab
 * listed view counts with no way to reach the thing being measured, so checking
 * a number meant hunting for the post by hand.
 *
 * Returns null rather than a guessed URL when the id shape cannot produce one —
 * a dead link on a metrics page is worse than plain text, because it looks like
 * accounting that works.
 */
export function postPermalink(
  platform: string,
  platformPostId: string | null | undefined,
  accountUsername?: string | null,
): string | null {
  const id = (platformPostId || "").trim();
  if (!id) return null;
  switch (platform) {
    case "instagram":
      // Numeric media ids are NOT addressable as /p/<id> — that path needs the
      // base64 shortcode, which the analytics row does not carry. Link the
      // account instead of inventing a URL that 404s.
      return /^\d+$/.test(id)
        ? accountUsername
          ? `https://www.instagram.com/${accountUsername}/`
          : null
        : `https://www.instagram.com/p/${id}/`;
    case "tiktok":
      return accountUsername
        ? `https://www.tiktok.com/@${accountUsername}/video/${id}`
        : `https://www.tiktok.com/video/${id}`;
    case "youtube":
      return `https://www.youtube.com/watch?v=${id}`;
    case "linkedin":
      // "urn:li:ugcPost:74871..." — the feed permalink takes the whole urn.
      return id.startsWith("urn:li:")
        ? `https://www.linkedin.com/feed/update/${id}/`
        : null;
    case "threads":
      return accountUsername ? `https://www.threads.net/@${accountUsername}` : null;
    default:
      return null;
  }
}

/**
 * ──────────────────────────────────────────────── publish-queue honesty
 *
 * How long a `queued` publish intent may sit before the page says so.
 *
 * WHAT THIS IS ACTUALLY FOR. The consumer EXISTS and is healthy:
 * `Business-Empire-Agent/scripts/marketing_publish_drain.py`, a cron_engine
 * SEED_JOB on `* * * * *` — 1,320 runs, 0 failures as of 2026-08-16.
 *
 * The thing it cannot promise is that the drain is REACHABLE. It runs on the
 * operator's machine, because that is where send_gateway's credentials live and
 * a Vercel function cannot call it (see database/140). So the queue has a
 * consumer that is offline whenever CC's machine is — overnight, travelling,
 * after a PM2 crash — and from this panel that state is indistinguishable from
 * a publish in flight. The operator gets a green toast either way and finds out
 * by checking the actual accounts.
 *
 * (A correction worth keeping: this was first written asserting the drainer had
 * never been built, on a peer agent's `grep CMO-Agent/scripts/` returning
 * nothing. It returns nothing because the drainer was never meant to live
 * there — it lives where the gateway lives, which is this fleet's own repo. The
 * grep was real and the conclusion was wrong, and the warning below is worth
 * having for the real reason rather than the assumed one.)
 *
 * WHY A TIMER RATHER THAN A HEALTH FLAG. The page would have to reach the
 * operator's machine to ask whether the drain is up, which is the exact thing it
 * cannot do. Age needs no such call: an intent that has sat unclaimed past the
 * threshold IS the evidence, whatever the cause — machine off, cron paused,
 * process wedged, or a bug in the drain itself. It reports the symptom the
 * operator cares about rather than a cause it would have to guess.
 *
 * Ten minutes against a one-minute schedule is deliberately generous — a 10 MB
 * reel to five networks legitimately takes minutes, and the drain claims an
 * intent before working, so anything genuinely in flight has left `queued`.
 */
export const PUBLISH_STALE_AFTER_MINUTES = 10;

export type PublishIntentLike = {
  state: string;
  created_at: string;
};

/**
 * The warning to show under a publish request, or null when there is nothing
 * worth saying.
 *
 * Pure and time-injectable so tests can age an intent without waiting; returns
 * null for every terminal state, because a `done` or `failed` intent has been
 * seen by a consumer and is no longer evidence of anything.
 */
export function stalePublishWarning(
  intent: PublishIntentLike | null | undefined,
  now: Date = new Date(),
): string | null {
  if (!intent) return null;
  // `running` is excluded too: something picked it up, which is the fact this
  // warning exists to establish.
  if (intent.state !== "queued") return null;
  const created = new Date(intent.created_at);
  if (Number.isNaN(created.getTime())) return null;
  const mins = Math.floor((now.getTime() - created.getTime()) / 60_000);
  if (mins < PUBLISH_STALE_AFTER_MINUTES) return null;
  const age =
    mins < 60
      ? `${mins} minutes`
      : mins < 1440
        ? `${Math.floor(mins / 60)} hour${Math.floor(mins / 60) === 1 ? "" : "s"}`
        : `${Math.floor(mins / 1440)} day${Math.floor(mins / 1440) === 1 ? "" : "s"}`;
  return (
    `Queued ${age} ago and still not picked up — nothing has been posted yet. ` +
    `The publisher runs on the operator machine; if it is offline this waits ` +
    `rather than fails.`
  );
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
