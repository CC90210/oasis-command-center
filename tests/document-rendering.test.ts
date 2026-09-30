import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import {
  documentPreviewKind,
  imageNeedsBrowserSafeConversion,
  normalizedDocumentMime,
} from "../lib/document-preview";

assert.equal(normalizedDocumentMime("statement.PDF", null), "application/pdf");
assert.equal(normalizedDocumentMime("license.jpg", "application/octet-stream"), "image/jpeg");
assert.equal(normalizedDocumentMime("statement", "application/pdf; charset=binary"), "application/pdf");
assert.equal(documentPreviewKind("statement.pdf", null), "pdf");
assert.equal(documentPreviewKind("license.HEIC", null), "image");
assert.equal(documentPreviewKind("notes.csv", null), "text");
assert.equal(documentPreviewKind("archive.docx", null), "download");
assert.equal(imageNeedsBrowserSafeConversion("image/heic"), true);
assert.equal(imageNeedsBrowserSafeConversion("image/tiff"), true);
assert.equal(imageNeedsBrowserSafeConversion("image/png"), false);
assert.equal(imageNeedsBrowserSafeConversion("image/jpeg; charset=binary"), false);

const root = path.resolve(import.meta.dirname, "..");
const metadataRoute = fs.readFileSync(
  path.join(root, "app/api/lead-documents/[id]/route.ts"),
  "utf8",
);
const contentRoute = fs.readFileSync(
  path.join(root, "app/api/lead-documents/[id]/content/route.ts"),
  "utf8",
);
const access = fs.readFileSync(path.join(root, "lib/lead-document-access.ts"), "utf8");

assert.match(metadataRoute, /\/content/);
assert.match(metadataRoute, /download_url/);
assert.doesNotMatch(metadataRoute, /createSignedUrl/);
assert.match(contentRoute, /getAuthorizedLeadDocument/);
assert.match(contentRoute, /req\.headers\.get\("range"\)/);
assert.match(contentRoute, /content-range/);
assert.match(contentRoute, /import\("sharp"\)/);
assert.match(contentRoute, /searchParams\.get\("download"\)/);
// #355 moved both guards to shared modules. The parent-lead check is the same
// read boundary every lead route uses (manager policy included), and the
// tenant-prefix check lives in the path normaliser, which
// tests/lead-document-path.test.ts exercises with hostile paths.
assert.match(access, /await getReadableLeadTargetForSession\(session,/);
assert.match(access, /if \(!parentTarget\) return \{ ok: false, status: 404/);

// The tenant-prefix refusal, driven for real: a row whose stored path, or
// whose active watermarked copy, sits outside the caller's tenant prefix is
// refused with 403 even though the row itself carries the caller's tenant_id.
// Checking only that the normaliser is called let the refusal after it be
// deleted with every test green. Run against a real local libSQL file.
const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "document-access-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
const r2Base = "https://pub-documents.r2.dev";
process.env.R2_PUBLIC_BASE_URL = r2Base;

async function storagePathRefusal() {
  const db = createClient({ url: `file:${dbFile}` });
  await db.execute(
    `CREATE TABLE lead_documents (
       id TEXT PRIMARY KEY, tenant_id TEXT, lead_id TEXT, filename TEXT,
       storage_path TEXT, mime_type TEXT, metadata TEXT)`,
  );
  const rows: Array<[string, string, string, Record<string, unknown>]> = [
    ["doc-own", "tenant-a", "tenant-a/lead/own.pdf", {}],
    ["doc-other-prefix", "tenant-a", "tenant-b/lead/theirs.pdf", {}],
    ["doc-other-url", "tenant-a", `${r2Base}/lead-documents/tenant-b/lead/theirs.pdf`, {}],
    ["doc-own-url", "tenant-a", `${r2Base}/lead-documents/tenant-a/lead/own.pdf`, {}],
    ["doc-wm-other", "tenant-a", "tenant-a/lead/clean.pdf", { active_variant: "watermarked", shopout_wm_path: "tenant-b/lead/wm.pdf" }],
    ["doc-wm-own", "tenant-a", "tenant-a/lead/clean.pdf", { active_variant: "watermarked", shopout_wm_path: "tenant-a/lead/wm.pdf" }],
    ["doc-tenant-b", "tenant-b", "tenant-b/lead/theirs.pdf", {}],
  ];
  for (const [id, tenantId, storagePath, metadata] of rows) {
    await db.execute({
      sql: `INSERT INTO lead_documents (id, tenant_id, lead_id, filename, storage_path, mime_type, metadata)
            VALUES (?, ?, NULL, 'statement.pdf', ?, 'application/pdf', ?)`,
      args: [id, tenantId, storagePath, JSON.stringify(metadata)],
    });
  }

  const { getAuthorizedLeadDocument } = await import("../lib/lead-document-access");
  // An admin reads a document with no parent lead, so the only guard left
  // between the row and its bytes is the storage-path check under test.
  const session = { tenantId: "tenant-a", teamRole: "admin", isAdmin: true, userId: "user-a" };
  const read = (id: string) => getAuthorizedLeadDocument(session, id);

  const own = await read("doc-own");
  assert.ok(own.ok, "a path under the caller's own prefix is served");
  assert.strictEqual(own.ok && own.document.activePath, "tenant-a/lead/own.pdf");
  const ownUrl = await read("doc-own-url");
  assert.strictEqual(ownUrl.ok && ownUrl.document.activePath, "tenant-a/lead/own.pdf", "a legacy R2 URL under the caller's prefix is served");

  for (const id of ["doc-other-prefix", "doc-other-url"]) {
    assert.deepStrictEqual(
      await read(id),
      { ok: false, status: 403, error: "storage_path_mismatch" },
      `${id}: a stored path under another tenant's prefix is refused`,
    );
  }
  assert.deepStrictEqual(
    await read("doc-wm-other"),
    { ok: false, status: 403, error: "storage_path_mismatch" },
    "an active watermarked copy under another tenant's prefix is refused",
  );
  const wmOwn = await read("doc-wm-own");
  assert.strictEqual(wmOwn.ok && wmOwn.document.activePath, "tenant-a/lead/wm.pdf", "the caller's own watermarked copy is served");
  assert.strictEqual(wmOwn.ok && wmOwn.document.activeVariant, "watermarked");

  assert.deepStrictEqual(
    await read("doc-tenant-b"),
    { ok: false, status: 404, error: "not_found" },
    "another tenant's row is not found at all",
  );
}

storagePathRefusal().then(
  () => console.log("ok document MIME recovery, preview fallbacks, authenticated streaming, and access guards"),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
