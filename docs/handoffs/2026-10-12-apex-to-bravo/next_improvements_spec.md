# OCC next improvements: design spec

**Status:** for Adon's approval. Nothing is built. Read-only pass, 2026-10-11 ~00:30 ET.
**Evidence:** OCC `origin/main` = Automations safety rails (#580, `3cfa105e`) via `git show`/`git grep` in `C:/Users/echel/oasis-o0-pairing`; open PRs on GitHub; the SEO/AEO design (`oasis-seo-aeo`, branch `apex/seo-phase-2-opportunities`, `docs/superpowers/specs/2026-10-08-seo-aeo-system-design.md`); screenshots 7, 8, 10, 11.
**Not redone:** per-person computers (`cli_design.json`), Content Tools (`content_tools_spec.md`), and the in-flight fix pack (`apex/fix-what-adon-saw`: broken logo, em dashes on the public intake page, Slack card showing secret names, Telegram "Connected" source).

**Every slice:** `oasis-ui-library` route + constitution; JARVIS `ui_slop_lint.py --baseline state/ui-slop-baseline.occ.json` plus manual keyboard, zoom and screen-reader checks (OCC has no `ui:check`/`accessibility:check` script); `coord_claim` lease; tests first; Codex review; ten-check acceptance on a synthetic workspace; done = merged to `main` + Cloudflare Workers run for that SHA `success`. No em dashes or house agent names in anything a client or visitor sees. New AI flows go in the AI governance register.

## 0. Decisions in one screen

| Area | Decision |
|---|---|
| Offers | Finish the offer-page builder that shipped (#557): AI first draft, "VSL with paths" template, video upload for every workspace, booking on the page, then `/vsl` live. |
| Consent | OCC records consent itself, for every workspace, before any funnel goes live. OASIS's forms record none today. |
| Domains | One "wiring plan": OCC lists the exact records, the owner approves once, OCC adds only those, checks them, and can undo only what it added. Cloudflare first; copy-and-check for other hosts. |
| SEO | "Audit any site" in the existing SEO Worker and screen: technical, AI-answer readiness, speed; honest scores; weekly tracking; generated fixes. Free sources first. |
| Chat apps | Connections holds keys; Chat apps says what teammates do. A new OASIS team Telegram bot shared by CC and Adon. WhatsApp moves to customer messaging. |
| Computers | No redesign. Devices stops offering CC's installer to anyone but CC. |

## 1. Offers become real VSL pages

### Today (verified)

| Piece | Where | State |
|---|---|---|
| Offers list | `app/forms/page.tsx`, `FormsListClient.tsx` | 2 offers (`/ai-audit`, `/start`), both "Draft page (not live)"; 1 intake form. |
| Builder | `components/offer-pages/builder/*`; parser `lib/offer-pages/types.ts`; table `form_offer_pages` | "Every form can have a full landing page, part 1" (#557): hero with video + VSL script field, What you get, Obstacles, How it works, Results, Bonuses, Guarantee, FAQ, Book. |
| Templates | `lib/offer-pages/templates.ts` | Book a call, Free audit, Application. Structure only, no copy, by design. |
| Publish gate | `lib/offer-pages/claims.ts:360` | Headline, form on, owner confirmation on results, values, guarantee and flagged sentences. |
| Video | `lib/offer-pages/video.ts:101` | Library video plays only for OASIS's brand; others paste YouTube, Vimeo or Loom links. |
| Funnel form | `lib/forms/oasis-ai-audit-seed.ts`, `ai-audit-ingest.ts`, `ai-audit-notify.ts` | 4 steps; scores the lead, interaction row, Telegram alert, welcome email. |
| Branching | `lib/forms/types.ts:122` | A step can show only for a chosen answer (`show_if`). |
| Booking | `lib/integrations/google-calendar.ts` | Inserts a 15-minute event, retry-safe. No free/busy read, no availability rules in `lib/calendar/`. |

### Missing or broken

| Gap | Evidence |
|---|---|
| **No consent record for OASIS or any client.** Consent sealing runs only for SunBiz and Bluerise. /ai-audit asks for a mobile number with no consent wording. | `lib/consent/brand-for-tenant.ts`; `FormPublicClient.tsx:249-250` |
| Nobody writes copy. "Ask for copy" stamps a date that no OCC code reads (an agent on CC's PC reading it: NOT VERIFIED). | `SectionEditors.tsx:608` |
| `/vsl` does not exist. | no route under `app/` |
| Funnel's 4 categories (PROTOCOL, COMMAND, COMMUNITY, FLEET) differ from the form's 4 choices. | funnel doc vs seed step 2 |
| How it works items each require a video. | `WorkSection`, `types.ts` |
| Clients cannot upload video. No booking, attribution, stats or confirmation email. | `video.ts:101`; `docs/OFFER_PAGES.md` |
| 38 em dashes in the live funnel's labels; the live form changes only when the seed re-runs or the row is edited. | `oasis-ai-audit-seed.ts` |

### Design

**Owner:** New offer -> "VSL with paths" -> 7-line brief (exists) -> **Write my page** -> tick flagged sentences -> add videos -> Preview -> Publish.

**Visitor (`/vsl?cat=p2&kw=COMMAND`):**

| Step | Sees | OCC records |
|---|---|---|
| 1 | Hero video (loads on tap), headline, one button | page view (server count, no cookie) |
| 2 | "Which is you?" 2-4 path cards; `cat` preselects | path |
| 3 | Contact step, unticked consent boxes | lead, consent event, `kw`/`cat`/UTM |
| 4 | That path's questions | answers, score |
| 5 | Calendar slots on the same page, their time zone | Google + OASIS Schedule event, `discovery_call_scheduled` (`lib/oasis-lead-stage-engine.ts:61`) |
| 6 | Confirmation; free-community link if they skip booking | confirmation email; alert to the workspace's own chat |

**AI writer:** same one-shot AI path as Draft with AI (#577), moving with O7. Writes headlines (3 options), subheadline, button label, What you get, Obstacles, How it works, FAQ, path cards, VSL script. **Never** results, testimonials, numbers, prices, bonus values or guarantee terms. A product page URL is read through the existing safe reader and fenced as untrusted. Output must pass `parseOfferPageDoc`, lands in the DRAFT only, and goes through the claims linter. Em dashes and house agent names are stripped and tested.

**Consent ledger:** separate unticked boxes for email and text; wording names the business, its address and how to unsubscribe (CASL), Law 25 privacy link. One insert-only row per consent: workspace, lead, form, channel, disclosure hash + version, ticked or not, IP from Cloudflare's header (never the body), user agent, page, time. No tick: the enquiry is answered, marketing sends refuse. SunBiz keeps Opt-in Vault.

**Who:** owners and admins build and publish (#544). A workspace renders only its own forms, videos and calendars.

**Failures:** AI fails: "Couldn't write the draft. Your page is unchanged." Upload fails: empty slot, never a broken player. No calendar or no slot: existing "tell us two times" fallback. Slot taken: "That time was just taken" with fresh slots.

### Slices

| Slice | Scope | Tests | Depends | h |
|---|---|---|---|---|
| **V0 Consent ledger** | migration `consent_events`; checkboxes in `FormPublicClient.tsx`; record in `app/api/forms/submit/route.ts`; marketing sends refuse no-consent leads | IP from header; forged field ignored; hash = rendered text; no update/delete; workspace isolation | none | 12 |
| **V1 Write my page** | `app/api/forms/[id]/offer/draft`; prompt + schema; fenced reader | injection fixture; never writes results or prices; failure leaves draft | none | 14 |
| **V2 VSL with paths** | template `vsl_paths`; cards wired to `show_if`; `cat` preselect; How it works video optional | old docs parse; bad `cat` ignored | V1 | 16 |
| **V3 Video for all** | presigned R2 upload, poster, captions; rights tick kept | other workspace refused; expiry; type and size | none | 14 |
| **V4 Booking on page** | availability rules; Google free/busy; unique (person, start) hold; existing event adapter; Schedule mirror; confirmation email | double-book race; DST; disconnected fallback | V0 | 28 |
| **V5 Attribution + routing** | `kw`/`cat`/UTM on lead; views to bookings per offer; path + revenue + intent rules set stage, owner, pillar | counts = fixtures; no cookie before consent | V2 | 16 |
| **V6 /vsl live** | short public paths per workspace, reserved words; `/vsl` -> OASIS's VSL offer; CC's video uploaded | reserved refused; ten checks on prod | V0, V2-V4 | 8 |

**~108 h.**

## 2. Brand & domain, wired during onboarding

### Today (verified)

| Piece | Where | State |
|---|---|---|
| Brand & domain | `app/settings/brand/page.tsx` | Logo card + read-only sending identity from a hard-coded 3-workspace map (`lib/email/brand-for-tenant.ts`). No domain field. |
| Sender identity | open PR "each workspace registers the business name and address its emails go out under" (#541) | Counts once the workspace's Google Workspace mailbox passes Test. No DNS. |
| Onboarding wizard | `OnboardingWizardClient.tsx:87` | industry, questions, departments, chat apps, classifier, Connections hub, brand (name + footer), confirm. No domain step. |
| Provisioning | `lib/provisioning/provision-tenant.ts` | Operator runs; steps in `provisioning_runs.steps_json`. |
| Client intake | `oasis-client-onboarding-seed.ts` | Forbids asking for any password or login in a form. |
| DNS in OCC | grep `custom_hostnames`, `dns_records` | None. No DNS card in Connections. `wrangler.jsonc` has no routes. |
| DNS scripts | JARVIS `scripts/integrations/cloudflare_admin.py`, `seo_domain_verify.mjs`, `cf_dns_probe.mjs` | OASIS's own zones only. CC's provisioning scripts: NOT VERIFIED (our token gets 404 on his repo). |
| Funnel events | `onboarding.vault_submitted` etc. | Not in OCC code. |

### Design

**Rule:** no agent free-types DNS. A server job builds the plan; the owner approves; only those records change.

| Step | What happens | Safety |
|---|---|---|
| 1 Detect | Nameserver lookup names the DNS host. | read-only |
| 2 Connect | Cloudflare: a token for one zone with DNS edit, pasted into a new Connections card, Test. Others: no credential; records shown to copy. | Test needs exactly one zone or refuses. Encrypted, owner-only, never shown again, never sent to any computer. |
| 3 Plan | Desired vs current. v1: public-pages CNAME (`go.<domain>`), Google verification TXT, DMARC if absent. | Name in use stops and asks. MX, apex A/AAAA and SPF untouched in v1. |
| 4 Approve | Each record in plain words; one tap. | Nothing applies without it. |
| 5 Apply | Planned records only, tagged with the plan id in Cloudflare's comment field. | Token re-tested; a failure stops and records progress. |
| 6 Verify | Two public resolvers agree; then the next step runs. | "Could not check" is never "missing". |
| 7 Log, undo | Activity row with before and after; Undo removes only this plan's tagged records. | Untagged records unreachable. |

**Custom domain:** OCC registers `go.client.com` as a Cloudflare custom hostname on OASIS's zone. That host answers only the workspace's published offer pages, form submit, and page video/captions; everything else (including `/login`) is 404; no session cookie is set there. One hostname, one workspace. Needs one new Worker secret (Cloudflare token for custom hostnames), pushed by CC or Bravo. Pricing and Worker routing in our account: NOT VERIFIED until D0.

**Page:** five live cards: Logo and colours; Sending identity (#541); Public link domain; Email health (SPF, DKIM, DMARC, read-only); Search Console.

**Onboarding:** a skippable "Domain and email" step after Brand. When the vault is complete, the provisioning run builds the plan; the client approves in one tap; progress shows on their setup page and the operator console. DNS changes are production changes, so a person approves every plan (AI governance gate). The client can revoke the token at Cloudflare anytime.

### Slices

| Slice | Scope | Tests | Depends | h |
|---|---|---|---|---|
| **D0 Spike** | Cloudflare for SaaS on a test host we own: setup, certificate time, Worker routing, cost; pre-filled token link | written result | none | 4 |
| **D1 Domain health** | brand page cards; `lib/domains/health.ts` | lookup failure = "could not check"; SPF/DKIM/DMARC fixtures | #541 | 10 |
| **D2 Custom domain** | `workspace_domains`; hostname client; host jail in `middleware.ts` | host A cannot render workspace B; `/login` 404; no cookie; unique host | D0 | 20 |
| **D3 DNS card + plan** | Connections card (#574 pattern); `lib/domains/plan.ts` | two-zone token refused; conflict stops; replay no-op; undo only tagged | D1 | 24 |
| **D4 Onboarding step** | wizard step; provisioning step; approval card | skip works; nothing unapproved applies | D2, D3 | 10 |
| **D5 Search Console** | SEO account TXT via D3, verify, register in SEO Worker (`POST /v1/sites` exists) | DPA confirmation required; failure retries, never "done" | D3 | 8 |

**~76 h.** Later: Domain Connect (GoDaddy, IONOS; no stored credential), SPF merge with per-record approval.

## 3. SEO tools that do something

### Today (verified)

| Piece | Where | State |
|---|---|---|
| SEO screen | `app/seo/*`, `lib/seo/client.ts` | Search Console numbers for sites we can read (#546; "CC and Adon only" #552; `lib/os/nav.ts:110`). |
| SEO Worker | `oasis-seo-aeo` | Collects every 15 min; foundations shipped 2026-10-08 (ledger); opportunity finder next. |
| Design F1-F15 | SEO/AEO design doc | Opportunities, keywords, a 23-check launch gate (CI-only, our builds), AI-answer tracker, local, reports. All for sites we measure. |
| Lead site scoring | JARVIS `services/leadgen/lib/scoring-run.js`, OCC `lib/web-leads/audit.ts` | 44 checks; an unreachable site is never scored. |
| Safe fetcher | `lib/tools/worker/learn-from-link.ts` | Private-address checks, 5 MB, 15 s. |

**Why it feels empty:** it reports Google numbers for sites we own and nothing else. Nothing scores an arbitrary site, explains a fix, or makes one.

### Design

| Tool | Does | Cost |
|---|---|---|
| **Audit any site** | URL in (yours, a rival's, a client's client); up to 25 pages from its sitemap; Technical, AI-answer readiness, Speed, Content, each 0-100, every finding with its fix. | free |
| **Compare** | Yours plus up to 3 rivals on the same checks. | free |
| **Track** | Weekly re-run, history, alert on a drop; own sites also show Search Console (exists). | free |
| **Fix it** | Generates robots.txt with an AI-crawler policy, llms.txt, business JSON-LD, title and description rewrites; copy for any site, a pull request a person approves for sites we host. | free (AI path) |
| **Topic gaps** | Topics rivals cover that you do not; paid lane adds volumes and rankings. | free / metered |

**Checks (no AI):** status, redirects, canonical, noindex, titles, descriptions, headings, alt text, internal links, sitemap, robots.txt (including a named crawler group not inheriting `*`), GPTBot, OAI-SearchBot, ClaudeBot, PerplexityBot, Google-Extended rules, llms.txt, JSON-LD validity and types with no invented ratings, Content-Signal, question headings with short answers. Unreachable, robots-blocked and not-checked are named, never scored; speed without a key is "not checked", never 0.

**Where:** a deterministic job in the SEO Worker (`POST /v1/audits`), read by OCC over the existing service binding, reusable by Gritly. Model work runs on the AI path, never in the Worker. The fetcher identifies itself, obeys robots.txt, never logs in, and caps pages and audits per day.

| Source | Cost | Key | Held |
|---|---|---|---|
| Our page fetch | free | none | yes |
| PageSpeed Insights / Chrome UX Report | free | Google API key | NOT VERIFIED |
| Search Console | free | service account | yes |
| Bing Webmaster | free | API key | no |
| Google Ads volumes | free | developer token | no (applying) |
| DataForSEO | metered, $50 prepaid | account | no |
| OpenAI web search (AI answers) | metered, $50/month cap | key | yes |
| Perplexity, Gemini | metered | accounts | no |

**Who:** CC and Adon now; clients later (audit any URL; track and fix their own sites).

### Slices

| Slice | Scope | Tests | Depends | h |
|---|---|---|---|---|
| **SEO1 Audit engine** | Worker `/v1/audits`; 23-check port (MIT, attributed) + AI-readiness checks; audit tables | one plant per check on a broken fixture; unreachable unscored; private address refused; robots obeyed | none | 20 |
| **SEO2 Audit screen** | `app/seo/audit/*`; scores, findings, compare, track; plain subtitles on existing screens | non-owner refused; "not checked" never 0; numerals tabular, right-aligned | SEO1 | 14 |
| **SEO3 Speed** | PageSpeed + CrUX behind the meter | no key = "not checked" | SEO1 | 6 |
| **SEO4 Fix it** | generators; rewrites with fenced page text | no invented rating; schema valid | SEO2 | 10 |
| **SEO6 Topic gaps** | free lane; DataForSEO behind the cap | cap refuses before the call | SEO2 | 12 |
| **SEO5 Agent fixes** | PR to our own site repos from the owner's computer; launch gate passes | never pushes to main | O4, J1, O7 | 16 |

**~78 h.** The AI-answer tracker stays in its own phase 7.

## 4. Chat apps

### Today (verified)

| App | State |
|---|---|
| Slack | Built (`lib/slack/*`, `app/api/webhooks/slack/*`): Add to Slack, channel map, @mention drafts, approvals. Blocked on 3 Worker secrets (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`). One OASIS app for everyone (#565). |
| Telegram, team | Connections card, alerts only. OASIS's own alerts go to an env lane whose audience is "CC (OASIS operator)" (`lib/notify/telegram.ts:105-108`), not to the card. Which bot the card holds: NOT VERIFIED. |
| Telegram, personal | Link a bot; nothing sends to it. The SunBiz-era webhook checks its secret only "if set", with a plain comparison: fails open (`app/api/telegram/webhook/route.ts`). |
| CC's bridges | Never shown here, "plan decision 3" (`app/settings/chat-apps/page.tsx:27`). |
| Discord, Teams | Webhook URL, post-only, "no department posts here yet" (`lib/os/connectors.ts:827-878`). |
| WhatsApp | Meta sign-in only (`connectors.ts:807-825`). |
| Overlap | No duplicate data: "More chat apps" opens the same Connections drawer. Two doors to one place is the confusion. |

### Design

- **Connections holds keys; Chat apps lists what each app does** (Alerts, Ask a teammate, Approvals: built or not).
- **Two groups:** Team chat (Slack, Telegram, Discord, Teams) and Customer messaging (WhatsApp, later SMS) linking to Conversations. WhatsApp has Meta's 24-hour reply window and templates; it is not team chat.
- **Shared OASIS Telegram:** a NEW OASIS-owned bot in a group with both founders. A new bot because Telegram allows one update reader per bot; reusing one CC's PC polls would break his bridge. OASIS alerts move to it through the same Connections card clients use. Then two-way: each person links their account with a code; a linked person's message runs as that person, on their own computer once O4 is live, and gets the same "paused" answer as department chats before that. Groups map to departments like Slack channels. Unlinked senders are ignored. Outward actions wait for approval in the Feed.
- **Discord:** slash commands (`/ask`) and approval buttons over Discord's signed requests, which a Worker can serve. The card says OASIS cannot read ordinary messages.
- **Teams:** a Microsoft bot plus an app package the client's admin installs; @mention gives a draft; approval as in Slack.
- **Every inbound route:** secret or signature checked first, constant time, before the body; missing secret refuses. Inbound text fenced. 90-day retention.

**Who:** Adon creates the vendor apps (Slack from a manifest we write, Telegram bot, Discord app, Microsoft bot); CC or Bravo pushes the secrets; owners and admins connect and map.

### Slices

| Slice | Scope | Tests | Depends | h |
|---|---|---|---|---|
| **CH0 Slack live** | manifest in repo; Adon creates app; secrets pushed; Add to Slack; map | manifest URLs = routes | Adon, CC | 2 |
| **CH1 Clarity** | two groups; capability lines; WhatsApp to customer messaging | non-owners never see secret names | fix pack | 6 |
| **CH2 Team Telegram alerts** | OASIS alerts via its Connections bot; retire the fail-open webhook check | lands in team group; no fallback to a person's bot; no secret = refused | Adon creates bot | 8 |
| **CH3 Telegram teammates** | `app/api/webhooks/telegram/[tenant]`; linking; per-person turns; group map | secret before body; Adon's message never runs on CC's computer | O4, J1 | 20 |
| **CH4 Discord** | interactions route; `/ask`; buttons | bad signature refused before parse | Adon creates app | 16 |
| **CH5 Teams** | messaging route with Microsoft token check; app package | invalid token refused | Adon creates bot | 24 |
| **CH6 WhatsApp** | Conversations in and out; window; templates; V0 consent | no send without consent | V0 | 30+ |

## 5. Adon's own computer (no redesign)

All 13 OASIS computers are CC's. "Connect this computer" on Devices (screenshot 7) runs the full installer, which copies CC's private agent setup. Adon must not press it. His PC gets a small OASIS Connector once the server can tell whose work is whose:

| Step | Gives Adon | State |
|---|---|---|
| O0 | Pairing binds only the person who proved who they are (#582) | ready; waits on Bravo until 10:00 ET today |
| O1 | Only a computer's owner uses it; Adon's chats pause, never run on CC's sign-in | built, review next |
| O3a / O3b | His computer is his, approved in the browser; his own engine and status | designed |
| O4 | His computer pulls only his work | designed |
| J1 | OASIS Connector on his PC, OASIS tools only | after O4 is live |

**Devices meanwhile (DV0, 3 h, after O1):** install buttons only for the computer owner (CC). Adon sees "Your computer connects through the OASIS Connector once it is ready. Nothing to install yet." CC's computers read-only, no Revoke (today any operator can revoke them). Drop the em dash in the intro. Test: a non-owner operator gets no installer link and no Revoke; CC keeps both.

## 6. Recommended build order (all open OCC work)

**Now:** fix pack; merge O0 (#582); review and merge O1 after CC's owner row exists.

| # | Lane A: computers (critical path, with Bravo) | Lane B: product (one builder) |
|---|---|---|
| 1 | DV0; T0 downloader bound to its owner | **V0 consent** |
| 2 | O2 own automations | CH0 Slack, CH2 team Telegram alerts |
| 3 | O3a, O3b | **V1, V2** |
| 4 | O4 pull dispatch | **V3, V4, V5, V6: /vsl live** |
| 5 | J1 on Adon's PC; B1, B2 on CC's | Content Tools A1-A5, K1 |
| 6 | O5 scheduled tasks | SEO1-SEO3 |
| 7 | O7, J3b | D0-D5 domains + onboarding |
| 8 | O6; J2 client package | SEO4, SEO6; Content M1, K2, Z1 |
| After O4 + J1 | | CH3, T1, C2, SEO5, Studio render S1 |
| Later | | CH4, CH5, CH6, client doors |

**Why:**
1. **Consent first:** the live funnel collects mobile numbers with no consent record; every funnel and WhatsApp slice needs it; 12 h.
2. **Funnel next:** sales is the focus, the VSL page turns traffic into booked calls, and it needs no computer.
3. **Lane A in parallel:** it fixes a hard rule (Adon's work on CC's sign-in) and unblocks downloads, renders, agent SEO fixes and Telegram teammates.
4. **Domains before the first done-for-you client,** not before OASIS's funnel, which lives on oasisai.work.
5. **Slack and Telegram alerts are cheap,** mostly vendor-app actions.

## 7. Questions for Adon (one tap each)

1. **Order:** funnel (consent, then VSL pages) first, domains after SEO tools. Recommend: yes. [Funnel first] [Domains first]
2. **Consent:** OCC records it for every workspace; Opt-in Vault stays for SunBiz. Recommend: our own record. [Our own record] [Opt-in Vault for all]
3. **AI page writer:** writes headlines, sections, FAQ, video script; never results, prices, bonuses or guarantees. Recommend: yes. [Those stay manual] [AI drafts them too]
4. **DNS for done-for-you clients:** the client taps approve on each plan. Recommend: client approves. [Client approves] [OASIS applies after the vault]
5. **Shared Telegram:** a new OASIS bot in a group with you and CC; CC's bridges stay his. Recommend: new bot. [New OASIS bot] [Reuse a bot]
6. **Paid SEO data:** free sources until the audit tool is in use, then DataForSEO ($50, capped). Recommend: free first. [Free first] [DataForSEO now]

## 8. Not verified

- Whether anything outside OCC reads "Ask for copy".
- Which bot the OASIS Telegram card holds (fix pack checking).
- CC's provisioning and DNS scripts (repo not readable with our token).
- How oasisai.work attaches to the Worker; Cloudflare for SaaS pricing and routing (D0).
- PageSpeed / Chrome UX Report keys held.
- Slack's current limits for apps outside its Marketplace.
- No live URL probed (network guard); `/vsl` missing is from code. No tests run; read-only design.
