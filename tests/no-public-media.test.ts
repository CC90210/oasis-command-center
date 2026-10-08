/**
 * public/ holds no video, and nothing at all under public/media/.
 * Run: node --conditions=react-server --import tsx tests/no-public-media.test.ts
 *
 * WHY THIS EXISTS (2026-10-02)
 * Every file under public/ is published to anyone who has its link. Workers
 * Static Assets (the "assets" block in wrangler.jsonc, with no
 * run_worker_first) answer those requests before the Worker runs, so
 * middleware and its sign-in check never see them. Six cuts of a client's
 * unreleased ad and its end card sat in public/media/arthrisil-marketing/
 * while the Library card beside them said "Internal only", and the V6 link
 * answered 200 video/mp4 with no sign-in.
 *
 * Client and marketing media belong in the private marketing-media bucket,
 * registered as Library assets: loadLibraryPage
 * (lib/founders/marketing-queries.ts) hands each signed-in viewer a
 * short-lived signed URL for them.
 *
 * The walk reads the files on disk, not the git index: a build publishes
 * whatever sits in public/, tracked or not.
 */
import assert from "node:assert/strict";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const PUBLIC_DIR = join(__dirname, "..", "public");

/** Video containers a browser or a player will stream. */
const VIDEO = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|mpe?g|wmv|flv|3gp)$/i;
/** Anything under public/media/, in any letter case. */
const MEDIA_DIR = /^media\//i;

/** Paths relative to public/ (forward slashes) that must not be published. */
function publicMediaOffenders(paths: readonly string[]): string[] {
  return paths.filter((p) => VIDEO.test(p) || MEDIA_DIR.test(p)).sort();
}

/** Every file under `dir`, following directory links once each. */
function walk(dir: string, seen = new Set<string>()): string[] {
  const real = realpathSync(dir);
  if (seen.has(real)) return [];
  seen.add(real);
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, seen));
    else out.push(full);
  }
  return out;
}

// The rule catches what it claims to, and nothing it should not.
{
  const sample = [
    "favicon.ico",
    "connectors/stripe.svg",
    "oasis-loop/index.html",
    "brand/sunbiz-logo.png",
    "media.svg", // a file named "media" is not under media/
    "mediakit/logo.png", // nor is a folder whose name only starts with it
    "media/arthrisil-marketing/end-card-preview.png",
    "media/x.mp4",
    "Media/poster.png",
    "clips/teaser.MOV",
    "promo.webm",
    "brand/reel.m4v",
  ];
  assert.deepEqual(
    publicMediaOffenders(sample),
    [
      "Media/poster.png",
      "brand/reel.m4v",
      "clips/teaser.MOV",
      "media/arthrisil-marketing/end-card-preview.png",
      "media/x.mp4",
      "promo.webm",
    ],
    "every video anywhere in public/ and every file under media/ is caught; images, icons and pages elsewhere are not",
  );
}

// This repository.
{
  const files = walk(PUBLIC_DIR).map((f) => relative(PUBLIC_DIR, f).split(sep).join("/"));
  // Fail closed: a walk that reached nothing would pass over an empty list.
  assert.ok(files.includes("favicon.ico"), `the walk did not reach public/ (found ${files.length} files)`);

  const offenders = publicMediaOffenders(files);
  assert.deepEqual(
    offenders,
    [],
    "public/ publishes these to anyone with the link, with no sign-in:\n  " +
      offenders.join("\n  ") +
      "\nUpload them to the private marketing-media bucket and register them as Library assets instead.",
  );

  console.log(`no-public-media: ${files.length} files under public/, no video and nothing under media/`);
}
