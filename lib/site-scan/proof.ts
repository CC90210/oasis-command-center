import "server-only";
import { safe } from "@/lib/api-helpers";
import { AI_AUDIT_TENANT_ID } from "@/lib/forms/oasis-ai-audit-seed";
import { scanCounts, siteScanTablesInstalled } from "@/lib/site-scan/store";
import { getTursoClient, tursoConfigured } from "@/lib/turso";

/** The counts the public scan page shows as proof, or null when they cannot be read (never a guess). */
export async function proofCounts(): Promise<{ scans: number; domains: number } | null> {
  if (!tursoConfigured()) return null;
  const db = getTursoClient();
  if (!(await safe("scan.counts.installed", siteScanTablesInstalled(db), false))) return null;
  return safe("scan.counts", scanCounts(db, AI_AUDIT_TENANT_ID), null);
}
