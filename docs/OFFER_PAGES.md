# Offer pages

An **offer** is a public landing page attached to one form. A form without one
is an **intake form**, and renders exactly as it always has.

Code name: **offer page** (`lib/offer-pages/`, `components/offer-pages/`, table
`form_offer_pages`). Never a bare "offer": that word is the retired SunBiz lender
entity, and `/offers` is its 404 route (`tests/os-redirects.test.ts`).

## Where things live

| What | Where |
|---|---|
| The page content | `form_offer_pages` (migration `database/turso/bravo__203_form_offer_pages.sql`), one row per form: a draft copy and a published copy of one JSON document |
| The document and its strict parser | `lib/offer-pages/types.ts` (`parseOfferPageDoc`) |
| What is drawn (hidden when empty) | `lib/offer-pages/visibility.ts` |
| The claims gate on Publish | `lib/offer-pages/claims.ts` |
| Templates (structure only, no copy) | `lib/offer-pages/templates.ts` |
| Video links (YouTube, Vimeo, Loom) | `lib/offer-pages/providers.ts` |
| Library video: resolve, sign, oEmbed | `lib/offer-pages/video.ts` |
| Reads and writes (missing-table tolerant) | `lib/offer-pages/store.ts` |
| New-lead alerts | `lib/offer-pages/notify.ts` (the send); `lib/offer-pages/alert-status.ts` (the builder's line, in the words of the Telegram card in Connections) |
| The public page | `app/f/[tenant_slug]/[form_slug]/page.tsx`, `components/offer-pages/OfferPage.tsx` |
| The marketing faces, preload off | `app/fonts/offer-fonts.ts` (pinned to the marketing layout's faces by `tests/marketing-accent-parity.test.ts`) |
| The builder | `/forms/[id]/edit`, `components/offer-pages/builder/` |
| Builder routes (owners and admins) | `app/api/forms/[id]/offer/*` (the Preview tab's draft videos: `preview-video`) |
| Public routes (a visitor's browser) | `app/api/offer-page/video`, `app/api/offer-page/captions` (both serve captions through `lib/offer-pages/captions.ts`) |
| A refused field, in the builder's words | `lib/offer-pages/field-labels.ts` |
| Seeding the two OASIS drafts | `scripts/seed-offer-pages.ts` (dry run unless `--apply`) |

## Rules the code holds

- **Nothing public changes until Publish.** No row, a draft, a missing table, or
  any error in the page layer: `/f/<workspace>/<slug>` is today's form, byte for
  byte (`tests/offer-pages-public.test.ts` compares it with a fixture of today's
  markup). Unpublish turns the link back into the plain form at once.
- **An offer's name is internal.** A form with an offer page and no headline of
  its own (every form made with New offer) shows its plain form, and its browser
  tab, under the workspace's name. A live page with no headline falls back to the
  form's own headline, then the workspace's name. Never the form's name.
- **Claims need an owner.** A result needs evidence, the client's permission and
  an owner's confirmation; a bonus value or price needs an owner's confirmation
  (a pricing tier's `confirmed`, see below);
  the guarantee shows only once its terms are confirmed; every sentence the linter
  flags needs an owner's tick, stored under the sentence's sha256 (editing the
  sentence clears it). The server stamps every confirmation with the saving
  owner and the time, and saving the same content again keeps the first stamp.
  The owner's preview (`?offer_preview=1`, the builder's Preview tab) also draws
  a price or guarantee nobody confirmed yet, each with a "Not confirmed yet"
  note, so the whole page reads before the ticks; a visitor never gets either
  (`visibility.ts` `unconfirmed`, set only by `render.ts` for the preview).
- **Templates carry structure only.** No invented copy; an empty section is not
  drawn.
- **Video loads on tap.** The server HTML holds a poster and a button: no
  `<video src>`, no `<iframe>`, no player script. A Library video is signed on
  tap, only for a ref in the published page of a live offer on an enabled form,
  for an asset of that form's own workspace and OASIS's own brand that is a
  released cut (approved, scheduled or published). Pulling an asset back to
  review stops it playing at once, on a live page too. The owner's Preview tab
  plays the DRAFT's Library videos through the builder's own route, which
  answers owners and admins of that workspace only.
- **Alerts stay in their workspace.** A new lead alerts through
  `lib/notify/alert-route.ts`: OASIS's own workspaces reach OASIS's chat, a
  client workspace only the bot it connected, a retired workspace nobody.
- **noindex**, always (offer pages stay out of search results).

## One engine, a distinct page per offer

Each offer page is the same document type; what makes the six OASIS offers look
like six different pages is the content plus these three choices. Every one is
optional, so every page stored before them parses and draws exactly as it did
(`tests/offer-pages-engine.test.ts` compares a page without them, byte for byte,
with markup rendered before they existed).

### Hero layout (`theme.layout`)

| Value | Desktop | Builder name |
|---|---|---|
| absent | today's hero: words left, video right (words only, left-aligned, with no video) | shows as "Side by side" |
| `split` | the same as absent, chosen explicitly | Side by side |
| `stacked` | headline, subheadline and button centred on top; the video wide (`max-w-4xl`) below | Video under the headline |
| `centered` | one centred column; the video narrower (`max-w-3xl`) under the words | Centred |

Every layout keeps the hero rules: no Reveal (the hero is the first paint),
the `#offer-hero-end` marker the phone Book bar watches, and on phones the
words, then the video, then the button. Builder: Settings tab, "Hero layout".

### Pricing (`key: "pricing"`)

A body section like the others (after bonuses in the builder's order, in the
Book a call template, pinnable to the top menu, anchor `#pricing`):

```json
{ "key": "pricing", "eyebrow": "...", "title": "...", "lede": "...",
  "currency_note": "Prices in CAD",
  "tiers": [
    { "name": "Turnkey", "price": "From $2,500", "cadence": "a month",
      "summary": "...", "includes": ["...", "..."], "highlighted": true,
      "confirmed": { "by": "<owner's user id>", "at": "2026-10-16T12:00:00.000Z" } }
  ] }
```

- At most 4 tiers (0 is a section being started, and is not drawn), 8
  `includes` lines each, at most one `highlighted`. Caps: name 60, price 40,
  cadence 40, summary 300, an included line 160, the currency note 120.
- `price` is free text, shown exactly as written; it is never turned into a
  number. `confirmed` is the owner's sign-off, the same stamped confirmation
  (who and when) a bonus value carries. Whoever drafts the copy leaves it out;
  the owner ticks it in the builder ("I confirm this price is right. It is
  shown on the page exactly as written"). A bare `true`/`false` is refused by
  the parser. The server stamps it with the saving owner and the time, bound
  to the whole tier (kind "price" in `claims.ts` confirmables): saving the same
  tier again keeps the first stamp, and a tier changed in any way is re-stamped
  with whoever saved the change. The builder also clears the tick when the
  price or how often it is paid is edited, so the owner confirms the new one.
- `price_cad` (optional, cap 40): prices are set in USD (owner decision
  2026-10-16) and this is the Canadian price as written ("CA$690"), drawn as a
  smaller "or CA$690" line under the price, no currency math. It is part of the
  confirmed tier (editing it re-stamps the sign-off and clears the builder's
  tick) and, like the price, is not linted.
- **The gate.** A tier is drawn only with a name, a price and an owner's
  confirmation. Publish is refused while any tier with a price is
  unconfirmed, and the checklist names it: `The price for "Turnkey" (From
  $2,500) needs an owner's confirmation.` (A tier with a name and no price is a
  warning, not a blocker; a hidden pricing section blocks nothing.) The price
  is not also put through the claims linter, since its own tick vouches for
  it; the tier's name, cadence, summary, included lines and the currency note
  are linted like any copy.
- **On the page.** One card per drawn tier, one column on phones and up to
  three or four on desktop; the highlighted card carries the accent (border,
  wash, top rule) and the filled button. Every card ends with the Book button
  (`#book`), so pricing is deliberately NOT one of the sections that add a
  Book button after themselves (no two buttons in a row).

### "Our work" steps without a video

A `work` item's `video` is optional. A step with no video draws as a numbered
card (01, 02... among the video-less steps) with its title and text, and needs
a title to be drawn. A step with a video draws exactly as before, and a step
whose video cannot play is still left out rather than shown as a card. In the
builder: "Add a step", or "Or add a step with its video"; removing a step's
video keeps the step.

## Known limits (the owner's call)

- **The claims linter reads the page's copy, not the form's.** The Book section
  draws the form's own step titles, field labels and thank-you message. None of
  that is linted, including the default thank-you, "A specialist will reach out
  within one business day." Edit the form's words in the Form & booking tab, or
  ask for the linter to cover them.
- **What the linter flags** (narrowed 2026-10-16: the owner was ticking 29
  sentences on OASIS's drafts, most of them noise; 9 now). A sentence is a
  claim when it carries:
  - money ("$497", "from $17", "1200 CAD", "$10K to $75K a month"), a
    percentage ("30% more") or a multiplier ("3x", "10x faster");
  - any digit ("200 clients", "save 20 hours a week", "2 minutes");
  - a spelled-out count, two to sixty, of people, outcomes, time or payments
    ("twelve businesses", "fifty new leads", "three conversions", "twenty
    replies", "twenty hours", "two payments", "three times faster"), or a quantity word
    (hundreds, thousands, doubled, tripled, half);
  - a promised result, either way round ("more revenue", "more qualified
    leads", "grow your leads"; "revenue increased", "results improved", "sales
    are up"), or results described as good ("real results");
  - a superlative ("the best", "#1", "number one", "fastest", "the only",
    "best-in-class", "most trusted", "a leading", "award-winning");
  - who else uses it ("trusted by", "used by", "relied on by", "serving twenty
    clinics", "over eighty agencies", "serving one clinic");
  - a time frame ("same-day", "overnight", "in days", "within hours", "within
    one week", "within one business day");
  - the words guarantee(d), proven, booked, refund, money back, risk-free,
    ROI, profit or savings.

  It does **not** flag a spelled-out number that counts nothing a client could
  hold us to ("Four dashboards, no answer", "One operating view, four
  sections", "Yes, two.", "Three steps, and you stay in control"), a number
  joined to a counted word by a connector rather than counting it ("Three
  steps for clients": words in between may describe, never be "for", "of",
  "your" and the like), or the bare
  words client(s), result(s) and revenue ("Clients" as a section name, "Team,
  Growth, Clients and Money in one view", "Do I have to share revenue or
  budget?"). A question is linted like any sentence, so one with a real signal
  ("Is it proven?") is still flagged. A currency note ("Prices in US dollars")
  is money and stays flagged. The rules and their tests:
  `lib/offer-pages/claims.ts` (`claimReasons`) and
  `tests/offer-pages-claims.test.ts`.

## Not in this version

Booking on the page (PR3: our own slot picker), attribution, stats, copy-pack
import and the confirmation email (PR2), uploaded result screenshots, the light
canvas, and the OG image. The Book section is the form, then the workspace's
booking link (OASIS), or "tell us two times that suit you" by email when no
link is set, or an honest "we'll be in touch".
