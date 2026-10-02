/**
 * scripts/check-worker-chunks.ts - fail CI when the Worker could ask for a
 * server chunk that OpenNext did not inline. (2026-10-02, review of #531)
 *
 * WHY. Next's server code loads its webpack chunks with
 * require("./chunks/" + id + ".js"). workerd has no file system, so OpenNext
 * rewrites that one dynamic require in .next/server/webpack-runtime.js into a
 * switch: one `case <id>: install(require("./chunks/<id>.js"))` per chunk file
 * it finds, then `default: throw new Error("Unknown chunk ...")`
 * (@opennextjs/cloudflare dist/cli/build/patches/ast/webpack-runtime.js). It
 * finds the chunks by listing .next/server/chunks/ and keeping names that
 * match /^\d+\.js$/. A chunk the code can request but the switch lacks is a 500
 * in production only, on a cold path: a startup chunk breaks a route on its
 * first request, an async one (a dynamic import()) only when that branch runs.
 * next.config.js changes how the Worker's server compile splits chunks (one
 * copy of each shared module), so this checks the emitted result rather than
 * trusting the config.
 *
 * WHAT IT CHECKS, on the server tree OpenNext bundled
 * (.open-next/server-functions/default/.next/server):
 *   1. Each webpack runtime there (webpack-runtime.js, webpack-api-runtime.js)
 *      was patched: it has the switch and its Unknown-chunk default, and no
 *      dynamic require("./chunks/" + ...) is left.
 *   2. Every file in chunks/ has a numeric name (any other name is skipped by
 *      the patch) and a case in every runtime.
 *   3. Every chunk id the code can request has a case and a file: the startup
 *      list each entry hands to __webpack_require__.X(0, [ids], ...), and the
 *      __webpack_require__.e(id) that every dynamic import compiles to.
 * An empty scan fails: no startup list or no async load means the patterns no
 * longer match webpack's output, not that there is nothing to check.
 *
 * Exit 0 = all inlined; 1 = a gap, or an input is missing or unreadable.
 *
 * Run: node --import tsx scripts/check-worker-chunks.ts .open-next/server-functions/default/.next/server
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type SourceFile = { file: string; source: string };

export type RuntimeScan = {
  file: string;
  /** The switch and its Unknown-chunk default are present. */
  patched: boolean;
  /** An unpatched require("./chunks/" + ...) is still there. */
  dynamicRequireLeft: boolean;
  /** case id -> the chunk file that case requires. */
  cases: Map<number, string>;
  /** The runtime's own chunk id: its case marks itself installed. */
  selfIds: number[];
};

const CASE = /case (\d+): [\w$]+\(require\("\.\/chunks\/([^"]+)"\)\); break;/g;
const SELF_CASE = /case (\d+): [\w$]+\[[\w$]+\] = 1; break;/g;
const UNKNOWN_DEFAULT = /default: throw new Error\(`Unknown chunk \$\{[\w$]+\}`\);/;
const DYNAMIC_REQUIRE = /require\(\s*"\.\/chunks\/"\s*\+/;
/** __webpack_require__.X(0, [ids], fn): an entry's startup chunks. */
const STARTUP = /\.X\(0,\s*\[([\d,\s]*)\]/g;
/** __webpack_require__.e(id), as a dynamic import compiles: inside Promise.all([...]) or followed by .then. */
const ASYNC_LOAD = /\b[\w$]+\.e\((\d+)\)(?=\s*(?:[,\])]|\.then\())/g;

export function scanRuntime(file: string, source: string): RuntimeScan {
  const cases = new Map<number, string>();
  for (const m of source.matchAll(CASE)) cases.set(Number(m[1]), m[2]);
  const selfIds = [...source.matchAll(SELF_CASE)].map((m) => Number(m[1]));
  return {
    file,
    patched: UNKNOWN_DEFAULT.test(source) && cases.size > 0,
    dynamicRequireLeft: DYNAMIC_REQUIRE.test(source),
    cases,
    selfIds,
  };
}

/** Chunk ids one compiled file can ask the runtime for. */
export function requestedChunks(source: string): { startup: number[]; async: number[] } {
  const startup: number[] = [];
  for (const m of source.matchAll(STARTUP)) {
    for (const id of m[1].split(",")) if (id.trim()) startup.push(Number(id.trim()));
  }
  const async = [...source.matchAll(ASYNC_LOAD)].map((m) => Number(m[1]));
  return { startup, async };
}

export type ServerTree = {
  /** webpack-runtime.js and, when present, webpack-api-runtime.js. */
  runtimes: SourceFile[];
  /** File names directly under chunks/. */
  chunkFiles: string[];
  /** Every compiled entry and chunk (app/, pages/, chunks/), manifests excluded. */
  sources: SourceFile[];
};

export type ChunkVerdict = { ok: boolean; problems: string[]; summary: string };

export function checkServerTree(tree: ServerTree): ChunkVerdict {
  const problems: string[] = [];
  const scans = tree.runtimes.map((r) => scanRuntime(r.file, r.source));
  if (scans.length === 0) problems.push("no webpack runtime found (webpack-runtime.js); nothing loads the chunks");
  for (const s of scans) {
    if (!s.patched) problems.push(`${s.file}: no Unknown-chunk switch, so OpenNext's runtime patch did not apply`);
    if (s.dynamicRequireLeft) problems.push(`${s.file}: still loads chunks with require("./chunks/" + ...), which workerd cannot run`);
    for (const [id, file] of s.cases) {
      if (file !== `${id}.js`) problems.push(`${s.file}: case ${id} requires chunks/${file}, not chunks/${id}.js`);
    }
  }

  const fileIds = new Set<number>();
  for (const name of tree.chunkFiles) {
    if (!name.endsWith(".js")) continue;
    if (!/^\d+\.js$/.test(name)) {
      problems.push(`chunks/${name}: not a numeric chunk name, so OpenNext's patch skips it and loading it fails as "Unknown chunk"`);
      continue;
    }
    fileIds.add(Number(name.slice(0, -3)));
  }
  for (const id of fileIds) {
    for (const s of scans) if (!s.cases.has(id)) problems.push(`chunk ${id}: chunks/${id}.js is not inlined in ${s.file}`);
  }
  for (const s of scans) {
    for (const id of s.cases.keys()) if (!fileIds.has(id)) problems.push(`chunk ${id}: ${s.file} inlines chunks/${id}.js, which does not exist`);
  }

  const firstRequester = new Map<number, string>();
  let startupLists = 0;
  let asyncSites = 0;
  for (const src of tree.sources) {
    const { startup, async } = requestedChunks(src.source);
    if (startup.length) startupLists++;
    asyncSites += async.length;
    for (const [kind, ids] of [["startup", startup], ["async", async]] as const) {
      for (const id of ids) if (!firstRequester.has(id)) firstRequester.set(id, `${src.file} (${kind})`);
    }
  }
  const selfIds = new Set(scans.flatMap((s) => s.selfIds));
  for (const [id, where] of firstRequester) {
    if (selfIds.has(id)) continue;
    for (const s of scans) if (!s.cases.has(id)) problems.push(`chunk ${id}: requested by ${where} but not inlined in ${s.file}`);
    if (!fileIds.has(id)) problems.push(`chunk ${id}: requested by ${where} but chunks/${id}.js does not exist`);
  }
  if (startupLists === 0) problems.push("found no entry startup list (__webpack_require__.X(0, [...])); the scan no longer matches webpack's output");
  if (asyncSites === 0) problems.push("found no async chunk load (__webpack_require__.e(id)); the scan no longer matches webpack's output");

  const summary =
    `${fileIds.size} chunk files, inlined in ${scans.map((s) => `${s.file} (${s.cases.size} cases)`).join(" and ")}; ` +
    `${firstRequester.size} chunk ids requested by ${startupLists} entry startup lists and ${asyncSites} async loads`;
  return { ok: problems.length === 0, problems, summary };
}

function listJs(dir: string, rel: string, out: SourceFile[]): void {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const relName = `${rel}/${name}`;
    if (statSync(abs).isDirectory()) listJs(abs, relName, out);
    else if (name.endsWith(".js") && !name.endsWith("_client-reference-manifest.js")) {
      out.push({ file: relName, source: readFileSync(abs, "utf8") });
    }
  }
}

export function readServerTree(serverDir: string): ServerTree {
  const runtimes = ["webpack-runtime.js", "webpack-api-runtime.js"]
    .filter((f) => existsSync(path.join(serverDir, f)))
    .map((f) => ({ file: f, source: readFileSync(path.join(serverDir, f), "utf8") }));
  const chunksDir = path.join(serverDir, "chunks");
  const chunkFiles = existsSync(chunksDir) ? readdirSync(chunksDir).filter((n) => statSync(path.join(chunksDir, n)).isFile()) : [];
  const sources: SourceFile[] = [];
  for (const sub of ["app", "pages", "chunks"]) {
    const dir = path.join(serverDir, sub);
    if (existsSync(dir)) listJs(dir, sub, sources);
  }
  return { runtimes, chunkFiles, sources };
}

function main(): number {
  const serverDir = process.argv[2];
  if (!serverDir || !existsSync(serverDir)) {
    console.error(`check-worker-chunks: pass the server tree OpenNext bundled (got ${serverDir ?? "nothing"})`);
    return 1;
  }
  const verdict = checkServerTree(readServerTree(serverDir));
  if (!verdict.ok) {
    console.error(`check-worker-chunks: FAIL, ${verdict.problems.length} problem(s). ${verdict.summary}`);
    for (const p of verdict.problems.slice(0, 50)) console.error(`  ${p}`);
    return 1;
  }
  console.log(`check-worker-chunks: ${verdict.summary}; every one is inlined`);
  return 0;
}

if (/check-worker-chunks\.ts$/.test(process.argv[1] || "")) {
  process.exit(main());
}
