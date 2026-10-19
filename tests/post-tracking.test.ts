/**
 * tests/post-tracking.test.ts - every post through Zernio, accounted for on its Library
 * row (CC, 2026-10-18).
 *
 *   1. postTrackingOf reads meta.zernio as CMO-Agent's library_tracking.py writes it:
 *      networks in a fixed order, each with its own label, tone, live link (posted only)
 *      and error (failed only); a summary per outcome. Missing or malformed reads as
 *      null; only an http(s) address becomes a link.
 *   2. A booked card is "Scheduled", not "Needs review": lifecycleOf and its label.
 *   3. The asset page draws the "Where it went" card from that record.
 *
 * Run: node --conditions=react-server --import tsx tests/post-tracking.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { postTrackingOf } from "../lib/founders/post-tracking";
import { LIFECYCLE, lifecycleLabel, lifecycleOf } from "../lib/founders-marketing-core";

const root = join(__dirname, "..");
let failures = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message.split("\n").join("\n        ")}`);
  }
}

/** The shape library_tracking.py writes (a real card, 2026-10-16). */
const META = {
  sha256: "x",
  zernio: {
    post_id: "6ad10df5fcd23d4a26747675",
    status: "published",
    scheduled_for: "2026-10-16T13:00:00.000Z",
    outcome: "partial",
    checked_at: "2026-10-19T01:00:00.000Z",
    platforms: {
      twitter: { status: "published", published_at: "2026-10-16T13:03:29.819Z", url: "https://twitter.com/i/web/status/2", error: null },
      instagram: { status: "published", published_at: "2026-10-16T13:03:47.179Z", url: "https://www.instagram.com/p/DejmLJjiuoQ/", error: null },
      threads: { status: "failed", published_at: null, url: "javascript:alert(1)", error: "Media upload timed out" },
      linkedin: { status: "pending", published_at: null, url: null, error: null },
    },
  },
};

async function main() {
  console.log("post-tracking:");

  await check("postTrackingOf reads each network's outcome, in a fixed order, with links only where posted", () => {
    const t = postTrackingOf(META)!;
    assert.equal(t.postId, "6ad10df5fcd23d4a26747675");
    assert.equal(t.outcome, "partial");
    assert.equal(t.summary, "Posted on some networks; at least one failed.");
    assert.equal(t.scheduledFor, "2026-10-16T13:00:00.000Z");
    assert.deepEqual(t.networks.map((n) => n.platform), ["instagram", "linkedin", "threads", "twitter"]);
    const by = Object.fromEntries(t.networks.map((n) => [n.platform, n]));
    assert.deepEqual([by.instagram.name, by.instagram.label, by.instagram.tone, by.instagram.url],
      ["Instagram", "Posted", "engaged", "https://www.instagram.com/p/DejmLJjiuoQ/"]);
    assert.deepEqual([by.twitter.name, by.twitter.label], ["X", "Posted"]);
    assert.deepEqual([by.threads.label, by.threads.tone, by.threads.url, by.threads.error],
      ["Failed", "hot", null, "Media upload timed out"], "a failed network shows its error and never a link");
    assert.deepEqual([by.linkedin.label, by.linkedin.tone], ["Waiting for its slot", "info"]);
    // The driver may hand meta back as JSON text.
    assert.deepEqual(postTrackingOf(JSON.stringify(META)), t);
  });

  await check("no tracking reads as null; a posted network with a non-web URL gets no link", () => {
    for (const raw of [null, undefined, "", "not json", "[]", {}, { sha256: "x" }, { zernio: {} }]) {
      assert.equal(postTrackingOf(raw), null, JSON.stringify(raw));
    }
    const t = postTrackingOf({ zernio: { outcome: "published", platforms: { instagram: { status: "published", url: "data:text/html,x" } } } })!;
    assert.equal(t.networks[0].url, null);
    // A hostile key never reaches React as an object, and the list is capped.
    const proto = postTrackingOf(JSON.parse('{"zernio":{"platforms":{"__proto__":{"status":"published"},"constructor":{"status":"failed"}}}}'))!;
    for (const n of proto.networks) assert.equal(typeof n.name, "string", n.platform);
    const many = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`net${i}`, { status: "pending" }]));
    assert.equal(postTrackingOf({ zernio: { platforms: many } })!.networks.length, 12);
    assert.equal(postTrackingOf({ zernio: { outcome: "missing" } })!.summary,
      "Zernio no longer has this post; it was removed or rebooked.");
  });

  await check("a booked card is Scheduled, not Needs review; posted still wins", () => {
    assert.ok((LIFECYCLE as readonly string[]).includes("scheduled"));
    assert.equal(lifecycleOf({ status: "scheduled", published_at: null }), "scheduled");
    assert.equal(lifecycleLabel("scheduled"), "Scheduled");
    assert.equal(lifecycleOf({ status: "scheduled", published_at: "2026-10-16T13:03:29Z" }), "live");
    assert.equal(lifecycleOf({ status: "in_review", published_at: null }), "needs_review");
  });

  await check("the asset page draws Where it went from meta.zernio", () => {
    const page = readFileSync(join(root, "app/founders/marketing/asset/[id]/page.tsx"), "utf8");
    assert.match(page, /postTrackingOf\(\(asset as \{ meta\?: unknown \}\)\.meta\)/);
    assert.match(page, /<Card title="Where it went" subtitle=\{tracking\.summary\}>/);
    assert.match(page, /data-testid="where-it-went"/);
  });

  if (failures) {
    console.log(`post-tracking: ${failures} failure(s)`);
    process.exit(1);
  }
  console.log("post-tracking: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
