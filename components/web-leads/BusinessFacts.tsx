"use client";

/**
 * BusinessFacts — everything the directory recorded about ONE business, in the
 * one place both surfaces read it from.
 *
 * ═══ WHY THIS FILE EXISTS ═══════════════════════════════════════════════════
 *
 * The battle card (components/web-leads/BattleCard.tsx) was built around the
 * website analysis and quietly shipped without the identity block: measured on
 * 2026-08-24, it contained ZERO references to address, postal, osmCategory or
 * territoryName. A rep who opened a lead from their own book landed on a full
 * screen of percentile charts and could not see where the business was. The
 * operator reported it in those words: "When the lead is in their pipeline they
 * can't view the address and they can't view a lot of information. You need to
 * be able to view all of the information that we have in the leads tab."
 *
 * The drawer (components/web-leads/WebLeadDetail.tsx) had the block all along.
 * Two surfaces, one of them right, is the shape a copy-paste fix reproduces --
 * so the block is extracted here and IMPORTED by both rather than written
 * twice. Two copies of a lead's address on two screens is two things that can
 * disagree about the same business while a rep is on the phone.
 *
 * ═══ THE RULES THIS FILE DOES NOT GET TO BREAK ══════════════════════════════
 *
 * 1. `websiteCondition` AND `auditFindings` RENDER VERBATIM. Never shortened,
 *    never re-worded, never a badge, never an icon, never a coloured pill.
 *    These are hedged, unverified strings from a public directory that nobody
 *    on our side has checked. A rep reading a fabricated finding aloud on a
 *    live call is the worst outcome this system can produce, and a badge is
 *    exactly how that nuance gets flattened into a verdict.
 *
 * 2. NO COLOUR IS KEYED TO ANYTHING. Same ban as the battle card and the
 *    comparison panel: tests/web-leads-guards.test.ts lists this file and
 *    forbids the red/green/amber classes outright.
 *
 * 3. A MISSING FIELD SAYS SO IN WORDS. "Not on file" rather than a dash or a
 *    blank: a rep glancing at this mid-call must be able to tell "we do not
 *    have it" apart from "the page did not finish rendering".
 *
 * 4. THE WEBSITE LINK GOES THROUGH preferredSiteUrl AND RENDERS NOTHING WHEN
 *    IT RETURNS NULL. A missing control is honest; a dead one is not. See
 *    lib/web-leads/url-safety.ts for why a bare domain would otherwise
 *    navigate inside our own dashboard and why the scheme allowlist matters.
 */

// `Map as MapIcon` on purpose: lucide exports an icon called `Map`, and
// importing it under that name shadows the global Map constructor for the
// whole module. Nothing here needs a Map today, which is exactly when that
// trap gets set for whoever adds the first one.
import { Building2, ExternalLink, Globe, Map as MapIcon, MapPin, Phone, Tag } from "lucide-react";
import type { WebLead } from "@/lib/web-leads/data";
import { preferredSiteUrl } from "@/lib/web-leads/url-safety";
import { BusinessHoursPanel, CallingWindowNotice, useNow } from "./OpeningHours";

/**
 * The one place the address is assembled, so the drawer and the page can never
 * print a different address for the same business. Joined exactly the way
 * WebLeadDetail has always joined it.
 */
export function fullAddress(lead: WebLead): string | null {
  return [lead.address, lead.city, lead.province, lead.postal].filter(Boolean).join(", ") || null;
}

const LABEL = "text-[10px] font-bold uppercase tracking-[0.12em] text-fg-muted";
const NOT_ON_FILE = "Not on file";

function Fact({
  icon, label, value, span = "", verbatim = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  /**
   * Column-span classes for the two long sentences, or "".
   *
   * A STRING RATHER THAN A `wide` BOOLEAN, deliberately. A boolean would have
   * to hardcode `sm:col-span-2 lg:col-span-3` here, and those classes are
   * wrong in the drawer: applied inside a `grid-cols-1` container, a
   * `col-span-2` item makes the browser create an IMPLICIT second column and
   * the single-column layout collapses. Only the parent knows how many
   * columns it asked for, so only the parent gets to say.
   */
  span?: string;
  /** Italic, plain, uncoloured. The visual treatment for "the directory said
   *  this and nobody checked it" -- deliberately quieter than a measurement,
   *  never louder. */
  verbatim?: boolean;
}) {
  return (
    <div className={`flex gap-3 border-b border-bg-border/60 py-2.5 ${span}`}>
      <div className="mt-0.5 shrink-0 text-fg-dim" aria-hidden>{icon}</div>
      <div className="min-w-0 flex-1">
        <p className={LABEL}>{label}</p>
        <p className={`mt-0.5 break-words text-sm leading-relaxed ${verbatim ? "italic text-fg-dim" : "text-fg"}`}>
          {value || NOT_ON_FILE}
        </p>
      </div>
    </div>
  );
}

/**
 * The website, as text AND as a way out to it.
 *
 * Both halves earn their place. The raw string is what a rep reads to the
 * prospect ("I am looking at joesplumbing.ca right now"); the link is what
 * they click to actually look at it. preferredSiteUrl sends them to the
 * ORIGIN rather than the stale deep path OpenStreetMap happens to store --
 * one in four of those paths 404s, measured 2026-08-24 -- so the text and the
 * link can legitimately differ, and the text is the honest record of what we
 * hold.
 */
function WebsiteFact({ lead }: { lead: WebLead }) {
  const href = preferredSiteUrl(lead.websiteUrl);
  return (
    <div className="flex gap-3 border-b border-bg-border/60 py-2.5">
      <div className="mt-0.5 shrink-0 text-fg-dim" aria-hidden><Globe className="h-4 w-4" /></div>
      <div className="min-w-0 flex-1">
        <p className={LABEL}>Website</p>
        <p className="mt-0.5 break-words text-sm leading-relaxed text-fg">{lead.websiteUrl || NOT_ON_FILE}</p>
        {/* Nothing at all when preferredSiteUrl returns null. rel="noopener
            noreferrer" is a requirement, not a nicety: without it the opened
            page can reach back through window.opener, and these are ~27,000
            sites we do not control. */}
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-bg-border bg-bg-raised px-2.5 py-1.5 text-xs font-semibold text-fg transition-colors hover:border-accent/50 hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
          >
            <ExternalLink className="h-3.5 w-3.5" />View website
          </a>
        )}
      </div>
    </div>
  );
}

/**
 * @param layout "grid" for the full-width battle card, "stack" for the 28rem
 *        drawer. Tailwind breakpoints are viewport-based, not container-based,
 *        so a drawer on a wide screen would take `sm:grid-cols-2` and go
 *        cramped -- the drawer asks for one column explicitly rather than
 *        hoping the breakpoint agrees with it.
 */
export function BusinessFacts({ lead, layout = "stack" }: { lead: WebLead; layout?: "stack" | "grid" }) {
  // Empty in the drawer. See the `span` prop doc on Fact: a col-span inside a
  // one-column grid conjures an implicit second column and breaks the stack.
  const wide = layout === "grid" ? "sm:col-span-2 lg:col-span-3" : "";
  // Read ONCE here and handed down, so every hours-derived statement on this
  // card is computed at one instant. Null until mount -- see useNow.
  const now = useNow();
  return (
    <div
      className={`grid border-t border-bg-border ${layout === "grid" ? "gap-x-8 sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-1"}`}
    >
      {/* Identity and location first. A rep confirms who they are calling
          BEFORE they pitch, which is the whole reason this block sits at the
          top of the card rather than under the charts. */}
      <Fact icon={<MapPin className="h-4 w-4" />} label="Address" value={fullAddress(lead)} />
      <Fact icon={<Phone className="h-4 w-4" />} label="Phone" value={lead.phone} />
      <Fact icon={<Building2 className="h-4 w-4" />} label="Industry" value={lead.industry} />
      <WebsiteFact lead={lead} />
      <Fact icon={<Tag className="h-4 w-4" />} label="Directory category" value={lead.osmCategory} />
      <Fact icon={<MapIcon className="h-4 w-4" />} label="Territory" value={lead.territoryName} />
      {/* WHEN THIS BUSINESS IS OPEN, full width, directly under WHERE they are.
          A rep decides in this order -- who, where, and then whether it is even
          worth dialling right now -- so the hours sit inside the identity block
          rather than below the charts. Full width because it carries a seven-row
          week.

          TWO SEPARATE ROWS, DELIBERATELY. The first is a fact about THEM. The
          second is a rule about US, and it only appears when the rep is
          actually outside the window. They were one block until the operator
          read the legal constant as fabricated data about the prospect: see
          rule 4 in OpeningHours.tsx. Do not merge them back, and do not give
          them a shared heading. */}
      <BusinessHoursPanel lead={lead} now={now} layout={layout} />
      <CallingWindowNotice lead={lead} now={now} layout={layout} />
      {/* VERBATIM. See rule 1 in the module header. Last, and full width,
          because they are sentences rather than fields -- but still inside the
          identity block, never behind a disclosure. */}
      <Fact
        icon={<Globe className="h-4 w-4" />}
        label="Website status, as recorded by the directory, unverified"
        value={lead.websiteCondition}
        span={wide}
        verbatim
      />
      <Fact
        icon={<Tag className="h-4 w-4" />}
        label="Research notes, unverified"
        value={lead.auditFindings}
        span={wide}
        verbatim
      />
    </div>
  );
}
