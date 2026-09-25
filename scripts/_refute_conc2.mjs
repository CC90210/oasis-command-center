/** SCRATCH — 13-lane A/B, high N, interleaved. Deleted after the run. */
import { createClient } from "@libsql/client";

const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const T = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const BOARD =
  "(json_extract(\"data\",'$.transferred_at') IS NULL OR json_extract(\"data\",'$.stage') = 'uw_sheet')";
const WHERE = 'WHERE "tenant_id"=? AND "entity_type"=? AND json_extract("data",\'$.stage\')=? AND ' + BOARD;
const countQ = (st) => ({ sql: 'SELECT count(*) AS n FROM "tenant_records" ' + WHERE, args: [T, "lead", st] });
const rowsQ = (st) => ({
  sql: 'SELECT "id","tenant_id","entity_type","data","created_at","updated_at" FROM "tenant_records" ' +
    WHERE + ' ORDER BY "updated_at" DESC LIMIT 40 OFFSET 0', args: [T, "lead", st] });
const GROUPED = {
  sql: 'SELECT json_extract("data",\'$.stage\') AS stage, count(*) AS n FROM "tenant_records" WHERE ' +
    '"tenant_id"=? AND "entity_type"=? AND ' + BOARD + ' GROUP BY 1', args: [T, "lead"] };
const stages = ["assigned","attempting_contact","connected","qualified","founder_meeting_booked",
  "demo_completed","proposal_sent","won","lost","onboarding","in_build","client_review","launched"];

const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const row = (label, a) =>
  console.log(`${label.padEnd(34)} min ${pct(a,0).toFixed(0).padStart(5)}  p25 ${pct(a,0.25).toFixed(0).padStart(5)}  median ${pct(a,0.5).toFixed(0).padStart(5)}  p75 ${pct(a,0.75).toFixed(0).padStart(5)} ms`);

async function main() {
  for (let i = 0; i < 6; i++) await c.execute("SELECT 1");
  const N = 25;
  const a = [], b = [], g = [];
  for (let i = 0; i < N; i++) {
    let t = performance.now();
    await Promise.all(stages.map((s) => c.execute(countQ(s)).then(() => c.execute(rowsQ(s)))));
    a.push(performance.now() - t);
    t = performance.now();
    await Promise.all(stages.map((s) => Promise.all([c.execute(countQ(s)), c.execute(rowsQ(s))])));
    b.push(performance.now() - t);
    t = performance.now();
    await Promise.all([c.execute(GROUPED), ...stages.map((s) => c.execute(rowsQ(s)))]);
    g.push(performance.now() - t);
  }
  row("TODAY  13x (count -> rows)", a);
  row("CLAIM FIX 13x Promise.all", b);
  row("GROUP BY + 13 rows, 1 wave", g);
  const wins = b.filter((x, i) => x < a[i]).length;
  console.log(`\nclaim-fix beat today in ${wins}/${N} interleaved pairs`);
}
main().then(() => process.exit(0), (e) => { console.error("ERR", e); process.exit(1); });
