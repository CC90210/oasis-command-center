import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const submit = fs.readFileSync(path.join(root, "app/api/forms/submit/route.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "components/forms/FormPublicClient.tsx"), "utf8");
const dropzone = fs.readFileSync(path.join(root, "components/forms/MultiFileDropzone.tsx"), "utf8");

assert.match(submit, /initialize_only\?: boolean/);
assert.match(submit, /field\.type === "file_upload_multi"/);
assert.match(submit, /initialization_not_required/);
assert.match(submit, /initialized: true/);
assert.match(client, /const ensureUploadToken = useCallback/);
assert.match(client, /tokenInitPromiseRef/);
assert.match(client, /initialize_only: true/);
assert.match(client, /prefill \|\| \{\}/);
assert.match(client, /all\.owner_cell/);
assert.match(dropzone, /uploadToken \|\| \(await ensureUploadToken\?\.\(\)\)/);
assert.doesNotMatch(dropzone, /if \(!uploadToken\) \{/);

console.log("forms upload bootstrap and contact-prefill resilience ok");
