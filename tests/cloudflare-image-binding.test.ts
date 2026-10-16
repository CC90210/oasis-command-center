/**
 * next/image must actually resize on Cloudflare.
 * Run: node --conditions=react-server --import tsx tests/cloudflare-image-binding.test.ts
 *
 * OpenNext serves /_next/image by handing the file to the Cloudflare Images
 * binding `env.IMAGES`. Without that binding it returns the ORIGINAL file at
 * every requested width, silently: until 2026-10-16 the 32 px nav logo on every
 * public page downloaded as the full 683x1024 JPEG (55 KB, high priority).
 * Nothing failed, so nothing noticed. This pins both halves: the binding is
 * declared in wrangler.jsonc, under the name the installed OpenNext reads.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT as ROOT } from "./_tree";

// wrangler.jsonc is kept comment-free (tests/cloudflare-runtime-parity parses it as JSON).
const wrangler = JSON.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")) as { images?: { binding?: string } };
assert.equal(
  wrangler.images?.binding,
  "IMAGES",
  'wrangler.jsonc needs "images": { "binding": "IMAGES" }, or /_next/image returns the original file at every width',
);

const handler = readFileSync(
  join(ROOT, "node_modules", "@opennextjs", "cloudflare", "dist", "cli", "templates", "images.js"),
  "utf8",
);
assert.ok(
  handler.includes("env.IMAGES.input("),
  "the installed OpenNext image handler no longer reads env.IMAGES; check which binding it expects and update wrangler.jsonc",
);

console.log("cloudflare-image-binding: wrangler.jsonc declares IMAGES, the binding OpenNext's image handler resizes with");
