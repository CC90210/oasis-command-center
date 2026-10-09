/**
 * offer-pages-doc.test.ts - the offer page document's strict parser
 * (lib/offer-pages/types.ts parseOfferPageDoc), design section 3.3.
 *
 * WHAT IS PINNED:
 *   - every section kind parses when valid, in order, and round-trips;
 *   - an unknown key anywhere is refused, and the error names the exact path;
 *   - the copy caps (headline 140, subheadline 400, item title 120, item body
 *     600, FAQ answer 1,200) and the per-section item caps;
 *   - copy is plain text: markup and control characters are refused, a bare
 *     "<" in a sentence is fine;
 *   - the accent is #rrggbb and must clear AA on the page;
 *   - provider ids: YouTube 11 chars, Vimeo digits (a hash only on Vimeo),
 *     Loom 32 hex;
 *   - nothing that would be a claim exists without an owner: a result without
 *     evidence or permission, a value without confirmation, a video without
 *     its rights tick are all refused;
 *   - the whole document is capped at 200 KB;
 *   - booking on the page (native) is refused until PR3, the canvas is dark
 *     only, the page is never indexable;
 *   - a refused field reaches the owner in the builder's words ("Bonus 2
 *     title"), never as its path (lib/offer-pages/field-labels.ts).
 *
 * Pure: no database. Run: node --conditions=react-server --import tsx tests/offer-pages-doc.test.ts
 */
import assert from "node:assert/strict";
import { OfferPageError, accentPassesAA, contrastRatio, parseOfferPageDoc } from "../lib/offer-pages/types";
import { fieldLabel } from "../lib/offer-pages/field-labels";

const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };
const YT = { source: "youtube", id: "dQw4w9WgXcQ", rights: OK, aspect: "16:9" };

/** A fresh copy every time: the checks below mutate what they are handed. */
function fullDoc(): Record<string, unknown> {
  return structuredClone({
    v: 1,
    template: "book_call",
    theme: { canvas: "dark", accent: "#e8c547", logo: "workspace" },
    nav: { pinned: ["what_you_get", "results", "bonuses"], cta_label: "Book a call" },
    hero: {
      eyebrow: "For service businesses",
      headline: "Answer every lead in a minute",
      subheadline: "A walkthrough of the system.",
      cta_label: "Book a walkthrough",
      video: { source: "library", asset_id: "a-1", video_media_id: "m-1", poster_media_id: "m-2", caption_media_id: "m-3", rights: OK, aspect: "16:9", duration_s: 252 },
      vsl_script: { text: "Hi, I'm the founder.", source: "cc" },
      show_transcript: true,
      booking_card: false,
    },
    sections: [
      { key: "what_you_get", title: "What you get", items: [{ title: "A built system", body: "Yours to keep.", video: YT }] },
      { key: "obstacles", items: [{ title: "Leads go cold", body: "Nobody owns follow-up." }] },
      { key: "work", items: [{ title: "Client portal", video: { source: "vimeo", id: "76979871", hash: "abcdef12", rights: OK, aspect: "16:9" } }] },
      {
        key: "results",
        items: [
          { kind: "quote", quote: "It paid for itself.", who: "Dana", role: "Owner", evidence: { permission: true, confirmed: OK } },
          { kind: "metric", value: "3x", label: "faster replies", source: "CRM export", evidence: { permission: true, confirmed: OK } },
          { kind: "video", video: { source: "loom", id: "0123456789abcdef0123456789abcdef", rights: OK, aspect: "9:16" }, label: "Walkthrough", evidence: { permission: true, confirmed: OK } },
          { kind: "screenshot", image: { asset_id: "a-9", media_id: "m-9" }, alt: "Inbox before and after", evidence: { permission: true, confirmed: OK } },
        ],
      },
      { key: "bonuses", items: [{ title: "Setup call", value: { cents: 50000, currency: "CAD", confirmed: OK } }], value_note: "Standalone price." },
      { key: "guarantee", body: "Your money back in 30 days.", terms_url: "https://oasisai.work/terms", confirmed: OK },
      { key: "faq", items: [{ q: "How long?", a: "Two weeks." }] },
    ],
    book: { title: "Book a walkthrough", mode: "form_then_link", qualify: "after" },
    seo: { title: "Offer", description: "A page.", indexable: false },
    brief: { audience: "Plumbers", requested_at: "2026-10-08T12:00:00.000Z" },
  });
}

function refused(mutate: (d: Record<string, unknown>) => void, path: string | RegExp, reason?: RegExp): void {
  const d = fullDoc();
  mutate(d);
  try {
    parseOfferPageDoc(d);
  } catch (err) {
    assert.ok(err instanceof OfferPageError, `expected OfferPageError, got ${String(err)}`);
    if (typeof path === "string") assert.equal(err.path, path, `wrong path: ${err.path} (${err.reason})`);
    else assert.match(err.path, path, `wrong path: ${err.path} (${err.reason})`);
    if (reason) assert.match(err.reason, reason);
    return;
  }
  assert.fail(`accepted a document it should refuse (expected ${String(path)})`);
}

const sec = (d: Record<string, unknown>, key: string) =>
  (d.sections as Array<Record<string, unknown>>).find((s) => s.key === key) as Record<string, unknown>;
const items = (d: Record<string, unknown>, key: string) => sec(d, key).items as Array<Record<string, unknown>>;

let n = 0;
/** One named group of checks; the name is for the reader (a failure throws with its own message). */
function t(_name: string, fn: () => void) {
  fn();
  n += 1;
}

// -- valid -------------------------------------------------------------------
t("a full document parses, keeps its order, and round-trips", () => {
  const doc = parseOfferPageDoc(fullDoc());
  assert.deepEqual(doc.sections.map((s) => s.key), ["what_you_get", "obstacles", "work", "results", "bonuses", "guarantee", "faq"]);
  assert.equal(doc.theme.accent, "#E8C547", "the accent is stored upper-case");
  assert.deepEqual(parseOfferPageDoc(JSON.stringify(doc)), doc, "a stored document parses back to itself");
  assert.equal(doc.brief?.audience, "Plumbers");
});

t("an empty page (template only) parses", () => {
  const doc = parseOfferPageDoc({ v: 1, template: "free_audit", theme: { canvas: "dark" }, nav: { pinned: [] }, hero: {}, sections: [], book: { mode: "form", qualify: "after" }, seo: { indexable: false } });
  assert.deepEqual(doc.sections, []);
});

t("an item being typed (empty title) is kept: the renderer, not the parser, drops it", () => {
  const d = fullDoc();
  items(d, "obstacles").push({ title: "" });
  assert.equal(parseOfferPageDoc(d).sections.find((s) => s.key === "obstacles")?.key, "obstacles");
});

t("a bare < in a sentence is plain text", () => {
  const d = fullDoc();
  items(d, "faq")[0].a = "Usually < 2 weeks.";
  parseOfferPageDoc(d);
});

// -- unknown keys, with the exact path ---------------------------------------
t("unknown keys are refused at every level, naming the path", () => {
  refused((d) => (d.extra = 1), "$.extra", /unknown key/);
  refused((d) => ((d.hero as Record<string, unknown>).html = "<b>"), "$.hero.html", /unknown key/);
  refused((d) => (sec(d, "faq").style = "x"), "$.sections[6].style", /unknown key/);
  refused((d) => (items(d, "what_you_get")[0].price = "$9"), "$.sections[0].items[0].price", /unknown key/);
  refused((d) => (((d.hero as Record<string, unknown>).video as Record<string, unknown>).src = "https://x.test/v.mp4"), "$.hero.video.src", /unknown key/);
  refused((d) => ((items(d, "results")[0].evidence as Record<string, unknown>).note = "trust me"), "$.sections[3].items[0].evidence.note");
  refused((d) => ((d.theme as Record<string, unknown>).font = "Comic"), "$.theme.font");
});

// -- caps --------------------------------------------------------------------
t("copy caps: headline 140, subheadline 400, item title 120, item body 600, FAQ answer 1,200", () => {
  const ok = (len: number) => "a".repeat(len);
  const h = (d: Record<string, unknown>) => d.hero as Record<string, unknown>;
  // At the cap: accepted.
  const at = fullDoc();
  h(at).headline = ok(140);
  h(at).subheadline = ok(400);
  items(at, "obstacles")[0].title = ok(120);
  items(at, "obstacles")[0].body = ok(600);
  items(at, "faq")[0].a = ok(1200);
  parseOfferPageDoc(at);
  // One over: refused, each naming its own path.
  refused((d) => (h(d).headline = ok(141)), "$.hero.headline", /140/);
  refused((d) => (h(d).subheadline = ok(401)), "$.hero.subheadline", /400/);
  refused((d) => (items(d, "obstacles")[0].title = ok(121)), "$.sections[1].items[0].title", /120/);
  refused((d) => (items(d, "obstacles")[0].body = ok(601)), "$.sections[1].items[0].body", /600/);
  refused((d) => (items(d, "faq")[0].a = ok(1201)), "$.sections[6].items[0].a", /1200/);
});

t("item caps per section", () => {
  refused((d) => (sec(d, "what_you_get").items = Array.from({ length: 9 }, () => ({ title: "x" }))), "$.sections[0].items", /at most 8/);
  refused((d) => (sec(d, "obstacles").items = Array.from({ length: 11 }, () => ({ title: "x" }))), "$.sections[1].items", /at most 10/);
  refused((d) => (sec(d, "faq").items = Array.from({ length: 21 }, () => ({ q: "q", a: "a" }))), "$.sections[6].items", /at most 20/);
});

t("plain text only: markup and control characters are refused", () => {
  refused((d) => ((d.hero as Record<string, unknown>).headline = "<script>alert(1)</script>"), "$.hero.headline", /plain text/);
  refused((d) => (items(d, "faq")[0].a = "Read <a href=x>this</a>"), "$.sections[6].items[0].a", /plain text/);
  refused((d) => ((d.hero as Record<string, unknown>).headline = "bad\u0007bell"), "$.hero.headline", /control/);
});

// -- colour ------------------------------------------------------------------
t("the accent is #rrggbb and must clear AA on the page", () => {
  refused((d) => ((d.theme as Record<string, unknown>).accent = "E8C547"), "$.theme.accent", /colour/);
  refused((d) => ((d.theme as Record<string, unknown>).accent = "#abc"), "$.theme.accent");
  refused((d) => ((d.theme as Record<string, unknown>).accent = "#1D4ED8"), "$.theme.accent", /too dark/);
  assert.equal(accentPassesAA("#00D4FF"), true, "signal cyan passes");
  assert.equal(accentPassesAA("#E8C547"), true, "the funnels' gold passes");
  assert.equal(accentPassesAA("#1D4ED8"), false, "dark blue does not");
  assert.ok(contrastRatio("#FFFFFF", "#000000") > 20.9 && contrastRatio("#FFFFFF", "#000000") < 21.1, "contrast math is WCAG's");
});

// -- provider ids ------------------------------------------------------------
t("provider ids: YouTube 11, Vimeo digits with an optional hash, Loom 32 hex", () => {
  const vid = (d: Record<string, unknown>) => items(d, "what_you_get")[0].video as Record<string, unknown>;
  refused((d) => (vid(d).id = "dQw4w9WgXc"), "$.sections[0].items[0].video.id", /youtube/);
  refused((d) => (vid(d).id = "dQw4w9WgXcQQ"), "$.sections[0].items[0].video.id");
  refused((d) => (vid(d).id = "dQw4w9WgX<Q"), "$.sections[0].items[0].video.id");
  refused((d) => (vid(d).hash = "abcdef12"), "$.sections[0].items[0].video.hash", /Vimeo/);
  refused((d) => (((items(d, "work")[0].video as Record<string, unknown>).id = "76979871x")), "$.sections[2].items[0].video.id");
  refused((d) => (((items(d, "work")[0].video as Record<string, unknown>).hash = "ABCDEF12")), "$.sections[2].items[0].video.hash");
  refused((d) => (((items(d, "results")[2].video as Record<string, unknown>).id = "0123456789abcdef0123456789abcde")), "$.sections[3].items[2].video.id");
  refused((d) => (vid(d).source = "dailymotion"), "$.sections[0].items[0].video.source");
  refused((d) => (vid(d).thumb_path = "other-tenant/../secret.jpg"), "$.sections[0].items[0].video.thumb_path");
});

// -- claims need an owner ----------------------------------------------------
t("a result needs evidence, the client's permission and a confirmation", () => {
  refused((d) => delete items(d, "results")[0].evidence, "$.sections[3].items[0].evidence", /evidence/);
  refused((d) => ((items(d, "results")[0].evidence as Record<string, unknown>).permission = false), "$.sections[3].items[0].evidence.permission", /permission/);
  refused((d) => delete (items(d, "results")[0].evidence as Record<string, unknown>).confirmed, "$.sections[3].items[0].evidence.confirmed");
  refused((d) => ((items(d, "results")[1].evidence as Record<string, unknown>).confirmed = { by: "", at: OK.at }), "$.sections[3].items[1].evidence.confirmed.by");
});

t("a value needs an owner's confirmation; a video needs its rights tick", () => {
  refused((d) => delete (items(d, "bonuses")[0].value as Record<string, unknown>).confirmed, "$.sections[4].items[0].value.confirmed", /confirmation/);
  refused((d) => ((items(d, "bonuses")[0].value as Record<string, unknown>).cents = 12.5), "$.sections[4].items[0].value.cents");
  refused((d) => ((items(d, "bonuses")[0].value as Record<string, unknown>).currency = "EUR"), "$.sections[4].items[0].value.currency");
  refused((d) => delete ((d.hero as Record<string, unknown>).video as Record<string, unknown>).rights, "$.hero.video.rights");
  refused((d) => delete items(d, "work")[0].video, "$.sections[2].items[0].video", /video/);
});

t("uploaded images are refused until uploads exist", () => {
  refused((d) => (items(d, "results")[3].image = { upload_path: "t/x.png" }), "$.sections[3].items[3].image.upload_path", /later version/);
});

// -- the shape of the page ---------------------------------------------------
t("one of each section, known keys in the menu, dark canvas, never indexable, no native booking yet", () => {
  refused((d) => (d.sections as unknown[]).push({ key: "faq", items: [] }), /^\$\.sections/);
  refused((d) => ((d.nav as Record<string, unknown>).pinned = ["pricing"]), "$.nav.pinned[0]");
  refused((d) => ((d.theme as Record<string, unknown>).canvas = "light"), "$.theme.canvas");
  refused((d) => ((d.seo as Record<string, unknown>).indexable = true), "$.seo.indexable", /search/);
  refused((d) => ((d.book as Record<string, unknown>).mode = "native"), "$.book.mode", /not available/);
  refused((d) => (d.template = "webinar"), "$.template");
  refused((d) => (d.v = 2), "$.v");
  refused((d) => ((items(d, "results")[0] as Record<string, unknown>).kind = "review"), "$.sections[3].items[0].kind");
  refused((d) => (sec(d, "guarantee").terms_url = "javascript:alert(1)"), "$.sections[5].terms_url", /https/);
});

t("the whole document is capped at 200 KB, as a stored string and as a body", () => {
  assert.throws(() => parseOfferPageDoc(`{"v":1,"pad":"${"x".repeat(205 * 1024)}"}`), (e: unknown) => e instanceof OfferPageError && e.path === "$" && /200 KB/.test(e.reason));
  const d = fullDoc();
  (d as Record<string, unknown>).pad = "x".repeat(205 * 1024);
  assert.throws(() => parseOfferPageDoc(d), (e: unknown) => e instanceof OfferPageError && e.path === "$" && /200 KB/.test(e.reason));
  assert.throws(() => parseOfferPageDoc("not json"), (e: unknown) => e instanceof OfferPageError && /JSON/.test(e.reason));
});

t("a refused field is named in the builder's words, never by its path", () => {
  const doc = parseOfferPageDoc(fullDoc());
  const cases: Array<[string, string]> = [
    ["$.hero.headline", "Headline"],
    ["$.hero.video.rights", "Top video"],
    ["hero", "Top video"],
    ["work:1", "Our work item 2 video"],
    ["$.sections[4].items[1].title", "Bonus 2 title"],
    ["$.sections[6].items[0].a", "Question 1 answer"],
    ["$.sections[3].items[0].evidence.confirmed", "Result 1 owner's confirmation"],
    ["$.sections[3].items[2].image", "Result 3 image"],
    ["$.sections[4].title", "Bonuses section title"],
    ["$.nav.cta_label", "Header button label"],
    ["$.seo.title", "Browser tab title"],
    ["$.theme.accent", "Accent colour"],
    ["$.book.title", "Book section title"],
    ["$", "This page"],
    ["", "This page"],
  ];
  for (const [path, words] of cases) assert.equal(fieldLabel(path, doc), words, path);
  // Whatever the parser refuses, the owner never sees a "$" or a bracket.
  const tooLong = "x".repeat(200);
  for (const mutate of [
    (d: Record<string, unknown>) => ((d.hero as Record<string, unknown>).headline = tooLong),
    (d: Record<string, unknown>) => (items(d, "bonuses")[0].title = tooLong),
    (d: Record<string, unknown>) => (items(d, "faq")[0].a = "<b>bold</b>"),
    (d: Record<string, unknown>) => ((d.theme as Record<string, unknown>).accent = "#111111"),
  ]) {
    const d = fullDoc();
    mutate(d);
    try {
      parseOfferPageDoc(d);
      assert.fail("not refused");
    } catch (e) {
      assert.ok(e instanceof OfferPageError, String(e));
      assert.doesNotMatch(fieldLabel(e.path, doc), /[$[\]]/, `${e.path} reached the owner as a path`);
    }
  }
});

console.log(`offer-pages-doc: OK - ${n} groups of checks`);
