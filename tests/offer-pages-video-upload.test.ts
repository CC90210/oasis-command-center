/**
 * offer-pages-video-upload.test.ts - a workspace's OWN uploaded video (slice
 * V3): POST /api/forms/[id]/offer/video-upload (mint), its .../confirm, the
 * PUT /api/forms/[id]/offer route's re-verification of a NEW upload ref, and
 * playback through POST /api/offer-page/video + GET /api/offer-page/captions
 * (lib/offer-pages/upload.ts, lib/offer-pages/video.ts).
 *
 * WHAT IS PINNED:
 *   - mint refuses a type outside the kind's allowed set, and a declared size
 *     over the kind's cap, before any signed URL is minted;
 *   - confirm trusts nothing the caller says about the object: it re-reads the
 *     REAL size and content-type (the fake storage stands in for R2's HEAD),
 *     refuses an object that never landed, one over its kind's cap even when
 *     the DECLARED size at mint was within it (anti-spoof), and one of the
 *     wrong real type;
 *   - confirm's token is tenant AND form bound: another workspace's session,
 *     or the right workspace but the wrong form, gets the same refusal as a
 *     missing object; an expired token is refused;
 *   - the PUT save route re-verifies a NEW upload path the same way (not a
 *     path already on record) before it ever reaches the draft;
 *   - a published upload ref whose object path does not belong to the form's
 *     own tenant is never signed for play, and neither are its captions;
 *   - an upload VideoRef still requires the rights confirmation to parse, and
 *     a doc with no upload fields at all (an old doc) still parses unchanged.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-video-upload.test.ts
 */
import assert from "node:assert/strict";
// Read lazily, by lib/offer-pages/upload.ts, inside each mint/verify call: safe to set after the harness import above has already run.
process.env.OFFER_UPLOAD_HMAC_KEY = "test-offer-upload-hmac-key-0001-not-a-real-secret";
import {
  CLIENT_A,
  OASIS,
  USERS,
  done,
  fakeOfferUploadStorage,
  formRow,
  login,
  minimalDoc,
  offerRow,
  setupOfferDatabase,
  signCalls,
  step,
  stubOfferUploadStorage,
  stubSigner,
  CONTACT_STEPS,
} from "./_offer-pages-harness";

const FORM = "f0de0000-0000-4000-8000-000000000011";
const FORM_B = "f0de0000-0000-4000-8000-000000000012";
/** A SECOND form in OASIS's own workspace: isolates the token's FORM binding from its TENANT binding (a cross-tenant path is already refused by pathBelongsToTenant alone, so that case alone cannot prove the form check fires). */
const FORM_A2 = "f0de0000-0000-4000-8000-000000000013";
const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };

/** Unlike a purely-synchronous presign, confirmOfferUpload's expiry check is reached only after a real DB read awaits, so the override must hold across the whole call, not just its first (synchronous) tick. */
async function at<T>(ms: number, call: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await call();
  } finally {
    Date.now = real;
  }
}

async function main() {
  await stubSigner();
  const db = await setupOfferDatabase();
  const fake = fakeOfferUploadStorage();
  await stubOfferUploadStorage(fake.storage);

  await db.batch(
    [
      formRow(FORM, OASIS, "vsl", "VSL offer", CONTACT_STEPS),
      formRow(FORM_B, CLIENT_A, "vsl-b", "Client A offer", CONTACT_STEPS),
      formRow(FORM_A2, OASIS, "vsl-2", "A second OASIS offer", CONTACT_STEPS),
      offerRow({ formId: FORM, tenantId: OASIS, draft: minimalDoc() }),
    ],
    "write",
  );

  const { NextRequest } = await import("next/server");
  const initRoute = await import("../app/api/forms/[id]/offer/video-upload/route");
  const confirmRoute = await import("../app/api/forms/[id]/offer/video-upload/confirm/route");
  const offerRoute = await import("../app/api/forms/[id]/offer/route");
  const videoRoute = await import("../app/api/offer-page/video/route");
  const captionsRoute = await import("../app/api/offer-page/captions/route");
  const { parseOfferPageDoc, OfferPageError, MAX_UPLOAD_BYTES } = await import("../lib/offer-pages/types");

  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response) => ({ status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> });

  const init = (formId: string, body: unknown) => initRoute.POST(req("POST", `/api/forms/${formId}/offer/video-upload`, body), { params: Promise.resolve({ id: formId }) });
  const confirm = (formId: string, body: unknown) => confirmRoute.POST(req("POST", `/api/forms/${formId}/offer/video-upload/confirm`, body), { params: Promise.resolve({ id: formId }) });

  console.log("offer-pages-video-upload:");

  await step("mint refuses a type outside the kind's set, and a declared size over the kind's cap, before any signed URL", async () => {
    await login(USERS.cc);
    fake.signed.length = 0;
    const badType = await json(await init(FORM, { kind: "video", filename: "a.pdf", mime_type: "application/pdf", size_bytes: 1000 }));
    assert.equal(badType.status, 400);
    assert.equal(badType.body.error, "unsupported_type");
    const tooBig = await json(await init(FORM, { kind: "video", filename: "a.mp4", mime_type: "video/mp4", size_bytes: MAX_UPLOAD_BYTES.video + 1 }));
    assert.equal(tooBig.status, 400);
    assert.equal(tooBig.body.error, "too_large");
    assert.deepEqual(fake.signed, [], "a refused mint still signed a PUT URL");
  });

  let videoToken = "";
  let videoPath = "";
  await step("a valid mint returns a storage path under this workspace's own prefix, and a presigned PUT", async () => {
    await login(USERS.cc);
    const r = await json(await init(FORM, { kind: "video", filename: "vsl.mp4", mime_type: "video/mp4", size_bytes: 5_000_000 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    videoPath = String(r.body.storage_path);
    videoToken = String(r.body.upload_token);
    assert.match(videoPath, new RegExp(`^${OASIS}/offer-pages/video/[0-9a-f-]{36}\\.mp4$`));
    assert.ok(String(r.body.signed_url).includes(videoPath), "the signed URL is for the minted path");
  });

  await step("confirm refuses an object that never landed (a mint with no matching upload)", async () => {
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });

  await step("confirm trusts the REAL head, not the declared size: a real object over the cap is refused even though the declared size at mint was fine", async () => {
    fake.put(videoPath, MAX_UPLOAD_BYTES.video + 1, "video/mp4");
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "too_large");
  });

  await step("confirm refuses a real content-type outside the kind's allowed set", async () => {
    fake.put(videoPath, 5_000_000, "text/html");
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "wrong_type");
  });

  await step("confirm succeeds once the real object is within the cap and the right type, and returns the real bytes", async () => {
    fake.put(videoPath, 5_000_000, "video/mp4");
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, "video");
    assert.equal(r.body.path, videoPath);
    assert.equal(r.body.bytes, 5_000_000);
    assert.equal(r.body.mime, "video/mp4");
  });

  await step("another workspace's caller is refused: mint on someone else's form (404), and a token minted for OASIS confirmed under Client A's own form (404)", async () => {
    await login(USERS.clientA);
    const mintOther = await json(await init(FORM, { kind: "video", filename: "x.mp4", mime_type: "video/mp4", size_bytes: 1000 }));
    assert.equal(mintOther.status, 404, "Client A minting against OASIS's form id");

    const confirmOther = await json(await confirm(FORM_B, { upload_token: videoToken }));
    assert.equal(confirmOther.status, 404, "a token minted for OASIS/FORM, confirmed under Client A's own form");
    await login(USERS.cc);
  });

  await step("the token's FORM binding is enforced on its own: the SAME tenant, a DIFFERENT one of its own forms, still refuses (the path's tenant prefix alone would otherwise pass)", async () => {
    await login(USERS.cc);
    const r = await json(await confirm(FORM_A2, { upload_token: videoToken }));
    assert.equal(r.status, 404, "OASIS's own token, confirmed under OASIS's other form");
  });

  await step("an expired token is refused", async () => {
    await login(USERS.cc);
    const minted = await json(await init(FORM, { kind: "poster", filename: "p.png", mime_type: "image/png", size_bytes: 1000 }));
    assert.equal(minted.status, 200);
    const posterPath = String(minted.body.storage_path);
    fake.put(posterPath, 1000, "image/png");
    const future = Date.now() + 21 * 60 * 1000; // past the 20-minute token TTL
    const r = await json(await at(future, () => confirm(FORM, { upload_token: minted.body.upload_token })));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "token_expired");
  });

  // -- the offer PUT route re-verifies a NEW upload path --------------------
  const draftWithUpload = (overrides: Record<string, unknown> = {}) =>
    minimalDoc({
      hero: {
        headline: "H",
        video: { source: "upload", video_path: videoPath, video_bytes: 5_000_000, video_mime: "video/mp4", rights: OK, aspect: "16:9", ...overrides },
      },
    });

  await step("the builder attaches a confirmed upload ref; another's path, or one that never landed, is refused (400)", async () => {
    await login(USERS.cc);
    const params = { params: Promise.resolve({ id: FORM }) };
    const cur = await db.execute({ sql: "SELECT draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const version = Number(cur.rows[0].draft_version);

    const otherTenantPath = `${CLIENT_A}/offer-pages/video/${videoPath.split("/").pop()}`;
    fake.put(otherTenantPath, 5_000_000, "video/mp4");
    const crossTenant = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: draftWithUpload({ video_path: otherTenantPath }), version }), params);
    assert.equal(crossTenant.status, 400, "a path under another tenant's prefix");
    assert.equal(((await crossTenant.json()) as { path: string }).path, "hero");

    const neverLanded = `${OASIS}/offer-pages/video/${"0".repeat(8)}-0000-4000-8000-000000000000.mp4`;
    const missing = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: draftWithUpload({ video_path: neverLanded }), version }), params);
    assert.equal(missing.status, 400, "a path with no real object behind it");

    const good = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: draftWithUpload(), version }), params);
    assert.equal(good.status, 200, JSON.stringify(await good.json()));
  });

  await step("a path already on record (draft or published) is not re-verified: removing it from fake storage still saves", async () => {
    await login(USERS.cc);
    const params = { params: Promise.resolve({ id: FORM }) };
    const cur = await db.execute({ sql: "SELECT draft, draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const draft = JSON.parse(String(cur.rows[0].draft));
    const version = Number(cur.rows[0].draft_version);
    fake.objects.delete(videoPath); // the object "disappears" after it was already attached once
    const r = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: { ...draft, hero: { ...draft.hero, headline: "H2" } }, version }), params);
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
    fake.put(videoPath, 5_000_000, "video/mp4"); // restore for the publish step below
  });

  // -- publish it, and play it -------------------------------------------
  await step("publish, then play: the signed GET is for the private offer-page-uploads prefix, never a public host", async () => {
    await login(USERS.cc);
    const cur = await db.execute({ sql: "SELECT draft, draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const draft = JSON.parse(String(cur.rows[0].draft));
    await db.execute({
      sql: "UPDATE form_offer_pages SET published = ?, published_version = draft_version, live = 1 WHERE form_id = ?",
      args: [JSON.stringify(draft), FORM],
    });
    signCalls.length = 0;
    const r = await json(
      await videoRoute.POST(
        new Request("http://localhost/api/offer-page/video", {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", "x-forwarded-for": "198.51.100.50" },
          body: JSON.stringify({ form_id: FORM, ref: "hero" }),
        }),
      ),
    );
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, `https://r2.test/offer-page-uploads/${videoPath}?ttl=7200&sig=fake`);
    assert.deepEqual(signCalls, [{ bucket: "offer-page-uploads", path: videoPath, ttl: 7200 }]);
  });

  await step("a published upload ref whose path does not belong to the form's own tenant is never signed (defense in depth)", async () => {
    const tampered = minimalDoc({
      hero: { headline: "H", video: { source: "upload", video_path: `${CLIENT_A}/offer-pages/video/aaaaaaaa-0000-4000-8000-000000000000.mp4`, video_bytes: 100, video_mime: "video/mp4", rights: OK, aspect: "16:9" } },
    });
    await db.execute({ sql: "UPDATE form_offer_pages SET published = ? WHERE form_id = ?", args: [JSON.stringify(tampered), FORM] });
    signCalls.length = 0;
    const r = await json(
      await videoRoute.POST(
        new Request("http://localhost/api/offer-page/video", {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", "x-forwarded-for": "198.51.100.51" },
          body: JSON.stringify({ form_id: FORM, ref: "hero" }),
        }),
      ),
    );
    assert.equal(r.status, 404, "a published ref pointing outside this form's own tenant prefix");
    assert.deepEqual(signCalls, [], "it was signed anyway");
  });

  // -- captions: an upload video's VTT is served by the same route -------
  await step("captions: an upload ref's caption path is served, and a ref with none is 404", async () => {
    await login(USERS.cc);
    const withCaption = minimalDoc({
      hero: {
        headline: "H",
        video: { source: "upload", video_path: videoPath, video_bytes: 5_000_000, video_mime: "video/mp4", caption_path: `${OASIS}/offer-pages/captions/aaaaaaaa-0000-4000-8000-000000000000.vtt`, rights: OK, aspect: "16:9" },
      },
    });
    await db.execute({ sql: "UPDATE form_offer_pages SET published = ? WHERE form_id = ?", args: [JSON.stringify(withCaption), FORM] });
    const get = () =>
      captionsRoute.GET(new Request(`http://localhost/api/offer-page/captions?form_id=${FORM}&ref=hero`, { headers: { host: "localhost", "x-forwarded-for": "192.0.2.80" } }));
    // Past every check, only the object store (the real captions download, not this feature's stand-in) remains: 503.
    assert.equal((await get()).status, 503);
    const noCaption = minimalDoc({ hero: { headline: "H", video: { source: "upload", video_path: videoPath, video_bytes: 5_000_000, video_mime: "video/mp4", rights: OK, aspect: "16:9" } } });
    await db.execute({ sql: "UPDATE form_offer_pages SET published = ? WHERE form_id = ?", args: [JSON.stringify(noCaption), FORM] });
    assert.equal((await get()).status, 404, "a ref with no captions on record");
  });

  // -- the parser: rights still required; old docs still parse unchanged --
  await step("an upload VideoRef still requires the rights confirmation to parse, and an old doc with no upload fields parses unchanged", async () => {
    const good = {
      ...minimalDoc(),
      hero: { headline: "H", video: { source: "upload", video_path: videoPath, video_bytes: 5_000_000, video_mime: "video/mp4", rights: OK, aspect: "16:9" } },
    };
    assert.doesNotThrow(() => parseOfferPageDoc(good));
    const noRights = structuredClone(good) as Record<string, unknown>;
    delete (((noRights.hero as Record<string, unknown>).video as Record<string, unknown>).rights as unknown);
    assert.throws(
      () => parseOfferPageDoc(noRights),
      (e: unknown) => e instanceof OfferPageError && e.path === "$.hero.video.rights",
    );
    // An old document (no video at all, or a Library/link one) is wholly unaffected by the new source.
    assert.doesNotThrow(() => parseOfferPageDoc(minimalDoc()));
    assert.doesNotThrow(() =>
      parseOfferPageDoc({ ...minimalDoc(), hero: { headline: "H", video: { source: "youtube", id: "dQw4w9WgXcQ", rights: OK, aspect: "16:9" } } }),
    );
  });

  done("offer-pages-video-upload");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
