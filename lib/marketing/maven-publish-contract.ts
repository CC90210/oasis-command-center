/** Pure contract shared by the Maven publish Queue producer and consumer. */
import { PUBLISH_CHANNELS } from "@/lib/founders/publish-targets";
import { parseSlideUrls, parseStringArray } from "@/lib/founders-marketing-core";
import { WEBDEV_TENANT_ID } from "@/lib/oasis-tenant";

export const OASIS_TENANT_ID = WEBDEV_TENANT_ID;
export const OASIS_MAVEN_PUBLISH_SWITCH = "OASIS_MAVEN_PUBLISH_QUEUE_FORWARD";
export const MAVEN_PUBLISH_QUEUE_NAME = "oasis-maven-publish-jobs";
export const MAVEN_PUBLISH_QUEUE_BINDING = "MAVEN_PUBLISH_JOBS";
export const MAVEN_PUBLISH_DLQ_NAME = "oasis-maven-publish-jobs-dlq";

const TRUTHY = new Set(["on", "true", "1", "yes"]);

export function mavenPublishEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUTHY.has((env[OASIS_MAVEN_PUBLISH_SWITCH] ?? "").trim().toLowerCase());
}

export function mavenPublishLiveReadiness(
  env: Record<string, string | undefined> = process.env,
): { ready: true } | { ready: false; reason: string } {
  const kill = env.MAVEN_FORCE_DRY_RUN;
  if (kill === undefined || kill.trim() === "") {
    return { ready: false, reason: "MAVEN_FORCE_DRY_RUN is missing (fail closed)" };
  }
  if (!new Set(["0", "false", "off", "no"]).has(kill.trim().toLowerCase())) {
    return { ready: false, reason: "MAVEN_FORCE_DRY_RUN is engaged" };
  }
  if (TRUTHY.has((env.BRAVO_FORCE_DRY_RUN ?? "").trim().toLowerCase())) {
    return { ready: false, reason: "BRAVO_FORCE_DRY_RUN is engaged" };
  }
  if (!(env.LATE_API_KEY ?? "").trim()) {
    return { ready: false, reason: "LATE_API_KEY is missing" };
  }
  if (!(env.R2_ACCOUNT_ID ?? env.CLOUDFLARE_ACCOUNT_ID ?? "").trim()) {
    return { ready: false, reason: "R2 account id is missing" };
  }
  for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const) {
    if (!(env[name] ?? "").trim()) return { ready: false, reason: `${name} is missing` };
  }
  if (!(env.OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET ?? "").trim()) {
    return { ready: false, reason: "OASIS_MAVEN_PUBLISH_JOB_SIGNING_SECRET is missing" };
  }
  return { ready: true };
}

export type MarketingAsset = {
  id: string;
  tenant_id: string;
  title: string | null;
  hook: string | null;
  body: string | null;
  cta: string | null;
  landing_url: string | null;
  campaign: string | null;
  asset_type: string | null;
  media_urls: unknown;
  status?: string | null;
  external_id?: string | null;
  platforms?: unknown;
  published_at?: string | null;
  updated_at?: string | null;
};

export type MarketingMedia = {
  tenant_id: string;
  asset_id: string;
  kind: string;
  storage_bucket: string;
  storage_path: string;
  mime: string | null;
  bytes: number | null;
};

export type PublishIntentLike = {
  id: string;
  tenant_id: string;
  asset_id: string;
  platforms: unknown;
};

export type PublishMedia = MarketingMedia & { mediaKind: "video" | "image" };

export type PublishGroup = {
  id: "short" | "pro";
  professional: boolean;
  platforms: string[];
  caption: string;
  title: string;
  idempotencyKey: string;
};

export type PublishPlan = {
  media: PublishMedia[];
  groups: PublishGroup[];
  requestedPlatforms: string[];
  droppedPlatforms: string[];
};

export type LateUploadedMedia = { url: string; kind: "video" | "image" };

/** Late/Zernio account ids verified by Maven's schedule_posts.py. */
export const LATE_ACCOUNT_BY_PLATFORM: Readonly<Record<string, string>> = {
  instagram: "699c92828ab8ae478b3ee83a",
  tiktok: "699c93118ab8ae478b3ee9d9",
  linkedin: "699c93508ab8ae478b3eeaee",
  youtube: "699c93348ab8ae478b3eea43",
  twitter: "699c93608ab8ae478b3eeba1",
  threads: "699c93c58ab8ae478b3eec7e",
};

const SHORT_FORM = new Set(["instagram", "tiktok", "youtube", "twitter", "threads"]);
const IMAGE_CAP: ReadonlyMap<string, number> = new Map(
  PUBLISH_CHANNELS.map((channel) => [channel.id, channel.imageCap]),
);

function uniqueStrings(raw: unknown): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of parseStringArray(raw)) {
    const key = value.trim().toLowerCase() === "x" ? "twitter" : value.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function captionFor(asset: MarketingAsset, professional: boolean): string {
  const hook = String(asset.hook ?? "").trim();
  const body = String(asset.body ?? "").trim();
  const cta = String(asset.cta ?? "").trim();
  const landing = String(asset.landing_url ?? "").trim();
  const parts: string[] = [];
  if (professional) {
    if (body) parts.push(body);
    else if (hook) parts.push(hook);
  } else {
    if (hook) parts.push(hook);
    if (body) parts.push(body);
  }
  if (!parts.length) parts.push(String(asset.title ?? "").trim());
  if (cta && landing) parts.push(`${cta.slice(0, 1).toUpperCase()}${cta.slice(1)} → ${landing}`);
  else if (landing) parts.push(landing);
  return parts.filter(Boolean).join("\n\n").trim();
}

function mediaKind(row: MarketingMedia): "video" | "image" | null {
  const mime = String(row.mime ?? "").toLowerCase();
  const suffix = row.storage_path.toLowerCase();
  if (row.kind === "video" || mime.startsWith("video/") || /\.(mp4|mov|webm)$/.test(suffix)) return "video";
  if (
    row.kind === "image" || row.kind === "poster" || row.kind === "preview" || row.kind === "thumb" ||
    mime.startsWith("image/") || /\.(png|jpe?g|webp)$/.test(suffix)
  ) return "image";
  return null;
}

function resolveMedia(asset: MarketingAsset, rows: MarketingMedia[]): PublishMedia[] {
  const scoped = rows.filter((row) => row.tenant_id === asset.tenant_id && row.asset_id === asset.id);
  const byPath = new Map(scoped.map((row) => [row.storage_path, row]));
  // Storage paths are case-sensitive and their recorded order is the post.
  // Platform normalization must never be reused here.
  const ordered = parseSlideUrls(asset.media_urls).map((path) => path.trim()).filter(Boolean);
  if (asset.asset_type === "carousel") {
    if (ordered.length < 2) throw new Error("carousel has fewer than two recorded slides");
    const missing = ordered.filter((path) => !byPath.has(path));
    if (missing.length) throw new Error(`carousel media row missing for ${missing.join(", ")}`);
    const resolved = ordered.map((path) => {
      const row = byPath.get(path)!;
      const kind = mediaKind(row);
      if (kind !== "image") throw new Error("multi-video carousels are not supported by the proven Maven publisher");
      return { ...row, mediaKind: kind };
    });
    return resolved;
  }

  const wanted = asset.asset_type === "video" ? "video" : "image";
  const chosen = scoped.find((row) => mediaKind(row) === wanted)
    ?? (asset.asset_type ? undefined : scoped.find((row) => mediaKind(row) === "video") ?? scoped.find((row) => mediaKind(row) === "image"));
  if (!chosen) throw new Error(`no ${wanted} media attached to the asset`);
  return [{ ...chosen, mediaKind: mediaKind(chosen)! }];
}

export function buildPublishPlan(
  intent: PublishIntentLike,
  asset: MarketingAsset,
  mediaRows: MarketingMedia[],
): PublishPlan {
  if (intent.tenant_id !== OASIS_TENANT_ID || asset.tenant_id !== OASIS_TENANT_ID) {
    throw new Error("Maven cloud publisher owns the OASIS tenant only");
  }
  if (asset.id !== intent.asset_id) throw new Error("intent asset does not match the loaded asset");
  const requestedPlatforms = uniqueStrings(intent.platforms);
  if (!requestedPlatforms.length) throw new Error("publish intent has no platforms");
  const unknown = requestedPlatforms.filter((platform) => !LATE_ACCOUNT_BY_PLATFORM[platform]);
  if (unknown.length) throw new Error(`no connected Late account for ${unknown.join(", ")}`);

  const media = resolveMedia(asset, mediaRows);
  const imageCount = media.every((item) => item.mediaKind === "image") ? media.length : 0;
  const droppedPlatforms = imageCount
    ? requestedPlatforms.filter((platform) => imageCount > (IMAGE_CAP.get(platform) ?? imageCount))
    : [];
  const accepted = requestedPlatforms.filter((platform) => !droppedPlatforms.includes(platform));
  if (!accepted.length) {
    throw new Error(`${imageCount}-image post exceeds every requested platform's image cap`);
  }

  const title = String(asset.title ?? "").slice(0, 95);
  const groups: PublishGroup[] = [];
  const short = accepted.filter((platform) => SHORT_FORM.has(platform));
  const professional = accepted.filter((platform) => !SHORT_FORM.has(platform));
  if (short.length) {
    groups.push({
      id: "short",
      professional: false,
      platforms: short,
      caption: captionFor(asset, false),
      title,
      idempotencyKey: `maven-publish:${intent.id}:short`,
    });
  }
  if (professional.length) {
    groups.push({
      id: "pro",
      professional: true,
      platforms: professional,
      caption: captionFor(asset, true),
      title,
      idempotencyKey: `maven-publish:${intent.id}:pro`,
    });
  }
  if (groups.some((group) => !group.caption)) throw new Error("asset has no caption or title");
  return { media, groups, requestedPlatforms, droppedPlatforms };
}

export function latePlatformEntry(platform: string, title: string, kind: "video" | "image") {
  const accountId = LATE_ACCOUNT_BY_PLATFORM[platform];
  if (!accountId) throw new Error(`no connected Late account for ${platform}`);
  const out: Record<string, unknown> = { platform, accountId };
  if (platform === "instagram" && kind === "video") {
    out.platformSpecificData = { contentType: "reel" };
  } else if (platform === "youtube") {
    out.platformSpecificData = {
      title: (title || "OASIS AI").slice(0, 95),
      visibility: "public",
      madeForKids: false,
      categoryId: "28",
    };
  }
  return out;
}

/** Exact /v1/posts body ported from Maven's proven late_adapter.py. */
export function buildLatePayload(group: PublishGroup, media: LateUploadedMedia[]): Record<string, unknown> {
  const firstKind = media[0]?.kind;
  if (!firstKind) throw new Error("no uploaded media");
  if (firstKind === "video" && media.length > 1) {
    throw new Error("multi-video carousels are not supported by the proven Maven publisher");
  }
  return {
    content: group.caption,
    mediaItems: media.map((item) => ({ type: item.kind, url: item.url })),
    platforms: group.platforms.map((platform) => latePlatformEntry(platform, group.title, firstKind)),
    publishNow: true,
    ...(group.title ? { title: group.title.slice(0, 95) } : {}),
  };
}
