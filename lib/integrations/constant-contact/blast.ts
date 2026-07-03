/**
 * lib/integrations/constant-contact/blast.ts — the shared blast core used by BOTH
 * the Email Blast composer route and the Leads-pipeline bulk action, so there's one
 * code path with one set of safety rails: suppression-filter the audience, run the
 * blast-safety guard (lender names + dashes, fail-closed), honor the dry-run gate,
 * import the audience into a Constant Contact list, create + send the campaign, and
 * record it. Server-only.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getConstantContactClient } from "./store";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { isDryRun } from "@/lib/integrations/send-mode";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";
import { renderSunbizTemplate, SUNBIZ_EMAIL_TEMPLATES } from "@/lib/sunbiz-templates-library";
import { COLD_OUTREACH_TEMPLATES } from "@/lib/cold-outreach/templates.generated";

// CAN-SPAM footer (mandatory). SunBiz Funding's registered address.
const SUNBIZ_FOOTER: Record<string, string> = {
  address_line1: "1 East Broward Blvd, Suite 700",
  city: "Fort Lauderdale",
  state_code: "FL",
  postal_code: "33301",
  country_code: "US",
};

export type BlastRecipient = { email: string; first_name: string | null; business: string | null; lead_id?: string | null };

function pickEmail(d: Record<string, unknown>): string {
  return String((d.email as string) || (d.owner_email as string) || (d.contact_email as string) || "").trim().toLowerCase();
}
function toRecipient(id: string, d: Record<string, unknown>): BlastRecipient | null {
  const email = pickEmail(d);
  if (!email) return null;
  return {
    email,
    first_name: (d.contact_name as string) || (d.name as string) || (d.owner_full_name as string) || null,
    business: (d.business_name as string) || (d.company as string) || (d.business_legal_name as string) || null,
    lead_id: id,
  };
}

async function filterSuppressed(tenantId: string, rows: BlastRecipient[]): Promise<{ ok: true; recipients: BlastRecipient[] } | { ok: false; error: string }> {
  const seen = new Set<string>();
  const out: BlastRecipient[] = [];
  for (const r of rows) {
    if (seen.has(r.email)) continue;
    const supp = await checkEmailSuppressed(tenantId, r.email);
    if (supp.checkFailed) return { ok: false, error: "suppression_check_failed" };
    if (supp.suppressed) continue;
    seen.add(r.email);
    out.push(r);
  }
  return { ok: true, recipients: out };
}

/** SunBiz lead segment (by stage) → suppression-filtered recipients. */
export async function resolveSunbizAudience(tenantId: string, stage: string) {
  const db = getServiceSupabase();
  const r = await db.from("tenant_records").select("id, data").eq("tenant_id", tenantId).eq("entity_type", "lead").filter("data->>stage", "eq", stage).limit(500);
  if (r.error) return { ok: false as const, error: r.error.message };
  const rows = ((r.data || []) as { id: string; data: Record<string, unknown> }[]).map((x) => toRecipient(x.id, x.data || {})).filter((x): x is BlastRecipient => !!x);
  return filterSuppressed(tenantId, rows);
}

/** Explicit lead ids (bulk action) → suppression-filtered recipients. */
export async function resolveLeadsAudience(tenantId: string, leadIds: string[]) {
  const db = getServiceSupabase();
  const r = await db.from("tenant_records").select("id, data").eq("tenant_id", tenantId).eq("entity_type", "lead").in("id", leadIds.slice(0, 1000));
  if (r.error) return { ok: false as const, error: r.error.message };
  const rows = ((r.data || []) as { id: string; data: Record<string, unknown> }[]).map((x) => toRecipient(x.id, x.data || {})).filter((x): x is BlastRecipient => !!x);
  return filterSuppressed(tenantId, rows);
}

/**
 * Render a chosen template → { subject, html }. v1 uses GENERIC fallbacks (no
 * per-recipient Constant Contact merge tags) so a blast can never render a broken
 * "Hi ,"/literal-token. Per-contact personalization via CC merge tags is a later
 * refinement.
 */
export function renderTemplate(source: "sunbiz" | "cold", id: string): { subject: string; html: string } | null {
  if (source === "sunbiz") {
    const tpl = SUNBIZ_EMAIL_TEMPLATES.find((t) => t.id === id);
    if (!tpl) return null;
    const { subject, body } = renderSunbizTemplate(tpl, {});
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222;line-height:1.55">${body
      .split(/\n{2,}/)
      .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
      .join("")}</div>`;
    return { subject, html };
  }
  const tpl = COLD_OUTREACH_TEMPLATES.find((t) => t.key === id);
  if (!tpl) return null;
  const html = tpl.html
    .replace(/\{\{\s*first_name\s*\}\}/g, "there")
    .replace(/\{\{\s*business_name\s*\}\}/g, "your business")
    .replace(/\{\{\s*year\s*\}\}/g, String(new Date().getFullYear()))
    .replace(/\{\{[a-zA-Z0-9_.\- ]+\}\}/g, ""); // strip any remaining tokens (unsubscribe injected by CC)
  return { subject: tpl.subject, html };
}

/** First confirmed sender email on the connected CC account (for the bulk action, which has no sender picker). */
export async function getDefaultSender(tenantId: string): Promise<string | null> {
  const client = await getConstantContactClient(tenantId);
  if (!client) return null;
  const em = await client.getSenderEmails().catch(() => null);
  const list = (Array.isArray(em) ? em : ((em as { account_emails?: unknown[] } | null)?.account_emails || [])) as { email_address?: string; confirm_status?: string }[];
  const pick = list.find((e) => String(e.confirm_status || "").toUpperCase() === "CONFIRMED") || list[0];
  return pick?.email_address || null;
}

export type RunBlastInput = {
  tenantId: string;
  userId?: string | null;
  recipients?: BlastRecipient[]; // SunBiz audience (segment or explicit leads)
  ccListId?: string; // OR an existing CC contact list
  subject: string;
  html: string;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
  scheduledDate?: string; // '0' now, ISO later
  test?: string[]; // if set, test-send only (to the operator), never schedules
  listNameHint?: string;
};

export type RunBlastResult =
  | { ok: true; dry_run?: boolean; tested?: boolean; campaign_id?: string; would_send?: unknown; recipients?: number }
  | { ok: false; error: string; message?: string; lender_hits?: string[]; status?: number };

export async function runBlast(input: RunBlastInput): Promise<RunBlastResult> {
  // 1. Blast-safety guard (fail-closed) on subject + html.
  const safe = await sanitizeBlastMessage(input.tenantId, `${input.subject}\n${input.html}`);
  if (!safe.ok) return { ok: false, error: safe.reason, message: safe.message, lender_hits: safe.lenderHits, status: 400 };

  const client = await getConstantContactClient(input.tenantId);
  if (!client) return { ok: false, error: "not_connected", status: 400 };

  const count = input.ccListId ? undefined : input.recipients?.length || 0;

  // 2. Dry-run gate — a LAUNCH does nothing in dry mode; a TEST send (operator-only) is allowed.
  if (!input.test?.length && isDryRun("constant_contact")) {
    return { ok: true, dry_run: true, recipients: count, would_send: { recipients: count ?? "cc_list", subject: input.subject, list: input.ccListId || input.listNameHint } };
  }
  if (!input.ccListId && !input.recipients?.length) return { ok: false, error: "no_recipients", status: 400 };

  // 3. Resolve the CC contact list (import the SunBiz audience, or use the chosen list).
  let listId = input.ccListId;
  if (!listId && input.recipients) {
    const listName = `SunBiz ${input.listNameHint || "segment"} ${new Date().toISOString().slice(0, 16)}`;
    const created = (await client.createList(listName).catch(() => null)) as { list_id?: string } | null;
    listId = created?.list_id;
    if (!listId) return { ok: false, error: "list_create_failed", status: 502 };
    const importData = input.recipients.map((r) => ({ email_address: r.email, first_name: r.first_name || undefined, company_name: r.business || undefined }));
    try {
      const imp = (await client.importContacts(importData, [listId])) as { activity_id?: string };
      if (imp.activity_id) await client.waitForActivity(imp.activity_id, { tries: 25, delayMs: 2000 });
    } catch (e) {
      return { ok: false, error: "import_failed", message: (e as Error).message.slice(0, 200), status: 502 };
    }
  }

  // 4. Create + (test|schedule) the campaign.
  const name = `SunBiz Blast ${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let result: { campaign_id: string; campaign_activity_id: string; scheduled?: boolean; tested?: boolean };
  try {
    result = (await client.createAndSendBlast({
      name,
      from_email: input.fromEmail,
      from_name: input.fromName || "SunBiz Funding",
      reply_to_email: input.replyTo || input.fromEmail,
      subject: input.subject,
      html_content: input.html,
      contact_list_ids: [listId as string],
      physical_address_in_footer: SUNBIZ_FOOTER,
      scheduledDate: input.scheduledDate || "0",
      testTo: input.test,
      guard: async (f) => {
        const g = await sanitizeBlastMessage(input.tenantId, `${f.subject}\n${f.html_content}`);
        if (!g.ok) throw new Error(`blast_safety_${g.reason}`);
      },
    })) as { campaign_id: string; campaign_activity_id: string; scheduled?: boolean; tested?: boolean };
  } catch (e) {
    return { ok: false, error: "cc_send_failed", message: (e as Error).message.slice(0, 200), status: 502 };
  }

  if (result.tested) return { ok: true, tested: true, campaign_id: result.campaign_id };

  // 5. Record the launch.
  const db = getServiceSupabase();
  await db
    .from("campaign_runs")
    .upsert(
      {
        tenant_id: input.tenantId,
        tt_campaign_id: String(result.campaign_id),
        provider_activity_id: String(result.campaign_activity_id),
        channel: "constant_contact",
        campaign_name: name,
        list_id: listId,
        message: input.subject,
        launched_by: input.userId ?? null,
        dry_run: false,
      },
      { onConflict: "tenant_id,tt_campaign_id" },
    )
    .then(() => {}, () => {});
  if (input.recipients?.length) {
    const rows = input.recipients.slice(0, 2000).map((r) => ({
      tenant_id: input.tenantId,
      tt_campaign_id: String(result.campaign_id),
      send_to: r.email,
      send_to_last10: r.email,
      send_from: input.fromEmail,
      send_status: "queued",
      received: false,
      lead_id: r.lead_id || null,
    }));
    await db.from("campaign_recipients").upsert(rows, { onConflict: "tt_campaign_id,send_to_last10" }).then(() => {}, () => {});
  }
  return { ok: true, campaign_id: result.campaign_id, recipients: count };
}

// ── Resend to non-openers ──────────────────────────────────────────────────────
export type RunResendInput = {
  tenantId: string;
  userId?: string | null;
  activityId: string;
  resendSubject: string;
  delayDays?: number; // 1-10; mutually exclusive with delayMinutes
  delayMinutes?: number; // 720-14400
};

/**
 * Resend a sent campaign to everyone who didn't open. The new subject is
 * merchant-facing, so it runs the SAME blast-safety + dry-run rails as a launch
 * (one-send-gate — no unguarded sibling path).
 */
export async function runResend(input: RunResendInput): Promise<RunBlastResult> {
  const safe = await sanitizeBlastMessage(input.tenantId, input.resendSubject);
  if (!safe.ok) return { ok: false, error: safe.reason, message: safe.message, lender_hits: safe.lenderHits, status: 400 };

  const client = await getConstantContactClient(input.tenantId);
  if (!client) return { ok: false, error: "not_connected", status: 400 };

  if (isDryRun("constant_contact")) {
    return { ok: true, dry_run: true, would_send: { resend_to: "non_openers", subject: input.resendSubject } };
  }

  const body: Record<string, unknown> = { resend_subject: input.resendSubject };
  if (input.delayMinutes != null) body.delay_minutes = input.delayMinutes;
  else body.delay_days = input.delayDays ?? 3;
  try {
    const res = (await client.createNonOpenerResend(input.activityId, body)) as { campaign_activity_id?: string };
    return { ok: true, campaign_id: res?.campaign_activity_id };
  } catch (e) {
    return { ok: false, error: "cc_resend_failed", message: (e as Error).message.slice(0, 200), status: 502 };
  }
}

// ── A/B subject test (applied to a DRAFT activity before scheduling) ────────────
export type RunAbTestInput = {
  tenantId: string;
  activityId: string;
  primarySubject: string;
  alternativeSubject: string;
  testSize: number; // 5-50 (%)
  winnerWaitHours: number; // 6 | 12 | 24 | 48
};

/** Configure an A/B subject test on a draft campaign. Both subjects are guarded. */
export async function runAbTest(input: RunAbTestInput): Promise<RunBlastResult> {
  const safe = await sanitizeBlastMessage(input.tenantId, `${input.primarySubject}\n${input.alternativeSubject}`);
  if (!safe.ok) return { ok: false, error: safe.reason, message: safe.message, lender_hits: safe.lenderHits, status: 400 };

  const client = await getConstantContactClient(input.tenantId);
  if (!client) return { ok: false, error: "not_connected", status: 400 };

  if (isDryRun("constant_contact")) {
    return { ok: true, dry_run: true, would_send: { abtest: { alternative_subject: input.alternativeSubject, test_size: input.testSize, winner_wait_duration: input.winnerWaitHours } } };
  }

  try {
    await client.createAbTest(input.activityId, {
      alternative_subject: input.alternativeSubject,
      test_size: input.testSize,
      winner_wait_duration: input.winnerWaitHours,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "cc_abtest_failed", message: (e as Error).message.slice(0, 200), status: 502 };
  }
}
