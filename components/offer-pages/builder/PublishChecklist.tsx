"use client";

/**
 * PublishChecklist - what stands between the draft and the public page, in
 * plain sentences (design 3.5), with Publish and Unpublish.
 *
 * Each flagged sentence (money, a number, a percentage, a multiplier, or
 * clients / results / guarantee / proven / revenue / booked) gets its own tick:
 * "true, and we can back it". Editing a sentence clears its tick. Publish is
 * refused by the server until nothing is left on the list; Unpublish always
 * works.
 */
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import type { GateResult } from "@/lib/offer-pages/claims";

export function PublishChecklist({
  gate,
  status,
  publishedVersion,
  alertLine,
  alertConnected,
  busy,
  onTick,
  onPublish,
  onUnpublish,
  publishErrors,
}: {
  gate: GateResult | null;
  status: "live" | "live_with_changes" | "draft";
  publishedVersion: number;
  alertLine: string;
  alertConnected: boolean;
  busy: boolean;
  onTick: (hash: string, confirmed: boolean) => void;
  onPublish: () => void;
  onUnpublish: () => void;
  publishErrors: string[];
}) {
  const blockers = gate?.blockers ?? [];
  const otherBlockers = blockers.filter((b) => !b.startsWith("Confirm "));
  const claims = gate?.claims ?? [];
  const ready = !!gate && blockers.length === 0;
  const statusLine =
    status === "live"
      ? `Live, version ${publishedVersion}.`
      : status === "live_with_changes"
        ? `Live (version ${publishedVersion}). Your newer changes are not live until you publish.`
        : "Not live. The link shows the plain form until you publish.";

  return (
    <div className="space-y-4 rounded-xl border border-bg-border bg-bg-elev/40 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`text-sm font-bold ${status === "draft" ? "text-fg" : "text-status-engaged"}`}>{statusLine}</span>
        <span className="ml-auto flex items-center gap-2">
          {status !== "draft" ? (
            <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" onClick={onUnpublish} disabled={busy}>
              Unpublish
            </button>
          ) : null}
          <button type="button" className="btn-primary !px-4 !py-1.5 text-xs" onClick={onPublish} disabled={busy || !ready}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : status === "draft" ? "Publish" : "Publish changes"}
          </button>
        </span>
      </div>

      <p className={`text-[12px] ${alertConnected ? "text-fg-muted" : "text-status-warm"}`}>{alertLine}</p>

      {otherBlockers.length ? (
        <ul className="space-y-1.5">
          {otherBlockers.map((b) => (
            <li key={b} className="flex items-start gap-2 text-[13px] text-status-warm">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {b}
            </li>
          ))}
        </ul>
      ) : null}

      {claims.length ? (
        <div className="space-y-2">
          <p className="text-[12px] font-semibold text-fg">
            Sentences that make a claim. Tick each one that is true and that you can back.
          </p>
          <ul className="space-y-1.5">
            {claims.map((c) => (
              <li key={c.hash} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={c.confirmed}
                  onChange={(e) => onTick(c.hash, e.target.checked)}
                  aria-label={`True, and we can back it: ${c.sentence}`}
                />
                <span className="text-[13px] text-fg">
                  {c.sentence}
                  <span className="ml-2 text-[11px] text-fg-dim">({c.why.join(", ")})</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {gate?.warnings?.length ? (
        <ul className="space-y-1">
          {gate.warnings.map((w) => (
            <li key={w} className="text-[12px] text-fg-muted">
              {w}
            </li>
          ))}
        </ul>
      ) : null}

      {ready ? (
        <p className="flex items-center gap-2 text-[12px] text-status-engaged">
          <CheckCircle2 className="h-3.5 w-3.5" /> Nothing blocks publishing.
        </p>
      ) : null}

      {publishErrors.length ? (
        <ul className="space-y-1">
          {publishErrors.map((e) => (
            <li key={e} className="text-[12px] text-rose-400">
              {e}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
