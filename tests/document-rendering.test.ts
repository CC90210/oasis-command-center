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
assert.match(access, /startsWith\(expectedPrefix\)/);

console.log("ok document MIME recovery, preview fallbacks, authenticated streaming, and access guards");
