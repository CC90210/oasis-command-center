import { NextResponse, type NextRequest } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { vaultServiceDefinition } from "@/lib/credential-vault/catalog";
import { checkVaultService } from "@/lib/credential-vault/service-checks";
import { getTenantIntegrationBundleStrict, VAULT_CUSTOM_SERVICE } from "@/lib/tenant-integration-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: session.reason }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });

  let body: { provider?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const definition = vaultServiceDefinition(body.provider);
  if (!definition) return NextResponse.json({ ok: false, error: "unknown_provider" }, { status: 400 });

  // Vault-only by design. A workspace status card must never turn green from
  // an operator process's environment or accidentally probe another account.
  try {
    const bundle = await getTenantIntegrationBundleStrict(session.tenantId, VAULT_CUSTOM_SERVICE);
    const status = await checkVaultService(definition, bundle);
    return NextResponse.json({ ok: true, status });
  } catch (error) {
    console.error("[credentials.custom.status] vault read failed", {
      tenantId: session.tenantId,
      provider: definition.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: "vault_unavailable" }, { status: 503 });
  }
}
