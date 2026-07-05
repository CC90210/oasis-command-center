"use client";

/**
 * ConstantContactConsole — the connected Constant Contact experience: a sub-tabbed
 * console (Compose / Campaigns / Reports / Contacts & Lists / Templates) rendered by
 * ConstantContactBlast once an account is linked. Drawer state (selected campaign) is
 * client-local so the console is self-contained on both the /email-blast page and the
 * Campaigns channel tab.
 */

import { useState } from "react";
import { PenSquare, Megaphone, BarChart3, Users, LayoutTemplate, Mail, CheckCircle2, AlertCircle, type LucideIcon } from "lucide-react";
import { ConstantContactComposer } from "./ConstantContactComposer";
import { CCCampaignsList } from "./cc/CCCampaignsList";
import { CCCampaignDrawer } from "./cc/CCCampaignDrawer";
import { CCReports } from "./cc/CCReports";
import { CCContacts } from "./cc/CCContacts";
import { CCTemplates } from "./cc/CCTemplates";

export type CCAccount = { org: string | null; emails: { email: string; status: string }[] } | null;
export type CampaignRef = { campaign_id: string; name: string; status: string };

type SectionKey = "compose" | "campaigns" | "reports" | "contacts" | "templates";
const TABS: { key: SectionKey; label: string; icon: LucideIcon }[] = [
  { key: "compose", label: "Compose", icon: PenSquare },
  { key: "campaigns", label: "Campaigns", icon: Megaphone },
  { key: "reports", label: "Reports", icon: BarChart3 },
  { key: "contacts", label: "Contacts & Lists", icon: Users },
  { key: "templates", label: "Templates", icon: LayoutTemplate },
];

export function ConstantContactConsole({ account, onReconnect }: { account: CCAccount; onReconnect: () => void }) {
  const [section, setSection] = useState<SectionKey>("campaigns");
  const [selected, setSelected] = useState<CampaignRef | null>(null);
  // Bump to force a campaigns-list refetch after a drawer action (rename/delete/cancel).
  const [refreshKey, setRefreshKey] = useState(0);

  const noConfirmedSender = !!account?.emails?.length && !account.emails.some((e) => e.status === "CONFIRMED");

  return (
    <div className="space-y-4">
      {/* Connected-as identity — the real linked account + its confirmed senders. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-bg-border bg-bg-panel px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent"><Mail className="h-4 w-4" /></span>
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-wide text-fg-dim">Connected as</div>
            <div className="truncate text-[13px] font-semibold text-fg">{account?.org || "Constant Contact"}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-[11px]">
          {account?.emails?.length ? (
            account.emails.slice(0, 3).map((e) => (
              <span key={e.email} className="inline-flex items-center gap-1 rounded-md border border-bg-border bg-bg-elev/40 px-2 py-1 text-fg-muted">
                {e.status === "CONFIRMED" ? <CheckCircle2 className="h-3 w-3 text-status-engaged" /> : <AlertCircle className="h-3 w-3 text-status-warm" />}
                {e.email}
              </span>
            ))
          ) : (
            <span className="inline-flex items-center gap-1 text-status-warm"><AlertCircle className="h-3 w-3" /> No sender email on this account</span>
          )}
          <button type="button" onClick={onReconnect} className="text-fg-dim underline hover:text-fg-muted">Reconnect</button>
        </div>
      </div>

      {noConfirmedSender && (
        <div className="rounded-md border border-status-warm/40 bg-status-warm/5 px-3 py-2 text-[11px] text-status-warm">
          No <span className="font-semibold">confirmed</span> sender on this account yet — Constant Contact rejects sends from unconfirmed addresses. Confirm one in Constant Contact first.
        </div>
      )}

      {/* Section pill tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = section === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSection(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[12px] transition-colors ${active ? "border-accent/40 bg-accent/10 text-accent" : "border-bg-border text-fg-muted hover:bg-bg-elev/40 hover:text-fg"}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {section === "compose" && <ConstantContactComposer />}
      {section === "campaigns" && <CCCampaignsList key={refreshKey} onSelect={setSelected} />}
      {section === "reports" && <CCReports />}
      {section === "contacts" && <CCContacts />}
      {section === "templates" && <CCTemplates />}

      {selected && (
        <CCCampaignDrawer
          campaign={selected}
          onClose={() => setSelected(null)}
          onChanged={() => {
            setRefreshKey((k) => k + 1);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}
