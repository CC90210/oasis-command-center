/**
 * tests/worker-composition.test.ts - the bundle composition report adds up and groups correctly.
 *
 * scripts/worker-composition.mjs reads either an esbuild bundle that keeps a `// <source path>`
 * comment before every module, or the directory OpenNext assembles for the handler, and attributes
 * the bytes to a package or directory. A grouping bug would send the next bundle diet after the
 * wrong dependency, so the rules are pinned here on synthetic inputs.
 *
 * Run: node --conditions=react-server --import tsx tests/worker-composition.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error - a plain .mjs script with no type declarations
import { groupOf, measure, measureMeta, measureTree } from "../scripts/worker-composition.mjs";

// ── grouping rules ──────────────────────────────────────────────────────
assert.equal(groupOf("node_modules/next/dist/server/app-render.js"), "next");
assert.equal(groupOf("node_modules/@scope/pkg/lib/x.mjs"), "@scope/pkg", "a scoped package keeps its scope");
assert.equal(groupOf("node_modules/.pnpm/zod@4.0.0/node_modules/zod/index.js"), "zod", "the last node_modules segment wins");
assert.equal(groupOf(".next/server/chunks/123.js"), "next server chunks");
assert.equal(groupOf(".next/server/app/api/forms/booking/route.js"), "app routes (.next/server/app)");
assert.equal(groupOf(".next/server/pages/_app.js"), "pages routes (.next/server/pages)");
assert.equal(groupOf(".next/server/middleware-manifest.json"), ".next/server (other)");
assert.equal(groupOf("app/api/forms/booking/route.ts"), "app/");
assert.equal(groupOf("single.js"), "(root)");

// ── an esbuild bundle with path headers ─────────────────────────────────
const bundle = [
  "// node_modules/next/dist/server/app-render.js",
  "var a = 1;",
  "// node_modules/.pnpm/zod@4.0.0/node_modules/zod/index.js",
  "var zod = {};",
  "// node_modules/@scope/pkg/lib/x.mjs",
  "var s = 2;",
  "// app/api/forms/booking/route.ts",
  "export const POST = () => 1;",
  "// node_modules/next/dist/server/other.js",
  "var c = 4;",
  "",
].join("\n");
const headers = measure(bundle);
assert.equal(headers.files.size, 5, "one entry per module header");
assert.equal(headers.total, Buffer.byteLength(bundle), "every byte is attributed exactly once");
assert.equal(
  headers.groups.get("next"),
  headers.files.get("node_modules/next/dist/server/app-render.js") + headers.files.get("node_modules/next/dist/server/other.js"),
  "two modules of one package add up",
);
const lead = measure("banner line\n// lib/a.ts\nx\n");
assert.ok(lead.files.has("(before the first module header)"), "text before the first header is not lost");
assert.equal(lead.total, Buffer.byteLength("banner line\n// lib/a.ts\nx\n"));
const crlf = measure("// lib/a.ts\r\nx\r\n");
assert.ok(crlf.files.has("lib/a.ts"), "CRLF headers are found");
const noNewline = measure("// lib/a.ts\nxyz");
assert.equal(noNewline.total, Buffer.byteLength("// lib/a.ts\nxyz"), "no trailing newline: no byte invented");

// ── an esbuild metafile ─────────────────────────────────────────────────
const metafile = {
  inputs: {},
  outputs: {
    "small.js": { bytes: 10, inputs: { "lib/x.ts": { bytesInOutput: 10 } } },
    "handler.mjs": {
      bytes: 6000,
      inputs: {
        "node_modules/zod/index.js": { bytesInOutput: 4000 },
        "node_modules/.pnpm/zod@4/node_modules/zod/v4/core.js": { bytesInOutput: 500 },
        "lib/forms/public-booking.ts": { bytesInOutput: 900 },
        "lib/empty.ts": { bytesInOutput: 0 },
        "app/api/forms/booking/route.ts": { bytesInOutput: 600 },
      },
    },
  },
};
const meta = measureMeta(metafile);
assert.equal(meta.output, "handler.mjs", "the biggest output is the handler");
assert.equal(meta.total, 6000, "only the handler's bytes, each module once");
assert.equal(meta.groups.get("zod"), 4500, "two paths of one package add up");
assert.equal(meta.groups.get("lib/"), 900);
assert.ok(!meta.files.has("lib/empty.ts"), "a module that put nothing in the bundle is not listed");
assert.deepEqual(measureMeta({}).total, 0, "an empty metafile does not throw");

// ── a directory tree, as OpenNext assembles it ──────────────────────────
const root = mkdtempSync(join(tmpdir(), "worker-composition-"));
try {
  const put = (rel: string, size: number) => {
    const full = join(root, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, "x".repeat(size));
  };
  put("node_modules/next/dist/a.js", 1000);
  put("node_modules/next/dist/b.js", 500);
  put("node_modules/@scope/pkg/index.js", 300);
  put(".next/server/chunks/1.js", 700);
  put(".next/server/app/api/forms/booking/route.js", 200);
  put("handler.mjs", 50);
  const tree = measureTree(root);
  assert.equal(tree.total, 1000 + 500 + 300 + 700 + 200 + 50);
  assert.equal(tree.groups.get("next"), 1500);
  assert.equal(tree.groups.get("@scope/pkg"), 300);
  assert.equal(tree.groups.get("next server chunks"), 700);
  assert.equal(tree.groups.get("app routes (.next/server/app)"), 200);
  assert.equal(tree.groups.get("(root)"), 50);
  assert.ok(tree.files.has("node_modules/next/dist/a.js"), "paths are relative with forward slashes");
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log("worker-composition: all passed");
