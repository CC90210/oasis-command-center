/**
 * GET /api/quests — read-only quest list for the OASIS Town Quest Log.
 *
 * Returns CC's live ACTIVE_TASKS.md state as rows from the `oasis_quests`
 * table.
 *
 * OPERATOR-ONLY since 2026-09-28 (P0-6, doc 02 F2). It was a public path "for
 * Phase 5 proof-of-life", which served CC's whole task list (55 rows of
 * internal work, counted live 2026-09-28) to anyone on the internet. It is off
 * middleware's public list and admits a platform operator session only:
 * 401 without a session, 404 for anyone else. The OASIS Town Convex backend
 * that polled it every 60 s holds no session, so it no longer reads this; if
 * that consumer is still alive it needs its own credential, not a public URL.
 *
 * Query params:
 *   status?     'open' | 'completed' | 'archived'   (default: not 'archived')
 *   bucket?     substring filter on bucket name
 *   limit?      default 200, max 500
 *   since_ms?   only quests updated_at > since_ms (cursor-style polling)
 */

import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { bad } from "@/lib/api-helpers";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  // Before any read. Middleware already 401s a signed-out caller; this is the
  // wall for a signed-in non-operator, and the backstop if the path is ever
  // made public again.
  const op = await resolvePlatformOperator();
  if (!op.operator) return op.reason === "no_session" ? bad(401, "unauthorized") : bad(404, "not_found");

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const bucket = url.searchParams.get("bucket");
  const sinceMs = url.searchParams.get("since_ms");
  const limit = Math.min(
    Math.max(parseInt(url.searchParams.get("limit") || "200", 10) || 200, 1),
    500,
  );

  try {
    const db = getServiceSupabase();
    let q = db
      .from("oasis_quests")
      .select(
        "id, bucket, title, owner, status, source_file, source_line, " +
          "first_seen_at, completed_at, updated_at",
      )
      .order("updated_at", { ascending: false })
      .limit(limit);
    if (status) q = q.eq("status", status);
    else q = q.neq("status", "archived");
    if (bucket) q = q.ilike("bucket", `%${bucket}%`);
    if (sinceMs) {
      const iso = new Date(parseInt(sinceMs, 10)).toISOString();
      q = q.gt("updated_at", iso);
    }
    const { data, error } = await q;
    if (error) return bad(500, error.message);

    return NextResponse.json({
      ok: true,
      count: (data || []).length,
      rows: data || [],
    });
  } catch (err) {
    return bad(500, err instanceof Error ? err.message : "quests fetch failed");
  }
}
