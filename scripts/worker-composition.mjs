#!/usr/bin/env node
/**
 * scripts/worker-composition.mjs - what the Worker bundle is made of.
 *
 * The Worker upload is at ~99% of Cloudflare's 64 MiB cap (ci.yml budget, check-worker-bundle.ts),
 * so "which dependency or route made it grow" is the question every large feature now has to
 * answer. Two ways to read it:
 *
 *   node scripts/worker-composition.mjs [dir]   (default .open-next/server-functions/default)
 *     Walks the tree OpenNext assembles for the handler and adds up bytes by what they are:
 *     node_modules/<package>, the server chunks (.next/server/chunks), the route files
 *     (.next/server/app, pages) and anything else by top folder, plus the biggest single files.
 *     This is the input to the handler's esbuild step, so it is a RANKING of what goes in, not
 *     the exact upload size (which is what check-worker-bundle.ts gates).
 *
 *   node scripts/worker-composition.mjs .open-next/server-functions/default/handler.mjs.meta.json
 *     The EXACT composition of the handler: OpenNext's esbuild metafile says how many bytes each
 *     source module put into handler.mjs. Use this one to decide what to cut.
 *
 *   node scripts/worker-composition.mjs <bundle.mjs>
 *     For an esbuild bundle that keeps a `// <source path>` comment before each module (OpenNext's
 *     own handler.mjs does not: it is minified), adds up the bytes after each header.
 *
 *   --top N   how many rows per table (default 30).
 *
 * No dependencies. Always exits 0: it prints, it does not gate.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const BOM = String.fromCharCode(0xfeff);

/** esbuild's module header: `// node_modules/pkg/index.js`, `// app/page.tsx`. */
const HEADER = /^\/\/ ([^\s][^\n]*\.(?:[cm]?[jt]sx?|json|css|node|txt|wasm|html|md))$/;

/**
 * What a path is, for grouping: the package for anything under node_modules (the LAST node_modules
 * segment wins, so nested and pnpm installs name the package that owns the file), the Next server's
 * chunks / app routes / pages routes by name, and otherwise the top folder.
 */
export function groupOf(path) {
  const parts = path.split("/");
  const nm = parts.lastIndexOf("node_modules");
  if (nm >= 0 && parts[nm + 1]) {
    return parts[nm + 1].startsWith("@") && parts[nm + 2] ? `${parts[nm + 1]}/${parts[nm + 2]}` : parts[nm + 1];
  }
  const next = parts.indexOf(".next");
  if (next >= 0 && parts[next + 1] === "server") {
    if (parts[next + 2] === "chunks") return "next server chunks";
    if (parts[next + 2] === "app") return "app routes (.next/server/app)";
    if (parts[next + 2] === "pages") return "pages routes (.next/server/pages)";
    return ".next/server (other)";
  }
  return parts.length > 1 ? `${parts[0]}/` : "(root)";
}

/** Bytes after each `// path` header of an esbuild bundle, per path and per group. */
export function measure(text) {
  const files = new Map();
  let current = "(before the first module header)";
  const lines = text.replace(new RegExp(`^${BOM}`), "").split("\n");
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
  return summarize(files);
}

/**
 * An esbuild metafile (OpenNext writes handler.mjs.meta.json next to handler.mjs): the bytes each
 * input module contributes to the biggest output, which is the handler. This is the exact ranking
 * of what is in the bundle; the other two modes are approximations.
 */
export function measureMeta(meta) {
  const outputs = Object.entries((meta && meta.outputs) || {});
  const biggest = outputs.sort((a, b) => (b[1].bytes || 0) - (a[1].bytes || 0))[0];
  const files = new Map();
  if (biggest) {
    for (const [path, info] of Object.entries(biggest[1].inputs || {})) {
      if (info && info.bytesInOutput > 0) files.set(path, info.bytesInOutput);
    }
  }
  return { ...summarize(files), output: biggest ? biggest[0] : null };
}

/** Bytes of every file under `root` (paths relative to it, with forward slashes). */
export function measureTree(root) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.set(full.slice(root.length + 1).split(sep).join("/"), statSync(full).size);
    }
  };
  walk(root);
  return summarize(files);
}

function summarize(files) {
  const groups = new Map();
  for (const [path, bytes] of files) {
    const g = groupOf(path);
    groups.set(g, (groups.get(g) || 0) + bytes);
  }
  return { files, groups, total: [...files.values()].reduce((a, b) => a + b, 0) };
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`.padStart(12);
const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

function report(label, { files, groups, total }, topN) {
  console.log(`worker-composition: ${label}  ${kib(total).trim()} in ${files.size} files`);
  console.log(`\nTop ${topN} packages / directories:`);
  for (const [name, bytes] of top(groups, topN)) {
    console.log(`${kib(bytes)}  ${((bytes / total) * 100).toFixed(1).padStart(5)}%  ${name}`);
  }
  console.log(`\nTop ${topN} files:`);
  for (const [name, bytes] of top(files, topN)) console.log(`${kib(bytes)}  ${name}`);
  const routes = new Map([...files].filter(([p]) => groupOf(p).startsWith("app routes")));
  if (routes.size) {
    console.log("\nTop 15 route files:");
    for (const [name, bytes] of top(routes, 15)) console.log(`${kib(bytes)}  ${name}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const topFlag = args.indexOf("--top");
  const topN = topFlag >= 0 ? Number(args[topFlag + 1]) || 30 : 30;
  const input = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--top") || ".open-next/server-functions/default";
  let stat;
  try {
    stat = statSync(input);
  } catch (error) {
    console.log(`worker-composition: cannot read ${input} (${error.code || error.message}); nothing to report`);
    return;
  }
  if (stat.isDirectory()) return report(input, measureTree(input), topN);
  if (input.endsWith(".meta.json")) {
    const meta = measureMeta(JSON.parse(readFileSync(input, "utf8")));
    return report(`${input} (bytes in ${meta.output ?? "no output"})`, meta, topN);
  }
  const result = measure(readFileSync(input, "utf8"));
  report(input, result, topN);
  if (result.files.size <= 2) {
    console.log("\nnote: this bundle has no per-module path comments (it is minified), so it reads as one module. Pass the directory instead.");
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("worker-composition.mjs")) main();
