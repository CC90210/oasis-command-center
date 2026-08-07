/**
 * Poll endpoint replacing Supabase Realtime broadcast for live refresh.
 *
 * Returns an opaque version token for a scope. The client refreshes when the
 * token changes. Cheap by construction: one indexed lookup, no row data.
 *
 * A caller may only poll a scope that belongs to THEM. The scope is derived
 * from the session, never taken from the query string — otherwise one rep could
 * poll another's board token and learn when that rep's deals change. The old
 * broadcast had the same property by design (a user subscribed to
 * `board:<their own uid>`), and losing it while "just swapping transports"
 * is exactly the kind of quiet regression this migration keeps producing.
 */
import { NextRequest, NextResponse } from "next/server";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { nudgePollingActive, readScope } from "@/lib/realtime/nudge-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!nudgePollingActive()) {
    // Supabase Realtime is still the transport — tell the client to stay on it
    // rather than polling as well.
    return NextResponse.json({ polling: false, token: "" });
  }
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const kind = req.nextUrl.searchParams.get("kind");

  let scope: string;
  if (kind === "board") {
    scope = `board:${user.id}`;                 // always the caller's own board
  } else if (kind === "conversations") {
    // The caller's OWN tenant, resolved server-side. An earlier version took
    // tenantId from the query string, which would have let any signed-in user
    // poll another tenant's token and learn when that tenant's conversations
    // change — a timing side channel the broadcast version did not have.
    const db = getServiceSupabase();
    const { data } = await db
      .from("user_profiles")
      .select("tenant_id")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    const tenantId = (data as { tenant_id?: string } | null)?.tenant_id;
    if (!tenantId) {
      return NextResponse.json({ ok: false, error: "no tenant" }, { status: 403 });
    }
    scope = `conversations:${tenantId}`;
  } else {
    return NextResponse.json({ ok: false, error: "unknown kind" }, { status: 400 });
  }

  return NextResponse.json(
    { polling: true, token: await readScope(scope) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
