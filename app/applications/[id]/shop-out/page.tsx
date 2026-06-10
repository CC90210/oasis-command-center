/**
 * Shop-out panel — Adon spec section 4 (2026-06-10).
 *
 * Server component shells the page (resolves the application + the
 * derived CC list + the rendered preview for the first lender) and
 * hands the data off to a client island that owns the modal + the
 * actual POST to /shop-out/run.
 *
 * URL: /applications/[id]/shop-out
 *
 * What this page is NOT: it is not the lender SELECTION UI. The
 * existing /pipeline lender-picker stays the source of truth for which
 * funders go on the run. This panel is just the confirm-and-send
 * surface. Operator picks lenders in the picker, lands here with the
 * lender_ids passed via search params, reviews + confirms.
 */

import { notFound } from "next/navigation";
import { getServiceSupabase } from "@/lib/supabase-server";
import { resolveSessionContext } from "@/lib/api-auth";
import { isOperatorEmail } from "@/lib/operator-credentials";
import { getAgents, deriveSigner } from "@/lib/config/agents";
import {
  jordanSubject,
  jordanBody,
  validateSubmissionDeal,
  type SubmissionDeal,
  type SubmissionSigner,
} from "@/lib/lenders/templates/jordan-submission";
import { buildShopOutPlan } from "@/lib/lenders/shop-out";
import type { ApplicationProfile } from "@/lib/lenders/match-fitness";
import ShopOutPanelClient from "./panel-client";
import type { DerivedAgentEntry } from "@/components/shop-out/derived-cc-list";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PageProps = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ lender_ids?: string | string[] }>;
};

function parseLenderIds(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : raw.split(",");
  return arr
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s));
}

export default async function ShopOutPage({ params, searchParams }: PageProps) {
  const [{ id: applicationId }, sp] = await Promise.all([params, searchParams]);
  const lenderIds = parseLenderIds(sp.lender_ids);

  if (!UUID_RE.test(applicationId)) notFound();

  const sess = await resolveSessionContext();
  if (!sess.ok) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12 text-zinc-100">
        <h1 className="text-2xl font-semibold">Shop-out</h1>
        <p className="mt-4 text-zinc-300">Sign in to use the shop-out panel.</p>
      </main>
    );
  }

  const db = getServiceSupabase();

  // Tenant gate — same as /run.
  const tenantRow = await db
    .from("tenants")
    .select("slug")
    .eq("id", sess.tenantId)
    .maybeSingle();
  const tenantSlug = (tenantRow.data as { slug: string } | null)?.slug || "";
  const isOperator = isOperatorEmail(sess.email);
  if (tenantSlug !== "submissions" && !isOperator) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-12 text-zinc-100">
        <h1 className="text-2xl font-semibold">Shop-out</h1>
        <p className="mt-4 text-zinc-300">
          Shop-out is enabled for the SunBiz tenant only. Talk to CC if you need
          access on this tenant.
        </p>
      </main>
    );
  }

  // Resolve the application + extract SubmissionDeal fields.
  const appRow = await db
    .from("tenant_records")
    .select("id, data")
    .eq("tenant_id", sess.tenantId)
    .eq("entity_type", "application")
    .eq("id", applicationId)
    .maybeSingle();
  if (appRow.error || !appRow.data) notFound();
  const appData = ((appRow.data as { data: Record<string, unknown> }).data) || {};

  const deal: SubmissionDeal = {
    merchant_legal_name: String(appData.merchant_legal_name || appData.business_name || ""),
    industry: String(appData.industry || ""),
    time_in_business: String(appData.time_in_business || ""),
    monthly_revenue: typeof appData.monthly_revenue === "number" ? appData.monthly_revenue : NaN,
    requested_amount: typeof appData.requested_amount === "number" ? appData.requested_amount : NaN,
    position_count: typeof appData.position_count === "number" ? appData.position_count : NaN,
    positions_balance: typeof appData.positions_balance === "number" ? appData.positions_balance : NaN,
    positions_payment: typeof appData.positions_payment === "number" ? appData.positions_payment : NaN,
    positions_payment_frequency: String(appData.positions_payment_frequency || ""),
    bank_statements_months: typeof appData.bank_statements_months === "number" ? appData.bank_statements_months : NaN,
    bank_statements_trend: String(appData.bank_statements_trend || ""),
    narrative_summary: String(appData.narrative_summary || ""),
    open_to_best_offer: typeof appData.open_to_best_offer === "boolean" ? appData.open_to_best_offer : false,
    stip_labels: Array.isArray(appData.stip_labels)
      ? (appData.stip_labels as unknown[]).filter((s): s is string => typeof s === "string")
      : [],
  };
  const missing = validateSubmissionDeal(deal);

  // Derive CC list from application rep fields.
  const repFields: Array<unknown> = [
    appData.assigned_rep_email,
    appData.assigned_rep_id,
    appData.owner_id,
    appData.assignee_id,
    appData.rep,
    appData.agent,
    appData.assigned,
    appData.owner,
  ];
  const repEmails: string[] = [];
  for (const f of repFields) {
    if (typeof f === "string" && f.includes("@")) repEmails.push(f.toLowerCase().trim());
  }
  const idFields = repFields.filter(
    (f): f is string => typeof f === "string" && UUID_RE.test(f),
  );
  if (idFields.length > 0) {
    const profiles = await db
      .from("user_profiles")
      .select("auth_user_id, email")
      .in("auth_user_id", idFields);
    for (const p of (profiles.data || []) as Array<{ email: string | null }>) {
      if (p.email) repEmails.push(p.email.toLowerCase().trim());
    }
  }
  const roster = getAgents();
  const agentByEmail = new Map(
    roster.map((a) => [a.email.toLowerCase().trim(), a]),
  );
  const derivedAgents: DerivedAgentEntry[] = [];
  const derivedEmails = new Set<string>();
  for (const email of repEmails) {
    if (derivedEmails.has(email)) continue;
    const agent = agentByEmail.get(email);
    if (agent) {
      derivedAgents.push({ key: agent.key, name: agent.name, email: agent.email });
      derivedEmails.add(email);
    }
  }

  // Render the first-lender preview server-side so it's instant when the
  // page paints. Only do this when we actually have a lender + valid deal.
  let preview: {
    funderName: string;
    to: string | null;
    cc: string[];
    subject: string;
    body: string;
    matchNarrative?: string;
  } | null = null;
  if (lenderIds.length > 0 && missing.length === 0) {
    const application: ApplicationProfile = {
      id: applicationId,
      monthly_revenue: typeof appData.monthly_revenue === "number" ? appData.monthly_revenue : undefined,
      time_in_business_months: typeof appData.time_in_business_months === "number" ? appData.time_in_business_months : undefined,
      applicant_fico: typeof appData.applicant_fico === "number" ? appData.applicant_fico : undefined,
      requested_amount: typeof appData.requested_amount === "number" ? appData.requested_amount : undefined,
      desired_product: typeof appData.desired_product === "string" ? appData.desired_product : undefined,
    };
    const plan = await buildShopOutPlan({
      tenant_id: sess.tenantId,
      application,
      lender_ids: [lenderIds[0]],
      cc_emails: [],
      attachments: [],
    });
    if (plan.ok && plan.plan.length > 0) {
      const firstRow = plan.plan[0];
      const previewSigner: SubmissionSigner = deriveSigner(
        derivedAgents.map((a) => a.email),
      );
      preview = {
        funderName: firstRow.lender_name,
        to: firstRow.recipient_email,
        cc: firstRow.recipient_cc_emails,
        subject: jordanSubject(deal),
        body: jordanBody(deal, previewSigner, firstRow.lender_name),
        matchNarrative: firstRow.narrative,
      };
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10 text-zinc-100">
      <header>
        <div className="text-xs uppercase tracking-wide text-zinc-500">
          Shop-out
        </div>
        <h1 className="mt-1 text-2xl font-semibold">
          {deal.merchant_legal_name || "(unnamed application)"}
        </h1>
        <p className="mt-1 text-sm text-zinc-400">
          Sending {lenderIds.length} submission{lenderIds.length === 1 ? "" : "s"} via{" "}
          <span className="font-mono text-zinc-300">submissions@sunbizfunding.com</span>
        </p>
      </header>

      {missing.length > 0 && (
        <div className="mt-6 rounded-md border border-amber-700/50 bg-amber-950/30 p-4 text-sm text-amber-200">
          <div className="font-medium">Deal is missing required fields.</div>
          <div className="mt-1 text-amber-100/80">
            {missing.join(", ")}
          </div>
          <div className="mt-2 text-xs text-amber-200/70">
            Complete the application form before firing the shop-out — the
            run endpoint will halt with 400 otherwise.
          </div>
        </div>
      )}

      {lenderIds.length === 0 && (
        <div className="mt-6 rounded-md border border-zinc-800 bg-zinc-950/40 p-4 text-sm text-zinc-300">
          No lenders selected. Go back to the pipeline / lender picker to
          choose lenders for this shop-out.
        </div>
      )}

      <ShopOutPanelClient
        applicationId={applicationId}
        merchantName={deal.merchant_legal_name || "(unnamed)"}
        fundersCount={lenderIds.length}
        lenderIds={lenderIds}
        derivedAgents={derivedAgents}
        missingFields={missing}
        preview={preview}
        signedInUserName={sess.email || "operator"}
      />
    </main>
  );
}
