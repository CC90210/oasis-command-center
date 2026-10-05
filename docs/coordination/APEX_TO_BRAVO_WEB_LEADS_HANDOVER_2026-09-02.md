# APEX → Bravo: web-leads handover, 2026-09-02

Adon: *"Bravo is also working on the same issue so just transfer everything you
worked on and communicate with them properly."*

Everything below is **verifiable** — SHAs, deployment ids, row counts measured
against `bravo-empire`, file paths on `origin/main`. Where something is unproven
or still running it says so. Nothing here is a claim about intent.

---

## 1. What is already MERGED and LIVE (do not re-do)

| PR | Merge SHA | Production deployment | What |
|---|---|---|---|
| #370 | `7106b29c` | `6224923111` success | `ownerOnly` filter + "Ask for &lt;name&gt;" on the lead card |
| #371 | `27a5d792` | `6226323003` success | manager lands on the pool + can claim; dead `CC Leads` chip removed |

Both are on `origin/main`. If you have local work touching
`lib/web-leads/data.ts`, `lib/web-leads/filters.ts`,
`components/web-leads/{FilterRail,LeadCards,LeadsToolbar,WebLeadsBrowser}.tsx`,
`app/web-leads/page.tsx` or `tests/web-leads-{guards,manager-access}.test.ts`,
**rebase on `origin/main` before continuing** — those files moved this morning.

---

## 2. 🚨 `main` CI was RED for four consecutive merges. It is green now.

Failing from `2026-09-01T22:11Z` through `edf8e5e7`; green again at `7106b29c`.

**The code was never broken — three guards were pinned to pre-refactor text.**
The lead-scoping refactor (`teamView` → `team`, manager check moved *inside*
`canViewerRead`, scope became three-way `team`/`mine`/`pool`) is correct and was
left intact. What broke were exact-text assertions describing the old shape:

| Guard | Was pinning | Re-aimed to |
|---|---|---|
| `web-leads-guards.test.ts` | `scope === "mine" ? manager ? canViewerRead : isInBookOf : isClaimable` | three separate assertions: `team`→`canViewerRead`, `mine`→`isInBookOf(.., viewer.userId)`, pool→`isClaimable` |
| `web-leads-manager-access.test.ts` | `teamView ? "Team leads" : "My leads"` and `canMutate && !(teamView && mine)` | `team ? … : mine ? … : "Leads"` and `canOperateCurrentView = canMutate && !team` |
| `web-leads-manager-access.test.ts` | `manager check … canViewerRead` as one ordered text run | `scope === "team" ? canViewerRead(` **and** the roster predicate living *inside* `canViewerRead` |

**Re-aimed, never relaxed.** Proven by planting a weakening: replacing the
`mine` branch with `true` turns the guard red on that exact assertion, and
restoring it turns it green. Please keep that property — if you refactor
scoping again, re-aim rather than delete, and re-run the plant.

---

## 3. Why the manager saw an empty board (root cause, already fixed)

`ethan@oasisai.work` — `user_profiles.team_role = 'manager'`, tenant
`ef8d389e-…`. Screenshot: **0 leads, no Claim button.**

1. `app/web-leads/page.tsx` force-redirected every manager to `view=team`. That
   view lists only **assigned** leads; almost nothing is assigned, so it renders
   "No roster-assigned team leads yet."
2. That view also sets `canOperateCurrentView = canMutate && !team`, which
   **hides Claim**.
3. `manager` **is** in `OASIS_SALES_LEAD_OPERATOR_ROLES`, so the role was always
   permitted to claim. Permissions were never the problem — the landing view
   silently overrode them.

Fix: managers land on the pool; Team leads remains a tab. The guard that
*required* the redirect is now **inverted** (`assert.doesNotMatch`) so it cannot
be reinstated by reflex.

**`CC Leads` was the second cause.** The pinned `🔥 CC Leads` toggle set
`industry='CC Leads'`, and **zero rows carry that industry** (measured:
`select count(*) … json_extract(data,'$.industry')='CC Leads'` → `0`). It was the
active filter in the screenshot. Removed, with its HOT badge. **Do not re-add
it** unless something starts writing that industry value.

---

## 4. The leads board was cut from 27,071 → 1,111, on Adon's explicit approval

**Every remaining lead has a named owner.** Adon: *"even if we only have 500
leads but they are all the owner, that is better than 20,000."*

| Step | Removed | Rule |
|---|---|---|
| junk | 3,660 | undialable · phone-quality tier `warned` · multi-city chains (Subway, Dollarama, H&R Block) |
| non-ICP | 208 | car dealerships, universities, municipal bodies |
| no owner, site read | 17,465 | had a website we fetched, names nobody |
| no owner, no site | 8,495 | no website and no owner |

Backups taken before each cut (JARVIS `state/backups/leads-board-<tenant>-2026-09-02*.jsonl`,
47–52 MB). **The pipeline was never touched** — 44 assigned plus every
connected/qualified/won lead are intact, verified by stage counts after each cut.

Deletion is scoped to `stage='researched'` **in the SQL predicate itself**, and
repeated on every batch statement, so a bad id list still cannot leave the board.

---

## 5. What the owner data actually is (read before trusting it)

- `owner_name` / `owner_title` — read off the business's **own** About/Team page.
- `owner_evidence_url` — the page that proved it. Every claim is re-checkable.
- `owner_phone` — **separate field; the business line is never overwritten.**
- Precision is ~90% after three revalidation sweeps (30 bad values stripped).
  A random sample of 12 came back 11 clean.

🚨 **`owner_phone` is only 25 rows.** An owner's mobile is not on the public web.
I tested search directly: DuckDuckGo returns the **business** line from
directories (ChatterBlock, Yelp), not a personal number. **Do not build a
DuckDuckGo/LinkedIn scraper for owner cells — it does not work, and LinkedIn
scraping is a ToS violation.** Real owner mobiles need a paid people-data
provider; our existing skip-trace is US-only, so Canada needs a different one.
That is an unmade spend decision, Adon's.

> The `_enrich_owner` LinkedIn+DuckDuckGo function described in the earlier
> lead-cleanup handover **does not exist on any branch in CC90210** — main and
> all CEO-Agent branches carry a Firecrawl-only `scrape_firecrawl_leads.py`.
> If it exists locally, push it; otherwise please stop citing it as available.

---

## 6. JARVIS-side machinery (ours, not in this repo — for your awareness)

`services/leadgen/`, branch `apex/url-verification-gate`, all pushed:

- `lib/owner-extract.js` (+19 tests) — HTML→text, owner-name patterns EN/FR,
  About/Team link discovery, `extractAllPhones` corroboration, `validateOwner`
  write gate.
- `enrich-owners.mjs` — board-side enrichment.
- `enrich-business-owners.mjs` + migration **011** — enriches
  `leadgen_businesses` **before** promotion, so unverified leads can never reach
  the board.
- `promote-osm.mjs --owner-only` — promotes only owner-named businesses.
- `leads-board-{backup,purge}.mjs` — purge refuses to run without today's backup.
- `revalidate-owners.mjs` — re-fetches evidence pages and strips anything the
  current rules would no longer produce (`--fast` skips the network).

**Lessons that cost real time — please do not repeat them:**
- Mark *attempted* work, not just successful work. Our first runs re-crawled
  their own failures on every restart (25 owners in 925 leads, then 2 in the
  next 900).
- In JS, `/i` + `/u` makes `\p{Lu}` match lowercase, silently removing a
  capitalisation anchor.
- The `/api/pg` bridge answers **501** to negated-null (`not.is.null`) and
  **400** on some column selects — filter in memory instead.
- The column is `website_url` on `leadgen_businesses`, `website` inside the CRM
  lead JSON.

---

## 7. Running right now (do not duplicate)

- **OSM ingest of 52 small towns** (`ingest-osm.mjs --run --priority 4`), at
  town 25/52. Rings 1–3h out from Toronto, Ottawa, Montreal, Quebec City,
  Vancouver, Calgary, Edmonton, Halifax, Moncton. Adon's method: in a town of
  5–30k the business *is* the owner, so the published number reaches a decision
  maker; in Toronto the same listing reaches a receptionist.
- Next, by us: `enrich-business-owners.mjs` over the new inventory →
  `promote-osm.mjs --owner-only`. Fresh-inventory owner hit rate measured at
  **10–12%**, vs 6% on the already-worked pool.

**Sourcing is blocked on discovery, not enrichment:** all **93,145** unpromoted
businesses have **no phone** (`phone_raw` null for every one). Every
phone-bearing business we held was already promoted. New leads must come from
fresh ingest.

---

## 8. What we would like from you

1. **Rebase before touching the web-leads files listed in §1.**
2. If you re-aim a guard, plant a weakening and prove it fires.
3. Tell us if you are also writing to `tenant_records` leads for tenant
   `ef8d389e-…` so we do not both purge/promote into the same board.
4. Push `_enrich_owner` if it exists, or drop it from the plan.

Reply on `agent_activity` (APEX reads `bravo` and `cc-agent`). Contested files:
take a lease first — `node scripts/coord_claim.mjs acquire --repo-path <checkout> --paths <a,b> --task "…"`.
