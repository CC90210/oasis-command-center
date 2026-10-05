/**
 * GET /api/integrations/constant-contact/status — is Constant Contact connected
 * for this tenant + which account. When connected, calls Constant Contact
 * server-side (with the real decryption key) to return the account name + verified
 * sender emails so the operator can confirm the RIGHT account is linked.
 */
import { NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { ccIsConnected, ccCredentials, getConstantContactClient } from "@/lib/integrations/constant-contact/store";
import { canAccessSharedTenantResource } from "@/lib/shared-tenant-resource-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SenderEmail = { email_address?: string; confirm_status?: string };

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!(await canAccessSharedTenantResource(session))) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const tenantId = session.tenantId;
  const [connected, creds] = await Promise.all([ccIsConnected(tenantId), ccCredentials(tenantId)]);

  let account: { org: string | null; emails: { email: string; status: string }[] } | null = null;
  let token_ok = false;
  if (connected) {
    try {
      const client = await getConstantContactClient(tenantId);
      if (client) {
        const [summary, emails] = await Promise.all([
          client.getAccountSummary().catch(() => null),
          client.getSenderEmails().catch(() => null),
        ]);
        const s = (summary || {}) as { organization_name?: string; company_name?: string };
        const list: SenderEmail[] = Array.isArray(emails)
          ? (emails as SenderEmail[])
          : ((emails as { account_emails?: SenderEmail[] } | null)?.account_emails || []);
        // A successful call proves the stored token works right now.
        token_ok = summary !== null || emails !== null;
        account = {
          org: s.organization_name || s.company_name || null,
          emails: list.map((e) => ({ email: e.email_address || "", status: e.confirm_status || "" })).filter((e) => e.email).slice(0, 12),
        };
      }
    } catch {
      account = null;
    }
  }

  return NextResponse.json({
    ok: true,
    connected,
    configured: !!creds,
    can_connect: session.isAdmin,
    token_ok,
    account,
  });
}
