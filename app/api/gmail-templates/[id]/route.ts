/**
 * /api/gmail-templates/[id]
 *
 *   PATCH  → update name/stage/subject/body, and/or remove one attached
 *            variant via { removeVariantId }.
 *   DELETE → hard-delete the template (variants go with it).
 *
 * Tenant-scoped on every query; CRM-write role required for both verbs.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getServiceSupabase } from "@/lib/supabase-server";
import { canWriteCrm } from "@/lib/role-gates";
import { validateGmailTemplateFields } from "@/lib/gmail-templates-server";
import type { GmailTemplate, GmailTemplateVariant } from "@/lib/gmail-templates";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function authAndFetch(id: string) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return { fail: NextResponse.json({ ok: false, error: sess.reason }, { status: 401 }) } as const;
  }
  if (!canWriteCrm(sess.teamRole) || !(await canAccessSharedTenantResource(sess))) {
    return { fail: NextResponse.json({ ok: false, error: "forbidden_role" }, { status: 403 }) } as const;
  }
  if (!UUID_RE.test(id)) {
    return { fail: NextResponse.json({ ok: false, error: "invalid_id" }, { status: 400 }) } as const;
  }
  const db = getServiceSupabase();
  const row = await db
    .from("gmail_templates")
    .select("*")
    .eq("tenant_id", sess.tenantId)
    .eq("id", id)
    .maybeSingle();
  if (row.error) {
    return {
      fail: NextResponse.json(
        { ok: false, error: "fetch_failed", message: row.error.message },
        { status: 500 },
      ),
    } as const;
  }
  if (!row.data) {
    return { fail: NextResponse.json({ ok: false, error: "not_found" }, { status: 404 }) } as const;
  }
  return { sess, db, template: row.data as GmailTemplate } as const;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const acc = await authAndFetch(id);
  if ("fail" in acc) return acc.fail;

  let body: Record<string, unknown>;
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const validated = validateGmailTemplateFields(body, { partial: true });
  if (!validated.ok) {
    return NextResponse.json(validated, { status: 400 });
  }

  const update: Record<string, unknown> = { ...validated.fields };

  if (body.removeVariantId !== undefined) {
    if (typeof body.removeVariantId !== "string" || !body.removeVariantId) {
      return NextResponse.json({ ok: false, error: "invalid_variant_id" }, { status: 400 });
    }
    const variants = (acc.template.variants ?? []) as GmailTemplateVariant[];
    const next = variants.filter((v) => v.id !== body.removeVariantId);
    if (next.length === variants.length) {
      return NextResponse.json({ ok: false, error: "variant_not_found" }, { status: 404 });
    }
    update.variants = next;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ ok: false, error: "nothing_to_update" }, { status: 400 });
  }
  update.updated_at = new Date().toISOString();

  const res = await acc.db
    .from("gmail_templates")
    .update(update)
    .eq("tenant_id", acc.sess.tenantId)
    .eq("id", id)
    .select("*")
    .single();
  if (res.error) {
    return NextResponse.json(
      { ok: false, error: "update_failed", message: res.error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true, template: res.data as GmailTemplate });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const acc = await authAndFetch(id);
  if ("fail" in acc) return acc.fail;

  const res = await acc.db
    .from("gmail_templates")
    .delete()
    .eq("tenant_id", acc.sess.tenantId)
    .eq("id", id);
  if (res.error) {
    return NextResponse.json(
      { ok: false, error: "delete_failed", message: res.error.message },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
