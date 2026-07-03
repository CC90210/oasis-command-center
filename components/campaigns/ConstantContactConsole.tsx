"use client";

/**
 * ConstantContactConsole — the connected Constant Contact experience: a sub-tabbed
 * console (Compose / Campaigns / Reports / Contacts & Lists / Templates) rendered by
 * ConstantContactBlast once an account is linked. Drawer state (selected campaign) is
 * client-local so the console is self-contained on both the /email-blast page and the
 * Campaigns channel tab.
 */

import { useState } from "react";
import { PenSquare, Megaphone, BarChart3, Users, LayoutTemplate, type LucideIcon } from "lucide-react";
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

  return (
    <div className="space-y-4">
      {/* Account line + reconnect */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-fg-dim">
        <div>
          Account: <span className="text-fg-muted font-medium">{account?.org || "Constant Contact"}</span>
          {account?.emails?.length ? (
            <span className="ml-2">
              · sender{account.emails.length > 1 ? "s" : ""}:{" "}
              {account.emails.map((e) => e.email).join(", ")}
            </span>
          ) : null}
        </div>
        <button type="button" onClick={onReconnect} className="underline hover:text-fg-muted">Reconnect</button>
      </div>

      {/* Section sub-tabs */}
      <div className="inline-flex flex-wrap rounded-md border border-bg-border overflow-hidden text-[12px]">
        {TABS.map((t, i) => {
          const Icon = t.icon;
          const active = section === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setSection(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${i > 0 ? "border-l border-bg-border" : ""} ${active ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}
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
