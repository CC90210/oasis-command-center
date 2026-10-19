/**
 * post-tracking - where a Library asset actually went, read from `meta.zernio`.
 *
 * CC, 2026-10-18: "I think we have a library linker that tracks every time we post
 * through Zernio. We just need to make sure the logic is all mapped out, integrated,
 * tracked, and accounted for on the command center."
 *
 * WHO WRITES IT. CMO-Agent scripts/lib/library_tracking.py, the last step of the daily
 * posting cron (library_sync.py), reads every booked card's post from Zernio and stamps
 * the row: external_id (the Zernio post id), scheduled_for, status, published_at,
 * platforms, and `meta.zernio` = { post_id, status, scheduled_for, outcome, checked_at,
 * platforms: { <network>: { status, published_at, url, error } } }. This file reads that
 * record for the asset page's "Where it went" card. Bravo's hourly caption linker leaves
 * rows that carry it alone (BEA defda104).
 *
 * PURE: no React, no server imports. Anything missing or malformed reads as "no
 * tracking", and only an http(s) address becomes a link.
 */

export type NetworkOutcome = {
  platform: string;
  /** "Instagram", "LinkedIn", "Threads", "X", or the key as written. */
  name: string;
  /** Zernio's own word: published, pending, processing, publishing, failed, ... */
  status: string;
  /** What the card says: "Posted", "Waiting for its slot", "Posting", "Failed". */
  label: string;
  tone: "engaged" | "info" | "hot" | "neutral";
  publishedAt: string | null;
  url: string | null;
  error: string | null;
};

export type PostTracking = {
  postId: string | null;
  /** published | partial | failed | scheduled | missing */
  outcome: string;
  /** One plain sentence for the card's subtitle. */
  summary: string;
  scheduledFor: string | null;
  checkedAt: string | null;
  networks: NetworkOutcome[];
};

const NETWORK_NAMES: Record<string, string> = {
  instagram: "Instagram",
  linkedin: "LinkedIn",
  threads: "Threads",
  twitter: "X",
  x: "X",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  bluesky: "Bluesky",
};

const ORDER = ["instagram", "linkedin", "threads", "twitter", "x", "facebook", "tiktok", "youtube"];

/** More networks than any post is booked to; a longer list is not Zernio's. */
const MAX_NETWORKS = 12;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function webUrl(v: unknown): string | null {
  const t = text(v, 2048);
  if (!t) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function parse(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      return obj(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return obj(raw);
}

function networkLabel(status: string): Pick<NetworkOutcome, "label" | "tone"> {
  switch (status) {
    case "published":
      return { label: "Posted", tone: "engaged" };
    case "failed":
      return { label: "Failed", tone: "hot" };
    case "processing":
    case "publishing":
      return { label: "Posting", tone: "info" };
    case "pending":
    case "scheduled":
      return { label: "Waiting for its slot", tone: "info" };
    default:
      return { label: status ? status.replace(/[_-]+/g, " ") : "Unknown", tone: "neutral" };
  }
}

const SUMMARY: Record<string, string> = {
  published: "Posted on every network it was booked for.",
  partial: "Posted on some networks; at least one failed.",
  failed: "Booked, but every network refused it.",
  scheduled: "Booked in Zernio and waiting for its slot.",
  missing: "Zernio no longer has this post; it was removed or rebooked.",
};

/** The asset's Zernio tracking, or null when the row carries none. */
export function postTrackingOf(rawMeta: unknown): PostTracking | null {
  const z = obj(parse(rawMeta).zernio);
  if (!Object.keys(z).length) return null;
  const nets = obj(z.platforms);
  const networks: NetworkOutcome[] = Object.keys(nets)
    .sort((a, b) => {
      const ia = ORDER.indexOf(a);
      const ib = ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    })
    .slice(0, MAX_NETWORKS)
    .map((platform) => {
      const n = obj(nets[platform]);
      const status = text(n.status, 40) ?? "";
      return {
        platform,
        // hasOwn, not `??`: a "__proto__" key would otherwise name the network
        // Object.prototype, which React cannot render (e9's review of #705).
        name: Object.prototype.hasOwnProperty.call(NETWORK_NAMES, platform) ? NETWORK_NAMES[platform] : platform,
        status,
        ...networkLabel(status),
        publishedAt: text(n.published_at, 40),
        url: status === "published" ? webUrl(n.url) : null,
        error: status === "failed" ? text(n.error, 200) : null,
      };
    });
  const outcome = text(z.outcome, 20) ?? "scheduled";
  return {
    postId: text(z.post_id, 80),
    outcome,
    summary: SUMMARY[outcome] ?? "Tracked in Zernio.",
    scheduledFor: text(z.scheduled_for, 40),
    checkedAt: text(z.checked_at, 40),
    networks,
  };
}
