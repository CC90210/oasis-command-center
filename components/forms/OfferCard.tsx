/**
 * components/forms/OfferCard.tsx - the Offers screen restructure (R1,
 * HANDOVER section 3: "they literally look the exact same" as the intake
 * forms table). One card per offer: name, one-line promise, page status, VSL
 * status, a 7-day funnel strip, and whatever action nodes the caller built
 * (Edit / Preview / Copy link / Share / the On-Off switch) — FormsListClient
 * still owns every click handler; this file only lays the result out as a
 * card instead of a table row.
 *
 * Intake forms are NOT built from this file: they stay a plain table
 * (FormsListClient's own markup), visibly secondary, exactly as section 3
 * asks.
 */
import type { ReactNode } from "react";
import { Plus } from "lucide-react";
import { Tag } from "@/components/Card";
import { FUNNEL_METRICS, funnelCell } from "@/lib/offers/funnel-strip";

export type OfferPageStatus = "live" | "live_with_changes" | "draft";

export type OfferCardViewModel = {
  id: string;
  name: string;
  slug: string;
  headline: string | null;
  subheadline: string | null;
  hasVideo: boolean;
  status: OfferPageStatus;
  publishedVersion: number;
  /** New leads in the last 7 days. null = could not be read (shown "-", never 0). */
  leads: number | null;
};

/** "Live, version N" / "Live + unpublished changes" / "Draft page (not live)". */
export function offerPageLabel(status: OfferPageStatus, publishedVersion: number): string {
  if (status === "live") return publishedVersion > 0 ? `Live, version ${publishedVersion}` : "Live";
  if (status === "live_with_changes") return "Live + unpublished changes";
  return "Draft page (not live)";
}

function statusTone(status: OfferPageStatus): "engaged" | "warm" | "neutral" {
  if (status === "live") return "engaged";
  if (status === "live_with_changes") return "warm";
  return "neutral";
}

/** The card's one-line promise: the hero headline, else the subheadline, else an honest placeholder - never invented. */
function promiseOf(offer: Pick<OfferCardViewModel, "headline" | "subheadline">): string {
  return offer.headline || offer.subheadline || "No headline written yet.";
}

function FunnelStrip({ leads }: { leads: number | null }) {
  return (
    <div>
      <div className="mb-1.5 text-[9.5px] font-semibold uppercase tracking-wider text-fg-dim">Last 7 days</div>
      <dl className="grid grid-cols-5 gap-1.5 rounded-lg border border-hairline bg-bg-elev/40 p-2">
        {FUNNEL_METRICS.map((m) => {
          const value = m.key === "leads" ? leads : null;
          const cell = funnelCell(value);
          return (
            <div key={m.key} className="flex flex-col items-center gap-0.5 text-center">
              <dt className="text-[9px] leading-tight uppercase tracking-wide text-fg-dim">{m.label}</dt>
              <dd
                className="text-sm font-semibold tabular-nums text-fg"
                {...(cell.ariaLabel ? { "aria-label": `${m.label}: ${cell.ariaLabel}` } : {})}
              >
                {cell.text}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/**
 * One offer, as a card. `pinned` marks the "Start here" router card (the
 * `/vsl` form): it draws the same card with an eyebrow instead of a second
 * component, so router and offer never drift apart visually.
 */
export function OfferCard({
  offer,
  pinned = false,
  toggle,
  actions,
}: {
  offer: OfferCardViewModel;
  pinned?: boolean;
  toggle: ReactNode;
  actions: ReactNode;
}) {
  return (
    <article
      className="flex flex-col gap-4 rounded-xl border border-hairline bg-bg-panel p-5 transition-colors duration-150 hover:border-bg-border-strong"
      aria-label={pinned ? `Start here: ${offer.name}` : `Offer: ${offer.name}`}
    >
      {pinned && <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-accent">Start here</div>}
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-bold text-fg" title={offer.name}>
            {offer.name}
          </h3>
          <p className="mt-1 text-sm leading-snug text-fg-muted">{promiseOf(offer)}</p>
        </div>
        {toggle}
      </header>
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={statusTone(offer.status)}>{offerPageLabel(offer.status, offer.publishedVersion)}</Tag>
        <Tag tone={offer.hasVideo ? "accent" : "neutral"}>{offer.hasVideo ? "Video attached" : "No video attached"}</Tag>
      </div>
      <FunnelStrip leads={offer.leads} />
      <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3 text-xs">{actions}</div>
    </article>
  );
}

/**
 * No `/vsl` form exists yet: a quiet placeholder, never a button that cannot
 * work. `onCreate` opens the same New offer picker the primary action does.
 */
export function StartHereEmptyCard({ canEdit, onCreate }: { canEdit: boolean; onCreate: () => void }) {
  return (
    <article className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-hairline bg-bg-elev/30 p-5">
      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-fg-dim">Start here</div>
      <p className="text-sm text-fg-muted">
        No start-here page yet. This is the page a new visitor sees first, before they land on one of your offers.
      </p>
      {canEdit && (
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex items-center gap-2 rounded-lg border border-bg-border px-3 py-1.5 text-xs font-semibold text-fg-muted hover:text-fg hover:border-bg-border-strong"
        >
          <Plus className="w-3.5 h-3.5" />
          Create
        </button>
      )}
    </article>
  );
}
