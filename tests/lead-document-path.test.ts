import assert from "node:assert/strict";
import { normalizeLeadDocumentStoragePath } from "../lib/lead-document-path";

const tenant = "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";
const base = "https://pub-d5766f0ed61d4694b9fe1d65ac34f1ec.r2.dev";
const key = `${tenant}/lead/statement%20one.pdf`;

assert.equal(normalizeLeadDocumentStoragePath(key, tenant, base), key);
assert.equal(
  normalizeLeadDocumentStoragePath(`${base}/lead-documents/${key}`, tenant, base),
  `${tenant}/lead/statement one.pdf`,
);
assert.equal(
  normalizeLeadDocumentStoragePath(`https://attacker.example/lead-documents/${key}`, tenant, base),
  null,
);
assert.equal(
  normalizeLeadDocumentStoragePath(`${base}/chat-attachments/${key}`, tenant, base),
  null,
);
assert.equal(
  normalizeLeadDocumentStoragePath(`${base}/lead-documents/other-tenant/file.pdf`, tenant, base),
  null,
);
assert.equal(
  normalizeLeadDocumentStoragePath(`${base}/lead-documents/${tenant}/../other/file.pdf`, tenant, base),
  null,
);

console.log("lead document path normalization ok");
