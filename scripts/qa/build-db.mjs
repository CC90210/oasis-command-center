#!/usr/bin/env node
/**
 * scripts/qa/build-db.mjs - build the QA crawl's LOCAL libSQL database from the
 * schema-only fixture (scripts/qa/fixtures/production-schema.json, regenerated
 * by scripts/qa/export-schema.mjs).
 *
 *   node scripts/qa/build-db.mjs <out.db> [--schema <fixture.json>]
 *
 * Tables first, then indexes, views and triggers, with a second pass for any
 * object that failed only because of creation order. Exits 1 if anything still
 * fails: a schema the crawl cannot reproduce would make every page that reads
 * the missing table look broken for the wrong reason.
 *
 * The target must be a local file. A libsql://, http(s):// or ws(s):// target
 * is refused, so this can never write to a real database. The file (and its
 * -wal/-shm companions) is deleted first.
 */
import { createClient } from "@libsql/client";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORDER = { table: 0, index: 1, view: 2, trigger: 3 };

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

async function main() {
  const out = process.argv[2];
  const schemaPath = path.resolve(arg("--schema", path.join(HERE, "fixtures", "production-schema.json")));
  if (!out || out.startsWith("--")) {
    console.error("usage: node scripts/qa/build-db.mjs <out.db> [--schema <fixture.json>]");
    process.exit(2);
  }
  if (/^(libsql|https?|wss?|file):/i.test(out)) {
    console.error("refusing: the output must be a plain local file path, not a database URL");
    process.exit(2);
  }
  for (const f of [out, `${out}-wal`, `${out}-shm`]) {
    try {
      unlinkSync(f);
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
  }
  const fixture = JSON.parse(readFileSync(schemaPath, "utf8"));
  const objects = (fixture.objects || [])
    .map((o, i) => ({ ...o, i }))
    .sort((a, b) => (ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9) || a.i - b.i);

  const db = createClient({ url: `file:${path.resolve(out)}` });
  let ok = 0;
  const retry = [];
  for (const o of objects) {
    try {
      await db.execute(o.sql);
      ok += 1;
    } catch (err) {
      retry.push({ o, error: String(err && err.message ? err.message : err) });
    }
  }
  const failed = [];
  for (const { o } of retry) {
    try {
      await db.execute(o.sql);
      ok += 1;
    } catch (err) {
      failed.push({ type: o.type, name: o.name, error: String(err && err.message ? err.message : err).slice(0, 300) });
    }
  }
  db.close();
  console.log(JSON.stringify({ ok, failed, db: path.resolve(out), schema: schemaPath }));
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
