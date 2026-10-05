/** SCRATCH — whole /pipeline DB chain: today vs the claim's fix vs grouped counts. Deleted after run. */
import { createClient } from "@libsql/client";

const c = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
const T = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const MV = 2;
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
const PARK = ["hugedomains.com","afternic.com","sedo.com","sedoparking.com","dan.com","undeveloped.com",
  "bodis.com","parkingcrew.net","above.com","squadhelp.com","buydomains.com","domainmarket.com",
  "brandbucket.com","/domain_profile.cfm","namesilo.com/parked"];

const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const row = (label, a) =>
  console.log(`${label.padEnd(40)} p25 ${pct(a,0.25).toFixed(0).padStart(5)}  median ${pct(a,0.5).toFixed(0).padStart(5)}  p75 ${pct(a,0.75).toFixed(0).padStart(5)} ms`);

function scoreLanes(idList) {
  const ph = idList.map(() => "?").join(",");
  const A = [T, MV, ...idList];
  const base = `FROM "leadgen_site_audits" WHERE "tenant_id"=? AND "audit_version"=? AND "business_id" IN (${ph})`;
  const un = `FROM "leadgen_site_unreachable" WHERE "tenant_id"=? AND "audit_version"=? AND "business_id" IN (${ph})`;
  const parkOr = PARK.map((p) => `signals LIKE '%${p}%'`).join(" OR ");
  return [
    ['SELECT "business_id","fetched_at" ' + base + " LIMIT 50000", base],
    ['SELECT "business_id","quality_score","fetched_at" ' + base + ' AND "profile" IS NOT NULL LIMIT 50000', base + ' AND "profile" IS NOT NULL'],
    ['SELECT "business_id" ' + un + " LIMIT 50000", un],
    ['SELECT "business_id","signals" ' + base + ' AND "is_parked"=1 LIMIT 50000', base + ' AND "is_parked"=1'],
    ['SELECT "business_id","signals" ' + base + ` AND "is_parked" IS NULL AND (${parkOr}) LIMIT 50000`, base + ` AND "is_parked" IS NULL AND (${parkOr})`],
  ].map(([r, w]) => ({ rows: { sql: r, args: A }, count: { sql: "SELECT count(*) AS n " + w, args: A } }));
}

const idsFrom = (results) => {
  const s = new Set();
  for (const res of results) for (const x of res.rows) {
    try { const d = JSON.parse(x.data); if (d.webdev_source_business_id) s.add(String(d.webdev_source_business_id).trim()); } catch {}
  }
  return [...s];
};

async function today() {
  const res = await Promise.all(stages.map((st) => c.execute(countQ(st)).then(() => c.execute(rowsQ(st)))));
  const lanes = scoreLanes(idsFrom(res));
  await Promise.all(lanes.map((l) => c.execute(l.count).then(() => c.execute(l.rows))));
}
async function claimFix() {
  const res = await Promise.all(stages.map((st) => Promise.all([c.execute(countQ(st)), c.execute(rowsQ(st))]).then(([, r]) => r)));
  const lanes = scoreLanes(idsFrom(res));
  await Promise.all(lanes.map((l) => Promise.all([c.execute(l.count), c.execute(l.rows)]).then(([, r]) => r)));
}
async function grouped() {
  const all = await Promise.all([c.execute(GROUPED), ...stages.map((st) => c.execute(rowsQ(st)))]);
  const lanes = scoreLanes(idsFrom(all.slice(1)));
  await Promise.all(lanes.map((l) => Promise.all([c.execute(l.count), c.execute(l.rows)]).then(([, r]) => r)));
}

async function main() {
  for (let i = 0; i < 5; i++) await c.execute("SELECT 1");
  const N = 12;
  const a = [], b = [], g = [], rtt = [];
  for (let i = 0; i < N; i++) {
    let t = performance.now(); await c.execute("SELECT 1"); rtt.push(performance.now() - t);
    t = performance.now(); await today(); a.push(performance.now() - t);
    t = performance.now(); await claimFix(); b.push(performance.now() - t);
    t = performance.now(); await grouped(); g.push(performance.now() - t);
  }
  row("empty round trip", rtt);
  row("/pipeline DB chain TODAY", a);
  row("/pipeline DB chain CLAIM FIX", b);
  row("/pipeline DB chain GROUPED counts", g);
}
main().then(() => process.exit(0), (e) => { console.error("ERR", e); process.exit(1); });
