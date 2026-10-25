/**
 * /api/ai-audit/settings — the workspace's tax rule, deposit default, default
 * currency, engine and turnaround wording.
 *
 *   GET                         the settings and their row version
 *   POST { settings, expected_row_version }   owner only
 *
 * There is no default tax rule on purpose: CC sets it once (registered or not,
 * and the rate) before the first real proposal can be submitted.
 */
import { NextResponse, type NextRequest } from "next/server";
import { requireAiAuditSession } from "@/lib/ai-audit/access";
import { getSettings, parseSettings, saveSettings } from "@/lib/ai-audit/store";
import { validateTaxRule } from "@/lib/ai-audit/proposal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" };
const json = (status: number, body: Record<string, unknown>) => NextResponse.json(body, { status, headers: NO_STORE });

export async function GET() {
  const access = await requireAiAuditSession();
  if (!access.ok) return access.response;
  const r = await getSettings(access.session.db, access.session.tenantId);
  return json(200, { ok: true, settings: r.settings, row_version: r.rowVersion, viewer: { is_owner: access.session.isOwner } });
}

export async function POST(req: NextRequest) {
  const access = await requireAiAuditSession({ ownerOnly: true });
  if (!access.ok) return access.response;
  const s = access.session;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !body.settings || typeof body.settings !== "object") return json(400, { ok: false, error: "settings_required" });
  const raw = body.settings as Record<string, unknown>;
  if (raw.tax !== null && raw.tax !== undefined) {
    const tax = validateTaxRule(raw.tax);
    if (!tax.ok) return json(400, { ok: false, error: "tax_invalid", field: tax.field, detail: tax.error });
  }
  const rv = Number(body.expected_row_version);
  if (!Number.isInteger(rv) || rv < 0) return json(400, { ok: false, error: "expected_row_version_required" });
  const settings = parseSettings(raw);
  const r = await saveSettings(s.db, { tenantId: s.tenantId, settings, expectedRowVersion: rv, actorId: s.userId, now: new Date() });
  if (!r.ok) return json(409, { ok: false, error: "changed_elsewhere_refresh" });
  const after = await getSettings(s.db, s.tenantId);
  return json(200, { ok: true, settings: after.settings, row_version: after.rowVersion });
}
