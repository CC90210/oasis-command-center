/**
 * Exercise the TS Turso adapter with the EXACT query shapes production uses.
 *
 * /api/auth/pair returns HTTP 500 every 60s, which has left the SunBiz VPS's
 * claude-bridge-ping crash-looping with no bridge token. The route's first DB
 * call is:
 *
 *     db.from("n8n_webhook_secrets").select("secret_hash")
 *       .eq("profile_id", id).is("revoked_at", null)
 *
 * followed by .maybeSingle() on user_profiles. If the adapter is missing any
 * link in those chains it throws, and the throw surfaces as a 500 before the
 * route can even authenticate.
 *
 * A prior audit reported this adapter had never been executed at all -- its
 * conformance test failed on a bad path before running anything. So this probe
 * is also the first real execution of it.
 *
 * Run:  node scripts/turso-adapter-probe.mjs
 * Env:  TURSO_DATABASE_URL, TURSO_AUTH_TOKEN  (vercel env pull)
 */
import { createClient } from "@libsql/client";
import { readFileSync, existsSync } from "node:fs";

// Load env from a pulled Vercel env file if the vars are not already present.
for (const f of ["probe.vars", ".env.local", ".env"]) {
  if (process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN) break;
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const i = s.indexOf("=");
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("MISSING TURSO_DATABASE_URL / TURSO_AUTH_TOKEN.");
  console.error("Run:  npx vercel env pull .env.turso-probe");
  process.exit(2);
}
console.log(`turso url length=${url.length}  token length=${token.length}\n`);

const { createTursoPostgrest } = await import("../lib/turso-postgrest.ts")
  .catch(async () => await import("../lib/turso-postgrest.js"))
  .catch((e) => {
    console.error("could not import the adapter:", e.message);
    process.exit(2);
  });

const raw = createClient({ url, authToken: token });
const db = createTursoPostgrest(raw);

let failures = 0;
async function probe(label, fn) {
  try {
    const r = await fn();
    if (r && r.error) {
      console.log(`  FAIL  ${label}\n          adapter returned error: ${JSON.stringify(r.error).slice(0, 200)}`);
      failures++;
      return;
    }
    const n = Array.isArray(r?.data) ? r.data.length : r?.data ? 1 : 0;
    console.log(`  ok    ${label}  -> ${n} row(s)`);
  } catch (e) {
    console.log(`  THROW ${label}\n          ${e?.message?.slice(0, 240)}`);
    failures++;
  }
}

console.log("=== the exact chain /api/auth/pair runs first ===");
await probe('from("n8n_webhook_secrets").select().eq().is(null)', () =>
  db.from("n8n_webhook_secrets").select("secret_hash")
    .eq("profile_id", "e356f515-de9b-411f-bd7d-8de8013c7f6d")
    .is("revoked_at", null));

console.log("\n=== the second call in that route ===");
await probe('from("user_profiles").select().eq().maybeSingle()', () =>
  db.from("user_profiles").select("email")
    .eq("id", "e356f515-de9b-411f-bd7d-8de8013c7f6d").maybeSingle());

console.log("\n=== other shapes the route uses further down ===");
await probe('from("bridge_pairings").select().limit()', () =>
  db.from("bridge_pairings").select("id").limit(1));
await probe('from("agent_model_config").select().eq().maybeSingle()', () =>
  db.from("agent_model_config").select("id").eq("tenant_id",
    "ef8d389e-3f15-43f2-ae00-3660f69a1452").maybeSingle());
await probe('from("integrations_health").select().eq()', () =>
  db.from("integrations_health").select("service,status").eq("service", "supabase"));
await probe('from("user_profiles").select().single()', () =>
  db.from("user_profiles").select("email")
    .eq("id", "e356f515-de9b-411f-bd7d-8de8013c7f6d").single());
await probe('from("tenant_records").select().order().limit()', () =>
  db.from("tenant_records").select("id").order("created_at", { ascending: false }).limit(2));

console.log(`\n${failures === 0 ? "ALL SHAPES OK" : failures + " SHAPE(S) BROKEN"}`);
process.exit(failures === 0 ? 0 : 1);
