import { NextResponse } from "next/server";

import {
  CLI_INVENTORY_SERVICE,
  normalizeCliSnapshot,
} from "@/lib/bridge-cli-status";
import { getServiceSupabase, getSessionUser } from "@/lib/supabase-server";
import { getActiveProfile } from "@/lib/queries";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  }

  const db = getServiceSupabase();
  const profileRow = await getActiveProfile() as {
    id?: string | null;
    tenant_id?: string | null;
  } | null;
  const tenantId = profileRow?.tenant_id;
  const profileId = profileRow?.id;
  if (!tenantId || !profileId) {
    return NextResponse.json({ ok: false, reason: "missing" });
  }

  const snapshot = await db
    .from("integrations_health")
    .select("metadata, last_ping_at")
    .eq("tenant_id", tenantId)
    .eq("profile_id", profileId)
    .eq("service", CLI_INVENTORY_SERVICE)
    .order("last_ping_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (snapshot.error) {
    return NextResponse.json({ ok: false, reason: "inventory_lookup_failed" }, { status: 500 });
  }

  const row = snapshot.data as {
    metadata?: unknown;
    last_ping_at?: string | null;
  } | null;
  const normalized = normalizeCliSnapshot(row?.metadata, row?.last_ping_at);
  return NextResponse.json(normalized, {
    headers: { "cache-control": "no-store" },
  });
}
