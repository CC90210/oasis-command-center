/**
 * /api/integrations/keys — per-tenant integration key store CRUD.
 *
 *   GET     — list every stored (service, field_key) presence + test
 *             status. NEVER returns the plaintext or ciphertext value.
 *   POST    — upsert one field. Body: { service, field_key, value }.
 *   DELETE  — remove one field. Body: { service, field_key }.
 *
 * Auth: session-cookie → tenant. Only `owner` / `admin` team roles
 * can mutate; everyone in the tenant can read presence.
 *
 * A save or a removal changes which values the app uses, so the workspace's
 * last Test of the values set on OASIS's server no longer describes them and
 * is cleared (lib/integrations/server-checks.ts): the card then says "not
 * tested yet" instead of carrying a pass that tested other values. The clear
 * runs FIRST, and a clear that fails stops the request before anything is
 * saved or removed: the other order could change the value, fail to clear, and
 * answer ok while the card applied the old pass to the new value (PR #558
 * review). A save that fails after the clear only costs the old result.
 */

import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";
import {
  setTenantIntegrationValue,
  deleteTenantIntegrationValue,
  listTenantIntegrationStatus,
  tenantMayUseEnvFallback,
} from "@/lib/tenant-integration-store";
import { clearIntegrationCheck } from "@/lib/integrations/server-checks";
import {
  findTenantManuallyEditableIntegrationSchema,
  validateIntegrationValue,
} from "@/lib/tenant-integration-schemas";
import { syncTwilioSenderRouteFor } from "@/lib/twilio/sender-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!(await canAccessSharedTenantResource(sess))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const status = await listTenantIntegrationStatus(sess.tenantId);
  return NextResponse.json({ ok: true, rows: status });
}

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!sess.isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { service?: unknown; field_key?: unknown; value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const service = typeof body.service === "string" ? body.service.toLowerCase() : "";
  const fieldKey = typeof body.field_key === "string" ? body.field_key.toLowerCase() : "";
  const value = typeof body.value === "string" ? body.value : "";

  const schema = findTenantManuallyEditableIntegrationSchema(service);
  if (!schema) {
    return NextResponse.json(
      { ok: false, error: "service_not_tenant_editable" },
      { status: 400 },
    );
  }
  const fieldDef = schema.fields.find((f) => f.key === fieldKey);
  if (!fieldDef) {
    return NextResponse.json({ ok: false, error: "unknown_field" }, { status: 400 });
  }
  const validation = validateIntegrationValue(fieldDef, value);
  if (validation) {
    return NextResponse.json({ ok: false, error: validation }, { status: 422 });
  }
  // Client workspaces connect Stripe READ-ONLY, with a restricted key, through
  // Settings › Connections (/api/connections/stripe/connect). This editor would
  // store a full secret key that can move money, so it stays OASIS's own
  // (the checkout-link key). Deleting a key stored here before is still allowed.
  if (service === "stripe" && !tenantMayUseEnvFallback(sess.tenantId)) {
    return NextResponse.json(
      {
        ok: false,
        error: "stripe_connects_with_restricted_key",
        message: "Connect Stripe from the Stripe card in Settings › Connections, with a read-only restricted key (rk_…).",
      },
      { status: 422 },
    );
  }

  if (!(await clearIntegrationCheck(sess.tenantId, service))) {
    return NextResponse.json({ ok: false, error: "check_clear_failed" }, { status: 500 });
  }
  const result = await setTenantIntegrationValue({
    tenantId: sess.tenantId,
    service,
    fieldKey,
    value,
    createdBy: sess.profileId,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  // Twilio: the webhooks find this workspace by its saved sender's routing row
  // (lib/twilio/sender-route.ts), so the row follows every save.
  const routing = service === "twilio" ? await syncTwilioSenderRouteFor(sess.tenantId, "key_saved") : undefined;
  return NextResponse.json({ ok: true, id: result.id, ...(routing ? { routing } : {}) });
}

export async function DELETE(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  }
  if (!sess.isAdmin) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }

  let body: { service?: unknown; field_key?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const service = typeof body.service === "string" ? body.service.toLowerCase() : "";
  const fieldKey = typeof body.field_key === "string" ? body.field_key.toLowerCase() : "";
  if (!service || !fieldKey) {
    return NextResponse.json({ ok: false, error: "missing_service_or_field" }, { status: 400 });
  }
  const schema = findTenantManuallyEditableIntegrationSchema(service);
  if (!schema) {
    return NextResponse.json(
      { ok: false, error: "service_not_tenant_editable" },
      { status: 400 },
    );
  }
  if (!schema.fields.some((field) => field.key === fieldKey)) {
    return NextResponse.json({ ok: false, error: "unknown_field" }, { status: 400 });
  }
  if (!(await clearIntegrationCheck(sess.tenantId, service))) {
    return NextResponse.json({ ok: false, error: "check_clear_failed" }, { status: 500 });
  }
  const result = await deleteTenantIntegrationValue({
    tenantId: sess.tenantId,
    service,
    fieldKey,
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 500 });
  }
  // A removed Twilio sender stops routing incoming texts to this workspace.
  const routing = service === "twilio" ? await syncTwilioSenderRouteFor(sess.tenantId, "key_removed") : undefined;
  return NextResponse.json({ ok: true, ...(routing ? { routing } : {}) });
}
