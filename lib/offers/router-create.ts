/**
 * lib/offers/router-create.ts - the "Start here" router card's Create action
 * (R1, Codex review on PR #596) opens the same New offer picker, but it must
 * land on a form at slug EXACTLY "vsl" - that is the one slug
 * OffersCardsGrid recognises as the router (components/forms/OffersCardsClient.tsx).
 * The ordinary picker derives its slug from the typed name, which almost
 * never spells "vsl", so completing it created another regular offer and
 * left the empty state showing.
 *
 * These two pure functions are the whole fix, pulled out so the rule is
 * tested without a browser: router mode always submits the fixed slug,
 * never the typed one, and names the one failure mode (the slug is already
 * someone's form) in words a router-builder will understand.
 */

export const ROUTER_SLUG = "vsl";

/** The slug New offer actually submits: fixed for the router, the typed/derived one otherwise. */
export function offerCreateSlug(routerMode: boolean, typedSlug: string): string {
  return routerMode ? ROUTER_SLUG : typedSlug;
}

/** What to say when the server reports the slug is taken - the router names what "taken" means for it specifically. */
export function slugTakenMessage(routerMode: boolean): string {
  return routerMode
    ? `A form already uses the link name "${ROUTER_SLUG}". If it already carries a page, refresh - it may already be your start-here page; otherwise open it and turn it into one.`
    : "That link name is taken in this workspace. Pick another.";
}
