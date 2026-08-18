"use client";

/**
 * SequenceVolumeView — how much email each sequence sends per day, and the
 * control that changes it.
 *
 * Adon, 2026-08-11: "we need to be able to have a feature that's visual on how
 * many email drips are being sent out per sequence daily. You're able to see
 * that and change that from the SunBiz software."
 *
 * THE CHART IS THE CAP'S OWN METER, not a report that happens to sit beside the
 * control. So the bars and the cap line are drawn from the same numbers the
 * engine gates on (lead_interactions, not drip_runs — see
 * lib/drips/sequence-volume-core.ts for why that distinction is load-bearing).
 * An operator sets 40, and the bar that reaches 40 is the same 40 the engine
 * counted.
 *
 * Inline SVG bars rather than a chart library: a strict CSP and a dozen
 * sequences of fourteen bars do not justify a dependency, and hand-drawn rects
 * mean the cap line is exactly where the cap is.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Loader2, Infinity as InfinityIcon } from "lucide-react";
import { sequenceRemaining, MAX_SEQUENCE_DAILY_CAP, type SequenceVolume } from "@/lib/drips/sequence-volume-core";
import type { ChannelLimits } from "@/lib/drips/channel-limits-core";
import { ChannelLimitsEditor } from "./ChannelLimitsEditor";

export type VolumeRow = {
  /** Sequence row id, when this volume matched a live sequence. Null means the
   *  sends exist but the sequence they name does not — deleted, or renamed
   *  before its history caught up. Shown, not hidden: mail that went out is
   *  mail that went out. */
  sequenceId: string | null;
  name: string;
  cap: number | null;
  enabled: boolean;
  volume: SequenceVolume | null;
};

function Bars({ volume, cap }: { volume: SequenceVolume | null; cap: number | null }) {
  const days = volume?.days ?? [];
  if (days.length === 0) {
    return <div className="text-[10px] text-fg-dim">no sends in this window</div>;
  }
  // Scale to the taller of the peak and the cap, so a cap ABOVE current volume
  // is still visible as headroom rather than sitting off the top of the chart.
  const ceiling = Math.max(1, volume?.peak ?? 0, cap ?? 0);
  const W = 8;
  const GAP = 3;
  const H = 34;
  const width = days.length * (W + GAP);
  const capY = cap === null ? null : H - (cap / ceiling) * H;

  return (
    // role="img" collapses the SVG to a single node, so a screen reader never
    // descends into the per-bar <title> elements. The whole series therefore
    // has to live in the label, or the chart is simply unavailable rather than
    // merely awkward.
    <svg
      width={width}
      height={H + 2}
      className="overflow-visible"
      role="img"
      aria-label={
        `Daily sends over ${days.length} days` +
        (cap === null ? "" : `, cap ${cap}`) +
        ": " +
        days.map((d) => `${d.day} ${d.count}`).join(", ")
      }
    >
      {days.map((d, i) => {
        const h = ceiling === 0 ? 0 : (d.count / ceiling) * H;
        const over = cap !== null && d.count > cap;
        return (
          <rect
            key={d.day}
            x={i * (W + GAP)}
            // A zero day still draws a 1px stub. A missing bar reads as "no
            // data"; a flat stub reads as "nothing sent", and those are
            // different findings.
            y={H - Math.max(h, d.count === 0 ? 1 : 2)}
            width={W}
            height={Math.max(h, d.count === 0 ? 1 : 2)}
            className={over ? "fill-rose-400" : d.count === 0 ? "fill-bg-border" : "fill-accent"}
          >
            <title>{`${d.day}: ${d.count} email${d.count === 1 ? "" : "s"}`}</title>
          </rect>
        );
      })}
      {/* The cap, drawn where the cap is. A number in a box beside a chart it
          does not appear on is a number nobody checks against the picture. */}
      {capY !== null && (
        <line x1={0} y1={capY} x2={width} y2={capY} className="stroke-amber-400" strokeWidth={1} strokeDasharray="3 2" />
      )}
    </svg>
  );
}

function CapEditor({ row, onSaved }: { row: VolumeRow; onSaved: () => void }) {
  const asText = (c: number | null) => (c === null ? "" : String(c));
  const [value, setValue] = useState(asText(row.cap));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Adopt a cap that changed ON THE SERVER.
  //
  // useState seeds only on mount, and React reuses this instance across a
  // router.refresh() because the row keeps its key and position. So a cap
  // changed by anything other than this box -- another operator, another tab,
  // a direct API call -- left the old number on screen while `dirty` flipped
  // true, presenting a stale value as the operator's own unsaved edit.
  //
  // Keyed on the SERVER value, not on the input, so this never interrupts
  // someone mid-type: it fires only when row.cap itself moves.
  const lastServer = useRef(asText(row.cap));
  useEffect(() => {
    const next = asText(row.cap);
    if (next === lastServer.current) return;
    lastServer.current = next;
    setValue(next);
    setSaved(false);
  }, [row.cap]);

  const dirty = asText(row.cap) !== value.trim();

  async function save() {
    if (!row.sequenceId || busy) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/sequences/${row.sequenceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ daily_email_cap: value.trim() === "" ? null : value.trim() }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; reason?: string } | null;
      if (!res.ok || json?.ok === false) {
        // The server's own words. "Failed" alone is not something an operator
        // can act on.
        setError(json?.reason || json?.error || `save failed (http_${res.status})`);
        return;
      }
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 120) : "network error");
    } finally {
      setBusy(false);
    }
  }

  if (!row.sequenceId) {
    return (
      <span className="text-[10px] text-fg-dim">
        no live sequence to cap
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          min={0}
          max={MAX_SEQUENCE_DAILY_CAP}
          step={1}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
          aria-label={`Daily email cap for ${row.name}`}
          placeholder="none"
          className="w-[72px] rounded-md border border-bg-border bg-bg-elev px-2 py-1 text-xs text-fg outline-none focus:border-accent/60"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-[10px] font-bold text-bg-deep disabled:opacity-30"
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
          Save
        </button>
        {saved && !dirty && <span className="text-[10px] font-bold text-emerald-400">saved</span>}
      </div>
      {/* Say what an empty box MEANS. "No cap" and "cap of zero" are opposite
          instructions and the difference is one character. */}
      <span className="text-[10px] text-fg-dim">
        {value.trim() === "" ? "empty = no cap" : value.trim() === "0" ? "0 = send nothing" : "emails/day"}
      </span>
      {error && (
        <span className="flex items-start gap-1 text-[10px] text-rose-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          {error}
        </span>
      )}
    </div>
  );
}

export function SequenceVolumeView({
  rows,
  days,
  timeZone,
  readError = null,
  truncated = false,
  sms,
  limits,
}: {
  rows: VolumeRow[];
  days: number;
  timeZone: string;
  /** Texts, same shape as email. Adon, 2026-08-17: "make sure your results are
   *  posted on the drips tab for texts and emails so I can keep track of
   *  everything." The chart was email-only, so the channel that had just gone
   *  live with a 40/day ceiling had no meter at all. */
  sms?: { rows: VolumeRow[]; error: string | null; truncated: boolean };
  /** The per-channel ceilings, editable. */
  limits?: ChannelLimits;
  /** Set when the volume READ failed. Must never render as zero volume: an
   *  empty chart is the most reassuring picture available and, when the read
   *  broke, the least true one. */
  readError?: string | null;
  truncated?: boolean;
}) {
  const router = useRouter();

  return (
    <div className="space-y-4">
      {limits && <ChannelLimitsEditor initial={limits} />}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-fg">Email volume per sequence</h3>
        <span className="text-[11px] text-fg-dim">
          Last {days} days, calendar days in {timeZone}. Counted the same way the engine counts when it decides whether
          to send.
        </span>
      </div>

      {readError && (
        <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {readError}. These bars are UNKNOWN, not zero. Do not set a cap from this screen until it reads again — you
            would be choosing a number against a blank chart.
          </span>
        </div>
      )}

      {truncated && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>More sends in this window than the chart reads at once. Every bar is a floor, not a total.</span>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-bg-border">
        <table className="w-full min-w-[720px] text-left text-xs">
          <thead className="bg-bg-elev text-[10px] uppercase tracking-wide text-fg-dim">
            <tr>
              <th className="px-3 py-2">Sequence</th>
              <th className="px-3 py-2">Last {days} days</th>
              <th className="px-3 py-2">Today</th>
              <th className="px-3 py-2">Peak</th>
              <th className="px-3 py-2">Daily cap</th>
              <th className="px-3 py-2">Left today</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const today = row.volume?.today ?? 0;
              const left = sequenceRemaining(today, row.cap);
              const atCap = row.cap !== null && today >= row.cap;
              return (
                <tr key={row.sequenceId || `name:${row.name}`} className="border-t border-bg-border/60 align-middle">
                  <td className="px-3 py-2">
                    <div className="font-semibold text-fg">{row.name}</div>
                    <div className="text-[10px] text-fg-dim">
                      {row.enabled ? "live" : "paused"}
                      {row.sequenceId === null && " · no matching sequence"}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <Bars volume={row.volume} cap={row.cap} />
                  </td>
                  <td className="px-3 py-2">
                    <span className={atCap ? "font-bold text-amber-400" : "text-fg"}>{today}</span>
                  </td>
                  <td className="px-3 py-2 text-fg-dim">{row.volume?.peak ?? 0}</td>
                  <td className="px-3 py-2">
                    <CapEditor row={row} onSaved={() => router.refresh()} />
                  </td>
                  <td className="px-3 py-2">
                    {left === null ? (
                      <span className="inline-flex items-center gap-1 text-fg-dim">
                        <InfinityIcon className="h-3 w-3" /> uncapped
                      </span>
                    ) : (
                      // Zero left is the state worth seeing at a glance: the
                      // sequence is holding until tomorrow, which is the cap
                      // working, not a fault.
                      <span className={left === 0 ? "font-bold text-amber-400" : "text-fg-muted"}>
                        {left === 0 ? "held until tomorrow" : `${left} left`}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-fg-muted">
                  {readError
                    ? "Volume could not be read. This is not the same as no sends."
                    : "No sequences and no drip email in this window."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {sms && (
        <div className="space-y-2 pt-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-bold text-fg">Text volume per sequence</h3>
            <span className="text-[11px] text-fg-dim">
              Same window, same counting. Texts have no per-sequence cap; the ceiling above governs them.
            </span>
          </div>

          {sms.error && (
            <div className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{sms.error}. These bars are UNKNOWN, not zero.</span>
            </div>
          )}
          {sms.truncated && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-400">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>More texts in this window than the chart reads at once. Every bar is a floor.</span>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-bg-border">
            <table className="w-full min-w-[560px] text-left text-xs">
              <thead className="bg-bg-elev text-[10px] uppercase tracking-wide text-fg-dim">
                <tr>
                  <th className="px-3 py-2">Sequence</th>
                  <th className="px-3 py-2">Last {days} days</th>
                  <th className="px-3 py-2">Today</th>
                  <th className="px-3 py-2">Peak</th>
                </tr>
              </thead>
              <tbody>
                {sms.rows.map((r) => (
                  <tr key={`sms-${r.sequenceId ?? r.name}`} className="border-t border-bg-border">
                    <td className="px-3 py-2 font-medium text-fg">{r.name}</td>
                    <td className="px-3 py-2"><Bars volume={r.volume} cap={null} /></td>
                    <td className="px-3 py-2 tabular-nums text-fg">{r.volume?.today ?? 0}</td>
                    <td className="px-3 py-2 tabular-nums text-fg-dim">{r.volume?.peak ?? 0}</td>
                  </tr>
                ))}
                {sms.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-fg-muted">
                      {sms.error
                        ? "Text volume could not be read. This is not the same as no texts."
                        : "No drip texts in this window."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <p className="text-[11px] leading-relaxed text-fg-dim">
        A cap here only ever makes a sequence send <b>less</b>. The brand ceilings still apply above it, and a sequence
        that reaches its cap <b>holds</b> until the next calendar day rather than dropping anyone — nobody is skipped,
        they arrive tomorrow.
      </p>
    </div>
  );
}
