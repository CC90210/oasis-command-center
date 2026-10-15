/**
 * tests/worker-composition.test.ts - the bundle composition report adds up and groups correctly.
 *
 * scripts/worker-composition.mjs reads OpenNext's handler.mjs (an esbuild bundle with a
 * `// <source path>` comment before every module) and attributes the bytes after each header
 * to a package or directory. A grouping bug would send the next bundle diet after the wrong
 * dependency, so the rules are pinned here on a synthetic bundle.
 *
 * Run: node --conditions=react-server --import tsx tests/worker-composition.test.ts
 */
import assert from "node:assert/strict";
// @ts-expect-error - a plain .mjs script with no type declarations
import { groupOf, measure } from "../scripts/worker-composition.mjs";

const bundle = [
  "// node_modules/next/dist/server/app-render.js",
  "var a = 1;",
  "// node_modules/.pnpm/zod@4.0.0/node_modules/zod/index.js",
  "var zod = {};",
  "// node_modules/@scope/pkg/lib/x.mjs",
  "var s = 2;",
  "// app/api/forms/booking/route.ts",
  "export const POST = () => 1;",
  "// lib/forms/public-booking.ts",
  "export const b = 3;",
  "// node_modules/next/dist/server/other.js",
  "var c = 4;",
  "",
].join("\n");

const { files, groups, total } = measure(bundle);

assert.equal(groupOf("node_modules/next/dist/server/app-render.js"), "next");
assert.equal(groupOf("node_modules/@scope/pkg/lib/x.mjs"), "@scope/pkg", "a scoped package keeps its scope");
assert.equal(groupOf("node_modules/.pnpm/zod@4.0.0/node_modules/zod/index.js"), "zod", "the last node_modules segment wins");
assert.equal(groupOf("app/api/forms/booking/route.ts"), "app/");
assert.equal(groupOf("lib/forms/public-booking.ts"), "lib/");
assert.equal(groupOf("single.js"), "(root)");

assert.equal(files.size, 6, "one entry per module header");
assert.equal(total, Buffer.byteLength(bundle) - 0, "every byte of the bundle is attributed once");
assert.equal(groups.get("next"), files.get("node_modules/next/dist/server/app-render.js") + files.get("node_modules/next/dist/server/other.js"), "two modules of one package add up");
assert.ok((groups.get("app/") ?? 0) > 0 && (groups.get("lib/") ?? 0) > 0);

// Text before the first header is not lost.
const lead = measure("banner line\n// lib/a.ts\nx\n");
assert.ok(lead.files.has("(before the first module header)"));
assert.equal(lead.total, Buffer.byteLength("banner line\n// lib/a.ts\nx\n"));

console.log("worker-composition: all passed");
