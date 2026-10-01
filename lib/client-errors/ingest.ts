import "server-only";

/**
 * Store one validated crash report (shape: lib/client-errors/shape.ts).
 *
 * Only a report from a signed-in session becomes a row. /api/client-errors is
 * a public write route (signed-out pages must be able to report), so a report
 * with no session is logged by the route and never stored: an unauthenticated
 * caller cannot fill the table, whatever Origin header it forges.
 *
 * Before migration bravo__198 is applied the table does not exist; that is
 * reported as `stored: false`, never thrown.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import type { ClientErrorReport } from "./shape";

export type ReportContext = { tenantId: string | null; userId: string | null; userAgent: string | null };
export type IngestResult = { stored: boolean; reason: "stored" | "anonymous" | "table_missing" | "write_failed" };

type Db = Pick<ReturnType<typeof getServiceSupabase>, "from">;

export async function storeClientErrorReport(
  report: ClientErrorReport,
  ctx: ReportContext,
  db: Db = getServiceSupabase(),
): Promise<IngestResult> {
  if (!ctx.tenantId || !ctx.userId) return { stored: false, reason: "anonymous" };
  const { error } = await db.from("client_error_reports").insert({
    id: crypto.randomUUID(),
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    kind: report.kind,
    name: report.name,
    message: report.message,
    stack: report.stack,
    digest: report.digest,
    path: report.path,
    user_agent: ctx.userAgent,
  });
  if (!error) return { stored: true, reason: "stored" };
  if (/no such table/i.test(error.message)) return { stored: false, reason: "table_missing" };
  console.error("[client.error.store]", error.message);
  return { stored: false, reason: "write_failed" };
}
