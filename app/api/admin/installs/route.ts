/**
 * /api/admin/installs - the operator's install console, as an API.
 *
 *   GET   every workspace: name, owner, members, set up or not, last activity.
 *   POST  create a NEW client workspace and set it up in one step.
 *         Body: { name, slug, departments[], modules[], chat_apps[], jev }
 *
 * Operators only (lib/provisioning/operator-session.ts). Anyone else gets a
 * 404, never a 403: a client learning that an install console exists is a leak
 * that costs nothing to avoid (same rule as the /admin pages).
 */

import { NextResponse, type NextRequest } from "next/server";
import { listInstalls } from "@/lib/provisioning/installs";
import { operatorFromSession } from "@/lib/provisioning/operator-session";
import { provisionTenant } from "@/lib/provisioning/provision-tenant";
import { parseProvisionBody } from "@/lib/provisioning/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NOT_FOUND = () => NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

export async function GET() {
  const operator = await operatorFromSession();
  if (!operator) return NOT_FOUND();
  try {
    return NextResponse.json({ ok: true, installs: await listInstalls() });
  } catch (err) {
    console.error("[admin.installs.list]", err);
    return NextResponse.json(
      { ok: false, error: "installs_unavailable", message: "Could not read the workspace list. Try again." },
      { status: 503 },
    );
  }
}

export async function POST(req: NextRequest) {
  const operator = await operatorFromSession();
  if (!operator) return NOT_FOUND();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const parsed = parseProvisionBody(body);
  const result = await provisionTenant({
    operator,
    target: { create: { name: String(body.name ?? ""), slug: String(body.slug ?? "") } },
    ...parsed,
  });
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: result.error, message: result.message, run_id: result.runId ?? null, steps: result.steps ?? [] },
      { status: result.status },
    );
  }
  return NextResponse.json(result, { status: 201 });
}
