"use client";

/**
 * CampaignsClient — Phase 3c of the TT + Kixie full embedding plan
 * (2026-06-02). TextTorrent bulk-campaign analytics + a create form.
 *
 * Fetches GET /api/campaigns (campaigns + per-campaign counts + lists +
 * templates) on mount. Create form POSTs /api/campaigns — owner/admin only,
 * DRY-RUN by default server-side.
 *
 * Degrades gracefully: a missing-TT-credentials response shows the Settings
 * CTA instead of an error wall; a 429 mid-fan-out shows a soft refreshing
 * hint rather than failing the table.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState } from "@/components/Card";
import { Megaphone, Plus, Send } from "lucide-react";

type Campaign = {
  id: string;
  name?: string;
  list_id?: string;
  message?: string;
  scheduled_time?: string | null;
  sent?: number;
  delivered?: number;
  clicked?: number;
  failed?: number;
  opted_out?: number;
};
type TtList = { id: string; name: string; count?: number };
type TtTemplate = { id: string; name: string; content: string };

function pct(num?: number, denom?: number): string {
  if (!denom || !num) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

function fmtSchedule(iso?: string | null): string {
  if (!iso) return "Immediate";
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : iso;
}

export function CampaignsClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ missingCreds: boolean; message: string } | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [lists, setLists] = useState<TtList[]>([]);
  const [templates, setTemplates] = useState<TtTemplate[]>([]);
  const [rateLimited, setRateLimited] = useState(false);

  // Create form state
  const [showForm, setShowForm] = useState(false);
  const [listId, setListId] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [message, setMessage] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
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
      setTemplates(data.templates || []);
      setRateLimited(!!data.rate_limited);
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

  function onTemplateChange(id: string) {
    setTemplateId(id);
    const t = templates.find((x) => x.id === id);
    if (t) setMessage(t.content);
  }

  async function handleCreate() {
    if (!listId || !message.trim() || creating) return;
    setCreating(true);
    setCreateNotice(null);
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          list_id: listId,
          message: message.trim(),
          scheduled_time: scheduledTime || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setCreateNotice(data?.message || data?.error || "Create failed.");
        return;
      }
      if (data.dry_run) {
        setCreateNotice(`Dry-run — nothing sent (dashboard is in dry-run mode). Would text ${data.total ?? 0} contact(s).`);
      } else {
        const n = data.sent ?? 0;
        const t = data.total ?? 0;
        const sk = data.skipped ?? 0;
        const f = data.failed ?? 0;
        setCreateNotice(
          `Sent to ${n}/${t}` +
            (sk ? `, ${sk} skipped (opted out)` : "") +
            (f ? `, ${f} failed` : "") +
            (data.capped ? ` — capped at ${t}; run again for the rest` : "") +
            ".",
        );
        setMessage("");
        setScheduledTime("");
        setTemplateId("");
        void load();
      }
    } catch {
      setCreateNotice("Network error — campaign not created.");
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
          {rateLimited && "TT rate limit hit mid-load — some counts may be missing. "}
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
        <Card title="New campaign" subtitle="Owner/admin only · dry-run by default">
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
                <span className="text-[11px] uppercase tracking-wide text-fg-dim">Template (optional)</span>
                <select
                  value={templateId}
                  onChange={(e) => onTemplateChange(e.target.value)}
                  className="mt-1 w-full bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent/50"
                >
                  <option value="">No template</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
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
            <div className="flex items-end justify-between gap-3">
              <label className="block">
                <span className="text-[11px] uppercase tracking-wide text-fg-dim">Schedule (optional)</span>
                <input
                  type="datetime-local"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="mt-1 block bg-bg-deep/40 border border-bg-border rounded-md px-2 py-1.5 text-sm text-fg focus:outline-none focus:border-accent/50"
                />
              </label>
              <button
                onClick={handleCreate}
                disabled={creating || !listId || !message.trim()}
                className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-2 text-xs disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {creating ? "Creating…" : "Create campaign"}
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
                  <th className="px-3 py-2.5 font-medium">Schedule</th>
                  <th className="px-3 py-2.5 font-medium text-right">Sent</th>
                  <th className="px-3 py-2.5 font-medium text-right">Delivered</th>
                  <th className="px-3 py-2.5 font-medium text-right">Clicked</th>
                  <th className="px-3 py-2.5 font-medium text-right">Failed</th>
                  <th className="px-3 py-2.5 font-medium text-right">Opt-out</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr key={c.id} className="border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30">
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-fg flex items-center gap-2">
                        <Megaphone className="h-3.5 w-3.5 text-fg-dim" />
                        {c.name || `Campaign ${c.id.slice(0, 8)}`}
                      </div>
                      {c.message && <div className="text-xs text-fg-dim truncate max-w-[280px]">{c.message}</div>}
                    </td>
                    <td className="px-3 py-2.5 text-fg-muted">{fmtSchedule(c.scheduled_time)}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg">{c.sent ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">
                      {c.delivered ?? "—"}
                      {typeof c.delivered === "number" && typeof c.sent === "number" && (
                        <span className="text-fg-dim text-[11px]"> ({pct(c.delivered, c.sent)})</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{c.clicked ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-status-hot">{c.failed ?? "—"}</td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-fg-muted">{c.opted_out ?? "—"}</td>
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
