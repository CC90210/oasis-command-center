/**
 * offer-pages-provider-urls.test.ts - the video links an offer page accepts
 * (lib/offer-pages/providers.ts), design section 4.2.
 *
 * WHAT IS PINNED: exactly YouTube, Vimeo and Loom, in exactly their shapes,
 * become an id; the player URL is built from that id only. Every lookalike
 * host, every other scheme (javascript:, data:), credentials or a port in the
 * URL, extra path segments and malformed ids are refused.
 *
 * Pure. Run: node --conditions=react-server --import tsx tests/offer-pages-provider-urls.test.ts
 */
import assert from "node:assert/strict";
import { embedUrl, findVideoRef, formatDuration, parseVideoLink, videoRefs } from "../lib/offer-pages/providers";
import { parseOfferPageDoc } from "../lib/offer-pages/types";

const YT = "dQw4w9WgXcQ";
const LOOM = "0123456789abcdef0123456789abcdef";
let checks = 0;

function accepts(url: string, source: string, id: string, extra: { hash?: string; vertical?: boolean } = {}) {
  const r = parseVideoLink(url);
  assert.ok(r.ok, `refused a good link: ${url}`);
  assert.equal(r.source, source, url);
  assert.equal(r.id, id, url);
  assert.equal(r.hash, extra.hash, `${url}: hash`);
  assert.equal(r.vertical, extra.vertical ?? false, `${url}: vertical`);
  checks += 1;
}

function refuses(url: string) {
  const r = parseVideoLink(url);
  assert.equal(r.ok, false, `accepted a link it must refuse: ${url}`);
  checks += 1;
}

// -- good --------------------------------------------------------------------
accepts(`https://www.youtube.com/watch?v=${YT}`, "youtube", YT);
accepts(`https://youtube.com/watch?v=${YT}&t=42s`, "youtube", YT);
accepts(`https://m.youtube.com/watch?v=${YT}`, "youtube", YT);
accepts(`https://youtu.be/${YT}`, "youtube", YT);
accepts(`youtu.be/${YT}`, "youtube", YT);
accepts(`https://www.youtube.com/shorts/${YT}`, "youtube", YT, { vertical: true });
accepts(`https://www.youtube.com/embed/${YT}`, "youtube", YT);
accepts(`https://www.youtube-nocookie.com/embed/${YT}`, "youtube", YT);
accepts("https://vimeo.com/76979871", "vimeo", "76979871");
accepts("https://vimeo.com/76979871/abcdef1234", "vimeo", "76979871", { hash: "abcdef1234" });
accepts("https://player.vimeo.com/video/76979871?h=abcdef1234", "vimeo", "76979871", { hash: "abcdef1234" });
accepts(`https://www.loom.com/share/${LOOM}`, "loom", LOOM);
accepts(`https://loom.com/share/${LOOM}?sid=x`, "loom", LOOM);

// -- hostile and malformed ---------------------------------------------------
for (const bad of [
  "",
  "   ",
  "javascript:alert(1)",
  "JavaScript:alert(document.cookie)//youtube.com/watch?v=dQw4w9WgXcQ",
  `data:text/html,<script>alert(1)</script>`,
  `ftp://youtube.com/watch?v=${YT}`,
  // Lookalike hosts.
  `https://youtube.com.evil.test/watch?v=${YT}`,
  `https://evilyoutube.com/watch?v=${YT}`,
  `https://youtu.be.evil.test/${YT}`,
  `https://www.youtube.co/watch?v=${YT}`,
  "https://vimeo.com.evil.test/76979871",
  `https://loom.co/share/${LOOM}`,
  `https://www.loom.com.evil.test/share/${LOOM}`,
  // Credentials and ports.
  `https://youtube.com@evil.test/watch?v=${YT}`,
  `https://user:pass@youtube.com/watch?v=${YT}`,
  `https://www.youtube.com:8443/watch?v=${YT}`,
  // Extra path segments.
  `https://www.youtube.com/watch/extra?v=${YT}`,
  `https://www.youtube.com/shorts/${YT}/extra`,
  `https://youtu.be/${YT}/extra`,
  "https://vimeo.com/76979871/abcdef1234/extra",
  `https://www.loom.com/share/${LOOM}/extra`,
  `https://www.loom.com/embed/${LOOM}`,
  "https://player.vimeo.com/video/76979871/extra",
  // Bad ids.
  "https://www.youtube.com/watch?v=dQw4w9WgXc",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQQ",
  "https://www.youtube.com/watch?v=dQw4w9WgX%3CQ",
  "https://www.youtube.com/watch",
  "https://vimeo.com/channels/staffpicks",
  "https://vimeo.com/76979871/NOTHEX!",
  "https://player.vimeo.com/video/76979871?h=NOT-HEX",
  `https://www.loom.com/share/${LOOM.slice(1)}`,
  "https://www.loom.com/share/0123456789abcdef0123456789abcdeZ",
  `https://www.youtube.com/watch?v=${YT}${"&x=1".repeat(200)}`,
]) {
  refuses(bad);
}

// -- the player URL is built from the id, never from what was pasted ---------
assert.equal(embedUrl({ source: "youtube", id: YT }), `https://www.youtube-nocookie.com/embed/${YT}?autoplay=1&rel=0&playsinline=1`);
assert.equal(embedUrl({ source: "vimeo", id: "76979871", hash: "abcdef1234" }), "https://player.vimeo.com/video/76979871?h=abcdef1234&autoplay=1&dnt=1");
assert.equal(embedUrl({ source: "vimeo", id: "76979871" }), "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1");
assert.equal(embedUrl({ source: "loom", id: LOOM }), `https://www.loom.com/embed/${LOOM}?autoplay=1`);
assert.equal(embedUrl({ source: "youtube", id: "x\"><script>" }), null, "an id that is not an id builds nothing");
assert.equal(embedUrl({ source: "vimeo", id: "76979871", hash: "\"onload=" }), "https://player.vimeo.com/video/76979871?autoplay=1&dnt=1", "a bad hash is dropped");
checks += 6;

// -- refs: where each video sits ---------------------------------------------
const OK = { by: "u", at: "2026-10-08T12:00:00.000Z" };
const doc = parseOfferPageDoc({
  v: 1,
  template: "book_call",
  theme: { canvas: "dark" },
  nav: { pinned: [] },
  hero: { headline: "H", video: { source: "youtube", id: YT, rights: OK, aspect: "16:9" } },
  sections: [
    { key: "what_you_get", items: [{ title: "a" }, { title: "b", video: { source: "loom", id: LOOM, rights: OK, aspect: "16:9" } }] },
    { key: "work", items: [{ title: "w", video: { source: "vimeo", id: "1", rights: OK, aspect: "9:16" } }] },
    {
      key: "results",
      items: [
        { kind: "quote", quote: "q", who: "w", evidence: { permission: true, confirmed: OK } },
        { kind: "video", video: { source: "youtube", id: YT, rights: OK, aspect: "1:1" }, evidence: { permission: true, confirmed: OK } },
      ],
    },
  ],
  book: { mode: "form", qualify: "after" },
  seo: { indexable: false },
});
assert.deepEqual(videoRefs(doc).map((v) => v.ref), ["hero", "what_you_get:1", "work:0", "results:1"]);
assert.equal(findVideoRef(doc, "results:1")?.aspect, "1:1");
assert.equal(findVideoRef(doc, "results:0"), null, "a quote has no video");
assert.equal(findVideoRef(doc, "work:9"), null);
assert.equal(findVideoRef(doc, "hero;drop"), null, "a malformed ref is nothing");
assert.equal(formatDuration(252), "4:12");
assert.equal(formatDuration(3725), "1:02:05");
assert.equal(formatDuration(undefined), "");
checks += 8;

console.log(`offer-pages-provider-urls: OK - ${checks} checks`);
