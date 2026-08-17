"use client";

/**
 * ChannelLimitsEditor — the volume dials, in the software.
 *
 * Adon, 2026-08-17: "those tabs are actually functional where if I want to
 * increase or decrease the volume, I will be able to use the rest of the
 * software."
 *
 * These four numbers used to be env vars, so changing one was a redeploy and
 * therefore a request to me. The per-sequence email cap below was already
 * editable; these are the per-CHANNEL ceilings that actually gate the day.
 *
 * The form does NOT own the rules. Ceilings, whole-number and
 * zero-means-stopped all live in channel-limits-core and are re-checked
 * server-side, because validation that only runs in a browser is not
 * validation. What the form owns is telling the operator the ceiling BEFORE
 * they type past it, and never silently rounding a rejected value into a
 * different one.
 */

import { useState } from "react";
import { AlertTriangle, Check, Loader2 } from "lucide-react";
import {
  LIMIT_KEYS, LIMIT_LABEL, LIMIT_MAX,
  validateLimit, type ChannelLimits, type LimitKey,
} from "@/lib/drips/channel-limits-core";

const HELP: Record<LimitKey, string> = {
  smsDaily: "Across every text sequence. Spread through the day, never sent at once.",
  smsHourly: "The drip, not the total. Stops a day's worth landing in five minutes.",
  emailDailySunbiz: "The established domain. Months of sending history behind it.",
  emailDailyBluerise: "Cold domain, started 14 Aug. Deliberately lower until it has a reputation.",
};

export function ChannelLimitsEditor({ initial }: { initial: ChannelLimits }) {
  // Held as STRINGS. A number input bound to a number cannot represent "the
  // operator has cleared the box", and an empty box read as 0 would silently
  // stop the channel while looking deliberate.
  const [draft, setDraft] = useState<Record<LimitKey, string>>(
    () => Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(initial[k])])) as Record<LimitKey, string>,
  );
  const [saved, setSaved] = useState<ChannelLimits>(initial);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<LimitKey, string>>>({});
  const [fault, setFault] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  const dirty = LIMIT_KEYS.some((k) => draft[k] !== String(saved[k]));

  async function save() {
    setFault(null);
    setOk(false);

    // Validate with the SAME function the server uses, so the inline message
    // and the rejection can never disagree.
    const next: Partial<Record<LimitKey, string>> = {};
    const patch: Record<string, number> = {};
    for (const k of LIMIT_KEYS) {
      if (draft[k] === String(saved[k])) continue;
      const v = validateLimit(k, draft[k]);
      if (v.ok) patch[k] = v.value;
      else next[k] = v.reason;
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    if (Object.keys(patch).length === 0) return;

    setBusy(true);
    try {
      const r = await fetch("/api/drips/limits", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = (await r.json()) as {
        ok?: boolean;
        limits?: ChannelLimits;
        error?: string;
        problems?: Array<{ key: LimitKey; reason: string }>;
      };
      if (!r.ok || !j.ok) {
        // A server-side rejection is rendered on the field, not as a toast:
        // the operator needs to see WHICH number it refused.
        if (j.problems?.length) {
          setErrors(Object.fromEntries(j.problems.map((p) => [p.key, p.reason])));
        } else {
          setFault(j.error || "could not save");
        }
        return;
      }
      // Re-seed from what the SERVER stored, not from the draft. If it clamped
      // a value, the box must show the clamped number rather than the one that
      // was typed — otherwise the screen disagrees with the engine.
      const applied = j.limits ?? saved;
      setSaved(applied);
      setDraft(Object.fromEntries(LIMIT_KEYS.map((k) => [k, String(applied[k])])) as Record<LimitKey, string>);
      setOk(true);
    } catch (e) {
      setFault(e instanceof Error ? e.message : "could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-bg-border p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-bold text-fg">How much goes out</h3>
        <span className="text-[11px] text-fg-dim">Applies across every sequence. Takes effect on the next run.</span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {LIMIT_KEYS.map((k) => {
          const err = errors[k];
          return (
            <label key={k} className="block">
              <span className="text-xs font-medium text-fg">{LIMIT_LABEL[k]}</span>
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={LIMIT_MAX[k]}
                value={draft[k]}
                disabled={busy}
                onChange={(e) => {
                  setDraft((d) => ({ ...d, [k]: e.target.value }));
                  setOk(false);
                  setErrors((x) => ({ ...x, [k]: undefined }));
                }}
                aria-invalid={Boolean(err)}
                aria-describedby={`${k}-help`}
                className={`mt-1 w-full rounded-md border bg-bg-elev px-2 py-1.5 text-sm text-fg ${
                  err ? "border-rose-500/60" : "border-bg-border"
                }`}
              />
              <span id={`${k}-help`} className="mt-1 block text-[11px] leading-snug text-fg-dim">
                {err ? <span className="text-rose-400">{err}</span> : HELP[k]}
                {!err && <> Max {LIMIT_MAX[k]}. 0 stops it.</>}
              </span>
            </label>
          );
        })}
      </div>

      {fault && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{fault}. Nothing was changed.</span>
        </div>
      )}

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={save}
          disabled={busy || !dirty}
          className="inline-flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-xs font-semibold text-bg disabled:opacity-40"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {busy ? "Saving" : "Save"}
        </button>
        {ok && !dirty && (
          <span className="inline-flex items-center gap-1 text-xs text-emerald-400">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        {dirty && !busy && <span className="text-[11px] text-fg-dim">Unsaved changes</span>}
      </div>
    </div>
  );
}
