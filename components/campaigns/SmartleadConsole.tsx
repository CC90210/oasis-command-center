"use client";

/**
 * SmartleadConsole — the cold-email surface (Campaigns → Cold Email). Shows the
 * pre-warmed mailbox roster + warmup health, the cold-campaign list with start/pause,
 * and a "new cold campaign" composer. Every launch runs through the server's
 * suppression + blast-safety + dry-run rails. Data: /api/campaigns/smartlead.
 * Inert + clearly "not connected" until SMARTLEAD_API_KEY is set on the server.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Send, Loader2 } from "lucide-react";
import { Card, Stat, EmptyState, Tag } from "@/components/Card";

type Account = { id: string | number | null; email: string; warmup: string; reputation: number | null };
type Health = { configured: boolean; mailboxes: number; warming: number; accounts: Account[] };
type Campaign = { id?: string | number; name?: string; status?: string };
type Data = { health: Health; campaigns: Campaign[] };

const input = "text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5";
const btnSec = "rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50";
const btnPri = "rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50";
const labelCls = "text-[11px] uppercase tracking-wide text-fg-dim";

const TIMEZONES = [
  { v: "America/New_York", l: "Eastern" },
  { v: "America/Chicago", l: "Central" },
  { v: "America/Denver", l: "Mountain" },
  { v: "America/Los_Angeles", l: "Pacific" },
  { v: "UTC", l: "UTC" },
];

function statusTone(s: string | undefined): "engaged" | "warm" | "hot" | "neutral" {
  const u = (s || "").toUpperCase();
  if (u.includes("ACTIVE") || u.includes("START") || u.includes("RUNNING")) return "engaged";
  if (u.includes("PAUSE")) return "warm";
  if (u.includes("STOP") || u.includes("ERROR")) return "hot";
  return "neutral";
}

export function SmartleadConsole() {
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [confirming, setConfirming] = useState(false);

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [dailyCap, setDailyCap] = useState(20);
  const [timezone, setTimezone] = useState("America/New_York");
  const [recipientsText, setRecipientsText] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/campaigns/smartlead", { cache: "no-store" });
      const j = await r.json();
      if (!r.ok || !j.ok) { setError(j?.message || j?.error || "Couldn't load cold-email data."); return; }
      setData({ health: j.health?.ok ? j.health : (j.health || { configured: false, mailboxes: 0, warming: 0, accounts: [] }), campaigns: j.campaigns || [] });
    } catch {
      setError("Network error loading cold-email data.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch("/api/campaigns/smartlead", { cache: "no-store" });
        const j = await r.json();
        if (!alive) return;
        if (!r.ok || !j.ok) { setError(j?.message || j?.error || "Couldn't load cold-email data."); return; }
        setData({ health: j.health?.ok ? j.health : (j.health || { configured: false, mailboxes: 0, warming: 0, accounts: [] }), campaigns: j.campaigns || [] });
      } catch {
        if (alive) setError("Network error loading cold-email data.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const recipients = useMemo(
    () => recipientsText.split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l.includes("@")).map((email) => ({ email })),
    [recipientsText],
  );
  const avgRep = useMemo(() => {
    const reps = (data?.health.accounts || []).map((a) => a.reputation).filter((r): r is number => r != null);
    return reps.length ? (reps.reduce((a, b) => a + b, 0) / reps.length).toFixed(1) : "—";
  }, [data]);

  async function run(kind: string, req: () => Promise<Response>, okText: string, after?: () => void) {
    setBusy(kind);
    setNotice(null);
    try {
      const r = await req();
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: `${j.message || j.error || "failed"}${j.lender_hits ? ": " + j.lender_hits.join(", ") : ""}` }); return; }
      if (j.dry_run) { setNotice({ kind: "info", text: `Dry run — would enroll ${j.recipients ?? recipients.length} recipient(s). Live sending is off (LIVE_SEND_SMARTLEAD).` }); }
      else setNotice({ kind: "ok", text: okText });
      after?.();
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
      setConfirming(false);
    }
  }

  const canLaunch = !!name.trim() && !!subject.trim() && !!emailBody.trim() && recipients.length > 0;

  const noticeEl = notice && (
    <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${notice.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : notice.kind === "info" ? "border-status-warm/40 bg-status-warm/5 text-status-warm" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
      {notice.text}
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Send className="h-4 w-4 text-accent" />
        <h2 className="text-sm font-semibold">Cold Email — Smartlead</h2>
      </div>

      {loading ? (
        <Card><div className="text-sm text-fg-dim italic">Loading cold-email console…</div></Card>
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : !data?.health.configured ? (
        <div className="rounded-md border border-status-warm/40 bg-status-warm/5 px-3 py-3 text-[12px] text-status-warm space-y-1">
          <div className="font-semibold">Cold email isn&apos;t connected yet.</div>
          <div>Set <code className="text-[11px]">SMARTLEAD_API_KEY</code> (and <code className="text-[11px]">SMARTLEAD_WEBHOOK_SECRET</code>) on the server, then your pre-warmed mailboxes and campaigns appear here. Sends stay dry-run-gated until <code className="text-[11px]">LIVE_SEND_SMARTLEAD=1</code>.</div>
        </div>
      ) : (
        <div className="space-y-4">
          {noticeEl}

          {/* Mailbox health */}
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Mailboxes" value={data.health.mailboxes.toLocaleString()} />
            <Stat label="Warming" value={data.health.warming.toLocaleString()} accent />
            <Stat label="Avg reputation" value={avgRep} />
          </div>

          {data.health.accounts.length > 0 && (
            <Card noPadding title="Mailboxes">
              <div className="overflow-x-auto">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-left text-fg-dim border-b border-bg-border">
                      <th className="px-4 py-2.5 font-medium">Mailbox</th>
                      <th className="px-4 py-2.5 font-medium">Warmup</th>
                      <th className="px-4 py-2.5 font-medium text-right">Reputation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.health.accounts.map((a, i) => (
                      <tr key={String(a.id ?? i)} className="border-b border-bg-border/40 last:border-b-0">
                        <td className="px-4 py-2.5 text-fg truncate max-w-[280px]">{a.email || "—"}</td>
                        <td className="px-4 py-2.5"><Tag tone={statusTone(a.warmup)}>{(a.warmup || "unknown").toLowerCase()}</Tag></td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-fg-muted">{a.reputation != null ? `${a.reputation}%` : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <div>
            <button type="button" className={btnSec} disabled={busy === "webhook"} onClick={() => void run("webhook", () => fetch("/api/campaigns/smartlead", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "register_webhook" }) }), "Suppression webhook registered.")}>
              {busy === "webhook" ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : null} Register suppression webhook
            </button>
            <span className="ml-2 text-[11px] text-fg-dim">One-time: routes Smartlead bounces / unsubscribes into your suppression list.</span>
          </div>

          {/* Campaigns */}
          <Card title="Cold campaigns" noPadding>
            {data.campaigns.length === 0 ? (
              <EmptyState message="No cold campaigns yet. Create one below." />
            ) : (
              <table className="w-full text-[13px]">
                <tbody>
                  {data.campaigns.map((c, i) => {
                    const cid = String(c.id ?? i);
                    return (
                      <tr key={cid} className="border-b border-bg-border/40 last:border-b-0">
                        <td className="px-4 py-2.5 text-fg">{c.name || "(untitled)"}</td>
                        <td className="px-4 py-2.5"><Tag tone={statusTone(c.status)}>{(c.status || "—").toLowerCase()}</Tag></td>
                        <td className="px-4 py-2.5 text-right">
                          {c.id != null && (
                            <span className="inline-flex gap-2">
                              <button type="button" className="text-[12px] text-accent" disabled={!!busy} onClick={() => void run(`start-${cid}`, () => fetch(`/api/campaigns/smartlead/campaigns/${encodeURIComponent(String(c.id))}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "ACTIVE" }) }), "Campaign started.", () => void load())}>Start</button>
                              <button type="button" className="text-[12px] text-fg-dim" disabled={!!busy} onClick={() => void run(`pause-${cid}`, () => fetch(`/api/campaigns/smartlead/campaigns/${encodeURIComponent(String(c.id))}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "PAUSED" }) }), "Campaign paused.", () => void load())}>Pause</button>
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>

          {/* New cold campaign */}
          <Card title="New cold campaign">
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <div className={labelCls}>Campaign name</div>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={`${input} w-full`} placeholder="July SMB cold — batch 1" />
                </div>
                <div className="space-y-1">
                  <div className={labelCls}>Subject</div>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} className={`${input} w-full`} placeholder="Quick question about your business" />
                </div>
              </div>
              <div className="space-y-1">
                <div className={labelCls}>Body</div>
                <textarea value={emailBody} onChange={(e) => setEmailBody(e.target.value)} rows={5} className={`${input} w-full`} placeholder="Hi there, …" />
                <div className="text-[11px] text-fg-dim">Plain text, no links in the first touch. No money words in the subject; the server blocks lender names + dashes.</div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                <div className="space-y-1">
                  <div className={labelCls}>Daily cap / mailbox</div>
                  <input type="number" min={1} max={50} value={dailyCap} onChange={(e) => setDailyCap(Math.max(1, Math.min(50, Number(e.target.value) || 20)))} className={`${input} w-full`} />
                </div>
                <div className="space-y-1">
                  <div className={labelCls}>Timezone</div>
                  <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={`${input} w-full`}>
                    {TIMEZONES.map((t) => <option key={t.v} value={t.v}>{t.l}</option>)}
                  </select>
                </div>
                <div className="space-y-1 self-end text-[11px] text-fg-dim">{recipients.length} recipient(s) parsed</div>
              </div>
              <div className="space-y-1">
                <div className={labelCls}>Recipients — one email per line</div>
                <textarea value={recipientsText} onChange={(e) => setRecipientsText(e.target.value)} rows={4} className={`${input} w-full font-mono`} placeholder={"owner@business1.com\nowner@business2.com"} />
              </div>

              <div className="text-[11px] text-status-warm">Sends are dry-run gated (LIVE_SEND_SMARTLEAD). Launch is safe until that flag is set.</div>

              {!confirming ? (
                <button type="button" className={btnPri} disabled={!canLaunch || !!busy} onClick={() => setConfirming(true)}>
                  <Send className="inline h-3.5 w-3.5 mr-1" /> Launch cold campaign
                </button>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[12px]">
                  <span>Enroll {recipients.length} recipient(s)?</span>
                  <button type="button" className="font-semibold text-accent" disabled={!!busy} onClick={() => void run("launch", () => fetch("/api/campaigns/smartlead", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "launch", campaign_name: name, subject, email_body: emailBody, daily_cap: dailyCap, timezone, recipients }) }), `Cold campaign created (${recipients.length} recipients).`, () => void load())}>
                    {busy === "launch" ? "Launching…" : "Confirm"}
                  </button>
                  <button type="button" className="text-fg-dim" onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
