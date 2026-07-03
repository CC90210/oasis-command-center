/**
 * /api/campaigns/constant-contact — Email Blast composer backend.
 *   GET  → composer data: confirmed senders, CC lists, templates, SunBiz stages.
 *   POST → { action:'test'|'launch' } runs a blast through the shared core
 *          (lib/integrations/constant-contact/blast.ts): suppression filter →
 *          blast-safety guard → dry-run gate → import audience → create + send.
 * Admin-only (tenant-shared integration).
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveSessionContext } from "@/lib/api-auth";
import { getConstantContactClient, ccIsConnected } from "@/lib/integrations/constant-contact/store";
import { renderTemplate, resolveSunbizAudience, runBlast, listRenderedTemplates } from "@/lib/integrations/constant-contact/blast";
import { SUNBIZ_TEMPLATE_CATEGORIES } from "@/lib/sunbiz-templates-library";
import { LEAD_PIPELINE_STAGES } from "@/lib/sunbiz-stage-meta";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type SenderEmail = { email_address?: string; confirm_status?: string };
type CcList = { list_id?: string; name?: string; membership_count?: number };

export async function GET() {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!(await ccIsConnected(session.tenantId))) return NextResponse.json({ ok: false, error: "not_connected" }, { status: 400 });

  const client = await getConstantContactClient(session.tenantId);
  let senders: { email: string; confirmed: boolean }[] = [];
  let ccLists: { id: string; name: string; count: number }[] = [];
  if (client) {
    const [em, ls] = await Promise.all([client.getSenderEmails().catch(() => null), client.getContactLists().catch(() => null)]);
    const emList: SenderEmail[] = Array.isArray(em) ? (em as SenderEmail[]) : ((em as { account_emails?: SenderEmail[] } | null)?.account_emails || []);
    senders = emList.map((e) => ({ email: e.email_address || "", confirmed: (e.confirm_status || "").toUpperCase() === "CONFIRMED" })).filter((e) => e.email);
    const lsList: CcList[] = Array.isArray(ls) ? (ls as CcList[]) : ((ls as { lists?: CcList[] } | null)?.lists || []);
    ccLists = lsList.map((l) => ({ id: l.list_id || "", name: l.name || "", count: l.membership_count || 0 })).filter((l) => l.id);
  }

  const tpls = await listRenderedTemplates(session.tenantId);
  return NextResponse.json({
    ok: true,
    senders,
    cc_lists: ccLists,
    stages: LEAD_PIPELINE_STAGES.map((s) => ({ key: s.key, label: s.label })),
    templates: {
      categories: SUNBIZ_TEMPLATE_CATEGORIES,
      sunbiz: tpls.sunbiz,
      cold: tpls.cold,
      custom: tpls.custom,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await resolveSessionContext();
  if (!session.ok) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  if (!session.isAdmin) return NextResponse.json({ ok: false, error: "admin_only" }, { status: 403 });

  let body: {
    action?: string;
    audience?: { type?: string; stage?: string; list_id?: string };
    template?: { source?: string; id?: string };
    subject?: string;
    html?: string; // custom/edited HTML from the inline editor — overrides the template
    preheader?: string;
    from_email?: string;
    from_name?: string;
    reply_to?: string;
    scheduled_date?: string;
    ab_test?: { alternative_subject?: string; test_size?: number; winner_wait_duration?: number };
  } = {};
  try { body = (await req.json()) as typeof body; } catch { /* empty */ }

  const action = body.action === "launch" ? "launch" : "test";
  const source = body.template?.source === "cold" ? "cold" : "sunbiz";
  const rendered = body.template?.id ? renderTemplate(source, body.template.id) : null;
  const html = (body.html && body.html.trim()) ? body.html : rendered?.html;
  if (!html) return NextResponse.json({ ok: false, error: "template_or_html_required" }, { status: 400 });
  const subject = (body.subject || rendered?.subject || "").trim();
  if (!subject) return NextResponse.json({ ok: false, error: "subject_required" }, { status: 400 });
  if (!body.from_email) return NextResponse.json({ ok: false, error: "from_email_required" }, { status: 400 });

  // Optional A/B subject test — clamp to CC's allowed ranges (fail-closed on bad input).
  let abTest: { alternative_subject: string; test_size: number; winner_wait_duration: number } | undefined;
  if (action === "launch" && body.ab_test?.alternative_subject?.trim()) {
    const size = Math.max(5, Math.min(50, Number(body.ab_test.test_size) || 20));
    const waitOptions = [6, 12, 24, 48];
    const wait = waitOptions.includes(Number(body.ab_test.winner_wait_duration)) ? Number(body.ab_test.winner_wait_duration) : 24;
    abTest = { alternative_subject: body.ab_test.alternative_subject.trim(), test_size: size, winner_wait_duration: wait };
  }

  // Audience: SunBiz segment (import) or an existing CC list.
  let recipients; let ccListId;
  if (body.audience?.type === "cc_list" && body.audience.list_id) {
    ccListId = body.audience.list_id;
  } else if (body.audience?.stage) {
    const aud = await resolveSunbizAudience(session.tenantId, body.audience.stage);
    if (!aud.ok) return NextResponse.json({ ok: false, error: aud.error }, { status: 500 });
    if (action === "launch" && aud.recipients.length === 0) return NextResponse.json({ ok: false, error: "no_recipients" }, { status: 400 });
    recipients = aud.recipients;
  } else {
    return NextResponse.json({ ok: false, error: "audience_required" }, { status: 400 });
  }

  const result = await runBlast({
    tenantId: session.tenantId,
    userId: session.userId,
    recipients,
    ccListId,
    subject,
    html,
    preheader: body.preheader,
    fromEmail: body.from_email,
    fromName: body.from_name,
    replyTo: body.reply_to,
    scheduledDate: body.scheduled_date && body.scheduled_date !== "now" ? body.scheduled_date : "0",
    test: action === "test" ? [session.email || body.from_email] : undefined,
    abTest,
    listNameHint: body.audience?.stage || "list",
  });

  const status = result.ok ? 200 : result.status || 400;
  return NextResponse.json(result, { status });
}
