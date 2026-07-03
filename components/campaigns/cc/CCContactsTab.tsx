"use client";

/**
 * CCContactsTab — browse/search Constant Contact contacts, create new ones, and
 * open a contact to edit its name, view tags + custom fields, resubscribe, delete,
 * and see its engagement (recent opens/clicks + rates). Talks to
 * /api/campaigns/constant-contact/contacts[/id][/engagement].
 */

import { useCallback, useEffect, useState } from "react";
import { Card, EmptyState, Tag } from "@/components/Card";
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

const input = "text-[12px] rounded-md border border-bg-border bg-transparent px-2 py-1.5";
const btnSec = "rounded-md border border-bg-border px-3 py-1.5 text-[12px] text-fg-muted hover:text-fg disabled:opacity-50";
const btnPri = "rounded-md bg-accent/10 border border-accent/30 text-accent px-3 py-1.5 text-[12px] font-semibold hover:bg-accent/20 disabled:opacity-50";

function permTone(p?: string): "engaged" | "warm" | "hot" | "neutral" {
  const s = (p || "").toLowerCase();
  if (s === "explicit" || s === "implicit") return "engaged";
  if (s === "unsubscribed" || s === "temp_hold") return "hot";
  if (s.includes("pending")) return "warm";
  return "neutral";
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
  const [engagement, setEngagement] = useState<{ rates?: Record<string, unknown>; summary?: Record<string, unknown> } | null>(null);
  const [eFirst, setEFirst] = useState("");
  const [eLast, setELast] = useState("");
  const [busy, setBusy] = useState("");

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
    const body = {
      email_address: detail.email_address,
      first_name: eFirst,
      last_name: eLast,
      create_source: detail.create_source || "Account",
      update_source: "Account",
      list_memberships: detail.list_memberships,
      taggings: detail.taggings,
      custom_fields: detail.custom_fields,
      phone_numbers: detail.phone_numbers,
      street_addresses: detail.street_addresses,
      notes: detail.notes,
    };
    void run("save", () => fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(selId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), "Saved.", () => void load({ cursor }));
  }

  const sel = rows.find((r) => r.contact_id === selId) || detail;
  const rates = engagement?.rates as { open_rate?: number; click_rate?: number } | undefined;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 flex-1 min-w-[200px]">
          <Search className="h-3.5 w-3.5 text-fg-dim" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void load({ email: search.trim() || undefined }); }}
            placeholder="Search by email…"
            className={`${input} flex-1`}
          />
        </div>
        <button type="button" className={btnSec} onClick={() => void load({ email: search.trim() || undefined })}>Search</button>
        <button type="button" className={btnPri} onClick={() => setShowCreate((v) => !v)}>
          <UserPlus className="inline h-3.5 w-3.5 mr-1" /> New contact
        </button>
      </div>

      {showCreate && (
        <Card>
          <div className="flex flex-wrap items-end gap-2">
            <input value={nEmail} onChange={(e) => setNEmail(e.target.value)} placeholder="email@business.com" className={`${input} flex-1 min-w-[200px]`} />
            <input value={nFirst} onChange={(e) => setNFirst(e.target.value)} placeholder="First" className={`${input} w-28`} />
            <input value={nLast} onChange={(e) => setNLast(e.target.value)} placeholder="Last" className={`${input} w-28`} />
            <button type="button" className={btnPri} disabled={busy === "create" || !nEmail.trim()} onClick={createContact}>
              {busy === "create" ? <Loader2 className="inline h-3.5 w-3.5 animate-spin" /> : "Create"}
            </button>
          </div>
        </Card>
      )}

      {notice && (
        <div className={`text-[12px] rounded-md border px-2.5 py-1.5 ${notice.kind === "ok" ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>{notice.text}</div>
      )}

      {loading ? (
        <Card noPadding><div className="p-6 text-sm text-fg-dim italic">Loading contacts…</div></Card>
      ) : error ? (
        <Card><div className="text-sm text-status-warm">{error}</div></Card>
      ) : rows.length === 0 ? (
        <Card noPadding><EmptyState message="No contacts found." /></Card>
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-fg-dim border-b border-bg-border">
                  <th className="px-4 py-2.5 font-medium">Email</th>
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.contact_id} onClick={() => void openContact(r.contact_id)} className={`border-b border-bg-border/40 last:border-b-0 hover:bg-bg-elev/30 cursor-pointer ${selId === r.contact_id ? "bg-bg-elev/40" : ""}`}>
                    <td className="px-4 py-2.5 text-fg truncate max-w-[260px]">{r.email_address?.address || "—"}</td>
                    <td className="px-4 py-2.5 text-fg-muted">{[r.first_name, r.last_name].filter(Boolean).join(" ") || "—"}</td>
                    <td className="px-4 py-2.5"><Tag tone={permTone(r.email_address?.permission_to_send)}>{(r.email_address?.permission_to_send || "unknown").replace(/_/g, " ")}</Tag></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between items-center px-4 py-2 text-[11px] text-fg-dim border-t border-bg-border">
            <span>{rows.length} shown</span>
            <button type="button" disabled={!nextCursor} className="underline disabled:no-underline disabled:opacity-40" onClick={() => void load({ cursor: nextCursor })}>Next page →</button>
          </div>
        </Card>
      )}

      {sel && (
        <Card title="Contact" action={<button type="button" onClick={() => { setSelId(null); setDetail(null); }} className="text-fg-dim hover:text-fg"><X className="h-4 w-4" /></button>}>
          <div className="space-y-3 text-[12px]">
            <div className="text-fg">{sel.email_address?.address}</div>
            <div className="flex flex-wrap items-end gap-2">
              <input value={eFirst} onChange={(e) => setEFirst(e.target.value)} placeholder="First" className={`${input} w-28`} />
              <input value={eLast} onChange={(e) => setELast(e.target.value)} placeholder="Last" className={`${input} w-28`} />
              <button type="button" className={btnSec} disabled={busy === "save" || !detail} onClick={saveName}>Save name</button>
            </div>

            {detail?.custom_fields?.length ? (
              <div className="text-fg-dim">Custom fields: {detail.custom_fields.map((c) => String(c.value)).filter(Boolean).join(", ") || "—"}</div>
            ) : null}

            {rates && (
              <div className="flex gap-4 text-fg-muted">
                <span>Open rate: <span className="text-fg">{rates.open_rate != null ? `${(Number(rates.open_rate) * 100).toFixed(0)}%` : "—"}</span></span>
                <span>Click rate: <span className="text-fg">{rates.click_rate != null ? `${(Number(rates.click_rate) * 100).toFixed(0)}%` : "—"}</span></span>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {selId && (
                <button type="button" className={btnSec} disabled={busy === "resub"} onClick={() => void run("resub", () => fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(selId)}/resubscribe`, { method: "POST" }), "Resubscribed.", () => void load({ cursor }))}>Resubscribe</button>
              )}
              {selId && (
                <button type="button" className="rounded-md border border-red-500/30 text-red-300 px-3 py-1.5 text-[12px] hover:bg-red-500/10 disabled:opacity-50" disabled={busy === "del"} onClick={() => void run("del", () => fetch(`/api/campaigns/constant-contact/contacts/${encodeURIComponent(selId)}`, { method: "DELETE" }), "Contact deleted.", () => { setSelId(null); setDetail(null); void load({ cursor }); })}>Delete</button>
              )}
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
