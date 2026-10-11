/**
 * tenant-logo-display.test.ts - an uploaded workspace logo is drawn from an
 * address that works on every surface (2026-10-11, Adon: the logo showed in
 * no preview and as a broken image on the public offer page).
 *
 * Root cause, measured: tenants.logo_url for OASIS held
 * https://pub-<id>.r2.dev/tenant-assets/<tenant>/<file>, which answered 404.
 * The upload wrote the object through the S3 API into the private bucket; the
 * r2.dev host does not serve it.
 *
 * Pinned here:
 *   1. displayLogoUrl reads every stored shape of a tenant-assets URL back to
 *      the first-party route, leaves a typed absolute URL or a first-party path
 *      alone, and draws nothing for any other value.
 *   2. the route serves ONLY images in the tenant-assets prefix: the prefix is
 *      fixed (another one cannot be named), the path is strict, the bytes are
 *      sniffed, the size is capped; a missing object is 404 and a failing
 *      store is 503 no-store, never a cached "not found".
 *   3. the upload route stores the first-party address, never getPublicUrl's.
 *   4. the surfaces that draw the logo use SafeLogo (no broken-image icon).
 *
 * Run: node --conditions=react-server --import tsx tests/tenant-logo-display.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayLogoUrl, tenantAssetPathFromUrl, TENANT_ASSET_ROUTE } from "../lib/tenant/logo-url";
import { sniffImageType, tenantAssetResponse, MAX_ASSET_BYTES } from "../lib/tenant/tenant-asset-response";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const FILE = "1791314337685_Oasisai_Logo.jpg";
const ROUTE = `${TENANT_ASSET_ROUTE}/${OASIS}/${FILE}`;

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err instanceof Error ? err.message : String(err)}`);
  }
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const HTML = new TextEncoder().encode("<html><script>alert(1)</script></html>");
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

type Calls = Array<[string, string]>;
function store(answer: (bucket: string, path: string) => { data: Blob | null; error: { message?: string; status?: number } | null } | Error) {
  const calls: Calls = [];
  const download = async (bucket: string, path: string) => {
    calls.push([bucket, path]);
    const a = answer(bucket, path);
    if (a instanceof Error) throw a;
    return a;
  };
  return { calls, download };
}
const blob = (b: Uint8Array) => new Blob([b]);

async function main() {
  console.log("tenant-logo-display:");

  await check("OASIS's stored r2.dev address is drawn from the first-party route", () => {
    assert.equal(displayLogoUrl(`https://pub-878de78813fd4787814a5b2cf6b1e0fa.r2.dev/tenant-assets/${OASIS}/${FILE}`), ROUTE);
  });

  await check("every other stored shape of a tenant-assets object reads back to the same route", () => {
    // A signed R2 URL (getPublicUrl without a public base), path-style.
    assert.equal(
      displayLogoUrl(`https://acct.r2.cloudflarestorage.com/oasis-storage/tenant-assets/${OASIS}/${FILE}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`),
      ROUTE,
    );
    // A Supabase public URL written before the R2 cutover.
    assert.equal(displayLogoUrl(`https://x.supabase.co/storage/v1/object/public/tenant-assets/${OASIS}/${FILE}`), ROUTE);
    // The route itself (what the upload stores from now on), absolute or not.
    assert.equal(displayLogoUrl(ROUTE), ROUTE);
    assert.equal(displayLogoUrl(`https://oasisai.work${ROUTE}`), ROUTE);
    // An offer page's thumbnail, one folder deeper.
    assert.equal(displayLogoUrl(`https://pub-1.r2.dev/tenant-assets/${OASIS}/offer-pages/youtube-dQw4w9WgXcQ.jpg`), `${TENANT_ASSET_ROUTE}/${OASIS}/offer-pages/youtube-dQw4w9WgXcQ.jpg`);
  });

  await check("a typed absolute URL and a first-party path are left alone", () => {
    assert.equal(displayLogoUrl("https://oasisai.work/brand/oasis-mark.png"), "https://oasisai.work/brand/oasis-mark.png");
    assert.equal(displayLogoUrl("/brand/sunbiz-logo.png"), "/brand/sunbiz-logo.png");
    assert.equal(displayLogoUrl("  https://cdn.example.com/logo.png  "), "https://cdn.example.com/logo.png");
  });

  await check("anything else draws no logo at all", () => {
    for (const bad of [null, undefined, "", "   ", "javascript:alert(1)", "data:image/png;base64,AAAA", "//evil.example/logo.png", "/\\evil.example", "logo.png", 42]) {
      assert.equal(displayLogoUrl(bad), null, String(bad));
    }
  });

  await check("a tenant-assets URL that is not <tenant uuid>/<file> is never rewritten to the route", () => {
    for (const bad of [
      "https://pub-1.r2.dev/tenant-assets/not-a-uuid/logo.png",
      `https://pub-1.r2.dev/tenant-assets/${OASIS}`,
      `https://pub-1.r2.dev/tenant-assets/${OASIS}/a/b/c/logo.png`,
      `https://pub-1.r2.dev/tenant-assets/${OASIS}/.hidden`,
      `https://pub-1.r2.dev/tenant-assets/${OASIS}/a%2F..%2Flead-documents`,
    ]) {
      assert.equal(tenantAssetPathFromUrl(bad), null, bad);
    }
  });

  await check("the route serves a PNG, JPEG, GIF and WebP as an inert image", async () => {
    for (const [bytes, type] of [[PNG, "image/png"], [JPEG, "image/jpeg"], [GIF, "image/gif"], [WEBP, "image/webp"]] as const) {
      const s = store(() => ({ data: blob(bytes), error: null }));
      const res = await tenantAssetResponse([OASIS, FILE], s.download);
      assert.equal(res.status, 200, type);
      assert.equal(res.headers.get("content-type"), type);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
      assert.match(res.headers.get("cache-control") ?? "", /^public/);
      assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
      assert.deepEqual(s.calls, [["tenant-assets", `${OASIS}/${FILE}`]], "always the tenant-assets prefix, exactly this key");
    }
  });

  await check("bytes that are not a raster image are never served, whatever the name says", async () => {
    for (const bytes of [HTML, SVG, new Uint8Array([1, 2, 3])]) {
      const s = store(() => ({ data: blob(bytes), error: null }));
      const res = await tenantAssetResponse([OASIS, "logo.png"], s.download);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("content-type"), null, "no body type for a refusal");
    }
    assert.equal(sniffImageType(SVG), null);
  });

  await check("no other prefix of the private bucket can be named, and a bad path never reaches the store", async () => {
    for (const segments of [
      ["lead-documents", OASIS, "statement.pdf"],
      [OASIS],
      [OASIS, ".."],
      [OASIS, "..", "lead-documents"],
      [OASIS, "a", "b", "c"],
      ["..", "lead-documents", "x.pdf"],
      [],
    ]) {
      const s = store(() => ({ data: blob(PNG), error: null }));
      const res = await tenantAssetResponse(segments, s.download);
      assert.equal(res.status, 404, segments.join("/"));
      assert.equal(s.calls.length, 0, `${segments.join("/")} reached the store`);
    }
  });

  await check("a missing object is 404; a failing or absent store is 503 and never cached", async () => {
    const missing = await tenantAssetResponse([OASIS, FILE], store(() => ({ data: null, error: { message: "R2 download failed (404)", status: 404 } })).download);
    assert.equal(missing.status, 404);
    const failing = await tenantAssetResponse([OASIS, FILE], store(() => ({ data: null, error: { message: "R2 download failed (500)", status: 500 } })).download);
    assert.equal(failing.status, 503);
    assert.equal(failing.headers.get("cache-control"), "no-store");
    const thrown = await tenantAssetResponse([OASIS, FILE], store(() => new Error("no object store")).download);
    assert.equal(thrown.status, 503);
    assert.equal(thrown.headers.get("cache-control"), "no-store");
  });

  await check("an object over the cap is refused", async () => {
    const big = new Uint8Array(MAX_ASSET_BYTES + 1);
    big.set(PNG);
    const res = await tenantAssetResponse([OASIS, FILE], store(() => ({ data: blob(big), error: null })).download);
    assert.equal(res.status, 404);
  });

  await check("the upload route stores the first-party address, never getPublicUrl's", () => {
    const src = read("app/api/tenant/logo/route.ts");
    assert.doesNotMatch(src, /getPublicUrl\(/, "getPublicUrl gave the r2.dev address that answered 404");
    assert.match(src, /const publicUrl = tenantAssetUrl\(storagePath\);/);
    assert.match(src, /update\(\{ logo_url: publicUrl \}\)/);
  });

  await check("every surface that draws the logo goes through the same address and SafeLogo", () => {
    for (const page of ["app/f/[tenant_slug]/[form_slug]/page.tsx", "app/f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx"]) {
      assert.match(read(page), /displayLogoUrl\(branding\.logo_url\)/, page);
    }
    assert.match(read("components/settings/BrandLogoCard.tsx"), /displayLogoUrl\(logoUrl\)/);
    assert.match(read("components/forms/FormBuilderClient.tsx"), /<SafeLogo src=\{displayLogoUrl\(branding\.logo_url\)\}/);
    for (const surface of ["components/forms/FormPublicClient.tsx", "components/offer-pages/OfferNav.tsx", "components/settings/BrandLogoCard.tsx"]) {
      const src = read(surface);
      assert.match(src, /<SafeLogo/, surface);
      assert.doesNotMatch(src, /<img\s/, `${surface} draws a bare <img> that shows a broken-image icon`);
    }
  });

  if (failed) {
    console.error(`tenant-logo-display: ${failed} failed`);
    process.exit(1);
  }
  console.log("tenant-logo-display: all passed");
}

void main();
