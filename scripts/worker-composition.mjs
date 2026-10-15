#!/usr/bin/env node
/**
 * scripts/worker-composition.mjs - what the Worker bundle is made of.
 *
 * The Worker upload is at ~99% of Cloudflare's 64 MiB cap (ci.yml budget, check-worker-bundle.ts),
 * so "which dependency or route made it grow" is the question every large feature now has to
 * answer. OpenNext's handler.mjs is one esbuild bundle that keeps a `// <source path>` comment
 * before each module; this reads it and adds up the bytes after every such header, grouped by
 * package (node_modules/<pkg>) or by app directory. No dependencies, no build needed beyond the one
 * that produced the handler.
 *
 *   node scripts/worker-composition.mjs [handler.mjs] [--top N]
 *
 * Default input: .open-next/server-functions/default/handler.mjs. Always exits 0 (diagnostic only):
 * it prints, it does not gate. Sizes are bytes of source in the bundle, before wrangler's own
 * bundling of worker.js, so read them as a ranking, not as the exact upload size.
 */
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const topFlag = args.indexOf("--top");
const TOP = topFlag >= 0 ? Number(args[topFlag + 1]) || 30 : 30;
const input =
  args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--top") ||
  ".open-next/server-functions/default/handler.mjs";

/** esbuild's module header: `// node_modules/pkg/index.js`, `// app/page.tsx`. */
const HEADER = /^\/\/ ([^\s][^\n]*\.(?:[cm]?[jt]sx?|json|css|node|txt|wasm|html|md))$/;

/** node_modules/@scope/pkg/... -> @scope/pkg; the LAST node_modules segment wins (nested installs). */
export function groupOf(path) {
  const parts = path.split("/");
  const nm = parts.lastIndexOf("node_modules");
  if (nm >= 0 && parts[nm + 1]) {
    return parts[nm + 1].startsWith("@") && parts[nm + 2] ? `${parts[nm + 1]}/${parts[nm + 2]}` : parts[nm + 1];
  }
  return parts.length > 1 ? `${parts[0]}/` : "(root)";
}

export function measure(text) {
  const files = new Map();
  let current = "(before the first module header)";
  const lines = text.replace(/^﻿/, "").split("\n");
  // A trailing newline leaves one empty last element that is not a line of its own.
  const endsWithNewline = lines[lines.length - 1] === "";
  if (endsWithNewline) lines.pop();
  lines.forEach((line, i) => {
    // CRLF input (a bundle written on Windows): the header test ignores the carriage return.
    const header = HEADER.exec(line.replace(/\r$/, ""));
    if (header) current = header[1];
    const newline = i === lines.length - 1 && !endsWithNewline ? 0 : 1;
    files.set(current, (files.get(current) || 0) + Buffer.byteLength(line) + newline);
  });
  const groups = new Map();
  for (const [path, bytes] of files) {
    const g = groupOf(path);
    groups.set(g, (groups.get(g) || 0) + bytes);
  }
  return { files, groups, total: [...files.values()].reduce((a, b) => a + b, 0) };
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`.padStart(12);

function top(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("worker-composition.mjs")) {
  let text;
  try {
    text = readFileSync(input, "utf8");
  } catch (error) {
    console.log(`worker-composition: cannot read ${input} (${error.code || error.message}); nothing to report`);
    process.exit(0);
  }
  const { files, groups, total } = measure(text);
  console.log(`worker-composition: ${input}  ${kib(total).trim()} of source in ${files.size} modules`);
  console.log(`\nTop ${TOP} packages / directories:`);
  for (const [name, bytes] of top(groups, TOP)) {
    console.log(`${kib(bytes)}  ${((bytes / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
  }
  console.log(`\nTop ${TOP} modules:`);
  for (const [name, bytes] of top(files, TOP)) {
    console.log(`${kib(bytes)}  ${name}`);
  }
  const appRoutes = new Map([...files].filter(([p]) => /^(app|\.next\/server\/app)\//.test(p)));
  if (appRoutes.size) {
    console.log("\nTop 15 modules under app/:");
    for (const [name, bytes] of top(appRoutes, 15)) console.log(`${kib(bytes)}  ${name}`);
  }
}
