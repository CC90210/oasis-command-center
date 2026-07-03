/**
 * /api/campaigns/constant-contact/contacts
 *   GET  → list/search contacts (paginated via cursor, filterable by email/lists/segment/status/tags).
 *   POST → create a contact.
 * Admin-only, fails closed.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCcAdmin, ccError } from "@/lib/integrations/constant-contact/route-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;
  const { client } = gate.ctx;

  const sp = req.nextUrl.searchParams;
  const limit = sp.get("limit");
  const cursor = sp.get("cursor");
  const email = sp.get("email");
  const lists = sp.get("lists");
  const segment_id = sp.get("segment_id");
  const status = sp.get("status");
  const tags = sp.get("tags");

  try {
    const result = await client.listContacts({
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? undefined,
      email: email ?? undefined,
      lists: lists ?? undefined,
      segment_id: segment_id ?? undefined,
      status: status ?? undefined,
      tags: tags ?? undefined,
      include: "custom_fields,list_memberships,taggings,phone_numbers,street_addresses",
    });
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireCcAdmin();
  if (!gate.ok) return gate.res;

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }
  const emailAddress = body.email_address as { address?: string } | string | undefined;
  const hasEmail = typeof emailAddress === "string" ? !!emailAddress : !!emailAddress?.address;
  if (!hasEmail) return NextResponse.json({ ok: false, error: "email_address_required" }, { status: 400 });

  try {
    const result = await gate.ctx.client.createContact(body);
    return NextResponse.json({ ok: true, ...(result as Record<string, unknown>) });
  } catch (e) {
    return ccError(e);
  }
}
