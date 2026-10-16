/**
 * /forms/publish - Confirm & publish: every offer page's sign-offs on one
 * screen, then Publish.
 *
 * CC 2026-10-16: one screen, no manual video uploads. Six offer pages sat as
 * drafts; publishing them meant six builders, about thirty ticks each, and a
 * video found and attached by hand for every one. This page lists every offer
 * page in the workspace with its name, its public link, its form On/Off,
 * Draft/Live and what still blocks it, and asks for every tick in one pass
 * (components/offer-pages/confirm/ConfirmPublish.tsx).
 *
 * GATE: the builder's own (app/forms/[id]/edit/page.tsx). requireOsRoute
 * ("/forms") is the first statement, so it opens for exactly the viewers whose
 * rail draws Offers and 404s for everyone else; then formsEditRefusal: only an
 * owner or admin of the session's workspace, never in a retired one, gets the
 * screen. Anyone else gets the same sentence the builder shows, and nothing of
 * the pages is read. The workspace is the session's, never the request's.
 *
 * Every write the screen makes goes through the builder's and the Library's
 * existing routes, each of which checks its own gate again.
 */
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { PageFrame } from "@/components/os/PageFrame";
import { requireOsRoute } from "@/components/os/landings/page-gate";
import { ConfirmPublish } from "@/components/offer-pages/confirm/ConfirmPublish";
import { formsEditRefusal } from "@/lib/forms/access";
import { getTenant } from "@/lib/queries";
import { safe } from "@/lib/api-helpers";
import { signMediaUrls } from "@/lib/founders/marketing-queries";
import { offerPagesDb } from "@/lib/offer-pages/store";
import { loadConfirmList, type ConfirmList } from "@/lib/offer-pages/confirm-list";

export const dynamic = "force-dynamic";

const TITLE = "Confirm & publish";

function BackToOffers() {
  return (
    <Link href="/forms" className="btn-secondary inline-flex min-h-11 items-center gap-2 !px-3 text-xs">
      <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
      Back to offers
    </Link>
  );
}

export default async function ConfirmPublishPage() {
  const viewer = await requireOsRoute("/forms");
  const tenantId = viewer.surface.tenantId;
  const refusal = formsEditRefusal({ persona: viewer.surface.persona, tenantId });
  if (refusal) {
    return (
      <PageFrame title={TITLE} subtitle={refusal.message} actions={<BackToOffers />}>
        <Link href="/forms" className="text-sm text-accent hover:text-accent-bright">
          See the offers and their responses
        </Link>
      </PageFrame>
    );
  }

  const tenant = await safe("forms.publish.tenant", getTenant(tenantId), null);
  const db = offerPagesDb();
  let list: ConfirmList | "failed" = { state: "unavailable" };
  if (db) {
    try {
      list = await loadConfirmList(db, { tenantId, tenantSlug: tenant?.slug ?? null, sign: signMediaUrls });
    } catch (err) {
      // The detail is for the log, never the screen.
      console.error("[forms.publish] offer pages unreadable", { tenantId }, err);
      list = "failed";
    }
  }

  return (
    <PageFrame
      title={TITLE}
      subtitle="Every offer page in one place. Tick what is true, watch the proposed video, then publish. Nothing goes live until you press Publish."
      actions={<BackToOffers />}
      className="space-y-6 animate-fade-in"
    >
      {list === "failed" ? (
        <p className="rounded-xl border border-status-warm/40 bg-status-warm/5 p-4 text-sm text-status-warm">
          The offer pages couldn&apos;t load. The error has been logged. Try again in a minute.
        </p>
      ) : list.state === "unavailable" ? (
        <p className="rounded-xl border border-bg-border bg-bg-elev/40 p-4 text-sm text-fg-muted">
          Offer pages aren&apos;t switched on here yet. Try again after the next update.
        </p>
      ) : (
        <ConfirmPublish offers={list.offers} />
      )}
    </PageFrame>
  );
}
