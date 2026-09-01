"use client";

/**
 * DocumentsViewer — full-screen lightbox to swipe through ALL of a lead's
 * documents at once (2026-06-29, Adon ask: "click View all and swift through
 * them all"). Mounts over the LeadDetailDrawer; resolves an authenticated,
 * same-origin stream per doc on demand and caches that stable route.
 *
 * PDFs render inline via <iframe>,
 * images via <img>; anything else falls back to a download link. Navigate with
 * the on-screen arrows, ←/→ keys, the thumbnail strip, or a touch swipe.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, ImageIcon, Loader2, Download } from "lucide-react";
import { leadDocTypeLabel } from "@/lib/lead-doc-display";
import { documentPreviewKind } from "@/lib/document-preview";

export type ViewerDoc = {
  id: string;
  filename: string;
  mime_type: string | null;
  doc_type: string;
  active_variant?: "clean" | "watermarked";
  legacy_baked?: boolean;
};

type Entry =
  | { status: "loading" }
  | { status: "ready"; url: string; downloadUrl: string }
  | { status: "error" };

export function DocumentsViewer({
  docs,
  onClose,
  startIndex = 0,
  canMutate = true,
}: {
  docs: ViewerDoc[];
  onClose: () => void;
  startIndex?: number;
  canMutate?: boolean;
}) {
  const [index, setIndex] = useState(
    Math.min(Math.max(0, startIndex), Math.max(0, docs.length - 1)),
  );
  // Cache stable content routes in a ref (avoids stale-closure refetches); a tick state
  // forces re-render when an entry changes.
  const cacheRef = useRef<Record<string, Entry>>({});
  const [, setTick] = useState(0);
  const setEntry = useCallback((id: string, e: Entry) => {
    cacheRef.current[id] = e;
    setTick((t) => t + 1);
  }, []);

  const load = useCallback(
    async (doc?: ViewerDoc) => {
      if (!doc) return;
      const cur = cacheRef.current[doc.id];
      if (cur && (cur.status === "ready" || cur.status === "loading")) return;
      setEntry(doc.id, { status: "loading" });
      try {
        const r = await fetch(`/api/lead-documents/${doc.id}`, { credentials: "include" });
        const j = await r.json().catch(() => ({}));
        if (j.ok && j.url) {
          setEntry(doc.id, {
            status: "ready",
            url: j.url,
            downloadUrl: j.download_url || `${j.url}?download=1`,
          });
        }
        else setEntry(doc.id, { status: "error" });
      } catch {
        setEntry(doc.id, { status: "error" });
      }
    },
    [setEntry],
  );

  // Per-doc active variant (seeded from props, updated on toggle).
  const [variants, setVariants] = useState<Record<string, "clean" | "watermarked">>({});
  const [toggling, setToggling] = useState<null | "clean" | "watermarked">(null);
  const variantOf = useCallback(
    (d?: ViewerDoc) =>
      d ? variants[d.id] || (d.active_variant === "watermarked" ? "watermarked" : "clean") : "clean",
    [variants],
  );
  // Why a WM toggle refused. Until 2026-08-03 a failed toggle did NOTHING
  // visible — the switch snapped back and the operator had no idea whether the
  // statement was branded, which is the same blindness that made "it says it
  // can't watermark it" the most anyone could report about shop-out.
  const [variantError, setVariantError] = useState<string | null>(null);
  const setVariant = useCallback(
    async (d: ViewerDoc, target: "clean" | "watermarked") => {
      if (!canMutate || toggling || variantOf(d) === target) return;
      setToggling(target);
      setVariantError(null);
      try {
        const r = await fetch(`/api/lead-documents/${d.id}/watermark-variant`, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ target }),
        });
        const j = await r.json().catch(() => ({}));
        if (j.ok && j.active) {
          setVariants((p) => ({ ...p, [d.id]: j.active }));
          delete cacheRef.current[d.id]; // invalidate the stream route → re-fetch the new variant
          await load(d);
        } else if (j.ok && j.state === "legacy_baked") {
          setVariantError(j.message || "No clean original — re-upload to get a clean version.");
        } else {
          setVariantError(
            j.error ? `Could not switch: ${j.error}` : "Could not switch this statement.",
          );
        }
      } catch (e) {
        setVariantError(`Could not switch: ${String((e as Error).message || e)}`);
      } finally {
        setToggling(null);
      }
    },
    [canMutate, toggling, load, variantOf],
  );

  // Load the current doc + prefetch its neighbours for snappy navigation.
  useEffect(() => {
    load(docs[index]);
    load(docs[index + 1]);
    load(docs[index - 1]);
  }, [index, docs, load]);

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(docs.length - 1, Math.max(0, i + delta))),
    [docs.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose]);

  const touchX = useRef<number | null>(null);

  const doc = docs[index];
  const entry = doc ? cacheRef.current[doc.id] : undefined;
  const previewKind = documentPreviewKind(doc?.filename, doc?.mime_type);
  const isPdf = previewKind === "pdf";
  const isImage = previewKind === "image";
  const isText = previewKind === "text";

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-bg-elev"
      role="dialog"
      aria-label="All documents"
    >
      <header className="flex items-center gap-2 px-4 py-3 border-b border-bg-border shrink-0">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back"
          className="p-1 -ml-1 rounded-md text-fg-muted hover:text-fg hover:bg-bg-deep transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] text-fg truncate">{doc?.filename || "Documents"}</div>
          <div className="text-[10px] uppercase tracking-wider text-fg-dim truncate">
            {doc ? leadDocTypeLabel(doc.doc_type) : ""}
          </div>
        </div>
        <div className="text-[11px] text-fg-dim tabular-nums shrink-0">
          {docs.length ? index + 1 : 0} / {docs.length}
        </div>
        {doc && doc.doc_type === "bank_statements_3mo" && doc.legacy_baked && (
          <span className="shrink-0 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 font-semibold" title="Watermarked before the clean-storage fix — no clean original. Re-upload from the lead to get a clean copy.">
            WM · no clean
          </span>
        )}
        {canMutate && doc && doc.doc_type === "bank_statements_3mo" && !doc.legacy_baked && (
          <div className="inline-flex items-center rounded-md border border-bg-border overflow-hidden shrink-0" title="Toggle clean / watermarked">
            {(["clean", "watermarked"] as const).map((t, i) => {
              const active = variantOf(doc) === t;
              return (
                <span key={t} className="contents">
                  {i === 1 && <span className="w-px self-stretch bg-bg-border" />}
                  <button
                    type="button"
                    disabled={!!toggling}
                    onClick={() => setVariant(doc, t)}
                    className={`px-2 py-1 text-[10px] uppercase tracking-wider font-semibold disabled:opacity-60 ${
                      active ? "bg-accent/20 text-fg" : "text-fg-dim hover:text-fg hover:bg-bg-deep"
                    }`}
                  >
                    {toggling === t ? "…" : t === "clean" ? "Clean" : "WM"}
                  </button>
                </span>
              );
            })}
          </div>
        )}
        {doc && entry?.status === "ready" && (
          <a
            href={entry.downloadUrl}
            download={doc.filename}
            target="_blank"
            rel="noopener"
            title="Download this document"
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-bg-border px-2 py-1 text-[11px] font-semibold text-fg-muted hover:text-fg hover:bg-bg-deep"
          >
            <Download className="w-3.5 h-3.5" /> Download
          </a>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-[11px] text-fg-dim hover:text-fg px-1 shrink-0"
        >
          Close
        </button>
      </header>

      {variantError && (
        <div className="shrink-0 border-b border-rose-500/30 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-100">
          {variantError}
        </div>
      )}

      <div
        className="relative flex-1 min-h-0 bg-bg-deep"
        onTouchStart={(e) => {
          touchX.current = e.touches[0]?.clientX ?? null;
        }}
        onTouchEnd={(e) => {
          if (touchX.current == null) return;
          const dx = (e.changedTouches[0]?.clientX ?? touchX.current) - touchX.current;
          if (dx < -50) go(1);
          else if (dx > 50) go(-1);
          touchX.current = null;
        }}
      >
        {!doc ? (
          <div className="h-full flex items-center justify-center text-fg-dim text-sm">
            No documents.
          </div>
        ) : !entry || entry.status === "loading" ? (
          <div className="h-full flex items-center justify-center text-fg-dim">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : entry.status === "error" ? (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-fg-dim text-sm">
            <span>Couldn&apos;t load this document.</span>
            <button
              type="button"
              onClick={() => load(doc)}
              className="text-[11px] font-semibold px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-fg"
            >
              Retry
            </button>
          </div>
        ) : isPdf || isText ? (
          <iframe
            src={entry.url}
            title={doc.filename}
            className="w-full h-full border-0 bg-white"
          />
        ) : isImage ? (
          <div className="h-full w-full overflow-auto flex items-center justify-center p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={entry.url}
              alt={doc.filename}
              onError={() => setEntry(doc.id, { status: "error" })}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center gap-3 text-fg-dim text-sm">
            <FileText className="w-6 h-6" />
            <span>Preview not supported for this file type.</span>
            <a
              href={entry.downloadUrl}
              download={doc.filename}
              target="_blank"
              rel="noopener"
              className="text-[11px] font-semibold px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-fg"
            >
              Download
            </a>
          </div>
        )}

        {index > 0 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous document"
            className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-bg-elev/80 border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        )}
        {index < docs.length - 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next document"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-bg-elev/80 border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev"
          >
            <ChevronRight className="w-5 h-5" />
          </button>
        )}
      </div>

      {docs.length > 1 && (
        <div className="shrink-0 flex items-center gap-1.5 overflow-x-auto px-3 py-2 border-t border-bg-border">
          {docs.map((dd, i) => (
            <button
              key={dd.id}
              type="button"
              onClick={() => setIndex(i)}
              title={dd.filename}
              className={`shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[10px] border ${
                i === index
                  ? "border-accent/50 bg-accent/15 text-fg"
                  : "border-transparent text-fg-dim hover:text-fg hover:bg-bg-elev"
              }`}
            >
              {documentPreviewKind(dd.filename, dd.mime_type) === "image" ? (
                <ImageIcon className="w-3 h-3" />
              ) : (
                <FileText className="w-3 h-3" />
              )}
              <span className="max-w-[90px] truncate">{dd.filename}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
