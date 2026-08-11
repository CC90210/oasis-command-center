import assert from "node:assert/strict";
import { shopOutCleanFallback } from "../lib/lead-documents";

const original = {
  filename: "statement.pdf",
  storage_path: "tenant/lead/_shopout_wm/doc_v3.pdf",
  original_path: "tenant/lead/statement.pdf",
  mime_type: "application/pdf",
};

const fallback = shopOutCleanFallback(
  original,
  original.original_path,
  "renderer_temporarily_unavailable",
);

assert.equal(fallback.filename, original.filename);
assert.equal(fallback.storage_path, "tenant/lead/statement.pdf");
assert.equal(fallback.original_path, "tenant/lead/statement.pdf");
assert.equal(fallback.mime_type, "application/pdf");
assert.equal((fallback as Record<string, unknown>).watermark_status, "fallback_clean");
assert.equal(
  (fallback as Record<string, unknown>).watermark_error,
  "renderer_temporarily_unavailable",
);

console.log("shop-out clean watermark fallback ok");
