"use client";

/**
 * PhoneTrust — the number, and what we actually know about it.
 *
 * ═══ WHY THIS EXISTS ════════════════════════════════════════════════════════
 *
 * Adon, 2026-08-25: *"We're running into a lot of situations where it's either
 * the wrong phone number for the associated business. That's obviously leading
 * to a lot of confusion, ruining a lot of our sales opportunities."*
 *
 * The audit found the pipeline stamped a hardcoded confidence of 50 on all
 * 31,016 leads, and this UI never read the field at all. So a number nobody had
 * ever checked rendered identically to one that had been. Every number looked
 * equally trustworthy because the screen had no way to say otherwise.
 *
 * ═══ THE RULE THIS COMPONENT EXISTS TO ENFORCE ══════════════════════════════
 *
 * 🚨 A TIER NEVER HIDES A NUMBER. Adon was explicit: *"If you're unsure, you
 * still put the phone number but there's a warning that it might not be the
 * right number."* So the number is ALWAYS rendered at full prominence and
 * always stays dialable. The tier is a label beside it, never a filter, never a
 * dimming, never a disabled button. A rep who wants to try a doubtful number is
 * making a reasonable choice and the screen must not fight them.
 *
 * ═══ WHY NO COLOUR ═════════════════════════════════════════════════════════
 *
 * Every surface in this feature is under a colour ban (tests/web-leads-guards
 * .test.ts) because a red number reads as a verdict about the BUSINESS rather
 * than about our data. That reasoning applies with full force here: a rep who
 * sees red beside a phone number will hear "bad lead", which is not what a
 * shared listing means. State is carried by a WORD and a SHAPE, the same way
 * OpeningHours carries open and closed, which also survives greyscale and
 * colour blindness.
 *
 * ═══ WHY `null` IS NOT `probable` ═══════════════════════════════════════════
 *
 * A lead the backfill has not reached yet has no tier. It renders as unchecked
 * rather than being quietly folded into "probable", because folding it in would
 * reinstate exactly the false reassurance this change was built to remove.
 */

import type { WebLead } from "@/lib/web-leads/data";

type Tier = WebLead["phoneTier"];

/**
 * The mark beside the number. A filled dot for confirmed, a ring for probable,
 * a split ring for a warning, a dash for never checked.
 *
 * Shape carries the meaning so the badge still reads when printed, when
 * greyscale, and to a rep who cannot distinguish the hues this codebase is
 * banned from using anyway.
 */
function TierMark({ tier }: { tier: Tier }) {
  const base = "inline-block h-1.5 w-1.5 shrink-0 rounded-full";
  if (tier === "verified") return <span className={`${base} bg-fg`} aria-hidden />;
  if (tier === "probable") return <span className={`${base} border border-fg-muted`} aria-hidden />;
  if (tier === "warned") {
    return <span className={`${base} border-2 border-dashed border-fg`} aria-hidden />;
  }
  return <span className="inline-block h-px w-2 shrink-0 bg-fg-muted" aria-hidden />;
}

const LABEL: Record<NonNullable<Tier> | "unchecked", string> = {
  verified: "Confirmed on their site",
  probable: "Not confirmed",
  warned: "Check before dialling",
  unchecked: "Not checked yet",
};

export function PhoneTierBadge({ tier, className = "" }: { tier: Tier; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-bg-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-fg-muted ${className}`}
    >
      <TierMark tier={tier} />
      {LABEL[tier ?? "unchecked"]}
    </span>
  );
}

/**
 * The full block: the dialable number, its tier, the extension, the reasons,
 * and any backup numbers.
 *
 * @param compact drops the reasons, for the list view where a rep is scanning
 *   rather than deciding. The badge still shows, because the whole point is that
 *   a doubtful number never looks like a clean one.
 */
export function PhoneTrust({
  lead,
  compact = false,
  dialable = true,
}: {
  lead: Pick<WebLead, "phone" | "phoneTier" | "phoneReasons" | "phoneExt" | "phoneAlternates">;
  compact?: boolean;
  dialable?: boolean;
}) {
  if (!lead.phone) {
    return (
      <p className="text-sm text-fg-muted">
        No phone number was listed for this business.
      </p>
    );
  }

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {dialable ? (
          <a
            href={`tel:${lead.phone.replace(/[^\d+]/g, "")}`}
            className="text-base font-semibold tabular-nums text-fg underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            {lead.phone}
          </a>
        ) : (
          <span className="text-base font-semibold tabular-nums text-fg">{lead.phone}</span>
        )}
        {lead.phoneExt && (
          <span className="text-xs font-medium tabular-nums text-fg-muted">ext. {lead.phoneExt}</span>
        )}
        <PhoneTierBadge tier={lead.phoneTier} />
      </div>

      {!compact && lead.phoneReasons.length > 0 && (
        // Rendered verbatim from lib/phone-quality.js. Nothing here is written
        // per lead, for the same reason the sales copy on this page is not: a
        // sentence a rep reads to a stranger has to be one a human wrote.
        <ul className="mt-2 space-y-1">
          {lead.phoneReasons.map((r) => (
            <li key={r} className="flex gap-2 text-xs leading-relaxed text-fg-muted">
              <span className="mt-1.5 inline-block h-1 w-1 shrink-0 rounded-full bg-fg-muted" aria-hidden />
              {r}
            </li>
          ))}
        </ul>
      )}

      {!compact && lead.phoneAlternates.length > 0 && (
        <p className="mt-2 text-xs text-fg-muted">
          Also listed:{" "}
          {lead.phoneAlternates.map((a, i) => (
            <span key={a}>
              {i > 0 && ", "}
              <a
                href={`tel:${a.replace(/[^\d+]/g, "")}`}
                className="tabular-nums underline-offset-4 hover:underline"
              >
                {a}
              </a>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

export default PhoneTrust;
