/**
 * offer-pages-video-sign.test.ts - a Library video is signed on tap, and only
 * the one the published page shows (POST /api/offer-page/video,
 * GET /api/offer-page/captions, lib/offer-pages/video.ts), design section 4.1.
 *
 * WHAT IS PINNED: the route signs a ref only when it is in the PUBLISHED copy
 * of a LIVE offer page on an ENABLED form, and the asset is that form's own
 * workspace's, OASIS's own brand, not archived or rejected, with that media row
 * its video. Every other case is the same 404:
 *   - a ref only in the draft,
 *   - another workspace's asset,
 *   - a client brand's asset in OASIS's own workspace (MKT-01),
 *   - an archived asset,
 *   - a page that is not live, a form that is switched off,
 *   - a media row of another asset or of the wrong kind,
 *   - a malformed ref or form id.
 * The signed URL is the video file's own, for two hours (plus the presign
 * window); the bucket is never signed wholesale. The route refuses a cross-site
 * caller (403), a missing Origin (403) and an oversized body (400).
 * The builder: a new Library ref to a client brand's asset is refused (400),
 * and the picker lists only OASIS's own approved or published videos.
 *
 * Stand-in: the R2 signer (records what it was asked to sign).
 *
 * Run: node --conditions=react-server --import tsx tests/offer-pages-video-sign.test.ts
 */
import {
  CLIENT_A,
  OASIS,
  USERS,
  done,
  formRow,
  login,
  minimalDoc,
  offerRow,
  setupOfferDatabase,
  signCalls,
  step,
  stubSigner,
  CONTACT_STEPS,
} from "./_offer-pages-harness";
import assert from "node:assert/strict";

const FORM = "f0de0000-0000-4000-8000-000000000001";
const FORM_OFF = "f0de0000-0000-4000-8000-000000000002";
const FORM_DRAFT = "f0de0000-0000-4000-8000-000000000003";
const OK = { by: "u-1", at: "2026-10-08T12:00:00.000Z" };
const lib = (asset: string, media: string, extra: Record<string, string> = {}) => ({ source: "library", asset_id: asset, video_media_id: media, rights: OK, aspect: "16:9", ...extra });

async function main() {
  await stubSigner();
  const db = await setupOfferDatabase();
  const asset = (id: string, tenant: string, brand: string, status: string, format = "video") => ({
    sql: "INSERT INTO marketing_asset (id, tenant_id, brand_slug, title, format, status, aspect, duration_s) VALUES (?, ?, ?, ?, ?, ?, '16:9', 252)",
    args: [id, tenant, brand, `Asset ${id}`, format, status],
  });
  const media = (id: string, tenant: string, assetId: string, kind: string) => ({
    sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_bucket, storage_path, width, height) VALUES (?, ?, ?, ?, 'marketing-media', ?, 1280, 720)",
    args: [id, tenant, assetId, kind, `${tenant}/${assetId}/${id}.${kind === "caption" ? "vtt" : kind === "video" ? "mp4" : "jpg"}`],
  });
  const published = minimalDoc({
    hero: { headline: "H", video: lib("a-good", "m-good-v", { poster_media_id: "m-good-p", caption_media_id: "m-good-c" }) },
    sections: [
      {
        key: "work",
        items: [
          { title: "client brand", video: lib("a-client-brand", "m-cb-v") },
          { title: "archived", video: lib("a-archived", "m-ar-v") },
          { title: "other workspace", video: lib("a-other", "m-other-v") },
          { title: "wrong media", video: lib("a-good", "m-good-p") },
          { title: "draft status", video: lib("a-draft-status", "m-ds-v") },
        ],
      },
    ],
  });
  const draft = { ...published, sections: [...(published.sections as unknown[]), { key: "what_you_get", items: [{ title: "draft only", video: lib("a-good", "m-good-v") }] }] };
  await db.batch(
    [
      asset("a-good", OASIS, "oasis-ai", "approved"),
      media("m-good-v", OASIS, "a-good", "video"),
      media("m-good-p", OASIS, "a-good", "poster"),
      media("m-good-c", OASIS, "a-good", "caption"),
      asset("a-client-brand", OASIS, "warner", "approved"),
      media("m-cb-v", OASIS, "a-client-brand", "video"),
      asset("a-archived", OASIS, "oasis-ai", "archived"),
      media("m-ar-v", OASIS, "a-archived", "video"),
      asset("a-other", CLIENT_A, "oasis-ai", "approved"),
      media("m-other-v", CLIENT_A, "a-other", "video"),
      asset("a-draft-status", OASIS, "oasis-ai", "draft"),
      media("m-ds-v", OASIS, "a-draft-status", "video"),
      formRow(FORM, OASIS, "vsl", "VSL offer", CONTACT_STEPS),
      formRow(FORM_OFF, OASIS, "vsl-off", "VSL offer off", CONTACT_STEPS, {}, 0),
      formRow(FORM_DRAFT, OASIS, "vsl-draft", "VSL offer draft", CONTACT_STEPS),
      offerRow({ formId: FORM, tenantId: OASIS, draft, published, live: 1 }),
      offerRow({ formId: FORM_OFF, tenantId: OASIS, draft: published, published, live: 1 }),
      offerRow({ formId: FORM_DRAFT, tenantId: OASIS, draft: published, published, live: 0 }),
    ],
    "write",
  );

  const video = await import("../app/api/offer-page/video/route");
  const captions = await import("../app/api/offer-page/captions/route");
  const post = (body: unknown, headers: Record<string, string> = { origin: "http://localhost" }) =>
    video.POST(
      new Request("http://localhost/api/offer-page/video", {
        method: "POST",
        headers: { "content-type": "application/json", host: "localhost", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}`, ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const json = async (r: Promise<Response> | Response) => {
    const res = await r;
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };

  console.log("offer-pages-video-sign:");

  await step("the published hero video of a live offer on an enabled form is signed, for two hours, and only its own file", async () => {
    signCalls.length = 0;
    const r = await json(post({ form_id: FORM, ref: "hero" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.url, `https://r2.test/marketing-media/${OASIS}/a-good/m-good-v.mp4?ttl=7200&sig=fake`);
    assert.equal(r.body.expires_in, 7200);
    assert.deepEqual(signCalls, [{ bucket: "marketing-media", path: `${OASIS}/a-good/m-good-v.mp4`, ttl: 7200 }], "exactly one object signed");
  });

  await step("every other case is the same 404, and nothing is signed", async () => {
    signCalls.length = 0;
    const cases: Array<[string, unknown]> = [
      ["a ref only in the draft", { form_id: FORM, ref: "what_you_get:0" }],
      ["a client brand's asset in OASIS's workspace", { form_id: FORM, ref: "work:0" }],
      ["an archived asset", { form_id: FORM, ref: "work:1" }],
      ["another workspace's asset", { form_id: FORM, ref: "work:2" }],
      ["a media row of the wrong kind", { form_id: FORM, ref: "work:3" }],
      ["no such ref", { form_id: FORM, ref: "work:9" }],
      ["a page that is not live", { form_id: FORM_DRAFT, ref: "hero" }],
      ["a form that is switched off", { form_id: FORM_OFF, ref: "hero" }],
      ["no such form", { form_id: "f0de0000-0000-4000-8000-0000000000ff", ref: "hero" }],
      ["a malformed ref", { form_id: FORM, ref: "hero;drop table" }],
      ["a malformed form id", { form_id: "../../etc", ref: "hero" }],
    ];
    for (const [what, body] of cases) {
      const r = await json(post(body));
      assert.equal(r.status, 404, `${what}: ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.url, undefined, what);
    }
    assert.deepEqual(signCalls, [], "a refused ref was signed");
  });

  await step("a draft-status asset is signed (the rule is not archived or rejected); the picker never offers it", async () => {
    const r = await json(post({ form_id: FORM, ref: "work:4" }));
    assert.equal(r.status, 200, "only archived and rejected are refused at play time");
  });

  await step("cross-site and malformed callers are refused before anything is read", async () => {
    assert.equal((await json(post({ form_id: FORM, ref: "hero" }, { origin: "https://evil.test" }))).status, 403);
    assert.equal((await json(post({ form_id: FORM, ref: "hero" }, {}))).status, 403, "no Origin and no Referer");
    assert.equal((await json(post(JSON.stringify({ form_id: FORM, ref: "hero", pad: "x".repeat(2000) })))).status, 400, "over the 1 KB cap");
    assert.equal((await json(post("not json"))).status, 400);
  });

  await step("captions: the published ref passes validation; every refused ref is 404 before any download", async () => {
    const get = (formId: string, ref: string) =>
      captions.GET(new Request(`http://localhost/api/offer-page/captions?form_id=${encodeURIComponent(formId)}&ref=${encodeURIComponent(ref)}`, { headers: { host: "localhost", "x-forwarded-for": "192.0.2.7" } }));
    for (const [formId, ref] of [
      [FORM, "what_you_get:0"],
      [FORM, "work:0"],
      [FORM_DRAFT, "hero"],
      [FORM_OFF, "hero"],
      [FORM, "work:1"],
    ]) {
      assert.equal((await get(formId, ref)).status, 404, `${formId} ${ref}`);
    }
    // The published hero has a caption: it is past every check, and only the
    // object store (not configured in a test) stands between it and the file.
    assert.equal((await get(FORM, "hero")).status, 503);
    // A published ref with no caption on record is 404, not 503.
    assert.equal((await get(FORM, "work:4")).status, 404);
  });

  // -- the builder --------------------------------------------------------
  const { NextRequest } = await import("next/server");
  const offerRoute = await import("../app/api/forms/[id]/offer/route");
  const libraryRoute = await import("../app/api/forms/[id]/offer/library-videos/route");
  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  await step("the builder refuses a NEW Library ref to a client brand's or another workspace's asset (400), accepts its own", async () => {
    await login(USERS.cc);
    const params = { params: Promise.resolve({ id: FORM }) };
    const cur = await db.execute({ sql: "SELECT draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const version = Number(cur.rows[0].draft_version);
    const withHero = (v: unknown) => ({ ...draft, hero: { headline: "H", video: v } });
    await db.batch(
      [
        asset("a-new-cb", OASIS, "blyss", "approved"),
        media("m-new-cb", OASIS, "a-new-cb", "video"),
        asset("a-other-2", CLIENT_A, "oasis-ai", "approved"),
        media("m-other-2", CLIENT_A, "a-other-2", "video"),
        asset("a-in-review", OASIS, "oasis-ai", "in_review"),
        media("m-in-review", OASIS, "a-in-review", "video"),
      ],
      "write",
    );
    for (const [what, ref] of [
      ["a client brand's asset", lib("a-new-cb", "m-new-cb")],
      ["another workspace's asset", lib("a-other-2", "m-other-2")],
      ["an asset still in review", lib("a-in-review", "m-in-review")],
    ] as const) {
      const r = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: withHero(ref), version }), params);
      assert.equal(r.status, 400, what);
      assert.equal(((await r.json()) as { path: string }).path, "hero", what);
    }
    const ok = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: withHero(lib("a-good", "m-good-v")), version }), params);
    assert.equal(ok.status, 200);
  });

  await step("the picker lists only OASIS's own approved or published videos with a video file", async () => {
    await login(USERS.cc);
    const r = await libraryRoute.GET(req("GET", `/api/forms/${FORM}/offer/library-videos`), { params: Promise.resolve({ id: FORM }) });
    const body = (await r.json()) as { available: boolean; videos: Array<{ asset_id: string; caption_media_id: string | null; poster_url: string | null }> };
    assert.equal(body.available, true);
    assert.deepEqual(body.videos.map((v) => v.asset_id), ["a-good"], "client brands, archived, draft and other workspaces' assets are not offered");
    assert.equal(body.videos[0].caption_media_id, "m-good-c");
    assert.match(String(body.videos[0].poster_url), /m-good-p\.jpg\?ttl=3600/);
  });

  done("offer-pages-video-sign");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
