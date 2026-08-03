/**
 * partial-index-upsert — you cannot upsert onto a PARTIAL unique index.
 *
 * PostgREST turns `.upsert(rows, { onConflict: "a,b" })` into
 * `ON CONFLICT (a, b) DO ...` with no WHERE predicate. Postgres will only infer
 * an index for that if the index is total; a partial unique index
 * (`... where state in ('queued','extracting')`) is NOT inferable, so the whole
 * statement dies with 42P10 "no unique or exclusion constraint matching the
 * ON CONFLICT specification".
 *
 * This repo has paid for that twice:
 *   1. the open-tracking dedup outage (silently dropped every row for weeks)
 *   2. app/api/founders/marketing/ingest/route.ts, caught in review before it
 *      could ship — it was invisible only because migration 133 had not been
 *      applied yet, so the route short-circuited to 503 before reaching the bug.
 *
 * Twice is a pattern, so it becomes a build gate instead of a lesson.
 *
 * The fix is never "make the index total" by reflex — a partial index is often
 * exactly right (here it is what allows a link to be re-ingested once an earlier
 * run finished). The fix is to stop using upsert and dedup explicitly.
 */

import assert from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

type IndexInfo = { table: string; cols: string; partial: boolean; name: string };

const normalize = (cols: string): string =>
  cols
    .split(",")
    .map((c) => c.trim().replace(/\s+(asc|desc)$/i, "").replace(/["`]/g, "").toLowerCase())
    .filter(Boolean)
    .join(",");

/** Every `create unique index` in a SQL blob, flagged partial if it has a WHERE. */
export function parseUniqueIndexes(sql: string): IndexInfo[] {
  const out: IndexInfo[] = [];
  const re =
    /create\s+unique\s+index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(\w+)\s*(?:using\s+\w+\s*)?\(([^)]*)\)([^;]*);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    out.push({
      name: m[1],
      table: m[2].toLowerCase(),
      cols: normalize(m[3]),
      partial: /\bwhere\b/i.test(m[4] || ""),
    });
  }
  // Inline table constraints (`unique (a, b)`) are always total.
  const tableRe = /create\s+table[^;]*?;/gis;
  let t: RegExpExecArray | null;
  while ((t = tableRe.exec(sql))) {
    const body = t[0];
    const name = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/i.exec(body)?.[1];
    if (!name) continue;
    const uq = /(?:^|[,\s])unique\s*\(([^)]*)\)/gi;
    let u: RegExpExecArray | null;
    while ((u = uq.exec(body))) {
      out.push({ name: `${name}_inline`, table: name.toLowerCase(), cols: normalize(u[1]), partial: false });
    }
  }
  return out;
}

/** Each `onConflict: "..."` paired with the nearest `.from("table")` above it. */
export function findUpsertTargets(code: string): Array<{ table: string; cols: string }> {
  const out: Array<{ table: string; cols: string }> = [];
  const re = /onConflict\s*:\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const before = code.slice(0, m.index);
    const from = [...before.matchAll(/\.from\(\s*["'`](\w+)["'`]\s*\)/g)].pop();
    if (!from) continue;
    out.push({ table: from[1].toLowerCase(), cols: normalize(m[1]) });
  }
  return out;
}

/** An upsert target is a violation when its column set is ONLY ever partial. */
export function violations(
  indexes: IndexInfo[],
  targets: Array<{ table: string; cols: string; file?: string }>,
): Array<{ table: string; cols: string; file?: string; index: string }> {
  const bad: Array<{ table: string; cols: string; file?: string; index: string }> = [];
  for (const t of targets) {
    const matching = indexes.filter((i) => i.table === t.table && i.cols === t.cols);
    if (!matching.length) continue; // no such index here; not this test's job
    if (matching.some((i) => !i.partial)) continue; // a total index can serve it
    bad.push({ ...t, index: matching[0].name });
  }
  return bad;
}

// ── the detector must actually fire ──────────────────────────────────
// Proving this on a fixture rather than trusting it: a guard that has never
// been seen to fail is a guard nobody has tested.
const FIXTURE_SQL = `
create table if not exists public.demo_total (tenant_id uuid, url text, unique (tenant_id, url));
create unique index if not exists demo_partial_idx
  on public.demo_partial (tenant_id, url)
  where url is not null and state in ('queued','extracting');
`;
const fixtureIdx = parseUniqueIndexes(FIXTURE_SQL);
assert.ok(
  fixtureIdx.some((i) => i.table === "demo_partial" && i.partial),
  "parser recognises a partial unique index",
);
assert.ok(
  fixtureIdx.some((i) => i.table === "demo_total" && !i.partial),
  "parser recognises a total inline unique constraint",
);

const fixtureCode = `
  const a = await db.from("demo_partial").upsert(rows, { onConflict: "tenant_id,source_url" });
  const b = await db.from("demo_partial").upsert(rows, { onConflict: "tenant_id,url" });
  const c = await db.from("demo_total").upsert(rows, { onConflict: "tenant_id,url" });
`;
const fixtureTargets = findUpsertTargets(fixtureCode);
assert.equal(fixtureTargets.length, 3, "finds every onConflict paired with its table");
const fired = violations(fixtureIdx, fixtureTargets);
assert.equal(fired.length, 1, "exactly the partial-index upsert is flagged");
assert.equal(fired[0].table, "demo_partial");
assert.equal(fired[0].cols, "tenant_id,url");

// ── now the real repo ────────────────────────────────────────────────
function walk(dir: string, exts: string[], acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, acc);
    else if (exts.some((x) => e.endsWith(x))) acc.push(p);
  }
  return acc;
}

const schema = walk(join(ROOT, "database"), [".sql"])
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const indexes = parseUniqueIndexes(schema);
assert.ok(indexes.length > 0, "found unique indexes in database/ — the scan is not silently empty");
assert.ok(
  indexes.some((i) => i.partial),
  "found at least one PARTIAL unique index — otherwise this gate proves nothing",
);

const codeFiles = [
  ...walk(join(ROOT, "app"), [".ts", ".tsx"]),
  ...walk(join(ROOT, "lib"), [".ts", ".tsx"]),
  ...walk(join(ROOT, "components"), [".ts", ".tsx"]),
  ...walk(join(ROOT, "scripts"), [".ts", ".mjs"]),
];
assert.ok(codeFiles.length > 100, "code scan reached the tree, not an empty directory");

const targets = codeFiles.flatMap((f) =>
  findUpsertTargets(readFileSync(f, "utf8")).map((t) => ({ ...t, file: f.replace(ROOT, "").replace(/\\/g, "/") })),
);
const found = violations(indexes, targets);

if (found.length) {
  for (const v of found) {
    console.error(
      `  ✗ ${v.file}\n      upsert onConflict "${v.cols}" on ${v.table} can only match ${v.index}, which is PARTIAL.\n      Postgres will answer 42P10 for every row. Dedup with an explicit select + insert instead.`,
    );
  }
}
assert.equal(found.length, 0, `${found.length} upsert(s) target a partial-only unique index`);

console.log(
  `partial-index-upsert: OK — ${indexes.length} unique indexes (${indexes.filter((i) => i.partial).length} partial), ${targets.length} upsert targets checked, 0 violations`,
);
