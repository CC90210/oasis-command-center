/** SCRATCH — count-vs-rows latency probe. Deleted after the run. */
async function main() {
  const { getTursoClient } = await import("../lib/turso");
  const c = getTursoClient();
  const t0 = performance.now();
  const r = await c.execute({ sql: "select count(*) as n from tenant_records where tenant_id=? and entity_type='lead'", args: ["ef8d389e-3f15-43f2-ae00-3660f69a1452"] });
  console.log("ok", r.rows[0], (performance.now()-t0).toFixed(0), "ms");
}
main().then(()=>process.exit(0),(e)=>{console.error("ERR", e.message); process.exit(1);});
