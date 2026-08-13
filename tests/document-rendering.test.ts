import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
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
assert.match(access, /canViewLead/);
// The tenant-prefix containment check used to be inline here as
// `startsWith(expectedPrefix)`. It was extracted to lib/lead-document-path.ts,
// so asserting on that literal was testing where the code lives rather than
// that it runs, and it broke on the move while the guard itself was untouched.
// Assert the access path still DELEGATES to the guard, and assert the guard's
// own content where it actually lives.
assert.match(access, /normalizeLeadDocumentStoragePath/);
assert.match(access, /storage_path_mismatch/);
const documentPath = fs.readFileSync(
  path.join(root, "lib/lead-document-path.ts"),
  "utf8",
);
assert.match(documentPath, /startsWith\(expectedPrefix\)/);
assert.match(documentPath, /\.\./, "path traversal rejection must survive refactors");

console.log("ok document MIME recovery, preview fallbacks, authenticated streaming, and access guards");
