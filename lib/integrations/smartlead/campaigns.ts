/**
 * lib/integrations/smartlead/campaigns.ts — cold-email orchestration core. Mirrors the
 * Constant Contact blast core's safety rails: suppression-filter the audience, run the
 * blast-safety guard (lender names + dashes, fail-closed), honor the dry-run gate, then
 * drive Smartlead (create campaign → sequence → attach warmed mailboxes → schedule + caps
 * → push leads). Server-only.
 *
 * NOTE: Smartlead request-body shapes below are best-effort from the documented endpoints
 * and are VERIFIED LIVE on first real run (marked SMARTLEAD_SHAPE). Everything is dry-run
 * gated + inert without SMARTLEAD_API_KEY, so nothing sends until that pass is done.
 */
import "server-only";
import { getServiceSupabase } from "@/lib/supabase-server";
import { getSmartleadClient, SmartleadClient } from "./client";
import { sanitizeBlastMessage } from "@/lib/integrations/blast-safety";
import { isDryRun } from "@/lib/integrations/send-mode";
import { checkEmailSuppressed } from "@/lib/lead-interactions-queries";

export type ColdRecipient = { email: string; first_name?: string | null; company?: string | null };

const stripDashes = (s: string | undefined | null) => String(s || "").replace(/\s*[—–]\s*/g, ", ");

/** Suppression-filter (fail closed) + dedupe an audience before it can be pushed to Smartlead. */
async function filterSuppressed(tenantId: string, rows: ColdRecipient[]): Promise<{ ok: true; recipients: ColdRecipient[] } | { ok: false; error: string }> {
  const seen = new Set<string>();
  const out: ColdRecipient[] = [];
  for (const r of rows) {
    const email = String(r.email || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    const supp = await checkEmailSuppressed(tenantId, email);
    if (supp.checkFailed) return { ok: false, error: "suppression_check_failed" };
    if (supp.suppressed) continue;
    seen.add(email);
    out.push({ email, first_name: r.first_name || null, company: r.company || null });
  }
  return { ok: true, recipients: out };
}

/** Mailbox roster + warmup-health roll-up for the dashboard. */
export async function smartleadHealth(): Promise<
  | { ok: true; configured: boolean; mailboxes: number; warming: number; accounts: { id: string | number | null; email: string; warmup: string; reputation: number | null }[] }
  | { ok: false; error: string; message?: string }
> {
  const client = getSmartleadClient();
  if (!client) return { ok: true, configured: false, mailboxes: 0, warming: 0, accounts: [] };
  try {
    const raw = await client.listEmailAccounts();
    const accounts = (Array.isArray(raw) ? raw : ((raw as { data?: unknown[] } | null)?.data || [])) as {
      id?: number | string; from_email?: string; email?: string; warmup_details?: { status?: string; warmup_reputation?: number | string };
    }[];
    const norm = accounts.map((a) => ({
      id: a.id ?? null,
      email: a.from_email || a.email || "",
      warmup: a.warmup_details?.status || "unknown",
      reputation: a.warmup_details?.warmup_reputation != null ? Number(a.warmup_details.warmup_reputation) : null,
    }));
    return { ok: true, configured: true, mailboxes: norm.length, warming: norm.filter((a) => a.warmup.toUpperCase().includes("ACTIVE")).length, accounts: norm };
  } catch (e) {
    return { ok: false, error: "smartlead_call_failed", message: (e as Error).message.slice(0, 200) };
  }
}

const DEFAULT_SCHEDULE = {
  // Mon-Thu, recipient-morning, low per-mailbox cap — the safe cold ramp.
  timezone: "America/New_York",
  days_of_the_week: [1, 2, 3, 4],
  start_hour: "08:00",
  end_hour: "11:00",
  min_time_btw_emails: 5, // minutes
};

export type RunColdCampaignInput = {
  tenantId: string;
  userId?: string | null;
  campaignName: string;
  recipients: ColdRecipient[];
  subject: string;
  body: string; // plain-text first touch (no links in touch 1 per doctrine)
  dailyCap?: number; // per-mailbox/day; default 20 (safe cold cap)
  mailboxIds?: (string | number)[]; // default: all warmed mailboxes
  timezone?: string;
};

export type RunColdCampaignResult =
  | { ok: true; dry_run?: boolean; campaign_id?: string | number; recipients?: number; would_send?: unknown }
  | { ok: false; error: string; message?: string; lender_hits?: string[]; status?: number };

/** Create + arm a Smartlead cold campaign. Suppression + blast-safety + dry-run rails, same as email blasts. */
export async function runColdCampaign(input: RunColdCampaignInput): Promise<RunColdCampaignResult> {
  const subject = stripDashes(input.subject);
  const body = stripDashes(input.body);

  // 1. Blast-safety guard (fail-closed) — no lender names, no dashes, in subject or body.
  const safe = await sanitizeBlastMessage(input.tenantId, `${subject}\n${body}`);
  if (!safe.ok) return { ok: false, error: safe.reason, message: safe.message, lender_hits: safe.lenderHits, status: 400 };

  const client = getSmartleadClient();
  if (!client) return { ok: false, error: "not_configured", status: 400 };

  // 2. Suppression-filter the audience (fail closed).
  const filt = await filterSuppressed(input.tenantId, input.recipients);
  if (!filt.ok) return { ok: false, error: filt.error, status: 500 };
  const recipients = filt.recipients;
  const count = recipients.length;

  // 3. Dry-run gate — nothing touches Smartlead in dry mode.
  if (isDryRun("smartlead")) {
    return { ok: true, dry_run: true, recipients: count, would_send: { recipients: count, subject, daily_cap: input.dailyCap ?? 20 } };
  }
  if (!count) return { ok: false, error: "no_recipients", status: 400 };

  try {
    // Resolve mailboxes (default: all warmed).
    let mailboxIds = input.mailboxIds;
    if (!mailboxIds?.length) {
      const health = await smartleadHealth();
      mailboxIds = health.ok && health.configured ? health.accounts.filter((a) => a.warmup.toUpperCase().includes("ACTIVE") && a.id != null).map((a) => a.id as string | number) : [];
    }
    if (!mailboxIds.length) return { ok: false, error: "no_warmed_mailboxes", status: 400 };

    // SMARTLEAD_SHAPE: create → sequence → attach mailboxes → schedule + cap → push leads.
    const created = (await client.createCampaign({ name: input.campaignName })) as { id?: string | number; campaign_id?: string | number };
    const campaignId = created.id ?? created.campaign_id;
    if (campaignId == null) return { ok: false, error: "campaign_create_failed", status: 502 };

    await client.saveSequence(campaignId, [{ seq_number: 1, seq_delay_details: { delay_in_days: 0 }, subject, email_body: body }]);
    await client.linkEmailAccounts(campaignId, mailboxIds);
    await client.setCampaignSchedule(campaignId, { ...DEFAULT_SCHEDULE, timezone: input.timezone || DEFAULT_SCHEDULE.timezone, max_new_leads_per_day: input.dailyCap ?? 20 });
    for (let i = 0; i < recipients.length; i += 400) {
      const batch = recipients.slice(i, i + 400).map((r) => ({ email: r.email, first_name: r.first_name || undefined, company_name: r.company || undefined }));
      await client.addLeads(campaignId, batch);
    }

    // Record the launch (channel = smartlead).
    const db = getServiceSupabase();
    await db
      .from("campaign_runs")
      .upsert(
        { tenant_id: input.tenantId, tt_campaign_id: String(campaignId), channel: "smartlead", campaign_name: input.campaignName, message: subject, launched_by: input.userId ?? null, dry_run: false },
        { onConflict: "tenant_id,tt_campaign_id" },
      )
      .then(() => {}, () => {});

    return { ok: true, campaign_id: campaignId, recipients: count };
  } catch (e) {
    return { ok: false, error: "smartlead_launch_failed", message: (e as Error).message.slice(0, 200), status: 502 };
  }
}

/** Register our webhook so Smartlead events feed the suppression list. */
export async function registerSmartleadWebhook(client: SmartleadClient, url: string): Promise<{ ok: boolean; message?: string }> {
  try {
    // SMARTLEAD_SHAPE: subscribe to the suppression-relevant events.
    await client.createWebhook({ name: "SunBiz suppression sync", webhook_url: url, event_types: ["EMAIL_BOUNCE", "LEAD_UNSUBSCRIBED", "EMAIL_REPLY"] });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e as Error).message.slice(0, 200) };
  }
}
