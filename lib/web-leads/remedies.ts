/**
 * lib/web-leads/remedies.ts — the script a rep reads instead of a defect list.
 *
 * quality-model.js (JARVIS, services/leadgen/lib/quality-model.js) can tell you
 * a site is missing `tel_link`. That is true and unsellable. What a rep needs
 * on the phone with a plumber is two sentences: what this is costing them, in
 * plain behaviour a busy owner recognises, and what we would build instead.
 * The cost names a specific way a visitor is lost, not a moral judgement about
 * the prospect's website. The fix describes something we deliver, so it
 * doubles as scope for the sale.
 *
 * WHY THIS COPY LIVES HERE, NOT IN JARVIS: it was originally written into
 * JARVIS (services/leadgen/lib/remedies.js) alongside the scoring model, but
 * JARVIS never reads it — only this UI renders it, to a rep, on a call. Copy
 * is a display concern and belongs beside the component that renders it, not
 * beside the scoring logic that produces the codes it explains. Ported
 * verbatim (2026-08-21): the wording was written to be read aloud and was
 * reviewed for plain speech, so it is not reworded here, only retyped.
 *
 * One entry per code in CHECKS (JARVIS lib/quality-model.js), enforced by
 * tests/web-leads-remedies.test.ts — a missing entry there is a hole in the
 * product, not a cosmetic gap.
 */

export type Remedy = { costs: string; fix: string };

export const REMEDIES: Record<string, Remedy> = {
  // ---- conversion ----
  tel_link: {
    costs: "A visitor on a phone has to copy your number by hand to call you. Most of them just leave instead.",
    fix: "A tap-to-call button in the header of every page, so calling you takes one thumb.",
  },
  phone_in_header: {
    costs: "Your number is somewhere down the page. Someone who is ready to call has to hunt for it first.",
    fix: "Your phone number pinned at the top of every page, visible before anyone scrolls.",
  },
  contact_form: {
    costs: "There is no way to reach you except by phone. Anyone who would rather send a quick message has no option and moves on.",
    fix: "A short contact form on every page, so a visitor can reach you without picking up the phone.",
  },
  short_form: {
    costs: "Your form asks for so much before someone can send it that most people quit halfway through.",
    fix: "A form trimmed to name, number and the job, so finishing it takes under a minute.",
  },
  cta_present: {
    costs: "A visitor can read the whole page and still not know what you want them to do next, so they do nothing.",
    fix: "One clear button on every page telling a visitor exactly what to do next, like Call Now or Get a Quote.",
  },
  cta_above_fold: {
    costs: "The only button telling someone what to do is buried below a screen of scrolling. Most people never see it.",
    fix: "That same button moved to the very top of the page, so it is the first thing anyone sees.",
  },
  booking: {
    costs: "Someone deciding at eleven at night has no way to lock in a time. By morning they have called someone else.",
    fix: "An online booking calendar so a customer can grab a slot themselves, any hour of the day.",
  },
  email_route: {
    costs: "A visitor who would rather write than call has no address to send a message to and no form either.",
    fix: "A working email address and a simple form, so a message reaches you even outside business hours.",
  },
  chat: {
    costs: "A visitor with a quick question has to call or wait on an email reply. Many will not bother with either.",
    fix: "A simple chat box so a quick question gets a quick answer while the visitor is still on the page.",
  },
  multi_route: {
    costs: "Phone is the only way to reach you. Anyone who cannot take a call right then has no other option and drops off.",
    fix: "At least two more ways to reach you, like a form and email, so a call is never the only option.",
  },

  // ---- trust ----
  testimonials: {
    costs: "Nothing on the site says anyone has hired you before. A stranger has only your word for it.",
    fix: "Real customer quotes with names and locations, placed next to the work they are about.",
  },
  review_platform: {
    costs: "Your reviews live only on Google or Facebook, if anywhere. A visitor has to leave your site to find proof you are good, and most will not bother.",
    fix: "Your best reviews pulled onto the site itself, right where someone is deciding whether to call.",
  },
  credentials: {
    costs: "Your licence and insurance are not shown, so a careful customer cannot tell you are covered.",
    fix: "Licence number, insurance and any certifications shown plainly near your contact details.",
  },
  real_photos: {
    costs: "The photos on the site are stock images or missing entirely, so a visitor has no idea what your actual work looks like.",
    fix: "Real photos of your crew and finished jobs, so a visitor sees exactly what they would be paying for.",
  },
  address: {
    costs: "There is no street address anywhere on the site, so a cautious visitor cannot tell if you are a real local business or a stranger from out of state.",
    fix: "Your business address shown clearly, so a visitor can confirm you are local before they call.",
  },
  map: {
    costs: "A visitor cannot see where you are or how close you are to them without leaving the site to look it up separately.",
    fix: "A map on the contact page showing exactly where you are, so distance stops being a question mark.",
  },
  years_trading: {
    costs: "Nothing tells a visitor how long you have been doing this, so a brand-new competitor and a twenty-year business look identical.",
    fix: "A line stating how many years you have been in business, right where trust decisions get made.",
  },
  guarantee: {
    costs: "There is no promise backing the work, so a nervous customer has no reason to pick you over a competitor who offers one.",
    fix: "Your guarantee or warranty spelled out plainly, so hesitation has an answer before it becomes an objection.",
  },
  social_proof: {
    costs: "There are no active social profiles linked from the site, so a visitor checking you out one more time before calling finds nothing.",
    fix: "Your social profiles linked and kept current, so a last look before calling finds an active business.",
  },

  // ---- design ----
  modern_layout: {
    costs: "The page does not line up cleanly on different screens. Boxes overlap or spill off the side, and it reads as unfinished.",
    fix: "A layout that lines up correctly on any screen size, built with current tools instead of patched-together code.",
  },
  web_fonts: {
    costs: "The text is set in whatever plain font a visitor happens to have installed, so the site looks unfinished before anyone reads a word.",
    fix: "Proper typography chosen to match your brand, so the page looks designed rather than left on default settings.",
  },
  not_default_tpl: {
    costs: "The site looks like a stock template, so it reads as a side project rather than a real business.",
    fix: "A designed layout built around your actual services and photographs, not a theme with your name on it.",
  },
  image_rich: {
    costs: "The page is mostly text with almost no pictures, so there is little to hold someone's eye or show them what you actually do.",
    fix: "Photos placed throughout the page, so a visitor sees your work instead of just reading about it.",
  },
  no_dated_markup: {
    costs: "Parts of the page are built the way sites were built fifteen years ago, and it shows: things misalign or look broken on newer devices.",
    fix: "The whole page rebuilt with current code, so it displays correctly and consistently everywhere.",
  },
  consistent_brand: {
    costs: "There is no consistent logo or colour scheme, so the site does not look like it belongs to one business, let alone a memorable one.",
    fix: "A logo and a consistent set of colours used across every page, so the business looks put together.",
  },
  favicon: {
    costs: "The little icon in the browser tab is blank or a generic default, a small tell to anyone with five tabs open that this site was never finished.",
    fix: "A small custom icon in the browser tab with your logo on it, a finishing touch that says the site was actually built.",
  },
  no_builder_badge: {
    costs: "A free website-builder logo sits at the bottom of every page, telling every visitor this was assembled from a template rather than built for the business.",
    fix: "That badge removed and replaced with a page footer that looks like it belongs to your business, not a builder tool.",
  },

  // ---- mobile ----
  viewport: {
    costs: "On a phone the page shows up shrunk to fit, so everything is too small to read or tap.",
    fix: "A layout built for phones first, since that is where most of your visitors are.",
  },
  responsive_css: {
    costs: "The layout does not change shape for a smaller screen, so a phone visitor sees a shrunken desktop page instead of one built for their screen.",
    fix: "A layout that reshapes itself for phones, tablets and desktops, so it looks right no matter what someone is holding.",
  },
  no_fixed_width: {
    costs: "The page is locked to one fixed size, so on a narrower phone screen a visitor has to scroll sideways just to read a sentence.",
    fix: "A page that stretches and shrinks to fit the screen it is on, so nobody ever has to scroll sideways.",
  },
  tap_targets: {
    costs: "The phone number and menu are sized for a mouse, not a thumb. On a phone, tapping the right thing takes two or three tries.",
    fix: "Buttons, the phone number and the menu all sized for a thumb, so tapping the right thing works the first time.",
  },
  no_flash: {
    costs: "Part of the page relies on old plugin technology that phones and current browsers refuse to run at all, so that section is simply invisible to most visitors.",
    fix: "That section rebuilt in current code that every phone and browser can actually display.",
  },

  // ---- content ----
  substantial: {
    costs: "There is barely a paragraph of real information on the page, so a visitor cannot learn enough to decide whether to call.",
    fix: "Real, specific copy about your services and how you work, enough for a visitor to make an informed decision to call.",
  },
  service_detail: {
    costs: "Services are listed as a word or two each with no detail, so a visitor cannot tell which of their problems you actually handle.",
    fix: "A page for each service explaining what it covers, so a visitor recognises their exact problem and calls about it.",
  },
  headings: {
    costs: "The page is one long block of text with no section titles, so a visitor skimming on their phone cannot find the part that matters to them.",
    fix: "Clear section titles breaking the page into skimmable pieces, so a rushed visitor finds their answer in seconds.",
  },
  service_area: {
    costs: "The page never says which towns or areas you actually serve, so someone nearby has to guess whether you even cover their address.",
    fix: "Your service area spelled out by name, so a visitor knows in one glance that you cover their town.",
  },
  pricing_signal: {
    costs: "There is no hint of cost anywhere, not even a starting range, so a price-shy visitor assumes the worst and calls a competitor instead.",
    fix: "A starting price, price range, or a clear free-quote offer, so cost stops being the unspoken reason people do not call.",
  },
  fresh: {
    costs: "The copyright date and the content both look untouched for years, so a visitor wonders if you are even still in business.",
    fix: "The site kept current with a fresh copyright date and up-to-date details, so it reads as an active business.",
  },

  // ---- performance ----
  fast_ttfb: {
    costs: "The page takes long enough to appear that some visitors give up before they see anything.",
    fix: "Faster hosting and lighter pages, so the site is on screen in about a second.",
  },
  lean_html: {
    costs: "Your pages carry a lot of extra weight that makes them slow to open on a phone, especially on a weak signal at a job site.",
    fix: "Pages trimmed down to load quickly, even on a slow phone connection out in the field.",
  },
  few_blocking: {
    costs: "A pile of extra code has to load before the page will even show up, so visitors stare at a blank screen longer than they will wait.",
    fix: "The page rebuilt to show up first and load the extras quietly after, so visitors see something instantly.",
  },
  https: {
    costs: "Browsers flag the site as not secure, and some visitors, especially anyone about to fill out a form, will close the tab the moment they see that warning.",
    fix: "A secure connection with the lock icon browsers look for, so nothing warns a visitor away before they even read a word.",
  },

  // ---- discoverability ----
  title: {
    costs: "The browser tab and the search result both show a blank or generic label instead of your business name, so people scanning results skip right past you.",
    fix: "A clear page title with your business name and what you do, so you stand out in a list of search results.",
  },
  meta_desc: {
    costs: "Search engines have nothing to show under your listing but a stray line of code, so your search result looks broken next to competitors with a real description.",
    fix: "A short, written description under your listing in search results, so people know what you offer before they click.",
  },
  local_schema: {
    costs: "Search engines cannot tell where you are or what you do, so you show up less in local results.",
    fix: "Your business details published in the format search engines read, so local searches find you.",
  },
  og_tags: {
    costs: "When someone shares your link in a text or on social media, it shows up as a bare blue link with no picture or preview, so it gets ignored in a crowded feed.",
    fix: "A proper preview image and description set up so your link looks like a real business when it is shared or texted.",
  },
  h1: {
    costs: "The page has no obvious main heading, so a visitor landing there and a search engine scanning it both have to guess what the page is even about.",
    fix: "One clear main heading at the top of each page stating exactly what it is about.",
  },
  analytics: {
    costs: "There is no way to see how many people visit the site, where they come from, or what they do once they land, so every marketing decision is a guess.",
    fix: "Visitor tracking installed so you can see real numbers and know what is actually working before you spend on more marketing.",
  },
  sitemap: {
    costs: "There is no list of pages handed to search engines, so some pages on your own site may never get found and indexed at all.",
    fix: "A page list submitted to search engines, so every page you have gets found and indexed properly.",
  },
};

export function remedyFor(code: string): Remedy | null {
  return REMEDIES[code] || null;
}

const remediesModule = { REMEDIES, remedyFor };
export default remediesModule;
