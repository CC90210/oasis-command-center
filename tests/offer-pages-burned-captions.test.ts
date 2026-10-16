/**
 * A Library video whose captions are burned into the picture raises no "no
 * captions" warning (2026-10-16: all six OASIS VSLs carry their captions in the
 * frame; the warning fired on every publish, and a caption file attached to
 * quiet it would have drawn a second set over the first).
 *
 *   - readOfferRow says so (draftHeroBurnedCaptions) when the draft's top video
 *     is a Library asset with meta.burned_captions, and only then;
 *   - publishGate drops the warning when told, and still warns for a Library
 *     video without captions of either kind;
 *   - the Confirm & publish list (a real caller) shows it that way;
 *   - the builder's gate and the publish route pass the flag through.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-burned-captions.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OASIS, CONTACT_STEPS, done, formRow, minimalDoc, offerRow, setupOfferDatabase, step } from "./_offer-pages-harness";

const WARNING = "The top video has no captions. People watching without sound will only have the transcript.";
const RIGHTS = { by: "user-cc", at: "2026-10-16T12:00:00.000Z" };
const F = { burned: "f0a1d170-0000-4000-8000-0000000b0001", plain: "f0a1d170-0000-4000-8000-0000000b0002", link: "f0a1d170-0000-4000-8000-0000000b0003" };
const A = { burned: "a5e70000-0000-4000-8000-0000000b0001", plain: "a5e70000-0000-4000-8000-0000000b0002" };

const libraryHero = (assetId: string) =>
  minimalDoc({ hero: { headline: "A page", video: { source: "library", asset_id: assetId, video_media_id: `${assetId}-v`, rights: RIGHTS, aspect: "16:9" } } });

async function main(): Promise<void> {
  const db = await setupOfferDatabase();
  await db.batch(
    [
      formRow(F.burned, OASIS, "burned", "Burned", CONTACT_STEPS, { headline: "Burned" }),
      formRow(F.plain, OASIS, "plain", "Plain", CONTACT_STEPS, { headline: "Plain" }),
      formRow(F.link, OASIS, "link", "Link", CONTACT_STEPS, { headline: "Link" }),
      offerRow({ formId: F.burned, tenantId: OASIS, draft: libraryHero(A.burned) }),
      offerRow({ formId: F.plain, tenantId: OASIS, draft: libraryHero(A.plain) }),
      offerRow({
        formId: F.link,
        tenantId: OASIS,
        draft: minimalDoc({ hero: { headline: "Link", video: { source: "youtube", id: "dQw4w9WgXcQ", rights: RIGHTS, aspect: "16:9" } } }),
      }),
      {
        sql: `INSERT INTO marketing_asset (id, tenant_id, brand_slug, title, format, status, aspect, meta) VALUES
              (?, ?, 'oasis-ai', 'Burned', 'video', 'approved', '16:9', ?), (?, ?, 'oasis-ai', 'Plain', 'video', 'approved', '16:9', ?)`,
        args: [A.burned, OASIS, JSON.stringify({ offer_slug: "burned", burned_captions: true }), A.plain, OASIS, JSON.stringify({ offer_slug: "plain" })],
      },
    ],
    "write",
  );
  const { readOfferRow } = await import("../lib/offer-pages/store");
  const { publishGate } = await import("../lib/offer-pages/claims");
  const row = async (formId: string) => {
    const r = await readOfferRow(db, OASIS, formId);
    assert.equal(r.state, "row");
    return (r as Extract<typeof r, { state: "row" }>).row;
  };

  await step("readOfferRow says a top video's captions are burned in only when its Library asset says so", async () => {
    assert.equal((await row(F.burned)).draftHeroBurnedCaptions, true);
    assert.equal((await row(F.plain)).draftHeroBurnedCaptions, undefined, "an asset without the flag");
    assert.equal((await row(F.link)).draftHeroBurnedCaptions, undefined, "a link video has no Library asset to say so");
    // Another workspace's asset with the same id never vouches for this one.
    await db.execute({ sql: "UPDATE marketing_asset SET tenant_id = 'someone-else' WHERE id = ?", args: [A.burned] });
    assert.equal((await row(F.burned)).draftHeroBurnedCaptions, undefined, "the asset was read across workspaces");
    await db.execute({ sql: "UPDATE marketing_asset SET tenant_id = ? WHERE id = ?", args: [OASIS, A.burned] });
    // An explicit false (or any other value) is "no".
    for (const value of [false, 0, "true", null]) {
      await db.execute({ sql: "UPDATE marketing_asset SET meta = ? WHERE id = ?", args: [JSON.stringify({ burned_captions: value }), A.plain] });
      assert.equal((await row(F.plain)).draftHeroBurnedCaptions, undefined, `burned_captions ${JSON.stringify(value)} read as yes`);
    }
    // Unreadable meta is "no", never an error.
    await db.execute({ sql: "UPDATE marketing_asset SET meta = 'not json' WHERE id = ?", args: [A.plain] });
    assert.equal((await row(F.plain)).draftHeroBurnedCaptions, undefined);
  });

  await step("publishGate drops the caption warning for burned-in captions, and keeps it otherwise", async () => {
    const gate = async (formId: string) => {
      const r = await row(formId);
      return publishGate(r.draft!, r.claims, { formEnabled: true, fallbackHeadline: "x", heroBurnedCaptions: r.draftHeroBurnedCaptions });
    };
    assert.ok(!(await gate(F.burned)).warnings.includes(WARNING), "burned-in captions still warned");
    assert.ok((await gate(F.plain)).warnings.includes(WARNING), "a video with no captions of any kind lost its warning");
  });

  await step("the Confirm & publish list shows it that way", async () => {
    const { loadConfirmList } = await import("../lib/offer-pages/confirm-list");
    const list = await loadConfirmList(db, { tenantId: OASIS, tenantSlug: "oasis-ai-cc", sign: async () => new Map() });
    assert.equal(list.state, "ok");
    const offers = (list as Extract<typeof list, { state: "ok" }>).offers;
    assert.ok(!offers.find((o) => o.slug === "burned")!.warnings.includes(WARNING));
    assert.ok(offers.find((o) => o.slug === "plain")!.warnings.includes(WARNING));
  });

  await step("the builder's gate and the publish route pass the flag through", () => {
    assert.match(readFileSync("lib/offer-pages/operator.ts", "utf8"), /heroBurnedCaptions: row\.draftHeroBurnedCaptions/);
    assert.match(readFileSync("app/api/forms/[id]/offer/publish/route.ts", "utf8"), /heroBurnedCaptions: row\.draftHeroBurnedCaptions/);
  });

  done("offer-pages-burned-captions");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
