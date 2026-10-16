/**
 * offers-confirm-publish.test.ts - Confirm & publish (/forms/publish): every
 * offer page's sign-offs on one screen, then Publish (CC 2026-10-16: one
 * screen, no manual video uploads).
 *
 * WHAT IS PINNED:
 *   - the gate is the builder's: a member who may not edit forms gets the
 *     builder's own sentence and nothing of the pages, an owner or admin gets
 *     the screen; the Offers screen links to it for the same people only;
 *   - the list holds every offer page of the workspace with its link, form
 *     On/Off, Draft/Live and what blocks it; a page with nothing to confirm
 *     reads "Ready to publish."; what only the builder can fix is named;
 *   - ticks go up in the builder's own draft-save shape: claim hashes, and a
 *     price / guarantee / video carrying the builder's pending confirmation,
 *     never a name or time the screen made up; the SERVER stamps the owner;
 *   - Publish runs approve (only for a video still in review), save, then
 *     publish the version the save returned, switching a switched-off form on
 *     in the SAME transaction as the publish; a page with anything left to
 *     tick is never sent to publish, nor one whose saved gate still lists a
 *     blocker; a conflict is reported, not retried; a failed save, a blocked
 *     page or a refused publish leaves the form off, and a publish whose
 *     answer is lost leaves the page and its form changed together or not at
 *     all (Codex on #637, twice);
 *   - an approval that went through before a later step failed is said out
 *     loud, never "nothing changed";
 *   - the proposed video: approved -> attached; in review -> approved through
 *     the Library's own route, only while still in review, then attached;
 *     approval refused, or a verdict reached in the Library since the screen
 *     loaded -> nothing saved, nothing attached, the form left off;
 *   - a gate warning shows before Publish, not only after it;
 *   - no proposal (suggested-videos.ts has none, or the map is empty) reads
 *     "No video proposed yet";
 *   - a Library cut tagged for a page (meta.offer_slug) is proposed ahead of
 *     the hand map, so a new offer needs no code: the newest by created_at,
 *     the hero layout's shape first; never another workspace's, another
 *     brand's, a rejected one or one with no video file.
 *
 * Real routes, real sessions, a local libSQL file (tests/_offer-pages-harness.ts).
 * The screen's request code (lib/offer-pages/confirm-publish.ts) runs with a
 * fetch that hands each request to the real route handler.
 *
 * Run: node --conditions=react-server --import tsx tests/offers-confirm-publish.test.ts
 */
import { OASIS, USERS, CONTACT_STEPS, ROOT, done, formRow, login, minimalDoc, offerRow, setupOfferDatabase, step, stubPath } from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

process.env.FOUNDERS_TENANT_IDS = OASIS;

// The client components the pages mount: markers, so a test reads the props a
// page hands them (tests/offer-pages-missing-table.test.ts does the same).
const marker = (name: string) => Object.assign(() => null, { displayName: name });
const ConfirmMarker = marker("ConfirmPublish");
const OfferBuilderMarker = marker("OfferBuilder");
const FormsListMarker = marker("FormsListClient");
stubPath(join(ROOT, "components", "offer-pages", "confirm", "ConfirmPublish.tsx"), { ConfirmPublish: ConfirmMarker });
stubPath(join(ROOT, "components", "offer-pages", "builder", "OfferBuilder.tsx"), { OfferBuilder: OfferBuilderMarker });
stubPath(join(ROOT, "components", "offer-pages", "builder", "TurnIntoOffer.tsx"), { TurnIntoOffer: marker("TurnIntoOffer") });
stubPath(join(ROOT, "components", "forms", "FormBuilderClient.tsx"), { FormBuilderClient: marker("FormBuilderClient") });
stubPath(join(ROOT, "components", "forms", "FormsListClient.tsx"), { FormsListClient: FormsListMarker });
stubPath(join(ROOT, "components", "forms", "SunBizFormsClient.tsx"), { SunBizFormsClient: marker("SunBizFormsClient") });

/** Runs right after a route reads a form (operator.ts editableForm), when a step sets it. */
let afterFormRead: ((formId: string) => Promise<void>) | null = null;

const F = {
  growth: "c0f10000-0000-4000-8000-000000000001",
  protocol: "c0f10000-0000-4000-8000-000000000002",
  command: "c0f10000-0000-4000-8000-000000000003",
  community: "c0f10000-0000-4000-8000-000000000004",
  vsl: "c0f10000-0000-4000-8000-000000000005",
  fleet: "c0f10000-0000-4000-8000-000000000006",
} as const;
const A_APPROVED = "a0000000-0000-4000-8000-0000000000a1";
const A_REVIEW = "a0000000-0000-4000-8000-0000000000b2";
const MEMBER = { id: "0e000000-0000-4000-8000-0000000000c9", email: "member@oasisai.work" };

/** An em dash and a right arrow, by code point (no wide character in this file). */
const WIDE_PUNCT = [String.fromCharCode(0x2014), String.fromCharCode(0x2192)];

const CLAIM_SUB = "Our clients see results in 30 days.";
const CAPTION_WARNING = "The top video has no captions. People watching without sound will only have the transcript.";
const PROTOCOL_DOC = minimalDoc({
  hero: { headline: "Systems that answer every lead", subheadline: CLAIM_SUB },
  sections: [
    { key: "pricing", tiers: [{ name: "Turnkey", price: "$2,500", cadence: "a month" }] },
    { key: "guarantee", body: "Full refund if we miss the launch date." },
  ],
});
const SUGGESTIONS = {
  protocol: { assetId: A_APPROVED, aspect: "9:16" as const },
  community: { assetId: A_REVIEW, aspect: "9:16" as const },
  command: { assetId: "a0000000-0000-4000-8000-0000000000ff", aspect: "16:9" as const },
};

/** The props of the first element of `type` in a tree (tests/forms-safe.test.ts propsOf). */
function find(node: unknown, type: unknown, seen = new Set<unknown>()): Record<string, unknown> | null {
  if (node === null || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = find(v, type, seen);
      if (hit) return hit;
    }
    return null;
  }
  const el = node as { $$typeof?: symbol; type?: unknown; props?: Record<string, unknown> };
  if (el.$$typeof && el.props) {
    if (el.type === type) return el.props;
    return find(el.props, type, seen);
  }
  for (const v of Object.values(node as Record<string, unknown>)) {
    const hit = find(v, type, seen);
    if (hit) return hit;
  }
  return null;
}

/** Every string and every href in a tree. */
function textOf(node: unknown, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (typeof node === "string") out.push(node);
  if (node === null || typeof node !== "object" || seen.has(node)) return out;
  seen.add(node);
  for (const v of Object.values(node as Record<string, unknown>)) textOf(v, out, seen);
  return out;
}

async function outcome(run: () => unknown): Promise<"404" | { tree: unknown }> {
  try {
    return { tree: await run() };
  } catch (err) {
    if (/NEXT_HTTP_ERROR_FALLBACK;404/.test((err as Error).message)) return "404";
    throw err;
  }
}

function render(scenarios: Record<string, unknown>): Record<string, string> {
  const childNodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions };
  if (!childNodeOptions) delete env.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ["--import", "tsx", join("tests", "offers-confirm-publish.render.ts")], {
    env,
    input: JSON.stringify(scenarios),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  assert.equal(child.status, 0, `render child failed:\n${child.stderr}`);
  return JSON.parse(child.stdout) as Record<string, string>;
}

async function main() {
  const db = await setupOfferDatabase();
  await db.executeMultiple(`
    CREATE TABLE marketing_review (id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))), tenant_id TEXT NOT NULL,
      asset_id TEXT NOT NULL, decision TEXT, note TEXT, reviewer TEXT, reviewer_agent TEXT, acted_on_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
  `);
  await db.batch(
    [
      formRow(F.growth, OASIS, "growth", "Growth", CONTACT_STEPS, {}, 1),
      offerRow({ formId: F.growth, tenantId: OASIS, draft: minimalDoc() }),
      formRow(F.protocol, OASIS, "protocol", "Protocol", CONTACT_STEPS, {}, 0),
      offerRow({ formId: F.protocol, tenantId: OASIS, draft: PROTOCOL_DOC }),
      // No headline anywhere: only the builder can fix that.
      formRow(F.command, OASIS, "command", "Command", CONTACT_STEPS, {}, 1),
      offerRow({ formId: F.command, tenantId: OASIS, draft: minimalDoc({ hero: {} }) }),
      formRow(F.community, OASIS, "community", "Community", CONTACT_STEPS, {}, 0),
      offerRow({ formId: F.community, tenantId: OASIS, draft: minimalDoc() }),
      formRow(F.vsl, OASIS, "vsl", "Start here", CONTACT_STEPS, {}, 1),
      offerRow({ formId: F.vsl, tenantId: OASIS, draft: minimalDoc(), published: minimalDoc(), live: 1 }),
      formRow(F.fleet, OASIS, "fleet", "Fleet", CONTACT_STEPS, {}, 1),
      offerRow({ formId: F.fleet, tenantId: OASIS, draft: minimalDoc({ hero: { headline: "Fleet audits", subheadline: "We cut costs by 20 percent." } }) }),
      {
        sql: `INSERT INTO marketing_asset (id, tenant_id, brand_slug, title, format, status, aspect, duration_s) VALUES
              (?, ?, 'oasis-ai', 'Protocol cut', 'video', 'approved', '9:16', 61.6),
              (?, ?, 'oasis-ai', 'Community cut', 'video', 'in_review', '9:16', 44)`,
        args: [A_APPROVED, OASIS, A_REVIEW, OASIS],
      },
      {
        sql: `INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path) VALUES
              ('m-ap-v', ?, ?, 'video', 'oasis/protocol.mp4'), ('m-ap-p', ?, ?, 'poster', 'oasis/protocol.jpg'),
              ('m-ap-c', ?, ?, 'caption', 'oasis/protocol.vtt'), ('m-rv-v', ?, ?, 'video', 'oasis/community.mp4'),
              ('m-rv-p', ?, ?, 'poster', 'oasis/community.jpg')`,
        args: [OASIS, A_APPROVED, OASIS, A_APPROVED, OASIS, A_APPROVED, OASIS, A_REVIEW, OASIS, A_REVIEW],
      },
      { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [MEMBER.id, MEMBER.email] },
      {
        sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, joined_at, updated_at)
              VALUES ('p-oasis-member', ?, ?, ?, 'member', 0, '2026-09-01T00:00:00Z', 'Member', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z')`,
        args: [MEMBER.id, MEMBER.email, OASIS],
      },
    ],
    "write",
  );

  // The routes' read of a form, with a hook after it: a step holds the publish
  // route right there to switch the form off between its read and its write.
  {
    const realOp = await import("../lib/offer-pages/operator");
    stubPath(join(ROOT, "lib", "offer-pages", "operator.ts"), {
      ...realOp,
      editableForm: async (...args: Parameters<typeof realOp.editableForm>) => {
        const form = await realOp.editableForm(...args);
        if (afterFormRead) await afterFormRead(args[2]);
        return form;
      },
    });
  }

  const { NextRequest } = await import("next/server");
  const access = await import("../lib/forms/access");
  const { loadConfirmList } = await import("../lib/offer-pages/confirm-list");
  const cp = await import("../lib/offer-pages/confirm-publish");
  const sv = await import("../lib/offer-pages/suggested-videos");
  const store = await import("../lib/offer-pages/store");
  const { pendingConfirmation } = await import("../components/offer-pages/builder/fields");
  const publishPage = (await import("../app/forms/publish/page")).default;
  const editPage = (await import("../app/forms/[id]/edit/page")).default;
  const formsPage = (await import("../app/forms/page")).default;
  const routes = {
    offer: await import("../app/api/forms/[id]/offer/route"),
    publish: await import("../app/api/forms/[id]/offer/publish/route"),
    form: await import("../app/api/forms/[id]/route"),
    asset: await import("../app/api/founders/marketing/assets/[id]/route"),
  };
  type ConfirmOffer = import("../lib/offer-pages/confirm-publish").ConfirmOffer;
  type Choices = import("../lib/offer-pages/confirm-publish").Choices;

  const signed: string[] = [];
  const sign = async (refs: Array<{ bucket: string; path: string }>, ttl: number) => {
    const m = new Map<string, string>();
    for (const r of refs) {
      signed.push(`${r.path}@${ttl}`);
      m.set(`${r.bucket}\n${r.path}`, `https://r2.test/${r.bucket}/${r.path}?ttl=${ttl}`);
    }
    return m;
  };
  const list = async (suggestions: Record<string, { assetId: string; aspect: "9:16" | "16:9" | "1:1" | "4:5" }> = SUGGESTIONS) => {
    const l = await loadConfirmList(db, { tenantId: OASIS, tenantSlug: "oasis-ai-cc", sign, suggestions });
    assert.equal(l.state, "ok");
    return (l as { offers: ConfirmOffer[] }).offers;
  };
  const offerOf = async (slug: string) => {
    const o = (await list()).find((x) => x.slug === slug);
    assert.ok(o, `no ${slug}`);
    return o;
  };
  const everything = (o: ConfirmOffer, video = true): Choices => ({
    claims: Object.fromEntries(o.claims.map((c) => [c.hash, true])),
    prices: Object.fromEntries(o.prices.map((p) => [p.index, true])),
    guarantee: !!o.guarantee,
    video,
  });

  // The screen's fetch, handed to the real routes, every request recorded.
  const calls: Array<{ method: string; url: string; body: Record<string, unknown> | undefined }> = [];
  let afterEach: ((url: string, method: string) => Promise<void>) | null = null;
  const p = (id: string) => ({ params: Promise.resolve({ id }) });
  const fetcher = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<Response> => {
    calls.push({ method: init.method, url, body: init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined });
    const req = new NextRequest(`http://localhost${url}`, { method: init.method, headers: init.headers, body: init.body });
    let m: RegExpExecArray | null;
    let res: Response;
    if ((m = /^\/api\/forms\/([^/]+)\/offer\/publish$/.exec(url)) && init.method === "POST") res = await routes.publish.POST(req, p(m[1]));
    else if ((m = /^\/api\/forms\/([^/]+)\/offer$/.exec(url)) && init.method === "PUT") res = await routes.offer.PUT(req, p(m[1]));
    else if ((m = /^\/api\/forms\/([^/]+)$/.exec(url)) && init.method === "PATCH") res = await routes.form.PATCH(req, p(m[1]));
    else if ((m = /^\/api\/founders\/marketing\/assets\/([^/]+)$/.exec(url)) && init.method === "PATCH") res = await routes.asset.PATCH(req, p(m[1]));
    else throw new Error(`the screen called a route it should not: ${init.method} ${url}`);
    if (afterEach) await afterEach(url, init.method);
    return res;
  };
  const deps = { fetch: fetcher, pending: pendingConfirmation };
  const shape = () => calls.map((c) => `${c.method} ${c.url}`);
  const rowOf = async (formId: string) => {
    const r = (await db.execute({ sql: "SELECT draft, draft_version, published, live, claims_confirmed FROM form_offer_pages WHERE form_id = ?", args: [formId] })).rows[0] as unknown as Record<string, unknown>;
    const f = (await db.execute({ sql: "SELECT enabled FROM forms WHERE id = ?", args: [formId] })).rows[0] as unknown as Record<string, unknown>;
    return {
      draft: JSON.parse(String(r.draft)),
      version: Number(r.draft_version),
      published: r.published == null ? null : JSON.parse(String(r.published)),
      live: Number(r.live) === 1,
      claims: JSON.parse(String(r.claims_confirmed ?? "[]")) as Array<{ hash: string; by: string }>,
      enabled: Number(f.enabled) === 1,
    };
  };
  const assetStatus = async (id: string) => String((await db.execute({ sql: "SELECT status FROM marketing_asset WHERE id = ?", args: [id] })).rows[0].status);

  console.log("offers-confirm-publish:");

  // -- The gate ---------------------------------------------------------------
  await step("a member who may not edit forms gets the builder's own refusal, and nothing of the pages", async () => {
    await login(MEMBER);
    const builder = await outcome(() => editPage({ params: Promise.resolve({ id: F.growth }) }));
    const screen = await outcome(() => publishPage());
    // A member opens Offers (the rail draws it) but may not change it: the
    // builder answers with its sentence, not a 404 (tests/forms-safe.test.ts).
    assert.ok(typeof builder === "object", "precondition: the builder 404s a member; pick a viewer it refuses in words");
    assert.ok(typeof screen === "object", String(screen));
    assert.equal(find(builder.tree, OfferBuilderMarker), null, "precondition: the builder refused this viewer");
    assert.ok(textOf(builder.tree).includes(access.FORMS_EDIT_REFUSED), "precondition: the builder's sentence");
    assert.equal(find(screen.tree, ConfirmMarker), null, "the screen was handed to a viewer the builder refuses");
    assert.ok(textOf(screen.tree).includes(access.FORMS_EDIT_REFUSED), "the screen does not say the builder's sentence");
    const offers = await outcome(() => formsPage());
    assert.ok(typeof offers === "object");
    assert.ok(!textOf(offers.tree).includes("/forms/publish"), "the Offers screen links a refused viewer to Confirm & publish");
  });

  await step("an owner and an admin get the screen with every offer page; the Offers screen links to it", async () => {
    for (const user of [USERS.cc, USERS.adon]) {
      await login(user);
      const screen = await outcome(() => publishPage());
      assert.ok(typeof screen === "object", String(screen));
      const props = find(screen.tree, ConfirmMarker) as { offers: ConfirmOffer[] } | null;
      assert.ok(props, "the screen is not mounted for an owner or admin");
      assert.deepEqual(props.offers.map((o) => o.slug).sort(), ["command", "community", "fleet", "growth", "protocol", "vsl"]);
      const offers = await outcome(() => formsPage());
      assert.ok(typeof offers === "object");
      assert.ok(textOf(offers.tree).includes("/forms/publish"), "no Confirm & publish link on the Offers screen");
    }
  });

  // -- The list ---------------------------------------------------------------
  const first = await list();
  await step("every offer: its short link, form On/Off, Draft/Live and what blocks it, per publishGate", () => {
    const by = Object.fromEntries(first.map((o) => [o.slug, o]));
    assert.equal(by.protocol.link, "/protocol", "the short public link (lib/offers/short-links.ts)");
    assert.equal(by.growth.link, "/f/oasis-ai-cc/growth");
    assert.equal(by.protocol.formEnabled, false);
    assert.equal(by.vsl.status, "live");
    assert.equal(by.protocol.status, "draft");
    assert.ok(by.protocol.blockers.some((b) => /Switch the form on/.test(b)), "the gate's form-off blocker");
    assert.ok(by.protocol.claims.some((c) => c.sentence === CLAIM_SUB && !c.confirmed), "the flagged sentence, unticked");
    assert.deepEqual(by.protocol.prices, [{ index: 0, name: "Turnkey", shown: "$2,500 a month", confirmed: false }]);
    assert.deepEqual(by.protocol.guarantee, { body: "Full refund if we miss the launch date.", confirmed: false });
    assert.deepEqual(by.protocol.unfixable, [], "everything protocol needs is a tick on this screen");
    assert.deepEqual(by.command.unfixable, ["Add a headline to the top of the page."], "a missing headline is the builder's to fix");
    assert.equal(cp.isReady(by.command, everything(by.command)), false, "every tick cannot publish a page only the builder can fix");
    assert.equal(cp.isReady(by.protocol, everything(by.protocol, false)), true, "the video tick is the owner's choice, never required");
    assert.equal(cp.isReady(by.protocol, cp.initialChoices(by.protocol)), false, "nothing is ticked for the owner");
    assert.equal(cp.isReady(by.growth, cp.initialChoices(by.growth)), true, "a page with nothing to confirm is ready");
    assert.deepEqual(by.growth.blockers, []);
  });

  await step("the proposed video resolves from its Library asset: approved, in review, or not there", () => {
    const by = Object.fromEntries(first.map((o) => [o.slug, o]));
    const pr = by.protocol.proposal;
    assert.equal(pr.state, "ready");
    if (pr.state !== "ready") return;
    assert.deepEqual(pr.ref, {
      source: "library",
      asset_id: A_APPROVED,
      video_media_id: "m-ap-v",
      poster_media_id: "m-ap-p",
      caption_media_id: "m-ap-c",
      aspect: "9:16",
      duration_s: 62,
    });
    assert.equal(pr.needsApproval, false);
    assert.match(String(pr.videoUrl), /protocol\.mp4\?ttl=1800$/, "signed for half an hour, as the builder's preview signs");
    const rv = by.community.proposal;
    assert.equal(rv.state === "ready" && rv.needsApproval, true, "an asset in review is offered with the approve tick");
    assert.equal(by.command.proposal.state, "missing");
    assert.equal(by.vsl.proposal.state, "none");
    assert.equal(by.growth.proposal.state, "none");
  });

  await step("suggested-videos.ts: OASIS's own workspace only, own keys only; vsl has none", () => {
    assert.equal(sv.suggestedHeroVideo("oasis-ai-cc", "vsl"), null);
    assert.equal(sv.suggestedHeroVideo("oasis-ai-cc", "constructor"), null);
    assert.equal(sv.suggestedHeroVideo("client-a", "protocol"), null, "another workspace's form of the same slug gets nothing");
    assert.deepEqual(sv.suggestedHeroVideo("oasis-ai-cc", "protocol"), { assetId: "d216493c-002b-4ce4-9a0e-846f5895e749", aspect: "9:16" });
    assert.deepEqual(sv.suggestedHeroVideo("oasis-ai-cc", "fleet"), { assetId: "20a179c9-b263-45c9-b2c3-e83656d09319", aspect: "9:16" }, "FLEET's old pack film is proposed again");
    assert.deepEqual(Object.keys(sv.SUGGESTED_HERO_VIDEOS).sort(), ["ai-audit", "command", "community", "fleet", "protocol"]);
  });

  const empty = await list({});
  await step("the screen draws every offer with its blockers, Ready for a page with nothing to confirm, and No video proposed yet", () => {
    const html = render({
      withProposals: { offers: first },
      noProposals: { offers: empty },
      withWarning: { offers: first.map((o) => (o.slug === "growth" ? { ...o, warnings: [CAPTION_WARNING] } : o)) },
    });
    const w = html.withWarning;
    assert.doesNotMatch(w, /^RENDER FAILED/, w.slice(0, 400));
    assert.ok(w.includes("Worth a look before publishing") && w.includes(CAPTION_WARNING), "a gate warning is not shown before Publish");
    assert.ok(w.includes("Ready to publish."), "a warning blocks nothing");
    const h = html.withProposals;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 400));
    for (const name of ["Growth", "Protocol", "Command", "Community", "Start here", "Fleet"]) assert.ok(h.includes(`>${name}</h2>`), `${name} is missing`);
    assert.ok(h.includes("Add a headline to the top of the page."), "the builder-only blocker is not shown");
    assert.ok(h.includes(CLAIM_SUB), "the flagged sentence is not shown");
    assert.ok(h.includes("True, and we can back it"), "the claim tick's words");
    assert.ok(h.includes("I confirm this price is right. Turnkey: $2,500 a month"), "the price tick");
    assert.ok(h.includes("Ready to publish."), "a page with nothing to confirm does not read ready");
    assert.ok(h.includes("We own this video and may use it here."), "the approved video's tick");
    assert.ok(h.includes("Approve this video and confirm we own it."), "the in-review video's tick");
    assert.ok(h.includes("Switch the form on"), "the form-off line");
    assert.ok(h.includes(">/protocol<"), "the short link");
    assert.ok(!/<input[^>]*checked/.test(h), "a box is ticked that no owner ticked");
    assert.ok(!/<video/.test(h), "the video loads before the tap");
    assert.ok(!h.includes("Worth a look before publishing"), "a warnings heading with no warnings");
    assert.ok(/aria-label="Play video: Protocol cut"/.test(h), "no play button for the proposal");
    assert.ok(!WIDE_PUNCT.some((ch) => h.includes(ch)), "an em dash or an arrow on the screen");
    const n = html.noProposals;
    assert.doesNotMatch(n, /^RENDER FAILED/, n.slice(0, 400));
    assert.equal((n.match(/No video proposed yet/g) || []).length, 6, "every page without a proposal says so");
    assert.ok(!n.includes("Play video"), "a player with nothing proposed");
  });

  // -- Ticks, in the builder's draft-save shape -------------------------------
  await step("ticks go up as the builder sends them: claim hashes, pending confirmations, never an owner the screen chose", () => {
    const o = first.find((x) => x.slug === "protocol")!;
    const body = cp.buildSaveBody(o, everything(o), pendingConfirmation);
    assert.deepEqual(Object.keys(body).sort(), ["confirm_claims", "draft", "unconfirm_claims", "version"]);
    assert.equal(body.version, o.version);
    assert.deepEqual(body.confirm_claims.sort(), o.claims.map((c) => c.hash).sort());
    assert.deepEqual(body.unconfirm_claims, []);
    const tier = (body.draft.sections.find((s) => s.key === "pricing") as { tiers: Array<{ confirmed?: { by: string } }> }).tiers[0];
    assert.equal(tier.confirmed?.by, "pending");
    const g = body.draft.sections.find((s) => s.key === "guarantee") as { confirmed?: { by: string } };
    assert.equal(g.confirmed?.by, "pending");
    const v = body.draft.hero.video as { source: string; asset_id: string; rights: { by: string } };
    assert.equal(v.source, "library");
    assert.equal(v.asset_id, A_APPROVED);
    assert.equal(v.rights.by, "pending", "the screen named who owns the video");
    // Nothing ticked: nothing changes but the version sent back.
    const none = cp.buildSaveBody(o, cp.initialChoices(o), pendingConfirmation);
    assert.deepEqual(none.draft, o.draft);
    assert.deepEqual([none.confirm_claims, none.unconfirm_claims], [[], []]);
  });

  // -- Publish ----------------------------------------------------------------
  await step("a page with anything left to tick is never sent anywhere", async () => {
    await login(USERS.cc);
    calls.length = 0;
    const o = await offerOf("protocol");
    const some = { ...everything(o), guarantee: false };
    const r = await cp.publishOffer(o, some, deps);
    assert.equal(r.kind, "blocked");
    assert.deepEqual(shape(), [], "a request went out for a page that still needs a tick");
    assert.equal((await rowOf(F.protocol)).enabled, false, "its form was switched on");
  });

  await step("a page whose saved gate still lists a blocker is saved but never published", async () => {
    await login(USERS.cc);
    calls.length = 0;
    const o = await offerOf("fleet");
    assert.ok(o.claims.length > 0, "precondition: fleet flags a sentence");
    // A screen that missed the sentence (claims dropped) thinks it is ready.
    const stale: ConfirmOffer = { ...o, claims: [] };
    const r = await cp.publishOffer(stale, everything(stale), deps);
    assert.equal(r.kind, "blocked", JSON.stringify(r));
    assert.deepEqual(shape(), [`PUT /api/forms/${F.fleet}/offer`], "the publish route was called for a blocked page");
    assert.equal((await rowOf(F.fleet)).live, false);
  });

  await step("a save that fails (someone saved first) leaves the form off and sends nothing else", async () => {
    await login(USERS.cc);
    const o = await offerOf("protocol");
    await db.execute({ sql: "UPDATE form_offer_pages SET draft_version = draft_version + 1 WHERE form_id = ?", args: [F.protocol] });
    calls.length = 0;
    const r = await cp.publishOffer(o, everything(o), deps);
    assert.equal(r.kind, "conflict", JSON.stringify(r));
    assert.deepEqual(shape(), [`PUT /api/forms/${F.protocol}/offer`], "the form was switched on before the save went through");
    assert.equal((await rowOf(F.protocol)).enabled, false);
  });

  await step("a saved gate that lists anything besides the switched-off form: saved, the form left off, never published", async () => {
    await login(USERS.cc);
    calls.length = 0;
    const o = await offerOf("protocol");
    // A screen that missed the flagged sentence thinks the page is ready.
    const stale: ConfirmOffer = { ...o, claims: [] };
    const r = await cp.publishOffer(stale, everything(stale, false), deps);
    assert.equal(r.kind, "blocked", JSON.stringify(r));
    const blockers = (r as { blockers: string[] }).blockers;
    assert.ok(blockers.length > 0 && !blockers.some((b) => /Switch the form on/.test(b)), "Publish lists the form it would switch on itself");
    assert.deepEqual(shape(), [`PUT /api/forms/${F.protocol}/offer`], "the form was switched on for a page that cannot go live");
    const row = await rowOf(F.protocol);
    assert.equal(row.enabled, false);
    assert.equal(row.live, false);
  });

  await step("the publish route never switches a form on for a page its gate refuses", async () => {
    await login(USERS.cc);
    const o = await offerOf("protocol");
    assert.ok(o.claims.some((c) => !c.confirmed), "precondition: protocol has an unticked sentence");
    const res = await routes.publish.POST(
      new NextRequest(`http://localhost/api/forms/${F.protocol}/offer/publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: o.version, enable_form: true }),
      }),
      p(F.protocol),
    );
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string; blockers: string[] };
    assert.equal(body.error, "publish_blocked");
    assert.ok(!body.blockers.some((b) => /Switch the form on/.test(b)), "enable_form still lists the switched-off form");
    const row = await rowOf(F.protocol);
    assert.equal(row.enabled, false);
    assert.equal(row.live, false);
  });

  await step("the store switches the form on only with a publish it actually made (a version that moved matches nothing)", async () => {
    const before = await rowOf(F.protocol);
    const lost = await store.publishDraft(db, {
      tenantId: OASIS,
      formId: F.protocol,
      draft: before.draft,
      draftVersion: before.version + 7,
      actor: USERS.cc.id,
      now: new Date().toISOString(),
      enableForm: true,
    });
    assert.equal(lost.ok, false);
    const after = await rowOf(F.protocol);
    assert.equal(after.enabled, false, "the form went on for a publish that matched no row");
    assert.equal(after.live, false);
  });

  await step("a refused publish leaves the form off: the form goes on in the same write as the page", async () => {
    await login(USERS.cc);
    const o = await offerOf("protocol");
    calls.length = 0;
    afterEach = async (url, method) => {
      // An edit lands just after the save, so the publish is a conflict.
      if (method === "PUT") await db.execute({ sql: "UPDATE form_offer_pages SET draft_version = draft_version + 1 WHERE form_id = ?", args: [F.protocol] });
    };
    try {
      const r = await cp.publishOffer(o, everything(o, false), deps);
      assert.equal(r.kind, "conflict", JSON.stringify(r));
      assert.deepEqual(shape(), [`PUT /api/forms/${F.protocol}/offer`, `POST /api/forms/${F.protocol}/offer/publish`]);
      assert.equal(calls[1].body!.enable_form, true, "Publish did not ask to switch the form on");
      const row = await rowOf(F.protocol);
      assert.equal(row.live, false);
      assert.equal(row.enabled, false, "a page that did not go live left its form on");
    } finally {
      afterEach = null;
    }
  });

  await step("a publish whose answer is lost: the page went live with its form on, and the screen says to reload", async () => {
    await login(USERS.cc);
    const o = await offerOf("community");
    assert.equal(o.formEnabled, false, "precondition: community's form is off");
    calls.length = 0;
    // The real route runs and commits; its answer never reaches the screen.
    const lossy = {
      pending: pendingConfirmation,
      fetch: async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
        const res = await fetcher(url, init);
        if (url.endsWith("/offer/publish")) throw new Error("connection reset");
        return res;
      },
    };
    const r = await cp.publishOffer(o, everything(o, false), lossy);
    assert.equal(r.kind, "error", JSON.stringify(r));
    assert.equal((r as { message: string }).message, cp.NO_ANSWER_MESSAGE);
    assert.deepEqual(shape(), [`PUT /api/forms/${F.community}/offer`, `POST /api/forms/${F.community}/offer/publish`]);
    const row = await rowOf(F.community);
    assert.equal(row.live, true);
    assert.equal(row.enabled, true, "the page went live with its form off");
  });

  await step("an approved proposal: save, then publish the version the save returned with the form switched on in the same write; the SERVER stamps the owner", async () => {
    await login(USERS.cc);
    calls.length = 0;
    const o = await offerOf("protocol");
    const r = await cp.publishOffer(o, everything(o), deps);
    assert.equal(r.kind, "published", JSON.stringify(r));
    assert.deepEqual(shape(), [`PUT /api/forms/${F.protocol}/offer`, `POST /api/forms/${F.protocol}/offer/publish`]);
    assert.equal(calls[1].body!.enable_form, true, "the switched-off form is not switched on with the publish");
    assert.equal((calls[0].body!.draft as { hero: { video: { rights: { by: string } } } }).hero.video.rights.by, "pending");
    const row = await rowOf(F.protocol);
    assert.equal(calls[1].body!.version, row.version, "published a version other than the one just saved");
    assert.equal(row.version, o.version + 1);
    assert.equal(row.live, true);
    assert.equal(row.enabled, true);
    const live = row.published as { hero: { video: { asset_id: string; video_media_id: string; rights: { by: string; at: string } } }; sections: Array<{ key: string; tiers?: Array<{ confirmed: { by: string } }>; confirmed?: { by: string } }> };
    assert.equal(live.hero.video.asset_id, A_APPROVED);
    assert.equal(live.hero.video.video_media_id, "m-ap-v");
    assert.equal(live.hero.video.rights.by, USERS.cc.id, "the rights are not the saving owner's");
    assert.equal(live.sections.find((s) => s.key === "pricing")!.tiers![0].confirmed.by, USERS.cc.id);
    assert.equal(live.sections.find((s) => s.key === "guarantee")!.confirmed!.by, USERS.cc.id);
    assert.ok(row.claims.length >= 1 && row.claims.every((t) => t.by === USERS.cc.id), "the claim ticks are not the saving owner's");
    assert.ok(!calls.some((c) => c.url.includes("/founders/")), "an approved video was approved again");
  });

  await step("approval refused: nothing saved, nothing attached, the form left off", async () => {
    await login(USERS.cc);
    process.env.FOUNDERS_TENANT_IDS = "aaaaaaaa-0000-4000-8000-00000000000a";
    try {
      const o = await offerOf("community");
      const before = await rowOf(F.community);
      for (const run of [cp.publishOffer, cp.saveOffer]) {
        calls.length = 0;
        const r = await run(o, everything(o), deps);
        assert.equal(r.kind, "approve_failed", JSON.stringify(r));
        assert.deepEqual(shape(), [`PATCH /api/founders/marketing/assets/${A_REVIEW}`]);
        assert.deepEqual(calls[0].body, { status: "approved", from: "in_review" }, "the Library's own verdict body, only while in review");
      }
      const after = await rowOf(F.community);
      assert.deepEqual(after, before, "the page or its form changed after a refused approval");
      assert.equal(await assetStatus(A_REVIEW), "in_review");
    } finally {
      process.env.FOUNDERS_TENANT_IDS = OASIS;
    }
  });

  await step("a verdict reached in the Library since the screen loaded stands: nothing approved, saved or switched on", async () => {
    await login(USERS.cc);
    const o = await offerOf("community");
    const before = await rowOf(F.community);
    await db.execute({ sql: "UPDATE marketing_asset SET status = 'rejected' WHERE id = ?", args: [A_REVIEW] });
    try {
      calls.length = 0;
      const r = await cp.publishOffer(o, everything(o), deps);
      assert.equal(r.kind, "approve_failed", JSON.stringify(r));
      assert.match((r as { message: string }).message, /changed in the Library.*rejected now/);
      assert.deepEqual(shape(), [`PATCH /api/founders/marketing/assets/${A_REVIEW}`]);
      assert.equal(await assetStatus(A_REVIEW), "rejected", "the rejection was rewritten to approved");
      assert.deepEqual(await rowOf(F.community), before, "the page or its form changed");
      const n = (await db.execute({ sql: "SELECT COUNT(*) AS n FROM marketing_review WHERE asset_id = ?", args: [A_REVIEW] })).rows[0].n;
      assert.equal(Number(n), 0, "a review was recorded for an approval that did not happen");
      // A `from` that is not a status is refused, and changes nothing.
      const bad = await routes.asset.PATCH(
        new NextRequest(`http://localhost/api/founders/marketing/assets/${A_REVIEW}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "approved", from: "nonsense" }),
        }),
        p(A_REVIEW),
      );
      assert.equal(bad.status, 400);
      assert.equal(await assetStatus(A_REVIEW), "rejected");
    } finally {
      await db.execute({ sql: "UPDATE marketing_asset SET status = 'in_review' WHERE id = ?", args: [A_REVIEW] });
    }
  });

  await step("an approval that went through before a failed save is said out loud, never 'nothing changed'", async () => {
    await login(USERS.cc);
    const o = await offerOf("community");
    await db.execute({ sql: "UPDATE form_offer_pages SET draft_version = draft_version + 1 WHERE form_id = ?", args: [F.community] });
    try {
      calls.length = 0;
      const r = await cp.publishOffer(o, everything(o), deps);
      assert.equal(r.kind, "conflict", JSON.stringify(r));
      assert.deepEqual(r.notes, [cp.APPROVED_NOTE]);
      assert.ok(cp.outcomeWords(r).lines.includes(cp.APPROVED_NOTE), "the card does not say the video was approved");
      assert.deepEqual(shape(), [`PATCH /api/founders/marketing/assets/${A_REVIEW}`, `PUT /api/forms/${F.community}/offer`]);
      assert.equal(await assetStatus(A_REVIEW), "approved");
    } finally {
      // Back to "in review" for the step that approves it for real.
      await db.execute({ sql: "UPDATE marketing_asset SET status = 'in_review' WHERE id = ?", args: [A_REVIEW] });
      await db.execute({ sql: "DELETE FROM marketing_review WHERE asset_id = ?", args: [A_REVIEW] });
    }
  });

  await step("approved or published in the Library since the screen loaded: nothing to approve, the video is attached as it is", async () => {
    const o = await offerOf("community");
    // "scheduled" stops: the offer save accepts only an approved or published Library video (Codex on #637).
    const cases = [
      ["approved", "saved"],
      ["published", "saved"],
      ["scheduled", "approve_failed"],
      ["draft", "approve_failed"],
      ["archived", "approve_failed"],
    ] as const;
    for (const [now, want] of cases) {
      const seen: string[] = [];
      const stub = {
        pending: pendingConfirmation,
        fetch: async (url: string, init: { method: string }) => {
          seen.push(`${init.method} ${url}`);
          if (url.includes("/founders/")) return new Response(JSON.stringify({ ok: false, error: "status_changed", status: now }), { status: 409 });
          return new Response(JSON.stringify({ ok: true, offer: { version: o.version + 1, gate: { blockers: [] } } }), { status: 200 });
        },
      };
      const r = await cp.saveOffer(o, everything(o), stub);
      assert.equal(r.kind, want, `${now}: ${JSON.stringify(r)}`);
      const asset = `PATCH /api/founders/marketing/assets/${A_REVIEW}`;
      assert.deepEqual(seen, want === "saved" ? [asset, `PUT /api/forms/${F.community}/offer`] : [asset], now);
    }
  });

  await step("a proposal in review: approved through the Library's route first, then save, then publish", async () => {
    await login(USERS.cc);
    calls.length = 0;
    const o = await offerOf("community");
    const r = await cp.publishOffer(o, everything(o), deps);
    assert.equal(r.kind, "published", JSON.stringify(r));
    assert.deepEqual(shape(), [
      `PATCH /api/founders/marketing/assets/${A_REVIEW}`,
      `PUT /api/forms/${F.community}/offer`,
      `POST /api/forms/${F.community}/offer/publish`,
    ]);
    assert.deepEqual(calls[0].body, { status: "approved", from: "in_review" });
    assert.equal(await assetStatus(A_REVIEW), "approved");
    const review = (await db.execute({ sql: "SELECT decision, acted_on_at FROM marketing_review WHERE asset_id = ?", args: [A_REVIEW] })).rows;
    assert.equal(review.length, 1, "the Library's review record is missing");
    assert.equal(String(review[0].decision), "approve");
    const row = await rowOf(F.community);
    assert.equal(row.live, true);
    assert.equal((row.published as { hero: { video: { asset_id: string; rights: { by: string } } } }).hero.video.asset_id, A_REVIEW);
    assert.equal((row.published as { hero: { video: { rights: { by: string } } } }).hero.video.rights.by, USERS.cc.id);
  });

  await step("someone else saved first: the conflict is reported and nothing is published", async () => {
    await login(USERS.cc);
    const o = await offerOf("growth");
    await db.execute({ sql: "UPDATE form_offer_pages SET draft_version = draft_version + 1 WHERE form_id = ?", args: [F.growth] });
    calls.length = 0;
    const r = await cp.publishOffer(o, cp.initialChoices(o), deps);
    assert.equal(r.kind, "conflict");
    assert.equal((r as { message: string }).message, cp.CONFLICT_MESSAGE);
    assert.match(cp.CONFLICT_MESSAGE, /Reload/);
    assert.deepEqual(shape(), [`PUT /api/forms/${F.growth}/offer`]);
    assert.equal((await rowOf(F.growth)).live, false);
  });

  await step("an edit that lands between the save and the publish is a conflict, never published unseen", async () => {
    await login(USERS.cc);
    const o = await offerOf("growth");
    calls.length = 0;
    afterEach = async (url, method) => {
      if (method === "PUT") await db.execute({ sql: "UPDATE form_offer_pages SET draft_version = draft_version + 1 WHERE form_id = ?", args: [F.growth] });
    };
    try {
      const r = await cp.publishOffer(o, cp.initialChoices(o), deps);
      assert.equal(r.kind, "conflict", JSON.stringify(r));
      assert.deepEqual(shape(), [`PUT /api/forms/${F.growth}/offer`, `POST /api/forms/${F.growth}/offer/publish`]);
      assert.equal((await rowOf(F.growth)).live, false);
    } finally {
      afterEach = null;
    }
  });

  await step("a form switched off between the save and the publish: the page still goes live with its form on", async () => {
    await login(USERS.cc);
    const o = await offerOf("growth");
    assert.equal(o.formEnabled, true, "precondition: growth's form is on");
    calls.length = 0;
    afterEach = async (_url, method) => {
      if (method === "PUT") await db.execute({ sql: "UPDATE forms SET enabled = 0 WHERE id = ?", args: [F.growth] });
    };
    try {
      const r = await cp.publishOffer(o, cp.initialChoices(o), deps);
      assert.equal(r.kind, "published", JSON.stringify(r));
      assert.equal(calls[1].body!.enable_form, true, "Publish trusted a stale read of the form");
      const row = await rowOf(F.growth);
      assert.equal(row.live, true);
      assert.equal(row.enabled, true, "the page went live with its form off");
    } finally {
      afterEach = null;
    }
  });

  await step("a form switched off AFTER the publish route read it as on: the page still goes live with its form on", async () => {
    await login(USERS.cc);
    const o = await offerOf("growth");
    assert.equal(o.formEnabled, true, "precondition: growth's form is on");
    // Hold the publish route right after its read of the form (operator.ts
    // editableForm) and switch the form off there, before the publish writes.
    let held = false;
    afterFormRead = async (formId) => {
      if (held || formId !== F.growth || !calls.some((c) => c.url.endsWith("/offer/publish"))) return;
      held = true;
      await db.execute({ sql: "UPDATE forms SET enabled = 0 WHERE id = ?", args: [F.growth] });
    };
    try {
      calls.length = 0;
      const r = await cp.publishOffer(o, cp.initialChoices(o), deps);
      assert.equal(r.kind, "published", JSON.stringify(r));
      assert.equal(held, true, "precondition: the form was switched off inside the publish route");
      const row = await rowOf(F.growth);
      assert.equal(row.live, true);
      assert.equal(row.enabled, true, "the publish trusted the route's own stale read of the form");
    } finally {
      afterFormRead = null;
    }
  });

  await step("after publishing, the screen reads the pages back as live, and a live page has nothing to publish", async () => {
    const again = await list();
    const by = Object.fromEntries(again.map((o) => [o.slug, o]));
    assert.equal(by.protocol.status, "live");
    assert.equal(by.protocol.formEnabled, true);
    assert.equal(by.protocol.proposal.state === "ready" && by.protocol.proposal.onPage, true, "the attached video is not read as on the page");
    assert.equal(cp.needsPublish(by.protocol, cp.initialChoices(by.protocol)), false);
    assert.equal(cp.isReady(by.protocol, cp.initialChoices(by.protocol)), true, "a confirmed page reads as needing ticks again");
    const words = cp.outcomeWords({ kind: "published", publishedVersion: 1, warnings: [] });
    assert.equal(words.tone, "ok");
    assert.ok(!WIDE_PUNCT.some((ch) => JSON.stringify(cp.outcomeWords({ kind: "blocked", blockers: ["x"] })).includes(ch)), "an em dash or arrow in the words");
  });

  await step("a Library cut tagged for a page is proposed with no code: newest by created_at, the layout's shape first, ahead of the hand map", async () => {
    const T = (n: number) => `ta000000-0000-4000-8000-00000000000${n}`;
    // [id, tenant, brand, slug tag (or raw meta), aspect, status, created_at, updated_at, has a video file]
    const cuts: Array<[string, string, string, string, string, string, string, string, boolean]> = [
      [T(1), OASIS, "oasis-ai", '{"offer_slug":"growth"}', "16:9", "approved", "2026-10-10T00:00:00Z", "2026-10-16T09:00:00Z", true],
      [T(2), OASIS, "oasis-ai", '{"offer_slug":"growth"}', "9:16", "in_review", "2026-10-12T00:00:00Z", "2026-10-12T00:00:00Z", true],
      [T(3), OASIS, "oasis-ai", '{"offer_slug":"growth","other":1}', "9:16", "approved", "2026-10-14T00:00:00Z", "2026-10-14T00:00:00Z", true],
      [T(4), OASIS, "oasis-ai", '{"offer_slug":"growth"}', "9:16", "rejected", "2026-10-15T00:00:00Z", "2026-10-15T00:00:00Z", true],
      [T(5), OASIS, "oasis-ai", '{"offer_slug":"growth"}', "9:16", "approved", "2026-10-15T01:00:00Z", "2026-10-15T01:00:00Z", false],
      [T(6), "aaaaaaaa-0000-4000-8000-00000000000a", "oasis-ai", '{"offer_slug":"growth"}', "9:16", "approved", "2026-10-15T02:00:00Z", "2026-10-15T02:00:00Z", true],
      [T(7), OASIS, "arthrisil", '{"offer_slug":"growth"}', "9:16", "approved", "2026-10-15T03:00:00Z", "2026-10-15T03:00:00Z", true],
      [T(8), OASIS, "oasis-ai", "not json at all", "9:16", "approved", "2026-10-15T04:00:00Z", "2026-10-15T04:00:00Z", true],
      [T(9), OASIS, "oasis-ai", '{"offer_slug":"protocol"}', "9:16", "approved", "2026-10-15T05:00:00Z", "2026-10-15T05:00:00Z", true],
      // The newest growth cut is wide: a page with no layout (drawn split) still gets the tall T3.
      ["ta000000-0000-4000-8000-000000000010", OASIS, "oasis-ai", '{"offer_slug":"growth"}', "16:9", "approved", "2026-10-15T06:00:00Z", "2026-10-15T06:00:00Z", true],
      // A shape no page draws is never proposed.
      ["ta000000-0000-4000-8000-000000000011", OASIS, "oasis-ai", '{"offer_slug":"growth"}', "21:9", "approved", "2026-10-15T07:00:00Z", "2026-10-15T07:00:00Z", true],
      // Thirty newer tall cuts and one older wide one: a stacked page still gets the wide one.
      ...Array.from({ length: 30 }, (_, i): [string, string, string, string, string, string, string, string, boolean] => [
        `tb000000-0000-4000-8000-0000000000${String(i).padStart(2, "0")}`,
        OASIS,
        "oasis-ai",
        '{"offer_slug":"many"}',
        "9:16",
        "approved",
        `2026-10-15T10:${String(i).padStart(2, "0")}:00Z`,
        `2026-10-15T10:${String(i).padStart(2, "0")}:00Z`,
        true,
      ]),
      ["tc000000-0000-4000-8000-000000000001", OASIS, "oasis-ai", '{"offer_slug":"many"}', "16:9", "approved", "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z", true],
    ];
    await db.batch(
      cuts.flatMap(([id, tenant, brand, meta, aspect, status, created, updated, file]) => [
        {
          sql: `INSERT INTO marketing_asset (id, tenant_id, brand_slug, title, format, status, aspect, duration_s, created_at, updated_at, meta)
                VALUES (?, ?, ?, ?, 'video', ?, ?, 30, ?, ?, ?)`,
          args: [id, tenant, brand, `Cut ${id.slice(-1)}`, status, aspect, created, updated, meta],
        },
        ...(file ? [{ sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path) VALUES (?, ?, ?, 'video', ?)", args: [`${id}-v`, tenant, id, `oasis/${id}.mp4`] }] : []),
      ]),
      "write",
    );
    const listed = await import("../lib/offer-pages/confirm-list");
    const tagged = (formSlug: string, layout?: "split" | "stacked" | "centered") => listed.taggedHeroVideo(db, { tenantId: OASIS, formSlug, layout });
    // Split, and no layout at all (drawn split): the newest usable TALL cut (T4 rejected, T5 has no
    // file, the newer wide T10 is the wrong shape; T1's newer updated_at counts for nothing).
    assert.deepEqual(await tagged("growth"), { assetId: T(3), aspect: "9:16" }, "a page with no layout is not treated as split");
    assert.deepEqual(await tagged("growth", "split"), { assetId: T(3), aspect: "9:16" });
    // Stacked: the newest wide cut. Centered: the newest of any shape the page can draw (never the 21:9).
    assert.deepEqual(await tagged("growth", "stacked"), { assetId: "ta000000-0000-4000-8000-000000000010", aspect: "16:9" });
    assert.deepEqual(await tagged("growth", "centered"), { assetId: "ta000000-0000-4000-8000-000000000010", aspect: "16:9" });
    // However many newer cuts of the other shape there are.
    assert.deepEqual(await tagged("many", "stacked"), { assetId: "tc000000-0000-4000-8000-000000000001", aspect: "16:9" }, "newer tall cuts pushed the wide one out");
    assert.deepEqual(await tagged("many", "split"), { assetId: "tb000000-0000-4000-8000-000000000029", aspect: "9:16" });
    assert.equal(await tagged("nothing-tagged"), null);
    // A client workspace never gets a Library proposal, even with a cut of its own tagged (T6): the
    // Library is OASIS's only, and its approval route is founders-only (Codex on #641).
    assert.equal(await listed.taggedHeroVideo(db, { tenantId: "aaaaaaaa-0000-4000-8000-00000000000a", formSlug: "growth", layout: undefined }), null);
    // Through the list: growth has no hand-map entry and gets its tagged cut; a tag beats protocol's map entry.
    const by = Object.fromEntries((await list({})).map((o) => [o.slug, o]));
    const g = by.growth.proposal;
    assert.equal(g.state, "ready", JSON.stringify(g));
    assert.equal(g.state === "ready" && g.assetId, T(3));
    const pr = (await list()).find((o) => o.slug === "protocol")!.proposal;
    assert.equal(pr.state === "ready" ? pr.assetId : pr.state, T(9), "the hand map beat a tagged cut");
    // Command: tagged nowhere, so the hand map still answers (its asset is not in this Library: missing).
    assert.equal(by.command.proposal.state, "none", "with an empty map and no tag, nothing is proposed");
    assert.equal((await list()).find((o) => o.slug === "command")!.proposal.state, "missing");
  });

  done("offers-confirm-publish");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
