/**
 * offer-pages-claims.test.ts - the claims gate (lib/offer-pages/claims.ts and
 * POST /api/forms/[id]/offer/publish), design section 3.5.
 *
 * WHAT IS PINNED:
 *   1. The linter flags money, numbers (digits and number words), percentages,
 *      multipliers ("3x") and the words clients, results, guarantee(d),
 *      proven, revenue, booked, refund, money back, risk-free, ROI, profit,
 *      savings; a plain sentence passes.
 *   2. A tick is stored under the sentence's sha256: editing the sentence
 *      clears it. A tick can only be added for a sentence the draft flags.
 *   3. Confirmations are stamped by the server: a new one gets the saving
 *      owner and the time, whatever the browser sent; one already on record
 *      for the same content is kept, even when the browser echoes it as
 *      "pending" again (saving twice never moves "confirmed at" forward, and a
 *      live page saved with nothing changed stays Live); editing the confirmed
 *      content re-stamps it.
 *   4. Publish answers 409 with a plain list of what blocks it, until every
 *      flagged sentence is ticked and the guarantee's terms are confirmed;
 *      then it publishes exactly the checked draft, without the brief. An edit
 *      after the tick blocks it again.
 *   5. Someone who may not edit forms gets 403 from every offer write, and the
 *      table is unchanged.
 *
 * Real routes, real signed sessions, a local libSQL file with bravo__203
 * applied (tests/_offer-pages-harness.ts).
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-claims.test.ts
 */
import { OASIS, USERS, done, formRow, login, minimalDoc, offerRow, setupOfferDatabase, step, CONTACT_STEPS } from "./_offer-pages-harness";
import assert from "node:assert/strict";

const FORM = "f0c1a100-0000-4000-8000-000000000001";
const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };

async function main() {
  const db = await setupOfferDatabase();
  const claims = await import("../lib/offer-pages/claims");
  const { parseOfferPageDoc } = await import("../lib/offer-pages/types");

  console.log("offer-pages-claims:");

  // -- 1. the linter -------------------------------------------------------
  await step("the linter flags money, numbers, percentages, multipliers and the claim words; a plain sentence passes", () => {
    const flagged: Array<[string, RegExp]> = [
      ["Starts at $2,500.", /money/],
      ["Priced at 1200 CAD.", /money/],
      ["Cut admin by 40%.", /percentage/],
      ["Replies get 3x faster.", /multiplier/],
      ["Save twenty hours a week.", /number/],
      ["It takes 14 days.", /number/],
      ["Our clients stay.", /clients/],
      ["See the results.", /results/],
      ["Guaranteed delivery.", /guaranteed/],
      ["A proven system.", /proven/],
      ["More revenue, less admin.", /revenue/],
      ["Calls booked while you sleep.", /booked/],
      ["Money back, no questions asked.", /money back/],
      ["A full refund if it does not fit.", /refund/],
      ["Start risk-free.", /risk-free/],
      ["Strong ROI from week one.", /roi/],
      ["Pure profit.", /profit/],
      ["Real savings on admin.", /savings/],
    ];
    for (const [s, why] of flagged) {
      const reasons = claims.claimReasons(s);
      assert.ok(reasons.length > 0, `not flagged: ${s}`);
      assert.match(reasons.join(", "), why, s);
    }
    for (const s of ["We build systems that fit how you work.", "Book a walkthrough.", "One call, then a plan."]) {
      assert.deepEqual(claims.claimReasons(s), [], `flagged a plain sentence: ${s}`);
    }
    assert.deepEqual(claims.sentencesOf("First line. Second line!\nThird line"), ["First line.", "Second line!", "Third line"]);
  });

  await step("lint walks every drawn piece of copy, once per sentence, and skips the brief", () => {
    const doc = parseOfferPageDoc(
      minimalDoc({
        hero: { headline: "Answer every lead.", subheadline: "Clients reply 3x faster. Really." },
        sections: [{ key: "faq", items: [{ q: "Is it proven?", a: "Clients reply 3x faster. Really." }] }],
        brief: { price: "$9,000 a month" },
      }),
    );
    const hits = claims.lintDoc(doc);
    assert.deepEqual(
      hits.map((h) => [h.where, h.sentence]),
      [
        ["hero.subheadline", "Clients reply 3x faster."],
        ["faq.items[0].q", "Is it proven?"],
      ],
      "duplicates appear once; the brief is never linted (it is never drawn)",
    );
    assert.ok(hits.every((h) => /^[0-9a-f]{64}$/.test(h.hash)));
  });

  // -- 2. ticks ------------------------------------------------------------
  await step("a tick is keyed by the sentence's sha256: editing the sentence clears it", () => {
    const before = parseOfferPageDoc(minimalDoc({ hero: { headline: "Book 3x more calls." } }));
    const [hit] = claims.lintDoc(before);
    const ticks = claims.applyClaimTicks({ existing: [], confirm: [hit.hash], unconfirm: [], draftHits: [hit], publishedHits: [], actor: "u-cc", now: OK.at });
    assert.equal(ticks.length, 1);
    assert.equal(ticks[0].by, "u-cc");
    assert.deepEqual(claims.publishGate(before, ticks, { formEnabled: true, fallbackHeadline: "" }).blockers, [], "ticked: nothing blocks");
    const edited = parseOfferPageDoc(minimalDoc({ hero: { headline: "Book 4x more calls." } }));
    const gate = claims.publishGate(edited, ticks, { formEnabled: true, fallbackHeadline: "" });
    assert.equal(gate.blockers.length, 1, "the edited sentence needs a new tick");
    assert.match(gate.blockers[0], /Book 4x more calls\./);
  });

  await step("a tick can only be added for a sentence the draft flags, and is dropped once neither copy carries it", () => {
    const doc = parseOfferPageDoc(minimalDoc({ hero: { headline: "Book 3x more calls." } }));
    const hits = claims.lintDoc(doc);
    const forged = "a".repeat(64);
    const ticks = claims.applyClaimTicks({ existing: [], confirm: [forged, hits[0].hash], unconfirm: [], draftHits: hits, publishedHits: [], actor: "u", now: OK.at });
    assert.deepEqual(ticks.map((x) => x.hash), [hits[0].hash], "an arbitrary hash is not a tick");
    const pruned = claims.applyClaimTicks({ existing: ticks, confirm: [], unconfirm: [], draftHits: [], publishedHits: [], actor: "u", now: OK.at });
    assert.deepEqual(pruned, []);
    const removed = claims.applyClaimTicks({ existing: ticks, confirm: [], unconfirm: [hits[0].hash], draftHits: hits, publishedHits: [], actor: "u", now: OK.at });
    assert.deepEqual(removed, []);
  });

  // -- 3. confirmations are the server's -----------------------------------
  await step("confirmations are stamped by the server: new ones get the saver, unchanged ones are kept, edited ones re-stamped", () => {
    const result = (quote: string, by = "forged-user") => ({ kind: "quote", quote, who: "Dana", evidence: { permission: true, confirmed: { by, at: OK.at } } });
    const prev = parseOfferPageDoc(minimalDoc({ sections: [{ key: "results", items: [result("It works.", "u-cc")] }] }));
    // The browser sends a copied confirmation on a NEW claim, and the old one unchanged.
    const next = parseOfferPageDoc(minimalDoc({ sections: [{ key: "results", items: [result("It works.", "u-cc"), result("Doubled our leads.", "u-cc")] }] }));
    const stamped = claims.stampConfirmations(next, [prev], "u-adon", "2026-10-09T09:00:00.000Z");
    const items = (stamped.sections[0] as { items: Array<{ evidence: { confirmed: { by: string; at: string } } }> }).items;
    assert.deepEqual(items[0].evidence.confirmed, { by: "u-cc", at: OK.at }, "the confirmation on record is kept");
    assert.deepEqual(items[1].evidence.confirmed, { by: "u-adon", at: "2026-10-09T09:00:00.000Z" }, "a copied confirmation on new content is re-stamped");
    const edited = parseOfferPageDoc(minimalDoc({ sections: [{ key: "results", items: [result("It works brilliantly.", "u-cc")] }] }));
    const restamped = claims.stampConfirmations(edited, [prev], "u-adon", "2026-10-09T09:00:00.000Z");
    assert.equal((restamped.sections[0] as { items: Array<{ evidence: { confirmed: { by: string } } }> }).items[0].evidence.confirmed.by, "u-adon");
  });

  await step("saving the same confirmed content again keeps its first stamp, whatever the browser echoes", () => {
    // What the builder holds after "Add the result", until it is reloaded.
    const pending = { by: "pending", at: "2026-10-08T10:00:00.000Z" };
    const local = parseOfferPageDoc(
      minimalDoc({ sections: [{ key: "results", items: [{ kind: "quote", quote: "Great.", who: "Dana", evidence: { permission: true, confirmed: pending } }] }] }),
    );
    const conf = (d: unknown) => (d as { sections: Array<{ items: Array<{ evidence: { confirmed: unknown } }> }> }).sections[0].items[0].evidence.confirmed;
    const first = claims.stampConfirmations(local, [], "user-a", "2026-10-08T10:00:01.000Z");
    assert.deepEqual(conf(first), { by: "user-a", at: "2026-10-08T10:00:01.000Z" });
    const later = claims.stampConfirmations(local, [first], "user-a", "2026-10-08T15:00:00.000Z");
    assert.deepEqual(conf(later), conf(first), "a second save of the same content moved 'confirmed at' forward");
    const otherOwner = claims.stampConfirmations(local, [first], "user-b", "2026-10-08T16:00:00.000Z");
    assert.deepEqual(conf(otherOwner), conf(first), "another owner's save of the same content took the confirmation over");
  });

  await step("the guarantee blocks Publish while its terms have words and no owner's confirmation, and not once confirmed", () => {
    const withGuarantee = (confirmed?: { by: string; at: string }) =>
      parseOfferPageDoc(minimalDoc({ sections: [{ key: "guarantee", body: "Keep the build if we miss the date.", ...(confirmed ? { confirmed } : {}) }] }));
    const open = claims.publishGate(withGuarantee(), [], { formEnabled: true, fallbackHeadline: "" });
    assert.deepEqual(open.blockers, ["The guarantee needs an owner's confirmation of its terms."]);
    const confirmed = claims.publishGate(withGuarantee(OK), [], { formEnabled: true, fallbackHeadline: "" });
    assert.deepEqual(confirmed.blockers, [], "a confirmed guarantee still blocks Publish");
  });

  // -- 4 and 5. the routes -------------------------------------------------
  const draft = minimalDoc({
    hero: { headline: "Book 3x more calls." },
    sections: [{ key: "faq", items: [{ q: "Who builds it?", a: "Our team, with you." }] }],
    brief: { audience: "Plumbers in Montreal" },
  });
  await db.batch([formRow(FORM, OASIS, "growth", "Growth offer", CONTACT_STEPS), offerRow({ formId: FORM, tenantId: OASIS, draft })], "write");
  const { NextRequest } = await import("next/server");
  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const params = { params: Promise.resolve({ id: FORM }) };
  const offerRoute = await import("../app/api/forms/[id]/offer/route");
  const publishRoute = await import("../app/api/forms/[id]/offer/publish/route");
  const unpublishRoute = await import("../app/api/forms/[id]/offer/unpublish/route");
  const table = async () => JSON.stringify((await db.execute("SELECT * FROM form_offer_pages ORDER BY form_id")).rows);
  const json = async (p: Promise<Response> | Response) => {
    const r = await p;
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };

  await step("someone who may not edit forms gets 403 from every offer write; the table is unchanged", async () => {
    await login(USERS.rep);
    const before = await table();
    for (const [what, run] of [
      ["GET", () => offerRoute.GET(req("GET", `/api/forms/${FORM}/offer`), params)],
      ["PUT", () => offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft, version: 0 }), params)],
      ["publish", () => publishRoute.POST(req("POST", `/api/forms/${FORM}/offer/publish`, { version: 0 }), params)],
      ["unpublish", () => unpublishRoute.POST(req("POST", `/api/forms/${FORM}/offer/unpublish`), params)],
    ] as const) {
      const r = await json(run());
      assert.equal(r.status, 403, `${what}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "forbidden", what);
    }
    assert.equal(await table(), before);
  });

  await step("Publish answers 409 with a plain list of what blocks it; nothing goes live", async () => {
    await login(USERS.cc);
    const r = await json(publishRoute.POST(req("POST", `/api/forms/${FORM}/offer/publish`, { version: 0 }), params));
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "publish_blocked");
    assert.deepEqual(r.body.blockers, [`Confirm "Book 3x more calls." is true and you can back it.`]);
    const live = await db.execute({ sql: "SELECT live, published FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    assert.equal(Number(live.rows[0].live), 0);
    assert.equal(live.rows[0].published, null);
  });

  await step("ticking the sentence lets Publish through, with exactly the checked draft and no brief", async () => {
    await login(USERS.cc);
    const got = await json(offerRoute.GET(req("GET", `/api/forms/${FORM}/offer`), params));
    const gate = (got.body.offer as { gate: { claims: Array<{ hash: string; confirmed: boolean }> } }).gate;
    assert.equal(gate.claims.length, 1);
    const saved = await json(offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft, version: 0, confirm_claims: [gate.claims[0].hash] }), params));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const view = saved.body.offer as { version: number; gate: { blockers: string[] } };
    assert.equal(view.version, 1);
    assert.deepEqual(view.gate.blockers, []);
    const stored = await db.execute({ sql: "SELECT claims_confirmed FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const ticks = JSON.parse(String(stored.rows[0].claims_confirmed)) as Array<{ by: string }>;
    assert.equal(ticks[0].by, USERS.cc.id, "the tick records who confirmed it");
    // A publish of a stale version is refused: what goes live is what was checked.
    const stale = await json(publishRoute.POST(req("POST", `/api/forms/${FORM}/offer/publish`, { version: 0 }), params));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "draft_conflict");
    const pub = await json(publishRoute.POST(req("POST", `/api/forms/${FORM}/offer/publish`, { version: 1 }), params));
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    const row = await db.execute({ sql: "SELECT live, published, published_by FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    assert.equal(Number(row.rows[0].live), 1);
    const published = JSON.parse(String(row.rows[0].published)) as Record<string, unknown>;
    assert.equal(published.brief, undefined, "the brief never goes live");
    assert.equal((published.hero as { headline: string }).headline, "Book 3x more calls.");
    assert.equal(row.rows[0].published_by, USERS.cc.id);
  });

  await step("an edit after the tick blocks Publish again; Unpublish needs no gate", async () => {
    await login(USERS.cc);
    const edited = { ...draft, hero: { headline: "Book 5x more calls." } };
    const saved = await json(offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: edited, version: 1 }), params));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const view = saved.body.offer as { status: string; gate: { blockers: string[] } };
    assert.equal(view.status, "live_with_changes");
    assert.deepEqual(view.gate.blockers, [`Confirm "Book 5x more calls." is true and you can back it.`]);
    const blocked = await json(publishRoute.POST(req("POST", `/api/forms/${FORM}/offer/publish`, { version: 2 }), params));
    assert.equal(blocked.status, 409);
    const off = await json(unpublishRoute.POST(req("POST", `/api/forms/${FORM}/offer/unpublish`), params));
    assert.equal(off.status, 200);
    const row = await db.execute({ sql: "SELECT live FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    assert.equal(Number(row.rows[0].live), 0);
  });

  await step("a confirmation the browser sends is replaced by the saving owner's", async () => {
    await login(USERS.adon);
    const withResult = {
      ...draft,
      sections: [{ key: "results", items: [{ kind: "quote", quote: "Worth it.", who: "Dana", evidence: { permission: true, confirmed: { by: USERS.cc.id, at: OK.at } } }] }],
    };
    const cur = await db.execute({ sql: "SELECT draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const saved = await json(offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: withResult, version: Number(cur.rows[0].draft_version) }), params));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const row = await db.execute({ sql: "SELECT draft FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const stored = JSON.parse(String(row.rows[0].draft)) as { sections: Array<{ items: Array<{ evidence: { confirmed: { by: string } } }> }> };
    assert.equal(stored.sections[0].items[0].evidence.confirmed.by, USERS.adon.id, "a browser cannot put CC's name on a claim Adon added");
  });

  await step("the builder saving the same page again (its 'pending' echo) keeps the stamp, and a live page stays Live", async () => {
    await login(USERS.cc);
    const pending = { by: "pending", at: "2026-10-08T10:00:00.000Z" };
    const local = { ...draft, sections: [{ key: "results", items: [{ kind: "quote", quote: "Kept our weekends.", who: "Sam", evidence: { permission: true, confirmed: pending } }] }] };
    const version = async () => Number((await db.execute({ sql: "SELECT draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] })).rows[0].draft_version);
    const stamp = async () =>
      (JSON.parse(String((await db.execute({ sql: "SELECT draft FROM form_offer_pages WHERE form_id = ?", args: [FORM] })).rows[0].draft)) as {
        sections: Array<{ items: Array<{ evidence: { confirmed: { by: string; at: string } } }> }>;
      }).sections[0].items[0].evidence.confirmed;
    const first = await json(offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: local, version: await version() }), params));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const stamped = await stamp();
    assert.equal(stamped.by, USERS.cc.id);
    const pub = await json(publishRoute.POST(req("POST", `/api/forms/${FORM}/offer/publish`, { version: await version() }), params));
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    // The builder still holds "pending" until it is reloaded; its next autosave sends it again.
    await new Promise((r) => setTimeout(r, 5));
    const again = await json(offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: local, version: await version() }), params));
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.deepEqual(await stamp(), stamped, "the second save moved who confirmed it, or when");
    assert.equal((again.body.offer as { status: string }).status, "live", "a save that changed nothing turned the live page into 'unpublished changes'");
  });

  done("offer-pages-claims");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
