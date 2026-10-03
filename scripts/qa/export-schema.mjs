#!/usr/bin/env node
/**
 * scripts/qa/export-schema.mjs - regenerate the schema-only fixture the QA crawl
 * builds its local database from (scripts/qa/fixtures/production-schema.json).
 *
 * READ-ONLY. It asks the production database for its catalog (the rows of
 * sqlite_master: one CREATE statement per table, index, view and trigger)
 * through Business-Empire-Agent's turso_tool.py, which loads the credential
 * itself and never prints it. No table row is read: sqlite_master is the
 * catalog, not the data.
 *
 *   node scripts/qa/export-schema.mjs --turso-tool <path to turso_tool.py>
 *        [--python python] [--out scripts/qa/fixtures/production-schema.json]
 *
 * It refuses to write the fixture when a statement is not a CREATE, or when
 * anything in the text looks like a credential or a database address. Run it
 * again after a migration lands so the crawl sees the same tables production
 * has; the diff of the fixture is the schema change.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.join(HERE, "fixtures", "production-schema.json");

const QUERY =
  "SELECT type, name, tbl_name, sql FROM sqlite_master " +
  "WHERE sql IS NOT NULL AND type IN ('table', 'index', 'view', 'trigger') " +
  "ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'view' THEN 2 ELSE 3 END, name";

/** Engine-internal objects: created by SQLite/libSQL themselves, never by a migration. */
const INTERNAL = /^(sqlite_|libsql_|_cf_|_litestream)/i;

const CREATE = /^\s*CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(TABLE|INDEX|VIEW|TRIGGER)\b/i;

/** Text that must never reach a committed fixture. Each is a credential or an address shape. */
const FORBIDDEN = [
  ["libSQL address", /libsql:\/\//i],
  ["Turso host", /\.turso\.io/i],
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["Stripe key", /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["assigned secret", /\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*'[^']{12,}'/i],
  ["long opaque literal", /'[A-Za-z0-9+/_-]{40,}={0,2}'/],
];

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Reasons the catalog cannot be committed as a fixture; empty when it can. */
export function fixtureProblems(objects) {
  const problems = [];
  for (const o of objects) {
    if (!CREATE.test(o.sql)) problems.push(`${o.type} ${o.name}: not a CREATE statement`);
    for (const [label, re] of FORBIDDEN) {
      if (re.test(o.sql)) problems.push(`${o.type} ${o.name}: contains a ${label}`);
    }
  }
  return problems;
}

/** JSON with every code unit above 0x7E escaped, so the fixture stays ASCII. */
export function asciiJson(value) {
  const s = JSON.stringify(value, null, 1);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code > 0x7e ? "\\u" + code.toString(16).padStart(4, "0") : s[i];
  }
  return out;
}

function main() {
  const tool = arg("--turso-tool", process.env.QA_TURSO_TOOL || "");
  const python = arg("--python", process.env.QA_PYTHON || "python");
  const out = path.resolve(arg("--out", DEFAULT_OUT));
  if (!tool) {
    console.error("usage: node scripts/qa/export-schema.mjs --turso-tool <path to turso_tool.py> [--python python] [--out file]");
    process.exit(2);
  }
  // turso_tool.py resolves its credential from its own repository, so it runs there.
  const toolRepo = path.resolve(path.dirname(tool), "..", "..");
  const res = spawnSync(python, [tool, "sql", QUERY, "--json"], {
    cwd: toolRepo,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.status !== 0) {
    console.error(`turso_tool.py exited ${res.status}: ${(res.stderr || "").slice(-2000)}`);
    process.exit(1);
  }
  const parsed = JSON.parse(res.stdout);
  if (!parsed.ok || !Array.isArray(parsed.rows)) {
    console.error(`turso_tool.py did not return rows: ${String(res.stdout).slice(0, 500)}`);
    process.exit(1);
  }
  const objects = parsed.rows
    .filter((r) => r && typeof r.sql === "string" && !INTERNAL.test(String(r.name)))
    .map((r) => ({ type: String(r.type), name: String(r.name), tbl_name: String(r.tbl_name), sql: r.sql }));
  const problems = fixtureProblems(objects);
  if (problems.length) {
    console.error(`refusing to write the fixture:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const counts = { table: 0, index: 0, view: 0, trigger: 0 };
  for (const o of objects) counts[o.type] = (counts[o.type] ?? 0) + 1;
  const fixture = {
    note: "Schema only: the CREATE statements of the production database's catalog (sqlite_master). No rows. Regenerate with scripts/qa/export-schema.mjs.",
    generated_at: new Date().toISOString(),
    counts,
    objects,
  };
  writeFileSync(out, asciiJson(fixture) + "\n", "utf8");
  console.log(JSON.stringify({ ok: true, out, counts }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
