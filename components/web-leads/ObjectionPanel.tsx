/**
 * ObjectionPanel — the eight brush-offs that arrive on every call, regardless
 * of which angle the rep opened with.
 *
 * ═══ WHY IT IS SEPARATE FROM THE ANGLE ══════════════════════════════════════
 *
 * Each angle in lib/web-leads/angles.ts carries ONE objection: the specific
 * push-back that its specific claim invites ("we get plenty of calls" only
 * arrives after the conversion opener). This panel is the other set entirely,
 * the ones that have nothing to do with the site and would arrive if we were
 * selling insurance: no budget, send me an email, call me back, we already have
 * a guy. A rep needs both on screen and needs to be able to tell them apart,
 * because they are answered differently. The angle objection is answered with
 * the measurement. These are answered with the call.
 *
 * ═══ WHY EACH CARD LEADS WITH "WHAT IT USUALLY MEANS" ═══════════════════════
 *
 * Sandler's premise, and the reason a two-column "they say / you say" table is
 * not enough: the stated objection is rarely the real one. "No budget" from an
 * owner who has not yet agreed anything is broken is not a money problem, and a
 * rep who answers it as a money problem wins the argument and loses the call.
 *
 * ═══ WHY EACH CARD ENDS WITH "SO IT DOES NOT COME UP" ═══════════════════════
 *
 * Rackham's 35,000-call study found top performers did not answer objections
 * better than average reps, they received about a third as many, because their
 * sequencing never gave the objection a reason to form. So the prevention line
 * is the one a rep should read between calls, and it is rendered quieter but
 * always visible rather than behind a disclosure -- a `<details>` here is a
 * click nobody makes with a stranger waiting.
 *
 * ═══ THE RULES THIS FILE DOES NOT GET TO BREAK ══════════════════════════════
 *
 * 1. NO COLOUR IS KEYED TO A SCORE, and nothing in here is keyed to anything at
 *    all: this panel renders the same eight cards for every lead and never
 *    touches the audit. Dark tokens only, enforced by the shared colour ban in
 *    tests/web-leads-guards.test.ts, which this file was added to.
 * 2. EVERY WORD IS HAND-WRITTEN, rendered verbatim from the fixed table. This
 *    component holds no copy of its own beyond its headings.
 * 3. The spoken line is visually dominant. `meaning` and `prevent` are coaching
 *    notes and are never said aloud, so they must not be able to be mistaken
 *    for the script at a glance mid-sentence.
 */

import { OBJECTIONS } from "@/lib/web-leads/angles";

export function ObjectionPanel() {
  return (
    <section className="rounded-xl border border-bg-border bg-bg-panel p-5 lg:p-6">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">
        The brush-offs, and what to do with them
      </h2>
      <p className="mt-1 max-w-4xl text-xs leading-relaxed text-fg-dim">
        These arrive on every call whatever the site looks like. The quoted line is what you say. The note underneath
        it is what to have done earlier so it never comes up, which is where the difference between reps actually
        lives.
      </p>

      <ul className="mt-5 grid gap-4 md:grid-cols-2">
        {OBJECTIONS.map((o) => (
          <li key={o.says} className="rounded-lg border border-bg-border bg-bg-raised/60 p-4">
            <p className="text-sm font-semibold text-fg">&ldquo;{o.says}&rdquo;</p>
            <p className="mt-1.5 text-xs italic leading-relaxed text-fg-muted">{o.meaning}</p>
            <p className="mt-3 border-l-2 border-bg-border pl-3 text-sm leading-relaxed text-fg-dim">{o.response}</p>
            <div className="mt-3 border-t border-bg-border pt-2.5">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">So it does not come up</p>
              <p className="mt-1 text-xs leading-relaxed text-fg-muted">{o.prevent}</p>
              {o.source && <p className="mt-1.5 text-[11px] leading-relaxed text-fg-muted/70">Source: {o.source}</p>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default ObjectionPanel;
