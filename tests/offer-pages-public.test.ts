/**
 * offer-pages-public.test.ts - the public page at /f/<workspace>/<slug>
 * (app/f/[tenant_slug]/[form_slug]/page.tsx, components/offer-pages/*),
 * design sections 2.3, 3.6 and 4.3.
 *
 * WHAT IS PINNED, through the real page against a local libSQL file:
 *   1. NO PAGE, NO CHANGE. With no offer row, and with a draft nobody
 *      published, the page returns exactly today's FormPublicClient element
 *      (the same props, no offer props), and its markup is BYTE-IDENTICAL to
 *      tests/fixtures/offer-pages/form-only.html, rendered from the component
 *      as it was before offer pages existed (main 34a2944f).
 *   2. A LIVE PAGE draws its sections in the owner's order with their anchors,
 *      the menu lists only drawn pinned sections, the Book section is last and
 *      holds the form (no second <main>), the accent is the CSS variable on the
 *      root, and the CTAs are the marketing site's own class strings.
 *   3. NOTHING VIDEO-RELATED IN THE SERVER HTML: no <video>, no <iframe>, no
 *      third-party <script>, no video file URL; the poster has width and
 *      height, and only the hero's poster asks for high fetch priority.
 *   4. A Library hero video shows only its poster, signed for an hour.
 *   5. noindex stays; a live page names the tab from its own words.
 *   6. ?offer_preview=1 shows the DRAFT only to a signed-in owner of the
 *      form's own workspace, never mounts a live form there, and is the public
 *      page for anyone else.
 *
 * The markup comes from tests/offer-pages-public.render.ts, run as a child
 * process without the react-server condition (react-dom/server does not load
 * under it).
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-public.test.ts
 */
import { OASIS, ROOT, USERS, done, formRow, login, offerRow, setupOfferDatabase, step, stubSigner, CONTACT_STEPS } from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FIXTURE_PROPS = JSON.parse(readFileSync(join(ROOT, "tests", "fixtures", "offer-pages", "form-only.props.json"), "utf8")) as {
  formId: string;
  formName: string;
  branding: Record<string, unknown>;
  steps: unknown[];
};
const FIXTURE_HTML = readFileSync(join(ROOT, "tests", "fixtures", "offer-pages", "form-only.html"), "utf8").replace(/\r?\n$/, "");

const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };
const FORM_VSL = "f0f1c000-0000-4000-8000-000000000001";
const FORM_LIB = "f0f1c000-0000-4000-8000-000000000002";
const YT = "dQw4w9WgXcQ";

function liveDoc(headline: string) {
  return {
    v: 1,
    template: "book_call",
    theme: { canvas: "dark", accent: "#E8C547", logo: "workspace" },
    nav: { pinned: ["what_you_get", "results", "bonuses"], cta_label: "Book a call" },
    hero: {
      eyebrow: "For service businesses",
      headline,
      subheadline: "See the system working before you decide.",
      video: { source: "youtube", id: YT, rights: OK, aspect: "16:9", thumb_path: `${OASIS}/offer-pages/youtube-${YT}.jpg` },
    },
    sections: [
      { key: "what_you_get", eyebrow: "Included", title: "What you get", items: [{ title: "The system, built" }, { title: "" }] },
      { key: "obstacles", items: [{ title: "Leads wait two days" }] },
      { key: "work", items: [{ title: "Client portal", video: { source: "vimeo", id: "76979871", rights: OK, aspect: "16:9" } }] },
      {
        key: "results",
        items: [
          { kind: "quote", quote: "We answer the same hour now.", who: "Dana", role: "Owner", evidence: { permission: true, confirmed: OK } },
          { kind: "metric", value: "40%", label: "less admin", source: "their CRM export", evidence: { permission: true, confirmed: OK } },
        ],
      },
      {
        key: "bonuses",
        items: [
          { title: "Setup session", value: { cents: 50000, currency: "CAD", confirmed: OK } },
          { title: "Checklist" },
        ],
        value_note: "Standalone prices.",
      },
      { key: "guarantee", body: "If it does not work, you do not pay.", confirmed: OK },
      { key: "faq", items: [{ q: "Who builds it?", a: "Our team." }] },
    ],
    book: { title: "Book a walkthrough", mode: "form_then_link", qualify: "after" },
    seo: { title: "Lead system walkthrough", description: "A short page.", indexable: false },
  };
}

// The object store's public half: a link video's poster is OUR copy in the
// public tenant-assets prefix, addressed by R2_PUBLIC_BASE_URL. Fake values,
// set after the harness cleared them; nothing here reaches the network (the
// signer is stood in, and a public URL is built, never fetched).
Object.assign(process.env, {
  R2_ACCOUNT_ID: "test-account",
  R2_ACCESS_KEY_ID: "test-key",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_BUCKET: "test-bucket",
  R2_PUBLIC_BASE_URL: "https://assets.test",
});

async function main() {
  await stubSigner();
  const db = await setupOfferDatabase();
  await db.batch(
    [
      // The fixture's form, in OASIS's workspace: its own logo on its branding,
      // so the page resolves exactly the props the fixture was rendered with.
      formRow(FIXTURE_PROPS.formId, OASIS, "ai-audit", FIXTURE_PROPS.formName, FIXTURE_PROPS.steps, FIXTURE_PROPS.branding),
      formRow(FORM_VSL, OASIS, "vsl", "VSL offer", CONTACT_STEPS, { headline: "Plain form headline", logo_url: "https://oasisai.work/brand/oasis-mark.png" }),
      offerRow({ formId: FORM_VSL, tenantId: OASIS, draft: liveDoc("Draft headline, not live yet"), published: liveDoc("Answer every lead in a minute"), live: 1 }),
      formRow(FORM_LIB, OASIS, "lib", "Library offer", CONTACT_STEPS),
      offerRow({
        formId: FORM_LIB,
        tenantId: OASIS,
        draft: {},
        published: {
          ...liveDoc("A Library video"),
          hero: {
            headline: "A Library video",
            video: { source: "library", asset_id: "a-1", video_media_id: "m-1-v", poster_media_id: "m-1-p", caption_media_id: "m-1-c", rights: OK, aspect: "16:9" },
          },
          sections: [],
        },
        live: 1,
      }),
      {
        sql: "INSERT INTO marketing_asset (id, tenant_id, brand_slug, title, format, status, aspect, duration_s) VALUES ('a-1', ?, 'oasis-ai', 'VSL', 'video', 'published', '16:9', 252)",
        args: [OASIS],
      },
      { sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path, width, height) VALUES ('m-1-v', ?, 'a-1', 'video', ?, 1920, 1080)", args: [OASIS, `${OASIS}/a-1/m-1-v.mp4`] },
      { sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path, width, height) VALUES ('m-1-p', ?, 'a-1', 'poster', ?, 1280, 720)", args: [OASIS, `${OASIS}/a-1/m-1-p.jpg`] },
      { sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path) VALUES ('m-1-c', ?, 'a-1', 'caption', ?)", args: [OASIS, `${OASIS}/a-1/m-1-c.vtt`] },
    ],
    "write",
  );

  const page = await import("../app/f/[tenant_slug]/[form_slug]/page");
  const { FormPublicClient } = await import("../components/forms/FormPublicClient");
  const { OfferPage } = await import("../components/offer-pages/OfferPage");
  type El = { type: unknown; props: Record<string, unknown> };
  const run = async (slug: string, sp: Record<string, string> = {}) =>
    (await page.default({ params: Promise.resolve({ tenant_slug: "oasis-ai-cc", form_slug: slug }), searchParams: Promise.resolve(sp) })) as unknown as El;
  const plain = (props: Record<string, unknown>) => JSON.parse(JSON.stringify(props)) as Record<string, unknown>;

  console.log("offer-pages-public:");
  const scenarios: Record<string, { kind: "form" | "offer"; props: Record<string, unknown> }> = {};

  await step("no offer row: the page returns today's FormPublicClient with today's props", async () => {
    const el = await run("ai-audit");
    assert.equal(el.type, FormPublicClient);
    assert.deepEqual(plain(el.props), FIXTURE_PROPS, "the plain form's props changed");
    assert.ok(!("chrome" in el.props) && !("onStepSubmitted" in el.props), "offer props reached the plain form");
    scenarios.noRow = { kind: "form", props: plain(el.props) };
  });

  await step("a draft nobody published: still today's page, byte for byte the same element", async () => {
    await db.batch([offerRow({ formId: FIXTURE_PROPS.formId, tenantId: OASIS, draft: liveDoc("Unpublished"), template: "free_audit" })], "write");
    const el = await run("ai-audit");
    assert.equal(el.type, FormPublicClient);
    assert.deepEqual(plain(el.props), FIXTURE_PROPS);
    scenarios.draftOnly = { kind: "form", props: plain(el.props) };
    const meta = await page.generateMetadata({ params: Promise.resolve({ tenant_slug: "oasis-ai-cc", form_slug: "ai-audit" }) });
    assert.deepEqual(meta.robots, { index: false, follow: false });
    assert.equal(meta.title, FIXTURE_PROPS.branding.headline, "the plain form's tab title changed");
    assert.equal("description" in meta, false);
  });

  await step("a live page: the offer page, with the form in its Book section and the published words", async () => {
    const el = await run("vsl", { rep: "Jordan", source: "text" });
    assert.equal(el.type, OfferPage);
    const props = plain(el.props) as { prepared: { page: { hero: { headline: string } }; accent: string }; form: Record<string, unknown>; preview: unknown; legalLinks: boolean };
    assert.equal(props.prepared.page.hero.headline, "Answer every lead in a minute", "the published copy, never the draft");
    assert.equal(props.prepared.accent, "#E8C547");
    assert.equal(props.preview, null);
    assert.equal(props.legalLinks, true, "OASIS's own page links OASIS's legal pages");
    assert.deepEqual(props.form.anonymousInit, { tenant_slug: "oasis-ai-cc", form_slug: "vsl", rep: "jordan", source: "text" }, "?rep and ?source pass into the form as today");
    assert.equal((props.form.branding as { primary_color: string }).primary_color, "#E8C547", "the form's buttons follow the page's accent");
    scenarios.live = { kind: "offer", props: plain(el.props) };
    const meta = await page.generateMetadata({ params: Promise.resolve({ tenant_slug: "oasis-ai-cc", form_slug: "vsl" }) });
    assert.deepEqual(meta.robots, { index: false, follow: false }, "noindex kept");
    assert.equal(meta.title, "Lead system walkthrough");
    assert.equal(meta.description, "A short page.");
  });

  await step("a Library hero video: its poster signed for an hour, the video itself nowhere", async () => {
    const el = await run("lib");
    assert.equal(el.type, OfferPage);
    const media = (el.props.prepared as { media: Record<string, { posterUrl: string; source: { kind: string } }> }).media;
    assert.equal(media.hero.source.kind, "library");
    assert.equal(media.hero.posterUrl, `https://r2.test/marketing-media/${OASIS}/a-1/m-1-p.jpg?ttl=3600&sig=fake`);
    assert.doesNotMatch(JSON.stringify(el.props), /m-1-v\.mp4/, "the video file's URL reached the page");
    scenarios.library = { kind: "offer", props: plain(el.props) };
  });

  await step("?offer_preview=1: the draft for the workspace's owner, the public page for everyone else", async () => {
    await login(null);
    const anon = await run("vsl", { offer_preview: "1" });
    assert.equal((anon.props.prepared as { page: { hero: { headline: string } } }).page.hero.headline, "Answer every lead in a minute");
    assert.equal(anon.props.preview, null);
    await login(USERS.clientA);
    const stranger = await run("vsl", { offer_preview: "1" });
    assert.equal((stranger.props.prepared as { page: { hero: { headline: string } } }).page.hero.headline, "Answer every lead in a minute", "another workspace's owner saw the draft");
    await login(USERS.rep);
    const member = await run("vsl", { offer_preview: "1" });
    assert.equal(member.props.preview, null, "a member who may not edit saw the draft");
    await login(USERS.cc);
    const owner = await run("vsl", { offer_preview: "1" });
    assert.equal((owner.props.prepared as { page: { hero: { headline: string } } }).page.hero.headline, "Draft headline, not live yet");
    assert.deepEqual(owner.props.preview, { steps: ["Your details", "About you"] });
    assert.equal(owner.props.form, null, "a preview mounted a live form");
    scenarios.preview = { kind: "offer", props: plain(owner.props) };
    await login(null);
  });

  // -- the markup ----------------------------------------------------------
  // CI runs every suite with NODE_OPTIONS=--conditions=react-server, which the
  // child would inherit, and react-dom/server refuses to load under it.
  const childNodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions };
  if (!childNodeOptions) delete childEnv.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ["--import", "tsx", "tests/offer-pages-public.render.ts"], {
    env: childEnv,
    input: JSON.stringify(scenarios),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  assert.equal(child.status, 0, `render child failed:\n${child.stderr}`);
  const html = JSON.parse(child.stdout) as Record<string, string>;

  await step("today's page, byte for byte: no row and an unpublished draft render the fixture exactly", () => {
    assert.equal(html.fixtureForm, FIXTURE_HTML, "FormPublicClient's own markup changed (regenerate the fixture only for an intended change)");
    assert.equal(html.noRow, FIXTURE_HTML, "the page with no offer row is not today's page");
    assert.equal(html.draftOnly, FIXTURE_HTML, "an unpublished draft changed the public page");
  });

  await step("the live page draws its sections in order, with anchors; the menu holds only drawn pinned sections; Book is last", () => {
    const h = html.live;
    const order = ["what-you-get", "obstacles", "work", "results", "bonuses", "guarantee", "faq", "book"].map((id) => h.indexOf(`id="${id}"`));
    assert.ok(order.every((i) => i > 0), `a section is missing: ${order.join(",")}`);
    assert.deepEqual([...order].sort((a, b) => a - b), order, "sections out of order");
    const header = h.slice(h.indexOf("<header"), h.indexOf("</header>"));
    for (const a of ["#what-you-get", "#results", "#bonuses", "#book"]) assert.ok(header.includes(`href="${a}"`), `menu lacks ${a}`);
    for (const a of ["#faq", "#obstacles", "#guarantee"]) assert.ok(!header.includes(`href="${a}"`), `menu lists the unpinned ${a}`);
    assert.equal((h.match(/<main\b/g) || []).length, 1, "the embedded form drew a second <main>");
    assert.ok(h.includes("Your details"), "the form is not in the Book section");
    assert.ok(h.indexOf("Your details") > h.indexOf('id="book"'), "the form is not inside #book");
    assert.ok(h.includes("--accent:#E8C547"), "the accent is not the root's CSS variable");
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- already loaded by the page above; read synchronously
    const { CTA_PRIMARY } = require("../components/marketing/Cta") as { CTA_PRIMARY: string };
    assert.ok(h.includes(`class="${CTA_PRIMARY}"`), "the hero CTA is not the marketing site's own class string");
    assert.ok(h.includes('href="/privacy"') && h.includes('href="/terms"'), "OASIS's page lost its legal links");
  });

  await step("only what an owner confirmed: a confirmed value and total appear, the unconfirmed value does not", () => {
    const h = html.live;
    assert.ok(/Value \$500/.test(h), "the confirmed value is missing");
    assert.ok(!/Total value/.test(h), "a total was drawn while one bonus has no value");
    assert.ok(h.includes("Standalone prices."), "the footnote sits next to the confirmed value");
    assert.ok(h.includes("If it does not work, you do not pay."), "the confirmed guarantee is missing");
    assert.ok(!h.includes('aria-hidden="true">01</span><h3 class="font-display text-xl font-bold leading-snug tracking-tight text-fg"></h3>'), "an empty item was drawn");
  });

  await step("nothing video-related in the server HTML: no <video>, no <iframe>, no third-party script; posters sized", () => {
    for (const [name, h] of Object.entries({ live: html.live, library: html.library, preview: html.preview })) {
      assert.doesNotMatch(h, /<video\b/i, `${name}: a <video> in the server HTML`);
      assert.doesNotMatch(h, /<iframe\b/i, `${name}: an <iframe> in the server HTML`);
      assert.doesNotMatch(h, /<script[^>]*\bsrc=/i, `${name}: a script with a src`);
      assert.equal((h.match(/<script\b/gi) || []).length, 1, `${name}: only the one-line js switch may be inline`);
      assert.doesNotMatch(h, /youtube(-nocookie)?\.com\/embed|player\.vimeo\.com|loom\.com\/embed/, `${name}: a player URL in the HTML`);
    }
    const lib = html.library;
    const poster = /<img [^>]*src="https:\/\/r2\.test\/marketing-media\/[^"]*m-1-p\.jpg[^"]*"[^>]*>/.exec(lib)?.[0] ?? "";
    assert.ok(poster, "the Library poster is missing");
    assert.match(poster, /width="1280"/);
    assert.match(poster, /height="720"/);
    assert.match(poster, /fetchpriority="high"/i, "the hero poster is not fetched first");
    assert.doesNotMatch(lib, /m-1-v\.mp4/, "the video file's URL is in the HTML");
    // The live page: the YouTube hero poster is our own copy; every poster has a size; one high priority.
    const imgs = html.live.match(/<img [^>]*>/g) || [];
    const posters = imgs.filter((i) => /object-cover/.test(i));
    assert.ok(posters.length >= 1);
    for (const p of posters) {
      assert.match(p, /width="\d+"/, p);
      assert.match(p, /height="\d+"/, p);
    }
    // React also hoists a <link rel="preload"> for the high-priority image;
    // what matters is that exactly one <img> asks for it: the hero's poster.
    assert.equal(imgs.filter((i) => /fetchpriority="high"/i.test(i)).length, 1, "more than one poster asks for high priority");
    assert.ok(html.live.includes(`src="https://assets.test/tenant-assets/${OASIS}/offer-pages/youtube-${YT}.jpg"`), "the hero poster is not our own copy");
    assert.doesNotMatch(html.live, /i\.ytimg\.com|vimeocdn/, "a third-party thumbnail is requested before a tap");
  });

  await step("the owner's preview shows the draft and never a live form", () => {
    const h = html.preview;
    assert.ok(h.includes("Draft headline, not live yet"));
    assert.ok(h.includes("Preview of your unpublished page"));
    assert.ok(h.includes("A preview never sends anything"));
    assert.doesNotMatch(h, /<input\b/i, "a preview drew form inputs");
  });

  done("offer-pages-public");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
