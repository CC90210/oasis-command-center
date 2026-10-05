/**
 * /api/gmail-templates — tenant-scoped Gmail (plain-text) template library.
 *
 *   GET  → list every template for the caller's tenant (newest first).
 *   POST → create { name, stage, subject?, body }.
 *
 * All reads/writes go through the service-role client with tenant scoping
 * enforced here (the table is RLS-locked to service_role + tenant policy).
 * Plain-text + compliance validation lives in lib/gmail-templates-server.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canWriteCrm } from "@/lib/role-gates";
import { validateGmailTemplateFields } from "@/lib/gmail-templates-server";
import type { GmailTemplate } from "@/lib/gmail-templates";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!(await canAccessSharedTenantResource(sess))) {
    return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
  }
  const db = getServiceSupabase();
  const res = await db
    .from("gmail_templates")
    .select("*")
    .eq("tenant_id", sess.tenantId)
    .order("updated_at", { ascending: false });
  if (res.error) {
    return NextResponse.json(
      { ok: false, error: "list_failed", message: res.error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, templates: (res.data ?? []) as GmailTemplate[] });
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!canWriteCrm(sess.teamRole) || !(await canAccessSharedTenantResource(sess))) {
    return NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const validated = validateGmailTemplateFields(
    (body ?? {}) as Record<string, unknown>,
    { partial: false },
  );
  if (!validated.ok) {
    return NextResponse.json(validated, { status: 400 });
  }

  const db = getServiceSupabase();
  const ins = await db
    .from("gmail_templates")
    .insert({
      tenant_id: sess.tenantId,
      name: validated.fields.name,
      stage: validated.fields.stage,
      subject: validated.fields.subject ?? "",
      body: validated.fields.body,
      variants: [],
      created_by: sess.userId,
    })
    .select("*")
    .single();
  if (ins.error) {
    return NextResponse.json(
      { ok: false, error: "insert_failed", message: ins.error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, template: ins.data as GmailTemplate });
}
