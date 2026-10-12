/**
 * components/forms/OffersCardsClient.tsx - lays the Offers section out as
 * cards (R1). FormsListClient still owns the data and every click handler; it
 * hands this component a pre-built view model plus the toggle/actions nodes
 * per offer, and this file decides layout only: the pinned "Start here"
 * router card (the form at slug `vsl`, HANDOVER section 3), then a grid of
 * every other offer, or the empty states when there are none.
 */
import type { ReactNode } from "react";
import { OfferCard, StartHereEmptyCard, type OfferCardViewModel } from "./OfferCard";

export type OfferCardEntry = {
  view: OfferCardViewModel;
  toggle: ReactNode;
  actions: ReactNode;
};

export function OffersCardsGrid({
  cards,
  canEdit,
  offersEnabled,
  onCreateRouter,
}: {
  cards: OfferCardEntry[];
  canEdit: boolean;
  /** false when offer pages aren't switched on in this workspace yet (same gate New offer uses). */
  offersEnabled: boolean;
  onCreateRouter: () => void;
}) {
  const routerIndex = cards.findIndex((c) => c.view.slug === "vsl");
  const router = routerIndex >= 0 ? cards[routerIndex] : null;
  const rest = router ? cards.filter((_, i) => i !== routerIndex) : cards;

  return (
    <div className="space-y-4">
      {router ? (
        <OfferCard offer={router.view} pinned toggle={router.toggle} actions={router.actions} />
      ) : (
        <StartHereEmptyCard canEdit={canEdit && offersEnabled} onCreate={onCreateRouter} />
      )}

      {rest.length === 0 ? (
        <div className="rounded-xl border border-bg-border bg-bg-elev/40 p-6 text-sm text-fg-muted">
          {!offersEnabled
            ? "Offers aren't switched on in this workspace yet. Your forms keep working as they are."
            : canEdit
              ? "No offers yet. New offer builds a full page around a form: a video, what people get, your proof, and the form to book."
              : "No offers yet."}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rest.map((c) => (
            <OfferCard key={c.view.id} offer={c.view} toggle={c.toggle} actions={c.actions} />
          ))}
        </div>
      )}
    </div>
  );
}
