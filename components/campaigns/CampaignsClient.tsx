"use client";

/**
 * CampaignsClient — TextTorrent NATIVE bulk campaigns (the anti-block engine).
 *
 * Fetches GET /api/campaigns (campaigns from /campaigning/analytic + contact
 * lists) on mount. The create form POSTs /api/campaigns → /campaigning/bulk
 * with the carrier-safe options (number-pool rotation, round-robin, batch drip,
 * opt-out link). Owner/admin only; dry-run unless the texttorrent channel is live.
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, EmptyState } from "@/components/Card";
import { Megaphone, Plus, Send } from "lucide-react";

type Campaign = {
  id: string | number;
  name?: string;
  campaign_name?: string;
  status?: string;
  contact_list_name?: string;
  message?: string;
  created_at?: string;
};
type TtList = { id: string; name: string; count?: number };
type Sender = { id: number; number: string; friendly_name?: string };

function fmtDate(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s.replace(" ", "T"));
  return Number.isFinite(d.getTime())
    ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : s;
}

function statusTone(status?: string): string {
  const s = (status || "").toLowerCase();
  if (s === "completed") return "text-status-good";
  if (s === "processing" || s === "scheduled") return "text-status-warm";
  if (s === "failed" || s === "paused") return "text-status-hot";
  return "text-fg-muted";
}

export function CampaignsClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openCampaign = (id: string | number) => {
    const next = new URLSearchParams(searchParams?.toString() || "");
    next.set("campaign", String(id));
    router.replace(`?${next.toString()}`, { scroll: false });
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ missingCreds: boolean; message: string } | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<TtList[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);

  // Create form state
  const [showForm, setShowForm] = useState(false);
  const [listId, setListId] = useState("");
  const [campaignName, setCampaignName] = useState("");
  const [message, setMessage] = useState("");
  const [selectedNumbers, setSelectedNumbers] = useState<string[]>([]); // sender pool to blast from
  const [manualNumbers, setManualNumbers] = useState(""); // fallback if the API can't list numbers
  const [schedule, setSchedule] = useState(""); // datetime-local; empty = now
  // Anti-block options (default ON — the whole point of native campaigns).
  const [numberPool, setNumberPool] = useState(true);
  const [roundRobin, setRoundRobin] = useState(true);
  const [batchProcess, setBatchProcess] = useState(true);
  const [batchSize, setBatchSize] = useState("");
  const [batchFrequency, setBatchFrequency] = useState("");
  const [optOutLink, setOptOutLink] = useState(true);
  const [creating, setCreating] = useState(false);
  const [createNotice, setCreateNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/campaigns");
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setError({
          missingCreds: data?.error === "missing_credentials",
          message: data?.message || "Couldn't load campaigns.",
        });
        return;
      }
      setCampaigns(data.campaigns || []);
      setLists(data.lists || []);
      setSenders(data.senders || []);
    } catch {
      setError({ missingCreds: false, message: "Network error loading campaigns." });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tenantId) void load();
    else setLoading(false);
  }, [tenantId, load]);

  async function handleCreate() {
    if (!listId || !message.trim() || creating) return;
    setCreating(true);
    setCreateNotice(null);
    try {
      const numberList = selectedNumbers.length
        ? selectedNumbers
        : manualNumbers.split(",").map((n) => n.trim()).filter(Boolean);
      const scheduledDate = schedule ? schedule.slice(0, 10) : undefined;
      const scheduledTime = schedule && schedule.length >= 16 ? schedule.slice(11, 16) : undefined;
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          list_id: listId,
          campaign_name: campaignName.trim() || undefined,
          message: message.trim(),
          numbers: numberList.length ? numberList : undefined,
          number_pool: numberPool,
          round_robin: roundRobin,
          batch_process: batchProcess,
          batch_size: batchSize ? Number(batchSize) : undefined,
          batch_frequency: batchFrequency ? Number(batchFrequency) : undefined,
          opt_out_link: optOutLink,
          scheduled_date: scheduledDate,
          scheduled_time: scheduledTime,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setCreateNotice(data?.message || data?.error || "Launch failed.");
        return;
      }
      if (data.dry_run) {
        setCreateNotice("Dry-run — TextTorrent is in dry-run mode, nothing sent. Inputs validated. Flip the TextTorrent channel live to send.");
      } else {
        const id = data.campaign_id ? ` (#${data.campaign_id})` : "";
        const tc = typeof data.total_contacts === "number" ? ` — ${data.total_contacts} contacts` : "";
        const seg = typeof data.total_segments === "number" ? `, ${data.total_segments} segments` : "";
        setCreateNotice(`Campaign launched${id}${tc}${seg}.`);
        setMessage("");
        setCampaignName("");
        setSchedule("");
        void load();
      }
    } catch {
      setCreateNotice("Network error — campaign not launched.");
    } finally {
      setCreating(false);
    }
  }

  if (!tenantId) {
    return (
      <div className="rounded-xl border border-bg-border bg-bg-panel p-6 text-sm text-fg-muted">
        Campaigns render for the tenant that owns this workspace. You&apos;re previewing the shell.
      </div>
    );
  }

  if (error?.missingCreds) {
    return (
      <Card title="TextTorrent not connected">
        <div className="text-sm text-fg-muted">
          {error.message}{" "}
          <a href={`/t/${tenantSlug}/settings#integrations`} className="text-accent hover:underline">
            Add your TextTorrent key in Settings → Integrations
          </a>{" "}
          to load campaigns.
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-fg-dim">
          {!loading && `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`}
        </div>
        <button
          onClick={() => setShowForm((s) => !s)}
          className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs"
        >
          <Plus className="h-3.5 w-3.5" />
          {showForm ? "Close" : "New campaign"}
        </button>
      </div>

      {showForm && (
        <Card title="New campaign" subtitle="Native anti-block bulk · owner/admin · dry-run unless live">
          <div className="space-y-3">
            {createNotice && <div className="text-[11px] text-status-warm">{createNotice}</div>}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-fg-dim">Contact list</span>
                <select
                  value={listId}
                  onChange={(e) => setListId(e.target.value)}
                  className="mt-1 w-full bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent/50"
                >
                  <option value="">Select a list…</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                      {typeof l.count === "number" ? ` (${l.count})` : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-fg-dim">Campaign name (optional)</span>
                <input
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="Auto-dated if blank"
                  className="mt-1 w-full bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wide text-fg-dim">Message</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                placeholder="Campaign message. Include opt-out language on first touch (Reply STOP to opt out)."
                className="mt-1 w-full bg-bg-deep/40 border border-bg-border rounded-md px-3 py-2 text-sm text-fg placeholder:text-fg-dim resize-none focus:outline-none focus:border-accent/50"
              />
            </label>
            <div className="block">
              <span className="text-[11px] uppercase tracking-wide text-fg-dim">Send from (rotate across the pool)</span>
              {senders.length > 0 ? (
                <div className="mt-1 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {senders.map((s) => {
                    const checked = selectedNumbers.includes(s.number);
                    return (
                      <label
                        key={s.id}
                        className="inline-flex items-center gap-2 text-[12px] text-fg-muted bg-bg-deep/30 border border-bg-border rounded-md px-2 py-1.5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={(e) =>
                            setSelectedNumbers((prev) =>
                              e.target.checked ? [...prev, s.number] : prev.filter((n) => n !== s.number),
                            )
                          }
                        />
                        <span className="text-fg">{s.friendly_name || s.number}</span>
                        {s.friendly_name && <span className="text-fg-dim">{s.number}</span>}
                      </label>
                    );
                  })}
                  <div className="text-[10px] text-fg-dim col-span-full">
                    {selectedNumbers.length === 0
                      ? "None selected — sends from the default business number."
                      : `${selectedNumbers.length} selected — the number pool rotates across them.`}
                  </div>
                </div>
              ) : (
                <input
                  value={manualNumbers}
                  onChange={(e) => setManualNumbers(e.target.value)}
                  placeholder="+18604527608, +13106271134 — comma-separated; blank = default number"
                  className="mt-1 w-full bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50"
                />
              )}
            </div>

            <div className="rounded-md border border-bg-border bg-bg-deep/20 p-3">
              <div className="text-[11px] uppercase tracking-wide text-fg-dim mb-2">Anti-block sending</div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px] text-fg-muted">
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={numberPool} onChange={(e) => setNumberPool(e.target.checked)} />
                  Number pool
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={roundRobin} onChange={(e) => setRoundRobin(e.target.checked)} />
                  Round-robin numbers
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={batchProcess} onChange={(e) => setBatchProcess(e.target.checked)} />
                  Batch drip
                </label>
                <label className="inline-flex items-center gap-2">
                  <input type="checkbox" checked={optOutLink} onChange={(e) => setOptOutLink(e.target.checked)} />
                  Opt-out link
                </label>
              </div>
              {batchProcess && (
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <label className="block">
                    <span className="text-[11px] text-fg-dim">Batch size</span>
                    <input
                      type="number"
                      value={batchSize}
                      onChange={(e) => setBatchSize(e.target.value)}
                      placeholder="e.g. 200"
                      className="mt-1 w-full bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50"
                    />
                  </label>
                  <label className="block">
                    <span className="text-[11px] text-fg-dim">Minutes between batches</span>
                    <input
                      type="number"
                      value={batchFrequency}
                      onChange={(e) => setBatchFrequency(e.target.value)}
                      placeholder="e.g. 20"
                      className="mt-1 w-full bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg placeholder:text-fg-dim focus:outline-none focus:border-accent/50"
                    />
                  </label>
                </div>
              )}
            </div>

            <div className="flex items-end justify-between gap-3">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-fg-dim">Schedule (optional)</span>
                <input
                  type="datetime-local"
                  value={schedule}
                  onChange={(e) => setSchedule(e.target.value)}
                  className="mt-1 block bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent/50"
                />
              </label>
              <button
                onClick={handleCreate}
                disabled={creating || !listId || !message.trim()}
                className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-2 text-xs disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {creating ? "Launching…" : "Launch campaign"}
              </button>
            </div>
          </div>
        </Card>
      )}

      <Card noPadding>
        {loading ? (
          <div className="p-6 text-sm text-fg-dim">Loading campaigns…</div>
        ) : campaigns.length === 0 ? (
          <EmptyState message="No campaigns yet. Create one above to blast a contact list." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Campaign</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">List</th>
                  <th className="px-3 py-2.5 font-medium text-right">Created</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={String(c.id)}
                    onClick={() => openCampaign(c.id)}
                    className="border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30 cursor-pointer"
                  >
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-fg flex items-center gap-2">
                        <Megaphone className="h-3.5 w-3.5 text-fg-dim" />
                        {c.campaign_name || c.name || `Campaign ${String(c.id).slice(0, 8)}`}
                      </div>
                      {c.message && <div className="text-xs text-fg-dim truncate max-w-[280px]">{c.message}</div>}
                    </td>
                    <td className={`px-3 py-2.5 ${statusTone(c.status)}`}>{c.status || "—"}</td>
                    <td className="px-3 py-2.5 text-fg-muted">{c.contact_list_name || "—"}</td>
                    <td className="px-3 py-2.5 text-right text-fg-muted tabular-nums">{fmtDate(c.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
