/**
 * scripts/repair-null-tenant-suppressions.mjs
 *
 * Finds email_suppressions rows with tenant_id IS NULL and re-files them against
 * the correct tenant.
 *
 * WHY THIS MATTERS: checkEmailSuppressed() filters on tenant_id, so a NULL-tenant
 * row can never match. Someone unsubscribed and is still receiving mail. The
 * 2026-08-05 audit found exactly one such row in production. The cause is the
 * /api/unsubscribe write path resolving DRIP_SUPPRESSION_BRAND to a tenant by
 * name: a value matching no tenant lands NULL and the opt-out silently does
 * nothing.
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Reads credentials the same way scripts/apply_migration.py does. Prints no
 * secrets, and masks every email address: this is an opt-out list, so the rows
 * are exactly the people who asked us to stop holding their data loosely.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require_ = createRequire(new URL("../package.json", import.meta.url));
const { createClient } = require_("@supabase/supabase-js");

function loadEnv(paths) {
  for (const p of paths) {
    let txt;
    try {
      txt = readFileSync(p, "utf8");
    } catch {
      continue;
    }
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (!process.env[m[1]]) process.env[m[1]] = v;
    }
  }
}

loadEnv([
  process.env.AGENT_ENV_FILE || "C:/Users/echel/JARVIS/.env.agents",
  "C:/Users/echel/JARVIS/.env",
]);

const APPLY = process.argv.includes("--apply");
const TENANT = process.env.SUNBIZ_TENANT_ID || "aa04fa1f-ad6a-44b0-ac4b-2ff5d1067110";

const url = process.env.BRAVO_SUPABASE_URL;
const key = process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("BRAVO_SUPABASE_URL and BRAVO_SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(2);
}
const db = createClient(url, key, { auth: { persistSession: false } });

/** a***@domain.com — enough to identify a row in a log without publishing it. */
function mask(addr) {
  const s = String(addr || "");
  const at = s.indexOf("@");
  if (at < 1) return "(malformed)";
  return `${s[0]}${"*".repeat(Math.max(1, at - 1))}${s.slice(at)}`;
}

const orphans = await db.from("email_suppressions").select("id, email, reason, tenant_id").is("tenant_id", null);
if (orphans.error) {
  console.error("query failed:", orphans.error.message);
  process.exit(2);
}

const rows = orphans.data || [];
console.log(
  JSON.stringify(
    {
      mode: APPLY ? "APPLY" : "DRY RUN",
      orphaned_rows: rows.length,
      target_tenant: TENANT.slice(0, 8) + "…",
      rows: rows.map((r) => ({ email: mask(r.email), reason: r.reason || null })),
    },
    null,
    2,
  ),
);

if (rows.length === 0) {
  console.log("nothing to repair");
  process.exit(0);
}

if (!APPLY) {
  console.log("\nDRY RUN — re-run with --apply to re-file these against the tenant.");
  process.exit(0);
}

let repaired = 0;
let failed = 0;
for (const r of rows) {
  // Do not create a duplicate if the same address is ALREADY suppressed for the
  // tenant: delete the orphan instead, so the unique constraint is respected and
  // the person stays suppressed either way.
  const existing = await db
    .from("email_suppressions")
    .select("id")
    .eq("tenant_id", TENANT)
    .ilike("email", String(r.email).replace(/[%_\\]/g, "\\$&"))
    .limit(1);
  if (existing.error) {
    console.error(`  ${mask(r.email)}: lookup failed — ${existing.error.message}`);
    failed++;
    continue;
  }

  const op =
    (existing.data || []).length > 0
      ? await db.from("email_suppressions").delete().eq("id", r.id)
      : await db.from("email_suppressions").update({ tenant_id: TENANT }).eq("id", r.id);

  if (op.error) {
    console.error(`  ${mask(r.email)}: write failed — ${op.error.message}`);
    failed++;
  } else {
    repaired++;
  }
}

// Verify CONTRIBUTION, not presence: re-query rather than trusting the writes.
const after = await db.from("email_suppressions").select("id", { count: "exact", head: true }).is("tenant_id", null);
const remaining = after.error ? `ERR ${after.error.message}` : after.count;

console.log(JSON.stringify({ repaired, failed, orphans_remaining: remaining }, null, 2));

if (failed > 0 || remaining !== 0) {
  console.error("repair incomplete");
  process.exit(1);
}

// Prove the repaired rows are now actually ENFORCED, which is the whole point.
for (const r of rows) {
  const check = await db
    .from("email_suppressions")
    .select("email")
    .eq("tenant_id", TENANT)
    .ilike("email", String(r.email).replace(/[%_\\]/g, "\\$&"))
    .limit(1);
  const enforced = !check.error && (check.data || []).length > 0;
  console.log(`  ${mask(r.email)}: ${enforced ? "NOW ENFORCED" : "STILL NOT ENFORCED"}`);
  if (!enforced) process.exit(1);
}
console.log("all orphaned opt-outs are now honored");
