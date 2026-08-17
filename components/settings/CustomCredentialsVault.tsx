"use client";

/**
 * CustomCredentialsVault — Settings → Custom credentials editor.
 *
 * Formerly the sibling of the "Known facts about you" editor, which was removed
 * 2026-08-17 (it shipped with its placeholder text still in the box and was
 * injecting that into every cloud chat as authoritative operator context).
 * While Known facts held
 * free-form Markdown facts ("my calendar link is X"), this surface
 * holds structured secrets — API keys, webhook URLs, service tokens —
 * that:
 *   (a) must be retrieved by exact string (not paraphrased), and
 *   (b) should NEVER appear in the chat transcript even when used.
 *
 * Agents read these via the `get_credential(name)` tool in
 * lib/cloud-tool-runner.ts — the value flows to the tool execution
 * site (e.g., http_post Authorization header) without ever crossing
 * the model's context. The model only sees `{"ok": true}` not the
 * secret itself.
 *
 * UI affords three input modes because the right shape depends on
 * what the user has in hand:
 *   1. Single entry — KEY + VALUE form. Best for one-off additions.
 *   2. Bulk paste — textarea that accepts .env-format text
 *      (`KEY=value`, one per line, # for comments, optional quotes,
 *      optional `export ` prefix). Best when migrating from an
 *      existing .env file.
 *   3. (implicit) Existing entries — list with last-updated, delete.
 *
 * Values are NEVER returned by the API — only presence. The "Update"
 * action upserts a new value; "Delete" removes the row. There is no
 * "reveal" affordance by design: if the operator forgot what they
 * pasted, they should re-paste it.
 */

import { useCallback, useEffect, useState } from "react";
import { KeyRound, Trash2, Plus, Upload, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";

type CustomCredentialRow = {
  key: string;
  has_value: boolean;
  updated_at: string | null;
};

type UpsertResult = {
  key: string;
  ok: boolean;
  error?: string;
};

function fmtUpdated(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const ms = Date.now() - d.getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function CustomCredentialsVault() {
  const [rows, setRows] = useState<CustomCredentialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Single-entry add form
  const [singleKey, setSingleKey] = useState("");
  const [singleValue, setSingleValue] = useState("");
  const [singleBusy, setSingleBusy] = useState(false);

  // Bulk-paste form
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkResults, setBulkResults] = useState<UpsertResult[] | null>(null);

  const fetchRows = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch("/api/credentials/custom", { cache: "no-store" });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        entries?: CustomCredentialRow[];
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setErr(j.error || `http_${r.status}`);
        setRows([]);
      } else {
        setRows(j.entries || []);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "fetch_failed");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  async function onAddSingle(e: React.FormEvent) {
    e.preventDefault();
    setSingleBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/credentials/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: singleKey, value: singleValue }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        results?: UpsertResult[];
        error?: string;
      };
      if (!j.ok) {
        const detail = j.results?.[0]?.error || j.error || `http_${r.status}`;
        setErr(detail);
        return;
      }
      setMsg(`Saved ${singleKey.toUpperCase()}.`);
      setSingleKey("");
      setSingleValue("");
      await fetchRows();
    } finally {
      setSingleBusy(false);
    }
  }

  async function onBulkPaste(e: React.FormEvent) {
    e.preventDefault();
    setBulkBusy(true);
    setErr(null);
    setMsg(null);
    setBulkResults(null);
    try {
      const r = await fetch("/api/credentials/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dotenv: bulkText }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        saved?: number;
        failed?: number;
        results?: UpsertResult[];
        error?: string;
      };
      if (j.error) {
        setErr(j.error);
        return;
      }
      setBulkResults(j.results || []);
      const saved = j.saved || 0;
      const failed = j.failed || 0;
      if (failed === 0 && saved > 0) {
        setMsg(`Saved ${saved} credential${saved === 1 ? "" : "s"}.`);
        setBulkText("");
      } else if (saved > 0) {
        setMsg(`Saved ${saved}, ${failed} failed — see details below.`);
      } else {
        setErr(`Nothing saved — see details below.`);
      }
      await fetchRows();
    } finally {
      setBulkBusy(false);
    }
  }

  async function onDelete(key: string) {
    if (!confirm(`Remove ${key}? Agents will lose access to this value immediately.`)) return;
    setErr(null);
    setMsg(null);
    try {
      const r = await fetch("/api/credentials/custom", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const j = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!j.ok) {
        setErr(j.error || `http_${r.status}`);
        return;
      }
      setMsg(`Removed ${key}.`);
      await fetchRows();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "delete_failed");
    }
  }

  return (
    <div className="space-y-5">
      <p className="text-xs text-fg-muted leading-relaxed max-w-3xl">
        Drop in any KEY=VALUE secret your agents need — custom API keys, webhook URLs,
        client-specific tokens. Stored encrypted (AES-256-GCM) and retrievable by agents
        via the <code className="font-mono text-fg">get_credential</code> tool. The value
        never appears in chat — only the result of the action that used it.
      </p>

      {/* Existing entries */}
      <div className="rounded-lg border border-bg-border bg-bg-elev/30">
        <div className="px-3 py-2 border-b border-bg-border flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-wider font-bold text-fg-dim flex items-center gap-2">
            <KeyRound className="w-3 h-3" />
            Stored credentials
            <span className="text-fg-faint">({rows.length})</span>
          </div>
          {loading && <Loader2 className="w-3 h-3 animate-spin text-fg-dim" />}
        </div>
        {!loading && rows.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-fg-dim">
            No custom credentials yet. Add one below or bulk-paste a .env block.
          </div>
        )}
        {rows.length > 0 && (
          <ul className="divide-y divide-bg-border">
            {rows.map((row) => (
              <li
                key={row.key}
                className="px-3 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="font-mono text-sm text-fg truncate">{row.key}</div>
                  <div className="text-[10px] text-fg-dim mt-0.5">
                    value masked · updated {fmtUpdated(row.updated_at)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void onDelete(row.key)}
                  className="text-fg-dim hover:text-status-hot transition-colors p-1.5 rounded-md hover:bg-status-hot/10"
                  title="Remove this credential"
                  aria-label={`Remove ${row.key}`}
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {err && (
        <div className="text-sm text-status-hot bg-status-hot/10 border border-status-hot/30 rounded-md px-3 py-2 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span className="font-mono text-xs">{err}</span>
        </div>
      )}
      {msg && (
        <div className="text-sm text-status-engaged bg-status-engaged/10 border border-status-engaged/30 rounded-md px-3 py-2 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{msg}</span>
        </div>
      )}

      {/* Single-entry add */}
      <form onSubmit={onAddSingle} className="space-y-2.5 rounded-lg border border-bg-border bg-bg-elev/20 p-3">
        <div className="text-[11px] uppercase tracking-wider font-bold text-fg-dim flex items-center gap-2">
          <Plus className="w-3 h-3" />
          Add one credential
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-[1fr,2fr,auto] gap-2">
          <input
            type="text"
            value={singleKey}
            onChange={(e) => setSingleKey(e.target.value)}
            placeholder="MY_API_KEY"
            required
            className="bg-bg-elev border border-bg-border rounded-md px-3 py-2 text-sm font-mono text-fg focus:border-accent focus:outline-none uppercase"
            autoComplete="off"
            spellCheck={false}
          />
          <input
            type="password"
            value={singleValue}
            onChange={(e) => setSingleValue(e.target.value)}
            placeholder="paste secret value"
            required
            className="bg-bg-elev border border-bg-border rounded-md px-3 py-2 text-sm font-mono text-fg focus:border-accent focus:outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          <button
            type="submit"
            disabled={singleBusy || !singleKey || !singleValue}
            className="bg-accent text-bg font-bold py-2 px-4 rounded-md hover:bg-accent-muted transition-colors disabled:opacity-50 text-sm"
          >
            {singleBusy ? "Saving…" : "Save"}
          </button>
        </div>
        <p className="text-[10px] text-fg-dim">
          Key must be UPPER_SNAKE_CASE, max 64 chars, start with a letter.
        </p>
      </form>

      {/* Bulk paste */}
      <div className="rounded-lg border border-bg-border bg-bg-elev/20">
        <button
          type="button"
          onClick={() => setBulkOpen((o) => !o)}
          className="w-full px-3 py-2 flex items-center justify-between text-[11px] uppercase tracking-wider font-bold text-fg-dim hover:text-fg transition-colors"
          aria-expanded={bulkOpen}
        >
          <span className="flex items-center gap-2">
            <Upload className="w-3 h-3" />
            Bulk paste .env block
          </span>
          <span className="text-fg-faint normal-case tracking-normal text-[10px]">
            {bulkOpen ? "close" : "open"}
          </span>
        </button>
        {bulkOpen && (
          <form onSubmit={onBulkPaste} className="px-3 pb-3 space-y-2.5">
            <textarea
              value={bulkText}
              onChange={(e) => setBulkText(e.target.value)}
              rows={8}
              placeholder={
                "# Paste .env-style lines, one per line:\n" +
                "STRIPE_WEBHOOK_SECRET=whsec_...\n" +
                "CALENDLY_API_KEY=pcal_...\n" +
                'CUSTOM_WEBHOOK_URL="https://hooks.zapier.com/..."'
              }
              className="w-full bg-bg-elev border border-bg-border rounded-md px-3 py-2.5 text-xs font-mono text-fg focus:border-accent focus:outline-none resize-y"
              spellCheck={false}
            />
            <div className="flex items-center gap-3">
              <button
                type="submit"
                disabled={bulkBusy || !bulkText.trim()}
                className="bg-accent text-bg font-bold py-2 px-4 rounded-md hover:bg-accent-muted transition-colors disabled:opacity-50 text-sm"
              >
                {bulkBusy ? "Uploading…" : "Upload all"}
              </button>
              <p className="text-[10px] text-fg-dim">
                Comments (#), <code className="font-mono">export</code> prefixes, and
                quoted values are all handled.
              </p>
            </div>
            {bulkResults && bulkResults.length > 0 && (
              <div className="border border-bg-border rounded-md divide-y divide-bg-border max-h-48 overflow-y-auto">
                {bulkResults.map((res, i) => (
                  <div
                    key={`${res.key}-${i}`}
                    className={`px-3 py-1.5 text-[11px] font-mono flex items-center justify-between gap-2 ${
                      res.ok ? "text-status-engaged" : "text-status-hot"
                    }`}
                  >
                    <span className="truncate">
                      {res.ok ? "✓" : "✗"} {res.key}
                    </span>
                    {!res.ok && (
                      <span className="text-fg-dim truncate text-[10px]">{res.error}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
