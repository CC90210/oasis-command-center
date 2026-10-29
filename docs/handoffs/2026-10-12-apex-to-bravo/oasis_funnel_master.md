# OASIS AI master funnel (context from Adon, 2026-10-11; condensed faithfully from his pasted doc)

Source of truth for the original: CC's repo Business-Empire-Agent `docs/funnel/OASIS_MASTER_HANDOVER_AND_SALES_ENGINE.md`, `oasis_funnel_tv.html`, `oasis_funnel_diagram.html`. Primary domain: https://oasisai.work.

## Flow
1. Traffic: organic social authority (CC's sobriety logs, Reels, X, LinkedIn), paid performance ads (speed-to-lead pain hooks, cost of inaction), retargeting proof.
2. Inbound setter: ManyChat answers a comment keyword in under 15 s and opens the DM; an agentic setter on CC's machine (`pm2.bravo-ig-dm`, `instagram_dm_poller.py` + `ig_closer.py`) qualifies and drops a deep link.
3. VSL intake landing page `https://oasisai.work/vsl`: 12-minute "epiphany bridge" founder video (founder pain to autonomous OS), then a 4-category single-click selector; each category loads its own qualification questions.
4. Form submit (under 60 s): write `leads` + `tenant_records` in Turso; log TCPA/CASL consent with IP and timestamp; immutable `lead_interactions` row; alert @sales; SMS/email via the send gateway; background domain research.
5. Inline calendar reveal on the SAME page (no redirect); booking syncs to Google Calendar AND OASIS Schedule (Team > Schedule).
6. Triage router (self-selection + revenue + operational intent) dispatches to one of 4 pillars.
7. Universal save basin: anyone who stalls goes to the free Telegram community ($0) with a 72 h proof drip; ascension engine nurtures upward.

## Deep links by keyword
| Keyword | Avatar | Offer | Link |
|---|---|---|---|
| PROTOCOL | solopreneurs | digital SOPs, prompt vaults, mystery bundles | /vsl?cat=p1&kw=PROTOCOL |
| COMMAND | service SMBs ($20K-75K/mo) | Command Center OS (DIY $497/mo or Turnkey $2,500 + $997/mo) | /vsl?cat=p2&kw=COMMAND |
| COMMUNITY | early builders, agencies | free Telegram + VIP mastermind ($47-97/mo) | /vsl?cat=p3&kw=COMMUNITY |
| FLEET | mid-market, corporate | enterprise AI audit ($2.5K-7.5K), bespoke fleets ($5K+) | /vsl?cat=p4&kw=FLEET |

## The 4 pillars and tiers
| Code | Tier | Price | Target | Downsell | Ascension | Fulfilment |
|---|---|---|---|---|---|---|
| 1A | Quick-win SOPs + prompt packs | $17-47 | beginners | free Telegram | bump +$27 prompt pack | instant digital delivery |
| 1B | System blueprints + workflows | $97-197 | DIY builders | 2-pay ($59 x 2) or free Telegram | bump +$47 video vault | private template access |
| 1C | Master protocol suite | $297 | agency owners | 1B ($147) | apply for OS DIY ($497/mo) | lifetime library key |
| 1D | Mystery digital vault | $97-395 | advanced builders | 1A ($47) | VIP mastermind | instant vault key in OCC |
| 2A | OS DIY core platform | $497/mo, no setup | tech-fluent SMBs ($10K-30K/mo) | VIP mastermind ($97/mo) | Turnkey | Cloudflare Worker + Turso provisioning |
| 2B | OS Turnkey done-for-you | $2,500 setup + $997/mo (2-pay $1,400 x 2) | service SMBs ($20K-75K/mo) | 2-pay or DIY | Managed partner | OCC onboarding vault, then agent configuration; 7-day SLA starts only when the vault is 100% submitted |
| 2C | Managed operating partner | $5,000 setup + $2,500-3,500/mo | established businesses | Turnkey; stalls to Telegram | custom fleets ($5K+/mo) | dedicated fleet ops + weekly audit |
| 3A | Free Telegram lounge | $0 | everyone who stalls | permanent orbit | weekly build clips | invite link + welcome drip |
| 3B | Paid VIP mastermind | $47-97/mo | builders with budget | churn to 3A | mentorship or OS | weekly build room |
| 3C | 1-on-1 founder mentorship | $2,500-5,000/mo | high-growth founders | 3B or OS | equity/rev share | private Telegram with CC |
| 4A | Enterprise AI + security audit | $2,500-7,500 | mid-market | self-audit protocol ($297) | 100% credited to the build | SOW report + roadmap |
| 4B | Bespoke multi-agent fleets | $5,000-15,000+ | multi-location | audit or OS | infrastructure retainer | Cloudflare/Docker fleets |
| 4C | High-converting website rebuild | $2,000-5,000 | SMBs with weak pages | website audit ($500) | forms wire into OCC CRM | Next.js on Cloudflare |

Community entry has an "innocence questions" gate: "Are you sure you want free self-serve?" and "Do you have a budget?".

## Discovery call (Google Meet / OASIS Meet), 45 min
Screen off 0-20: hook and disarm, situation (prospect talks 80%), bleeding-neck pain quantified, reframe from tool vendor to autonomous OS partner, co-create the ideal week. Screen on 20-45: consequence of doing nothing for 6 months, architecture walk of OCC tailored to the pain, live "math for them" ROI (deal size x leaked deals; payback = (setup + month) / deal size), trial close 1-10 + LAER objections, close with Stripe link in chat + expedited VIP vault bonus ($500 value). Fork at minute 40: won, or downsell ladder 2-pay -> DIY $497/mo -> VIP $97/mo + $197 blueprints -> save basin (tag call_stall, 72 h case-study drip).

## Onboarding events
`intake.submitted` (from /vsl into Turso), `call.scheduled` (Google Calendar + OASIS Schedule), `onboarding.vault_submitted` (triggers the provisioning agent to configure the tenant), `save_basin.enrolled`. Onboarding vault at https://oasisai.work/onboarding: clients enter credentials, sign legal docs, configure channels.

## Compliance reminders (estate rules)
Consent evidence (TCPA/CASL, Quebec Law 25) is logged per lead. Public or scraped contact data is not consent. No em dashes in customer-facing copy. Client-facing UI never names house agents (Bravo, Maven, Atlas, Aura, APEX, Knut).
