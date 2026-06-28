#!/usr/bin/env node
/**
 * watermark_backfill.ts — one-time: brand bank statements ALREADY in Storage
 * with the SunBiz watermark (CC 2026-06-28). New uploads are watermarked at
 * ingestion; this covers statements uploaded BEFORE the feature shipped so every
 * open deal is branded before its next shop-out.
 *
 * Idempotent: skips any doc already carrying metadata.watermarked_at (safe to
 * re-run). Best-effort per doc — a failure is logged + flagged on the row
 * (metadata.watermark_error) and the shop-out door guard retries at send time.
 *
 * Run (needs BRAVO_SUPABASE_URL + BRAVO_SUPABASE_SERVICE_ROLE_KEY; the
 * --conditions flag is required for the server-only watermark module):
 *   node --conditions=react-server --env-file=.env.local --import tsx scripts/watermark_backfill.ts          # dry run (count)
 *   node --conditions=react-server --env-file=.env.local --import tsx scripts/watermark_backfill.ts --apply  # brand them
 */
import { getServiceSupabase } from "../lib/supabase-server";
import { watermarkStoredBankStatement } from "../lib/lead-documents";

const APPLY = process.argv.includes("--apply");
const PAGE = 100;

async function main() {
  const db = getServiceSupabase();

  const baseFilter = () =>
    db
      .from("lead_documents")
      .select("storage_path")
      .eq("doc_type", "bank_statements_3mo")
      .is("metadata->>deleted_at", null)
      .is("metadata->>watermarked_at", null);

  if (!APPLY) {
    const cnt = await db
      .from("lead_documents")
      .select("storage_path", { count: "exact", head: true })
      .eq("doc_type", "bank_statements_3mo")
      .is("metadata->>deleted_at", null)
      .is("metadata->>watermarked_at", null);
    if (cnt.error) {
      console.error("count query failed:", cnt.error.message);
      process.exit(1);
    }
    console.log(`DRY RUN — ${cnt.count ?? 0} un-watermarked bank statement(s) would be branded.`);
    console.log("Re-run with --apply to brand them.");
    return;
  }

  // Apply: branded rows drop out of the filter, so re-query the first page each
  // loop. Track attempted paths so persistently-failing rows (which stay
  // un-watermarked) can't loop forever — when a page yields no NEW path, stop.
  const attempted = new Set<string>();
  let total = 0;
  let branded = 0;
  let skipped = 0;
  let failed = 0;
  const failures: Array<{ path: string; reason: string }> = [];

  for (;;) {
    const res = await baseFilter().limit(PAGE);
    if (res.error) {
      console.error("query failed:", res.error.message);
      process.exit(1);
    }
    const rows = (res.data || []) as Array<{ storage_path: string }>;
    const fresh = rows.filter((r) => !attempted.has(r.storage_path));
    if (fresh.length === 0) break; // only previously-failed rows remain

    for (const r of fresh) {
      attempted.add(r.storage_path);
      total++;
      try {
        const wm = await watermarkStoredBankStatement(r.storage_path);
        if (wm.skipped) {
          skipped++;
        } else if (wm.ok) {
          branded++;
          console.log(`branded ${r.storage_path} (${wm.sizeBytes} bytes, ${wm.mimeType})`);
        } else {
          failed++;
          failures.push({ path: r.storage_path, reason: wm.error || "unknown" });
        }
      } catch (e) {
        failed++;
        failures.push({ path: r.storage_path, reason: e instanceof Error ? e.message : "threw" });
      }
    }
  }

  console.log(
    `\nAPPLIED — attempted: ${total}, branded: ${branded}, skipped(already): ${skipped}, failed: ${failed}`,
  );
  if (failures.length) {
    console.log("failures (left for the shop-out guard to retry):");
    for (const f of failures) console.log(`  ${f.path} — ${f.reason}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
