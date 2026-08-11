/**
 * Do the R2 adapter's upload paths actually work against the real bucket?
 *
 * createSignedUploadUrl and info were MISSING from the adapter while two live
 * paths called them: the public SunBiz lead form (a prospect uploading bank
 * statements) and chat attachments. Both hand a signed URL to the browser and
 * never proxy the bytes, so with `.storage` pointed at R2 the call was simply
 * undefined — a TypeError, not an error result.
 *
 * A type-check cannot catch that (the surface is typed as SupabaseClient, which
 * has both), and neither can a mock. So this signs a URL, PUTs to it the way a
 * BROWSER would — no credentials, nothing but the signature — then reads it
 * back and cleans up.
 *
 *   npx tsx scripts/verify-r2-upload.ts
 */
import { randomUUID } from "node:crypto";

import { r2Configured, r2StorageSurface } from "../lib/r2-storage";

let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

async function main() {
  if (!r2Configured()) {
    console.error("R2 is not configured in this environment — nothing proven.");
    process.exit(2);
  }

  const bucket = "lead-documents";
  const path = `_verify/${randomUUID()}.txt`;
  const body = `r2 adapter verification ${new Date().toISOString()}`;
  const store = r2StorageSurface().from(bucket);

  console.log("surface exposes the methods the app calls");
  for (const m of ["upload", "download", "createSignedUrl", "createSignedUploadUrl",
                   "info", "remove", "list", "getPublicUrl"]) {
    check(`.${m}()`, typeof (store as Record<string, unknown>)[m] === "function");
  }

  console.log("\ndirect upload, exactly as the browser does it");
  const signed = await store.createSignedUploadUrl(path);
  check("createSignedUploadUrl returns data", !signed.error && !!signed.data,
        signed.error?.message ?? "");
  check("returns path + signedUrl + token",
        !!signed.data?.path && !!signed.data?.signedUrl && !!signed.data?.token);

  if (signed.data?.signedUrl) {
    // No auth header on purpose: if this needs credentials, the browser cannot
    // use it and the whole path is still broken.
    const put = await fetch(signed.data.signedUrl, {
      method: "PUT",
      body,
      headers: { "content-type": "text/plain" },
    });
    check("unauthenticated PUT to the signed URL succeeds", put.ok,
          `HTTP ${put.status}${put.ok ? "" : " " + (await put.text()).slice(0, 140)}`);
  }

  console.log("\nthe object is really there");
  const info = await store.info(path);
  check("info() finds it", !info.error && !!info.data, info.error?.message ?? "");
  check("info() reports the right size",
        info.data?.size === Buffer.byteLength(body),
        `${info.data?.size} vs ${Buffer.byteLength(body)}`);
  check("info() reports a content type", !!info.data?.contentType,
        String(info.data?.contentType));

  const dl = await store.download(path);
  const text = dl.data ? await (dl.data as Blob).text() : "";
  check("download() returns the same bytes", text === body,
        text === body ? "" : `got ${JSON.stringify(text.slice(0, 60))}`);

  console.log("\nmissing objects fail as an error result, not a throw");
  const missing = await store.info(`_verify/definitely-not-here-${randomUUID()}`);
  check("info() on a missing key returns {error}, does not throw",
        !!missing.error && !missing.data, missing.error?.message ?? "");

  console.log("\ncleanup");
  const rm = await store.remove([path]);
  check("remove() succeeds", !rm.error, rm.error?.message ?? "");
  const gone = await store.info(path);
  check("object is gone afterwards", !!gone.error);

  console.log(failures ? `\n${failures} FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("threw:", e);
  process.exit(1);
});
