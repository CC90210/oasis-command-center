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
 *      claims linter flags, so nothing that needs an owner's tick is missed,
 *      under one "### <Title> (`slug`): N" heading per page whose N is what
 *      the linter flags today.
 *   6. --refresh-drafts, against an IN-MEMORY libSQL shaped like production
 *      on 2026-10-16 (ai-audit's form live, its page an empty free_audit
 *      draft; community saved by a person; nothing published): it writes a
 *      draft only when the page is not live, never published and no person
 *      saved it; a person's draft is left with what differs, unless
 *      --include-edited names it; a published page never; a concurrent save
 *      or publish between the read and the write is a "conflict", never an
 *      overwrite; no form row ever changes; page-only files
 *      (<slug>.page.json) are a bare page, absent is "no_content", and the
 *      create path never reads or creates them. A copy file never carries an
 *      owner's sign-off.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-oasis-content.test.ts
 */
import { OASIS, OFFER_MIGRATION_PATH, done, formRow, setupOfferDatabase, splitSql, step, ROOT } from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, InStatement } from "@libsql/client";

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
  // 3000: BEA docs/funnel/OASIS_MASTER_HANDOVER_AND_SALES_ENGINE.md section 4.2 ("2C Managed Partner:
  // $5,000 setup + $3,000 / mo"; 4B "$3,000-$8,000"). Missing here until COMMAND quoted it (2026-10-16).
  "1400", "2000", "2500", "3000", "3500", "5000", "7500", "15000",
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
    assert.deepEqual(seed.parseArgs(["--tenant-slug", "oasis-ai-cc", "--dry-run"]), {
      ok: true,
      args: { tenantSlug: "oasis-ai-cc", apply: false, refresh: false, includeEdited: [] },
    });
    assert.deepEqual(seed.parseArgs(["--apply", "--tenant-slug=oasis-ai-cc"]), {
      ok: true,
      args: { tenantSlug: "oasis-ai-cc", apply: true, refresh: false, includeEdited: [] },
    });
  });

  await step("--refresh-drafts needs the workspace and exactly one of --dry-run / --apply; --include-edited names a known page and only goes with it", () => {
    const refused: Array<[string[], RegExp]> = [
      [["--refresh-drafts"], /--tenant-slug/],
      [["--refresh-drafts", "--dry-run"], /--tenant-slug/],
      [["--tenant-slug", "client-a", "--refresh-drafts", "--apply"], /oasis-ai-cc workspace only/],
      [["--tenant-slug", "oasis-ai-cc", "--refresh-drafts"], /exactly one/],
      [["--tenant-slug", "oasis-ai-cc", "--refresh-drafts", "--dry-run", "--apply"], /exactly one/],
      [["--tenant-slug", "oasis-ai-cc", "--apply", "--include-edited", "community"], /only goes with --refresh-drafts/],
      [["--tenant-slug", "oasis-ai-cc", "--refresh-drafts", "--apply", "--include-edited"], /needs a page slug/],
      [["--tenant-slug", "oasis-ai-cc", "--refresh-drafts", "--apply", "--include-edited", "--dry-run"], /needs a page slug/],
      [["--tenant-slug", "oasis-ai-cc", "--refresh-drafts", "--apply", "--include-edited", "start"], /not one of the pages/],
      [["--tenant-slug", "oasis-ai-cc", "--refresh-drafts", "--apply", "--include-edited=../vsl"], /not one of the pages/],
      [["--tenant-slug", "oasis-ai-cc", "--refresh-drafts", "--apply", "--publish"], /unknown argument/],
    ];
    for (const [argv, why] of refused) {
      const r = seed.parseArgs(argv);
      assert.equal(r.ok, false, `accepted: ${argv.join(" ")}`);
      if (!r.ok) assert.match(r.error, why, argv.join(" "));
    }
    assert.deepEqual(seed.parseArgs(["--tenant-slug", "oasis-ai-cc", "--refresh-drafts", "--dry-run"]), {
      ok: true,
      args: { tenantSlug: "oasis-ai-cc", apply: false, refresh: true, includeEdited: [] },
    });
    assert.deepEqual(
      seed.parseArgs(["--refresh-drafts", "--apply", "--include-edited", "community", "--tenant-slug", "oasis-ai-cc", "--include-edited=ai-audit", "--include-edited", "community"]),
      { ok: true, args: { tenantSlug: "oasis-ai-cc", apply: true, refresh: true, includeEdited: ["community", "ai-audit"] } },
    );
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
    // A copy file never signs off a price on an owner's behalf: the server stamps that when an owner ticks it.
    const signed = JSON.parse(JSON.stringify(json));
    // The page may already have its own pricing section (PROTOCOL does since 2026-10-16): replace it.
    signed.offer_page.sections = signed.offer_page.sections.filter((s: Raw) => s.key !== "pricing");
    signed.offer_page.sections.push({ key: "pricing", tiers: [{ name: "Pack", price: "$97", price_cad: "CA$135", confirmed: { by: "copywriter", at: "2026-10-16T12:00:00.000Z" } }] });
    assert.throws(() => seed.parseOfferContent(signed, "protocol.json"), /offer_page\.sections\[\d+\]\.tiers\[0\]\.confirmed: a content file never carries an owner's sign-off/);
    const unsigned = JSON.parse(JSON.stringify(signed));
    delete unsigned.offer_page.sections.at(-1).tiers[0].confirmed;
    assert.equal(seed.parseOfferContent(unsigned, "protocol.json").slug, "protocol", "a price written with no sign-off is refused");
  });

  // -- 3. copy rules ------------------------------------------------------
  await step("no em or en dash and no house agent name in any file", () => {
    for (const slug of SLUGS) {
      const { text } = rawFile(slug);
      assert.ok(!text.includes("—"), `${slug}: em dash`);
      assert.ok(!text.includes("–"), `${slug}: en dash`);
      // What the page shows. Left out: the script's `source` (who wrote it, a record), the `brief` (stripped
      // before publish), and the word-for-word narration of an approved film (source "maven"): the film is
      // what CC approved on 2026-10-16, and FLEET's names OASIS's own agents on purpose. All copy is checked.
      const shown = structuredClone(rawFile(slug).json);
      const script = shown.offer_page?.hero?.vsl_script;
      if (script) {
        if (script.source === "maven") delete script.text;
        delete script.source;
      }
      if (shown.offer_page) delete shown.offer_page.brief;
      assert.doesNotMatch(JSON.stringify(shown), HOUSE_AGENTS, `${slug}: house agent name`);
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
    const CANCEL = /cancel[^.]*any time from your account[.;] (there is )?no cancellation fee/i;
    for (const slug of ["command", "community"]) {
      const sections = rawFile(slug).json.offer_page.sections;
      const wyg = sections.find((s: Raw) => s.key === "what_you_get");
      for (const it of wyg.items) {
        if (!/a month/.test(it.title)) continue;
        monthly += 1;
        assert.match(it.body, CANCEL, `${slug}: "${it.title}"`);
      }
      // A monthly plan in the pricing section (2026-10-16): the section that lists it says how to cancel.
      const pricing = sections.find((s: Raw) => s.key === "pricing");
      for (const t of pricing?.tiers ?? []) {
        if (!/a month/.test(t.cadence ?? "")) continue;
        monthly += 1;
        assert.match(`${pricing.lede ?? ""} ${t.summary ?? ""}`, CANCEL, `${slug}: pricing tier "${t.name}"`);
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

  await step("every hero: an empty video slot, a script by the founders or the narration of its approved film, no transcript drawn yet, kept out of search", () => {
    for (const slug of SLUGS) {
      const doc = rawFile(slug).json.offer_page;
      assert.equal(doc.hero.video, null, slug);
      // "cc": the founders' recording script. "maven": the narration, word for word, of the approved pillar
      // film the page plays (CC approved those films 2026-10-16); a 20-second narration has no beats.
      assert.ok(["cc", "maven"].includes(doc.hero.vsl_script.source), `${slug}: script source ${doc.hero.vsl_script.source}`);
      assert.ok(doc.hero.vsl_script.text.trim().length > 0, `${slug}: empty script`);
      if (doc.hero.vsl_script.source === "cc") {
        assert.ok(doc.hero.vsl_script.text.length > 800, `${slug}: script too short`);
        assert.match(doc.hero.vsl_script.text, /BEAT 1\. HOOK/, slug);
        if (slug === "community") assert.match(doc.hero.vsl_script.text, /Join free below/, slug);
        else assert.match(doc.hero.vsl_script.text, /free community is linked/, slug);
      }
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
    const wrongCount: string[] = [];
    // Each page's table is headed "### <Title> (`slug`): N", once, with N what the linter flags today.
    const counted = (slug: string, n: number) => {
      const heads = [...checklist.matchAll(new RegExp(`^### .+ \\(\`${slug}\`\\): (\\d+)$`, "gm"))].map((m) => Number(m[1]));
      if (heads.length !== 1 || heads[0] !== n) wrongCount.push(`${slug}: headings ${JSON.stringify(heads)}, lintDoc flags ${n}`);
    };
    for (const c of content) {
      const hits = claims.lintDoc(c.doc, { fallbackHeadline: c.form.branding.headline ?? "" });
      counted(c.slug, hits.length);
      for (const h of hits) {
        if (!checklist.includes(h.sentence)) missing.push(`${c.slug}: ${h.sentence}`);
      }
    }
    // Page-only pages (ai-audit) need their ticks listed too.
    for (const p of seed.loadOasisPageOnlyContent(CONTENT_DIR)) {
      if (!p.doc) continue;
      const hits = claims.lintDoc(p.doc, { fallbackHeadline: "" });
      counted(p.slug, hits.length);
      for (const h of hits) {
        if (!checklist.includes(h.sentence)) missing.push(`${p.slug}: ${h.sentence}`);
      }
    }
    assert.deepEqual(missing, [], "flagged sentences missing from the checklist");
    assert.deepEqual(wrongCount, [], "a checklist table's count is stale or the table is listed twice");
  });

  // -- 6. --refresh-drafts, against an in-memory database --------------------
  const { createClient } = await import("@libsql/client");
  const { publishDraft, saveDraft } = await import("../lib/offer-pages/store");
  const { emptyDocForTemplate } = await import("../lib/offer-pages/templates");
  const bySlug = (slug: string) => content.find((c) => c.slug === slug)!;
  const PERSON = "0d000000-0000-4000-8000-000000000002";
  const EDITED_AT = "2026-10-14T18:30:00.000Z";
  const T_REFRESH = "2026-10-16T20:00:00.000Z";
  const TICK = { hash: "a".repeat(64), excerpt: "An older claim.", by: PERSON, at: EDITED_AT };
  /** What the copy team would write for /ai-audit (a page-only file): a free_audit page, no sign-offs. */
  const auditDoc = { ...JSON.parse(JSON.stringify(bySlug("fleet").doc)), template: "free_audit" };
  auditDoc.hero.headline = "Find the hours AI can give back to your team";
  const auditOnly = (doc: unknown = auditDoc) => [{ slug: "ai-audit", file: "ai-audit.page.json", doc: doc === null ? null : parseOfferPageDoc(doc) }];
  /** The community draft a person saved on 2026-10-14: the content with one line edited and the FAQ removed. */
  const personCommunity = JSON.parse(JSON.stringify(bySlug("community").doc));
  personCommunity.hero.subheadline = "A subheadline someone edited in the builder.";
  personCommunity.sections = personCommunity.sections.filter((s: Raw) => s.key !== "faq");
  const olderVsl = JSON.parse(JSON.stringify(bySlug("vsl").doc));
  olderVsl.hero.headline = "An older headline";
  const IDS: Record<string, string> = {
    "ai-audit": "f0c1a200-0000-4000-8000-0000000000a0",
    vsl: "f0c1a200-0000-4000-8000-0000000000a1",
    protocol: "f0c1a200-0000-4000-8000-0000000000a2",
    command: "f0c1a200-0000-4000-8000-0000000000a3",
    community: "f0c1a200-0000-4000-8000-0000000000a4",
    fleet: "f0c1a200-0000-4000-8000-0000000000a5",
    "no-page": "f0c1a200-0000-4000-8000-0000000000a6",
  };

  /** A fresh in-memory database shaped like production on 2026-10-16. Never the real one. */
  const production = async (): Promise<Client> => {
    const mem = createClient({ url: ":memory:" });
    await mem.executeMultiple(`
      CREATE TABLE tenants (id TEXT PRIMARY KEY, slug TEXT, name TEXT);
      CREATE TABLE forms (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, slug TEXT NOT NULL, name TEXT NOT NULL,
        description TEXT, branding TEXT NOT NULL DEFAULT '{}', steps TEXT NOT NULL DEFAULT '[]', on_complete_stage TEXT,
        step_outcomes TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, redirect_url TEXT, created_by TEXT,
        created_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z', updated_at TEXT NOT NULL DEFAULT '2026-09-01T00:00:00.000Z');
    `);
    for (const stmt of splitSql(readFileSync(OFFER_MIGRATION_PATH, "utf8"))) await mem.execute(stmt);
    await mem.execute({ sql: "INSERT INTO tenants (id, slug, name) VALUES (?, 'oasis-ai-cc', 'OASIS AI')", args: [OASIS] });
    const form = (slug: string, name: string, enabled: number, steps: unknown) =>
      mem.execute({
        sql: "INSERT INTO forms (id, tenant_id, slug, name, steps, enabled) VALUES (?, ?, ?, ?, ?, ?)",
        args: [IDS[slug], OASIS, slug, name, JSON.stringify(steps), enabled],
      });
    await form("ai-audit", "AI Automation Audit", 1, [{ key: "live-step", title: "Tell us about your business", fields: [] }]);
    for (const slug of ["vsl", "protocol", "command", "community", "fleet"]) {
      await form(slug, bySlug(slug).form.name, slug === "fleet" ? 1 : 0, bySlug(slug).form.steps);
    }
    await form("no-page", "A form with no page", 0, []);
    const page = (
      slug: string,
      draft: unknown,
      o: { template?: string; version?: number; by?: string | null; published?: unknown; publishedVersion?: number; live?: number; claims?: unknown[] } = {},
    ) =>
      mem.execute({
        sql: `INSERT INTO form_offer_pages (form_id, tenant_id, template_key, draft, draft_version, draft_updated_at, draft_updated_by,
                published, published_version, published_at, published_by, live, claims_confirmed, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-10-12T15:00:00.000Z', ?)`,
        args: [
          IDS[slug],
          OASIS,
          o.template ?? (draft as Raw).template,
          JSON.stringify(draft),
          o.version ?? 0,
          o.by ? EDITED_AT : "2026-10-12T15:00:00.000Z",
          o.by ?? null,
          o.published === undefined ? null : JSON.stringify(o.published),
          o.publishedVersion ?? 0,
          o.published === undefined ? null : EDITED_AT,
          o.published === undefined ? null : PERSON,
          o.live ?? 0,
          JSON.stringify(o.claims ?? []),
          o.by ? EDITED_AT : "2026-10-12T15:00:00.000Z",
        ],
      });
    await page("ai-audit", emptyDocForTemplate("free_audit"));
    await page("vsl", olderVsl, { claims: [TICK] });
    await page("protocol", bySlug("protocol").doc);
    await page("command", olderVsl, { published: olderVsl, publishedVersion: 1, live: 1 });
    await page("community", personCommunity, { version: 3, by: PERSON });
    // Published once, then unpublished: still a page someone put in front of the public.
    await page("fleet", bySlug("fleet").doc, { published: bySlug("fleet").doc, publishedVersion: 1, live: 0 });
    return mem;
  };
  const snapshot = async (mem: Client) => ({
    forms: (await mem.execute("SELECT * FROM forms ORDER BY id")).rows.map((r) => JSON.stringify(r)),
    pages: (await mem.execute("SELECT * FROM form_offer_pages ORDER BY form_id")).rows.map((r) => JSON.stringify(r)),
  });
  const pageRow = async (mem: Client, slug: string) =>
    (await mem.execute({ sql: "SELECT * FROM form_offer_pages WHERE form_id = ?", args: [IDS[slug]] })).rows[0] as unknown as Raw;
  const outcomes = (r: { pages: Array<{ slug: string; outcome: string }> }) => Object.fromEntries(r.pages.map((p) => [p.slug, p.outcome]));
  /** Runs `between` once, just before the refresh's own draft write reaches the table: a save or publish landing after the read. */
  const interleaved = (mem: Client, between: () => Promise<unknown>): Client => {
    let fired = false;
    return new Proxy(mem, {
      get(target, prop) {
        if (prop === "execute") {
          return async (stmt: InStatement) => {
            const sql = typeof stmt === "string" ? stmt : stmt.sql;
            if (!fired && /^\s*UPDATE form_offer_pages\s+SET draft = /.test(sql)) {
              fired = true;
              await between();
            }
            return target.execute(stmt);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  };

  await step("page-only files: none yet is no_content, a file is the page alone (parsed first), a bad one or a sign-off refuses; the create path never takes one", async () => {
    assert.deepEqual([...seed.OASIS_PAGE_ONLY_SLUGS], ["ai-audit"]);
    assert.ok(!seed.OASIS_PAGE_ONLY_SLUGS.some((s) => (seed.OASIS_OFFER_SLUGS as readonly string[]).includes(s)), "a page-only slug is also a content slug");
    // The real page (Maven's copy, 2026-10-16): the page alone, parsed by the strict parser, no form block.
    const [real] = seed.loadOasisPageOnlyContent(CONTENT_DIR);
    assert.equal(real.slug, "ai-audit");
    assert.equal(real.file, join(CONTENT_DIR, "ai-audit.page.json"));
    assert.ok(real.doc, "content/offers/oasis/ai-audit.page.json parses");
    assert.equal(real.doc!.template, "free_audit");
    assert.ok(!real.doc!.hero.video, "no video until one is attached with its rights tick");
    const dir = mkdtempSync(join(tmpdir(), "page-only-"));
    const file = join(dir, "ai-audit.page.json");
    writeFileSync(file, JSON.stringify(auditDoc));
    assert.deepEqual(seed.loadOasisPageOnlyContent(dir), [{ slug: "ai-audit", file, doc: parseOfferPageDoc(auditDoc) }]);
    // A full content file (form and all) is not a page-only file: the form is never redefined.
    writeFileSync(file, JSON.stringify(rawFile("fleet").json));
    assert.throws(() => seed.loadOasisPageOnlyContent(dir), (e: unknown) => e instanceof seed.ContentError && /unknown key/.test(e.message));
    writeFileSync(file, JSON.stringify({ ...auditDoc, sections: [{ key: "pricing", tiers: [{ name: "Audit", price: "$2,500", confirmed: { by: "x", at: T_REFRESH } }] }] }));
    assert.throws(() => seed.loadOasisPageOnlyContent(dir), /\$\.sections\[0\]\.tiers\[0\]\.confirmed: a content file never carries an owner's sign-off/);
    writeFileSync(file, "{ not json");
    assert.throws(() => seed.loadOasisPageOnlyContent(dir), /unreadable/);
    // The create path: never reads a page-only file, and refuses content under a page-only slug.
    assert.ok(!seed.loadOasisOfferContent(CONTENT_DIR).some((c) => c.slug === "ai-audit"));
    const mem = await production();
    const before = await snapshot(mem);
    const asAudit = { ...bySlug("fleet"), slug: "ai-audit", form: { ...bySlug("fleet").form, slug: "ai-audit" } };
    await assert.rejects(() => seed.seedOasisOfferPages(mem, { tenantSlug: "oasis-ai-cc", apply: true, content: [asAudit] }), /page-only slug/);
    assert.deepEqual(await snapshot(mem), before, "the create path touched the page-only form");
  });

  await step("refresh dry run: reports each page's outcome and what differs, writes nothing", async () => {
    const mem = await production();
    const before = await snapshot(mem);
    const r = await seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: false, content, pageOnly: auditOnly(), now: T_REFRESH });
    assert.equal(r.tenantId, OASIS);
    assert.deepEqual(outcomes(r), {
      vsl: "would_refresh",
      protocol: "unchanged",
      command: "published_left",
      community: "edited_left",
      fleet: "published_left",
      "ai-audit": "would_refresh",
    });
    const vsl = r.pages.find((p) => p.slug === "vsl")!;
    assert.deepEqual([vsl.differences, vsl.version, vsl.ticks], [["hero.headline"], 0, 1]);
    const community = r.pages.find((p) => p.slug === "community")!;
    assert.deepEqual(
      [community.differences, community.editedBy, community.editedAt, community.version],
      [["hero.subheadline", "sections.faq (only in the content)"], PERSON, EDITED_AT, 3],
    );
    assert.deepEqual(await snapshot(mem), before, "a dry run wrote something");
    // Absent page-only copy: reported, nothing read for it.
    const none = await seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: false, content: [], pageOnly: auditOnly(null) });
    assert.deepEqual(outcomes(none), { "ai-audit": "no_content" });
  });

  await step("refresh: the owner sign-offs it clears (claim ticks and the confirmations inside a draft) are counted and named by the dry run; the apply prints the same count and the database loses exactly that many", async () => {
    // 2026-10-16: an apply cleared 3 ticks on COMMUNITY that the dry run never mentioned.
    const OTHER = "0d000000-0000-4000-8000-000000000003";
    const STAMP_A = { by: PERSON, at: EDITED_AT };
    const STAMP_B = { by: OTHER, at: "2026-10-15T09:00:00.000Z" };
    // Built from code points: the stored excerpt holds characters the report must not print.
    const nonAscii = `caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x2014)} claim`;
    const TICK_A = { hash: "b".repeat(64), excerpt: "Members meet every week.", by: PERSON, at: EDITED_AT };
    const TICK_B = { hash: "c".repeat(64), excerpt: nonAscii, by: OTHER, at: STAMP_B.at };
    /** The community content with a person's sign-offs on it: three prices, the top video's rights, a guarantee, a bonus value, a result. */
    const signedDoc = (): Raw => {
      const d = JSON.parse(JSON.stringify(bySlug("community").doc)) as Raw;
      const tiers = d.sections.find((s: Raw) => s.key === "pricing").tiers as Raw[];
      tiers[0].confirmed = STAMP_A;
      tiers[1].confirmed = STAMP_A;
      tiers[2].confirmed = STAMP_B;
      d.hero.video = { source: "youtube", id: "dQw4w9WgXcQ", aspect: "16:9", rights: STAMP_B };
      d.sections.push(
        { key: "guarantee", body: "Cancel any month.", confirmed: STAMP_A },
        { key: "bonuses", items: [{ title: "Starter pack", value: { cents: 9700, currency: "USD", confirmed: STAMP_B } }] },
        { key: "results", items: [{ kind: "quote", quote: "It paid for itself.", who: "A member", evidence: { permission: true, confirmed: STAMP_A } }] },
      );
      return d;
    };
    /** A production-shaped database where a person saved community with those sign-offs and two ticked claims. */
    const signed = async (): Promise<Client> => {
      const mem = await production();
      await mem.execute({
        sql: "UPDATE form_offer_pages SET draft = ?, claims_confirmed = ? WHERE form_id = ?",
        args: [JSON.stringify(signedDoc()), JSON.stringify([TICK_A, TICK_B]), IDS.community],
      });
      return mem;
    };
    /** Sign-offs a page holds, counted straight off the stored row (every {by, at} stamp in the draft, plus the ticks column), not through the code under test. */
    const stamps = (v: unknown): number =>
      Array.isArray(v)
        ? v.reduce((n: number, x: unknown) => n + stamps(x), 0)
        : v && typeof v === "object"
          ? (typeof (v as Raw).by === "string" && typeof (v as Raw).at === "string" ? 1 : 0) + Object.values(v as Raw).reduce((n: number, x: unknown) => n + stamps(x), 0)
          : 0;
    const signOffsOn = async (mem: Client, slug: string): Promise<number> => {
      const row = await pageRow(mem, slug);
      return stamps(JSON.parse(String(row.draft))) + (JSON.parse(String(row.claims_confirmed)) as unknown[]).length;
    };
    const SLUGS_WITH_PAGE = ["ai-audit", "vsl", "protocol", "command", "community", "fleet"];
    type Report = Awaited<ReturnType<typeof seed.refreshOasisOfferDrafts>>;
    const pageOf = (r: Report, slug: string) => r.pages.find((p) => p.slug === slug)!;
    /** One page's lines in the printed report: from its heading to the next blank line. */
    const block = (lines: string[], slug: string): string[] => {
      const rest = lines.slice(lines.findIndex((l) => l.startsWith(`${slug} (/f/`)) + 1);
      const end = rest.indexOf("");
      return end < 0 ? rest : rest.slice(0, end);
    };
    const COUNT_LINE = /^ {2}owner ticks (?:that would be )?cleared: (\d+)$/;
    /** The number a page's block prints. Exactly one count line per page, or the test fails. */
    const printed = (r: Report, slug: string): number => {
      const found = block(seed.formatRefreshReport(r), slug).map((l) => COUNT_LINE.exec(l)).filter((m) => m !== null);
      assert.equal(found.length, 1, `${slug}: expected exactly one "owner ticks ... cleared: N" line`);
      return Number(found[0]![1]);
    };
    const run = (mem: Client, o: { apply: boolean; includeEdited?: string[]; content?: typeof content }) =>
      seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: o.apply, content: o.content ?? content, pageOnly: auditOnly(), includeEdited: o.includeEdited, now: T_REFRESH });

    const mem = await signed();
    const before = await snapshot(mem);
    const heldBefore: Record<string, number> = {};
    for (const slug of SLUGS_WITH_PAGE) heldBefore[slug] = await signOffsOn(mem, slug);
    assert.equal(heldBefore.community, 9, "the fixture holds 7 confirmations (3 prices, video rights, guarantee, bonus value, result) and 2 ticks");

    // A dry run that does not name community: the page is left alone, and the number --include-edited would clear is still shown.
    const left = await run(mem, { apply: false });
    assert.equal(outcomes(left).community, "edited_left");
    assert.equal(printed(left, "community"), 9, "the dry run did not say what naming community would clear");
    assert.ok(block(seed.formatRefreshReport(left), "community").includes("    (only if --include-edited community replaces this page; this run leaves it alone)"));
    assert.equal(printed(left, "command"), 0, "a published page loses nothing");
    assert.equal(printed(left, "protocol"), 0, "an unchanged page loses nothing");
    assert.deepEqual(await snapshot(mem), before, "a dry run wrote something");

    // The dry run for the apply that will follow: counts and names every sign-off, who stamped it and when.
    const dry = await run(mem, { apply: false, includeEdited: ["community"] });
    assert.equal(outcomes(dry).community, "would_refresh_edited");
    const community = pageOf(dry, "community");
    assert.equal(community.ticks, 9);
    const kinds: Record<string, number> = {};
    for (const s of community.signOffs) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    assert.deepEqual(kinds, { price: 3, rights: 1, guarantee: 1, money: 1, evidence: 1, claim: 2 });
    const dryLines = block(seed.formatRefreshReport(dry), "community");
    assert.ok(dryLines.includes("  owner ticks that would be cleared: 9"), dryLines.join("\n"));
    const listed = dryLines.filter((l) => l.startsWith("    - "));
    const want = [
      `    - price: pricing tier 1 "Free community" price (stamped by ${PERSON} at ${EDITED_AT})`,
      `    - price: pricing tier 2 "VIP mastermind" price (stamped by ${PERSON} at ${EDITED_AT})`,
      `    - price: pricing tier 3 "Founder mentorship" price (stamped by ${OTHER} at ${STAMP_B.at})`,
      `    - rights: hero video rights (stamped by ${OTHER} at ${STAMP_B.at})`,
      `    - guarantee: guarantee terms (stamped by ${PERSON} at ${EDITED_AT})`,
      `    - money: bonuses item 1 value (stamped by ${OTHER} at ${STAMP_B.at})`,
      `    - evidence: results item 1 evidence (stamped by ${PERSON} at ${EDITED_AT})`,
      `    - claim: "Members meet every week." [bbbbbbbb] (stamped by ${PERSON} at ${EDITED_AT})`,
      // A stored value is printed as plain ASCII, whatever the database holds.
      `    - claim: "caf? ? claim" [cccccccc] (stamped by ${OTHER} at ${STAMP_B.at})`,
    ];
    assert.deepEqual([...listed].sort(), [...want].sort(), "the dry run did not name every sign-off");
    assert.ok(seed.formatRefreshReport(dry).every((l) => /^[\x20-\x7E]*$/.test(l)), "the report is not plain ASCII");
    // Stored text is redacted before it is printed (Codex review of #675): a
    // keyed URL pasted into the copy never reaches an agent's context.
    assert.equal(seed.plainText("see https://x.example/a?key=abc123secret&b=1"), "see https://x.example/a?key=[REDACTED]&b=1");
    for (const slug of SLUGS_WITH_PAGE) printed(dry, slug);
    assert.deepEqual(await snapshot(mem), before, "a dry run wrote something");

    // The apply prints the same number and the same names, and the database loses exactly that many, page by page.
    const applied = await run(mem, { apply: true, includeEdited: ["community"] });
    assert.equal(outcomes(applied).community, "refreshed_edited");
    assert.ok(block(seed.formatRefreshReport(applied), "community").includes("  owner ticks cleared: 9"));
    assert.deepEqual(block(seed.formatRefreshReport(applied), "community").filter((l) => l.startsWith("    - ")), listed, "the apply named other sign-offs than the dry run");
    for (const slug of SLUGS_WITH_PAGE) {
      const lost = heldBefore[slug] - (await signOffsOn(mem, slug));
      assert.equal(printed(dry, slug), lost, `${slug}: the dry run's count is not what the apply cleared`);
      assert.equal(printed(applied, slug), lost, `${slug}: the apply's count is not what it cleared`);
    }
    assert.equal(await signOffsOn(mem, "community"), 0);
    assert.ok(heldBefore.vsl === 1 && printed(applied, "vsl") === 1, "vsl's one tick was not counted");

    // What the written draft carries with the same stamp is not lost: the count follows the rule, it does not just count everything.
    const carried = JSON.parse(JSON.stringify(bySlug("community").doc)) as Raw;
    carried.sections.find((s: Raw) => s.key === "pricing").tiers[0].confirmed = STAMP_A;
    const withCarried = content.map((c) => (c.slug === "community" ? { ...c, doc: parseOfferPageDoc(carried) } : c));
    const mem2 = await signed();
    const dry2 = await run(mem2, { apply: false, includeEdited: ["community"], content: withCarried });
    assert.equal(printed(dry2, "community"), 8, "a confirmation the written draft carries was counted as lost");
    assert.ok(!block(seed.formatRefreshReport(dry2), "community").some((l) => l.includes('pricing tier 1 "Free community"')), "the carried price was listed");
    const applied2 = await run(mem2, { apply: true, includeEdited: ["community"], content: withCarried });
    assert.equal(printed(applied2, "community"), 8);
    assert.equal(await signOffsOn(mem2, "community"), 1, "the carried price lost its sign-off");

    // A stored draft that no longer parses: its confirmations cannot be listed, and the report says so instead of undercounting silently.
    const mem3 = await production();
    await mem3.execute({ sql: "UPDATE form_offer_pages SET draft = ? WHERE form_id = ?", args: [JSON.stringify({ v: 2 }), IDS.vsl] });
    const dry3 = await run(mem3, { apply: false, content: [bySlug("vsl")] });
    assert.deepEqual([pageOf(dry3, "vsl").outcome, pageOf(dry3, "vsl").draftUnreadable, pageOf(dry3, "vsl").ticks], ["would_refresh", true, 1]);
    assert.ok(block(seed.formatRefreshReport(dry3), "vsl").includes("    (the stored draft does not parse: confirmations inside it could not be counted)"));
  });

  await step("refresh --apply: only never-published, never-person-saved drafts are written, CAS on the version read; no form row changes; a re-run is unchanged", async () => {
    const mem = await production();
    const before = await snapshot(mem);
    const r = await seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: true, content, pageOnly: auditOnly(), now: T_REFRESH });
    assert.deepEqual(outcomes(r), {
      vsl: "refreshed",
      protocol: "unchanged",
      command: "published_left",
      community: "edited_left",
      fleet: "published_left",
      "ai-audit": "refreshed",
    });
    const after = await snapshot(mem);
    assert.deepEqual(after.forms, before.forms, "a refresh changed a form row (steps, name or switch)");
    for (const [slug, doc] of [["vsl", bySlug("vsl").doc], ["ai-audit", parseOfferPageDoc(auditDoc)]] as const) {
      const row = await pageRow(mem, slug);
      assert.deepEqual(parseOfferPageDoc(String(row.draft)), doc, `${slug}: the draft is not the content`);
      assert.deepEqual(
        [Number(row.draft_version), row.draft_updated_by, row.draft_updated_at, Number(row.live), row.published, Number(row.published_version), row.claims_confirmed],
        [1, null, T_REFRESH, 0, null, 0, "[]"],
        `${slug}: not a plain draft write`,
      );
    }
    assert.equal(String((await pageRow(mem, "ai-audit")).template_key), "free_audit");
    // Everything else is exactly as it was.
    const untouched = (s: { pages: string[] }) => s.pages.filter((p) => !p.includes(IDS.vsl) && !p.includes(IDS["ai-audit"]));
    assert.deepEqual(untouched(after), untouched(before), "a refresh touched a page it must leave");
    const again = await seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: true, content, pageOnly: auditOnly(), now: "2026-10-17T00:00:00.000Z" });
    assert.equal(outcomes(again).vsl, "unchanged");
    assert.equal(outcomes(again)["ai-audit"], "unchanged");
    assert.deepEqual(await snapshot(mem), after, "a second refresh changed something");
  });

  await step("--include-edited community: the person's draft is replaced (still CAS), its differences reported; a published page is never touched, named or not", async () => {
    const mem = await production();
    const before = await snapshot(mem);
    const dry = await seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: false, content, pageOnly: [], includeEdited: ["community", "command"] });
    assert.deepEqual([outcomes(dry).community, outcomes(dry).command], ["would_refresh_edited", "published_left"]);
    assert.deepEqual(await snapshot(mem), before);
    const r = await seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: true, content, pageOnly: [], includeEdited: ["community", "command"], now: T_REFRESH });
    assert.deepEqual(outcomes(r), { vsl: "refreshed", protocol: "unchanged", command: "published_left", community: "refreshed_edited", fleet: "published_left" });
    const community = r.pages.find((p) => p.slug === "community")!;
    assert.deepEqual([community.differences, community.editedBy, community.version], [["hero.subheadline", "sections.faq (only in the content)"], PERSON, 3]);
    const row = await pageRow(mem, "community");
    assert.deepEqual(parseOfferPageDoc(String(row.draft)), bySlug("community").doc);
    assert.deepEqual([Number(row.draft_version), row.draft_updated_by, Number(row.live), row.published], [4, null, 0, null]);
    assert.deepEqual((await snapshot(mem)).forms, before.forms);
    assert.equal(String((await pageRow(mem, "command")).draft), JSON.stringify(olderVsl), "a published page's draft was overwritten");
    const lines = seed.formatRefreshReport(r);
    assert.ok(lines.includes("  replaced: hero.subheadline, sections.faq (only in the content)"), lines.join("\n"));
    assert.ok(lines.some((l) => l.includes(`saved by a person (${PERSON}, ${EDITED_AT}): replaced, as --include-edited community asks`)), lines.join("\n"));
    assert.ok(lines.every((l) => /^[\x20-\x7E]*$/.test(l)), "the report is not plain ASCII");
    // Without the flag the same page is left, and the report says how to merge.
    const left = seed.formatRefreshReport(await seed.refreshOasisOfferDrafts(await production(), { tenantSlug: "oasis-ai-cc", apply: true, content, pageOnly: [] }));
    assert.ok(left.includes("  merge by hand, or re-run with --include-edited community to replace it"), left.join("\n"));
    assert.ok(left.includes("  differs from the content: hero.subheadline, sections.faq (only in the content)"), left.join("\n"));
    await assert.rejects(
      () => seed.refreshOasisOfferDrafts(mem, { tenantSlug: "oasis-ai-cc", apply: true, content, pageOnly: [], includeEdited: ["ai-audit"] }),
      /not a page this run refreshes/,
    );
    await assert.rejects(() => seed.refreshOasisOfferDrafts(mem, { tenantSlug: "client-a", apply: true, content, pageOnly: [] }), /oasis-ai-cc only/);
  });

  await step("a save or a publish landing between the refresh's read and its write is a conflict, never an overwrite", async () => {
    // A person saves the vsl draft in the builder (version 0 to 1).
    let mem = await production();
    const personDoc = { ...olderVsl, hero: { ...olderVsl.hero, headline: "The person's own headline" } };
    let r = await seed.refreshOasisOfferDrafts(
      interleaved(mem, () => saveDraft(mem, { tenantId: OASIS, formId: IDS.vsl, draft: parseOfferPageDoc(personDoc), expectedVersion: 0, claims: [], actor: PERSON, now: T_REFRESH })),
      { tenantSlug: "oasis-ai-cc", apply: true, content: [bySlug("vsl")], pageOnly: [], now: T_REFRESH },
    );
    assert.equal(outcomes(r).vsl, "conflict");
    let row = await pageRow(mem, "vsl");
    assert.deepEqual([JSON.parse(String(row.draft)).hero.headline, Number(row.draft_version), row.draft_updated_by], ["The person's own headline", 1, PERSON]);
    // An owner publishes it (Publish does not move the draft version).
    mem = await production();
    r = await seed.refreshOasisOfferDrafts(
      interleaved(mem, () => publishDraft(mem, { tenantId: OASIS, formId: IDS.vsl, draft: parseOfferPageDoc(olderVsl), draftVersion: 0, actor: PERSON, now: T_REFRESH })),
      { tenantSlug: "oasis-ai-cc", apply: true, content: [bySlug("vsl")], pageOnly: [], now: T_REFRESH },
    );
    assert.equal(outcomes(r).vsl, "conflict");
    row = await pageRow(mem, "vsl");
    assert.deepEqual([JSON.parse(String(row.draft)).hero.headline, Number(row.draft_version), Number(row.live)], ["An older headline", 0, 1], "the draft of a page that went live was overwritten");
    // A person's name lands on the row without a version change: still not ours to replace.
    mem = await production();
    r = await seed.refreshOasisOfferDrafts(
      interleaved(mem, () => mem.execute({ sql: "UPDATE form_offer_pages SET draft_updated_by = ? WHERE form_id = ?", args: [PERSON, IDS.vsl] })),
      { tenantSlug: "oasis-ai-cc", apply: true, content: [bySlug("vsl")], pageOnly: [], now: T_REFRESH },
    );
    assert.equal(outcomes(r).vsl, "conflict");
    assert.equal(JSON.parse(String((await pageRow(mem, "vsl")).draft)).hero.headline, "An older headline");
    // --include-edited is still compare-and-swap: the person saving community again (version 3 to 4) wins.
    mem = await production();
    const again = { ...personCommunity, hero: { ...personCommunity.hero, subheadline: "Saved again while the refresh ran." } };
    r = await seed.refreshOasisOfferDrafts(
      interleaved(mem, () => saveDraft(mem, { tenantId: OASIS, formId: IDS.community, draft: parseOfferPageDoc(again), expectedVersion: 3, claims: [], actor: PERSON, now: T_REFRESH })),
      { tenantSlug: "oasis-ai-cc", apply: true, content: [bySlug("community")], pageOnly: [], includeEdited: ["community"], now: T_REFRESH },
    );
    assert.equal(outcomes(r).community, "conflict");
    row = await pageRow(mem, "community");
    assert.deepEqual([JSON.parse(String(row.draft)).hero.subheadline, Number(row.draft_version)], ["Saved again while the refresh ran.", 4]);
  });

  await step("refresh: no form, no page, a template the page was not made with: nothing written", async () => {
    const mem = await production();
    const before = await snapshot(mem);
    const as = (slug: string) => ({ ...bySlug("protocol"), slug, form: { ...bySlug("protocol").form, slug } });
    const r = await seed.refreshOasisOfferDrafts(mem, {
      tenantSlug: "oasis-ai-cc",
      apply: true,
      content: [as("not-a-form"), as("no-page")],
      pageOnly: auditOnly({ ...auditDoc, template: "book_call" }),
      now: T_REFRESH,
    });
    assert.deepEqual(outcomes(r), { "not-a-form": "no_form", "no-page": "no_page", "ai-audit": "template_differs" });
    assert.match(r.pages[2].detail ?? "", /made as free_audit, the content is book_call/);
    assert.deepEqual(await snapshot(mem), before);
  });

  done("offer-pages-oasis-content");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
