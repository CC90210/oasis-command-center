/**
 * library-media-self-heal.test.ts - a Library tile whose signed link expired gets ONE fresh link, and only for this
 * workspace's own media.
 * Run: node --conditions=react-server --import tsx tests/library-media-self-heal.test.ts
 *
 * WHY THIS EXISTS
 * CC, 2026-10-19 (through Maven): the newest quote cards showed the browser's broken-image icon. Rows, objects and
 * the Worker's own signed links were all proven good (200 image/png); the tile was a plain lazy <img> of a link that
 * lives one to two hours, with nothing to recover an expired one but a reload.
 *
 * WHAT IS PINNED
 *  1. mediaRefFromSignedUrl reads back exactly the object lib/r2-storage signed (round trip, odd characters
 *     included) and refuses anything that is not one of this Worker's signed R2 links.
 *  2. isTenantLibraryMedia: a media row or a listed carousel slide of THIS workspace; never another workspace's,
 *     never a substring of a listed slide, never a slide path in another bucket.
 *  3. POST /api/founders/marketing/media/resign: 404 outside the founders portal and for another workspace's
 *     object; 400 for a body that is not a signed media link; 200 with a fresh, valid link (no-store) otherwise.
 *  4. resignMediaUrl: one request per link however many elements ask; any failure is null, never a throw.
 *  5. Every Library image and video element is wired to the retry.
 *
 * Real route, real sessions, a local libSQL file (tests/_offer-pages-harness.ts). The R2_* values are test
 * placeholders, not credentials.
 */
import { CLIENT_A, OASIS, USERS, check, finish, login, setupOfferDatabase } from "./_offer-pages-harness";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { r2StorageSurface } from "../lib/r2-storage";
import { isTenantLibraryMedia, mediaRefFromSignedUrl, RESIGN_TTL_SEC } from "../lib/founders/media-resign";

process.env.R2_ACCOUNT_ID = "test-account";
process.env.R2_ACCESS_KEY_ID = "test-key-id";
process.env.R2_SECRET_ACCESS_KEY = "test-secret";
process.env.R2_BUCKET = "test-bucket";
process.env.FOUNDERS_TENANT_IDS = OASIS;

const ROOT = join(__dirname, "..");
const POSTER = `${OASIS}/a1/1792325210602_card-01.1080x1350.png`;
const SLIDES = [`${OASIS}/a2/1_slide-1.png`, `${OASIS}/a2/2_slide-2.png`];
const CLIENT_OBJECT = `${CLIENT_A}/c1/1_client-card.png`;

const sign = async (bucket: string, path: string) =>
  (await r2StorageSurface().from(bucket).createSignedUrl(path, RESIGN_TTL_SEC)).data!.signedUrl;

async function main() {
  console.log("library-media-self-heal");
  const db = await setupOfferDatabase({ migrate: false });
  await db.execute("ALTER TABLE marketing_asset ADD COLUMN media_urls TEXT");
  await db.batch(
    [
      { sql: "INSERT INTO marketing_asset (id, tenant_id, title, format, media_urls) VALUES ('a1', ?, 'Card', 'image', ?)", args: [OASIS, JSON.stringify([POSTER])] },
      { sql: "INSERT INTO marketing_asset (id, tenant_id, title, format, media_urls) VALUES ('a2', ?, 'Deck', 'image', ?)", args: [OASIS, JSON.stringify(SLIDES)] },
      { sql: "INSERT INTO marketing_asset (id, tenant_id, title, format, media_urls) VALUES ('c1', ?, 'Theirs', 'image', ?)", args: [CLIENT_A, JSON.stringify([CLIENT_OBJECT])] },
      { sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path) VALUES ('m1', ?, 'a1', 'image', ?)", args: [OASIS, POSTER] },
      { sql: "INSERT INTO marketing_asset_media (id, tenant_id, asset_id, kind, storage_path) VALUES ('m2', ?, 'c1', 'image', ?)", args: [CLIENT_A, CLIENT_OBJECT] },
    ],
    "write",
  );

  // -- 1. the link, read back ---------------------------------------------------------------------------------------
  await check("a signed link reads back as exactly the object that was signed, odd characters included", async () => {
    const odd = `${OASIS}/a9/it's (v2) caf\u00e9 #1+2.png`;
    for (const path of [POSTER, odd]) {
      assert.deepEqual(mediaRefFromSignedUrl(await sign("marketing-media", path), "test-bucket"), { bucket: "marketing-media", path });
    }
  });

  await check("anything that is not this Worker's signed R2 link is refused", async () => {
    const good = await sign("marketing-media", POSTER);
    const refused: unknown[] = [
      good.replace("https://", "http://"),
      good.replace("test-account.r2.cloudflarestorage.com", "evil.example.com"),
      good.replace("/test-bucket/", "/other-bucket/"),
      "https://test-account.r2.cloudflarestorage.com/test-bucket/marketing-media",
      "https://test-account.r2.cloudflarestorage.com/test-bucket/marketing-media//x.png",
      "https://test-account.r2.cloudflarestorage.com/test-bucket/marketing-media/%E0%A4%A.png",
      `https://test-account.r2.cloudflarestorage.com/test-bucket/marketing-media/${"a".repeat(5000)}.png`,
      "not a url",
      "",
      42,
      null,
      { url: good },
    ];
    for (const raw of refused) assert.equal(mediaRefFromSignedUrl(raw, "test-bucket"), null, String(raw).slice(0, 90));
    assert.equal(mediaRefFromSignedUrl(good, undefined), null, "no configured bucket: nothing parses");
    // Dot segments are resolved by the URL parser before the path is read, so they can never climb out.
    const climbed = mediaRefFromSignedUrl("https://test-account.r2.cloudflarestorage.com/test-bucket/marketing-media/../../x.png", "test-bucket");
    assert.equal(climbed, null);
  });

  // -- 2. whose object ----------------------------------------------------------------------------------------------
  await check("only this workspace's Library media counts: a media row or a listed slide, exactly", async () => {
    const own = (bucket: string, path: string, tenant = OASIS) => isTenantLibraryMedia(db, tenant, { bucket, path });
    assert.equal(await own("marketing-media", POSTER), true, "a media row");
    assert.equal(await own("marketing-media", SLIDES[1]), true, "a slide listed in media_urls");
    assert.equal(await own("marketing-media", CLIENT_OBJECT), false, "another workspace's object");
    assert.equal(await own("marketing-media", CLIENT_OBJECT, CLIENT_A), true, "...which is that workspace's own");
    assert.equal(await own("marketing-media", SLIDES[1].slice(0, -4)), false, "a substring of a listed slide");
    assert.equal(await own("lead-documents", SLIDES[1]), false, "a slide path in another bucket");
    assert.equal(await own("marketing-media", POSTER, ""), false, "no workspace");
  });

  await check("however many assets list the path only as a substring, the one that lists it exactly is found", async () => {
    // CodeRabbit on #706: a row cap before the exact match could leave that asset out of the read.
    const exact = `${OASIS}/a7/1_deck.png`;
    await db.batch(
      [
        ...Array.from({ length: 25 }, (_, i) => ({
          sql: "INSERT INTO marketing_asset (id, tenant_id, title, format, media_urls) VALUES (?, ?, 'Near', 'image', ?)",
          args: [`near-${i}`, OASIS, JSON.stringify([`${exact}.v${i}.png`])],
        })),
        { sql: "INSERT INTO marketing_asset (id, tenant_id, title, format, media_urls) VALUES ('a7', ?, 'Deck', 'image', ?)", args: [OASIS, JSON.stringify([exact])] },
      ],
      "write",
    );
    assert.equal(await isTenantLibraryMedia(db, OASIS, { bucket: "marketing-media", path: exact }), true);
  });

  // -- 3. the route -------------------------------------------------------------------------------------------------
  const route = await import("../app/api/founders/marketing/media/resign/route");
  const post = (body: unknown) =>
    route.POST(
      new Request("http://localhost/api/founders/marketing/media/resign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  await check("outside the founders portal the route is not there: signed out and a sales seat get 404", async () => {
    const url = await sign("marketing-media", POSTER);
    for (const user of [null, USERS.rep]) {
      await login(user);
      const res = await post({ url });
      assert.equal(res.status, 404, user?.email ?? "signed out");
      assert.equal(((await res.json()) as { error: string }).error, "not_found");
    }
  });

  await check("an owner gets a fresh, valid link for their own poster and slides, never cached", async () => {
    await login(USERS.cc);
    for (const path of [POSTER, SLIDES[0]]) {
      const res = await post({ url: await sign("marketing-media", path) });
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const body = (await res.json()) as { ok: boolean; url: string };
      assert.equal(body.ok, true);
      assert.deepEqual(mediaRefFromSignedUrl(body.url, "test-bucket"), { bucket: "marketing-media", path });
      assert.ok(new URL(body.url).searchParams.get("X-Amz-Signature"), "a signed link");
    }
  });

  await check("another workspace's object, and a body that is not a media link, sign nothing", async () => {
    await login(USERS.cc);
    const theirs = await post({ url: await sign("marketing-media", CLIENT_OBJECT) });
    assert.equal(theirs.status, 404, "not this workspace's");
    for (const [body, error] of [
      ["{not json", "invalid_json"],
      [{ url: "https://example.com/x.png" }, "not_a_media_link"],
      [{}, "not_a_media_link"],
      [JSON.stringify({ url: "x".repeat(6000) }), "too_large"],
    ] as const) {
      const res = await post(body);
      assert.equal(res.status, 400, error);
      assert.equal(((await res.json()) as { error: string }).error, error);
    }
    assert.equal((await route.GET()).status, 404, "other verbs answer 404, not 405");
  });

  // -- 4. the client's request --------------------------------------------------------------------------------------
  await check("resignMediaUrl asks once per link however many elements fail on it, and never throws", async () => {
    const { resignMediaUrl, RESIGN_ROUTE } = await import("../components/founders/SignedMedia");
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    let answer: () => Promise<Response> = async () => Response.json({ ok: true, url: "https://fresh" });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${String(input)} ${String(init?.body)}`);
      return answer();
    }) as typeof fetch;
    try {
      const [a, b] = await Promise.all([resignMediaUrl("https://old"), resignMediaUrl("https://old")]);
      assert.deepEqual([a, b], ["https://fresh", "https://fresh"]);
      assert.deepEqual(calls, [`${RESIGN_ROUTE} {"url":"https://old"}`]);
      for (const failing of [
        async () => new Response("no", { status: 404 }),
        async () => Response.json({ ok: false, error: "sign_failed" }),
        async () => Response.json({ ok: true, url: 42 }),
        async () => new Response("not json", { status: 200 }),
        async () => {
          throw new Error("offline");
        },
      ]) {
        answer = failing;
        assert.equal(await resignMediaUrl(`https://old-${calls.length}`), null);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await check("the hook retries an expired link once, then says so in plain words (tests/library-media-self-heal.render.ts)", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/library-media-self-heal.render.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120_000,
      // CI exports --conditions=react-server in NODE_OPTIONS, which the child would inherit and load React's server
      // build with no client hooks (it passed locally and failed in CI, CodeRabbit on #706). Same filter as
      // tests/library-review.test.ts: drop only the condition, keep any other option.
      env: {
        ...process.env,
        NODE_OPTIONS: (process.env.NODE_OPTIONS || "")
          .split(/\s+/)
          .filter((t) => t && !/^(--conditions|-C)(=|$)/.test(t) && t !== "react-server")
          .join(" "),
      },
    });
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.trim().slice(-1500));
    assert.match(r.stdout, /library-media-self-heal\.render: all passed/);
  });

  // -- 5. the wiring -------------------------------------------------------------------------------------------------
  await check("every Library image and video element retries through the one hook", () => {
    const src = (p: string) => readFileSync(join(ROOT, p), "utf8");
    // Every surface that draws a signed Library link (Codex on #706 found three the first cut missed: the pack
    // comparison, the asset page's image and the slide-order thumbnails).
    const SURFACES = [
      "components/founders/marketing-shared.tsx",
      "components/founders/CarouselFrame.tsx",
      "components/founders/TileVideo.tsx",
      "components/founders/HookCompare.tsx",
      "components/founders/SlideReorder.tsx",
      // Extracted videos' late-mounting player (audit, 2026-10-26): it mounts after the page, so its link is the likeliest to have expired.
      "components/founders/LazyVideo.tsx",
      "app/founders/marketing/asset/[id]/page.tsx",
      "components/founders/SignedMedia.tsx",
    ];
    for (const p of SURFACES) {
      // A JSX <img> or <video> element (comment lines start with * or //, so they never match).
      const elements = [...src(p).matchAll(/^\s*<(img|video)\b[\s\S]*?\/>/gm)].map((m) => m[0]);
      for (const el of elements) assert.match(el, /onError=\{/, `${p}: a <${el.trim().slice(1, 6)}...> with no retry`);
    }
    const shared = src("components/founders/marketing-shared.tsx");
    const video = src("components/founders/TileVideo.tsx");
    assert.match(shared, /<SignedImg\s+src=\{posterUrl\}/, "the tile's poster");
    assert.match(src("components/founders/CarouselFrame.tsx"), /<SignedImg\s+src=\{slides\[at\]\}/, "a carousel's image slide");
    assert.match(src("components/founders/SlideReorder.tsx"), /<SignedImg\s+src=\{slideUrls\[slideIdx\]\}/, "a slide-order thumbnail");
    assert.match(src("app/founders/marketing/asset/[id]/page.tsx"), /<SignedImg src=\{imageUrl\}/, "the asset page's image");
    const compare = src("components/founders/HookCompare.tsx");
    assert.match(compare, /const media = useSignedVideos\(/, "one hook for every compared card");
    assert.match(compare, /src=\{media\.src\(card\.playbackUrl\) \?\? undefined\}[\s\S]*onError=\{\(\) => media\.onError\(card\.playbackUrl\)\}/, "a compared clip");
    assert.match(compare, /src=\{media\.src\(card\.posterUrl\) \?\? undefined\}[\s\S]*onError=\{\(\) => media\.onError\(card\.posterUrl\)\}/, "a compared cover");
    assert.match(video, /const video = useSignedVideo\(src, \(\) => ref\.current, \(\) => setPaused\(true\)\);/);
    assert.match(video, /const poster = useSignedSrc\(posterUrl\);/);
    assert.match(video, /src=\{video\.src \?\? undefined\}[\s\S]*onError=\{video\.onError\}/, "the player");
    assert.match(video, /src=\{poster\.src \?\? undefined\}[\s\S]*onError=\{poster\.onError\}/, "the cover");
    for (const p of ["components/founders/SignedMedia.tsx", "lib/founders/media-resign.ts", "app/api/founders/marketing/media/resign/route.ts", "tests/library-media-self-heal.test.ts", "tests/library-media-self-heal.render.ts"]) {
      assert.ok(![...src(p)].some((c) => c.charCodeAt(0) > 127), `${p} is ASCII`);
    }
  });

  finish("library-media-self-heal");
}

main();
