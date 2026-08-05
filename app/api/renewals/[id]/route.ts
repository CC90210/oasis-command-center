import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canWriteCrm } from "@/lib/role-gates";
import { getServiceSupabase } from "@/lib/supabase-server";
import { nextRenewalDate, estCommissionUsd, isTermUnit, type TermUnit } from "@/lib/renewals/derive";

export const dynamic = "force-dynamic";

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  const db = getServiceSupabase();
  const deal = await db.from("funded_deals").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!deal.data) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const row = deal.data as Record<string, unknown>;
  const [lead, lender, events] = await Promise.all([
    row.lead_id ? db.from("tenant_records").select("id,entity_type,data,updated_at").eq("tenant_id", session.tenantId).eq("id", row.lead_id).maybeSingle() : null,
    row.lender_id ? db.from("tenant_records").select("id,entity_type,data,updated_at").eq("tenant_id", session.tenantId).eq("id", row.lender_id).maybeSingle() : null,
    db.from("renewal_outreach_events").select("*").eq("tenant_id", session.tenantId).eq("funded_deal_id", id).order("created_at", { ascending: false }),
  ]);
  return NextResponse.json({ ok: true, deal: row, lead: lead?.data || null, lender: lender?.data || null, events: events.data || [] });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canWriteCrm(session.teamRole)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => ({})) as Record<string, unknown>;
  const db = getServiceSupabase();
  const existing = await db.from("funded_deals").select("*").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!existing.data) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  const current = existing.data as Record<string, unknown>;
  const amount = Number(body.funded_amount_usd ?? current.funded_amount_usd);
  const legacyTermPatch = body.term_value === undefined && body.term_months !== undefined;
  const termValue = Number(body.term_value ?? body.term_months ?? current.term_value ?? current.term_months);
  const termUnit: TermUnit = legacyTermPatch ? "months" : isTermUnit(body.term_unit)
    ? body.term_unit
    : isTermUnit(current.term_unit) ? current.term_unit : "months";
  const maxByUnit: Record<TermUnit, number> = { months: 60, weeks: 260, days: 1825 };
  const rate = Number(body.factor_rate ?? current.factor_rate);
  const points = body.points_pct === "" || body.points_pct === null ? null : Number(body.points_pct ?? current.points_pct);
  const fundedAt = String(body.funded_at ?? current.funded_at);
  if (!(amount > 0) || !Number.isInteger(termValue) || termValue < 1 || termValue > maxByUnit[termUnit] || rate < 1 || rate > 2 || !/^\d{4}-\d{2}-\d{2}$/.test(fundedAt)) {
    return NextResponse.json({ ok: false, error: "validation_failed" }, { status: 400 });
  }
  let lenderName = current.lender_name;
  const lenderId = typeof body.lender_id === "string" ? body.lender_id : current.lender_id;
  if (lenderId) {
    const lender = await db.from("tenant_records").select("data").eq("tenant_id", session.tenantId).eq("entity_type", "lender").eq("id", lenderId).maybeSingle();
    if (!lender.data) return NextResponse.json({ ok: false, error: "invalid_lender" }, { status: 400 });
    const data = lender.data.data as Record<string, unknown>;
    lenderName = data.name || data.lender_name || null;
  }
  const update = {
    lender_id: lenderId || null, lender_name: lenderName,
    funded_amount_usd: amount, factor_rate: rate,
    term_months: termUnit === "months" ? termValue : null,
    term_value: termValue, term_unit: termUnit,
    points_pct: Number.isFinite(points) ? points : null, funded_at: fundedAt,
    next_renewal_date: nextRenewalDate(fundedAt, termValue, termUnit),
    est_commission_usd: estCommissionUsd(amount, Number.isFinite(points) ? points : null),
    notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : current.notes,
  };
  const saved = await db.from("funded_deals").update(update).eq("tenant_id", session.tenantId).eq("id", id).select("*").single();
  if (saved.error) return NextResponse.json({ ok: false, error: saved.error.message }, { status: 500 });
  return NextResponse.json({ ok: true, deal: saved.data });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!canWriteCrm(session.teamRole)) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const { id } = await params;
  const db = getServiceSupabase();
  const existing = await db.from("funded_deals").select("id").eq("tenant_id", session.tenantId).eq("id", id).maybeSingle();
  if (!existing.data) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const events = await db.from("renewal_outreach_events").select("scheduled_send_id")
    .eq("tenant_id", session.tenantId).eq("funded_deal_id", id).not("scheduled_send_id", "is", null);
  if (events.error) return NextResponse.json({ ok: false, error: "outreach_check_failed" }, { status: 500 });
  const sendIds = (events.data || []).map((event) => event.scheduled_send_id as string | null)
    .filter((sendId): sendId is string => Boolean(sendId));
  if (sendIds.length) {
    const sends = await db.from("scheduled_sends").select("id,status")
      .eq("tenant_id", session.tenantId).in("id", sendIds);
    if (sends.error) return NextResponse.json({ ok: false, error: "outreach_check_failed" }, { status: 500 });
    if ((sends.data || []).some((send) => send.status === "sending")) {
      return NextResponse.json(
        { ok: false, error: "outreach_in_progress", message: "Wait for the active lender email attempt to finish before deleting this renewal." },
        { status: 409 },
      );
    }
    const cancellableIds = (sends.data || []).filter((send) => ["pending", "failed"].includes(String(send.status))).map((send) => send.id);
    if (cancellableIds.length) {
      const cancelled = await db.from("scheduled_sends").update({ status: "cancelled" })
        .eq("tenant_id", session.tenantId).in("id", cancellableIds);
      if (cancelled.error) return NextResponse.json({ ok: false, error: "cancel_failed" }, { status: 500 });
    }
  }

  const removed = await db.from("funded_deals").delete().eq("tenant_id", session.tenantId).eq("id", id).select("id").maybeSingle();
  if (removed.error) return NextResponse.json({ ok: false, error: removed.error.message }, { status: 500 });
  if (!removed.data) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, deleted_id: removed.data.id });
}
