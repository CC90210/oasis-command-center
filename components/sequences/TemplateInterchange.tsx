"use client";

/**
 * TemplateInterchange — swap the approved template behind one step.
 *
 * WHY IT GOES THROUGH THE EXISTING PATCH. It writes the chosen template's
 * subject and body onto the step and saves via PATCH /api/sequences/[id], which
 * already validates with parseDripSteps, runs guardSequenceSteps, and versions
 * the prior steps. A dedicated write route would have skipped all three — the
 * guard exists precisely to stop an edit that strips required copy, and this is
 * the last human checkpoint before merchants receive it.
 *
 * PREVIEW BEFORE APPLY, ALWAYS. This changes live merchant mail with no further
 * review, so an operator sees current and candidate side by side and presses
 * Apply deliberately. Nothing swaps on selection alone.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Check, Loader2, AlertTriangle } from "lucide-react";
import { selectableTemplates, effectiveRole } from "@/lib/drips/template-interchange";
import type { PoolTemplate } from "@/lib/drips/template-pool";
import type { BrandKey } from "@/lib/email/brands";
import type { DripStep } from "@/lib/drips/types";

export function TemplateInterchange({
  sequenceId,
  stepIndex,
  step,
  steps,
  brand,
  stage,
  pool,
}: {
  sequenceId: string;
  stepIndex: number;
  step: DripStep;
  steps: DripStep[];
  brand: BrandKey;
  stage: string;
  pool: PoolTemplate[];
}) {
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const router = useRouter();

  // Scope by the step's ROLE as well as brand and stage. The executor narrows
  // the pool with poolFor(brand, stage, role) before it resolves the pin, so a
  // template from another role is invisible at send time — offering it would
  // save cleanly, report success, and change nothing. Same default the executor
  // uses for an unset role.
  const role = effectiveRole(step.role);
  const options = useMemo(
    () => selectableTemplates(pool, { brand, stage, role }),
    [pool, brand, stage, role],
  );
  const candidate = options.find((t) => t.id === choice) || null;

  // Nothing approved for this brand, stage and role means there is nothing to
  // interchange. Say that rather than rendering an empty dropdown that looks
  // broken.
  if (options.length === 0) {
    return (
      <p className="mt-2 text-[10px] text-fg-dim">
        No approved <b>{role}</b> templates for {brand === "bluerise" ? "Bluerise" : "SunBiz"} · {stage}. Approve copy in
        the template pool before it can be swapped in here. Rotation only ever substitutes within one role, so an opener
        never stands in for a last call.
      </p>
    );
  }

  async function apply() {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      // Replace only THIS step; every other step is sent back unchanged so the
      // PATCH cannot silently drop a sibling.
      const next = steps.map((s, i) => {
        if (i !== stepIndex) return s;
        // Strip body_html rather than carrying it over. It belongs to the
        // PREVIOUS template, and leaving it would send HTML-capable recipients
        // the old copy while the plain-text fallback carried the new one.
        const { body_html: _dropped, ...rest } = s as typeof s & { body_html?: string };
        return {
          ...rest,
          ...(s.channel === "email" && candidate.subject ? { subject: candidate.subject } : {}),
          body: candidate.bodyText,
          // The PIN is what actually changes what merchants receive. Copying the
          // text alone is a no-op whenever an approved pool exists, because
          // resolveCopy samples the pool before it ever reads the step body —
          // the swap would report success and change nothing.
          template_id: candidate.id,
        };
      });
      const res = await fetch(`/api/sequences/${sequenceId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        // Just the steps. The server derives the swap from the pins it is about
        // to persist and validates and audits from those, so a separate
        // "here is what I'm doing" field would be a second story it has no
        // reason to believe.
        body: JSON.stringify({ steps: next }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; reason?: string } | null;
      if (!res.ok || json?.ok === false) {
        // Surface the guard's own words. A rejected edit that says only
        // "failed" is one an operator cannot act on.
        setError(json?.reason || json?.error || `save failed (http_${res.status})`);
        return;
      }
      setDone(true);
      setOpen(false);
      // Re-render the server component so `steps` is the PERSISTED array again.
      //
      // Without this, a second swap in the same session silently reverts the
      // first: every TemplateInterchange on the page builds its PATCH from the
      // same server-rendered `steps` snapshot and sends the WHOLE array, so
      // step 2's save rewrites step 1 back to the copy it had before the page
      // loaded. The audit then records that revert as a deliberate unpin by the
      // operator. A note telling them to reload is not a fix; nothing enforced
      // it.
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message.slice(0, 140) : "network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 border-t border-bg-border/60 pt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold text-fg-muted hover:text-accent"
      >
        <ArrowLeftRight className="h-3 w-3" />
        Interchange template
        <span className="font-normal text-fg-dim">({options.length} approved)</span>
      </button>

      {done && (
        <span className="ml-2 inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400">
          <Check className="h-3 w-3" /> swapped
        </span>
      )}

      {/* A pin the engine can no longer reach — the template was retired, or the
          step's role was changed after the swap — stops applying SILENTLY: the
          step keeps showing the pinned copy while sampling decides what actually
          goes out. Saying so is the whole point of this tab. */}
      {step.template_id && !options.some((t) => t.id === step.template_id) && (
        <div className="mt-2 flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-400">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>
            This step is pinned to a template that is no longer approved for {brand === "bluerise" ? "Bluerise" : "SunBiz"}{" "}
            · {stage} · {role}, so the engine is ignoring the pin and sampling the pool instead. Pick a template below to
            make the copy shown here the copy that sends.
          </span>
        </div>
      )}

      {open && (
        <div className="mt-2 space-y-2 rounded-md border border-bg-border bg-bg-deep/40 p-2">
          <select
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            className="w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-xs text-fg"
          >
            <option value="">Choose an approved template…</option>
            {options.map((t) => (
              <option key={t.id} value={t.id}>
                {t.role} · {(t.subject || t.bodyText).slice(0, 60)}
              </option>
            ))}
          </select>

          {candidate && (
            <div className="grid gap-2 md:grid-cols-2">
              <div className="rounded border border-bg-border bg-bg-elev/40 p-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-fg-dim">Current</div>
                {step.channel === "email" && (
                  <div className="mt-1 text-[11px] font-semibold text-fg">{step.subject || "(no subject)"}</div>
                )}
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-fg-muted">
                  {step.body}
                </pre>
              </div>
              <div className="rounded border border-accent/40 bg-accent/5 p-2">
                <div className="text-[10px] font-bold uppercase tracking-wide text-accent">Candidate</div>
                {step.channel === "email" && (
                  <div className="mt-1 text-[11px] font-semibold text-fg">{candidate.subject || "(no subject)"}</div>
                )}
                <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[10px] leading-relaxed text-fg-muted">
                  {candidate.bodyText}
                </pre>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-1.5 rounded border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!candidate || busy}
              onClick={apply}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[11px] font-bold text-bg-deep disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Apply to step {stepIndex + 1}
            </button>
            <span className="text-[10px] text-fg-dim">
              This changes what merchants receive. The edit is versioned and attributed.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
