"use client";

/**
 * CCContactsTab — browse/search Constant Contact contacts, create new ones, and
 * open a contact in a slide-in drawer to edit its name, view tags + custom fields,
 * resubscribe, delete, and see its engagement (rate rings + a per-campaign
 * timeline). Talks to /api/campaigns/constant-contact/contacts[/id][/engagement].
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, Tag } from "@/components/Card";
import { Donut } from "@/components/charts/Donut";
import { Loader2, Search, UserPlus, X } from "lucide-react";

type Row = {
  contact_id: string;
  email_address?: { address?: string; permission_to_send?: string };
  first_name?: string;
  last_name?: string;
};
type Detail = Row & {
  create_source?: string;
  list_memberships?: unknown;
  taggings?: unknown;
  custom_fields?: { custom_field_id?: string; value?: string }[];
  phone_numbers?: unknown;
  street_addresses?: unknown;
  notes?: unknown;
};
type Engagement = { rates?: Record<string, unknown>; summary?: unknown };
type TimelineRow = { id: string; label: string; when: string; sends: number; opens: number; clicks: number };

function permTone(p?: string): "engaged" | "warm" | "hot" | "neutral" {
  const s = (p || "").toLowerCase();
  if (s === "explicit" || s === "implicit") return "engaged";
  if (s === "unsubscribed" || s === "temp_hold") return "hot";
  if (s.includes("pending")) return "warm";
  return "neutral";
}

function num(o: Record<string, unknown> | undefined | null, ...keys: string[]): number {
  if (!o) return 0;
  for (const k of keys) {
    const v = o[k];
    if (v != null && !isNaN(Number(v))) return Number(v);
  }
  return 0;
}
function str(o: Record<string, unknown> | undefined | null, ...keys: string[]): string {
  if (!o) return "";
  for (const k of keys) {
    const v = o[k];
    if (v != null && String(v).trim()) return String(v);
  }
  return "";
}
function fmtDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** CC's activity-summary report shape varies by tenant/version — accept an array
 *  directly or nested under results/summary/activities, and read numeric/name/date
 *  fields defensively (mirrors the extractStats() idiom in CCCampaignDrawer). */
function timelineRows(summary: unknown): TimelineRow[] {
  const s = summary as { results?: unknown[]; summary?: unknown[]; activities?: unknown[] } | unknown[] | null | undefined;
  const list = (Array.isArray(s) ? s : s?.results || s?.summary || s?.activities || []) as Record<string, unknown>[];
  return list.map((r, i) => ({
    id: str(r, "campaign_activity_id", "campaign_id", "id") || String(i),
    label: str(r, "email_campaign_name", "campaign_name", "name") || "Campaign",
    when: str(r, "start_on", "send_date", "created_time", "date"),
    sends: num(r, "sends", "em_sends"),
    opens: num(r, "opens", "em_opens", "unique_opens"),
    clicks: num(r, "clicks", "em_clicks", "unique_clicks"),
  }));
}

function ContactsSkeleton() {
  return (
    <div className="rounded-xl border border-bg-border bg-bg-panel overflow-hidden" aria-busy="true" aria-live="polite">
      <div className="h-10 border-b border-bg-border bg-bg-elev/60 animate-pulse-slow" />
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 h-12 border-b border-bg-border/40 last:border-0" style={{ animationDelay: `${i * 50}ms` }}>
          <div className="h-3 w-48 rounded-md bg-bg-elev animate-pulse-slow" />
          <div className="h-3 w-28 rounded-md bg-bg-elev/70 animate-pulse-slow" />
          <div className="ml-auto h-5 w-20 rounded-md bg-bg-elev animate-pulse-slow" />
        </div>
      ))}
    </div>
  );
}

export function CCContactsTab() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [nEmail, setNEmail] = useState("");
  const [nFirst, setNFirst] = useState("");
  const [nLast, setNLast] = useState("");

  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [eFirst, setEFirst] = useState("");
  const [eLast, setELast] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async (opts: { cursor?: string | null; email?: string } = {}) => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams({ limit: "50" });
      if (opts.cursor) q.set("cursor", opts.cursor);
      if (opts.email) q.set("email", opts.email);
      const res = await fetch(`/api/campaigns/constant-contact/contacts?${q}`, { cache: "no-store" });
      const j = await res.json();
      if (!res.ok || !j.ok) { setError(j?.message || j?.error || "Couldn't load contacts."); return; }
      setRows((j.contacts || []) as Row[]);
      const next = j._links?.next?.href as string | undefined;
      const m = next?.match(/cursor=([^&]+)/);
      setNextCursor(m ? decodeURIComponent(m[1]) : null);
      setCursor(opts.cursor ?? null);
    } catch {
      setError("Network error loading contacts.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const openContact = useCallback(async (id: string) => {
    setSelId(id);
    setDetail(null);
    setEngagement(null);
    setConfirmDelete(false);
    try {
      const [d, e] = await Promise.all([
        fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(id)}`, { cache: "no-store" }).then((r) => r.json()),
        fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(id)}/engagement`, { cache: "no-store" }).then((r) => r.json()).catch(() => null),
      ]);
      const dd = (d?.contact || d) as Detail;
      setDetail(dd);
      setEFirst(dd.first_name || "");
      setELast(dd.last_name || "");
      if (e?.ok) setEngagement(e);
    } catch { /* ignore */ }
  }, []);

  function closeDrawer() {
    setSelId(null);
    setDetail(null);
    setEngagement(null);
    setNotice(null);
    setConfirmDelete(false);
  }

  async function run(kind: string, req: () => Promise<Response>, okText: string, after?: () => void) {
    setBusy(kind);
    setNotice(null);
    try {
      const r = await req();
      const j = await r.json();
      if (!r.ok || !j.ok) { setNotice({ kind: "err", text: j.message || j.error || "failed" }); return; }
      setNotice({ kind: "ok", text: okText });
      after?.();
    } catch {
      setNotice({ kind: "err", text: "Request failed." });
    } finally {
      setBusy("");
    }
  }

  function createContact() {
    const address = nEmail.trim().toLowerCase();
    if (!address) return;
    void run(
      "create",
      () => fetch("/api/campaigns/constant-contact/contacts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email_address: { address, permission_to_send: "implicit" }, first_name: nFirst.trim() || undefined, last_name: nLast.trim() || undefined, create_source: "Account" }),
      }),
      "Contact created.",
      () => { setNEmail(""); setNFirst(""); setNLast(""); setShowCreate(false); void load(); },
    );
  }

  function saveName() {
    if (!detail || !selId) return;
    // CC PUT is a full replace: send ONLY writable fields (drop create_source + the read-only
    // taggings/notes/ids) and preserve present scalars, so saving a name can't 400 or wipe data.
    const d = detail as Record<string, unknown>;
    const body: Record<string, unknown> = { email_address: d.email_address, update_source: "Account", first_name: eFirst, last_name: eLast };
    for (const k of ["job_title", "company_name", "birthday_month", "birthday_day", "anniversary", "phone_numbers", "street_addresses", "custom_fields", "list_memberships"]) {
      if (d[k] != null) body[k] = d[k];
    }
    void run("save", () => fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(selId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), "Saved.", () => void load({ cursor }));
  }

  const sel = rows.find((r) => r.contact_id === selId) || detail;
  const rates = engagement?.rates as { average_open_rate?: number; average_click_rate?: number } | undefined;
  const feed = timelineRows(engagement?.summary);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
          <Search className="h-3.5 w-3.5 text-fg-dim shrink-0" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void load({ email: search.trim() || undefined }); }}
            placeholder="Search by email…"
            className="input flex-1"
          />
        </div>
        <button type="button" className="btn-secondary" onClick={() => void load({ email: search.trim() || undefined })}>Search</button>
        <button type="button" className="btn-primary" onClick={() => setShowCreate((v) => !v)}>
          <UserPlus className="inline h-3.5 w-3.5 mr-1" /> New contact
        </button>
      </div>

      {showCreate && (
        <Card>
          <div className="flex flex-wrap items-end gap-2">
            <input value={nEmail} onChange={(e) => setNEmail(e.target.value)} placeholder="email@business.com" className="input flex-1 min-w-[200px]" />
            <input value={nFirst} onChange={(e) => setNFirst(e.target.value)} placeholder="First" className="input w-28" />
            <input value={nLast} onChange={(e) => setNLast(e.target.value)} placeholder="Last" className="input w-28" />
            <button type="button" className="btn-primary" disabled={busy === "create" || !nEmail.trim()} onClick={createContact}>
              {busy === "create" ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Create"}
            </button>
          </div>
        </Card>
      )}

      {loading ? (
        <ContactsSkeleton />
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : rows.length === 0 ? (
        <Card noPadding>
          <EmptyState message="No contacts found." cta={<button type="button" className="btn-primary" onClick={() => setShowCreate(true)}>New contact</button>} />
        </Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.contact_id}
                    onClick={() => void openContact(r.contact_id)}
                    className={`group border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/40 cursor-pointer transition-colors ${selId === r.contact_id ? "bg-bg-elev/40" : ""}`}
                  >
                    <td className="px-4 py-2.5 text-fg group-hover:text-accent transition-colors truncate max-w-[260px]">{r.email_address?.address || "—"}</td>
                    <td className="px-4 py-2.5 text-fg-muted">{[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}</td>
                    <td className="px-4 py-2.5"><Tag tone={permTone(r.email_address?.permission_to_send)}>{(r.email_address?.permission_to_send || "unknown").replace(/_/g, " ")}</Tag></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between items-center px-4 py-2 text-[11px] text-fg-dim border-t border-bg-border">
            <span className="tabular-nums">{rows.length} shown</span>
            <button type="button" disabled={!nextCursor} className="underline disabled:no-underline disabled:opacity-40" onClick={() => void load({ cursor: nextCursor })}>Next page →</button>
          </div>
        </Card>
      )}

      {selId && (
        <div className="fixed inset-0 z-50 flex" role="dialog" aria-modal="true">
          <button type="button" onClick={closeDrawer} className="flex-1 bg-black/60 backdrop-blur-sm cursor-default" aria-label="Close" />
          <aside className="relative w-full sm:w-[560px] h-full bg-bg-elev border-l border-bg-border shadow-[-12px_0_32px_-8px_rgba(0,0,0,0.6)] flex flex-col">
            <header className="px-5 py-4 border-b border-bg-border/60 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-fg truncate">{sel?.email_address?.address || "Contact"}</div>
                <div className="text-[11px] text-fg-dim uppercase tracking-wide">{[sel?.first_name, sel?.last_name].filter(Boolean).join(" ") || "no name on file"}</div>
              </div>
              <button type="button" onClick={closeDrawer} className="text-fg-dim hover:text-fg"><X className="h-4 w-4" /></button>
            </header>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
              {notice && (
                <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${notice.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>{notice.text}</div>
              )}

              {!detail ? (
                <div className="space-y-3" aria-busy="true" aria-live="polite">
                  <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4 flex items-center gap-4">
                    <div className="h-[68px] w-[68px] rounded-full bg-bg-elev animate-pulse-slow" />
                    <div className="h-[68px] w-[68px] rounded-full bg-bg-elev animate-pulse-slow" />
                    <div className="flex-1 space-y-2">
                      <div className="h-3 w-full rounded-md bg-bg-elev animate-pulse-slow" />
                      <div className="h-3 w-3/4 rounded-md bg-bg-elev/70 animate-pulse-slow" />
                    </div>
                  </div>
                  <div className="h-24 rounded-xl border border-bg-border bg-bg-panel/40 animate-pulse-slow" />
                </div>
              ) : (
                <>
                  {/* Identity — edit name */}
                  <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4 space-y-2.5">
                    <div className="text-[10px] uppercase tracking-wide text-fg-dim">Name</div>
                    <div className="flex flex-wrap items-end gap-2">
                      <input value={eFirst} onChange={(e) => setEFirst(e.target.value)} placeholder="First" className="input w-28" />
                      <input value={eLast} onChange={(e) => setELast(e.target.value)} placeholder="Last" className="input w-28" />
                      <button type="button" className="btn-secondary" disabled={busy === "save"} onClick={saveName}>
                        {busy === "save" ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Save name"}
                      </button>
                    </div>
                    {detail.custom_fields?.length ? (
                      <div className="text-[12px] text-fg-dim">Custom fields: {detail.custom_fields.map((c) => String(c.value)).filter(Boolean).join(", ") || "—"}</div>
                    ) : null}
                  </div>

                  {/* Engagement rings */}
                  <div className="flex items-center gap-4 rounded-xl border border-bg-border bg-bg-panel/40 p-4">
                    <div className="text-center">
                      <Donut pct={num(rates as Record<string, unknown>, "average_open_rate") * 100} tone="threshold" />
                      <div className="mt-1.5 text-[10px] uppercase tracking-wide text-fg-dim">Open rate</div>
                    </div>
                    <div className="text-center">
                      <Donut pct={num(rates as Record<string, unknown>, "average_click_rate") * 100} tone="accent" />
                      <div className="mt-1.5 text-[10px] uppercase tracking-wide text-fg-dim">Click rate</div>
                    </div>
                    <div className="flex-1 text-[12px] text-fg-dim">
                      {rates ? "Average across this contact's campaign sends." : "No engagement history yet."}
                    </div>
                  </div>

                  {/* Engagement timeline */}
                  <div className="rounded-xl border border-bg-border bg-bg-panel/40 p-4">
                    <div className="mb-2.5 text-[10px] uppercase tracking-wide text-fg-dim">Engagement timeline</div>
                    {feed.length === 0 ? (
                      <div className="text-[12px] text-fg-dim italic">No campaign activity recorded yet.</div>
                    ) : (
                      <ol className="space-y-2.5">
                        {feed.map((f) => (
                          <li key={f.id} className="flex items-start gap-3 text-[12px]">
                            <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" aria-hidden="true" />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="truncate text-fg">{f.label}</span>
                                <span className="shrink-0 text-fg-dim tabular-nums">{fmtDate(f.when)}</span>
                              </div>
                              <div className="mt-0.5 flex gap-3 text-fg-muted tabular-nums">
                                <span>Sent {f.sends.toLocaleString()}</span>
                                <span className={f.opens ? "text-status-engaged" : ""}>Opened {f.opens.toLocaleString()}</span>
                                <span className={f.clicks ? "text-accent" : ""}>Clicked {f.clicks.toLocaleString()}</span>
                              </div>
                            </div>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button type="button" className="btn-secondary" disabled={busy === "resub"} onClick={() => void run("resub", () => fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(selId)}/resubscribe`, { method: "POST" }), "Resubscribed.", () => void load({ cursor }))}>Resubscribe</button>
                    {!confirmDelete ? (
                      <button type="button" className="btn-danger" onClick={() => setConfirmDelete(true)}>Delete</button>
                    ) : (
                      <span className="inline-flex items-center gap-2 text-[12px]">
                        <span className="text-fg-muted">Delete permanently?</span>
                        <button type="button" className="btn-danger" disabled={busy === "del"} onClick={() => void run("del", () => fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(selId)}`, { method: "DELETE" }), "Contact deleted.", () => { closeDrawer(); void load({ cursor }); })}>
                          {busy === "del" ? "Deleting…" : "Confirm"}
                        </button>
                        <button type="button" className="text-fg-dim hover:text-fg" onClick={() => setConfirmDelete(false)}>Cancel</button>
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
