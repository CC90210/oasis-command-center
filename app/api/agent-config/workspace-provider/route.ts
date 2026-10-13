/**
 * Compatibility endpoint for dashboard builds from before the canonical
 * AI Brain engine configurator. Provider activation now requires a tested
 * staged-key receipt plus the current engine version, neither of which this
 * old payload carries. Fail closed so an old tab cannot race or bypass the
 * atomic PUT /api/ai/engine flow.
 */
import { NextRequest, NextResponse } from "next/server";
import { canManageTeam, getSessionContext } from "@/lib/team";
import { type Provider } from "@/lib/providers";
import { SWITCHABLE_PROVIDERS } from "@/lib/ai/agent-engine-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const fail = (status: number, error: string, message: string) =>
  NextResponse.json({ ok: false, error, message }, { status });

export async function POST(req: NextRequest) {
  const ctx = await getSessionContext();
  if (!ctx?.tenantId) return fail(401, "unauthorized", "Your session ended. Sign in again, then try again.");
  if (!(ctx.isOwner || canManageTeam(ctx.teamRole, ctx.adminAccess))) {
    return fail(403, "admin_required", "Only an owner or admin can change the AI provider your agents use.");
  }
  let body: { provider?: unknown };
  try {
    body = (await req.json()) as { provider?: unknown };
  } catch {
    return fail(400, "invalid_json", "That request could not be read. Try again.");
  }
  const provider = (typeof body.provider === "string" ? body.provider.trim() : "") as Provider;
  if (!SWITCHABLE_PROVIDERS.includes(provider)) {
    return fail(400, "invalid_provider", "Pick Anthropic, OpenAI, Google or OpenRouter.");
  }
  return fail(
    409,
    "engine_upgrade_required",
    "Refresh Settings > AI brain, choose this provider under Workspace default, then Test and Use it. Nothing was changed.",
  );
}
