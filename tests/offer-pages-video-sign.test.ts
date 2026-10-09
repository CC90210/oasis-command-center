/**
 * offer-pages-video-sign.test.ts - a Library video is signed on tap, and only
 * the one the published page shows (POST /api/offer-page/video,
 * GET /api/offer-page/captions, lib/offer-pages/video.ts), design section 4.1.
 *
 * WHAT IS PINNED: the route signs a ref only when it is in the PUBLISHED copy
 * of a LIVE offer page on an ENABLED form, and the asset is that form's own
 * workspace's, OASIS's own brand, a released cut (approved, scheduled or
 * published), with that media row its video. Every other case is the same 404:
 *   - a ref only in the draft (captions too, though that ref has captions),
 *   - another workspace's asset,
 *   - a client brand's asset in OASIS's own workspace (MKT-01),
 *   - an archived asset, a draft-status asset, one pulled back to review,
 *   - a page that is not live, a form that is switched off,
 *   - a media row of another asset or of the wrong kind,
 *   - a malformed ref or form id.
 * The signed URL is the video file's own, for two hours (plus the presign
 * window); the bucket is never signed wholesale. The route refuses a cross-site
 * caller (403), a missing Origin (403) and an oversized body (400).
 * The owner's Preview (POST/GET /api/forms/[id]/offer/preview-video) plays a
 * DRAFT ref and its captions, by the same asset rules, for half an hour.
 * The builder: a new Library ref to a client brand's asset is refused (400),
 * a new Library image that the page could not show is refused (400), and the
 * picker lists only OASIS's own approved or published videos.
 * A link video's thumbnail (design 4.2) is copied only from the provider's own
 * image host over https, and a redirect is never followed (CodeRabbit on #557):
 * the copy lands in the PUBLIC prefix.
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
      {
        key: "results",
        items: [
          { kind: "video", label: "scheduled", video: lib("a-scheduled", "m-sch-v"), evidence: { permission: true, confirmed: OK } },
          { kind: "video", label: "pulled back to review", video: lib("a-pulled", "m-pulled-v"), evidence: { permission: true, confirmed: OK } },
        ],
      },
    ],
  });
  // The draft-only ref carries captions, so a captions route that read the
  // draft would answer it (503 here, past every check) instead of 404.
  const draft = {
    ...published,
    sections: [...(published.sections as unknown[]), { key: "what_you_get", items: [{ title: "draft only", video: lib("a-good", "m-good-v", { caption_media_id: "m-good-c" }) }] }],
  };
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
      asset("a-scheduled", OASIS, "oasis-ai", "scheduled"),
      media("m-sch-v", OASIS, "a-scheduled", "video"),
      // Approved when it was attached, then pulled back to review (an unreleased cut).
      asset("a-pulled", OASIS, "oasis-ai", "in_review"),
      media("m-pulled-v", OASIS, "a-pulled", "video"),
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
      ["a draft-status asset", { form_id: FORM, ref: "work:4" }],
      ["an asset pulled back to review after it went live", { form_id: FORM, ref: "results:1" }],
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

  await step("a scheduled asset still plays: approved, scheduled, published is the forward path", async () => {
    const r = await json(post({ form_id: FORM, ref: "results:0" }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
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
    assert.equal((await get(FORM, "results:0")).status, 404);
  });

  await step("captions: a file bigger than a caption file, by its size on record, is 404 before anything is downloaded", async () => {
    const { captionsResponse, MAX_VTT_BYTES } = await import("../lib/offer-pages/captions");
    const row = { id: "m-big", asset_id: "a-good", kind: "caption", storage_bucket: "marketing-media", storage_path: `${OASIS}/a-good/m-big.vtt`, mime: null, width: null, height: null };
    const ctx = { where: "test", formId: FORM, ref: "hero", cacheControl: "no-store" };
    assert.equal((await captionsResponse({ ...row, bytes: MAX_VTT_BYTES + 1 }, ctx)).status, 404, "an oversized caption was downloaded");
    // Within the cap it goes on to the object store (not configured here: 503).
    assert.equal((await captionsResponse({ ...row, bytes: 2048 }, ctx)).status, 503);
  });

  // -- the builder --------------------------------------------------------
  const { NextRequest } = await import("next/server");
  const offerRoute = await import("../app/api/forms/[id]/offer/route");
  const libraryRoute = await import("../app/api/forms/[id]/offer/library-videos/route");
  const req = (method: string, url: string, body?: unknown) =>
    new NextRequest(`http://localhost${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

  await step("the owner's Preview plays the DRAFT's Library video and its captions, by the page's own asset rules", async () => {
    const preview = await import("../app/api/forms/[id]/offer/preview-video/route");
    const params = { params: Promise.resolve({ id: FORM }) };
    const sign = (ref: unknown) => preview.POST(req("POST", `/api/forms/${FORM}/offer/preview-video`, { ref }), params);
    const caps = (ref: string) => preview.GET(req("GET", `/api/forms/${FORM}/offer/preview-video?ref=${encodeURIComponent(ref)}`), params);
    await login(USERS.cc);
    signCalls.length = 0;
    const r = await json(sign("what_you_get:0"));
    assert.equal(r.status, 200, `a draft-only ref does not play in the owner's preview: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.url, `https://r2.test/marketing-media/${OASIS}/a-good/m-good-v.mp4?ttl=1800&sig=fake`);
    assert.deepEqual(signCalls, [{ bucket: "marketing-media", path: `${OASIS}/a-good/m-good-v.mp4`, ttl: 1800 }], "exactly one object, for half an hour");
    // Its captions come from the draft too: past every check, only the object store (not configured here) remains.
    assert.equal((await caps("what_you_get:0")).status, 503);
    signCalls.length = 0;
    for (const [what, ref] of [
      ["a client brand's asset", "work:0"],
      ["an archived asset", "work:1"],
      ["another workspace's asset", "work:2"],
      ["a media row of the wrong kind", "work:3"],
      ["a draft-status asset", "work:4"],
      ["an asset pulled back to review", "results:1"],
      ["no such ref", "work:9"],
      ["a malformed ref", "hero;x"],
    ] as const) {
      assert.equal((await sign(ref)).status, 404, what);
    }
    assert.equal((await caps("results:0")).status, 404, "a ref with no captions on record");
    assert.deepEqual(signCalls, [], "a refused ref was signed");
    // The facade asks the preview route only in the owner's preview, and the public routes otherwise.
    const { libraryEndpoints } = await import("../components/offer-pages/VideoFacade");
    const base = { kind: "library" as const, formId: FORM, videoRef: "what_you_get:0", captions: true };
    assert.deepEqual(libraryEndpoints({ ...base, preview: true }), {
      sign: `/api/forms/${FORM}/offer/preview-video`,
      body: JSON.stringify({ ref: "what_you_get:0" }),
      captions: `/api/forms/${FORM}/offer/preview-video?ref=what_you_get%3A0`,
    });
    assert.deepEqual(libraryEndpoints(base), {
      sign: "/api/offer-page/video",
      body: JSON.stringify({ form_id: FORM, ref: "what_you_get:0" }),
      captions: `/api/offer-page/captions?form_id=${FORM}&ref=what_you_get%3A0`,
    });
  });

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

  await step("the builder refuses a NEW Library image the page could not show (400, naming where), and takes a released one", async () => {
    await login(USERS.cc);
    const params = { params: Promise.resolve({ id: FORM }) };
    await db.batch(
      [
        asset("a-img-draft", OASIS, "oasis-ai", "draft", "image"),
        media("m-img-draft", OASIS, "a-img-draft", "image"),
        asset("a-img-ok", OASIS, "oasis-ai", "approved", "image"),
        media("m-img-ok", OASIS, "a-img-ok", "image"),
      ],
      "write",
    );
    const cur = await db.execute({ sql: "SELECT draft, draft_version FROM form_offer_pages WHERE form_id = ?", args: [FORM] });
    const base = JSON.parse(String(cur.rows[0].draft)) as { sections: Array<{ key: string; items: unknown[] }> };
    const version = Number(cur.rows[0].draft_version);
    const at = base.sections.findIndex((s) => s.key === "results");
    assert.ok(at >= 0, "precondition: the draft has a results section");
    const shotAt = base.sections[at].items.length;
    const withShot = (assetId: string, mediaId: string) => ({
      ...base,
      sections: base.sections.map((s, i) =>
        i === at
          ? {
              ...s,
              items: [
                ...s.items,
                { kind: "screenshot", image: { asset_id: assetId, media_id: mediaId }, alt: "The inbox, before and after", evidence: { permission: true, confirmed: OK } },
              ],
            }
          : s,
      ),
    });
    const bad = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: withShot("a-img-draft", "m-img-draft"), version }), params);
    assert.equal(bad.status, 400, "a draft-status image was attached");
    const body = (await bad.json()) as { path: string; reason: string };
    assert.equal(body.path, `$.sections[${at}].items[${shotAt}].image`);
    assert.equal(body.reason, "not a Library image this workspace may show");
    const good = await offerRoute.PUT(req("PUT", `/api/forms/${FORM}/offer`, { draft: withShot("a-img-ok", "m-img-ok"), version }), params);
    assert.equal(good.status, 200, JSON.stringify(await good.json()));
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

  // -- a link video's thumbnail, copied to our own PUBLIC prefix -------------
  await step("a link video's thumbnail comes only from the provider's own image host, and a redirect is never followed", async () => {
    const { copyThumbnail } = await import("../lib/offer-pages/video");
    const ref = { source: "youtube" as const, id: "dQw4w9WgXcQ" };
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const uploads: string[] = [];
    const upload = async (path: string) => {
      uploads.push(path);
      return true;
    };
    const asked: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
    // An allowed CDN URL that answers with a redirect to an internal address.
    // A fetch left to follow it gets that address's bytes; told not to, it
    // gets the 302 itself.
    const redirecting = (async (input: unknown, init?: RequestInit) => {
      asked.push({ url: String(input), redirect: init?.redirect });
      if (init?.redirect === "manual") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
      return new Response(image, { status: 200, headers: { "content-type": "image/jpeg" } });
    }) as typeof fetch;
    const hq = "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg";
    assert.equal(await copyThumbnail({ thumbnailUrl: hq, tenantId: OASIS, ref, upload, fetchImpl: redirecting }), null);
    assert.deepEqual(uploads, [], "a redirected thumbnail was saved to the public prefix");
    assert.deepEqual(asked, [{ url: hq, redirect: "manual" }], "the thumbnail fetch follows redirects");
    // An off-list host, plain http, or a lookalike host is never fetched at all.
    asked.length = 0;
    for (const url of ["https://evil.test/x.jpg", "http://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", "https://i.ytimg.com.evil.test/x.jpg"]) {
      assert.equal(await copyThumbnail({ thumbnailUrl: url, tenantId: OASIS, ref, upload, fetchImpl: redirecting }), null, url);
    }
    assert.deepEqual(asked, [], "an off-list thumbnail URL was fetched");
    // The provider's own image: copied under this workspace's offer-pages prefix.
    const direct = (async () => new Response(image, { status: 200, headers: { "content-type": "image/jpeg" } })) as typeof fetch;
    assert.equal(await copyThumbnail({ thumbnailUrl: hq, tenantId: OASIS, ref, upload, fetchImpl: direct }), `${OASIS}/offer-pages/youtube-dQw4w9WgXcQ.jpg`);
    assert.deepEqual(uploads, [`${OASIS}/offer-pages/youtube-dQw4w9WgXcQ.jpg`]);
  });

  done("offer-pages-video-sign");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
