/**
 * Arthrisil in the Library: real asset rows only, nothing hand-typed, nothing public.
 * Run: node --conditions=react-server --import tsx tests/arthrisil-marketing-placement.test.ts
 *
 * WHY (2026-10-02; CC approved the removal on 2026-10-01)
 * The Library drew a hand-typed Arthrisil card ("Rights: Internal only", a
 * fixed "In review") whose player streamed
 * /media/arthrisil-marketing/arthrisil-social-proof-v6.mp4 out of public/.
 * Files in public/ are served before the Worker runs, so anyone with the link
 * could download the client's unreleased ad. The card and the public files are
 * gone; the ad is an ordinary Library asset in the private marketing-media
 * bucket, signed per viewer. tests/no-public-media.test.ts keeps video out of
 * public/.
 *
 * WHAT IS PINNED
 *  1. Arthrisil is not a Content tab of its own.
 *  2. Both old URLs still redirect to Library > Clients > Arthrisil.
 *  3. That view is real: an Arthrisil asset row reaches it as a tile whose video
 *     and cover come from the signer, in a private bucket. (In-memory database
 *     through the real query builder; no production rows.)
 *  4. The Library page hard-codes no Arthrisil creative, and nothing the app
 *     ships points at the deleted public files.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createClient } from "@libsql/client";

import { FOUNDERS_PORTAL } from "../lib/portals/registry";
import { brandGroupFor, isBrandGroupKey } from "../lib/founders-marketing-core";
import { loadLibraryPage, mediaKey } from "../lib/founders/marketing-queries";
import { PUBLIC_BUCKET_PREFIXES } from "../lib/r2-storage";
import { createTursoPostgrest } from "../lib/turso-postgrest";

const root = join(__dirname, "..");
const LIBRARY_ARTHRISIL = "/founders/marketing/library?group=clients&brand=arthrisil";
const OLD_PUBLIC_FILES = /media\/arthrisil-marketing|arthrisil-social-proof-v\d|end-card-preview/;

// Next's redirect() throws to stop rendering. The stub throws the same way,
// with the target in the message, so a check can read where a page sends you.
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/navigation", {
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
});

function redirectTarget(pageFile: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the next/navigation stub above
  const page = require(join(root, pageFile)) as { default: () => unknown };
  try {
    page.default();
  } catch (e) {
    const m = /^NEXT_REDIRECT;(.+)$/.exec((e as Error).message);
    if (m) return m[1];
    throw e;
  }
  throw new Error(`${pageFile} rendered a page instead of redirecting`);
}

/** Text files under the shipped trees, as repo-relative paths. */
function shippedTextFiles(): string[] {
  const TEXT = /\.(tsx?|jsx?|mjs|cjs|json|jsonc|md|html|css|txt|xml|webmanifest|svg)$/i;
  const SKIP = new Set(["node_modules", ".next", ".open-next"]);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (TEXT.test(name)) out.push(relative(root, full).split(sep).join("/"));
    }
  };
  for (const dir of ["app", "components", "hooks", "lib", "config", "content", "public"]) {
    if (existsSync(join(root, dir))) walk(join(root, dir));
  }
  for (const file of ["middleware.ts", "next.config.js", "wrangler.jsonc", "open-next.config.ts"]) {
    if (existsSync(join(root, file))) out.push(file);
  }
  return out;
}

const T = "tenant-founders";
const NOW = "2026-10-02T00:00:00.000Z";

/** The Library's three tables, as tests/library-paging.test.ts builds them. */
async function libraryDb() {
  const raw = createClient({ url: ":memory:" });
  await raw.executeMultiple(`
    CREATE TABLE marketing_asset (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL,
      track TEXT GENERATED ALWAYS AS (CASE channel WHEN 'organic-instagram' THEN 'organic'
        WHEN 'organic-tiktok' THEN 'organic' WHEN 'paid-meta' THEN 'paid' ELSE NULL END) STORED,
      format TEXT NOT NULL, aspect TEXT, status TEXT NOT NULL DEFAULT 'draft', hook TEXT, body TEXT, cta TEXT,
      landing_url TEXT, campaign TEXT, duration_s TEXT, author_agent TEXT NOT NULL DEFAULT 'human', source TEXT,
      scheduled_for TEXT, published_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      brand_slug TEXT NOT NULL DEFAULT 'oasis-ai', brand_name TEXT NOT NULL DEFAULT 'OASIS AI',
      platforms TEXT NOT NULL DEFAULT '[]', asset_type TEXT NOT NULL DEFAULT 'single_image',
      media_urls TEXT NOT NULL DEFAULT '[]', slide_count INTEGER NOT NULL DEFAULT 1,
      author_email TEXT NOT NULL DEFAULT 'conaugh@oasisai.work'
    );
    CREATE TABLE marketing_asset_media (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT NOT NULL,
      storage_bucket TEXT NOT NULL DEFAULT 'marketing-media', storage_path TEXT NOT NULL,
      mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, label TEXT
    );
    CREATE TABLE marketing_review (
      id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, decision TEXT NOT NULL,
      acted_on_at TEXT
    );
  `);
  // A registered video, shaped the way scripts/register-marketing-asset.ts
  // writes one: the asset row plus a video and a poster in marketing-media.
  for (const [id, brand, brandName] of [
    ["own-1", "oasis-ai", "OASIS AI"],
    ["arth-1", "arthrisil", "Arthrisil"],
    ["warner-1", "warner", "Warner"],
  ]) {
    await raw.execute({
      sql: `INSERT INTO marketing_asset (id, tenant_id, title, channel, format, aspect, status, created_at, updated_at,
              brand_slug, brand_name, asset_type)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [id, T, `Asset ${id}`, "organic-instagram", "video", "9:16", "in_review", NOW, NOW, brand, brandName, "video"],
    });
    for (const [kind, file] of [["video", "ad.mp4"], ["poster", "cover.png"]]) {
      await raw.execute({
        sql: `INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_bucket, storage_path, width, height)
              VALUES (?,?,?,?,?,?,?,?)`,
        args: [`${id}-${kind}`, T, id, kind, "marketing-media", `${T}/${id}/${file}`, 1080, 1920],
      });
    }
  }
  return createTursoPostgrest(raw) as never;
}

async function main() {
  // 1. Not a standalone tab.
  assert.equal(
    FOUNDERS_PORTAL.sections.some((section) => section.href === "/founders/marketing/arthrisil"),
    false,
    "Arthrisil must not be a Content tab of its own",
  );

  // 2. Both old URLs still land on Library > Clients > Arthrisil.
  for (const file of ["app/arthrisil-marketing/page.tsx", "app/founders/marketing/arthrisil/page.tsx"]) {
    assert.equal(redirectTarget(file), LIBRARY_ARTHRISIL, `${file} must redirect to Library > Clients > Arthrisil`);
  }

  // 3. ...and that view shows the asset row, signed, from a private bucket.
  const target = new URL(LIBRARY_ARTHRISIL, "https://oasis.example");
  const group = target.searchParams.get("group");
  const brand = target.searchParams.get("brand") ?? "";
  assert.ok(isBrandGroupKey(group), `?group=${group} must be a Library tab`);
  assert.equal(group, "clients");
  assert.equal(brandGroupFor(brand), "clients", "Arthrisil is a client brand, so its filter applies inside the Clients tab");

  const signed: Array<{ bucket: string; path: string }> = [];
  const page = await loadLibraryPage(T, { group, brand }, {
    db: await libraryDb(),
    sign: async (refs) => {
      signed.push(...refs);
      return new Map(refs.map((r) => [mediaKey(r.bucket, r.path), `https://signed.example/${r.bucket}/${r.path}`]));
    },
  });
  assert.deepEqual(
    page.tiles.map((t) => t.asset.id),
    ["arth-1"],
    "the old URLs show Arthrisil's asset, not OASIS's own work or another client's",
  );
  const [tile] = page.tiles;
  assert.equal(tile.playbackUrl, `https://signed.example/marketing-media/${T}/arth-1/ad.mp4`, "the video plays from a signed URL");
  assert.equal(tile.posterUrl, `https://signed.example/marketing-media/${T}/arth-1/cover.png`, "the cover is signed as well");
  assert.ok(
    signed.length > 0 && signed.every((r) => r.bucket === "marketing-media"),
    `the tile's media is signed in marketing-media only: ${JSON.stringify(signed)}`,
  );
  assert.equal(
    PUBLIC_BUCKET_PREFIXES.has("marketing-media"),
    false,
    "marketing-media must stay a private bucket: a signed URL is the only way to its files",
  );

  // 4. No hand-typed card, and nothing the app ships points at the old files.
  const library = readFileSync(join(root, "app/founders/marketing/library/page.tsx"), "utf8");
  const libraryCode = library.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // The offending lines, not the whole file, so a failure reads at a glance.
  const linesMatching = (re: RegExp) => libraryCode.split(/\r?\n/).filter((line) => re.test(line)).map((line) => line.trim());
  assert.deepEqual(linesMatching(/arthrisil/i), [], "the Library hard-codes no Arthrisil creative; client assets come from asset rows");
  assert.deepEqual(linesMatching(/["'`]\/media\//), [], "the Library plays nothing from a public /media/ path");
  assert.deepEqual(linesMatching(/<video\b/), [], "no <video> mounts on arrival anywhere in the Library page");
  assert.equal(
    existsSync(join(root, "public/media/arthrisil-marketing")),
    false,
    "the Arthrisil cuts must not be served from public/",
  );

  const files = shippedTextFiles();
  assert.ok(files.includes("app/founders/marketing/library/page.tsx"), `the scan did not reach app/ (${files.length} files)`);
  const stale = files.filter((f) => OLD_PUBLIC_FILES.test(readFileSync(join(root, f), "utf8")));
  assert.deepEqual(stale, [], `these still point at the deleted public Arthrisil files:\n  ${stale.join("\n  ")}`);

  console.log(`arthrisil marketing placement: passed (${files.length} shipped files scanned)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
