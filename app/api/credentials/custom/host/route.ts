/**
 * POST /api/credentials/custom/host - set or clear the one website a custom key
 * may be sent to (CC, 2026-10-27: client workspaces' agents get their keys).
 *
 * Body: { key, host }. `host` is a website name or an https link to take it
 * from (keyHost in lib/os/custom-keys.ts); null or "" clears it, after which
 * use_custom_key cannot send the key anywhere. Owner or admin only, like the
 * vault, and only for a key the workspace has saved.
 */
import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { keyHost, keyHostProblemWords } from "@/lib/os/custom-keys";
import { clearKeyHost, saveKeyHost } from "@/lib/os/custom-key-hosts";
import { getTenantIntegrationValue, VAULT_CUSTOM_SERVICE, VAULT_KEY_PATTERN } from "@/lib/tenant-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const sess = await resolveSessionContext();
  if (!sess.ok) return NextResponse.json({ ok: false, error: sess.reason }, { status: 401 });
  if (!sess.isAdmin) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  let body: { key?: unknown; host?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const key = typeof body.key === "string" ? body.key.trim().toUpperCase() : "";
  if (!VAULT_KEY_PATTERN.test(key)) return NextResponse.json({ ok: false, error: "invalid_key" }, { status: 400 });
  const saved = await getTenantIntegrationValue(sess.tenantId, VAULT_CUSTOM_SERVICE, key.toLowerCase());
  if (saved === null) return NextResponse.json({ ok: false, error: "key_not_found" }, { status: 404 });

  if (body.host === null || body.host === "") {
    const cleared = await clearKeyHost({ tenantId: sess.tenantId, key });
    if (!cleared.ok) return NextResponse.json({ ok: false, error: "host_not_saved" }, { status: 500 });
    return NextResponse.json({ ok: true, key, host: null });
  }
  if (typeof body.host !== "string") return NextResponse.json({ ok: false, error: "invalid_host" }, { status: 400 });
  const checked = keyHost(body.host);
  if (!checked.ok) {
    return NextResponse.json({ ok: false, error: "invalid_host", problem: checked.problem, message: keyHostProblemWords(checked.problem) }, { status: 400 });
  }
  const r = await saveKeyHost({ tenantId: sess.tenantId, key, host: checked.host, createdBy: sess.profileId ?? null });
  if (!r.ok) {
    console.error("[credentials.custom.host] not saved", { tenantId: sess.tenantId, key, error: r.error });
    return NextResponse.json({ ok: false, error: "host_not_saved" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, key, host: checked.host });
}
