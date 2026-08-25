/**
 * A rep's filters survive leaving the Leads page.
 *
 * Adon, 2026-08-25: "when a rep is on the Leads page and they search for the
 * leads because they are trying to assign themselves to leads... once they
 * click on a lead from those filters or go on the battle card or whatever or
 * click off anything that is not directly on that page, when they go back, they
 * lose their filters. They have to re-click and re-find the leads. We have to
 * add functionality where once you click the filters until you un-click the
 * filters, it's going to stay on that filter no matter where you go."
 *
 * Filters live in the URL, which makes them exact and shareable and also makes
 * them die the moment a rep opens a battle card or any sidebar tab. A rep
 * claiming fifty Toronto salons re-picked province, city and industry after
 * every single lead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { memorableQuery, hasNoFilters, FILTER_MEMORY_KEY } from "../lib/web-leads/filter-memory";
import { parseFilters } from "../lib/web-leads/filters";

const read = (p: string) => readFileSync(p, "utf8");

// ---------------------------------------------------------------------------
// 1. WHAT IS REMEMBERED: the filters, and only the filters.
// ---------------------------------------------------------------------------
// The param names are the ones lib/web-leads/filters.ts actually uses -- `prov`,
// `city`, `ind` -- read off that module rather than invented here. A test that
// asserts a vocabulary the code does not use passes on a broken feature.
{
  const q = memorableQuery("prov=ON&city=Toronto&ind=Salons%20%26%20Spas&band=under40");
  const sp = new URLSearchParams(q);
  assert.equal(sp.get("prov"), "ON", "province must be remembered");
  assert.equal(sp.get("city"), "Toronto", "city must be remembered");
  assert.equal(sp.get("band"), "under40", "the score band must be remembered");
  // The round trip is what matters, not the exact encoding: industries carry
  // ampersands and spaces ("Salons & Spas", "Restaurants & Bars"), and the list
  // encoder comma-joins URI-encoded values. Re-parsing proves it survives.
  const back = parseFilters(new URLSearchParams(q));
  assert.deepEqual(back.industries, ["Salons & Spas"], "an industry must survive its ampersand intact");
  assert.deepEqual(back.provinces, ["ON"]);
  assert.deepEqual(back.cities, ["Toronto"]);
}

// A search a rep typed is part of "the filters they clicked" -- it is how they
// found the leads in the first place.
assert.match(memorableQuery("q=dentist"), /q=dentist/, "the search box must be remembered");

// The view too: a rep working My Leads should come back to My Leads.
assert.match(memorableQuery("view=mine"), /view=mine/, "the active view must be remembered");

// ---------------------------------------------------------------------------
// 2. WHAT IS DELIBERATELY NOT REMEMBERED.
//
// Both of these are the difference between "restore their filters" and
// "restore their session", and the second one is where this gets dangerous.
// ---------------------------------------------------------------------------
{
  // An open drawer. Reopening a lead somebody looked at yesterday is not a
  // filter, and on a since-claimed lead it reopens something no longer theirs.
  const q = memorableQuery("prov=ON&lead=abc-123");
  assert.doesNotMatch(q, /lead=/, "an open lead must never be remembered");
  assert.match(q, /prov=ON/, "but the filters around it must be");

  // The page number. A remembered page 7 against a pool that has since shrunk
  // renders an EMPTY list, and an empty list reads as "there are no leads"
  // rather than "you are past the end" -- the exact misread this product has
  // already been bitten by twice.
  const p = memorableQuery("prov=ON&page=7");
  assert.doesNotMatch(p, /page=7/, "a stale page number must never be restored");
}

// ---------------------------------------------------------------------------
// 3. "UNTIL YOU UN-CLICK THE FILTERS."
//
// Clearing is itself a filter change, so it overwrites the memory with an empty
// string -- and an empty memory restores nothing. There is no separate "forget"
// path that could fall out of sync with the clear button.
// ---------------------------------------------------------------------------
assert.equal(memorableQuery(""), "", "no filters remembers nothing");
assert.equal(memorableQuery("page=3"), "", "a page alone is not a filter");
assert.equal(memorableQuery("lead=abc"), "", "an open lead alone is not a filter");

// ---------------------------------------------------------------------------
// 4. hasNoFilters decides whether restoring is safe: it must be true ONLY when
//    there is genuinely nothing on screen to overwrite.
// ---------------------------------------------------------------------------
assert.equal(hasNoFilters(""), true, "a bare /web-leads has nothing to lose");
assert.equal(hasNoFilters("lead=abc-123"), true, "a deep link to one lead carries no filters");
assert.equal(hasNoFilters("page=4"), true, "a page number is not a filter");
assert.equal(hasNoFilters("prov=ON"), false, "an active filter must NEVER be overwritten");
assert.equal(hasNoFilters("q=dentist"), false, "an active search must never be overwritten");
assert.equal(hasNoFilters("view=mine"), false, "an explicitly chosen view must never be overwritten");

// ---------------------------------------------------------------------------
// 5. THE WIRING, AND THE TWO ORDERING RULES THAT MAKE IT CORRECT.
//
// Source-matched because the hook lives inside a client component with a
// router; what matters is not the JSX but the order of the two effects.
// ---------------------------------------------------------------------------
{
  const src = read("components/web-leads/WebLeadsBrowser.tsx");

  // RESTORE ONCE. Without the ref this re-runs on every URL change and fights
  // a rep who is actively clearing filters -- they clear, it restores, forever.
  assert.match(src, /const restoredRef = useRef\(false\)/, "the restore must be guarded to run once");
  assert.match(src, /if \(restoredRef\.current\) return;/, "and must return early on later renders");

  // RESTORE ONLY INTO AN EMPTY URL. This is what stops it overriding a link
  // somebody was sent, or a rep who is mid-filter.
  assert.match(src, /if \(!hasNoFilters\(current\)\) return;/, "never restore over live filters");

  // REPLACE, NOT PUSH. A pushed entry makes the bare URL a back-button stop
  // that immediately bounces the rep forward again -- a trap, not a feature.
  assert.match(
    src,
    /router\.replace\(`\/web-leads\?\$\{target\}`/,
    "restoring must REPLACE the bare URL, never push a new history entry",
  );
  assert.doesNotMatch(
    src,
    /router\.push\(`\/web-leads\?\$\{target\}`/,
    "pushing the restore would create a back-button trap",
  );

  // REMEMBER ONLY AFTER THE RESTORE HAS RUN. Writing on the first render would
  // overwrite a real memory with the empty URL we are about to replace -- the
  // whole bug in miniature, and it would look like the feature simply never
  // worked.
  assert.match(
    src,
    /if \(!restoredRef\.current\) return;\s*\n\s*rememberFilters\(sp\.toString\(\)\);/,
    "the remember effect must not run before the restore effect has had its turn",
  );
}

// ---------------------------------------------------------------------------
// 6. RESTORED FILTERS MUST BE VISIBLE, NOT HIDDEN STATE.
//
// This is the condition that makes persisting safe at all. A filtered list that
// looks like the whole pool is how "the board reads as clogged" and "the queue
// looks complete and is not" happened before. It is safe here ONLY because the
// toolbar renders a chip per active filter and a Clear all button, so a
// restored filter is on screen, named, and one click from gone.
// ---------------------------------------------------------------------------
{
  const toolbar = read("components/web-leads/LeadsToolbar.tsx");
  assert.match(toolbar, /chips/, "active filters must render as visible chips");
  assert.match(toolbar, /Clear all/, "and there must be a one-click way to un-click them");
}

// The storage key is versioned, so a change to the filter vocabulary retires
// every stored string at once instead of replaying an old shape into a new
// parser.
assert.match(FILTER_MEMORY_KEY, /\.v\d+$/, "the storage key must carry a version suffix");

console.log("web-leads-filter-memory ok — filters survive the round trip, and clearing still clears");
