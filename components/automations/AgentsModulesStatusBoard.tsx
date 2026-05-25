/**
 * Agents & Modules status board — Phase 11 of the Jordan/Oasis
 * 2026-05-23 restructure.
 *
 * Renders an HONEST status grid of the backend automation modules
 * that power the SunBiz pipeline. Live vs Planned reflects whether
 * the supporting code actually exists and is wired into a request
 * path — not whether the operator has it switched on for their
 * tenant. Sits ABOVE the cron-jobs manager so operators see the
 * full automation surface (modules + custom crons) on one page.
 *
 * No fetching here — module presence is a build-time fact. The
 * cron-jobs manager below this component handles the per-tenant
 * dynamic schedule layer.
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

const MODULES: Module[] = [
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
      "Multi-lender package delivery — match-fitness ranking, attachment validation, queueing.",
    // Honest label (2026-05-24): the UI + API are wired, but physical
    // SMTP fires from the operator's bridge — not from this route.
    // Threads land at status='pending' and stay there until Phase 6.3-bis
    // (bridge /exec-tool shop_out_send_batch handler) ships.
    status: "partial",
    icon: Send,
    connected:
      "lib/lenders/shop-out.ts + POST /api/applications/[id]/shop-out → application_lender_threads (status='pending'). Physical SMTP fires from the operator's bridge (Phase 6.3-bis pending) — until then, run `python scripts/send_gateway.py send` or trigger via Solara chat.",
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

export function AgentsModulesStatusBoard() {
  return (
    <Card
      title="Agents & modules"
      subtitle="Honest status board for the backend modules powering this workspace. Live = wired and serving requests. Planned = on the roadmap, not running."
    >
      <ul className="grid gap-2 sm:grid-cols-2">
        {MODULES.map((m) => {
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
