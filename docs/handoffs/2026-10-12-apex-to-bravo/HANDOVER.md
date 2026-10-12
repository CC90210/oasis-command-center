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

---

## 11. Devices (Adon, 2026-10-12: "a big part", top priority with the funnel)

**What Adon saw on Settings > Devices, signed in as adon@ (verified against `origin/main`):**

| Symptom | Cause | Fix |
|---|---|---|
| "Team computers (2): 192.168.11.27 (Mac) · Waiting for your approval / CCPC (Windows) · Waiting for your approval" | `components/settings/YourComputersCard.tsx:76`: the team list reuses the viewer's own label function, so CC's machines say "your approval" to Adon. They wait on CC. | Team rows say the owner: "CC's computer · online · not yet approved by CC for department work". Only the owner sees an Approve button. |
| No way to pair from Devices | `ConnectYourComputerCard` is mounted only in Settings > Profile (`SettingsContent.tsx:373, :761`). Devices only has a sentence pointing at it, and that sentence says "there is nothing to install today". | Put the connect flow at the TOP of Devices as one button, "Add a device". Keep the Profile mount too. |
| "Waiting for your approval" on your own newly paired computer | O3a requires the owner to approve claiming after pairing. When the person minted the code themselves, the code already proves it is them. | A connector code minted and redeemed by the same signed-in person is approved on redeem. Keep the explicit approval only for legacy or team-paired machines. |
| Nothing to install | The J1 connector exists only inside JARVIS (Adon's machine: `node scripts/oasis_pair.mjs`). J2, the installer for everyone else, is not built. | Until J2 ships, the card shows the exact command for OASIS team machines and says plainly that the client installer is coming. Never show a button that cannot work (the Devices full-install button failed live once; it is now owner-only). |

**D0 = the four fixes above. Ship them first, about 6 h, one PR.** Tests:
- a team row never says "your approval";
- an own code is approved on redeem;
- someone else's code is not;
- the card renders on Devices for a non-admin member.

**What Adon wants Devices to become.** Every device a person owns connects here, and everything that person sets up then runs on their own device:
- AI connections: local models, cloud models, subscription accounts, API keys;
- automations;
- tracked tasks.

It also has to hold future device types: computers, iPhones, whatever comes next.

Design direction:

- **A device is anything a person owns that can do work or take decisions.** It advertises CAPABILITIES; jobs route
  by the capabilities they need plus the person they run as (`run_as`), never by device type. Capability vocabulary,
  versioned:
  - `cli_agent:claude_code` / `cli_agent:codex`;
  - `local_llm` (with its model list);
  - `files`, `shell`, `browser`, `schedule`;
  - `notify`, `approve`, `capture:camera` / `capture:voice`.

  New hardware adds capabilities, not code paths.
- **Computers (Windows, macOS, Linux)** run the connector and advertise what they actually detect:
  - installed CLIs and whether each is signed in;
  - local model servers (Ollama / LM Studio: models listed, never their prompts);
  - free capacity.

  The page shows the detected list live.
- **Phones (iPhone, Android): the decide-and-capture device, not the runner.**
  - v1 is the OCC web app installed to the home screen (PWA), paired by scanning a QR code on Devices, with web push.
  - It carries approvals (approve or decline approval cards), alerts, voice notes into a department chat, and
    photos/docs into the Library.
  - Native apps are later. A phone never holds keys or runs agents.
- **AI connections bind to a person, and optionally to a device:**
  - cloud API keys stay server-side, per person, encrypted;
  - subscription CLIs and local models belong to the device that has them;
  - AI brain shows "where this runs" for each.
- **Automations and tasks get a "Run on" picker** listing the person's devices with the capability the job needs and
  their live status. If the chosen device is offline, the run says so and follows the missed-run rule already decided
  (catch up once within 12 h, else "Missed"). It never falls back to someone else's device.
- **Security, unchanged from O1-O4:**
  - a device answers only its owner's work;
  - revoked = refused everywhere;
  - pairing codes are short-lived and single-use;
  - every capability report is data, validated server-side, never trusted to widen access.

**Slices after D0:**

| Slice | Ships | Est. |
|---|---|---|
| D1 | Capability registry: device capabilities table plus a versioned vocabulary; the connector reports them; Devices shows them | 16 h |
| D2 | J2 installers for Windows and macOS, signed, one-click, code pre-filled from "Add a device" | 24 h+ (signing certificates are a CC/Adon purchase) |
| D3 | Phone as a device: PWA install, QR pairing, web push, approve from the phone | 20 h |
| D4 | AI connections bound to devices: detected CLIs and local models shown and selectable in AI brain | 16 h |
| D5 | "Run on" picker for automations and tasks, with live device status | 10 h |

**Order with the funnel:** D0 first (small, Adon is blocked by it), then funnel slices 1-3, then D1-D5 interleaved
with funnel 5-7. Write the D1-D5 design as a spec and get Adon's and CC's yes before building D1 (it changes what
O4's claim route trusts).

---

## 12. AI brain: redesign it per person (Adon, 2026-10-12, with screenshots)

Adon's words: AI brain, Devices, Connections and Chat apps "work interconnectingly". AI brain must be HIS instance,
never CC's info. Connecting cloud models, API keys, subscription accounts and your own local LLM must be easy, in
**three clearly separated categories**. Remove the redundant and useless parts; keep the valuable ones.

**What is wrong today** (Settings > AI brain, signed in as adon@, after his PC was paired):

| Seen | Problem |
|---|---|
| Header: "run on Claude Code on your paired computer", then the warning "can't be reached from this account" | The workspace engine (CC's machine) is shown as if it were Adon's. |
| "AI apps on your paired computer: This runs on another team member's computer" | The card reads the workspace's bridge, not the viewer's own devices. |
| "Your AI account is Google Gemini" while the header says Claude Code | The fallback key reads like the primary. One sentence must say primary and fallback together. |
| "What powers your agents", "How your departments think", and the Claude Code / Codex / Gemini CLI tabs | Three controls for one decision. |
| Workspace agents list and the Jev (TypeSafe) panel | They belong on AI Team and Connections, not AI brain. |
| Adon's pairing `938fbd09` has `claude_account_hash` NULL and no CLI inventory | The connector pings, but what it detects (CLIs, sign-in, local models) is not reaching the server, so there is nothing per-device to show. Check `probeCliInventory` / `buildPingBody` in JARVIS `services/oasis-connector/index.mjs` against what `/api/bridge/ping` stores. |

**Target layout.** One page, per signed-in person. Workspace-wide settings sit in a collapsed "Workspace defaults"
that only owners and admins see.

1. **One sentence at the top, with one Change button:**
   "Your departments answer with **Claude Code on UPPAECHELON**. If it is offline: **Gemini 3.8 Flash (workspace
   key)**."
   - It is live: device online or offline, last answer time.
   - It is built only from the viewer's own devices and keys, plus the workspace fallback, labelled as such.
2. **Three categories, as tabs or three cards, same layout each:**

   | Category | What it shows | Connect action |
   |---|---|---|
   | **On my devices** (apps) | Per paired device: detected Claude Code / Codex / Gemini CLI, each with signed in / not signed in, and "Use for my departments". Codex and Gemini keep their "not for departments" reason. | Empty state: "Connect a device", which opens the Devices "Add a device" flow (section 11, D0). |
   | **Local models** | Per device: Ollama / LM Studio detected, the model list, a "Test" that runs one short prompt locally, and "Use for my departments". | Short how-to: install Ollama, `ollama pull <model>`, then it appears here on the next ping. |
   | **API keys** (cloud) | Provider cards: Anthropic, OpenAI, Google Gemini, OpenRouter. Each shows Connected / Not connected, whose key (mine or workspace), model picker, Test, Replace, Disconnect. | Paste a key once; Test before save. Keys are encrypted and never sent to any computer. |

3. **Interlinks:**
   - a device on Devices links to its AI brain card and back;
   - Connections lists AI keys only as a link to AI brain, never a second editor;
   - Chat apps (Slack mention) says which brain answers there: always the API key, per the existing rule.
4. **Remove from AI brain:**
   - the duplicated explanations;
   - "How your departments think" (merged into item 1);
   - the Workspace agents list (it lives on AI Team);
   - the Jev panel (move it to Connections under "Specialist models").
5. **States to design** (hallmark 8): no device, device offline, app not signed in, key failing, no fallback,
   loading, read error, and a member (not admin) view.

**Rules that stay** (O1-O4):
- a person's departments run only on their own approved device, else their fallback;
- never on another person's device;
- Codex and Gemini CLI are not offered for department work.

**Slice:** AI1, after D0 and D1 (D1 delivers the per-device capability list this page reads). About 14 h. Write the
mockup first and get Adon's yes before building. Use the oasis-ui-library doctrine and run the UI gate.
