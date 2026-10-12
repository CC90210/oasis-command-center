/**
 * offer-pages-video-upload.test.ts - a workspace's OWN uploaded video (slice
 * V3): POST /api/forms/[id]/offer/video-upload (mint), its .../confirm, the
 * PUT /api/forms/[id]/offer route's re-verification of a NEW upload ref, and
 * playback through POST /api/offer-page/video + GET /api/offer-page/captions
 * (lib/offer-pages/upload.ts, lib/offer-pages/video.ts).
 *
 * WHAT IS PINNED:
 *   - mint refuses a type outside the kind's allowed set, and a declared size
 *     over the kind's cap, before any signed URL is minted; the SIGNED
 *     Content-Length/Content-Type binding itself (so R2 refuses a mismatched
 *     real PUT, not only a server-side check after the fact) is proven
 *     independently in tests/r2-signed-url-constrained.test.ts;
 *   - confirm trusts nothing the caller says about the STAGING object: it
 *     re-reads the REAL size and content-type (the fake storage stands in
 *     for R2's HEAD), refuses one that never landed, one over its kind's cap
 *     even when the DECLARED size at mint was within it (anti-spoof), and
 *     one of the wrong real type;
 *   - confirm copies the verified staging object to an IMMUTABLE FINAL key,
 *     conditional on the ETag it just read: a source that changed underneath
 *     that ETag (TOCTOU - the presigned PUT stays valid after confirm reads
 *     it) fails the copy, "swapped", and nothing is promoted; the staging
 *     path is NEVER the one returned or ever servable;
 *   - confirm's token is tenant AND form bound: another workspace's session,
 *     or the right workspace but the wrong form, gets the same refusal as a
 *     missing object; an expired (short) token is refused;
 *   - a missing/short signing key fails CLOSED (key_unavailable -> 503
 *     upload_unavailable), never a silent pass;
 *   - the PUT save route re-verifies a NEW upload path the same way (not a
 *     path already on record) before it ever reaches the draft;
 *   - resolve/serve (play, and the page's initial poster) re-checks the FINAL
 *     object's real size and type against the cap EVERY TIME, not only at
 *     confirm; a published ref whose object path does not belong to the
 *     form's own tenant is never signed for play, and neither are its
 *     captions;
 *   - an upload VideoRef still requires the rights confirmation to parse, and
 *     a doc with no upload fields at all (an old doc) still parses unchanged.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-video-upload.test.ts
 */
import assert from "node:assert/strict";
import {
  CLIENT_A,
  OASIS,
  USERS,
  derivedKeySwitch,
  done,
  fakeOfferUploadStorage,
  formRow,
  login,
  minimalDoc,
  offerRow,
  setupOfferDatabase,
  signCalls,
  step,
  stubDerivedKeys,
  stubOfferUploadStorage,
  stubSigner,
  CONTACT_STEPS,
} from "./_offer-pages-harness";

const FORM = "f0de0000-0000-4000-8000-000000000011";
const FORM_B = "f0de0000-0000-4000-8000-000000000012";
/** A SECOND form in OASIS's own workspace: isolates the token's FORM binding from its TENANT binding (a cross-tenant path is already refused by pathBelongsToTenant alone, so that case alone cannot prove the form check fires). */
const FORM_A2 = "f0de0000-0000-4000-8000-000000000013";
const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };

/** Reads an upload_token's own payload (no signature check - the test has no legitimate way to hold the HKDF-derived key, and does not need to: it only needs to predict the SAME final path confirmOfferUpload's finalPathForToken derives, to assert nothing landed there). */
function decodeUploadToken(token: string): { nonce: string; staging_path: string } {
  const [body] = token.split(".");
  return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as { nonce: string; staging_path: string };
}

/** Mirrors lib/offer-pages/upload.ts's finalPathForToken: the final key a token promotes to, named by ITS OWN nonce, never the staging path's mint-time uuid. */
function expectedFinalPath(stagingPath: string, token: string): string {
  const nonce = decodeUploadToken(token).nonce;
  const m = /^(.+\/offer-pages\/)_staging\/([^/]+)\/[0-9a-f-]+(\.[a-z0-9]+)$/.exec(stagingPath);
  assert.ok(m, `not a staging path: ${stagingPath}`);
  return `${m![1]}${m![2]}/${nonce}${m![3]}`;
}

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
  await stubDerivedKeys();
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
  const { UPLOAD_TOKEN_TTL_SEC } = await import("../lib/offer-pages/upload");

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
  let videoStagingPath = "";
  let videoFinalPath = "";
  await step("a valid mint returns a STAGING path under this workspace's own prefix, with Content-Length/Content-Type signed and a short TTL", async () => {
    await login(USERS.cc);
    const r = await json(await init(FORM, { kind: "video", filename: "vsl.mp4", mime_type: "video/mp4", size_bytes: 5_000_000 }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    videoStagingPath = String(r.body.storage_path);
    videoToken = String(r.body.upload_token);
    assert.match(videoStagingPath, new RegExp(`^${OASIS}/offer-pages/_staging/video/[0-9a-f-]{36}\\.mp4$`), "a STAGING path, never the final shape");
    assert.ok(String(r.body.signed_url).includes(videoStagingPath), "the signed URL is for the minted staging path");
    const signedCall = fake.signed.find((s) => s.path === videoStagingPath);
    assert.ok(signedCall, "the constrained presign was asked for");
    assert.equal(signedCall!.contentLength, 5_000_000, "the exact declared size is what gets signed");
    assert.equal(signedCall!.contentType, "video/mp4");
    assert.ok(signedCall!.ttlSec <= 600, "minutes, not the old 15-minute shared default");
    assert.equal(r.body.expires_in, UPLOAD_TOKEN_TTL_SEC);
  });

  await step("confirm refuses an object that never landed (a mint with no matching upload)", async () => {
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 404);
    assert.equal(r.body.error, "not_found");
  });

  await step("confirm trusts the REAL head, not the declared size: a real object over the cap is refused even though the declared size at mint was fine", async () => {
    fake.put(videoStagingPath, MAX_UPLOAD_BYTES.video + 1, "video/mp4");
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "too_large");
    assert.deepEqual(fake.copies, [], "an oversize staging object was ever copied to a final key");
  });

  await step("confirm refuses a real content-type outside the kind's allowed set", async () => {
    fake.put(videoStagingPath, 5_000_000, "text/html");
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "wrong_type");
    assert.deepEqual(fake.copies, [], "a wrong-type staging object was ever copied");
  });

  await step("confirm succeeds once the real object is within the cap and the right type: copies to an IMMUTABLE FINAL key, removes the staging object, and returns only the final path", async () => {
    fake.put(videoStagingPath, 5_000_000, "video/mp4");
    const r = await json(await confirm(FORM, { upload_token: videoToken }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kind, "video");
    videoFinalPath = String(r.body.path);
    assert.notEqual(videoFinalPath, videoStagingPath, "the returned path is the FINAL key, never the staging one");
    assert.match(videoFinalPath, new RegExp(`^${OASIS}/offer-pages/video/[0-9a-f-]{36}\\.mp4$`));
    assert.equal(r.body.bytes, 5_000_000);
    assert.equal(r.body.mime, "video/mp4");
    assert.ok(fake.objects.has(videoFinalPath), "the final object exists");
    assert.equal(fake.objects.has(videoStagingPath), false, "the staging object was removed after promotion");
    assert.deepEqual(
      fake.copies.map((c) => ({ source: c.source, dest: c.dest })),
      [{ source: videoStagingPath, dest: videoFinalPath }],
      "exactly one conditional copy, staging to final",
    );
  });

  await step("a TOCTOU swap (the source changed between confirm's own HEAD and the copy) is refused, and nothing is promoted", async () => {
    await login(USERS.cc);
    const minted = await json(await init(FORM, { kind: "video", filename: "swap.mp4", mime_type: "video/mp4", size_bytes: 2_000_000 }));
    assert.equal(minted.status, 200);
    const stagingPath = String(minted.body.storage_path);
    fake.put(stagingPath, 2_000_000, "video/mp4"); // the HEAD confirm reads still passes its own size/type gate
    // Flips the SAME storage instance already wired into the route (re-stubbing
    // the module here would have no effect: the route captured the first
    // stub's exports at import time), modelling R2 reporting that the source
    // changed underneath the ETag confirm just read.
    fake.opts.forcePreconditionFailed = true;
    const r = await json(await confirm(FORM, { upload_token: minted.body.upload_token }));
    fake.opts.forcePreconditionFailed = false;
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.equal(r.body.error, "swapped");
    const finalPath = expectedFinalPath(stagingPath, String(minted.body.upload_token));
    assert.equal(fake.objects.has(finalPath), false, "a swapped source was promoted to the final key anyway");
    assert.equal(fake.objects.has(stagingPath), true, "a refused swap still removed the staging object it did not promote");
  });

  await step("confirm-replay-overwrite: confirming twice for the SAME token never overwrites the first promotion, even with different, same-size-and-type bytes re-uploaded in between (Codex review of e99e9a90)", async () => {
    await login(USERS.cc);
    const minted = await json(await init(FORM, { kind: "video", filename: "replay.mp4", mime_type: "video/mp4", size_bytes: 3_000_000 }));
    assert.equal(minted.status, 200);
    const stagingPath = String(minted.body.storage_path);
    const token = String(minted.body.upload_token);
    const finalPath = expectedFinalPath(stagingPath, token);

    fake.put(stagingPath, 3_000_000, "video/mp4"); // the editor's real upload
    const first = await json(await confirm(FORM, { upload_token: token }));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.path, finalPath);
    const etagAfterFirst = fake.objects.get(finalPath)?.etag;
    assert.ok(etagAfterFirst, "the first confirm did not promote anything");

    // The PUT URL is still valid (its own window has not elapsed): the SAME
    // staging key gets DIFFERENT bytes, same declared size and type, exactly
    // the review's reproduction - then the SAME token is replayed.
    fake.put(stagingPath, 3_000_000, "video/mp4");
    const replay = await json(await confirm(FORM, { upload_token: token }));
    assert.equal(replay.status, 409, JSON.stringify(replay.body));
    assert.equal(replay.body.error, "already_confirmed");
    assert.equal(fake.objects.get(finalPath)?.etag, etagAfterFirst, "the replay changed the already-promoted final object");
    // The write-once check runs BEFORE any copy is even attempted: the
    // replay never reaches storage.copyIfMatch at all, so exactly ONE copy
    // (the first, legitimate confirm) was ever made into this final key.
    assert.deepEqual(
      fake.copies.filter((c) => c.dest === finalPath).map((c) => c.source),
      [stagingPath],
      "the replay reached copyIfMatch instead of being refused before it",
    );
  });

  await step("another workspace's caller is refused: mint on someone else's form (404), and a token minted for OASIS confirmed under Client A's own form (404)", async () => {
    await login(USERS.clientA);
    const mintOther = await json(await init(FORM, { kind: "video", filename: "x.mp4", mime_type: "video/mp4", size_bytes: 1000 }));
    assert.equal(mintOther.status, 404, "Client A minting against OASIS's form id");

    const retry = await json(await init(FORM_B, { kind: "video", filename: "x.mp4", mime_type: "video/mp4", size_bytes: 1000 }));
    assert.equal(retry.status, 200, "Client A may mint for its OWN form");
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
    const future = Date.now() + (UPLOAD_TOKEN_TTL_SEC + 60) * 1000;
    const r = await json(await at(future, () => confirm(FORM, { upload_token: minted.body.upload_token })));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "token_expired");
  });

  await step("a missing signing key fails CLOSED: 503 upload_unavailable, never a silent pass (the key is HKDF-derived from AUTH_SESSION_SECRET, lib/crypto/derived-keys.ts)", async () => {
    await login(USERS.cc);
    derivedKeySwitch.failing = true;
    try {
      const mintFails = await json(await init(FORM, { kind: "video", filename: "x.mp4", mime_type: "video/mp4", size_bytes: 1000 }));
      assert.equal(mintFails.status, 503, JSON.stringify(mintFails.body));
      assert.equal(mintFails.body.error, "upload_unavailable");

      derivedKeySwitch.failing = false;
      const minted = await json(await init(FORM, { kind: "video", filename: "x.mp4", mime_type: "video/mp4", size_bytes: 1000 }));
      assert.equal(minted.status, 200, "the key works again once it is available");
      fake.put(String(minted.body.storage_path), 1000, "video/mp4");

      derivedKeySwitch.failing = true;
      const confirmFails = await json(await confirm(FORM, { upload_token: minted.body.upload_token }));
      assert.equal(confirmFails.status, 503, JSON.stringify(confirmFails.body));
      assert.equal(confirmFails.body.error, "upload_unavailable");
    } finally {
      derivedKeySwitch.failing = false;
    }
  });

  // -- the offer PUT route re-verifies a NEW upload path --------------------
  const draftWithUpload = (overrides: Record<string, unknown> = {}) =>
    minimalDoc({
      hero: {
        headline: "H",
        video: { source: "upload", video_path: videoFinalPath, video_bytes: 5_000_000, video_mime: "video/mp4", rights: OK, aspect: "16:9", ...overrides },
      },
    });

  await step("the builder attaches a confirmed (FINAL) upload ref; another's path, a staging path, or one that never landed, is refused (400)", async () => {
    await login(USERS.cc);
    const params = { params: Promise.resolve({ id: FORM }) };
    const cur = await db.execute({ sql: "SELECT draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const version = Number(cur.rows[0].draft_version);

    const otherTenantPath = `${CLIENT_A}/offer-pages/video/${videoFinalPath.split("/").pop()}`;
    fake.put(otherTenantPath, 5_000_000, "video/mp4");
    const crossTenant = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: draftWithUpload({ video_path: otherTenantPath }), version }), params);
    assert.equal(crossTenant.status, 400, "a path under another tenant's prefix");
    assert.equal(((await crossTenant.json()) as { path: string }).path, "hero");

    const neverLanded = `${OASIS}/offer-pages/video/${"0".repeat(8)}-0000-4000-8000-000000000000.mp4`;
    const missing = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: draftWithUpload({ video_path: neverLanded }), version }), params);
    assert.equal(missing.status, 400, "a path with no real object behind it");

    // A STAGING path (even one that is a real object, same tenant) is never a valid ref: the parser's own path shape rejects it before any storage call.
    const stagingAsRef = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: draftWithUpload({ video_path: `${OASIS}/offer-pages/_staging/video/aaaaaaaa-0000-4000-8000-000000000000.mp4` }), version }), params);
    assert.equal(stagingAsRef.status, 400, "a staging path used directly as a ref");
    assert.equal(((await stagingAsRef.json()) as { reason: string }).reason, "not an uploaded video this workspace stored");

    const good = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: draftWithUpload(), version }), params);
    assert.equal(good.status, 200, JSON.stringify(await good.json()));
  });

  await step("a path already on record (draft or published) is not re-verified: removing it from fake storage still saves", async () => {
    await login(USERS.cc);
    const params = { params: Promise.resolve({ id: FORM }) };
    const cur = await db.execute({ sql: "SELECT draft, draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const draft = JSON.parse(String(cur.rows[0].draft));
    const version = Number(cur.rows[0].draft_version);
    fake.objects.delete(videoFinalPath); // the object "disappears" after it was already attached once
    const r = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: { ...draft, hero: { ...draft.hero, headline: "H2" } }, version }), params);
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
    fake.put(videoFinalPath, 5_000_000, "video/mp4"); // restore for the publish step below
  });

  // -- publish it, and play it -------------------------------------------
  await step("publish, then play: the signed GET is for the private offer-page-uploads prefix, never a public host, and a re-check runs at every play", async () => {
    await login(USERS.cc);
    const cur = await db.execute({ sql: "SELECT draft, draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const draft = JSON.parse(String(cur.rows[0].draft));
    await db.execute({
      sql: "UPDATE form_offer_pages SET published = ?, published_version = draft_version, live = 1 WHERE form_id = ?",
      args: [JSON.stringify(draft), FORM],
    });
    signCalls.length = 0;
    const play = () =>
      videoRoute.POST(
        new Request("http://localhost/api/offer-page/video", {
          method: "POST",
          headers: { "content-type": "application/json", host: "localhost", origin: "http://localhost", "x-forwarded-for": "198.51.100.50" },
          body: JSON.stringify({ form_id: FORM, ref: "hero" }),
        }),
      );
    const r = await json(await play());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, `https://r2.test/offer-page-uploads/${videoFinalPath}?ttl=7200&sig=fake`);
    assert.deepEqual(signCalls, [{ bucket: "offer-page-uploads", path: videoFinalPath, ttl: 7200 }]);

    // resource-cap-bypass finding: "not only confirm" - if the final object's
    // REAL size is ever found to be over the cap (however that happened:
    // nothing here claims how), play refuses it too, every time, not only
    // once at confirm.
    fake.put(videoFinalPath, MAX_UPLOAD_BYTES.video + 1, "video/mp4");
    signCalls.length = 0;
    const overCap = await json(await play());
    assert.equal(overCap.status, 404, "an over-cap final object is never signed for play either");
    assert.deepEqual(signCalls, []);
    fake.put(videoFinalPath, 5_000_000, "video/mp4"); // restore
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
        video: { source: "upload", video_path: videoFinalPath, video_bytes: 5_000_000, video_mime: "video/mp4", caption_path: `${OASIS}/offer-pages/captions/aaaaaaaa-0000-4000-8000-000000000000.vtt`, rights: OK, aspect: "16:9" },
      },
    });
    await db.execute({ sql: "UPDATE form_offer_pages SET published = ? WHERE form_id = ?", args: [JSON.stringify(withCaption), FORM] });
    const get = () =>
      captionsRoute.GET(new Request(`http://localhost/api/offer-page/captions?form_id=${FORM}&ref=hero`, { headers: { host: "localhost", "x-forwarded-for": "192.0.2.80" } }));
    // Past every check, only the object store (the real captions download, not this feature's stand-in) remains: 503.
    assert.equal((await get()).status, 503);
    const noCaption = minimalDoc({ hero: { headline: "H", video: { source: "upload", video_path: videoFinalPath, video_bytes: 5_000_000, video_mime: "video/mp4", rights: OK, aspect: "16:9" } } });
    await db.execute({ sql: "UPDATE form_offer_pages SET published = ? WHERE form_id = ?", args: [JSON.stringify(noCaption), FORM] });
    assert.equal((await get()).status, 404, "a ref with no captions on record");
  });

  // -- the parser: rights still required; old docs still parse unchanged --
  await step("an upload VideoRef still requires the rights confirmation to parse, and an old doc with no upload fields parses unchanged", async () => {
    const good = {
      ...minimalDoc(),
      hero: { headline: "H", video: { source: "upload", video_path: videoFinalPath, video_bytes: 5_000_000, video_mime: "video/mp4", rights: OK, aspect: "16:9" } },
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
