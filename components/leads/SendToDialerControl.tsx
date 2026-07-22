"use client";

/**
 * SendToDialerControl — "Send to dialer" bulk action for the pipeline board.
 *
 * Lives in the BulkActionBar (components/manifest/LeadPipelineView.tsx) next
 * to bulk assign / stage / email. Enabled once ≥1 lead is selected; opens a
 * small upward popover listing the tenant's configured Kixie PowerLists
 * (GET /api/leads/powerlist — keys+labels only), and picking one POSTs the
 * selected lead ids. Result is shown inline in the bar's chip idiom:
 * "Pushed 42 · 3 no phone · 1 failed".
 *
 * Server enforces the real gates (session, read-only 403, tenant scoping,
 * dry-run via isDryRun("kixie")) — this control is purely the picker.
 */

import { useEffect, useRef, useState } from "react";
import { Loader2, Phone } from "lucide-react";

type PowerlistOption = { key: string; label: string };

type PushResult = {
  ok: boolean;
  pushed?: number;
  skipped_no_phone?: string[];
  failed?: Array<{ id: string; error: string }>;
  dry_run?: boolean;
  error?: string;
  message?: string;
};

export function SendToDialerControl({
  selectedIds,
  disabled,
}: {
  selectedIds: string[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [lists, setLists] = useState<PowerlistOption[] | null>(null);
  const [listsState, setListsState] = useState<"idle" | "loading" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the popover on outside click.
  useEffect(() => {
    if (!open) return;
    function onDown(e: globalThis.MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  async function loadLists() {
    setListsState("loading");
    try {
      const res = await fetch("/api/leads/powerlist", { cache: "no-store" });
      const body = (await res.json()) as { ok?: boolean; powerlists?: PowerlistOption[] };
      if (!res.ok || !body.ok || !Array.isArray(body.powerlists)) throw new Error("load_failed");
      setLists(body.powerlists);
      setListsState("idle");
    } catch {
      setLists(null);
      setListsState("error");
    }
  }

  function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && lists === null && listsState !== "loading") void loadLists();
  }

  async function push(powerlistKey: string) {
    setOpen(false);
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/leads/powerlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lead_ids: selectedIds, powerlist_key: powerlistKey }),
      });
      const body = (await res.json()) as PushResult;
      if (!res.ok || !body.ok) {
        setMsg(`Couldn't push: ${body.message || body.error || `HTTP ${res.status}`}`);
        return;
      }
      const bits = [`Pushed ${body.pushed ?? 0}`];
      const noPhone = body.skipped_no_phone?.length ?? 0;
      const failedN = body.failed?.length ?? 0;
      if (noPhone) bits.push(`${noPhone} no phone`);
      if (failedN) bits.push(`${failedN} failed`);
      if (body.dry_run) bits.push("dry-run");
      setMsg(bits.join(" · "));
    } catch (e) {
      setMsg(`Couldn't push: ${(e as Error).message || "network error"}`);
    } finally {
      setBusy(false);
    }
  }

  const blocked = disabled || busy || selectedIds.length === 0;

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      <button
        type="button"
        disabled={blocked}
        onClick={toggleOpen}
        title="Push the selected leads into a Kixie PowerList (power-dialer queue)"
        className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] transition-colors disabled:opacity-60 ${
          open
            ? "border-accent bg-accent/15 text-accent"
            : "border-bg-border bg-bg-deep text-fg hover:border-fg-dim"
        }`}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
        ) : (
          <Phone className="h-3.5 w-3.5 text-fg-dim" />
        )}
        Send to dialer
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-lg border border-bg-border bg-bg-elev/95 p-2 shadow-lg backdrop-blur">
          <div className="px-1.5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-fg-dim">
            Push {selectedIds.length} lead{selectedIds.length === 1 ? "" : "s"} to…
          </div>
          {listsState === "loading" && (
            <div className="flex items-center gap-2 px-1.5 py-2 text-[11px] text-fg-muted">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading PowerLists…
            </div>
          )}
          {listsState === "error" && (
            <button
              type="button"
              onClick={() => void loadLists()}
              className="w-full rounded-md border border-red-400/40 bg-red-500/10 px-2 py-1.5 text-left text-[11px] text-red-200 hover:bg-red-500/20"
            >
              Couldn&apos;t load PowerLists — retry
            </button>
          )}
          {listsState === "idle" && lists !== null && lists.length === 0 && (
            <div className="px-1.5 py-1.5 text-[11px] leading-relaxed text-fg-muted">
              No PowerLists configured — add them in Settings (tenants.kixie_powerlists) with IDs
              from the Kixie dashboard (Manage → PowerLists).
            </div>
          )}
          {listsState === "idle" &&
            (lists || []).map((l) => (
              <button
                key={l.key}
                type="button"
                disabled={busy}
                onClick={() => void push(l.key)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] text-fg hover:bg-accent/10 disabled:opacity-60"
              >
                <Phone className="h-3 w-3 shrink-0 text-fg-dim" />
                <span className="truncate">{l.label}</span>
              </button>
            ))}
        </div>
      )}

      {msg && (
        <span className="flex items-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-[11px] text-fg">
          {msg}
          <button type="button" onClick={() => setMsg(null)} className="text-fg-dim hover:text-fg">
            ×
          </button>
        </span>
      )}
    </div>
  );
}
