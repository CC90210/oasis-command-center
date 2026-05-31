/**
 * Agents & Modules status board — tenant-scoped status grid.
 *
 * Originally shipped as Phase 11 of the Jordan/Oasis 2026-05-23
 * restructure with a hardcoded SunBiz module list. CC flagged the
 * cross-tenant leak 2026-05-25: those SunBiz modules (Email Offer
 * Scanner, Shopping Out Sender, Lender Matching Agent, ...) were
 * rendering on the OASIS /automations view too. They have nothing
 * to do with OASIS operations.
 *
 * Fix: keyed the module list by tenant slug. The board returns null
 * when the viewing tenant has no modules registered — OASIS sees
 * nothing (correctly), Sun Biz sees its 9 funding-flow modules,
 * future tenants get their own lists by adding a MODULES_BY_TENANT
 * entry.
 *
 * Renders an HONEST status grid per tenant. Live vs Planned reflects
 * whether the supporting code actually exists and is wired into a
 * request path — not whether the operator has it switched on.
 */

import { Card } from "@/components/Card";
import {
  Mail,
  Globe2,
  Send,
  RefreshCw,
  FileText,
  Landmark,
  ArrowRight,
  BadgeDollarSign,
  Clock,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type ModuleStatus = "live" | "partial" | "planned";

type Module = {
  key: string;
  name: string;
  description: string;
  status: ModuleStatus;
  icon: LucideIcon;
  connected: string;
};

const SUNBIZ_MODULES: Module[] = [
  {
    key: "email_offer_scanner",
    name: "Email Offer Scanner",
    description:
      "Watches the inbound lender mailbox, extracts amount / term / buy-rate from offer emails, and creates Offer records.",
    status: "planned",
    icon: Mail,
    connected: "Phase 6.4 work — depends on a daemon that polls Gmail with the operator's credentials.",
  },
  {
    key: "browser_offer_extractor",
    name: "Browser Offer Extractor",
    description:
      "Opens lender portal links from emails (Velocity, etc.) and extracts the offer terms via stealth browser automation.",
    status: "planned",
    icon: Globe2,
    connected: "Phase 6.5 work — needs per-lender adapter modules + credential vault.",
  },
  {
    key: "shopping_out_sender",
    name: "Shopping Out Sender",
    description:
      "Multi-lender package delivery — match-fitness ranking, attachment validation, queueing, and bridge-side SMTP send via the universal send_gateway chokepoint.",
    // Phase 6.3-bis shipped 2026-05-25. Threads queued by the
    // dashboard route are now consumed by scripts/shop_out_sender.py
    // on the operator's bridge, which fires actual SMTP via
    // send_gateway and flips the thread to status='sent' (or 'error'
    // with last_error set). End-to-end wired.
    status: "live",
    icon: Send,
    connected:
      "lib/lenders/shop-out.ts + POST /api/applications/[id]/shop-out → application_lender_threads → scripts/shop_out_sender.py loop (bridge) → send_gateway.send → status='sent'. Migration 065 persists body_template + attachments per-thread so the operator's confirmed copy + docs survive across the dashboard → bridge boundary.",
  },
  {
    key: "renewal_calculator",
    name: "Renewal Calculator",
    description:
      "Funded-deal term tracker — computes % progress, surfaces past-due / upcoming windows.",
    status: "live",
    icon: RefreshCw,
    connected: "app/renewals/page.tsx + lib/queries.ts (getRenewalsSummary + getRenewalsRows).",
  },
  {
    key: "lender_matching_agent",
    name: "Lender Matching Agent",
    description:
      "Pure scoring function that ranks lenders against a deal profile using hard gates (revenue, TIB, FICO, funded amount) + soft penalties.",
    status: "live",
    icon: Landmark,
    connected: "lib/lenders/match-fitness.ts (powers the Shopping Out lender list).",
  },
  {
    key: "document_parser",
    name: "Application Document Parser",
    description:
      "Reads uploaded bank statements + application forms, extracts revenue / NSF / deposit consistency, populates CRM fields.",
    status: "planned",
    icon: FileText,
    connected: "Phase 7.x work — currently operators enter Bank tab fields manually.",
  },
  {
    key: "crm_stage_engine",
    name: "CRM Stage Engine",
    description:
      "Auto-advances leads through the funnel based on email opens, doc uploads, form completions, and inbound replies.",
    status: "live",
    icon: ArrowRight,
    connected: "lib/lead-stage-engine.ts + lib/lead-stage-dispatcher.ts.",
  },
  // Two new modules added 2026-05-25 per CC. Both honestly Planned —
  // no code wired yet. The board entries make the roadmap visible to
  // the operator so they don't expect either to be running.
  {
    key: "underwriting_agent",
    name: "Underwriting Agent",
    description:
      "Watches shopped-out deals as they progress toward funding. Captures lender rate, term, and projected commission ($ + points) so Commissions stays in sync with what's actually been sold.",
    status: "planned",
    icon: BadgeDollarSign,
    connected:
      "Phase 6.6 — depends on the Email Offer Scanner being Live so amount/term/buy-rate can be extracted from inbound lender emails, plus a commissions_projection field on application_lender_threads.",
  },
  {
    key: "renewal_reminder_agent",
    name: "Renewal Reminder Agent",
    description:
      "Daily 9am sweep of funded deals. Flags any deal at 40-50% through its term (configurable via manifest.settings.renewal_eligibility_threshold_pct, default 40) and pushes a Telegram alert so the team has time to re-shop.",
    status: "planned",
    icon: Clock,
    connected:
      "Phase 8.2 — needs a tenant_cron_jobs seed (daily 09:00 ET, action_type='agent_prompt') + Solara given a 'scan funded_deals where progress in [0.35, 0.50]' tool. Distinct from the Renewal Calculator entry above (which computes % on page-load).",
  },
];

const STATUS_TONE: Record<ModuleStatus, string> = {
  live: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  partial: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  planned: "bg-slate-500/15 text-slate-300 border-slate-500/30",
};

const STATUS_LABEL: Record<ModuleStatus, string> = {
  live: "Live",
  partial: "Partial",
  planned: "Planned",
};

/**
 * Module list per tenant slug. Empty entry = board returns null.
 *
 * TODO(architectural): move this map into the manifest schema so
 * adding a tenant is a manifest edit, not a code edit. Blocker: the
 * Module type carries `icon: ReactComponent` which is non-serializable.
 * The right shape is module_keys: string[] in the manifest + a
 * KEY_TO_ICON registry here. Lift when a third tenant ships.
 */
const MODULES_BY_TENANT: Record<string, Module[]> = {
  sun: SUNBIZ_MODULES,
};

export function AgentsModulesStatusBoard({
  tenantSlug,
}: {
  /** Signed-in user's tenant slug. When undefined / not in
   *  MODULES_BY_TENANT, the board returns null and the parent page
   *  renders without it. */
  tenantSlug?: string | null;
}) {
  const slug = (tenantSlug || "").toLowerCase();
  const modules = slug ? MODULES_BY_TENANT[slug] : undefined;
  if (!modules || modules.length === 0) {
    // Honest no-op for tenants without registered modules. OASIS and
    // any future tenant whose automations are 100% cron-driven get
    // this branch.
    return null;
  }

  return (
    <Card
      title="Agents & modules"
      subtitle="Honest status board for the backend modules powering this workspace. Live = wired and serving requests. Planned = on the roadmap, not running."
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {modules.map((m) => {
          const Icon = m.icon;
          return (
            <li
              key={m.key}
              className="rounded-lg border border-bg-border bg-bg-elev/40 p-3 flex items-start gap-3"
            >
              <div className="rounded-md bg-bg-deep border border-bg-border p-1.5 shrink-0">
                <Icon className="w-4 h-4 text-fg-muted" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[12.5px] font-semibold text-fg">{m.name}</span>
                  <StatusPill status={m.status} />
                </div>
                <div className="text-[11.5px] text-fg-muted leading-relaxed">
                  {m.description}
                </div>
                <div className="text-[10.5px] text-fg-dim mt-1.5 font-mono break-words leading-snug">
                  {m.connected}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function StatusPill({ status }: { status: ModuleStatus }): ReactNode {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[9.5px] font-mono uppercase tracking-wider border ${STATUS_TONE[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
