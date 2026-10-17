/**
 * POST /api/founders/marketing/assets/[id]/request-changes  { note }
 *
 * Send one in-review Library asset back to the marketing agent with a note.
 * The approve, archive, restore and delete verdicts already live on the
 * sibling route (../route.ts) and are used as they are; this is the one the
 * Library could not do. What it writes, in what order and why is in
 * lib/founders/request-changes.ts.
 *
 * GUARDS, in the order they are checked:
 *   1. Founders portal only: resolveFounder() (the founders tenant, and a persona
 *      that may see Marketing). Anyone else gets 404, never 403 - a 403 would
 *      confirm the route exists (lib/founders/gate.ts). This is EXACTLY the gate
 *      on the sibling verbs (../route.ts: Approve, Archive, Restore, Delete), so
 *      whoever can pass a verdict in the Library can also send an asset back;
 *      the mildest verb is not stricter than the rest.
 *   2. The note is required: a request with no words in it says something was
 *      wrong and not where, so it is refused (400 note_required) before any read.
 *   3. The asset must be in the founder's own workspace (tenant_id on every
 *      query) and still in review (409 not_in_review / status_changed).
 *
 * Does NOT book, schedule or post anything, and touches no stored file.
 */

import { NextResponse } from "next/server";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveFounder } from "@/lib/founders/gate";
import { methodNotHere } from "@/lib/founders/method-guard";
import { checkRequestChangesBody, requestChanges } from "@/lib/founders/request-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const notFound = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

/** An asset id as this app stores it: letters, digits, dash, underscore. Anything else matches nothing. */
const ASSET_ID = /^[A-Za-z0-9_-]{1,64}$/;

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const founder = await resolveFounder();
  if (!founder) return notFound();

  const { id } = await ctx.params;
  if (!ASSET_ID.test(id)) return notFound();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const checked = checkRequestChangesBody(body);
  if (!checked.ok) return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });

  const result = await requestChanges(getServiceSupabase(), {
    tenantId: founder.tenantId,
    assetId: id,
    note: checked.note,
    reviewer: founder.displayName || "founder",
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, ...(result.current !== undefined ? { status: result.current } : {}) },
      { status: result.http },
    );
  }
  return NextResponse.json({ ok: true, asset: result.asset, review_recorded: true });
}

// Verbs this route does not implement answer 404, not the framework's 405.
// A 405 confirms the path is real, which is exactly what lib/founders/gate.ts
// refuses to tell a tenant that is not ours. See lib/founders/method-guard.ts.
export const GET = methodNotHere;
export const PUT = methodNotHere;
export const PATCH = methodNotHere;
export const DELETE = methodNotHere;
