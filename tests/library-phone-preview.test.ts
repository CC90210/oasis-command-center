/**
 * Every Library asset shows the way it lands on a phone, and no tile loads a
 * video until someone opens it.
 * Run: node --conditions=react-server --import tsx tests/library-phone-preview.test.ts
 *
 * WHY THIS EXISTS
 * CC asked three times for an "iPhone-frame preview like Instagram/TikTok", "for
 * all content including chat-made". And on 2026-10-01 the Library took minutes
 * to open: every video tile was a <video preload="metadata">, which for an MP4
 * without faststart reads deep into the file, on every tile at once.
 *
 * WHAT IS PINNED
 *  1. phoneMediaFit: 9:16 fills the phone's reel area; 4:5, 1:1 and 16:9 are
 *     letterboxed at their real shape; taller than 9:16 is pillarboxed; never
 *     cropped. Measured pixels beat the label, as in mediaFrame().
 *  2. PhoneFrame, drawn in full React (tests/library-phone-preview.render.ts):
 *     a 9:19.5 screen, the media box at those exact proportions, both chromes,
 *     and no image anywhere in the frame itself (CSS only).
 *  3. Grid tiles, in both presentations and for every kind of asset: no
 *     <video> on arrival (and any <video> a tile file can render is
 *     preload="none"); every <img> is lazy, async and carries its width and
 *     height; a carousel draws its first slide only; an asset with no media
 *     still shows its copy on the phone instead of a blank tile.
 *  4. TileVideo, driven frame by frame: the <video> mounts on the cover's click
 *     and on nothing else (not on mount, not when hydration runs the effects);
 *     the phone player pauses and plays from a real button whose name says
 *     which, with the decorative icon hidden from assistive tech; the asset
 *     page's player (initialOpen) is open from the start with its first frame
 *     and plays nothing on its own; Library tiles never pass initialOpen.
 *  5. The slide-order strip's thumbnails are lazy and async, and a tile's link
 *     carries the Library view it sits in (?from=) for the asset page's way back.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PHONE_REEL_RATIO, PHONE_SCREEN_RATIO, phoneMediaFit } from "../lib/founders-marketing-core";

const ROOT = join(__dirname, "..");

let failed = 0;
let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${(e as Error).message.split("\n").join("\n       ")}`);
  }
}

/** Source without comments: the docs above an element may quote the markup it replaced. */
const code = (file: string) =>
  readFileSync(join(ROOT, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The opening tag of every element with this name, attributes included. */
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
/** The inline style of the media box the frame lays the asset out in. */
const mediaBox = (html: string) => {
  const t = tags(html, "div").find((d) => d.includes("data-media-box"));
  assert.ok(t, "the frame draws a media box");
  return attr(t!, "style") ?? "";
};

console.log("library-phone-preview");

// ── 1. the fit, pure ────────────────────────────────────────────────────────
check("phoneMediaFit: 9:16 fills, 4:5 / 1:1 / 16:9 letterbox, taller pillarboxes", () => {
  assert.ok(Math.abs(PHONE_SCREEN_RATIO - 9 / 19.5) < 1e-12, "the screen is an iPhone's 9:19.5");
  assert.ok(Math.abs(PHONE_REEL_RATIO - 9 / 16) < 1e-12);
  assert.deepEqual(phoneMediaFit(1080, 1920), { mode: "fill", ratio: 0.5625, widthPct: 100, heightPct: 100 });
  assert.deepEqual(phoneMediaFit(1080, 1350), { mode: "letterbox", ratio: 0.8, widthPct: 100, heightPct: 70.3125 });
  assert.deepEqual(phoneMediaFit(1080, 1080), { mode: "letterbox", ratio: 1, widthPct: 100, heightPct: 56.25 });
  const wide = phoneMediaFit(1920, 1080);
  assert.equal(wide.mode, "letterbox");
  assert.equal(wide.heightPct, 31.6406);
  const tall = phoneMediaFit(1080, 2340);
  assert.equal(tall.mode, "pillarbox");
  assert.equal(tall.heightPct, 100);
  assert.equal(tall.widthPct, 82.0513);
});

check("phoneMediaFit: pixels beat the label, the label beats nothing, a near-9:16 export still fills", () => {
  assert.equal(phoneMediaFit(1080, 1350, "9:16").mode, "letterbox", "a 4:5 card mislabelled 9:16 is still 4:5");
  assert.equal(phoneMediaFit(null, null, "1:1").heightPct, 56.25);
  assert.equal(phoneMediaFit(null, null, null).mode, "fill", "no shape at all takes the whole reel area");
  assert.equal(phoneMediaFit(1, 1000, "4:5").heightPct, 70.3125, "an absurd ratio is a corrupt row: fall back to the label");
  assert.equal(phoneMediaFit(1080, 1916).mode, "fill", "within 2% of 9:16 is 9:16");
});

// ── 2 + 3. drawn in full React ──────────────────────────────────────────────
const r = spawnSync(process.execPath, ["--import", "tsx", "tests/library-phone-preview.render.ts"], {
  cwd: ROOT,
  encoding: "utf8",
  env: { ...process.env, NODE_OPTIONS: "" },
  maxBuffer: 32 * 1024 * 1024,
});
if (r.status !== 0) {
  console.error(r.stderr || r.stdout);
  throw new Error(`tests/library-phone-preview.render.ts exited ${r.status}`);
}
const drawn = JSON.parse(r.stdout) as {
  frames: Record<string, string>;
  tiles: Record<string, string>;
  player: {
    mount: string;
    afterHydration: string;
    afterClick: string;
    callsAfterClick: string[];
    playing: string;
    callsAfterPause: string[];
    paused: string;
    callsAfterPlay: string[];
    openMount: string;
    openAfterHydration: string;
    openCalls: string[];
    nativeAfterHydration: string;
    nativeAfterClick: string;
  };
  slideReorder: string;
};

check("PhoneFrame draws a 9:19.5 screen with the asset's media inside it", () => {
  for (const [name, html] of Object.entries(drawn.frames)) {
    assert.ok(html.includes("data-phone-frame"), `${name}: marked as a phone frame`);
    assert.match(html, /aspect-ratio:9 \/ 19\.5/, `${name}: the screen is 9:19.5`);
    assert.ok(html.includes('data-probe="media"'), `${name}: the asset is inside the frame`);
  }
});

check("PhoneFrame fills 9:16 and letterboxes 1:1 and 4:5 (and 16:9) without cropping", () => {
  assert.match(drawn.frames.reel, /data-fit="fill"/);
  assert.equal(mediaBox(drawn.frames.reel), "left:0%;top:0%;width:100%;height:100%");

  assert.match(drawn.frames.square, /data-fit="letterbox"/);
  assert.equal(mediaBox(drawn.frames.square), "left:0%;top:21.875%;width:100%;height:56.25%");

  assert.match(drawn.frames.card45, /data-fit="letterbox"/);
  assert.equal(mediaBox(drawn.frames.card45), "left:0%;top:14.84375%;width:100%;height:70.3125%");

  assert.match(drawn.frames.wide, /data-fit="letterbox"/);
  assert.match(mediaBox(drawn.frames.wide), /width:100%;height:31\.6406%/);

  assert.match(drawn.frames.tall, /data-fit="pillarbox"/);
  assert.match(mediaBox(drawn.frames.tall), /width:82\.0513%;height:100%/);

  assert.equal(mediaBox(drawn.frames.labelOnly), "left:0%;top:14.84375%;width:100%;height:70.3125%");
});

check("PhoneFrame is CSS only: no image in the frame, the overlay states only what the asset says", () => {
  for (const [name, html] of Object.entries(drawn.frames)) {
    assert.equal(tags(html, "img").length, 0, `${name}: the frame itself draws no <img>`);
    assert.ok(!/url\(/.test(html), `${name}: and no background image`);
  }
  assert.ok(drawn.frames.reel.includes("OASIS AI"), "the account line is the brand name as stored");
  assert.ok(drawn.frames.reel.includes("Caption from the hook"), "the caption is the asset's own copy");
  assert.ok(!/\d+(\.\d+)?[KkMm]\b/.test(drawn.frames.reel.replace(/<[^>]+>/g, " ")), "no invented like or view counts");
  assert.ok(drawn.frames.reel.includes("Reels"), "Instagram chrome by default");
  assert.ok(drawn.frames.tiktok.includes("For You"), "TikTok chrome on request");
  assert.ok(drawn.frames.guides.includes("border-dashed"), "safe-zone guides draw when asked");
  assert.ok(!drawn.frames.reel.includes("border-dashed"), "and not otherwise");
});

check("no grid tile renders a <video> on arrival; any tile <video> is preload=\"none\"", () => {
  for (const [name, html] of Object.entries(drawn.tiles)) {
    const videos = tags(html, "video");
    assert.equal(videos.length, 0, `${name}: a <video> mounted before anyone opened the asset`);
    for (const v of videos) assert.equal(attr(v, "preload"), "none", `${name}: ${v}`);
  }
  for (const name of ["videoPoster:grid", "videoPoster:phone", "videoBare:grid", "videoBare:phone"]) {
    assert.match(drawn.tiles[name], /aria-label="Play Asset title"/, `${name}: the video waits behind a play button`);
  }
  // Every other <video> a tile file can render is preload="none" in source. A
  // grid tile reaches only these files (PhoneEnlarge and PhoneEnlargeOverlay:
  // the big phone a tile opens, which draws the tile's own media and no <video>
  // of its own).
  for (const file of [
    "components/founders/marketing-shared.tsx",
    "components/founders/CarouselFrame.tsx",
    "components/founders/PhoneFrame.tsx",
    "components/founders/PhoneEnlarge.tsx",
    "components/founders/PhoneEnlargeOverlay.tsx",
  ]) {
    const src = code(file);
    const elements = src.match(/<video\b[\s\S]*?\/?>/g) ?? [];
    for (const el of elements) {
      assert.match(el, /preload="none"/, `${file}: a tile <video> must be preload="none":\n${el}`);
    }
    assert.ok(!/preload="(metadata|auto)"/.test(src), `${file}: no tile media may preload`);
  }
  // TileVideo's one <video> is the opened one. It preloads only on the asset
  // page (initialOpen), which no tile passes - checked, drawn, further down.
  const tileVideo = code("components/founders/TileVideo.tsx");
  assert.equal((tileVideo.match(/<video\b/g) ?? []).length, 1, "TileVideo has exactly one <video>, the opened one");
  assert.deepEqual(
    tileVideo.match(/preload=\{?[^\s>]*/g),
    ['preload={initialOpen'],
    "TileVideo's preload is decided by initialOpen and nothing else",
  );
  assert.ok(!/preload="(metadata|auto)"/.test(tileVideo), "TileVideo hardcodes no preloading");
});

check("a tile's <video> mounts on the cover's click and on nothing else - not on mount, not on hydration", () => {
  const p = drawn.player;
  assert.equal(tags(p.mount, "video").length, 0, "a <video> on mount");
  assert.match(p.mount, /aria-label="Play Asset title"/, "the cover is a named play button");
  assert.equal(tags(p.afterHydration, "video").length, 0, "the hydration commit (effects) opened the player");
  const opened = tags(p.afterClick, "video");
  assert.equal(opened.length, 1, "the click mounts the <video>");
  assert.equal(attr(opened[0], "preload"), "none", "and it loads nothing before play() asks for it");
  assert.deepEqual(p.callsAfterClick, ["play"], "the click is what plays it");
  assert.equal(tags(p.nativeAfterHydration, "video").length, 0, "the plain grid's cover survives hydration too");
  const native = tags(p.nativeAfterClick, "video");
  assert.equal(native.length, 1);
  assert.equal(attr(native[0], "preload"), "none", "the plain grid's player too");
  assert.ok(/\scontrols=""/.test(native[0]), "with the browser's controls");
});

check("the phone player pauses and plays from a real button named for what it will do", () => {
  const p = drawn.player;
  const named = (html: string, label: string) =>
    tags(html, "button").filter((b) => attr(b, "aria-label") === label);
  assert.equal(named(p.afterClick, "Play Asset title").length, 1, "paused: the button says Play");
  assert.equal(named(p.playing, "Pause Asset title").length, 1, "playing: the button says Pause");
  assert.equal(named(p.playing, "Play Asset title").length, 0, "and not Play");
  assert.deepEqual(p.callsAfterPause, ["play", "pause"], "the button pauses the playing video");
  assert.equal(named(p.paused, "Play Asset title").length, 1, "paused again: it says Play");
  assert.deepEqual(p.callsAfterPlay, ["play", "pause", "play"], "and plays it again");
  // The big play glyph is decoration on a named button: hidden from assistive tech.
  assert.match(
    p.afterClick,
    /<button[^>]*aria-label="Play Asset title"[^>]*><span aria-hidden="true"[^>]*><svg\b[^>]*aria-hidden="true"/,
    "the play glyph inside the button is aria-hidden",
  );
  const video = tags(p.afterClick, "video")[0];
  assert.ok(!/\scontrols=/.test(video), "no desktop control bar over the caption in the phone");
});

check("the asset page's player is open from the start, shows its first frame, and plays nothing on its own", () => {
  const p = drawn.player;
  const v = tags(p.openMount, "video");
  assert.equal(v.length, 1, "no cover in front of the asset the viewer opened");
  assert.equal(attr(v[0], "preload"), "metadata", "its first frame stands in for the missing poster");
  assert.ok(!p.openMount.includes("No cover image on file"), "never the black 'No cover image' box");
  assert.deepEqual(p.openCalls, [], "nothing autoplays");
  assert.match(p.openAfterHydration, /aria-label="Play Asset title"/, "it waits for its play button");
  const detail = code("app/founders/marketing/asset/[id]/page.tsx");
  assert.match(detail, /<TileVideo\b[^>]*\bvariant="phone"[^>]*\binitialOpen\b/, "the asset page opens its phone player");
  for (const file of [
    "components/founders/marketing-shared.tsx",
    "app/founders/marketing/library/page.tsx",
    "components/founders/PhoneEnlarge.tsx",
    "components/founders/PhoneEnlargeOverlay.tsx",
  ]) {
    assert.ok(!/initialOpen/.test(code(file)), `${file}: a Library tile stays a cover until play`);
  }
});

check("the slide-order thumbnails are lazy and async", () => {
  const imgs = tags(drawn.slideReorder, "img");
  assert.equal(imgs.length, 3);
  for (const img of imgs) {
    assert.equal(attr(img, "loading"), "lazy", img);
    assert.equal(attr(img, "decoding"), "async", img);
  }
});

check("a tile links to its asset page with the Library view it sits in", () => {
  const withView = tags(drawn.tiles["returnTo:phone"], "a").map((a) => attr(a, "href"));
  assert.ok(
    withView.includes("/founders/marketing/asset/a1?from=%2Ffounders%2Fmarketing%2Flibrary%3Fgroup%3Dclients%26view%3Dgrid%26page%3D2"),
    `tile links: ${withView.join(", ")}`,
  );
  const plain = tags(drawn.tiles["videoPoster:phone"], "a").map((a) => attr(a, "href"));
  assert.ok(plain.includes("/founders/marketing/asset/a1"), "no view to carry: the bare asset link");
});

check("every tile <img> is lazy, async and sized; a carousel draws its first slide only", () => {
  let images = 0;
  for (const [name, html] of Object.entries(drawn.tiles)) {
    for (const img of tags(html, "img")) {
      images += 1;
      assert.equal(attr(img, "loading"), "lazy", `${name}: ${img}`);
      assert.equal(attr(img, "decoding"), "async", `${name}: ${img}`);
      assert.ok(attr(img, "width") && attr(img, "height"), `${name}: explicit width and height: ${img}`);
    }
  }
  assert.ok(images >= 6, `expected tile images to police, saw ${images}`);
  for (const name of ["carousel:grid", "carousel:phone"]) {
    const imgs = tags(drawn.tiles[name], "img");
    assert.equal(imgs.length, 1, `${name}: one slide on arrival`);
    assert.equal(attr(imgs[0], "src"), "https://media.test/slide_1.png", `${name}: the first slide`);
  }
  assert.equal(tags(drawn.tiles["videoBare:grid"], "img").length, 0, "no poster on file means no image request");
});

check("the phone view frames every kind of asset, including the ones with no media", () => {
  for (const [name, html] of Object.entries(drawn.tiles)) {
    const phone = name.endsWith(":phone");
    assert.equal(html.includes("data-phone-frame"), phone, `${name}: phone frame only in the phone view`);
  }
  assert.ok(drawn.tiles["copy:phone"].includes("A caption drafted in chat"), "a copy-only asset shows its copy on the phone");
  assert.ok(drawn.tiles["copy:phone"].includes("Text post"));
  assert.ok(drawn.tiles["html:phone"].includes("HTML page"));
  for (const name of ["copy:phone", "html:phone"]) {
    assert.ok(!drawn.tiles[name].includes("no preview"), `${name}: not a blank tile`);
  }
  assert.match(drawn.tiles["image:phone"], /data-fit="letterbox"/, "a 1:1 card is letterboxed in the tile too");
  assert.match(drawn.tiles["videoPoster:phone"], /data-fit="fill"/, "a 9:16 reel fills the tile");
});

console.log(`\nlibrary-phone-preview: ${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
