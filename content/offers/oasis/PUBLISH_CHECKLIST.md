# OASIS offer pages: publish checklist

The five pages in this folder (the "Start here" router plus PROTOCOL, COMMAND, COMMUNITY and FLEET) are seeded
by `scripts/seed-oasis-offer-pages.ts` as **drafts behind switched-off forms**. Nothing here is public. A page goes
live only when Adon or CC has confirmed every item below, switched its form On, and pressed Publish in the builder.

The builder's claims gate (`lib/offer-pages/claims.ts`, `publishGate`) enforces part of this list on its own:
the form must be On, every flagged sentence needs an owner's tick, every bonus value and every video's rights
need a confirmation. The rest only a person can check.

**Order matters.** A tick is stored against the exact sentence, so editing a sentence clears its tick. Settle the
currency and the price ranges first, edit the copy, and tick the flagged sentences last.

---

## 1. Every page

- [x] **Currency: USD** (owner decision 2026-10-16). Prices are set in USD. A pricing tier may also carry an
      optional Canadian price (`price_cad`, for example "CA$690"), drawn as a smaller "or CA$690" line under the
      USD price and confirmed with the rest of the tier.
- [ ] **Telegram link is the right group:** `https://t.me/+w_8rgh8YBWg4YmM5` (HANDOVER decision 3). It belongs in
      server config for `/go/community`, never in a page.
- [x] **The "Not ready? Join the free community" link is drawn** (done: `components/offer-pages/CommunityLink.tsx`
      on main draws it on every offer page once the workspace's community URL is set, `lib/offers/community-link.ts`).
      Each file still carries it as `community_link` (`/go/community?form=<slug>&t=oasis-ai-cc`).
- [x] **`/go/community` exists** (done: `app/go/community/route.ts` on main, slice V5, HANDOVER section 5.4).
- [ ] **Cancellation wording is true.** Every monthly plan says "Cancel any time from your account; no cancellation
      fee." Confirm a client can actually cancel from their account (for example a Stripe customer portal). If not,
      replace it with the real cancel path before publish. Quebec auto-renewal rules apply.
- [ ] **VSL recorded** (Adon and CC on camera, HANDOVER section 7), ingested into Library as an OASIS asset and
      picked in the builder's VideoPicker.
- [ ] **Video rights ticked honestly:** founders' own footage, licensed music and b-roll only.
- [ ] **Transcript:** each hero carries the recording SCRIPT (`vsl_script`), with `show_transcript` off. After
      recording, replace the script with the real transcript, then switch `show_transcript` on. Turning it on also
      sends the transcript through the claims linter, which will flag the prices it says out loud.
- [ ] **"How it works" section:** the page schema requires a video for each step, so the `work` section is left
      out. The three steps are in each file's `work_steps` and in the FAQ answer "How does it work?". Add the
      section once each step has its screen recording.
- [ ] **No results, testimonials, statistics or guarantee** are on any page; those sections are omitted. Add one
      only with evidence, the client's permission and an owner's tick (the gate enforces this).
- [ ] **Every flagged sentence in section 7 ticked** in the builder, after the edits above.
- [ ] **Form switched On, then Publish.** The gate refuses while the form is off.
- [ ] **Public paths:** until slice V6 ships short paths, the pages live at `/f/oasis-ai-cc/<slug>`
      (`vsl`, `protocol`, `command`, `community`, `fleet`).
- [ ] **Slugs free in production.** The seed has not been run against production. Its dry run reports any form
      already using one of these slugs (`--tenant-slug oasis-ai-cc --dry-run`), and it never touches a form it did
      not create.

## 2. Router (`vsl`, "Start here")

- [ ] **Routing is not automatic yet.** The rules are data in `vsl.json` (`routing_rules`), a first cut from
      HANDOVER section 4. Nothing reads them until slices V2 and V5. Until then the router only records the answers
      and its thank-you tells the visitor to open the page for the path they picked. Publish the router after V2,
      or accept a router that does not route.
- [ ] **Rule order.** The HANDOVER table overlaps (a COMMAND pick with no budget also matches the COMMUNITY row;
      a $250K+ business with a $2K+ budget matches both COMMAND and FLEET). Confirm the order. The table also
      routes team size 21+ to FLEET; the router does not ask team size (FLEET's own form does).
- [ ] **The founder story in the 12-minute VSL is your own, true account.** The script gives the structure and
      the factual lines only; the story beats are prompts in square brackets.
- [ ] `?cat=p1..p4` preselecting a card and `kw=` being recorded arrive with V2 and V5.

## 3. PROTOCOL (`protocol`)

- [ ] **One number for each range:** 1A $17 to $47, 1B $97 to $197, 1D $97 to $395.
- [ ] **Stripe Payment Links** for each pack (1A to 1D), the two add-ons ($27 prompt pack, $47 video vault) and
      the 1B two-payment plan ($59 x 2). Until they exist, the form and the FAQ promise "A member of the OASIS team
      will email you a secure checkout link": confirm someone owns sending it, or point the form's redirect at the
      Payment Link once it exists.
- [ ] **Delivery is not built** (HANDOVER section 4). The page deliberately says nothing about how or when a pack
      arrives. The funnel doc lists 1C as a lifetime library key and 1D as an instant vault key in OCC; add either
      only once it is real.
- [ ] **"No. Each pack is a one-time purchase. Nothing renews."** Confirm.
- [ ] **1B "with private template access"** (funnel fulfilment column) and **1D "You find out what is inside when
      you open it"** (the meaning of "mystery") are accurate.
- [ ] Downsells kept off the page on purpose: 1C to 1B at $147, 1D to 1A at $47 (checkout-flow offers, not page copy).

## 4. COMMAND (`command`)

- [ ] **One number for the range:** 2C $2,500 to $3,500 a month.
- [ ] **Expedited VIP vault bonus: confirm its value and what it includes.** The funnel doc gives "$500 value";
      the page shows no value until an owner confirms it (a value on a bonus needs an owner's confirmation in the
      builder). The page says "We walk you through what it includes on the call", so someone must be able to.
- [ ] **Booking link set in the workspace.** The Book section shows the workspace's booking link after the contact
      step; with none, the visitor is only told we will reach out. The thank-you says "We will confirm your
      discovery call by email": confirm who does.
- [ ] **Starting on the call:** the FAQ says "If it is a fit, you can start on the call." The funnel doc closes
      with a Stripe link in chat. Confirm Stripe links exist for OS DIY, Turnkey (including the two-payment
      setup) and the managed partner.
- [ ] **The 7-day setup clock** ("starts when it is 100% submitted") is offered exactly as stated.
- [ ] **The product claim** in the hero and the VSL ("answers new leads, books the call and keeps the back office
      moving") is what a client workspace does today.
- [ ] **VIP at "$97 a month"** in the downsell answer must match the single number Adon picks for the 3B range
      ($47 to $97).

## 5. COMMUNITY (`community`)

- [ ] **One number for each range:** 3B $47 to $97 a month, 3C $2,500 to $5,000 a month.
- [ ] **Stripe Payment Link for the VIP mastermind** (HANDOVER publish checklist item 6).
- [ ] **"With weekly build clips"** in the free lounge: confirm they are posted.
- [ ] **Who reviews mentorship applications,** and who sends "the next step" the thank-you promises to VIP and
      mentorship askers. Any nurture send must pass `marketingSendAllowed` and the one send gate.
- [ ] The innocence gate works as the HANDOVER describes: "Yes, I have a budget" shows the VIP room, mentorship and
      COMMAND as choices. Choosing COMMAND does not redirect anyone; that arrives with V5.

## 6. FLEET (`fleet`)

- [ ] **One number for each range:** 4A $2,500 to $7,500, 4B $5,000 to $15,000+, 4C $2,000 to $5,000.
- [ ] **The audit fee is "credited in full to the build"** (funnel doc: 100% credited). Confirm the terms.
- [ ] **"The master protocol suite ... includes a self-audit protocol":** HANDOVER maps FLEET's downsell
      (self-audit protocol, $297) to PROTOCOL 1C. Confirm the suite contains it.
- [ ] **4C is titled "Website rebuild"**, not "High-converting website rebuild": "high-converting" is a performance
      claim with no evidence yet. Restore it only with evidence.
- [x] **`/ai-audit` decision: FLEET keeps its own form** (owner decision 2026-10-16). The AI Automation Audit keeps
      its own page and its own live form: its page copy comes as a page-only file (`ai-audit.page.json`, loaded by
      `--refresh-drafts`), which never changes the form's steps, name or switch. The seed's separate `fleet` form
      keeps the same field names and option values.

## 7. Sentences the claims linter flags

Each needs an owner's tick in the builder: "true, and we can back it". Generated from `lintDoc` on the drafts as
written; `tests/offer-pages-oasis-content.test.ts` fails if any flagged sentence is missing from this list.

### Router (`vsl`): 6

| Where | Why | Sentence |
|---|---|---|
| `what_you_get.items[0].body` | money, a number | The SOPs, prompts and blueprints OASIS runs on, from $17 for a quick-win pack to $297 for the full suite. |
| `what_you_get.items[1].body` | money, a number | For service businesses doing roughly $10K to $75K a month. |
| `what_you_get.items[1].body` | money, a number | Follow-up, booking and back office running without you, from $497 a month. |
| `what_you_get.items[3].body` | money, a number | It starts with an enterprise AI and security audit, from $2,500, credited in full to the build. |
| `faq.items[0].a` | the word "revenue" | We also ask about revenue and budget so we can point you to the page that fits, and you can change your mind on any page. |
| `faq.items[2].q` | the word "revenue" | Why do you ask about revenue and budget? |

### PROTOCOL (`protocol`): 7

| Where | Why | Sentence |
|---|---|---|
| `what_you_get.items[0].title` | money, a number | Quick-win SOPs and prompt packs: $17 to $47 |
| `what_you_get.items[0].body` | money, a number | Optional add-on: an extra prompt pack for $27. |
| `what_you_get.items[1].title` | money, a number | System blueprints and workflows: $97 to $197 |
| `what_you_get.items[1].body` | money, a number | Two payments of $59. |
| `what_you_get.items[1].body` | money, a number | Optional add-on: the video vault for $47. |
| `what_you_get.items[2].title` | money, a number | Master protocol suite: $297 |
| `what_you_get.items[3].title` | money, a number | Mystery digital vault: $97 to $395 |

### COMMAND (`command`): 8

| Where | Why | Sentence |
|---|---|---|
| `what_you_get.items[0].title` | money, a number | OS DIY: $497 a month, no setup fee |
| `what_you_get.items[1].title` | money, a number | OS Turnkey, done for you: $2,500 setup + $997 a month |
| `what_you_get.items[1].body` | a percentage, a number | You fill in the onboarding vault (your logins, documents and channels), and the 7-day setup clock starts when it is 100% submitted. |
| `what_you_get.items[1].body` | money, a number | Two payments of $1,400. |
| `what_you_get.items[2].title` | money, a number | Managed operating partner: $5,000 setup + $2,500 to $3,500 a month |
| `faq.items[0].a` | a number | It is a 45-minute video call. |
| `faq.items[4].a` | money, a number | Turnkey's setup can be split into two payments of $1,400. |
| `faq.items[4].a` | money, a number | You can also start on OS DIY at $497 a month with no setup fee, or join the VIP mastermind at $97 a month and build alongside us first. |

### COMMUNITY (`community`): 3

| Where | Why | Sentence |
|---|---|---|
| `what_you_get.items[0].title` | money, a number | Free Telegram lounge: $0 |
| `what_you_get.items[1].title` | money, a number | VIP mastermind: $47 to $97 a month |
| `what_you_get.items[2].title` | money, a number | One-on-one founder mentorship: $2,500 to $5,000 a month |

### FLEET (`fleet`): 6

| Where | Why | Sentence |
|---|---|---|
| `what_you_get.items[0].title` | money, a number | Enterprise AI and security audit: $2,500 to $7,500 |
| `what_you_get.items[1].title` | money, a number | Bespoke multi-agent fleets: $5,000 to $15,000+ |
| `what_you_get.items[2].title` | money, a number | Website rebuild: $2,000 to $5,000 |
| `what_you_get.items[2].body` | money, a number | Start with a $500 website audit. |
| `faq.items[3].a` | money, a number | The master protocol suite on the PROTOCOL page includes a self-audit protocol your team can run in-house for $297. |
| `faq.items[3].a` | money, a number | For the website alone, start with the $500 website audit. |

### AI Automation Audit (`ai-audit`): 3

| Where | Why | Sentence |
|---|---|---|
| `work.title` | a number | Three steps, and you stay in control |
| `work.items[0].body` | the word "revenue" | Revenue and budget are optional. |
| `faq.items[3].q` | the word "revenue" | Do I have to share revenue or budget? |

Not flagged, but still a commitment to confirm (sections 1 and 3 to 6 above): the cancellation sentence, "Nothing
renews", the bonus line, every thank-you message, and every promise to email someone.

## 8. AI Automation Audit (`ai-audit`, page only)

Copy from Maven (CMO-Agent `output/offer-pages/ai-audit.json`, 2026-10-16), loaded as `ai-audit.page.json` by
`--refresh-drafts`; the live form keeps its own steps. Checked against the live form: revenue, team size and budget
are optional, as the page says.

- [ ] **"Conaugh reads every one personally"** (hero, book, what you get). Confirmed wording 2026-10-08.
- [ ] **"Follows up with you personally"** on every completed audit (hero, how it works, FAQ).
- [ ] **The follow-up gives "a straight answer on where AI fits".** No written report, instant reply or same-day call
      is promised anywhere on the page.
- [ ] **Routing:** larger operations to FLEET, unready ones to the free community (what you get, FAQ).
- [ ] **How a call gets booked today** (FAQ "he will set up a time with you"). When the public booking calendar ships,
      the FAQ can say "pick a time right after you submit".
- [ ] **Hero video:** none yet. Maven's window-light audit film (9:16 and 16:9) waits on the narrator voice; attach it
      with its rights tick in the builder.
