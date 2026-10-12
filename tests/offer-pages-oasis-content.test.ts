/**
 * offer-pages-oasis-content.test.ts - OASIS's four offer pages and the
 * "Start here" router (content/offers/oasis/*.json) and the script that seeds
 * them as drafts (scripts/seed-oasis-offer-pages.ts).
 *
 * WHAT IS PINNED:
 *   1. The script refuses to run without --tenant-slug oasis-ai-cc and exactly
 *      one of --dry-run / --apply, and the seed function refuses any other
 *      workspace. The script holds no workspace id: it resolves it by slug.
 *   2. Every page parses with the real parseOfferPageDoc and comes back
 *      unchanged (nothing silently dropped), and every form parses with the
 *      forms API's own parsers.
 *   3. The copy rules: no em or en dash, no house agent name, no results or
 *      guarantee section, the only bonus is COMMAND's with no value, every
 *      price is a figure the funnel doc states, every monthly plan says how to
 *      cancel, every page has "What if I'm not ready?" pointing at its tracked
 *      community link, and every hero has an empty video slot and a script.
 *   4. Against a scratch libSQL file: a dry run writes nothing; --apply makes
 *      five SWITCHED-OFF forms and five DRAFT pages (never live, never
 *      published) in the workspace found by slug; a second run changes
 *      nothing; a half-finished run resumes; a form someone else owns is left
 *      alone; and the claims gate refuses to publish any of them.
 *   5. content/offers/oasis/PUBLISH_CHECKLIST.md lists every sentence the
 *      claims linter flags, so nothing that needs an owner's tick is missed.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-oasis-content.test.ts
 */
import { OASIS, done, formRow, setupOfferDatabase, step, ROOT } from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CONTENT_DIR = join(ROOT, "content", "offers", "oasis");
const SLUGS = ["vsl", "protocol", "command", "community", "fleet"];
const HOUSE_AGENTS = /\b(bravo|maven|atlas|aura|apex|knut)\b/i;

/**
 * Every dollar figure the funnel doc (oasis_funnel_master.md) and HANDOVER
 * section 4 state, plus the /ai-audit form's own revenue and budget bands.
 * A figure on a page that is not here is a typo or an invented price.
 */
const FUNNEL_FIGURES = new Set([
  "0", "17", "27", "47", "59", "97", "147", "197", "297", "395", "497", "500", "997",
  "1400", "2000", "2500", "3500", "5000", "7500", "15000",
  "2K", "5K", "10K", "15K", "50K", "75K", "250K",
]);

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function rawFile(slug: string): { text: string; json: Raw } {
  const text = readFileSync(join(CONTENT_DIR, `${slug}.json`), "utf8");
  return { text, json: JSON.parse(text) as Raw };
}

/** The page as written, minus the explicit empty slots the parser rightly drops (video: null, value: null). */
function withoutEmptySlots(doc: Raw): Raw {
  const copy = JSON.parse(JSON.stringify(doc)) as Raw;
  if (copy.hero.video === null) delete copy.hero.video;
  for (const s of copy.sections) {
    if (s.key === "bonuses") for (const it of s.items) if (it.value === null) delete it.value;
  }
  return copy;
}

/** Every piece of text a visitor can read: page copy, script, form labels, options, help and thanks. */
function visibleText(json: Raw): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(json.offer_page.hero);
  walk(json.offer_page.sections);
  walk(json.offer_page.book);
  walk(json.offer_page.nav);
  walk(json.offer_page.seo);
  walk(json.form.branding);
  for (const st of json.form.steps) {
    out.push(st.title, st.description ?? "", st.cta_label ?? "");
    for (const f of st.fields) {
      out.push(f.label, f.help ?? "", f.placeholder ?? "");
      for (const o of f.options ?? []) out.push(o.label);
    }
  }
  return out.filter(Boolean);
}

async function main() {
  const db = await setupOfferDatabase();
  const seed = await import("../scripts/seed-oasis-offer-pages");
  const { parseOfferPageDoc } = await import("../lib/offer-pages/types");
  const { parseFormSteps } = await import("../lib/forms/types");
  const claims = await import("../lib/offer-pages/claims");

  console.log("offer-pages-oasis-content:");

  // -- 1. refusals --------------------------------------------------------
  await step("the script refuses without --tenant-slug oasis-ai-cc and exactly one of --dry-run / --apply", () => {
    const refused = [
      [],
      ["--dry-run"],
      ["--apply"],
      ["--tenant-slug", "client-a", "--dry-run"],
      ["--tenant-slug=client-a", "--apply"],
      ["--tenant-slug"],
      ["--tenant-slug", "--dry-run"],
      ["--tenant-slug", "oasis-ai-cc"],
      ["--tenant-slug", "oasis-ai-cc", "--dry-run", "--apply"],
      ["--tenant-slug", "oasis-ai-cc", "--dry-run", "--publish"],
    ];
    for (const argv of refused) assert.equal(seed.parseArgs(argv).ok, false, `accepted: ${argv.join(" ")}`);
    assert.deepEqual(seed.parseArgs(["--tenant-slug", "oasis-ai-cc", "--dry-run"]), { ok: true, args: { tenantSlug: "oasis-ai-cc", apply: false } });
    assert.deepEqual(seed.parseArgs(["--apply", "--tenant-slug=oasis-ai-cc"]), { ok: true, args: { tenantSlug: "oasis-ai-cc", apply: true } });
  });

  await step("the seed function refuses another workspace, and the script holds no workspace id", async () => {
    const content = seed.loadOasisOfferContent(CONTENT_DIR);
    await assert.rejects(() => seed.seedOasisOfferPages(db, { tenantSlug: "client-a", apply: true, content }), /oasis-ai-cc only/);
    const src = readFileSync(join(ROOT, "scripts", "seed-oasis-offer-pages.ts"), "utf8");
    assert.doesNotMatch(src, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, "a workspace id is written in the script");
  });

  // -- 2. parsing ---------------------------------------------------------
  await step("every page parses with parseOfferPageDoc and comes back unchanged; every form parses", () => {
    for (const slug of SLUGS) {
      const { json } = rawFile(slug);
      const parsed = parseOfferPageDoc(json.offer_page);
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), withoutEmptySlots(json.offer_page), `${slug}: the parser dropped or changed something`);
      assert.deepEqual(parseOfferPageDoc(JSON.stringify(parsed)), parsed, `${slug}: not stable through the database string form`);
      parseFormSteps(json.form.steps);
    }
    const loaded = seed.loadOasisOfferContent(CONTENT_DIR);
    assert.deepEqual(loaded.map((c) => c.slug), SLUGS);
  });

  await step("a broken file is refused before anything is written", () => {
    const { json } = rawFile("protocol");
    const bad = JSON.parse(JSON.stringify(json));
    bad.offer_page.sections.push({ key: "results", items: [{ kind: "quote", quote: "Great.", who: "A client" }] });
    assert.throws(() => seed.parseOfferContent(bad, "protocol.json"), /evidence/);
    const wrongLink = JSON.parse(JSON.stringify(json));
    wrongLink.community_link.href = "https://t.me/+somewhere";
    assert.throws(() => seed.parseOfferContent(wrongLink, "protocol.json"), /community_link/);
  });

  // -- 3. copy rules ------------------------------------------------------
  await step("no em or en dash and no house agent name in any file", () => {
    for (const slug of SLUGS) {
      const { text } = rawFile(slug);
      assert.ok(!text.includes("—"), `${slug}: em dash`);
      assert.ok(!text.includes("–"), `${slug}: en dash`);
      assert.doesNotMatch(text, HOUSE_AGENTS, `${slug}: house agent name`);
    }
    const checklist = readFileSync(join(CONTENT_DIR, "PUBLISH_CHECKLIST.md"), "utf8");
    assert.ok(!checklist.includes("—"), "checklist: em dash");
  });

  await step("no results or guarantee section; the only bonus is COMMAND's, with no value until confirmed", () => {
    for (const slug of SLUGS) {
      const keys = rawFile(slug).json.offer_page.sections.map((s: Raw) => s.key);
      assert.ok(!keys.includes("results"), `${slug}: results section`);
      assert.ok(!keys.includes("guarantee"), `${slug}: guarantee section`);
      if (slug !== "command") assert.ok(!keys.includes("bonuses"), `${slug}: bonuses section`);
    }
    const bonuses = rawFile("command").json.offer_page.sections.find((s: Raw) => s.key === "bonuses");
    assert.equal(bonuses.items.length, 1);
    assert.match(bonuses.items[0].title, /expedited VIP vault bonus/i);
    assert.equal(bonuses.items[0].value, null);
  });

  await step("every dollar figure on every page and form is one the funnel doc states", () => {
    for (const slug of SLUGS) {
      for (const t of visibleText(rawFile(slug).json)) {
        for (const m of t.matchAll(/\$([0-9][0-9,]*)(K?)/g)) {
          const fig = m[1].replace(/,/g, "") + m[2];
          assert.ok(FUNNEL_FIGURES.has(fig), `${slug}: $${m[1]}${m[2]} is not in the funnel doc ("${t.slice(0, 80)}")`);
        }
      }
    }
  });

  await step("every monthly plan says plainly how to cancel, with no cancellation fee", () => {
    let monthly = 0;
    for (const slug of ["command", "community"]) {
      const wyg = rawFile(slug).json.offer_page.sections.find((s: Raw) => s.key === "what_you_get");
      for (const it of wyg.items) {
        if (!/a month/.test(it.title)) continue;
        monthly += 1;
        assert.match(it.body, /cancel[^.]*any time from your account; no cancellation fee/i, `${slug}: "${it.title}"`);
      }
    }
    assert.equal(monthly, 5, "five monthly plans: OS DIY, Turnkey, managed partner, VIP, mentorship");
  });

  await step("every page: \"What if I'm not ready?\" points at its tracked community link, and so does its thank-you", () => {
    for (const slug of SLUGS) {
      const { json } = rawFile(slug);
      const url = `https://oasisai.work${seed.communityHref(slug)}`;
      assert.equal(json.community_link.href, `/go/community?form=${slug}&t=oasis-ai-cc`);
      assert.equal(json.community_link.label, "Not ready? Join the free community");
      const faq = json.offer_page.sections.find((s: Raw) => s.key === "faq");
      const item = faq.items.find((i: Raw) => i.q === "What if I'm not ready?");
      assert.ok(item, `${slug}: no "What if I'm not ready?"`);
      assert.ok(item.a.includes(url), `${slug}: the answer does not carry ${url}`);
      assert.ok(json.form.branding.thanks_message.includes(url), `${slug}: thank-you without the community link`);
    }
  });

  await step("every hero: an empty video slot, a script by the founders, no transcript drawn yet, kept out of search", () => {
    for (const slug of SLUGS) {
      const doc = rawFile(slug).json.offer_page;
      assert.equal(doc.hero.video, null, slug);
      assert.equal(doc.hero.vsl_script.source, "cc", slug);
      assert.ok(doc.hero.vsl_script.text.length > 800, `${slug}: script too short`);
      assert.match(doc.hero.vsl_script.text, /BEAT 1\. HOOK/, slug);
      if (slug === "community") assert.match(doc.hero.vsl_script.text, /Join free below/, slug);
      else assert.match(doc.hero.vsl_script.text, /free community is linked/, slug);
      assert.equal(doc.hero.show_transcript, false, slug);
      assert.equal(doc.seo.indexable, false, slug);
    }
  });

  await step("the router asks the path as four cards, then revenue and budget with the /ai-audit values", async () => {
    const { AI_AUDIT_STEPS } = await import("../lib/forms/oasis-ai-audit-seed");
    const values = (name: string) =>
      AI_AUDIT_STEPS.flatMap((s) => s.fields).find((f) => f.name === name)!.options!.map((o) => o.value);
    const steps = rawFile("vsl").json.form.steps;
    assert.deepEqual(steps[0].fields[0].options.map((o: Raw) => o.value), ["protocol", "command", "community", "fleet"]);
    const fit = steps[1].fields;
    assert.deepEqual(fit.find((f: Raw) => f.name === "monthly_revenue").options.map((o: Raw) => o.value), values("monthly_revenue"));
    assert.deepEqual(fit.find((f: Raw) => f.name === "budget").options.map((o: Raw) => o.value), values("budget"));
    // FLEET keeps the /ai-audit steps' field names and option values.
    const fleet = rawFile("fleet").json.form.steps.flatMap((s: Raw) => s.fields);
    for (const name of ["automation_goal", "tried_before", "monthly_revenue", "team_size", "budget", "timeframe", "wants_call"]) {
      assert.deepEqual(fleet.find((f: Raw) => f.name === name).options.map((o: Raw) => o.value), values(name), `fleet ${name}`);
    }
  });

  // -- 4. the seed, against a scratch database ----------------------------
  const content = seed.loadOasisOfferContent(CONTENT_DIR);
  const counts = async () => {
    const f = await db.execute({ sql: "SELECT COUNT(*) AS n FROM forms WHERE tenant_id = ?", args: [OASIS] });
    const p = await db.execute({ sql: "SELECT COUNT(*) AS n FROM form_offer_pages WHERE tenant_id = ?", args: [OASIS] });
    return { forms: Number(f.rows[0].n), pages: Number(p.rows[0].n) };
  };
  const before = await counts();

  await step("a dry run writes nothing and reports five forms and five pages it would create", async () => {
    const r = await seed.seedOasisOfferPages(db, { tenantSlug: "oasis-ai-cc", apply: false, content });
    assert.equal(r.tenantId, OASIS);
    assert.deepEqual(r.pages.map((p) => [p.slug, p.form, p.page]), SLUGS.map((s) => [s, "would_create", "would_create"]));
    assert.deepEqual(await counts(), before);
  });

  const NOW = "2026-10-12T15:00:00.000Z";
  await step("--apply: five switched-off forms and five draft pages in the workspace found by slug, nothing published", async () => {
    const r = await seed.seedOasisOfferPages(db, { tenantSlug: "oasis-ai-cc", apply: true, content, now: NOW });
    const t = await db.execute({ sql: "SELECT id FROM tenants WHERE slug = 'oasis-ai-cc'", args: [] });
    assert.equal(r.tenantId, String(t.rows[0].id));
    assert.deepEqual(r.pages.map((p) => [p.slug, p.form, p.page]), SLUGS.map((s) => [s, "created", "created"]));
    assert.deepEqual(await counts(), { forms: before.forms + 5, pages: before.pages + 5 });
    for (const c of content) {
      const f = await db.execute({ sql: "SELECT id, enabled, name, steps FROM forms WHERE tenant_id = ? AND slug = ?", args: [OASIS, c.slug] });
      assert.equal(f.rows.length, 1, c.slug);
      assert.equal(Number(f.rows[0].enabled), 0, `${c.slug}: form is switched on`);
      assert.equal(String(f.rows[0].name), c.form.name);
      assert.deepEqual(parseFormSteps(JSON.parse(String(f.rows[0].steps))), c.form.steps);
      const p = await db.execute({
        sql: "SELECT draft, draft_version, published, published_version, live, template_key FROM form_offer_pages WHERE tenant_id = ? AND form_id = ?",
        args: [OASIS, String(f.rows[0].id)],
      });
      assert.equal(Number(p.rows[0].live), 0, `${c.slug}: live`);
      assert.equal(p.rows[0].published, null, `${c.slug}: published`);
      assert.equal(Number(p.rows[0].published_version), 0);
      assert.equal(Number(p.rows[0].draft_version), 0);
      assert.equal(String(p.rows[0].template_key), c.doc.template);
      assert.deepEqual(parseOfferPageDoc(String(p.rows[0].draft)), c.doc, `${c.slug}: stored draft differs from the content`);
    }
  });

  await step("a second --apply changes nothing", async () => {
    const read = async () =>
      (
        await db.execute({
          sql: "SELECT p.form_id, p.draft, p.draft_version, p.updated_at, f.enabled, f.steps, f.updated_at AS form_updated FROM form_offer_pages p JOIN forms f ON f.id = p.form_id WHERE p.tenant_id = ? ORDER BY p.form_id",
          args: [OASIS],
        })
      ).rows.map((x) => [x.form_id, x.draft, x.draft_version, x.updated_at, x.enabled, x.steps, x.form_updated]);
    const snap = await read();
    const r = await seed.seedOasisOfferPages(db, { tenantSlug: "oasis-ai-cc", apply: true, content, now: "2026-10-13T00:00:00.000Z" });
    assert.deepEqual(r.pages.map((p) => [p.form, p.page]), SLUGS.map(() => ["resumed", "exists_left"]));
    assert.deepEqual(await read(), snap);
    assert.deepEqual(await counts(), { forms: before.forms + 5, pages: before.pages + 5 });
  });

  await step("a run that stopped after the form resumes: the page is added, the form is not duplicated", async () => {
    const f = await db.execute({ sql: "SELECT id FROM forms WHERE tenant_id = ? AND slug = 'community'", args: [OASIS] });
    await db.execute({ sql: "DELETE FROM form_offer_pages WHERE tenant_id = ? AND form_id = ?", args: [OASIS, String(f.rows[0].id)] });
    const r = await seed.seedOasisOfferPages(db, { tenantSlug: "oasis-ai-cc", apply: true, content, now: NOW });
    const community = r.pages.find((p) => p.slug === "community")!;
    assert.deepEqual([community.form, community.page], ["resumed", "created"]);
    assert.deepEqual(await counts(), { forms: before.forms + 5, pages: before.pages + 5 });
  });

  await step("a form someone else owns under the same slug (switched on, or another name) is left alone and gets no page", async () => {
    const clone = (slug: string) => ({ ...content[1], slug, form: { ...content[1].form, slug } });
    await db.batch(
      [
        formRow("f0c1a100-0000-4000-8000-0000000000a1", OASIS, "guard-live", content[1].form.name, [], {}, 1),
        formRow("f0c1a100-0000-4000-8000-0000000000a2", OASIS, "guard-foreign", "Somebody's draft form", [], {}, 0),
      ],
      "write",
    );
    const r = await seed.seedOasisOfferPages(db, { tenantSlug: "oasis-ai-cc", apply: true, content: [clone("guard-live"), clone("guard-foreign")], now: NOW });
    assert.deepEqual(r.pages.map((p) => [p.slug, p.form, p.page]), [
      ["guard-live", "skipped_live", "skipped"],
      ["guard-foreign", "skipped_foreign", "skipped"],
    ]);
    const pages = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM form_offer_pages WHERE form_id IN ('f0c1a100-0000-4000-8000-0000000000a1', 'f0c1a100-0000-4000-8000-0000000000a2')",
      args: [],
    });
    assert.equal(Number(pages.rows[0].n), 0);
    const live = await db.execute({ sql: "SELECT enabled FROM forms WHERE id = 'f0c1a100-0000-4000-8000-0000000000a1'", args: [] });
    assert.equal(Number(live.rows[0].enabled), 1, "the seed changed someone's form");
  });

  await step("the claims gate refuses to publish any of them: the form is off and every flagged sentence is unticked", async () => {
    for (const c of content) {
      const gate = claims.publishGate(c.doc, [], { formEnabled: false, fallbackHeadline: c.form.branding.headline ?? "" });
      assert.ok(gate.blockers.some((b) => /Switch the form on first/.test(b)), `${c.slug}: no form-off blocker`);
      const hits = claims.lintDoc(c.doc, { fallbackHeadline: c.form.branding.headline ?? "" });
      assert.equal(gate.claims.length, hits.length);
      assert.ok(hits.length > 0, `${c.slug}: prices on the page but nothing flagged`);
    }
  });

  // -- 5. the checklist ---------------------------------------------------
  await step("PUBLISH_CHECKLIST.md lists every sentence the claims linter flags, per page", () => {
    const checklist = readFileSync(join(CONTENT_DIR, "PUBLISH_CHECKLIST.md"), "utf8");
    const missing: string[] = [];
    for (const c of content) {
      for (const h of claims.lintDoc(c.doc, { fallbackHeadline: c.form.branding.headline ?? "" })) {
        if (!checklist.includes(h.sentence)) missing.push(`${c.slug}: ${h.sentence}`);
      }
    }
    assert.deepEqual(missing, [], "flagged sentences missing from the checklist");
  });

  done("offer-pages-oasis-content");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
