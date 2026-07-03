/**
 * Shared admin-gate for the Constant Contact console routes. Every CC route is
 * admin-only and requires a connected account; this centralizes that check so no
 * route forgets it. Fails closed (any missing piece → an error NextResponse).
 */
import "server-only";
import { NextResponse } from "next/server";
import { resolveSessionContext, type SessionContext } from "@/lib/api-auth";
import { getConstantContactClient, ccIsConnected } from "./store";
import type { ConstantContactClient } from "./client";

type AdminSession = Extract<SessionContext, { ok: true }>;
export type CcAdminCtx = { session: AdminSession; client: ConstantContactClient };

/** Admin-gated + connected CC client, or a NextResponse error to return early. */
export async function requireCcAdmin(): Promise<{ ok: true; ctx: CcAdminCtx } | { ok: false; res: NextResponse }> {
  const session = await resolveSessionContext();
  if (!session.ok) return { ok: false, res: NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 }) };
  if (!session.isAdmin) return { ok: false, res: NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 }) };
  if (!(await ccIsConnected(session.tenantId))) return { ok: false, res: NextResponse.json({ ok: false, error: "not_connected" }, { status: 400 }) };
  const client = await getConstantContactClient(session.tenantId);
  if (!client) return { ok: false, res: NextResponse.json({ ok: false, error: "not_connected" }, { status: 400 }) };
  return { ok: true, ctx: { session, client } };
}

/** The primary_email activity id for a campaign (most report/schedule calls key off it). */
export async function resolvePrimaryActivityId(client: ConstantContactClient, campaignId: string): Promise<string | null> {
  const camp = (await client.getCampaign(campaignId)) as { campaign_activities?: { role?: string; campaign_activity_id: string }[] };
  const acts = camp.campaign_activities || [];
  const primary = acts.find((a) => a.role === "primary_email") || acts[0];
  return primary?.campaign_activity_id || null;
}

/** Uniform 502 for a failed CC call (message truncated, never leaks a token). */
export function ccError(e: unknown) {
  const msg = (e as Error)?.message || "cc_error";
  const status = /rate limited|\b429\b/.test(msg) ? 429 : 502;
  return NextResponse.json({ ok: false, error: "cc_call_failed", message: msg.slice(0, 200) }, { status });
}
