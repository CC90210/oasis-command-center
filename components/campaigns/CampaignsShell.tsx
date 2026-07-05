"use client";

/**
 * CampaignsShell — the multi-channel Campaigns command center.
 *
 * Top-level channel sub-tabs separate every point of contact into its own
 * surface:
 *   - Text Torrent → native TT bulk engine (credits, list counts, blast estimate)
 *   - Twilio       → cold-outreach engine, channel-locked to sms_twilio
 *   - Gmail        → cold-outreach engine, channel-locked to email
 *
 * Each channel renders its own create + send + metrics. The Text Torrent tab
 * keeps its inner "Campaigns / List intelligence" toggle and the ?campaign
 * detail drawer (mounted at the page level).
 */

import { useState } from "react";
import { Megaphone, MessageSquare, Mail, Send, type LucideIcon } from "lucide-react";
import { CampaignsClient } from "./CampaignsClient";
import { ColdOutreachClient } from "@/components/cold-outreach/ColdOutreachClient";
import { ConstantContactBlast } from "./ConstantContactBlast";
import { SmartleadConsole } from "./SmartleadConsole";

type ChannelTab = "texttorrent" | "twilio" | "gmail" | "constantcontact" | "coldemail";

const TABS: { key: ChannelTab; label: string; icon: LucideIcon }[] = [
  { key: "texttorrent", label: "Text Torrent", icon: Megaphone },
  { key: "twilio", label: "Twilio", icon: MessageSquare },
  { key: "gmail", label: "Gmail", icon: Mail },
  { key: "constantcontact", label: "Constant Contact", icon: Mail },
  { key: "coldemail", label: "Cold Email", icon: Send },
];

export function CampaignsShell({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const [channel, setChannel] = useState<ChannelTab>("texttorrent");

  return (
    <div className="space-y-4">
      {/* Channel sub-tabs — one per point of contact. */}
      <div className="inline-flex rounded-md border border-bg-border overflow-hidden text-[12px]">
        {TABS.map((t, i) => {
          const Icon = t.icon;
          const active = channel === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setChannel(t.key)}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 ${i > 0 ? "border-l border-bg-border" : ""} ${active ? "bg-bg-elev text-fg" : "text-fg-muted hover:text-fg"}`}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {channel === "texttorrent" && <CampaignsClient tenantSlug={tenantSlug} tenantId={tenantId} />}

      {channel === "twilio" && (
        <ColdOutreachClient tenantSlug={tenantSlug} tenantId={tenantId} lockedChannel="sms_twilio" />
      )}

      {channel === "gmail" && (
        <div className="space-y-3">
          <div className="rounded-md border border-status-warm/40 bg-status-warm/5 px-3 py-2 text-[12px] text-status-warm">
            Gmail send is pending OAuth wiring (separate workstream). Campaigns you queue here are
            saved and will send once Gmail is connected.
          </div>
          <ColdOutreachClient tenantSlug={tenantSlug} tenantId={tenantId} lockedChannel="email" />
        </div>
      )}

      {channel === "constantcontact" && <ConstantContactBlast />}

      {channel === "coldemail" && <SmartleadConsole />}
    </div>
  );
}
