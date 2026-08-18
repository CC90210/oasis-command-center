/**
 * tests/or-filter-dotted-values.test.ts — the .or() grammar must survive
 * values that contain dots. Above all: EMAIL ADDRESSES.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-18 every public-form submission whose email had a dotted local
 * part (first.last@gmail.com — roughly half of real-world addresses) died with
 * an empty 500. findExistingLead() builds
 *
 *     data->>email.eq.first.last@gmail.com
 *
 * and compileOrGroup's segment regex let the GREEDY column class swallow
 * "data->>email.eq", then read "first" as the operator:
 *
 *     Error: unsupported operator: first
 *
 * The throw was synchronous, /api/forms/submit had no top-level catch, Vercel
 * answered 500 with an EMPTY body, and Safari's res.json() surfaced it to the
 * merchant as "The string did not match the expected pattern." Nothing was
 * stored — the application was simply lost. The proof of the demographic: 25/25
 * recent stored submissions had bare local parts; the dotted-email merchants
 * never landed a row.
 *
 * The fix anchors the parse on the OPERATOR TOKEN (lazy column + known-operator
 * alternation), so the value tail keeps its dots. This test pins that grammar.
 */

import assert from "node:assert/strict";
import { TursoQueryBuilder } from "@/lib/turso-postgrest";

type Cond = { sql: string; args: unknown[] };

function conds(expr: string): Cond[] {
  const qb = new TursoQueryBuilder(null as never, "tenant_records");
  qb.or(expr);
  return (qb as unknown as { conds: Cond[] }).conds;
}

// ── THE regression: dotted local part in a JSON-path or() segment ──────────
{
  const [c] = conds("data->>email.eq.first.last@gmail.com");
  assert.equal(c.sql, `(json_extract("data", '$.email') = ?)`);
  assert.deepEqual(c.args, ["first.last@gmail.com"]);
}

// ── Same shape on a plain column ───────────────────────────────────────────
{
  const [c] = conds("email.eq.echelonx.aisolutions+canary@gmail.com");
  assert.equal(c.sql, `("email" = ?)`);
  assert.deepEqual(c.args, ["echelonx.aisolutions+canary@gmail.com"]);
}

// ── The exact production shape findExistingLead builds ─────────────────────
{
  const [c] = conds("data->>email.eq.jane.q.doe@sub.domain.co.uk,data->>phone.eq.+15145550188");
  assert.equal(
    c.sql,
    `(json_extract("data", '$.email') = ? OR json_extract("data", '$.phone') = ?)`,
  );
  assert.deepEqual(c.args, ["jane.q.doe@sub.domain.co.uk", "+15145550188"]);
}

// ── A value whose first dotted token is uppercase must also parse ──────────
// (findExistingLead lowercases, but the grammar must not depend on that.)
{
  const [c] = conds("data->>email.eq.First.Last@Example.com");
  assert.deepEqual(c.args, ["First.Last@Example.com"]);
}

// ── Existing grammar must keep working exactly as before ───────────────────
{
  const [c] = conds("is_public.eq.true");
  assert.equal(c.sql, `("is_public" = ?)`);
  assert.deepEqual(c.args, [1], "boolean literal must still bind as 0/1");
}
{
  const [c] = conds("meta->>deleted_at.is.null");
  assert.equal(c.sql, `(json_extract("meta", '$.deleted_at') IS NULL)`);
}
{
  const [c] = conds("status.not.eq.dead");
  assert.equal(c.sql, `(NOT ("status" = ?))`);
  assert.deepEqual(c.args, ["dead"]);
}
{
  const [c] = conds("name.like.*acme*");
  assert.equal(c.sql, `("name" LIKE ?)`);
  assert.deepEqual(c.args, ["%acme%"]);
}
{
  const [c] = conds("a.eq.1,and(c.gt.2,d.lt.5)");
  assert.equal(c.sql, `("a" = ? OR ("c" > ? AND "d" < ?))`);
  assert.deepEqual(c.args, [1, 2, 5]);
}
{
  // gte/lte must not be shadowed by their gt/lt prefixes in the operator list.
  const [c] = conds("score.gte.10,score.lte.90");
  assert.equal(c.sql, `("score" >= ? OR "score" <= ?)`);
}

// ── Garbage must still fail LOUDLY, never silently drop the filter ─────────
assert.throws(
  () => conds("email.bogusop.5"),
  /cannot parse or\(\) segment|unsupported operator/,
  "an unknown operator must still be refused — a dropped filter returns wrong rows",
);
assert.throws(() => conds("no-dots-at-all"), /cannot parse or\(\) segment/);

console.log("or-filter-dotted-values: all assertions passed");
