/**
 * offer-pages-visibility.test.ts - what an offer page draws
 * (lib/offer-pages/visibility.ts), design sections 2.3 and 3.4.
 *
 * WHAT IS PINNED:
 *   - an empty section is hidden, an incomplete item is dropped (never filled);
 *   - the menu lists only sections that are drawn AND pinned, in page order;
 *   - a result without evidence, without permission or without a confirmation
 *     never renders, even if it reaches the renderer by hand (the parser
 *     refuses it too: offer-pages-doc);
 *   - a value without confirmation never renders; the total appears only when
 *     EVERY bonus has a confirmed value in one currency; the value footnote only
 *     next to a confirmed value;
 *   - the guarantee needs words AND an owner's confirmation;
 *   - "our work" draws only playable videos; the hero headline falls back to the
 *     form's own; the transcript appears only under a drawn video.
 *
 * Pure. Run: node --conditions=react-server --import tsx tests/offer-pages-visibility.test.ts
 */
import assert from "node:assert/strict";
import type { OfferPageDoc, ResultItem, VideoRef } from "../lib/offer-pages/types";
import { drawnPage, drawnSections, formatMoney, navFor, shownValue } from "../lib/offer-pages/visibility";

const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };
const YT: VideoRef = { source: "youtube", id: "dQw4w9WgXcQ", rights: OK, aspect: "16:9" };
const LIB: VideoRef = { source: "library", asset_id: "a-1", video_media_id: "m-1", rights: OK, aspect: "16:9" };
const everything = { video: () => true, image: () => true };

function doc(sections: OfferPageDoc["sections"], extra: Partial<OfferPageDoc> = {}): OfferPageDoc {
  return {
    v: 1,
    template: "book_call",
    theme: { canvas: "dark" },
    nav: { pinned: ["what_you_get", "results", "bonuses", "faq"] },
    hero: {},
    sections,
    book: { mode: "form", qualify: "after" },
    seo: { indexable: false },
    ...extra,
  };
}

let n = 0;
const t = (_name: string, fn: () => void) => {
  fn();
  n += 1;
};

t("every section empty: the page is the hero and Book, with an empty menu", () => {
  const d = doc([
    { key: "what_you_get", items: [] },
    { key: "obstacles", items: [{ title: "  " }] },
    { key: "work", items: [] },
    { key: "results", items: [] },
    { key: "bonuses", items: [{ title: "" }] },
    { key: "guarantee" },
    { key: "faq", items: [{ q: "Only a question", a: "" }] },
  ]);
  const page = drawnPage(d, { fallbackHeadline: "The form's own headline", media: everything });
  assert.deepEqual(page.sections, []);
  assert.deepEqual(page.nav, []);
  assert.equal(page.hero.headline, "The form's own headline", "the headline falls back to the form's");
  assert.equal(page.book.mode, "form");
});

t("incomplete items are dropped, complete ones kept in order; a hidden section is not drawn", () => {
  const d = doc([
    { key: "what_you_get", items: [{ title: "" }, { title: "A system", body: "Yours." }, { title: "Support" }] },
    { key: "obstacles", hidden: true, items: [{ title: "Leads go cold" }] },
    { key: "faq", items: [{ q: "How long?", a: "Two weeks." }, { q: "", a: "orphan answer" }] },
  ]);
  const drawn = drawnSections(d, everything);
  assert.deepEqual(drawn.map((s) => s.key), ["what_you_get", "faq"]);
  const wyg = drawn[0] as Extract<(typeof drawn)[number], { key: "what_you_get" }>;
  assert.deepEqual(wyg.items.map((i) => [i.index, i.title]), [[1, "A system"], [2, "Support"]], "the doc index is kept, the empty item dropped");
  const faq = drawn[1] as Extract<(typeof drawn)[number], { key: "faq" }>;
  assert.equal(faq.items.length, 1);
});

t("the menu lists only drawn AND pinned sections, in the page's order", () => {
  const d = doc(
    [
      { key: "faq", items: [{ q: "q", a: "a" }] },
      { key: "obstacles", items: [{ title: "x" }] },
      { key: "results", items: [] },
      { key: "what_you_get", items: [{ title: "y" }] },
    ],
    { nav: { pinned: ["what_you_get", "results", "faq"] } },
  );
  const drawn = drawnSections(d, everything);
  assert.deepEqual(navFor(d, drawn).map((n) => n.anchor), ["faq", "what-you-get"], "obstacles is drawn but not pinned; results is pinned but empty");
});

t("a result without evidence, permission or confirmation never renders", () => {
  const good: ResultItem = { kind: "quote", quote: "It works.", who: "Dana", evidence: { permission: true, confirmed: OK } };
  const noEvidence = { kind: "quote", quote: "Unbacked.", who: "Eve" } as unknown as ResultItem;
  const noPermission = { kind: "quote", quote: "No permission.", who: "Fay", evidence: { permission: false, confirmed: OK } } as unknown as ResultItem;
  const noConfirm = { kind: "metric", value: "3x", label: "x", source: "y", evidence: { permission: true } } as unknown as ResultItem;
  const halfMetric: ResultItem = { kind: "metric", value: "40%", label: "", source: "CRM", evidence: { permission: true, confirmed: OK } };
  const d = doc([{ key: "results", items: [noEvidence, good, noPermission, noConfirm, halfMetric] }]);
  const drawn = drawnSections(d, everything);
  assert.equal(drawn.length, 1);
  const r = drawn[0] as Extract<(typeof drawn)[number], { key: "results" }>;
  assert.deepEqual(r.items.map((i) => i.index), [1], "only the result with evidence, permission and a confirmation");
  // With nothing drawable, the section is gone entirely.
  assert.deepEqual(drawnSections(doc([{ key: "results", items: [noEvidence, noPermission] }]), everything), []);
});

t("a result video or screenshot draws only when its media can be shown", () => {
  const vid: ResultItem = { kind: "video", video: LIB, evidence: { permission: true, confirmed: OK } };
  const shot: ResultItem = { kind: "screenshot", image: { asset_id: "a", media_id: "m" }, alt: "Before and after", evidence: { permission: true, confirmed: OK } };
  const none = { video: () => false, image: () => false };
  assert.deepEqual(drawnSections(doc([{ key: "results", items: [vid, shot] }]), none), []);
  assert.equal(drawnSections(doc([{ key: "results", items: [vid, shot] }]), everything).length, 1);
});

t("a value without confirmation never renders; the total only when every value is confirmed in one currency", () => {
  const confirmed = { cents: 50000, currency: "CAD" as const, confirmed: OK };
  const unconfirmed = { cents: 99900, currency: "CAD" as const } as unknown as typeof confirmed;
  const bonuses = (values: Array<typeof confirmed | null>, note?: string) =>
    drawnSections(doc([{ key: "bonuses", items: values.map((value, i) => ({ title: `Bonus ${i}`, value })), ...(note ? { value_note: note } : {}) }]), everything)[0] as Extract<
      ReturnType<typeof drawnSections>[number],
      { key: "bonuses" }
    >;
  assert.equal(shownValue(unconfirmed), null);
  const mixed = bonuses([confirmed, unconfirmed], "Standalone prices.");
  assert.deepEqual(mixed.items.map((i) => i.value?.cents ?? null), [50000, null], "the unconfirmed value is not drawn");
  assert.equal(mixed.total, null, "no total while one value is unconfirmed");
  assert.equal(mixed.valueNote, "Standalone prices.", "the note sits next to the confirmed value");
  const all = bonuses([confirmed, { ...confirmed, cents: 25000 }]);
  assert.deepEqual(all.total, { cents: 75000, currency: "CAD" });
  const twoCurrencies = bonuses([confirmed, { ...confirmed, currency: "USD" }]);
  assert.equal(twoCurrencies.total, null, "no total across currencies");
  const noValues = bonuses([null, null], "Footnote with nothing to sit next to.");
  assert.equal(noValues.valueNote, null, "no footnote without a confirmed value");
  assert.equal(noValues.total, null);
  assert.equal(formatMoney({ cents: 75000, currency: "CAD" }), "$750");
});

t("the guarantee needs words and an owner's confirmation", () => {
  assert.deepEqual(drawnSections(doc([{ key: "guarantee", body: "Money back in 30 days." }]), everything), []);
  assert.deepEqual(drawnSections(doc([{ key: "guarantee", confirmed: OK }]), everything), []);
  assert.equal(drawnSections(doc([{ key: "guarantee", body: "Money back in 30 days.", confirmed: OK }]), everything).length, 1);
});

t("our work draws only playable videos; a what-you-get video only when it can play", () => {
  const media = { video: (ref: string) => ref !== "work:0" && ref !== "what_you_get:0", image: () => true };
  const d = doc([
    { key: "work", items: [{ title: "Broken", video: LIB }, { title: "Portal", video: YT }] },
    { key: "what_you_get", items: [{ title: "Demo", video: LIB }] },
  ]);
  const drawn = drawnSections(d, media);
  const work = drawn.find((s) => s.key === "work") as Extract<(typeof drawn)[number], { key: "work" }>;
  assert.deepEqual(work.items.map((i) => i.video.ref), ["work:1"]);
  const wyg = drawn.find((s) => s.key === "what_you_get") as Extract<(typeof drawn)[number], { key: "what_you_get" }>;
  assert.equal(wyg.items[0].video, null, "the item stays, its broken video does not");
});

t("the transcript appears only under a drawn video", () => {
  const withVideo = drawnPage(doc([], { hero: { headline: "H", video: YT, vsl_script: { text: "Script.", source: "cc" }, show_transcript: true } }), {
    fallbackHeadline: "",
    media: everything,
  });
  assert.equal(withVideo.hero.transcript, "Script.");
  const noVideo = drawnPage(doc([], { hero: { headline: "H", vsl_script: { text: "Script.", source: "cc" }, show_transcript: true } }), {
    fallbackHeadline: "",
    media: everything,
  });
  assert.equal(noVideo.hero.transcript, null);
  const off = drawnPage(doc([], { hero: { headline: "H", video: YT, vsl_script: { text: "Script.", source: "cc" } } }), { fallbackHeadline: "", media: everything });
  assert.equal(off.hero.transcript, null);
});

console.log(`offer-pages-visibility: OK - ${n} groups of checks`);
