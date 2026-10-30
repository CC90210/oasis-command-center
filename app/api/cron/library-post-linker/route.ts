import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTursoClient } from "@/lib/turso";
import { cloudJobDryRun, cloudJobEnabled } from "@/lib/cloud-jobs/control";
import { runLibraryPostLinker } from "@/lib/cloud-jobs/library-post-linker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: NextRequest) {
  if (!cloudJobEnabled("LIBRARY_POST_LINKER_ENABLED")) {
    return NextResponse.json({ ok: true, skipped: "library_post_linker_disabled" });
  }
  const denied = checkCronAuth(request);
  if (denied) return denied;
  try {
    const dryRun = cloudJobDryRun(request, "LIBRARY_POST_LINKER_DRY_RUN");
    const result = await runLibraryPostLinker({
      db: getTursoClient(),
      dryRun,
    });
    if (result.conflicts.length > 0) {
      return NextResponse.json({
        ok: false,
        error: "library_post_linker_conflicts",
        dry_run: dryRun,
        dry_run_scope: dryRun ? "database_read_only" : "live",
        ...result,
      }, { status: 409 });
    }
    return NextResponse.json({
      ok: true,
      dry_run: dryRun,
      dry_run_scope: dryRun ? "database_read_only" : "live",
      ...result,
    });
  } catch (error) {
    console.error("[cron.library-post-linker]", error instanceof Error ? error.stack : error);
    return NextResponse.json({ ok: false, error: "library_post_linker_failed" }, { status: 500 });
  }
}
