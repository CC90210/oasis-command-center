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
  an owner's confirmation; a bonus value or price needs an owner's confirmation;
  the guarantee shows only once its terms are confirmed; every sentence the linter
  flags needs an owner's tick, stored under the sentence's sha256 (editing the
  sentence clears it). The server stamps every confirmation with the saving
  owner and the time, and saving the same content again keeps the first stamp.
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

## Known limits (the owner's call)

- **The claims linter reads the page's copy, not the form's.** The Book section
  draws the form's own step titles, field labels and thank-you message. None of
  that is linted, including the default thank-you, "A specialist will reach out
  within one business day." Edit the form's words in the Form & booking tab, or
  ask for the linter to cover them.
- The claim words are: clients, results, guarantee(d), proven, revenue, booked,
  refund, money back, risk-free, ROI, profit, savings; plus money, numbers,
  percentages and multipliers.

## Not in this version

Booking on the page (PR3: our own slot picker), attribution, stats, copy-pack
import and the confirmation email (PR2), uploaded result screenshots, the light
canvas, and the OG image. The Book section is the form, then the workspace's
booking link (OASIS), or "tell us two times that suit you" by email when no
link is set, or an honest "we'll be in touch".
