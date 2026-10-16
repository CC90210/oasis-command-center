/**
 * offer-pages-engine.test.ts - one engine, six distinct offer pages: the hero
 * layout (theme.layout), the pricing section and its publish gate, and "how it
 * works" steps that carry no video (lib/offer-pages/types.ts, visibility.ts,
 * claims.ts, render.ts; components/offer-pages/OfferPage.tsx and sections.tsx).
 *
 * WHAT IS PINNED:
 *   1. BACKWARD COMPATIBLE, BYTE FOR BYTE. Every content/offers/oasis page and
 *      a page written before any of this existed parse unchanged (no layout is
 *      added, a work video stays where it was). A page with no layout draws a
 *      <main> BYTE-IDENTICAL to tests/fixtures/offer-pages/legacy-main-video.html
 *      and legacy-main-copy-only.html, which were rendered from OfferPage as it
 *      was before layouts, pricing and video-less steps existed (main 12e426d6);
 *      "split" draws the very same bytes. So every live page, and the hero's
 *      LCP rules, phone button and #offer-hero-end marker, are untouched.
 *   2. "stacked" and "centered": centred copy, no side column, the video under
 *      the words (max-w-4xl and max-w-3xl), the phone button still under the
 *      video, nothing in the hero waits for JavaScript (no Reveal).
 *   3. PRICING: only a tier an owner confirmed is drawn; Publish names every
 *      unconfirmed price and the checklist shows it (it does not start with
 *      "Confirm ", which the checklist reserves for claim ticks); the price
 *      itself is not linted twice, the rest of the tier's words are; each card
 *      ends with the Book button and the section does not add a second one.
 *   4. A "how it works" step needs no video: it draws as a numbered card; a
 *      step's video still plays exactly as before.
 *
 * The markup comes from tests/offer-pages-public.render.ts, run as a child
 * process without the react-server condition (react-dom/server does not load
 * under it), exactly as tests/offer-pages-public.test.ts does.
 *
 * To re-capture the two legacy fixtures (ONLY for an intended change to how a
 * page without the new fields draws):
 *   node --conditions=react-server --import tsx tests/offer-pages-engine.test.ts --write-legacy-fixtures
 *
 * Pure: no database, no network. Run:
 *   node --conditions=react-server --import tsx tests/offer-pages-engine.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "tests", "fixtures", "offer-pages");
const LEGACY_VIDEO_FIXTURE = join(FIXTURES, "legacy-main-video.html");
const LEGACY_COPY_FIXTURE = join(FIXTURES, "legacy-main-copy-only.html");

const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };
const TENANT = "t-engine";
const YT = "dQw4w9WgXcQ";
const HERO_VIDEO = {
  source: "youtube",
  id: YT,
  rights: OK,
  aspect: "16:9",
  duration_s: 252,
  thumb_path: `${TENANT}/offer-pages/youtube-${YT}.jpg`,
};

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * A page as one was written before layouts, pricing and video-less steps:
 * every section kind, a work item WITH its video, and (withVideo) a hero video
 * with its transcript. Without a video the hero has no eyebrow either, so the
 * two fixtures cover both of the hero's eyebrow branches.
 */
function legacyDoc(withVideo: boolean): Raw {
  return structuredClone({
    v: 1,
    template: "book_call",
    theme: { canvas: "dark", accent: "#E8C547", logo: "workspace" },
    nav: { pinned: ["what_you_get", "results", "bonuses"], cta_label: "Book a call" },
    hero: withVideo
      ? {
          eyebrow: "For service businesses",
          headline: "Answer every lead in a minute",
          subheadline: "See the system working before you decide.",
          cta_label: "Book a walkthrough",
          video: HERO_VIDEO,
          // One line: a newline inside a fixture would become CRLF in a Windows checkout (core.autocrlf).
          vsl_script: { text: "Hi. This is the script.", source: "cc" },
          show_transcript: true,
        }
      : { headline: "Answer every lead in a minute", subheadline: "See the system working before you decide." },
    sections: [
      { key: "what_you_get", eyebrow: "Included", title: "What you get", items: [{ title: "The system, built", body: "Yours to keep." }, { title: "A demo", video: { ...HERO_VIDEO, aspect: "9:16" } }] },
      { key: "obstacles", items: [{ title: "Leads wait two days", body: "Nobody owns follow-up." }] },
      { key: "work", title: "Our work", items: [{ title: "Client portal", body: "Built in two weeks.", video: { source: "vimeo", id: "76979871", rights: OK, aspect: "16:9" } }] },
      {
        key: "results",
        items: [
          { kind: "quote", quote: "We answer the same hour now.", who: "Dana", role: "Owner", evidence: { permission: true, confirmed: OK } },
          { kind: "metric", value: "40%", label: "less admin", source: "their CRM export", evidence: { permission: true, confirmed: OK } },
        ],
      },
      { key: "bonuses", items: [{ title: "Setup session", value: { cents: 50000, currency: "CAD", confirmed: OK } }, { title: "Checklist" }], value_note: "Standalone prices." },
      { key: "guarantee", title: "Our promise", body: "If it does not work, you do not pay.", confirmed: OK },
      { key: "faq", items: [{ q: "Who builds it?", a: "Our team." }] },
    ],
    book: { title: "Book a walkthrough", mode: "form_then_link", qualify: "after" },
    seo: { title: "Walkthrough", indexable: false },
  });
}

async function prepare(raw: Raw) {
  const { parseOfferPageDoc } = await import("../lib/offer-pages/types");
  const { prepareOfferRender } = await import("../lib/offer-pages/render");
  return prepareOfferRender({
    db: null,
    tenantId: TENANT,
    formId: "f-engine",
    doc: parseOfferPageDoc(raw),
    fallbackHeadline: "The form's own headline",
    sign: async () => new Map(),
    publicUrl: (p: string) => `https://assets.test/tenant-assets/${p}`,
    uploadStorage: null,
  });
}

/** OfferPage's props as the public page hands them, minus a live form (a placeholder draws instead). */
function pageProps(prepared: unknown): Raw {
  return JSON.parse(
    JSON.stringify({ prepared, workspaceName: "Engine Co", logoUrl: null, legalLinks: false, form: null, bookingUrl: null, contactEmail: null, preview: null }),
  ) as Raw;
}

/** Render OfferPage scenarios in the child (see the header). */
function render(scenarios: Record<string, Raw>): Record<string, string> {
  // CI runs every suite with NODE_OPTIONS=--conditions=react-server, which the
  // child would inherit, and react-dom/server refuses to load under it.
  const childNodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions };
  if (!childNodeOptions) delete env.NODE_OPTIONS;
  const input = Object.fromEntries(Object.entries(scenarios).map(([name, props]) => [name, { kind: "offer", props }]));
  const child = spawnSync(process.execPath, ["--import", "tsx", "tests/offer-pages-public.render.ts"], {
    env,
    input: JSON.stringify(input),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  assert.equal(child.status, 0, `render child failed:\n${child.stderr}`);
  const out = JSON.parse(child.stdout) as Record<string, string>;
  for (const name of Object.keys(scenarios)) assert.doesNotMatch(out[name], /^RENDER FAILED/, `${name}: ${out[name].slice(0, 300)}`);
  return out;
}

/** The page's <main>: the hero, every body section and Book. (The footer carries the year.) */
function mainOf(h: string): string {
  const start = h.indexOf('<main id="top">');
  const end = h.indexOf("</main>");
  assert.ok(start >= 0 && end > start, "no <main> in the page");
  return h.slice(start, end + "</main>".length);
}

/** The hero: from <main> to the section that holds #offer-hero-end. */
function heroOf(h: string): string {
  const start = h.indexOf('<main id="top">');
  const marker = h.indexOf('id="offer-hero-end"');
  const end = h.indexOf("</section>", marker);
  assert.ok(start >= 0 && marker > start && end > marker, "the hero or its #offer-hero-end marker is missing");
  return h.slice(start, end + "</section>".length);
}

/** One body section by its anchor. */
function sectionOf(h: string, id: string): string {
  const start = h.indexOf(`<section id="${id}"`);
  assert.ok(start >= 0, `no #${id} section`);
  return h.slice(start, h.indexOf("</section>", start) + "</section>".length);
}

const count = (h: string, re: RegExp) => (h.match(new RegExp(re.source, "g")) || []).length;

let n = 0;
async function t(_name: string, fn: () => void | Promise<void>) {
  await fn();
  n += 1;
}

async function writeLegacyFixtures() {
  const html = render({
    video: pageProps(await prepare(legacyDoc(true))),
    copyOnly: pageProps(await prepare(legacyDoc(false))),
  });
  writeFileSync(LEGACY_VIDEO_FIXTURE, mainOf(html.video) + "\n");
  writeFileSync(LEGACY_COPY_FIXTURE, mainOf(html.copyOnly) + "\n");
  console.log(`wrote ${LEGACY_VIDEO_FIXTURE}\nwrote ${LEGACY_COPY_FIXTURE}`);
}

function withLayout(raw: Raw, layout: unknown): Raw {
  const copy = structuredClone(raw);
  copy.theme.layout = layout;
  return copy;
}

const PRICING = {
  key: "pricing",
  eyebrow: "Pricing",
  title: "Pick how you start",
  currency_note: "Prices in CAD",
  tiers: [
    { name: "DIY", price: "$497", cadence: "a month", summary: "You run it.", includes: ["The OS", "", "Community access"], confirmed: true },
    { name: "Turnkey", price: "From $2,500", summary: "We build it with you.", includes: ["Everything in DIY", "Setup calls"], highlighted: true, confirmed: true },
    { name: "Managed", price: "$7,500", cadence: "one time", confirmed: false },
  ],
};

async function main() {
  if (process.argv.includes("--write-legacy-fixtures")) {
    await writeLegacyFixtures();
    return;
  }
  const { OfferPageError, parseOfferPageDoc } = await import("../lib/offer-pages/types");
  const { publishGate, lintDoc } = await import("../lib/offer-pages/claims");

  // -- 1. backward compatibility ------------------------------------------
  await t("every content/offers/oasis page parses unchanged and gains no layout", () => {
    const dir = join(ROOT, "content", "offers", "oasis");
    const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
    const pages = files.filter((f) => "offer_page" in (JSON.parse(readFileSync(join(dir, f), "utf8")) as Raw));
    assert.deepEqual(
      files.filter((f) => !pages.includes(f)),
      ["vsl-routing.json"],
      "a content file that is not a page (only the router rules are allowed to be one)",
    );
    assert.ok(pages.length >= 5, `expected the five OASIS pages, found ${pages.join(", ")}`);
    for (const f of pages) {
      const page = (JSON.parse(readFileSync(join(dir, f), "utf8")) as Raw).offer_page as Raw;
      // The empty slots the parser rightly drops (as offer-pages-oasis-content does).
      const expected = structuredClone(page);
      if (expected.hero.video === null) delete expected.hero.video;
      for (const s of expected.sections) if (s.key === "bonuses") for (const it of s.items) if (it.value === null) delete it.value;
      const parsed = parseOfferPageDoc(page);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), expected, `${f}: the parser dropped or changed something`);
      assert.equal("layout" in parsed.theme, false, `${f}: a layout appeared that nobody chose`);
      assert.deepEqual(parseOfferPageDoc(JSON.stringify(parsed)), parsed, `${f}: not stable through the stored string`);
    }
  });

  await t("a page written before layouts, pricing and video-less steps parses to itself", async () => {
    for (const withVideo of [true, false]) {
      const raw = legacyDoc(withVideo);
      const parsed = parseOfferPageDoc(raw);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), raw, "the parser changed an old page");
      const work = parsed.sections.find((s) => s.key === "work") as Raw;
      assert.equal(work.items[0].video.id, "76979871", "a step's video moved");
      const prepared = await prepare(raw);
      assert.equal("layout" in prepared, false, "an old page's prepared render carries a layout");
    }
  });

  const legacy = render({
    video: pageProps(await prepare(legacyDoc(true))),
    copyOnly: pageProps(await prepare(legacyDoc(false))),
    splitVideo: pageProps(await prepare(withLayout(legacyDoc(true), "split"))),
    splitCopyOnly: pageProps(await prepare(withLayout(legacyDoc(false), "split"))),
  });
  const FIX_VIDEO = readFileSync(LEGACY_VIDEO_FIXTURE, "utf8").replace(/\r?\n$/, "");
  const FIX_COPY = readFileSync(LEGACY_COPY_FIXTURE, "utf8").replace(/\r?\n$/, "");

  await t("no layout draws today's page byte for byte; split is the same bytes", () => {
    assert.equal(mainOf(legacy.video), FIX_VIDEO, "a page with a hero video and no layout changed");
    assert.equal(mainOf(legacy.copyOnly), FIX_COPY, "a page with no hero video and no layout changed");
    assert.equal(mainOf(legacy.splitVideo), FIX_VIDEO, "split is not today's side-by-side hero");
    assert.equal(mainOf(legacy.splitCopyOnly), FIX_COPY, "split without a video is not today's left-aligned hero");
    // What those bytes are, in words (so a regenerated fixture cannot quietly drop them).
    const hero = heroOf(legacy.video);
    assert.ok(hero.includes('class="grid items-center gap-10 lg:grid-cols-[1.02fr_1fr] lg:gap-14"'), "the side-by-side grid is gone");
    assert.ok(heroOf(legacy.copyOnly).includes('<div class="max-w-3xl">'), "the left-aligned copy column is gone");
    assert.equal(count(hero, /data-section="hero"/), 2, "the hero has its desktop and its phone button");
  });

  // -- 2. the hero layouts ------------------------------------------------
  await t("the parser takes split, stacked or centered, and nothing else", () => {
    for (const layout of ["split", "stacked", "centered"]) {
      assert.equal(parseOfferPageDoc(withLayout(legacyDoc(true), layout)).theme.layout, layout);
    }
    for (const bad of ["grid", "", "STACKED", 1, true]) {
      assert.throws(
        () => parseOfferPageDoc(withLayout(legacyDoc(true), bad)),
        (e: unknown) => e instanceof OfferPageError && e.path === "$.theme.layout" && /split, stacked or centered/.test(e.reason),
        `accepted the layout ${JSON.stringify(bad)}`,
      );
    }
    const nulled = withLayout(legacyDoc(true), null);
    assert.equal("layout" in parseOfferPageDoc(nulled).theme, false, "a null layout is the default, not a value");
  });

  const layouts = render({
    stacked: pageProps(await prepare(withLayout(legacyDoc(true), "stacked"))),
    centered: pageProps(await prepare(withLayout(legacyDoc(true), "centered"))),
    stackedCopy: pageProps(await prepare(withLayout(legacyDoc(false), "stacked"))),
    centeredCopy: pageProps(await prepare(withLayout(legacyDoc(false), "centered"))),
  });

  await t("stacked and centered: centred words on top, the video under them at its own width, the phone button under the video", () => {
    for (const [name, width] of [
      ["stacked", "max-w-4xl"],
      ["centered", "max-w-3xl"],
    ] as const) {
      const hero = heroOf(layouts[name]);
      assert.ok(!hero.includes("lg:grid-cols-[1.02fr_1fr]"), `${name}: still a side column`);
      assert.ok(hero.includes("text-center"), `${name}: the words are not centred`);
      const video = hero.indexOf('aria-label="Play video: Answer every lead in a minute"');
      assert.ok(video > hero.indexOf("<h1"), `${name}: the video is not under the headline`);
      assert.ok(new RegExp(`class="mx-auto mt-12 w-full ${width}"`).test(hero), `${name}: the video is not ${width} wide`);
      // The desktop button sits with the words; phones get it once, under the video.
      const buttons = [...hero.matchAll(/<div class="([^"]*)"><a href="#book"[^>]*data-section="hero"/g)].map((m) => m[1]);
      assert.equal(buttons.length, 2, `${name}: the hero should draw one desktop and one phone button`);
      assert.match(buttons[0], /\bhidden lg:flex\b/, `${name}: the words' button shows on phones`);
      assert.match(buttons[1], /\blg:hidden\b/, `${name}: the phone button is not phone-only`);
      assert.ok(hero.indexOf(buttons[1]) > video, `${name}: the phone button is above the video`);
      assert.ok(hero.includes("Read the script"), `${name}: the transcript left the video`);
      assert.ok(!hero.includes("m-reveal"), `${name}: the hero waits for JavaScript (Reveal) to paint`);
      assert.ok(hero.includes('<span id="offer-hero-end" aria-hidden="true" class="block h-px"></span>'), `${name}: #offer-hero-end lost`);
      assert.equal(count(hero, /<h1\b/), 1, `${name}: one h1`);
    }
    // The two layouts really differ on the page: the video's width.
    assert.notEqual(heroOf(layouts.stacked), heroOf(layouts.centered));
    for (const name of ["stackedCopy", "centeredCopy"] as const) {
      const hero = heroOf(layouts[name]);
      assert.ok(hero.includes("text-center"), `${name}: the words are not centred`);
      assert.equal(count(hero, /data-section="hero"/), 1, `${name}: with no video there is one button, on every screen`);
      assert.ok(!/hidden lg:flex/.test(hero), `${name}: the only button is hidden on phones`);
      assert.ok(hero.includes('class="mx-auto block h-px w-8'), `${name}: the bare accent rule is not centred`);
    }
    // Everything below the hero is the same page whatever the layout.
    const below = (h: string) => mainOf(h).slice(heroOf(h).length);
    assert.equal(below(layouts.stacked), below(legacy.video), "stacked changed a body section");
    assert.equal(below(layouts.centered), below(legacy.video), "centered changed a body section");
  });

  // -- 3. pricing -----------------------------------------------------------
  const priced = legacyDoc(false);
  priced.sections.splice(5, 0, structuredClone(PRICING));
  priced.nav.pinned.push("pricing");

  await t("Publish names every unconfirmed price, in a line the checklist shows; a confirmed one passes", () => {
    const doc = parseOfferPageDoc(priced);
    const gate = publishGate(doc, [], { formEnabled: true, fallbackHeadline: "" });
    const price = gate.blockers.filter((b) => /price/i.test(b) && !b.startsWith("Confirm "));
    assert.deepEqual(price, ['The price for "Managed" ($7,500) needs an owner\'s confirmation. It is shown exactly as written.']);
    const allOk = structuredClone(priced);
    allOk.sections[5].tiers[2].confirmed = true;
    const passed = publishGate(parseOfferPageDoc(allOk), [], { formEnabled: true, fallbackHeadline: "" });
    assert.equal(passed.blockers.filter((b) => /price for/.test(b)).length, 0, "a confirmed price still blocks");
    // A tier with no name is named by its place.
    const unnamed = structuredClone(priced);
    unnamed.sections[5].tiers[2].name = "";
    assert.ok(
      publishGate(parseOfferPageDoc(unnamed), [], { formEnabled: true, fallbackHeadline: "" }).blockers.includes(
        "The price for plan 3 ($7,500) needs an owner's confirmation. It is shown exactly as written.",
      ),
    );
    // A tier with a name and no price is not drawn: said, not blocked.
    const noPrice = structuredClone(priced);
    noPrice.sections[5].tiers[2] = { name: "Managed", price: "", confirmed: false };
    const g = publishGate(parseOfferPageDoc(noPrice), [], { formEnabled: true, fallbackHeadline: "" });
    assert.equal(g.blockers.filter((b) => /price for/.test(b)).length, 0);
    assert.ok(g.warnings.includes('"Managed" has no price yet, so it is not shown.'), g.warnings.join(" | "));
    // A hidden pricing section blocks nothing and draws nothing.
    const hidden = structuredClone(priced);
    hidden.sections[5].hidden = true;
    assert.equal(publishGate(parseOfferPageDoc(hidden), [], { formEnabled: true, fallbackHeadline: "" }).blockers.filter((b) => /price for/.test(b)).length, 0);
  });

  await t("the price is vouched for by its own tick, so the linter reads the rest of the tier, not the price", () => {
    const hits = lintDoc(parseOfferPageDoc(priced));
    const where = hits.filter((h) => h.section === "pricing").map((h) => h.where);
    assert.ok(!where.some((w) => /\.price$/.test(w)), `the price was linted: ${where.join(", ")}`);
    assert.ok(where.includes("pricing.currency_note"), "the currency note (money) is not linted");
    const words = structuredClone(priced);
    words.sections[5].tiers[0].summary = "Clients see results in 30 days.";
    words.sections[5].tiers[1].includes = ["2 setup calls"];
    words.sections[5].tiers[0].name = "Proven";
    const w = lintDoc(parseOfferPageDoc(words)).filter((h) => h.section === "pricing").map((h) => h.where);
    for (const p of ["pricing.tiers[0].summary", "pricing.tiers[1].includes[0]", "pricing.tiers[0].name"]) assert.ok(w.includes(p), `${p} not linted`);
  });

  const pricing = render({ priced: pageProps(await prepare(priced)) });

  await t("the pricing cards: only confirmed tiers, the highlighted one marked, each ending with the Book button and no second one", () => {
    const h = pricing.priced;
    const s = sectionOf(h, "pricing");
    assert.ok(s.includes(">DIY<") && s.includes(">Turnkey<"), "a confirmed tier is missing");
    assert.ok(!s.includes("Managed") && !s.includes("$7,500"), "an unconfirmed price reached the page");
    assert.ok(s.includes("From $2,500") && s.includes("$497") && s.includes("a month"), "a price or its cadence is missing");
    assert.equal(count(s, /<article\b/), 2, "one card per drawn tier");
    assert.equal(count(s, /data-highlighted=""/), 1, "exactly one highlighted card");
    const turnkey = s.slice(s.lastIndexOf("<article", s.indexOf(">Turnkey<")));
    assert.ok(turnkey.startsWith("<article") && turnkey.slice(0, 400).includes("data-highlighted"), "the highlighted card is not Turnkey");
    assert.ok(/border-\[color:color-mix\(in_srgb,var\(--accent/.test(turnkey.slice(0, 400)), "the highlighted card is not marked with the accent");
    assert.equal(count(s, /href="#book"[^>]*data-section="pricing"/), 2, "each card ends with its own Book button");
    // Every card's button is the last thing in it, and the section adds none after the grid.
    for (const card of s.split("<article").slice(1)) {
      const body = card.slice(0, card.indexOf("</article>"));
      assert.match(body.slice(body.lastIndexOf('data-section="pricing"')), /^data-section="pricing">Book a call<svg[\s\S]*?<\/svg><\/a><\/div>$/, "a card does not end with its button");
    }
    const afterGrid = s.slice(s.lastIndexOf("</article>"));
    assert.ok(!afterGrid.includes('href="#book"'), "the pricing section ends with a second Book button");
    assert.ok(s.includes("Prices in CAD"), "the currency note is missing");
    assert.ok(s.includes("Community access") && !/<li[^>]*><\/li>/.test(s), "an empty included line was drawn, or a real one dropped");
    assert.ok(s.includes('class="mt-12 grid gap-6 md:grid-cols-2 lg:max-w-4xl"'), "two cards are not a two-column grid");
    // With one highlighted, its button is the filled one and the other is the outline.
    // Read from the source, not imported: Cta.tsx pulls next/link, which does not load under react-server.
    const cta = readFileSync(join(ROOT, "components", "marketing", "Cta.tsx"), "utf8");
    const CTA_PRIMARY = /export const CTA_PRIMARY =\s*"([^"]+)"/.exec(cta)?.[1] ?? "";
    const CTA_SECONDARY = /export const CTA_SECONDARY =\s*"([^"]+)"/.exec(cta)?.[1] ?? "";
    assert.ok(CTA_PRIMARY && CTA_SECONDARY, "the marketing CTA class strings moved");
    assert.ok(turnkey.includes(`class="${CTA_PRIMARY} w-full" data-section="pricing"`), "the highlighted card's button is not the filled one");
    assert.ok(s.includes(`class="${CTA_SECONDARY} w-full" data-section="pricing"`), "the other card's button is not the outline one");
    // The top menu lists Pricing when pinned and drawn.
    const header = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    assert.ok(header.includes('href="#pricing"'), "Pricing is pinned and drawn but not in the menu");
  });

  // -- 4. "how it works" steps without a video ------------------------------
  const steps = legacyDoc(false);
  steps.sections[2] = {
    key: "work",
    title: "How it works",
    items: [
      { title: "We map your follow-up", body: "One call, then a written plan." },
      { title: "Client portal", body: "Built in two weeks.", video: { source: "vimeo", id: "76979871", rights: OK, aspect: "16:9" } },
      { title: "", body: "A step with no title is not drawn." },
      { title: "You go live" },
    ],
  };

  await t("a step without a video parses, and only a step's own video is a video ref", async () => {
    const doc = parseOfferPageDoc(steps);
    const work = doc.sections.find((s) => s.key === "work") as Raw;
    assert.equal("video" in work.items[0], false);
    const { videoRefs } = await import("../lib/offer-pages/providers");
    assert.deepEqual(videoRefs(doc).filter((v) => v.ref.startsWith("work:")).map((v) => v.ref), ["work:1"]);
    assert.equal(publishGate(doc, [], { formEnabled: true, fallbackHeadline: "" }).blockers.filter((b) => /video at work/.test(b)).length, 0);
  });

  const stepHtml = render({ steps: pageProps(await prepare(steps)) });

  await t("a step with no video draws as a numbered card; the step with a video draws exactly as before", () => {
    const s = sectionOf(stepHtml.steps, "work");
    assert.equal(count(s, /aria-label="Play video:/), 1, "only the step with a video has a player");
    assert.ok(s.includes("We map your follow-up") && s.includes("One call, then a written plan.") && s.includes("You go live"));
    assert.ok(!s.includes("A step with no title is not drawn."), "an untitled step was drawn");
    assert.match(s, />01<\/span><h3[^>]*>We map your follow-up<\/h3>/, "the first step is not numbered 01");
    assert.match(s, />02<\/span><h3[^>]*>You go live<\/h3>/, "the second step is not numbered 02");
    // The video step's figure is byte-identical to the legacy fixture's.
    const legacyWork = sectionOf(FIX_VIDEO, "work");
    const figure = (x: string) => x.slice(x.indexOf("<figure"), x.indexOf("</figure>") + "</figure>".length);
    assert.equal(figure(s), figure(legacyWork), "a step's video draws differently than before");
  });

  console.log(`offer-pages-engine: OK - ${n} groups of checks`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
