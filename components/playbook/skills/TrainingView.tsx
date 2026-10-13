"use client";
/**
 * Training (JARVIS plan 3, spec section 6): only what needs Adon. Misses first (detected nightly
 * from plan 4 on; until then "not checked yet", never "0 misses"), then held changes, changes that
 * did not go live, what is queued for tonight, and what went live this week.
 */
import type { ReactNode } from "react";
import { shortDate, training, type ChangeRow, type Computer, type Library } from "@/lib/skills/view";
import { HeldChange } from "./HeldChange";
import { Btn } from "./ui";

function Section({ id, title, count, countLabel, children }: { id: string; title: string; count?: number; countLabel?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h3 id={id} className="flex items-center gap-2 text-sm font-semibold text-fg">
        {title}
        {count !== undefined && count > 0 && (
          <span className="rounded-full bg-unread px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white">
            {count}
            {/* Fix round 1 (task 9) #8: the number alone ("1") reads as a bare digit to a screen
                reader with no context for what it counts - the visible badge stays just the
                number, legible at a glance, and this hidden span carries the rest. */}
            {countLabel && <span className="sr-only"> {countLabel}</span>}
          </span>
        )}
      </h3>
      {children}
    </section>
  );
}

const Row = ({ c, note }: { c: ChangeRow; note?: string }) => (
  <li className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 py-3">
    <span className="min-w-0 text-sm text-fg">{c.description}</span>
    <span className="text-xs tabular-nums text-fg-dim">{shortDate(c.updated_at)}</span>
    {note && <span className="w-full text-xs text-fg-muted">{note}</span>}
  </li>
);

export function TrainingView({ lib, computer, changes, nowIso, proofReady = false, rebuildBusy, onDone, onRebuild }: {
  lib: Library; computer: Computer; changes: ChangeRow[]; nowIso: string; proofReady?: boolean; rebuildBusy: boolean;
  onDone: (message: string) => void; onRebuild: () => void;
}) {
  const l = training(changes, computer.id, new Date(nowIso));
  const rebuildDisabled = rebuildBusy || computer.rebuild_requested || computer.revoked;
  const rebuildReasonId = `rebuild-reason-${computer.id}`;
  // Fix round 1 (task 9) #6: revoked gets its own sentence, never "or now if you ask" - asking is
  // not actually possible once this computer's access is revoked.
  const rebuildReason = computer.revoked
    ? "This computer's access was revoked, so no check can run here."
    : computer.rebuild_requested
      ? "Your PC picks it up within 5 minutes."
      : l.waiting.length
        ? `${l.waiting.length} waiting. Your PC checks them tonight, or now if you ask.`
        : "Nothing waiting.";
  return (
    <div className="space-y-8">
      <Section id="skills-misses" title="Misses to fix">
        <p className="rounded-xl border border-hairline bg-bg-panel px-4 py-4 text-sm text-fg-muted">
          Misses are not checked yet. The nightly miss check is the next part of this build, so an empty list here does not mean zero misses.
        </p>
      </Section>

      <Section id="skills-held" title="Held for you" count={l.held.length} countLabel="waiting for you">
        {l.held.length === 0 ? (
          <p className="text-sm text-fg-muted">Nothing is held. Every change passed its check.</p>
        ) : (
          <div className="space-y-3">
            {l.held.map((c) => (
              <HeldChange key={c.change_id} change={c} lib={lib} computerId={computer.id} computerName={computer.display_name} proofReady={proofReady} onDone={onDone} />
            ))}
          </div>
        )}
      </Section>

      {l.failed.length > 0 && (
        <Section id="skills-failed" title="Did not go live" count={l.failed.length}>
          <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
            {l.failed.map((c) => <Row key={c.change_id} c={c} note={c.reason} />)}
          </ul>
        </Section>
      )}

      <Section id="skills-queued" title="Queued for tonight's check">
        {l.waiting.length > 0 && (
          <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
            {l.waiting.map((c) => <Row key={c.change_id} c={c} />)}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Btn onClick={onRebuild} disabled={rebuildDisabled} aria-describedby={rebuildDisabled ? rebuildReasonId : undefined}>
            {computer.revoked ? "Access revoked" : computer.rebuild_requested ? "Check requested" : rebuildBusy ? "Asking your PC." : "Run the check now"}
          </Btn>
          <p id={rebuildReasonId} className="text-xs text-fg-dim">{rebuildReason}</p>
        </div>
      </Section>

      <Section id="skills-applied" title="Applied this week">
        {l.applied.length === 0 ? <p className="text-sm text-fg-muted">Nothing went live this week.</p> : (
          <ul className="divide-y divide-hairline rounded-xl border border-hairline bg-bg-panel">
            {l.applied.map((c) => <Row key={c.change_id} c={c} />)}
          </ul>
        )}
      </Section>
    </div>
  );
}
