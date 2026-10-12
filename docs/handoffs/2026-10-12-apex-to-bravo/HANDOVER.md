# APEX to Bravo: OCC handover, and the four-offer rebuild

Written 2026-10-12 by APEX (Adon's agent). Bravo owns OCC execution from here: APEX is pausing for usage.
OCC `main` at writing: `34696ff3`. Every claim below about the code was read on `origin/main`; anything not
verified says so.

Companion files in this folder (all readable without JARVIS access):

| File | What it is |
|---|---|
| `oasis_funnel_master.md` | Adon's master funnel, condensed faithfully. Source of truth for the four pillars and prices. Original lives in CC's Business-Empire-Agent `docs/funnel/`. |
| `next_improvements_spec.md` | Approved 2026-10-11 (Adon: "all yes" to its 6 questions). VSL pages V0-V6, brand and domain, SEO tools, chat apps. |
| `content_tools_spec.md` | Approved 2026-10-11 ("all yes" to its 5 questions). Content Tools rebuild. |

---

## 1. Adon's decisions (2026-10-11, in his words where it matters)

1. **Four offers = the four pillars in `oasis_funnel_master.md`:** PROTOCOL, COMMAND, COMMUNITY, FLEET.
   Each gets its own full descriptive landing page with a VSL. Plus one routing page (`/vsl`, "start here").
2. **Pages show prices,** the funnel doc's numbers exactly. Where the doc gives a range, Adon picks the number
   before publish (section 6, the publish checklist).
3. **Free community = Telegram:** `https://t.me/+w_8rgh8YBWg4YmM5`. This is the "save basin": anyone who is not
   ready, has no budget, or stalls is routed here, and the route is tracked.
4. **VSLs: Adon and CC on camera.** Oasis Studio edits (captions, b-roll, screen recordings of OCC).
   **Separate later project, log it, do not start it now:** Studio-made videos hyper-specific to each of the four
   ICPs.
5. **His brief, verbatim intent:** today "the offers and the intake forms look the exact same", just a form. Offers
   must carry real information about the company and the product, then the step-by-step form, "as seamless and
   easy as possible", and "if they ever get discouraged or they're not interested, they get routed back to our free
   community, and everything is tracked", so OASIS "can house and account for everyone, how big or how little their
   budget is."
6. He already deleted the old CC-work offers. Today the Offers screen holds one offer (AI Automation Audit,
   `/ai-audit`, draft page not live, 21 responses) and one intake form (Client Support Ticket, `/support`).
   "The AI automation audit is good, but it's not what we want."

---

## 2. What APEX shipped in this takeover (all merged to main and deploy-verified)

Each verified by the `deploy-cloudflare.yml` run for the merge SHA plus `GET /api/health` reporting that SHA.

| PR | What it does | Merge | Migration |
|---|---|---|---|
| #582 O0 | Pairing binds the proven person | `7ced8a99` | |
| #583 O1 | Only a computer's owner can use it; non-owners' chats pause | `0e0ed29f` | bravo__210 |
| #584 | Logos load everywhere, Repurpose names its failures, no em dashes on public forms, plain Slack card, Telegram webhook fails closed | `14750122` | |
| #585 O2 | Automations shows only your own; house lane for CC only | `9ad1423e` | bravo__211 |
| #586 DV0 | Devices offers CC's full install to the owner only | `0c9c48a6` | |
| #587 O3a | Computers belong to whoever paired them, need their approval, stop when they leave | `59a1825f` | bravo__212 |
| #588 O3b | Per-person AI engine, Your computers card, one computer-state rule | `64707577` | |
| #589 O4 | Your approved computer claims your department chats (pull dispatch, no key fallback) | `55711a41` | bravo__213 |
| #590 DV1 | Connect your computer card (connector code) in Settings > Profile | `bcfa2861` | |
| #591 V0 | Consent record for every public form (below) | `34696ff3` | bravo__214 |

All five migrations are applied to `bravo-empire` and have `schema_migrations` rows (checksum = sha256 of the git
blob, not the CRLF working copy).

**V0, the consent record, matters for everything below.** Every public form now draws two separate unticked boxes
(email, SMS) on the step that collects that channel, naming OASIS AI Solutions and its address. The server records
each decision in insert-only `consent_events`:
- the IP comes from Cloudflare only;
- a decision binds to the canonical address (`subject_hash`), never the lead;
- a decline after a tick is permanent;
- support forms draw no boxes.

**The rule for any future marketing sender:** call `marketingSendAllowed(db, {tenantId, channel, destination})`
(`lib/consent/marketing-send-gate.ts`) and send ONLY to `verdict.destination`. Transactional replies never call it.
No non-SunBiz marketing sender exists yet, so the community drip and nurture in section 4 are the first callers.

**Not exercised live:**
- **V0:** no test row was written, because rows can never be deleted. Watch the first real one:
  `SELECT channel, ticked, created_at FROM consent_events ORDER BY created_at DESC LIMIT 5`.
- **CC's department chat path since O4:** no chat has run on it since the deploy. Watch the first one on CCPC.

---

## 3. Offers screen: restructure it (Adon: "they literally look the exact same")

Code today: `app/forms/page.tsx` + `components/forms/FormsListClient.tsx`. A form is an offer iff it has a
`form_offer_pages` row. Both tables render as near-identical rows, and the AI audit page was never published, so
the public link shows the plain form.

Target:

- **Offers section = cards, not table rows.** One card per pillar, showing:
  - name and one-line promise;
  - page status (Draft / Live vN / Live + unpublished changes);
  - VSL status (none / uploaded / captioned);
  - price ladder (the tiers in section 4);
  - a 7-day funnel strip: views, video plays, leads, booked, sent to community. Real counts only: a dash, never a 0,
    until tracking ships (section 5).
  - Actions: Edit page, Preview, Copy link (with UTM presets, which already exist), Share, switch On/Off.
- **"Start here" router card** pinned above the four. It is the `/vsl` page and shows where its visitors went.
- **Intake forms section stays a plain table,** visibly secondary. Today it holds Client Support Ticket only.
- **AI Automation Audit (`/ai-audit`):** do NOT delete it; it holds 21 responses and live links point at it. Recommended:
  - it becomes the qualification form behind FLEET (4A Enterprise AI audit);
  - once the FLEET page is live, `/ai-audit` renders the FLEET offer page, so existing links keep working.
  - Its em dashes were fixed live on 2026-10-11 (DB shows 0).
- Build through the oasis-ui-library doctrine:
  - tabular numerals on money and counts;
  - semantic tokens;
  - no indigo or violet accent;
  - WCAG 2.2 AA;
  - gate: `python .github/ui/ui_slop_lint.py --root . --baseline .github/ui/ui-slop-baseline.json`.

---

## 4. The four offer pages and the router

**Page anatomy.** Use the existing `OfferPageDoc` (`lib/offer-pages/types.ts`); no new schema is needed for content:

| Order | Section | Notes |
|---|---|---|
| 1 | `hero` | VSL (tap to play), headline, subheadline, one button. `show_transcript` on. |
| 2 | `obstacles` | Their problem in their words. |
| 3 | `what_you_get` | The tiers, with prices. |
| 4 | `work` | How it works: 3 steps. |
| 5 | `results` | Only with evidence, permission and the owner's tick (the claims gate enforces this). If there is none yet, OMIT the section; never invent. |
| 6 | `bonuses` | Only real ones, values confirmed. |
| 7 | `guarantee` | Only if Adon or CC confirm the exact terms. Otherwise omit. |
| 8 | `faq` | Must include "What if I'm not ready?", which links the community. |
| 9 | `book` | The step-by-step form (`form_then_link` where a call is the next step). |

Every page carries a persistent, quiet **"Not ready? Join the free community"** link (tracked, section 5) in the
hero area and the FAQ. That is Adon's "routed back to our free community".

**Copy rules:**
- no em dashes;
- never name house agents (Bravo, Maven, Atlas, Aura, APEX, Knut);
- no number, result, testimonial or guarantee without a source and an owner tick;
- scarcity only if literally true;
- no negative-option continuity, cancellation fees or penalty trials (Quebec auto-renewal rules);
- monthly plans say plainly how to cancel.

**Prices** are the funnel doc's `$` figures. The doc does not say CAD or USD: ask Adon once, and show the currency on
the page.

### PROTOCOL (`cat=p1`): solopreneurs and DIY builders
- **Promise:** the exact SOPs, prompts and blueprints OASIS runs on, so you can set it up yourself this week.
- **Tiers:**

  | Code | What | Price |
  |---|---|---|
  | 1A | Quick-win SOPs + prompt packs | $17-47 |
  | 1B | System blueprints + workflows | $97-197, or 2-pay $59 x 2 |
  | 1C | Master protocol suite | $297 |
  | 1D | Mystery digital vault | $97-395 |

  Order bumps: +$27 prompt pack, +$47 video vault.
- **Page CTA:** buy, not book. **NOT BUILT:** checkout and digital delivery. v1 = Stripe Payment Links created by
  CC/Adon (no code), with the button linking out and the success URL returning to an OCC thank-you page.
  Delivery of files = a later slice.
- **Downsell:** free community. **Ascension:** "apply for OS DIY" links to COMMAND.

### COMMAND (`cat=p2`): service businesses doing about $10K-75K a month
- **Promise:** the OASIS Command Center runs your follow-up, booking and back office, set up for you or by you.
- **Tiers:**

  | Code | What | Price |
  |---|---|---|
  | 2A | OS DIY | $497/mo, no setup |
  | 2B | OS Turnkey (done for you) | $2,500 setup + $997/mo, or 2-pay $1,400 x 2 |
  | 2C | Managed operating partner | $5,000 setup + $2,500-3,500/mo |
- **Fulfilment fact for the page:** Turnkey's 7-day setup clock starts when the onboarding vault
  (`https://oasisai.work/onboarding`) is 100% submitted. State it plainly; it sets expectations.
- **Page CTA:** book the 45-minute discovery call (the call script is in the funnel doc).
- **Downsell ladder on the page and in the call:** 2-pay, then DIY $497/mo, then VIP $97/mo, then the community.

### COMMUNITY (`cat=p3`): early builders and agencies
- **Tiers:**

  | Code | What | Price |
  |---|---|---|
  | 3A | Free Telegram lounge | $0, `https://t.me/+w_8rgh8YBWg4YmM5` |
  | 3B | VIP mastermind, weekly build room | $47-97/mo |
  | 3C | 1-on-1 founder mentorship | $2,500-5,000/mo, application only |
- **Entry gate (funnel doc):** two "innocence questions" before the free link: "Are you sure you want free
  self-serve?" and "Do you have a budget?". A "yes, I have a budget" shows 3B and COMMAND instead of only the free
  link. Tracked either way.
- **Page CTA:** join free (tracked redirect), upgrade to VIP (Stripe Payment Link in v1), or apply for mentorship (form).

### FLEET (`cat=p4`): mid-market and multi-location
- **Tiers:**

  | Code | What | Price |
  |---|---|---|
  | 4A | Enterprise AI + security audit | $2,500-7,500, 100% credited to the build |
  | 4B | Bespoke multi-agent fleets | $5,000-15,000+ |
  | 4C | High-converting website rebuild | $2,000-5,000, or a $500 website audit first |
- **Downsell:** self-audit protocol ($297, PROTOCOL 1C).
- **Page CTA:** request the audit, using the current `/ai-audit` form steps (they are good; keep them), then book.

### Router: `/vsl`, "Start here"
- 12-minute "epiphany bridge" founder VSL, then one click: "Which is you?" with four cards, one per pillar.
- `?cat=p1..p4` preselects a card; `kw=` is recorded.
- Then two routing questions: monthly revenue band (reuse the `/ai-audit` options) and budget (reuse its budget
  options).

| Answer | Goes to |
|---|---|
| Chose PROTOCOL, or revenue "pre-revenue / under $10K" with no budget | PROTOCOL page; free-community link shown first |
| Chose COMMAND and revenue $10K+, or budget $2K+ | COMMAND page, booking |
| Chose COMMUNITY, or "Nothing yet, exploring" budget at any revenue | COMMUNITY page (innocence gate) |
| Chose FLEET, or revenue $250K+, or team 21+ | FLEET page, audit form |
| Anyone who closes the router or answers "not now" | Free community link (tracked) |

These rules are a first cut from the funnel doc's triage (self-selection + revenue + intent). Store them as data
(per-workspace routing rules), not code, so CC/Adon can tune them. The spec's slice V5 already plans "path +
revenue + intent rules set stage, owner, pillar".

---

## 5. Tracking (nothing exists today)

Verified on main: no page-view, video-play, step or abandon events exist anywhere, and the submit route reads only
`?rep` and `?source`. The Share menu's `utm_*` params are dropped. Build:

**1. Events table.** Turso, new migration with RLS-equivalent tenant scoping in code (libSQL has no RLS); every index
leads with `tenant_id`. Events:
- `page_view`;
- `video_play`, plus progress at 25/50/75/100;
- `path_selected`, `step_viewed`, `step_submitted`;
- `community_click`;
- `booking_made`;
- `checkout_click`.

**2. Privacy (Law 25).**
- Before any consent, store aggregate counts only: a random per-visit id in `sessionStorage`, never a cookie, never
  an IP, never a fingerprint.
- Link the visit to a lead only at submit, when the visitor has given details.
- Retention: 13 months for events.

**3. UTM and `kw`/`cat` on submit.** Read `utm_source`, `utm_medium`, `utm_campaign`, `kw` and `cat` in
`app/api/forms/submit/route.ts` and store them on the lead next to `lead_source` (which stays first-touch,
immutable).

**4. The community redirect.** A first-party route, e.g. `GET /go/community?from=<offer>&step=<n>`:
- it records `community_click` and then 302s to the Telegram link;
- if a lead exists, it also writes the `save_basin.enrolled` lead interaction (funnel doc onboarding events);
- the destination comes from server config, never from the query, so the route can't become an open redirect.

**5. Per-offer funnel numbers** feed the Offers cards (section 3) and per-lead stage, owner and pillar routing (V5).

**6. Any nurture or community drip** to a lead must pass `marketingSendAllowed` (section 2) and the one send gate.

---

## 6. Build order for Bravo

Slices follow the approved `next_improvements_spec.md` §1, adjusted for the decisions above. Estimates are
APEX's, not measured.

| # | Slice | Ships | Needs | Est. |
|---|---|---|---|---|
| 1 | **R1 Offers screen** | Section 3 restructure (cards, router card, intake table secondary). Funnel strip shows a dash until slice 5. | none | 10 h |
| 2 | **V3 Video for all** | Presigned R2 upload, poster, captions (VTT), rights tick. Lift the OASIS-only lock in `lib/offer-pages/video.ts:93` for the workspace's own uploads. OASIS can attach Library videos today, so OASIS VSLs are not blocked by this. | none | 14 h |
| 3 | **V2 VSL with paths + router** | `vsl_paths` template, the `/vsl` router (section 4), `cat` preselect, routing rules as data, community link on every page | none | 18 h |
| 4 | **Content** | Create the four offer pages plus the router in OASIS's workspace from section 4. Draft only; publish waits on the checklist below. | 3 | 6 h |
| 5 | **V5 Tracking + routing** | Section 5: events, UTM/kw/cat on submit, `/go/community`, funnel strip numbers, stage/owner/pillar rules | 3 | 18 h |
| 6 | **V4 Booking on page** | Availability, Google free/busy, race-safe holds, Schedule mirror (spec §1) | V0 (live) | 28 h |
| 7 | **V6 `/vsl` live** | Short public paths, reserved words, ten-check acceptance on prod | 2-6 | 8 h |
| later | V1 Write my page | The AI page writer. Lower priority now: section 4 already gives the page structure. | | 14 h |
| later | ICP-specific Studio videos | Adon's separate project (decision 4). Blocked on an OASIS brand kit in Oasis Studio (only an Arthrisil kit exists; Studio refuses a brief with no kit). | brand kit | ? |

**Publish checklist** (the claims gate in `lib/offer-pages/claims.ts:360` enforces part of it). Adon or CC confirm:
1. Currency, and one number for each price range.
2. Every result or number on the page, each with evidence and permission.
3. Guarantee terms, or the guarantee section is removed.
4. Bonus values.
5. That the VSL is uploaded and its rights are ticked.
6. Stripe Payment Links exist for PROTOCOL and VIP.
7. That the Telegram link above is the right group.

---

## 7. The VSLs (Adon and CC on camera)

Five videos:
- one 12-minute router VSL;
- four offer VSLs of 3-6 minutes each.

Record on a phone, landscape, eye level, quiet room. Oasis Studio adds:
- captions;
- b-roll;
- screen recordings of the OCC screens each offer sells;
- the OASIS end card.

Beats for every offer VSL, which is also what the script writer follows (no invented numbers; real numbers only with
their source):

1. Hook (0:00-0:20): the one painful moment this ICP lives every week.
2. Who this is for, and who it is not for. That sentence is also the route to the community.
3. Why it keeps happening: the real cause, not "you need AI".
4. What we do about it: the 3-step how-it-works, shown on screen in OCC.
5. What you get: the tiers, with prices said out loud, matching the page.
6. Proof: only real, permissioned examples. If none yet, show the product working instead.
7. The call to action matching the page CTA, plus "not ready? the free community is linked below".

Per offer, the angle:

| VSL | Angle |
|---|---|
| Router (12 min) | Founder story, from doing everything by hand to an autonomous operating system. Then "pick the one that's you". |
| PROTOCOL | "Here is exactly what we use. Copy it this week." |
| COMMAND | "Leads go cold while you work. Here is your follow-up and booking running without you." Show a lead arriving, the auto-reply, the booked call. |
| COMMUNITY | "Build alongside us for free. Upgrade only when you want the room." |
| FLEET | "Before anyone builds anything, we audit where AI pays back and where it is a liability." Show the audit report shape. |

**Upload:**
- for OASIS, ingest into Library as an OASIS brand asset and pick it in the page builder's VideoPicker;
- for other workspaces, use slice V3.

The "Video" rights tick must be set honestly: founders' own footage, licensed music and b-roll only (Studio records
the licence of every asset).

---

## 8. How APEX worked (keep these; each one cost a defect when skipped)

**Every PR:**
- Fresh worktree from `origin/main`, one branch per PR. Lease contested paths:
  `node scripts/coord_claim.mjs acquire|release` (JARVIS), repo slug from the remote.
- Register every new test file in a `package.json` test group: `tests/test-suite-coverage.test.ts` fails the build
  otherwise.
- Run tests with `node --conditions=react-server --import tsx tests/<file>.ts`.
- **Before pushing, run EVERY group in `.github/workflows/ci.yml`'s Tests step** with
  `NODE_OPTIONS=--conditions=react-server`. A hand-picked subset missed `test:sunbiz` on #591 and CI caught it.
- Mutation-check the key test: break the fix on purpose and confirm the test fails.
- Independent review (Codex `review --base origin/main` from the worktree, or a separate reviewer when Codex is out
  of quota). A reviewer that fails to complete is blocking, not a pass.
- **Review in rounds.** Each fix commit gets its own `review --commit <sha>`; #591 needed six rounds, and every one
  found something real.
- Before merging: 0 unresolved review threads (GraphQL `reviewThreads`, reply then `resolveReviewThread`), and CI
  green on the exact head.
- Merge with `gh pr merge N --squash --match-head-commit <sha>`.
- Done = `deploy-cloudflare.yml` success for the merge SHA plus `/api/health` showing it. A preview is not a deploy.
  The Vercel check is stale: ignore it as a deploy signal and get it disconnected.

**Every migration:**
- Lease the number, and check that the table or column names are free in prod.
- Write any trigger `BEGIN ... END;` on ONE line. The applier (`scripts/turso_sql.mjs`) splits on `;` followed by a
  newline.
- No `-- comment` after a `;` on the same line.
- Dry-run through the applier's own `splitSqlStatements` on a scratch libSQL file, twice, so it proves it re-runs.
- Apply before merging. Then verify every object the file DECLARES, counted from the file text, exists in
  `sqlite_master`.
- Ledger row checksum = sha256 of `git show HEAD:<file>`.

**Code rules:**
- Fail closed.
- Tenant from the session only.
- argv, never shell strings.
- Untrusted text fenced.
- libSQL booleans are 0/1 and JSON columns are TEXT.
- Async client code reads state through refs after any await. #591 had two stale-closure bugs from this.

---

## 9. Open items handed to Bravo

| Item | State |
|---|---|
| Adon pairs his PC (JARVIS connector `apex-oasis-connector`) | Waiting on Adon. Steps: Settings > Profile > Connect your computer, then `node scripts/oasis_pair.mjs` in a NON-admin terminal, then `pm2 start ecosystem.config.cjs --only apex-oasis-connector` and `pm2 save`. The first live run proves the canary and hook schema. |
| Slack app | Adon creates the app (`docs/handovers/2026-10-01_oasis_slack_app_manifest.md`). Bravo loads keys with `wrangler_tool.py secrets-push`; then test OAuth live. |
| Vendor apps (QuickBooks, Xero, Zoom, WhatsApp/Meta) | Same pattern. WhatsApp may need Meta business verification (days). |
| Shared Telegram team bot | NOT approved by Adon. Do not build. |
| Content Tools, SEO tools, domains/DNS, chat apps | Approved specs in this folder; not started. Content Tools is Adon's top priority after the funnel. |
| Em dashes in 4 lead emails; a SunBiz form mentions lenders | Found, not fixed. |
| `/api/telegram/webhook` not on the middleware public list; `/health` system-health unscoped for the house scheduler | Found, not fixed. |
| J2 client installer; O5/O6/O7 from the per-person computers design | Not started. |
| `test_router_eval` latency flake (JARVIS pre-push) | Promote it to a slow/deterministic test. |

---

## 10. Who must act

| Who | What |
|---|---|
| **Adon / CC** | Record the five VSLs (section 7). Answer the publish checklist (section 6). Create the Stripe Payment Links. Confirm the currency. |
| **Adon** | Pair his PC. Create the Slack app. |
| **Bravo** | Slices 1-7 in order, merge gate per section 8. Report each merge with its plain-language description first and the SHA second. |
