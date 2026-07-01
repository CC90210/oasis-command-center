"use client";

/**
 * ColdOutreachClient — Cold-list blast composer + campaign tracker.
 *
 * Surface: SunBiz tenant "Cold Outreach" tab (one of three tabs added in the
 * 2026-05-25 product meeting).
 *
 * Backend tables (migration 069):
 *   - cold_lead_lists        — list catalog: id, tenant_id, name, source,
 *                              row_count, promoted_count, created_at, archived_at
 *   - cold_leads             — individual contacts in a list:
 *                              id, tenant_id, list_id, business_name,
 *                              contact_name, phone, email, raw, stage,
 *                              attempt_count
 *   - cold_outreach_campaigns — blast jobs: id, tenant_id, name, channel,
 *                              message_body, subject, cold_list_id,
 *                              recipient_filter, status, scheduled_for,
 *                              started_at, completed_at, total_recipients,
 *                              sent_count, failed_count, daily_cap
 *   - cold_outreach_recipients — per-contact delivery state:
 *                              id, tenant_id, campaign_id, cold_lead_id,
 *                              contact_address, status, sent_at,
 *                              delivery_status_at, last_error
 *
 * Phase 6 daemon (not yet built): scripts/cold_outreach_runner.py — drains
 * cold_outreach_recipients rows at status='pending' via send_gateway.
 * Document here so API routes can be designed against it without waiting for
 * the daemon.
 *
 * Preview-mode contract: when tenantId === null, the same 3-step scaffold
 * renders with empty pickers and no network fetches — identical to
 * ShoppingOutClient lines 144-152.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Card } from "@/components/Card";
import {
  MessageSquare,
  Megaphone,
  Mail,
  Plus,
  X,
  Send,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCcw,
  AlertTriangle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ColdList = {
  id: string;
  name: string;
  source: string | null;
  row_count: number;
  promoted_count: number;
  created_at: string;
};

type ColdLead = {
  id: string;
  business_name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  stage: string;
  attempt_count: number;
};

type Campaign = {
  id: string;
  name: string;
  channel: "sms_twilio" | "sms_texttorrent" | "email";
  message_body: string;
  subject: string | null;
  cold_list_id: string;
  recipient_filter: RecipientFilter | null;
  status: "draft" | "queued" | "sending" | "complete" | "cancelled" | "error";
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  total_recipients: number;
  sent_count: number;
  failed_count: number;
  daily_cap: number;
  created_at: string;
};

type RecipientFilter = {
  stage?: string;
  max_attempts?: number;
};

type Recipient = {
  id: string;
  cold_lead_id: string;
  contact_address: string;
  status: string;
  sent_at: string | null;
  delivery_status_at: string | null;
  last_error: string | null;
};

type Channel = "sms_twilio" | "sms_texttorrent" | "email";

// ---------------------------------------------------------------------------
// Status colour map — mirrors STATUS_TONE shape from ShoppingOutClient.tsx
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<string, string> = {
  draft: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  queued: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  sending: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  complete: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  cancelled: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

const RECIPIENT_STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  sent: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  delivered: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  failed: "bg-rose-500/15 text-rose-300 border-rose-500/30",
  bounced: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

const SMS_CHAR_LIMIT = 160;

const CHANNEL_LABEL: Record<Channel, string> = {
  sms_twilio: "SMS (Twilio)",
  sms_texttorrent: "SMS (TextTorrent)",
  email: "Email",
};

function renderPreviewMessage(body: string, lead: ColdLead): string {
  return body
    .replace(/\{\{first_name\}\}/g, lead.contact_name?.split(" ")[0] ?? "there")
    .replace(/\{\{business_name\}\}/g, lead.business_name)
    .replace(/\{\{phone\}\}/g, lead.phone ?? "")
    .replace(/\{\{email\}\}/g, lead.email ?? "");
}

// ---------------------------------------------------------------------------
// Sub-component: ChannelPicker
// ---------------------------------------------------------------------------

function ChannelPicker({
  value,
  onChange,
}: {
  value: Channel;
  onChange: (c: Channel) => void;
}) {
  const options: { id: Channel; label: string; sub: string; Icon: React.FC<{ className?: string }> }[] = [
    { id: "sms_twilio", label: "SMS via Twilio", sub: "Twilio carrier routing", Icon: MessageSquare },
    { id: "sms_texttorrent", label: "SMS via TextTorrent", sub: "High-volume blast tier", Icon: Megaphone },
    { id: "email", label: "Email blast", sub: "CASL-footer auto-appended", Icon: Mail },
  ];
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      {options.map(({ id, label, sub, Icon }) => {
        const active = value === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={`flex items-start gap-2 rounded-md border px-3 py-2.5 text-left transition-colors ${
              active
                ? "border-accent/50 bg-accent/10 text-accent"
                : "border-bg-border bg-bg-deep text-fg-muted hover:border-bg-border hover:bg-bg-elev/60 hover:text-fg"
            }`}
          >
            <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${active ? "text-accent" : ""}`} />
            <div>
              <div className="text-[12.5px] font-semibold leading-snug">{label}</div>
              <div className={`text-[10.5px] mt-0.5 ${active ? "text-accent/70" : "text-fg-muted"}`}>{sub}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: RecipientFilterChips
// ---------------------------------------------------------------------------

function RecipientFilterChips({
  filter,
  totalInList,
  filteredCount,
  onChange,
}: {
  filter: RecipientFilter;
  totalInList: number;
  filteredCount: number | null;
  onChange: (f: RecipientFilter) => void;
}) {
  const hasStage = typeof filter.stage === "string" && filter.stage.length > 0;
  const hasMaxAttempts = typeof filter.max_attempts === "number";

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Base chip always visible */}
      <button
        type="button"
        className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border font-medium ${
          !hasStage && !hasMaxAttempts
            ? "border-accent/40 bg-accent/10 text-accent"
            : "border-bg-border bg-bg-elev text-fg-dim hover:border-accent/30 hover:text-fg"
        }`}
        onClick={() => onChange({})}
      >
        All in list ({totalInList})
      </button>

      {/* Stage chip */}
      {hasStage ? (
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-accent/40 bg-accent/10 text-accent font-medium">
          Stage: {filter.stage}
          <button
            type="button"
            onClick={() => onChange({ ...filter, stage: undefined })}
            className="ml-0.5 hover:text-fg"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onChange({ ...filter, stage: "imported" })}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-bg-border bg-bg-elev text-fg-dim hover:border-accent/30 hover:text-fg"
        >
          + Stage: imported
        </button>
      )}

      {/* Max attempts chip */}
      {hasMaxAttempts ? (
        <span className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-accent/40 bg-accent/10 text-accent font-medium">
          Max attempts: {filter.max_attempts}
          <button
            type="button"
            onClick={() => onChange({ ...filter, max_attempts: undefined })}
            className="ml-0.5 hover:text-fg"
          >
            <X className="w-2.5 h-2.5" />
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => onChange({ ...filter, max_attempts: 1 })}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border border-bg-border bg-bg-elev text-fg-dim hover:border-accent/30 hover:text-fg"
        >
          + Max attempts: 1
        </button>
      )}

      {filteredCount !== null && (hasStage || hasMaxAttempts) && (
        <span className="text-[11px] text-fg-dim">
          → {filteredCount} recipient{filteredCount === 1 ? "" : "s"} match
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-component: CampaignRow
// ---------------------------------------------------------------------------

function CampaignRow({
  campaign,
  tenantSlug,
}: {
  campaign: Campaign;
  tenantSlug: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [recipientTotal, setRecipientTotal] = useState(0);
  const [recipientOffset, setRecipientOffset] = useState(0);
  const [loadingRecipients, setLoadingRecipients] = useState(false);

  const tone = STATUS_TONE[campaign.status] ?? "bg-slate-500/15 text-slate-300 border-slate-500/30";
  const pct =
    campaign.total_recipients > 0
      ? Math.round((campaign.sent_count / campaign.total_recipients) * 100)
      : 0;

  const loadRecipients = useCallback(
    async (offset: number) => {
      setLoadingRecipients(true);
      try {
        const res = await fetch(
          `/api/manifest/${tenantSlug}/cold-outreach/campaigns/${campaign.id}/recipients?offset=${offset}&limit=50`,
          { credentials: "include" },
        );
        const json = await res.json();
        if (json.recipients) {
          setRecipients((prev) => (offset === 0 ? json.recipients : [...prev, ...json.recipients]));
          setRecipientTotal(json.total ?? 0);
          setRecipientOffset(offset + (json.recipients as Recipient[]).length);
        }
      } finally {
        setLoadingRecipients(false);
      }
    },
    [campaign.id, tenantSlug],
  );

  const handleExpand = () => {
    if (!expanded && recipients.length === 0) {
      loadRecipients(0);
    }
    setExpanded((v) => !v);
  };

  const channelIcon = (() => {
    if (campaign.channel === "sms_twilio") return <MessageSquare className="w-3 h-3" />;
    if (campaign.channel === "sms_texttorrent") return <Megaphone className="w-3 h-3" />;
    return <Mail className="w-3 h-3" />;
  })();

  return (
    <div className="border-b border-bg-border last:border-0">
      <button
        type="button"
        onClick={handleExpand}
        className="w-full text-left px-4 py-3 flex items-center gap-3 hover:bg-bg-elev/60"
      >
        <span className="text-fg-dim shrink-0">{channelIcon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-semibold text-fg truncate">{campaign.name}</span>
            <span
              className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded border ${tone}`}
            >
              {campaign.status}
            </span>
          </div>
          <div className="text-[11px] text-fg-dim mt-0.5">
            {new Date(campaign.created_at).toLocaleDateString()} ·{" "}
            {campaign.total_recipients > 0
              ? `${campaign.sent_count} / ${campaign.total_recipients} sent`
              : "not yet started"}
          </div>
          {(campaign.status === "sending" || campaign.status === "complete") &&
            campaign.total_recipients > 0 && (
              <div className="mt-1.5 h-1 w-full rounded-full bg-bg-border overflow-hidden">
                <div
                  className="h-full bg-accent rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
        </div>
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-fg-dim shrink-0" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-fg-dim shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="px-4 pb-3">
          {loadingRecipients && recipients.length === 0 ? (
            <div className="text-xs text-fg-dim italic py-3 flex items-center gap-2 justify-center">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading recipients…
            </div>
          ) : recipients.length === 0 ? (
            <div className="text-xs text-fg-dim italic py-3 text-center">
              No recipients yet — campaign hasn&apos;t started.
            </div>
          ) : (
            <>
              <div className="rounded-md border border-bg-border divide-y divide-bg-border">
                {recipients.map((r) => {
                  const rTone =
                    RECIPIENT_STATUS_TONE[r.status] ??
                    "bg-slate-500/15 text-slate-300 border-slate-500/30";
                  return (
                    <div key={r.id} className="px-3 py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[12px] font-medium text-fg truncate">
                          {r.contact_address}
                        </div>
                        {r.last_error && (
                          <div className="text-[10.5px] text-rose-300 mt-0.5 flex items-center gap-1">
                            <AlertTriangle className="w-2.5 h-2.5 shrink-0" />
                            {r.last_error}
                          </div>
                        )}
                      </div>
                      <span
                        className={`text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded border shrink-0 ${rTone}`}
                      >
                        {r.status}
                      </span>
                    </div>
                  );
                })}
              </div>
              {recipientOffset < recipientTotal && (
                <button
                  type="button"
                  onClick={() => loadRecipients(recipientOffset)}
                  disabled={loadingRecipients}
                  className="mt-2 text-[11px] text-fg-dim hover:text-fg flex items-center gap-1 disabled:opacity-50"
                >
                  {loadingRecipients ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : null}
                  Load more ({recipientTotal - recipientOffset} remaining)
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function ColdOutreachClient({
  tenantSlug,
  tenantId,
  lockedChannel,
}: {
  tenantSlug: string;
  tenantId: string | null;
  /** When set, this surface is locked to one channel and the channel picker is
   *  hidden — used by the Campaigns tab's Twilio (sms_twilio) and Gmail (email) sub-tabs. */
  lockedChannel?: Channel;
}) {
  // ── List state ────────────────────────────────────────────────────────────
  const [lists, setLists] = useState<ColdList[] | null>(null);
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [recentCampaignsForList, setRecentCampaignsForList] = useState<Campaign[]>([]);

  // ── New-list dialog ────────────────────────────────────────────────────────
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [newListName, setNewListName] = useState("");
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // ── Compose state ─────────────────────────────────────────────────────────
  const [channel, setChannel] = useState<Channel>(lockedChannel ?? "sms_twilio");
  const [messageBody, setMessageBody] = useState("");
  const [subject, setSubject] = useState("");
  const [dailyCap, setDailyCap] = useState(500);
  const [recipientFilter, setRecipientFilter] = useState<RecipientFilter>({});

  // ── HTML template picker (email channel) ─────────────────────────────────
  // The SunBiz marketing template library (SunBiz-Agent/docs/*.html),
  // served by /api/manifest/[slug]/cold-outreach/templates. Picking one
  // loads its HTML into messageBody + its suggested subject; the runner
  // substitutes {{first_name}} {{business_name}} {{year}}
  // {{unsubscribe_url}} per recipient at send time.
  const [htmlTemplates, setHtmlTemplates] = useState<
    Array<{ key: string; name: string; subject: string; size_bytes: number }> | null
  >(null);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  const [applyingTemplate, setApplyingTemplate] = useState(false);

  useEffect(() => {
    if (channel !== "email" || htmlTemplates !== null || !tenantId) return;
    (async () => {
      try {
        const res = await fetch(
          `/api/manifest/${tenantSlug}/cold-outreach/templates`,
          { credentials: "include" },
        );
        const json = await res.json();
        setHtmlTemplates(json.ok ? (json.templates ?? []) : []);
      } catch {
        setHtmlTemplates([]);
      }
    })();
  }, [channel, htmlTemplates, tenantId, tenantSlug]);

  const applyTemplate = useCallback(
    async (key: string) => {
      if (!key) return;
      setApplyingTemplate(true);
      try {
        const res = await fetch(
          `/api/manifest/${tenantSlug}/cold-outreach/templates?key=${encodeURIComponent(key)}`,
          { credentials: "include" },
        );
        const json = await res.json();
        if (json.ok && json.template) {
          setMessageBody(json.template.html);
          setSubject(json.template.subject);
          setPreviewOpen(false);
        }
      } catch {
        // Network blip — leave the compose state untouched.
      } finally {
        setApplyingTemplate(false);
      }
    },
    [tenantSlug],
  );

  // Looks like a full HTML email (vs hand-typed plain text)? Drives the
  // rendered iframe preview below the textarea.
  const bodyIsHtmlEmail =
    channel === "email" && /^\s*(<!doctype|<html)/i.test(messageBody);

  // ── Preview state ─────────────────────────────────────────────────────────
  const [previewLeads, setPreviewLeads] = useState<ColdLead[] | null>(null);
  const [filteredTotal, setFilteredTotal] = useState<number | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // ── Send / confirm state ──────────────────────────────────────────────────
  const [showConfirm, setShowConfirm] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  // ── Campaign tracker ──────────────────────────────────────────────────────
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(false);

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedList = useMemo(
    () => lists?.find((l) => l.id === selectedListId) ?? null,
    [lists, selectedListId],
  );

  const isSms = channel === "sms_twilio" || channel === "sms_texttorrent";
  const charCount = messageBody.length;

  const canSend =
    selectedListId !== null &&
    messageBody.trim().length > 0 &&
    (filteredTotal === null ? (selectedList?.row_count ?? 0) > 0 : filteredTotal > 0);

  const recipientCount =
    filteredTotal !== null
      ? filteredTotal
      : selectedList?.row_count ?? 0;

  // ── Load lists on mount ───────────────────────────────────────────────────
  useEffect(() => {
    if (!tenantId) {
      // Preview mode — same scaffold, empty pickers, no fetches
      setLists([]);
      return;
    }
    (async () => {
      try {
        const res = await fetch(`/api/manifest/${tenantSlug}/cold-lists`, {
          credentials: "include",
        });
        const json = await res.json();
        setLists((json.lists as ColdList[]) ?? []);
      } catch {
        setLists([]);
      }
    })();
  }, [tenantSlug, tenantId]);

  // ── Load campaigns tracker ────────────────────────────────────────────────
  const loadCampaigns = useCallback(async () => {
    if (!tenantId) return;
    setLoadingCampaigns(true);
    try {
      const res = await fetch(
        `/api/manifest/${tenantSlug}/cold-outreach/campaigns?limit=10`,
        { credentials: "include" },
      );
      const json = await res.json();
      setCampaigns((json.campaigns as Campaign[]) ?? []);
    } catch {
      setCampaigns([]);
    } finally {
      setLoadingCampaigns(false);
    }
  }, [tenantSlug, tenantId]);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  // ── When list selected: load recent campaigns for that list ───────────────
  useEffect(() => {
    if (!selectedListId || !tenantId) {
      setRecentCampaignsForList([]);
      return;
    }
    (async () => {
      try {
        const res = await fetch(
          `/api/manifest/${tenantSlug}/cold-outreach/campaigns?limit=5&cold_list_id=${selectedListId}`,
          { credentials: "include" },
        );
        const json = await res.json();
        setRecentCampaignsForList((json.campaigns as Campaign[]) ?? []);
      } catch {
        setRecentCampaignsForList([]);
      }
    })();
  }, [selectedListId, tenantSlug, tenantId]);

  // ── Preview fetch ─────────────────────────────────────────────────────────
  const fetchPreview = useCallback(async () => {
    if (!selectedListId || !tenantId) return;
    setLoadingPreview(true);
    setPreviewOpen(false);
    try {
      const params = new URLSearchParams({ limit: "3" });
      if (recipientFilter.stage) params.set("stage", recipientFilter.stage);
      if (typeof recipientFilter.max_attempts === "number")
        params.set("max_attempts", String(recipientFilter.max_attempts));
      const res = await fetch(
        `/api/manifest/${tenantSlug}/cold-lists/${selectedListId}/leads?${params.toString()}`,
        { credentials: "include" },
      );
      const json = await res.json();
      setPreviewLeads((json.leads as ColdLead[]) ?? []);
      setFilteredTotal(typeof json.total === "number" ? json.total : null);
      setPreviewOpen(true);
    } finally {
      setLoadingPreview(false);
    }
  }, [selectedListId, tenantSlug, tenantId, recipientFilter]);

  // Recompute filtered count when filter changes (without opening preview)
  useEffect(() => {
    if (!selectedListId || !tenantId) {
      setFilteredTotal(null);
      return;
    }
    const hasFilter =
      (typeof recipientFilter.stage === "string" && recipientFilter.stage.length > 0) ||
      typeof recipientFilter.max_attempts === "number";
    if (!hasFilter) {
      setFilteredTotal(null);
      return;
    }
    const params = new URLSearchParams({ limit: "0" });
    if (recipientFilter.stage) params.set("stage", recipientFilter.stage);
    if (typeof recipientFilter.max_attempts === "number")
      params.set("max_attempts", String(recipientFilter.max_attempts));
    fetch(
      `/api/manifest/${tenantSlug}/cold-lists/${selectedListId}/leads?${params.toString()}`,
      { credentials: "include" },
    )
      .then((r) => r.json())
      .then((json) => {
        if (typeof json.total === "number") setFilteredTotal(json.total);
      })
      .catch(() => {});
  }, [selectedListId, tenantSlug, tenantId, recipientFilter]);

  // ── Upload handler ────────────────────────────────────────────────────────
  const handleUpload = async () => {
    const rows = csvText.trim().split("\n").filter((l) => l.trim().length > 0);
    if (rows.length === 0) {
      setUploadError("No rows detected. Expected: business_name,contact_name,phone,email");
      return;
    }
    if (!newListName.trim()) {
      setUploadError("List name is required.");
      return;
    }
    setUploadError(null);
    setUploading(true);
    try {
      const res = await fetch(`/api/manifest/${tenantSlug}/cold-lists/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: newListName.trim(), csv: csvText }),
      });
      const json = await res.json();
      if (json.list_id) {
        // Refresh list sidebar
        const listsRes = await fetch(`/api/manifest/${tenantSlug}/cold-lists`, {
          credentials: "include",
        });
        const listsJson = await listsRes.json();
        setLists((listsJson.lists as ColdList[]) ?? []);
        setSelectedListId(json.list_id as string);
        setCsvText("");
        setNewListName("");
        setShowUploadDialog(false);
      } else {
        setUploadError(json.error ?? "Upload failed.");
      }
    } catch (err) {
      setUploadError(String((err as Error).message || err));
    } finally {
      setUploading(false);
    }
  };

  // ── Submit campaign ───────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    setShowConfirm(false);
    setSending(true);
    setSendResult(null);
    try {
      const body: Record<string, unknown> = {
        cold_list_id: selectedListId,
        channel,
        message_body: messageBody,
        recipient_filter: recipientFilter,
        daily_cap: dailyCap,
        name: `${selectedList?.name ?? "List"} — ${new Date().toLocaleDateString()}`,
      };
      if (channel === "email" && subject.trim()) body.subject = subject.trim();
      const res = await fetch(`/api/manifest/${tenantSlug}/cold-outreach/campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (json.campaign_id) {
        setSendResult({ ok: true, message: `Campaign queued (ID: ${json.campaign_id}). Daemon drains pending recipients via send_gateway.` });
        // Reset compose
        setMessageBody("");
        setSubject("");
        setRecipientFilter({});
        setFilteredTotal(null);
        setPreviewOpen(false);
        await loadCampaigns();
      } else {
        setSendResult({ ok: false, message: json.error ?? "Campaign creation failed." });
      }
    } catch (err) {
      setSendResult({ ok: false, message: String((err as Error).message || err) });
    } finally {
      setSending(false);
    }
  }, [selectedListId, selectedList, channel, messageBody, subject, recipientFilter, dailyCap, tenantSlug, loadCampaigns]);

  // =========================================================================
  return (
    <div className="space-y-5">

      {/* ── Step 1 — Pick a cold list ───────────────────────────────────── */}
      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
              1 · Cold List
            </div>
            <button
              type="button"
              onClick={() => {
                setUploadError(null);
                setCsvText("");
                setNewListName("");
                setShowUploadDialog(true);
              }}
              className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev"
            >
              <Plus className="w-3 h-3" /> New list
            </button>
          </div>

          {/* Upload dialog */}
          {showUploadDialog && (
            <div className="rounded-md border border-bg-border bg-bg-elev p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-semibold text-fg">Upload CSV list</span>
                <button
                  type="button"
                  onClick={() => setShowUploadDialog(false)}
                  className="text-fg-dim hover:text-fg"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <input
                type="text"
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                placeholder="List name (e.g. Florida Contractors May 2026)"
                className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
              />
              <textarea
                value={csvText}
                onChange={(e) => setCsvText(e.target.value)}
                placeholder={"Paste CSV — one row per line:\nbusiness_name,contact_name,phone,email\nAcme Corp,John Smith,+14165551234,john@acme.com"}
                rows={6}
                className="w-full text-[12px] font-mono px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg resize-none placeholder:text-fg-dim"
              />
              {uploadError && (
                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-2.5 text-[12px] text-rose-200 flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0 text-rose-400" />
                  {uploadError}
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowUploadDialog(false)}
                  className="text-[12px] text-fg-dim hover:text-fg px-3 py-1.5"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleUpload}
                  disabled={uploading}
                  className="inline-flex items-center gap-1.5 text-[12px] font-semibold px-4 py-1.5 rounded-md bg-accent text-bg-deep disabled:opacity-50"
                >
                  {uploading ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Upload
                </button>
              </div>
            </div>
          )}

          {/* List sidebar */}
          <div className="flex gap-4">
            <div className="w-[280px] shrink-0">
              {lists === null ? (
                <div className="text-xs text-fg-dim italic py-4 text-center">
                  Loading lists…
                </div>
              ) : lists.length === 0 ? (
                <div className="text-xs text-fg-dim italic py-4 text-center">
                  No cold lists yet. Upload one above.
                </div>
              ) : (
                <div className="rounded-md border border-bg-border divide-y divide-bg-border max-h-64 overflow-y-auto">
                  {lists.map((l) => {
                    const isSelected = l.id === selectedListId;
                    return (
                      <button
                        key={l.id}
                        type="button"
                        onClick={() => {
                          setSelectedListId(l.id);
                          setPreviewOpen(false);
                          setFilteredTotal(null);
                          setRecipientFilter({});
                        }}
                        className={`w-full text-left px-3 py-2.5 hover:bg-bg-elev/60 ${
                          isSelected ? "bg-accent/10" : ""
                        }`}
                      >
                        <div className={`text-[13px] font-semibold truncate ${isSelected ? "text-accent" : "text-fg"}`}>
                          {l.name}
                        </div>
                        <div className="text-[11px] text-fg-dim mt-0.5">
                          {l.row_count.toLocaleString()} contacts
                          {l.promoted_count > 0 && (
                            <span className="text-fg-muted"> · {l.promoted_count} promoted</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Right summary pane */}
            <div className="flex-1 min-w-0">
              {selectedList ? (
                <div className="space-y-3">
                  <div className="rounded-md border border-bg-border bg-bg-deep px-4 py-3 space-y-1">
                    <div className="text-[13px] font-semibold text-fg">{selectedList.name}</div>
                    <div className="text-[11.5px] text-fg-dim">
                      {selectedList.row_count.toLocaleString()} total ·{" "}
                      {selectedList.promoted_count} promoted ·{" "}
                      {selectedList.source ? `Source: ${selectedList.source}` : "No source"} ·{" "}
                      Added {new Date(selectedList.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  {recentCampaignsForList.length > 0 ? (
                    <div>
                      <div className="text-[10.5px] uppercase tracking-wider text-fg-muted mb-1.5 font-semibold">
                        Recent campaigns against this list
                      </div>
                      <div className="rounded-md border border-bg-border divide-y divide-bg-border">
                        {recentCampaignsForList.map((c) => {
                          const tone = STATUS_TONE[c.status] ?? "bg-slate-500/15 text-slate-300 border-slate-500/30";
                          return (
                            <div key={c.id} className="px-3 py-2 flex items-center justify-between gap-3">
                              <span className="text-[12px] text-fg truncate">{c.name}</span>
                              <span className={`text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border shrink-0 ${tone}`}>
                                {c.status}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11.5px] text-fg-dim italic">
                      No campaigns against this list yet.
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-fg-dim italic py-4">
                  Select a list on the left to see its summary and recent campaigns.
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* ── Step 2 — Compose ────────────────────────────────────────────── */}
      <Card>
        <div className="space-y-4">
          <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
            2 · Compose
          </div>

          {!lockedChannel && (
            <ChannelPicker value={channel} onChange={(c) => { setChannel(c); setPreviewOpen(false); }} />
          )}

          {channel === "email" && (
            <div className="flex items-center gap-2">
              <select
                value={selectedTemplateKey}
                onChange={(e) => setSelectedTemplateKey(e.target.value)}
                disabled={applyingTemplate || htmlTemplates === null}
                className="flex-1 text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg disabled:opacity-50"
              >
                <option value="">
                  {htmlTemplates === null
                    ? "Loading HTML templates…"
                    : "HTML template (optional) — or write plain text below"}
                </option>
                {(htmlTemplates ?? []).map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name} · {Math.round(t.size_bytes / 1024)} KB
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => applyTemplate(selectedTemplateKey)}
                disabled={!selectedTemplateKey || applyingTemplate}
                className="inline-flex items-center gap-1.5 text-[12px] px-3 py-2 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-40 shrink-0"
              >
                {applyingTemplate ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : null}
                Apply
              </button>
            </div>
          )}

          {channel === "email" && (
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Subject line — e.g. Quick question about {{business_name}}"
              className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
            />
          )}

          <div className="space-y-1">
            <textarea
              value={messageBody}
              onChange={(e) => { setMessageBody(e.target.value); setPreviewOpen(false); }}
              placeholder={"Hi {{first_name}} — quick question about {{business_name}}'s funding needs…"}
              rows={5}
              className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg resize-none placeholder:text-fg-dim"
            />
            <div className="flex items-center justify-between text-[10.5px] text-fg-muted">
              <span>Variables: {"{{"} first_name {"}}"}  {"{{"} business_name {"}}"}  {"{{"} phone {"}}"}  {"{{"} email {"}}"}</span>
              {isSms ? (
                <span className={charCount > SMS_CHAR_LIMIT ? "text-rose-300" : ""}>
                  {charCount} / {SMS_CHAR_LIMIT} chars
                  {charCount > SMS_CHAR_LIMIT && " — will split into multiple SMS"}
                </span>
              ) : (
                <span>
                  {messageBody.split("\n").length} lines · {messageBody.split(/\s+/).filter(Boolean).length} words
                </span>
              )}
            </div>
            <div className="text-[10.5px] text-fg-dim">
              Stays under {SMS_CHAR_LIMIT} chars for SMS to avoid splits. Respects CASL + carrier limits via send_gateway.
            </div>
          </div>

          {bodyIsHtmlEmail && (
            <div className="space-y-1">
              <div className="text-[10.5px] text-fg-dim">
                Rendered preview (tokens shown raw — substituted per
                recipient at send time):
              </div>
              <iframe
                title="Email template preview"
                sandbox=""
                srcDoc={messageBody}
                className="w-full h-96 rounded-md border border-bg-border bg-white"
              />
            </div>
          )}

          <div className="flex items-center gap-3">
            <label className="text-[11px] text-fg-dim shrink-0">Daily cap</label>
            <input
              type="number"
              value={dailyCap}
              onChange={(e) => setDailyCap(Math.max(1, Math.min(5000, Number(e.target.value))))}
              min={1}
              max={5000}
              className="w-28 text-sm px-3 py-1.5 rounded-md bg-bg-deep border border-bg-border text-fg"
            />
            <span className="text-[10.5px] text-fg-dim">
              Max per day (1–5 000). Respects CASL + carrier limits via send_gateway.
            </span>
          </div>
        </div>
      </Card>

      {/* ── Step 3 — Preview + Send ──────────────────────────────────────── */}
      <Card>
        <div className="space-y-4">
          <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
            3 · Preview + Send
          </div>

          <RecipientFilterChips
            filter={recipientFilter}
            totalInList={selectedList?.row_count ?? 0}
            filteredCount={filteredTotal}
            onChange={(f) => { setRecipientFilter(f); setPreviewOpen(false); }}
          />

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={fetchPreview}
              disabled={!selectedListId || loadingPreview}
              className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-40"
            >
              {loadingPreview ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
              Preview first 3 messages
            </button>

            <div className="flex-1" />

            <button
              type="button"
              onClick={() => setShowConfirm(true)}
              disabled={!canSend || sending}
              className="inline-flex items-center gap-2 text-[12.5px] font-semibold px-5 py-2 rounded-md bg-accent text-bg-deep disabled:opacity-40"
            >
              {sending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              Send to {recipientCount.toLocaleString()} {CHANNEL_LABEL[channel]}
            </button>
          </div>

          {/* Preview dropdown */}
          {previewOpen && previewLeads !== null && (
            <div className="rounded-md border border-bg-border bg-bg-deep divide-y divide-bg-border">
              {previewLeads.length === 0 ? (
                <div className="px-4 py-3 text-xs text-fg-dim italic">
                  No contacts match the current filter.
                </div>
              ) : (
                previewLeads.map((lead) => (
                  <div key={lead.id} className="px-4 py-3 space-y-1">
                    <div className="text-[11px] font-semibold text-fg-dim uppercase tracking-wider">
                      {lead.business_name}
                      {lead.contact_name ? ` · ${lead.contact_name}` : ""}
                    </div>
                    <div className="text-[12.5px] text-fg leading-relaxed whitespace-pre-wrap">
                      {renderPreviewMessage(messageBody, lead)}
                    </div>
                    <div className="text-[10px] text-fg-muted font-mono">
                      To: {channel === "email" ? (lead.email ?? "no email") : (lead.phone ?? "no phone")}
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {sendResult && (
            <div
              className={`rounded-md border p-2.5 text-[12px] ${
                sendResult.ok
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-100"
              }`}
            >
              {sendResult.message}
            </div>
          )}
        </div>
      </Card>

      {/* ── Confirmation dialog ──────────────────────────────────────────── */}
      {showConfirm && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="rounded-xl border border-bg-border bg-bg-panel p-6 shadow-card w-full max-w-md space-y-4 mx-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-300 shrink-0 mt-0.5" />
              <div>
                <div className="text-[14px] font-bold text-fg">Confirm blast</div>
                <div className="text-[12.5px] text-fg-muted mt-1 leading-relaxed">
                  About to send{" "}
                  <span className="font-semibold text-fg">{recipientCount.toLocaleString()}</span>{" "}
                  <span className="font-semibold text-fg">{CHANNEL_LABEL[channel]}</span>{" "}
                  message{recipientCount === 1 ? "" : "s"}. CASL footer auto-included. Daily cap:{" "}
                  <span className="font-semibold text-fg">{dailyCap.toLocaleString()}</span>.
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="text-[12px] text-fg-dim hover:text-fg px-4 py-2"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSend}
                className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold px-5 py-2 rounded-md bg-accent text-bg-deep"
              >
                <Send className="w-3.5 h-3.5" /> Send all
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Campaign tracker ─────────────────────────────────────────────── */}
      <Card
        title="Recent campaigns"
        action={
          <button
            type="button"
            onClick={loadCampaigns}
            disabled={loadingCampaigns}
            className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-50"
          >
            <RefreshCcw className={`w-3 h-3 ${loadingCampaigns ? "animate-spin" : ""}`} />
            Refresh
          </button>
        }
      >
        {campaigns.length === 0 ? (
          <div className="text-xs text-fg-dim italic py-4 text-center">
            {loadingCampaigns ? "Loading campaigns…" : "No campaigns yet. Send the first one above."}
          </div>
        ) : (
          <div className="rounded-md border border-bg-border divide-y divide-bg-border -mx-5 -mb-5">
            {campaigns.map((c) => (
              <CampaignRow key={c.id} campaign={c} tenantSlug={tenantSlug} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
