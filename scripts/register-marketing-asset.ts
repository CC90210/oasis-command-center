/**
 * Register a locally rendered marketing video in the founders Marketing Library.
 *
 * Dry-run by default. Use `--execute` only after reviewing the resolved tenant,
 * files and metadata. Production credentials are supplied by the runtime (for
 * example `vercel env run`) and are never read from or written to source.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { isChannel, type Channel } from "../lib/founders-marketing-core";

type Args = Record<string, string | boolean>;

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function required(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`--${key} is required`);
  return value.trim();
}

function safeName(filename: string): string {
  return filename
    .normalize("NFKD")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_.]+/, "")
    .slice(0, 120) || "file";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const execute = args.execute === true;
  const videoPath = path.resolve(required(args, "video"));
  const posterPath = typeof args.poster === "string" ? path.resolve(args.poster) : null;
  const title = required(args, "title");
  const source = required(args, "source");
  const brandSlug = required(args, "brand");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(brandSlug)) throw new Error("--brand must be a lowercase slug such as oasis-ai or r3sol");
  const brandName = typeof args["brand-name"] === "string" ? args["brand-name"].trim() : brandSlug;
  const channelRaw = typeof args.channel === "string" ? args.channel : "organic-instagram";
  if (!isChannel(channelRaw)) throw new Error(`Unsupported --channel: ${channelRaw}`);
  const channel: Channel = channelRaw;
  const hook = typeof args.hook === "string" ? args.hook : null;
  const body = typeof args.body === "string" ? args.body : null;
  const cta = typeof args.cta === "string" ? args.cta : null;
  const durationRaw = typeof args.duration === "string" ? args.duration.trim() : null;
  const duration = durationRaw === null ? null : Number(durationRaw);
  if (durationRaw !== null && (!Number.isFinite(duration) || (duration as number) <= 0)) {
    throw new Error("--duration must be a positive number of seconds");
  }
  const aspect = typeof args.aspect === "string" ? args.aspect : "9:16";
  if (!["9:16", "1:1", "4:5", "16:9"].includes(aspect)) throw new Error("--aspect must be 9:16, 1:1, 4:5, or 16:9");
  const [defaultWidth, defaultHeight] = aspect === "16:9" ? [1920, 1080] : aspect === "1:1" ? [1080, 1080] : aspect === "4:5" ? [1080, 1350] : [1080, 1920];
  const width = Number(typeof args.width === "string" ? args.width : defaultWidth);
  const height = Number(typeof args.height === "string" ? args.height : defaultHeight);
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error("--width and --height must be positive integers");
  const campaign = typeof args.campaign === "string" ? args.campaign : null;
  const landingUrl = typeof args.landing === "string" ? args.landing : null;

  const founderIds = (process.env.FOUNDERS_TENANT_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const requestedTenant = typeof args.tenant === "string" ? args.tenant.trim() : null;
  const tenantId = requestedTenant || (founderIds.length === 1 ? founderIds[0] : null);
  if (execute && !tenantId) throw new Error("Pass --tenant when FOUNDERS_TENANT_IDS does not resolve to exactly one tenant");
  if (tenantId && founderIds.length && !founderIds.includes(tenantId)) throw new Error("Resolved tenant is not in FOUNDERS_TENANT_IDS");

  const [videoInfo, posterInfo] = await Promise.all([
    stat(videoPath),
    posterPath ? stat(posterPath) : Promise.resolve(null),
  ]);
  const summary = {
    mode: execute ? "execute" : "dry-run",
    tenantId: tenantId || "unresolved (dry-run only)",
    title,
    brandSlug,
    brandName,
    channel,
    source,
    video: { path: videoPath, bytes: videoInfo.size },
    poster: posterPath && posterInfo ? { path: posterPath, bytes: posterInfo.size } : null,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!execute) return;

  const url = process.env.BRAVO_SUPABASE_URL;
  const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("BRAVO_SUPABASE_URL and BRAVO_SUPABASE_SERVICE_ROLE_KEY are required");
  // execute=true guarantees this above; keeping the narrowed value separate
  // prevents accidental use of an unresolved tenant in any write path.
  const resolvedTenantId = tenantId as string;

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const tenant = await db.from("tenants").select("id, name, slug").eq("id", resolvedTenantId).maybeSingle();
  if (tenant.error || !tenant.data) throw new Error(`Tenant lookup failed: ${tenant.error?.message || "not found"}`);

  const existing = await db
    .from("marketing_asset")
    .select("id, title")
    .eq("tenant_id", resolvedTenantId)
    .eq("source", source)
    .maybeSingle();
  if (existing.error) throw new Error(`Duplicate check failed: ${existing.error.message}`);
  if (existing.data) {
    console.log(JSON.stringify({ status: "already_registered", tenant: tenant.data, asset: existing.data }, null, 2));
    return;
  }

  const assetId = randomUUID();
  const asset = await db.from("marketing_asset").insert({
    id: assetId,
    tenant_id: resolvedTenantId,
    title,
    brand_slug: brandSlug,
    brand_name: brandName,
    channel,
    format: "video",
    aspect,
    status: "in_review",
    hook,
    body,
    cta,
    landing_url: landingUrl,
    campaign,
    duration_s: duration,
    author_agent: "maven-codex",
    source,
    meta: {
      sha256: createHash("sha256").update(await readFile(videoPath)).digest("hex"),
      registered_by: "scripts/register-marketing-asset.ts",
    },
  }).select("id, title, status, created_at").single();
  if (asset.error?.code === "23505") {
    const winner = await db.from("marketing_asset").select("id, title").eq("tenant_id", resolvedTenantId).eq("source", source).maybeSingle();
    if (!winner.error && winner.data) {
      console.log(JSON.stringify({ status: "already_registered", tenant: tenant.data, asset: winner.data }, null, 2));
      return;
    }
  }
  if (asset.error) throw new Error(`Asset insert failed: ${asset.error.message}`);

  const bucket = "marketing-media";
  const uploaded: string[] = [];
  try {
    const buckets = await db.storage.listBuckets();
    if (buckets.error) throw new Error(`Bucket lookup failed: ${buckets.error.message}`);
    if (!(buckets.data || []).some((item) => item.name === bucket)) {
      const created = await db.storage.createBucket(bucket, { public: false });
      if (created.error) throw new Error(`Bucket creation failed: ${created.error.message}`);
    }

    const mediaRows: Array<Record<string, unknown>> = [];
    for (const item of [
      { kind: "video", filePath: videoPath, mime: "video/mp4", bytes: videoInfo.size, width, height },
      posterPath && posterInfo
        ? { kind: "poster", filePath: posterPath, mime: "image/png", bytes: posterInfo.size, width, height }
        : null,
    ].filter(Boolean) as Array<{kind: string; filePath: string; mime: string; bytes: number; width: number; height: number}>) {
      const storagePath = `${resolvedTenantId}/${assetId}/${Date.now()}_${randomUUID()}_${safeName(path.basename(item.filePath))}`;
      const upload = await db.storage.from(bucket).upload(storagePath, await readFile(item.filePath), {
        contentType: item.mime,
        upsert: false,
      });
      if (upload.error) throw new Error(`${item.kind} upload failed: ${upload.error.message}`);
      uploaded.push(storagePath);
      mediaRows.push({
        tenant_id: resolvedTenantId,
        asset_id: assetId,
        kind: item.kind,
        storage_bucket: bucket,
        storage_path: storagePath,
        mime: item.mime,
        bytes: item.bytes,
        width: item.width,
        height: item.height,
        label: item.kind === "video" ? "Final 30-second vertical ad" : "Library poster",
      });
    }

    const media = await db.from("marketing_asset_media").insert(mediaRows).select("id, kind, storage_bucket, storage_path");
    if (media.error) throw new Error(`Media insert failed: ${media.error.message}`);
    console.log(JSON.stringify({ status: "registered", tenant: tenant.data, asset: asset.data, media: media.data }, null, 2));
  } catch (error) {
    const cleanupErrors: string[] = [];
    if (uploaded.length) {
      const removed = await db.storage.from(bucket).remove(uploaded);
      if (removed.error) cleanupErrors.push(`storage cleanup failed: ${removed.error.message}`);
    }
    const deleted = await db.from("marketing_asset").delete().eq("tenant_id", resolvedTenantId).eq("id", assetId);
    if (deleted.error) cleanupErrors.push(`asset cleanup failed: ${deleted.error.message}`);
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(cleanupErrors.length ? `${original}; ${cleanupErrors.join("; ")}` : original);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
