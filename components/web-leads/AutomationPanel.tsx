"use client";

/**
 * AutomationPanel — what else we can build for this business, in the words a
 * rep can say without understanding automation.
 *
 * ═══ WHY IT SITS BELOW THE OBJECTIONS ═══════════════════════════════════════
 *
 * Adon described the moment this exists for precisely: *"Okay maybe you don't
 * want the website, but we have a variety of automations that can help your
 * website, such as X, Y and Z."* That is a rep saving a call the website pitch
 * is losing, which is why the panel renders after the angle, after the
 * evidence and after the brush-offs. Moving it up the page turns a save into
 * an opener, and the upsell ladder (OASIS_UNDENIABLE_OFFER_STRATEGY.md §5) is
 * explicit that the first automation sale belongs at month three, after two
 * evidence reports have landed. tests/web-leads-automations.test.ts pins the
 * ordering so a later layout tidy-up cannot quietly promote it.
 *
 * ═══ WHY TWO GROUPS AND NOT ONE LIST ════════════════════════════════════════
 *
 * A rep given twelve equal-looking cards will pitch the biggest one, and the
 * biggest one here is the front desk, which touches bookings and customer
 * records. That is the exact ask that gets AI shops refused on data custody
 * (§3), and it is a month six conversation, not a month zero one. So the panel
 * splits: what attaches to the website we are already selling, and what
 * becomes possible once that is running. A rep can read which half is safe
 * today off the headings, without a per-card label to misread mid-sentence.
 *
 * ═══ THE RULES THIS FILE DOES NOT GET TO BREAK ══════════════════════════════
 *
 * 1. NO COLOUR IS KEYED TO ANYTHING. Same ban as every other surface in this
 *    feature, enforced in tests/web-leads-guards.test.ts. The "not on their
 *    site" marker is carried by a WORD and a SHAPE, never by red or green --
 *    a tinted card teaches the eye that colour is a verdict on this screen,
 *    and the next person tints a score.
 * 2. EVERY WORD IS HAND-WRITTEN, rendered verbatim out of
 *    lib/web-leads/automations.ts. This component holds no sales copy of its
 *    own beyond its headings.
 * 3. NO PRICE, EVER. Not here, not in the table. Adon signs off before a rep
 *    says a number out loud, and no web-dev price exists in this codebase yet.
 * 4. NOTHING IS MARKED MISSING UNLESS WE MEASURED IT. `missingHere` is only
 *    ever true off a scored audit; the three non-scored states mark nothing.
 */

import type { AuditResult } from "@/lib/web-leads/audit";
import { selectAutomations, type SelectedAutomation } from "@/lib/web-leads/automations";

/**
 * One automation, as a rep reads it mid-call.
 *
 * The four lines are ordered by what a rep needs first: the spoken line is
 * visually dominant because it is the only part said out loud, `gets` sits
 * under it as the thing being bought, `why` is the coaching note that makes it
 * land for this trade, and the brush-off it answers is quietest because it is
 * read between calls rather than during one.
 *
 * The absence marker is the only thing here derived from data, and it is drawn
 * with a word and a hollow ring rather than a colour -- see rule 1 in the file
 * header.
 */
function Card({ item }: { item: SelectedAutomation }) {
  return (
    <li className="rounded-lg border border-bg-border bg-bg-raised/60 p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-semibold leading-relaxed text-fg">{item.says}</p>
        {item.missingHere && (
          // Shape and words, never colour. A hollow ring reads as "absent"
          // in greyscale and to a colour-blind rep, which a tint does not.
          <span className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-bg-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted">
            <span className="h-1.5 w-1.5 rounded-full border border-fg-muted" aria-hidden />
            Not on their site
          </span>
        )}
      </div>

      <p className="mt-2 border-l-2 border-bg-border pl-3 text-xs leading-relaxed text-fg-dim">{item.gets}</p>

      <div className="mt-3 border-t border-bg-border pt-2.5">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Why it lands here</p>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">{item.why}</p>
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-fg-muted/70">
        Answers: &ldquo;{item.answers}&rdquo;
      </p>
    </li>
  );
}

/**
 * The whole panel: what else we can build for this business, in two groups.
 *
 * Takes the lead's raw `industry` string and the audit, and does no selection
 * of its own -- `selectAutomations` owns which cards apply, which are cleared
 * to render, and what order they go in. That split matters because the
 * ordering rule is the only per-lead behaviour in the feature and it is
 * separately tested; a component that re-sorted here would be a second opinion
 * about the same lead.
 *
 * Renders for EVERY audit state. A lead with no website found still gets the
 * full panel, with nothing marked missing, because that is the lead most likely
 * to need it.
 *
 * @param industry the lead's industry as stored, free text, may be null
 * @param audit the 49-check result, scored or not
 */
export function AutomationPanel({ industry, audit }: { industry: string | null; audit: AuditResult }) {
  const { industryLabel, isFallback, attached, later } = selectAutomations(industry, audit);

  return (
    <section className="rounded-xl border border-bg-border bg-bg-panel p-5 lg:p-6">
      <h2 className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted">
        If the website is not the thing they want
      </h2>
      <p className="mt-1 max-w-4xl text-xs leading-relaxed text-fg-dim">
        {isFallback ? (
          <>
            We have not written a set for this business&rsquo;s category yet, so these are the ones that work almost
            anywhere. The line in bold is what you say. The note under it is why it lands, which is the part worth
            reading before you dial.
          </>
        ) : (
          <>
            What else we can build for a business like this one, written for {industryLabel.toLowerCase()}. The line in
            bold is what you say. The note under it is why it lands for this trade specifically, which is the part
            worth reading before you dial.
          </>
        )}
      </p>

      <div className="mt-5">
        <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">
          Attaches to the site we are building
        </p>
        <p className="mt-1 text-xs text-fg-dim">
          Part of the same conversation and the same build. Anything marked is something their current site does not
          do, measured on the crawl above.
        </p>
        <ul className="mt-4 grid gap-4 md:grid-cols-2">
          {attached.map((item) => (
            <Card key={item.id} item={item} />
          ))}
        </ul>
      </div>

      {later.length > 0 && (
        <div className="mt-7 border-t border-bg-border pt-5">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-fg-muted">Once that is running</p>
          {/* The honest boundary, stated to the rep rather than left implied.
              These touch bookings and customer records, which is the ask that
              gets refused on data custody when it arrives too early. */}
          <p className="mt-1 text-xs text-fg-dim">
            Not a first-call offer. These come up once the site is live and they have seen it working, so use them to
            answer what else do you do, not to open a second pitch.
          </p>
          <ul className="mt-4 grid gap-4 md:grid-cols-2">
            {later.map((item) => (
              <Card key={item.id} item={item} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default AutomationPanel;
