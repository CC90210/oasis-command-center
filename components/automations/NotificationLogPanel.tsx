"use client";

/**
 * NotificationLogPanel — everything the agents told CC, newest first, and which
 * bot carried each notice. CC, 2026-11-05: "make sure all the automation
 * notifications are also displayed on the OasisAI command center."
 *
 * Reads GET /api/automations/notifications (agents owner only; anyone else gets
 * scope "not_yours" and this renders nothing, like the Background workers panel).
 */

import { useCallback, useEffect, useState } from "react";
import { AlertCircle, Bell } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { timeAgo } from "@/lib/devices/presence";

export type NoticeAgent = "bravo" | "maven" | "atlas" | "command_center";

export type Notice = {
  id: string;
  agent: NoticeAgent;
  category: string | null;
  title: string;
  body: string | null;
  severity: "info" | "warn" | "urgent";
  bridge: NoticeAgent | null;
  delivered: boolean;
  detail: string | null;
  source: string | null;
  created_at: string;
};

type ApiResponse = {
  ok: boolean;
  notifications: Notice[];
  scope?: "yours" | "not_yours" | "not_installed";
  error?: string;
  message?: string;
};

export const NOTICE_AGENT_LABEL: Record<NoticeAgent, string> = {
  bravo: "Bravo",
  maven: "Maven",
  atlas: "Atlas",
  command_center: "Command Center",
};

const FILTERS: Array<{ key: NoticeAgent | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "bravo", label: "Bravo" },
  { key: "maven", label: "Maven" },
  { key: "atlas", label: "Atlas" },
  { key: "command_center", label: "Command Center" },
];

/** How the notice reached CC, in the words the panel shows. */
export function deliveryLine(n: Pick<Notice, "agent" | "bridge" | "delivered" | "detail">): string {
  if (!n.delivered) return `Not sent to Telegram${n.detail ? `: ${n.detail}` : ""}`;
  if (n.agent === "command_center") {
    return n.detail ? `Sent by the Command Center (${n.detail})` : "Sent by the Command Center";
  }
  const owner = NOTICE_AGENT_LABEL[n.agent];
  if (n.bridge && n.bridge !== n.agent) {
    return `Sent by ${NOTICE_AGENT_LABEL[n.bridge]}'s bot: ${owner}'s bot is not set up where this ran`;
  }
  return `Sent by ${owner}'s bot`;
}

function tone(n: Notice): string {
  if (!n.delivered) return "border-status-warm/40 bg-status-warm/10";
  if (n.severity === "urgent") return "border-status-hot/40 bg-status-hot/10";
  if (n.severity === "warn") return "border-status-warm/30 bg-bg-elev/40";
  return "border-bg-border bg-bg-elev/30";
}

export function NotificationLogPanel() {
  const [filter, setFilter] = useState<NoticeAgent | "all">("all");
  const [data, setData] = useState<ApiResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    const qs = filter === "all" ? "" : `?agent=${filter}`;
    const result = await fetchJson<ApiResponse>(`/api/automations/notifications${qs}`, undefined, { retries: 2 });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (!result.data.ok) {
      setError(result.data.message || result.data.error || `http_${result.status}`);
      return;
    }
    setData(result.data);
    setError(null);
  }, [filter]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 60_000);
    return () => clearInterval(t);
  }, [refresh]);

  if (data?.scope === "not_yours") return null;

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Bell className="w-4 h-4 text-fg-muted" />
        <div className="text-sm font-bold text-fg">Notifications</div>
        <span className="text-[11px] text-fg-dim">what your agents sent you, and which bot carried it (last 90 days)</span>
      </div>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Show notifications from">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`text-[11px] rounded-full border px-2 py-0.5 ${
              filter === f.key ? "border-fg-muted text-fg bg-bg-elev" : "border-bg-border text-fg-muted hover:text-fg"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>
    </div>
  );

  if (error) {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded-xl border border-status-warm/40 bg-status-warm/10 p-3 text-sm text-status-warm flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>Couldn&apos;t load notifications: {error}</span>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-xs text-fg-muted">Loading notifications…</div>
      </div>
    );
  }
  if (data.scope === "not_installed") {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-xs text-fg-muted">
          The notification log is not set up on this database yet, so nothing is recorded here.
        </div>
      </div>
    );
  }
  if (data.notifications.length === 0) {
    return (
      <div className="space-y-3">
        {header}
        <div className="rounded-xl border border-bg-border bg-bg-elev/30 p-4 text-xs text-fg-muted">
          {filter === "all" ? "No notifications yet." : `No notifications from ${NOTICE_AGENT_LABEL[filter]} yet.`}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {header}
      <ul className="space-y-2">
        {data.notifications.map((n) => {
          const expanded = open.has(n.id);
          return (
            <li key={n.id} className={`rounded-lg border p-3 ${tone(n)}`}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="flex items-baseline gap-2 min-w-0">
                  <span className="text-[10px] uppercase tracking-wider text-fg-dim border border-bg-border rounded-full px-1.5 py-0.5 shrink-0">
                    {NOTICE_AGENT_LABEL[n.agent]}
                  </span>
                  <span className="text-sm font-semibold text-fg break-words">{n.title}</span>
                </div>
                <time className="text-[11px] text-fg-dim shrink-0" dateTime={n.created_at} title={n.created_at}>
                  {timeAgo(n.created_at)}
                </time>
              </div>
              {n.body && (
                <button
                  type="button"
                  onClick={() =>
                    setOpen((prev) => {
                      const next = new Set(prev);
                      if (next.has(n.id)) next.delete(n.id);
                      else next.add(n.id);
                      return next;
                    })
                  }
                  aria-expanded={expanded}
                  className={`mt-1 block w-full text-left text-xs text-fg-muted whitespace-pre-line ${expanded ? "" : "line-clamp-2"}`}
                >
                  {n.body}
                </button>
              )}
              <div className={`mt-1 text-[11px] ${n.delivered ? "text-fg-dim" : "text-status-warm"}`}>{deliveryLine(n)}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
