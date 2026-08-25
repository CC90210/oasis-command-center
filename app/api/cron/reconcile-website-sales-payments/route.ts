import { NextResponse, type NextRequest } from "next/server";
import { checkCronAuth } from "@/lib/cron-auth";
import { getTenantIntegrationValue } from "@/lib/tenant-integration-store";
import { getTursoClient } from "@/lib/turso";
import { reconcileWebsiteSalesPayments } from "@/lib/website-sales-payment-reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

async function handle(req: NextRequest): Promise<NextResponse> {
  const denied = checkCronAuth(req);
  if (denied) return denied;

  try {
    const result = await reconcileWebsiteSalesPayments(getTursoClient(), {
      resolveStripeSecret: (tenantId) =>
        getTenantIntegrationValue(tenantId, "stripe", "secret_key"),
    });
    if (result.errors.length > 0) {
      for (const failure of result.errors) {
        console.error("[reconcile-website-sales-payments] receipt failed", failure);
      }
      return NextResponse.json(
        { ok: false, ...result },
        { status: 500 },
      );
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "website_sales_reconciliation_failed";
    console.error("[reconcile-website-sales-payments] run failed", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
