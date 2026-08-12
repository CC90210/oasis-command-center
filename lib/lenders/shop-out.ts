/**
 * lenders/shop-out.ts — multi-lender email distributor.
 *
 * Phase 6.3 of the SunBiz CRM build (2026-05-15). Given (application, [lenders],
 * [cc_emails]), this helper:
 *   1. Builds a structured per-lender email with the bank statements
 *      attached (or referenced via the operator's chosen storage path)
 *   2. Sends each via send_gateway.send(channel="email", ...) so CASL +
 *      cooldown + daily-cap enforcement apply uniformly
 *   3. Inserts an application_lender_threads row per lender at status=sent
 *      so Phase 6.4's response classifier daemon can correlate replies
 *
 * Email send happens via the dashboard-side Python subprocess pattern
 * /api/sms/send uses today: dispatchSmsThroughClientAgent's email twin
 * lives in scripts/email_engine.py. We invoke that through the
 * dashboard's existing client-agent layer when one is configured, or
 * fall back to /api/forms-style direct send when running OASIS HQ.
 *
 * NOTE: actual fan-out happens server-side in /api/applications/[id]/shop-out.
 * This module is the planning + audit helper imported by that route.
 */

import { getServiceSupabase } from "@/lib/supabase-server";
import type { LenderProfile, ApplicationProfile, LenderWarning } from "./match-fitness";
import { scoreLenderMatch } from "./match-fitness";
import { buildLenderNarrative } from "./match-narrative";
import { findAgentByEmail } from "@/lib/config/agents";
import { updateRecord } from "@/lib/manifest/data";
import { DEFAULT_SHOP_OUT_BODY } from "./shop-out-email-templates";

// Stages at or past "shopping" — a (re-)shop-out must never downgrade these.
const SHOPPING_OR_LATER = new Set([
  "shopping", "approved", "requested_docs", "docs_out", "login",
  "funded", "follow_ups", "declined", "dead_file",
]);

/**
 * After a REAL shop-out (>=1 lender actually sent), auto-advance the application
 * to the "shopping" stage so the operator never drags it across the board by
 * hand (Ezra 2026-06-24). Routes through updateRecord, so it fires
 * BRAVO_RECORD_STATUS_CHANGED and the pipeline/board update live. Shared by BOTH
 * shop-out paths — the legacy /shop-out route and the Gmail-direct /shop-out/run
 * engine. Best-effort + self-contained: reads the current status, skips if it's
 * already at/past shopping, and never throws into the caller (sends already happened).
 */
export async function autoAdvanceToShopping(
  tenantId: string,
  applicationId: string,
): Promise<void> {
  try {
    const db = getServiceSupabase();
    const row = await db
      .from("tenant_records")
      .select("data")
      .eq("tenant_id", tenantId)
      .eq("entity_type", "application")
      .eq("id", applicationId)
      .maybeSingle();
    const data = (row.data as { data?: Record<string, unknown> } | null)?.data || {};
    const cur = typeof data.status === "string" ? data.status : "";
    if (SHOPPING_OR_LATER.has(cur)) return;
    await updateRecord({
      tenant_id: tenantId,
      entity: "application",
      id: applicationId,
      patch: { status: "shopping" },
    });
  } catch (err) {
    console.error("[shop-out] auto-advance to shopping stage failed:", err);
  }
}

export type ShopOutAttachment = {
  /** Display filename — e.g. "bank-statements-mar-may.pdf". */
  filename: string;
  /** Storage path for retrieval. Supabase Storage path or inline base64. */
  storage_path: string;
  mime_type: string;
  size_bytes: number;
};

export type ShopOutPlanInput = {
  tenant_id: string;
  application: ApplicationProfile;
  lender_ids: string[];
  cc_emails: string[];
  /** Bank statements + supporting docs. Each gets attached to every lender email. */
  attachments: ShopOutAttachment[];
  /** Optional operator override for the email body. {{lender.name}} substitution. */
  subject_template?: string;
  body_template?: string;
  /** Assigned rep's email — resolved from application.data.assigned_to in
   * the route. Under the SunBiz shared-inbox model the From: is always
   * tenant-shared, so the rep stays on the thread by being CC'd on every
   * lender email going out. Merged into the per-row cc list alongside
   * the operator's typed cc + the lender's stored submission_cc_emails. */
  assigned_rep_email?: string | null;
};

// Subject per Adon's MCA shop-out SOP §3 (2026-06-11): identical across
// re-sends to the same lender so the email client threads them. "deal
// name" = merchant/business name. Keep the parens — funders look for
// that exact prefix when filing.
const DEFAULT_SUBJECT = "New Deal ({{application.business_name}})";

// Minimal body per Adon SOP §3 — funders skim. Merge fields use the
// pre-formatted *_display tokens (built in buildShopOutPlan) so a missing
// value renders "Not provided" instead of a broken "$" / empty line, and
// currency renders "$42,000" not "42000". Closing line carries an explicit
// ask (the draft critic flagged the old "let me know what you can do" as
// having "no clear ask"). Operator can still edit per send.
/** Format a currency-ish value for the lender email. Returns "Not provided"
 *  for empty/zero/non-numeric so the body never shows a bare "$" or "$0". */
function moneyDisplay(v: unknown): string {
  const n =
    typeof v === "number"
      ? v
      : typeof v === "string"
        ? Number(v.replace(/[^0-9.]/g, ""))
        : NaN;
  if (!Number.isFinite(n) || n <= 0) return "Not provided";
  return "$" + Math.round(n).toLocaleString("en-US");
}

/** Render a plain field, falling back to "Not provided" for empty values. */
function plainDisplay(v: unknown): string {
  if (v === null || v === undefined || String(v).trim() === "") return "Not provided";
  return String(v);
}

/** Resolve the merchant/business name with a fallback chain so the subject
 *  is never "New Deal ()". Funders file on the "(name)" prefix, so an empty
 *  name is worse than a generic one. */
function resolveBusinessName(app: Record<string, unknown>): string {
  const candidates = [app.business_name, app.merchant_name, app.legal_name, app.company, app.name];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "Merchant Submission";
}

function renderSimple(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const parts = path.split(".");
    let cur: unknown = vars;
    for (const p of parts) {
      if (typeof cur !== "object" || cur === null) return "";
      cur = (cur as Record<string, unknown>)[p];
    }
    if (cur === null || cur === undefined) return "";
    return typeof cur === "string" ? cur : String(cur);
  });
}

export type ShopOutPlanRow = {
  lender_id: string;
  lender_name: string;
  match_score: number;
  /** Backward-compat — flattened high_risk warning details. */
  blockers: string[];
  /** 2026-05-25 — severity-tiered warnings the UI groups by tier. */
  warnings: LenderWarning[];
  /** 2026-05-25 — 1-3 sentence plain-English explanation of the rank. */
  narrative: string;
  rendered_subject: string;
  rendered_body: string;
  recipient_email: string | null;
  /** Per-lender CC list — operator's global cc_emails + the lender's
   *  stored submission_cc_emails (SOP-encoded routing). The shop-out
   *  route persists this per-row so the bridge-side sender hits every
   *  cc the SOP specifies without the operator having to retype them. */
  recipient_cc_emails: string[];
};

/**
 * Build the plan without sending. Useful for the operator confirmation
 * step ("here's what's about to go to 5 lenders — review before send").
 */
export async function buildShopOutPlan(input: ShopOutPlanInput): Promise<{
  ok: true;
  plan: ShopOutPlanRow[];
  missing_recipients: string[];
} | { ok: false; error: string }> {
  const db = getServiceSupabase();

  // Fetch each lender row from tenant_records.
  const lenderRows = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", input.tenant_id)
    .eq("entity_type", "lender")
    .in("id", input.lender_ids);
  if (lenderRows.error) {
    return { ok: false, error: lenderRows.error.message };
  }

  const subjectTemplate = input.subject_template || DEFAULT_SUBJECT;
  const bodyTemplate = input.body_template || DEFAULT_SHOP_OUT_BODY;
  const plan: ShopOutPlanRow[] = [];
  const missing_recipients: string[] = [];

  // Adon SOP §3 — body signs "{agent_first_name}". Resolve the assigned
  // rep's first name from agents.config.json so the body matches the
  // signature the bridge tool will render (resolveSignerForOperator).
  // Falls back to "SunBiz Submissions" wordmark first-token when there's
  // no match, mirroring the signature-fallback rule.
  const assignedAgent = findAgentByEmail(input.assigned_rep_email || null);
  const agentFirstName = assignedAgent
    ? assignedAgent.name.split(/\s+/)[0]
    : "SunBiz Submissions";

  for (const row of lenderRows.data || []) {
    const r = row as { id: string; data: Record<string, unknown> };
    const data = r.data || {};
    const lender: LenderProfile = {
      id: r.id,
      name: String(data.name || "(unnamed)"),
      product_types: data.product_types as LenderProfile["product_types"],
      min_monthly_revenue: typeof data.min_monthly_revenue === "number" ? data.min_monthly_revenue : undefined,
      max_funded_amount: typeof data.max_funded_amount === "number" ? data.max_funded_amount : undefined,
      min_time_in_business_months: typeof data.min_time_in_business_months === "number" ? data.min_time_in_business_months : undefined,
      fico_floor: typeof data.fico_floor === "number" ? data.fico_floor : undefined,
      sla_response_days: typeof data.sla_response_days === "number" ? data.sla_response_days : undefined,
      submission_cc_emails: Array.isArray(data.submission_cc_emails)
        ? (data.submission_cc_emails as unknown[])
            .filter((s): s is string => typeof s === "string" && s.includes("@"))
        : undefined,
      // SOP §1 restricted lists — populated from lender's tenant_records.data.
      restricted_states: Array.isArray(data.restricted_states)
        ? (data.restricted_states as unknown[])
            .filter((s): s is string => typeof s === "string" && s.trim().length === 2)
            .map((s) => s.toUpperCase())
        : undefined,
      // Defensive read: schema rename 2026-06-11 from industry_restrictions
      // → restricted_industries. If any legacy lender row still uses the
      // old key, read it too so the SOP §4 filter fires correctly during
      // transition. Adon's seed CLI writes only the new name.
      restricted_industries: (() => {
        const raw = Array.isArray(data.restricted_industries)
          ? (data.restricted_industries as unknown[])
          : Array.isArray(data.industry_restrictions)
            ? (data.industry_restrictions as unknown[])
            : null;
        if (!raw) return undefined;
        return raw
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .map((s) => s.trim().toLowerCase());
      })(),
    };

    // Adon SOP §3 — "source from the lender record (prefer an address
    // matching /submission|submit/i, else the primary contact)". The
    // lender row carries `contact` (primary) and optionally a list of
    // submission-routing addresses in `submission_emails`. Walk them and
    // pick the first match; fall back to `contact`.
    const submissionEmails = Array.isArray(data.submission_emails)
      ? (data.submission_emails as unknown[]).filter(
          (s): s is string => typeof s === "string" && s.includes("@"),
        )
      : [];
    const allCandidates = [
      ...submissionEmails,
      ...(typeof data.contact === "string" && data.contact.includes("@") ? [data.contact] : []),
    ];
    const recipient =
      allCandidates.find((e) => /submission|submit/i.test(e)) ||
      (typeof data.contact === "string" && data.contact.includes("@") ? data.contact : null);
    if (!recipient) missing_recipients.push(lender.name);

    const score = scoreLenderMatch(lender, input.application);
    // Display-safe application: business-name fallback + pre-formatted money/
    // plain fields so the default template never emits "New Deal ()" or a bare
    // "$". Spreads the raw application first so operator custom templates that
    // reference the original tokens (monthly_revenue, etc.) keep working.
    const rawApp = input.application as unknown as Record<string, unknown>;
    const displayApplication = {
      ...rawApp,
      business_name: resolveBusinessName(rawApp),
      monthly_revenue_display: moneyDisplay(rawApp.monthly_revenue),
      position_count_display: plainDisplay(rawApp.position_count),
      requested_amount_display: moneyDisplay(rawApp.requested_amount),
    };
    const vars = {
      lender,
      application: displayApplication,
      agent: { first_name: agentFirstName },
    };

    // Per-lender CC list = operator's global cc_emails ∪ lender's stored
    // submission_cc_emails ∪ the assigned rep's email (so the rep stays
    // on the thread under the shared-inbox From: model). De-duped +
    // lower-cased so the same address doesn't show up twice if operator
    // manually typed one the catalog already has.
    const cc_emails = Array.from(
      new Set(
        [
          ...input.cc_emails,
          ...(lender.submission_cc_emails ?? []),
          ...(input.assigned_rep_email ? [input.assigned_rep_email] : []),
        ]
          .map((e) => e.trim().toLowerCase())
          .filter((e) => e && e.includes("@")),
      ),
    );

    plan.push({
      lender_id: lender.id,
      lender_name: lender.name,
      match_score: score.score,
      blockers: score.blockers,
      warnings: score.warnings,
      narrative: buildLenderNarrative(score, lender, input.application),
      rendered_subject: renderSimple(subjectTemplate, vars),
      rendered_body: renderSimple(bodyTemplate, vars),
      recipient_email: recipient,
      recipient_cc_emails: cc_emails,
    });
  }

  return { ok: true, plan, missing_recipients };
}

/**
 * Insert the application_lender_threads rows for a shop-out batch.
 * Called by /api/applications/[id]/shop-out.
 *
 * NOTE on status semantics: rows land at 'pending' (NOT 'sent') because
 * the physical SMTP send is Phase 6.3-bis. A row only moves to 'sent'
 * once the bridge-side send_gateway invocation succeeds + stamps
 * gmail_thread_id. If `entries[i].error` is set (missing contact /
 * match blocker), the row lands at 'error' so operators see what went
 * wrong without polluting their pending queue.
 *
 * The status column's CHECK constraint covers: pending, sent,
 * responded, approved, declined, info_requested, no_response, error
 * (per migration 044).
 */
export async function recordShopOutThreads(input: {
  tenant_id: string;
  application_id: string;
  /** Operator's global cc list — used as the fallback when an entry
   *  doesn't carry its own per-lender cc list. */
  cc_emails: string[];
  entries: Array<{
    lender_id: string;
    subject: string;
    /** Per-lender rendered body (template substitutions already applied). */
    body?: string;
    sent: boolean;
    error?: string;
    /** Per-lender CC list — when present, persisted instead of the global
     *  `cc_emails` so the bridge-side sender hits the lender's stored
     *  routing (Maison's rummi@, TBF's joe.v@, etc.) without the operator
     *  retyping them every shop-out. */
    cc_emails?: string[];
  }>;
  /** Attachments the operator confirmed on this shop-out. Same shape and
   *  validation the POST route accepts (tenant-scoped storage paths). */
  attachments?: ShopOutAttachment[];
  /**
   * 2026-05-25 (migration 069) — assigned rep's phone snapshot.
   * Resolved from application.data.assigned_rep_phone at queue time so
   * reassignment AFTER queue doesn't silently change the outbound.
   * scripts/shop_out_sender.py substitutes {{owner_phone}} placeholders
   * in body templates with this value; falls back to
   * "[no owner phone configured]" when null.
   */
  owner_phone?: string | null;
}): Promise<
  | { ok: true; inserted: number; threads: Array<{ id: string; lender_id: string }> }
  | { ok: false; error: string }
> {
  if (input.entries.length === 0) return { ok: true, inserted: 0, threads: [] };
  const db = getServiceSupabase();
  // Persist body_template + attachments on each thread (migration 065,
  // 2026-05-25). Without these the bridge-side sender can't faithfully
  // reproduce what the operator approved — it'd re-render from defaults
  // and silently drop the operator's notes / chosen docs. Both columns
  // are nullable / default-empty, so legacy threads keep working.
  const attachmentsJson = (input.attachments ?? []) as unknown as Record<string, unknown>[];
  const rows = input.entries.map((e) => ({
    application_id: input.application_id,
    lender_id: e.lender_id,
    tenant_id: input.tenant_id,
    subject: e.subject.slice(0, 500),
    body_template: e.body ?? null,
    attachments: attachmentsJson,
    cc_emails: e.cc_emails ?? input.cc_emails,
    owner_phone: input.owner_phone ?? null,
    // Errors (missing contact, match blocker) -> 'error'. Otherwise
    // 'pending' until the bridge-side sender (scripts/shop_out_sender.py,
    // Phase 6.3-bis) flips it to 'sent' on real SMTP success. Never
    // 'sent' from this route — that would lie about what happened.
    status: e.error ? "error" : "pending",
    last_error: e.error || null,
    sent_at: null,
  }));
  const { data, error } = await db
    .from("application_lender_threads")
    .insert(rows)
    .select("id, lender_id");
  if (error) {
    return { ok: false, error: error.message };
  }
  const threads = (data || []).map((r) => ({
    id: String((r as { id: unknown }).id),
    lender_id: String((r as { lender_id: unknown }).lender_id),
  }));
  return { ok: true, inserted: threads.length, threads };
}
