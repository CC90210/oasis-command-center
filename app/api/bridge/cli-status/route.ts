import { NextResponse } from "next/server";

import {
  CLI_INVENTORY_SERVICE,
  normalizeCliMachines,
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
  // One entry per paired computer (lib/bridge-cli-status.ts). A computer whose
  // pairing was revoked disappears here; if the pairings cannot be read the
  // filter is skipped (logged) rather than hiding every computer.
  const pairings = await db
    .from("bridge_pairings")
    .select("id, label")
    .eq("tenant_id", tenantId)
    .is("revoked_at", null);
  let active: Map<string, string | null> | null = null;
  if (pairings.error) {
    console.error("[bridge.cli_status.pairings]", pairings.error.message);
  } else {
    active = new Map(((pairings.data || []) as Array<{ id: string; label: string | null }>).map((p) => [p.id, p.label]));
  }
  const normalized = normalizeCliMachines(row?.metadata, row?.last_ping_at, active);
  return NextResponse.json(normalized, {
    headers: { "cache-control": "no-store" },
  });
}
