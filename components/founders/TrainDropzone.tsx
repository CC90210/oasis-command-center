"use client";

/**
 * Drag a link in, or paste a wall of them, and Maven learns from it.
 *
 * Adon: "I can just drag and drop the link right in and you'll automatically be
 * able to ingest that and also be able to replicate certain videos and take
 * inspiration from certain videos to create ads."
 *
 * The parse runs CLIENT-SIDE first so the operator sees what each link is, and
 * what will be pulled out of it, BEFORE committing. Ingestion is asynchronous
 * and can take minutes; a queue you cannot inspect reads as broken rather than
 * as working.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  CORPUS_LABEL_COPY,
  CORPUS_LABELS,
  describeExtraction,
  extractUrls,
  parseIngestUrl,
  type CorpusLabel,
} from "@/lib/founders/ingest-core";

type Parsed = {
  raw: string;
  ok: boolean;
  kind?: string;
  label?: string;
  describe?: string;
  inspirable?: boolean;
  reason?: string;
};

const KIND_ICON: Record<string, string> = {
  youtube: "▶",
  instagram: "◎",
  tiktok: "♪",
  github: "⌥",
  web: "⌘",
};

export function TrainDropzone({ onQueued }: { onQueued?: () => void }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [label, setLabel] = useState<CorpusLabel>("exemplar");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<null | { tone: "ok" | "warn" | "bad"; msg: string }>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Live preview of what the paste will become. Pure, no network.
  const parsed: Parsed[] = useMemo(() => {
    return extractUrls(text).map((raw) => {
      const r = parseIngestUrl(raw);
      if (!r.ok) return { raw, ok: false, reason: r.reason };
      return {
        raw,
        ok: true,
        kind: r.target.kind,
        label: r.target.label,
        describe: describeExtraction(r.target),
        inspirable: r.target.inspirable,
      };
    });
  }, [text]);

  const good = parsed.filter((p) => p.ok);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const dropped =
      e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain") || "";
    if (dropped) setText((t) => (t ? `${t}\n${dropped}` : dropped));
  }, []);

  async function submit() {
    if (!good.length || busy) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/founders/marketing/ingest", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ urls: good.map((g) => g.raw), label }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) {
        const dup = body.duplicates ? ` · ${body.duplicates} already queued` : "";
        if (body.over_cap) {
          // Over the per-request cap is a WARNING, not a success. The links are
          // left in the box so the operator can submit them, instead of being
          // told "queued 25" while 15 disappeared.
          setResult({
            tone: "warn",
            msg: `Queued ${body.queued}${dup}. ${body.over_cap} more were over the per-drop limit and are still in the box — submit again to queue them.`,
          });
          setText((body.over_cap_links as string[] | undefined)?.join("\n") ?? "");
        } else {
          setResult({ tone: "ok", msg: `Queued ${body.queued} to learn from${dup}.` });
          setText("");
        }
        // The queue and the counters above are server-rendered, so without this
        // a successful drop just empties the box and nothing visibly arrives.
        router.refresh();
        onQueued?.();
      } else if (res.status === 503 && body.error === "migration_pending") {
        // Say exactly what is wrong rather than "failed" — this one is fixable
        // in 30 seconds and the operator is the only one who can fix it.
        setResult({ tone: "warn", msg: body.detail || "Storage not ready yet." });
      } else {
        setResult({ tone: "bad", msg: body.error || `Failed (${res.status}).` });
      }
    } catch (e) {
      setResult({ tone: "bad", msg: e instanceof Error ? e.message : "Network error." });
    }
    setBusy(false);
  }

  return (
    <div className="space-y-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className="rounded-2xl border-2 border-dashed p-1 transition-all"
        style={{
          borderColor: dragging ? "rgba(31,227,240,0.55)" : "rgba(31,227,240,0.18)",
          background: dragging ? "rgba(31,227,240,0.06)" : "transparent",
        }}
      >
        <textarea
          ref={areaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          spellCheck={false}
          placeholder={
            "Drop or paste links here.\nYouTube · Instagram reels · TikTok · GitHub repos · any article.\nPaste several at once."
          }
          className="w-full resize-y rounded-xl bg-transparent px-4 py-3 text-sm text-fg placeholder:text-fg-dim/70 outline-none"
        />
      </div>

      {/* What Maven should conclude from these. The label is the whole point:
          a counter-example teaches more than an exemplar. */}
      <div className="flex flex-wrap items-center gap-2">
        {CORPUS_LABELS.map((l) => {
          const on = label === l;
          return (
            <button
              key={l}
              type="button"
              onClick={() => setLabel(l)}
              title={CORPUS_LABEL_COPY[l].help}
              className="rounded-full border px-3 py-1.5 text-xs font-medium transition-all"
              style={
                on
                  ? { borderColor: "rgba(31,227,240,0.5)", background: "rgba(31,227,240,0.1)", color: "#1FE3F0" }
                  : { borderColor: "rgba(148,163,184,0.22)", color: "#A8B5C2" }
              }
            >
              {CORPUS_LABEL_COPY[l].title}
            </button>
          );
        })}
        <span className="text-[11px] text-fg-dim">{CORPUS_LABEL_COPY[label].help}</span>
      </div>

      {parsed.length > 0 && (
        <ul className="space-y-1.5">
          {parsed.map((p, i) => (
            <li
              key={`${p.raw}-${i}`}
              className="flex items-start gap-3 rounded-lg border border-bg-border bg-bg-deep/40 px-3 py-2"
            >
              <span
                className="mt-0.5 font-mono text-sm"
                style={{ color: p.ok ? "#1FE3F0" : "#FFB4AC" }}
                aria-hidden
              >
                {p.ok ? (KIND_ICON[p.kind || "web"] ?? "⌘") : "×"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-fg">{p.ok ? p.label : p.raw}</span>
                  {p.inspirable && (
                    <span
                      className="rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider"
                      style={{ background: "rgba(31,227,240,0.12)", color: "#7AE8F0" }}
                      title="Can be used as a reference to build an ad from"
                    >
                      usable as inspiration
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-fg-dim">
                  {p.ok ? p.describe : p.reason}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={!good.length || busy}
          className="rounded-full px-5 py-2 text-sm font-bold transition-all disabled:cursor-not-allowed disabled:opacity-40"
          style={{ background: "#1FE3F0", color: "#050B12", boxShadow: "0 0 24px rgba(31,227,240,0.28)" }}
        >
          {busy
            ? "Queueing…"
            : good.length
              ? `Learn from ${good.length} ${good.length === 1 ? "link" : "links"}`
              : "Nothing to learn from yet"}
        </button>
        {text && (
          <button type="button" onClick={() => setText("")} className="text-xs text-fg-dim hover:text-fg">
            Clear
          </button>
        )}
      </div>

      {result && (
        <div
          className="rounded-xl border px-4 py-3 text-sm"
          style={
            result.tone === "ok"
              ? { borderColor: "rgba(140,232,176,0.35)", background: "rgba(140,232,176,0.08)", color: "#8CE8B0" }
              : result.tone === "warn"
                ? { borderColor: "rgba(245,212,138,0.35)", background: "rgba(245,212,138,0.08)", color: "#F5D48A" }
                : { borderColor: "rgba(255,180,172,0.35)", background: "rgba(255,180,172,0.08)", color: "#FFB4AC" }
          }
        >
          {result.msg}
        </div>
      )}
    </div>
  );
}
