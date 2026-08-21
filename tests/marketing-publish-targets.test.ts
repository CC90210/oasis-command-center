/**
 * The publish gate on the founders Marketing asset page.
 * Run: npx tsx tests/marketing-publish-targets.test.ts
 *
 * REGRESSION THIS PINS (2026-08-21)
 *   The panel gated on `hasVideo: boolean`. A carousel has no video and never will,
 *   so the flag was always false and the panel announced "every channel below will
 *   refuse this asset" about the format CC pivoted the entire feed to that morning.
 *   The drain had published image decks correctly the whole time.
 *
 *   The naive fix — "just let images through" — is also wrong: TikTok and YouTube
 *   cannot take an image deck at all, and X truncates past four. Both halves are
 *   asserted below, because fixing one and not the other just moves the failure
 *   from the UI to the drain, where it costs a queued intent instead of a click.
 */
import assert from "node:assert/strict";
import {
  PUBLISH_CHANNELS,
  formatList,
  refusalFor,
  unavailableChannels,
} from "../lib/founders/publish-targets";

const byId = (id: string) => {
  const c = PUBLISH_CHANNELS.find((x) => x.id === id);
  assert.ok(c, `channel ${id} missing from PUBLISH_CHANNELS`);
  return c;
};

// -- The actual bug: a 5-slide carousel must reach its real surfaces -----------
// Mirrors the live row "OASIS Oasis Tried And Failed": asset_type carousel,
// slide_count 5, media_urls 5 entries.
for (const id of ["instagram", "threads", "linkedin"]) {
  assert.equal(
    refusalFor(byId(id), "images", 5),
    null,
    `${id} must accept a 5-slide carousel — this is the pivot CC made on 2026-08-21`,
  );
}

// -- The other half: surfaces that genuinely cannot take an image deck ---------
assert.equal(refusalFor(byId("tiktok"), "images", 5), "TikTok only accepts video");
assert.equal(refusalFor(byId("youtube"), "images", 5), "YouTube only accepts video");
assert.equal(
  refusalFor(byId("twitter"), "images", 5),
  "X accepts 4 images per post; this deck has 5",
  "X caps at 4 — matches PLATFORM_IMAGE_CAP in CMO-Agent/scripts/schedule_posts.py",
);

// A 4-slide deck is exactly the size that reaches all four image surfaces. Maven
// authors at --slides 4 for this reason; if this flips, that guidance is wrong.
assert.equal(refusalFor(byId("twitter"), "images", 4), null);
assert.deepEqual(
  unavailableChannels("images", 4).map((c) => c.id),
  ["tiktok", "youtube"],
  "a 4-slide deck should lose only the video-only surfaces",
);

// -- Video still reaches everything, and nothing reaches an empty asset --------
for (const c of PUBLISH_CHANNELS) {
  assert.equal(refusalFor(c, "video", 0), null, `${c.id} must still take video`);
  assert.equal(
    refusalFor(c, "none", 0),
    "No media is attached to this asset",
    `${c.id} must refuse an asset with no media`,
  );
}
assert.equal(unavailableChannels("none", 0).length, PUBLISH_CHANNELS.length);
assert.equal(unavailableChannels("video", 0).length, 0);

// -- Copy: the hint line is read by CC, so it should read like English --------
assert.equal(formatList(["TikTok", "YouTube", "X"]), "TikTok, YouTube and X");
assert.equal(formatList(["TikTok", "YouTube"]), "TikTok and YouTube");
assert.equal(formatList(["TikTok"]), "TikTok");
assert.equal(formatList([]), "");

// -- Guard the caps themselves: a silent edit here changes what ships ---------
assert.equal(byId("twitter").imageCap, 4);
assert.equal(byId("instagram").imageCap, 10);
assert.equal(byId("threads").imageCap, 10);
assert.equal(byId("linkedin").imageCap, 20);
assert.equal(byId("tiktok").imageCap, 0);
assert.equal(byId("youtube").imageCap, 0);

console.log("marketing-publish-targets: all assertions passed");
