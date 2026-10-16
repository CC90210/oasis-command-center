/**
 * offers-screen.test.ts - the Offers screen restructure (R1, HANDOVER section
 * 3: "they literally look the exact same" as the intake forms table).
 *
 * Covers:
 *   1. Offers render as cards (an <article>), intake forms stay a table.
 *   2. An untracked funnel metric (views, video plays, booked, sent to
 *      community) renders "-" with an accessible "not tracked yet" label,
 *      NEVER a 0 - only leads has real tracking today.
 *   3. The "Start here" router card appears only when a form at slug "vsl"
 *      exists; otherwise a quiet empty state with Create.
 *   4. Preview is drawn only for canEdit (Codex review, PR #596): the public
 *      route only honours ?offer_preview=1 for an editor, and since #659 it
 *      draws a switched-off form's draft for its owner too. Since
 *      2026-10-16 it reads "Open draft" on a draft and "Preview changes" on a
 *      live page with newer edits.
 *   6. ONE link per offer (CC, 2026-10-16): a public page's card copies,
 *      opens and shares the landing page; a draft's card never offers Copy
 *      link (that address would show only the bare form) and offers Publish.
 *   5. The router's Create action always submits slug "vsl", never one
 *      derived from the typed name (Codex review, PR #596) - proved as a
 *      pure function (offerCreateSlug) rather than by simulating a click and
 *      a fetch, since this suite has no DOM/fetch-mocking harness. Chained
 *      with (3) above - a form AT slug "vsl" pins as the router card - this
 *      proves end to end that completing the router flow yields the router
 *      card: the only thing the flow controls is which slug gets submitted,
 *      and that is fixed to "vsl" here.
 *
 * (1), (3) and (4) render FormsListClient the same way
 * tests/offer-pages-public.test.ts does: spawned as plain `node --import tsx`
 * (react-dom/server does not resolve under this suite's
 * --conditions=react-server), reusing tests/offer-pages-public.render.ts
 * rather than a second render script.
 *
 * Run: node --conditions=react-server --import tsx tests/offers-screen.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ROOT, done, step } from "./_offer-pages-harness";
import { funnelCell } from "../lib/offers/funnel-strip";
import { offerCreateSlug, slugTakenMessage, ROUTER_SLUG } from "../lib/offers/router-create";

const AT = "2026-10-08T12:00:00.000Z";
const row = (id: string, slug: string, name: string, enabled = true) => ({
  id,
  slug,
  name,
  description: null,
  enabled,
  created_at: AT,
  updated_at: AT,
});

type Scenario = { kind: "list"; props: Record<string, unknown> };

function render(scenarios: Record<string, Scenario>): Record<string, string> {
  // Same isolation tests/offer-pages-public.test.ts uses: strip --conditions
  // from NODE_OPTIONS so the child's react-dom/server resolves.
  const childNodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions };
  if (!childNodeOptions) delete childEnv.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ["--import", "tsx", join("tests", "offer-pages-public.render.ts")], {
    env: childEnv,
    input: JSON.stringify(scenarios),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  assert.equal(child.status, 0, `render child failed:\n${child.stderr}`);
  return JSON.parse(child.stdout) as Record<string, string>;
}

/** A Copy link BUTTON was drawn (its tooltip), not merely the words in the help text. */
const COPY_BUTTON = /title="(Copy the landing page|Copy the public link\. Anyone)/;

async function main() {
  console.log("offers-screen:");

  // -- 2. funnelCell: the pure rule, no React involved -----------------------
  await step("a tracked value (including a real zero) shows its number, with no accessible label", () => {
    assert.deepEqual(funnelCell(5), { text: "5" });
    assert.deepEqual(funnelCell(0), { text: "0" });
  });
  await step("an untracked value (null, undefined, NaN) shows a hyphen, never 0, with the 'not tracked yet' label", () => {
    for (const v of [null, undefined, Number.NaN] as const) {
      const cell = funnelCell(v);
      assert.equal(cell.text, "-");
      assert.notEqual(cell.text, "0");
      assert.equal(cell.ariaLabel, "not tracked yet");
    }
  });
  await step("a failed leads read says 'couldn't load', never 'not tracked yet'", () => {
    const cell = funnelCell(null, "unavailable");
    assert.equal(cell.text, "-");
    assert.equal(cell.ariaLabel, "couldn't load");
    // V5a: views/video_plays/leads/community are all tracked now (offer_funnel_events)
    // -- a missing number in any of them is a failed read, same as leads always was.
    // Only booked has no tracking yet, so it alone keeps "untracked".
    const src = readFileSync(join(ROOT, "components", "forms", "OfferCard.tsx"), "utf8");
    assert.ok(/funnelCell\(VALUES\[m\.key\], m\.key === "booked" \? "untracked" : "unavailable"\)/.test(src));
  });
  await step("the glyph is a plain hyphen, never an em dash", () => {
    assert.equal(funnelCell(null).text, "-");
    assert.notEqual(funnelCell(null).text, "—");
  });

  // -- 1. cards vs table, and untracked metrics in real markup --------------
  const html = render({
    cardsAndTable: {
      kind: "list",
      props: {
        initialRows: [row("offer-1", "alpha", "Alpha Offer"), row("intake-1", "support", "Support Ticket")],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-1": 2, "intake-1": 0 },
        offers: {
          "offer-1": {
            status: "draft",
            publishedVersion: 0,
            headline: "We answer every lead in under a minute",
            hasVideo: true,
          },
        },
        recentLeads: { "offer-1": 5 },
        recentFunnel: { "offer-1": { views: 12, video_plays: 4, community: 1 } },
      },
    },
    // -- 3. router card: present only with a "vsl"-slugged form ------------
    routerPresent: {
      kind: "list",
      props: {
        initialRows: [row("router-1", "vsl", "Which one is you")],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "router-1": 0 },
        offers: { "router-1": { status: "live", publishedVersion: 1, headline: "Pick your path" } },
        recentLeads: { "router-1": 0 },
      },
    },
    routerAbsent: {
      kind: "list",
      props: {
        initialRows: [row("offer-2", "beta", "Beta Offer")],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-2": 0 },
        offers: { "offer-2": { status: "draft", publishedVersion: 0 } },
        recentLeads: { "offer-2": 0 },
      },
    },
    // -- 4. Preview: canEdit && enabled only --------------------------------
    previewEditorEnabled: {
      kind: "list",
      props: {
        initialRows: [row("offer-3", "gamma", "Gamma Offer", true)],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-3": 0 },
        offers: { "offer-3": { status: "draft", publishedVersion: 0 } },
        recentLeads: { "offer-3": 0 },
      },
    },
    previewEditorDisabled: {
      kind: "list",
      props: {
        initialRows: [row("offer-4", "delta", "Delta Offer", false)],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-4": 0 },
        offers: { "offer-4": { status: "draft", publishedVersion: 0 } },
        recentLeads: { "offer-4": 0 },
      },
    },
    livePage: {
      kind: "list",
      props: {
        initialRows: [row("offer-6", "zeta", "Zeta Offer", true)],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-6": 0 },
        offers: { "offer-6": { status: "live", publishedVersion: 2 } },
        recentLeads: { "offer-6": 0 },
      },
    },
    oasisLiveFleet: {
      kind: "list",
      props: {
        initialRows: [row("offer-8", "fleet", "FLEET", true)],
        tenantLogoUrl: null,
        tenantSlug: "oasis-ai-cc",
        tenantName: "OASIS AI",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-8": 0 },
        offers: { "offer-8": { status: "live", publishedVersion: 1 } },
        recentLeads: { "offer-8": 0 },
      },
    },
    offPublished: {
      kind: "list",
      props: {
        initialRows: [row("offer-9", "theta", "Theta Offer", false)],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-9": 0 },
        offers: { "offer-9": { status: "live", publishedVersion: 3 } },
        recentLeads: { "offer-9": 0 },
      },
    },
    unresolvedLive: {
      kind: "list",
      props: {
        initialRows: [row("offer-10", "iota", "Iota Offer", true)],
        tenantLogoUrl: null,
        tenantSlug: null,
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-10": 0 },
        offers: { "offer-10": { status: "live", publishedVersion: 1 } },
        recentLeads: { "offer-10": 0 },
      },
    },
    liveWithChanges: {
      kind: "list",
      props: {
        initialRows: [row("offer-7", "eta", "Eta Offer", true)],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: true,
        responseCounts: { "offer-7": 0 },
        offers: { "offer-7": { status: "live_with_changes", publishedVersion: 2 } },
        recentLeads: { "offer-7": 0 },
      },
    },
    previewReadOnlyViewer: {
      kind: "list",
      props: {
        initialRows: [row("offer-5", "epsilon", "Epsilon Offer", true)],
        tenantLogoUrl: null,
        tenantSlug: "acme",
        tenantName: "Acme",
        profileSlug: "oasis",
        canEdit: false,
        responseCounts: { "offer-5": 0 },
        offers: { "offer-5": { status: "draft", publishedVersion: 0 } },
        recentLeads: { "offer-5": 0 },
      },
    },
  });

  await step("offers render as cards; intake forms stay a table", () => {
    const h = html.cardsAndTable;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(/<article\b/.test(h), "no <article> card for the offer");
    assert.ok(h.includes("We answer every lead in under a minute"), "the card's one-line promise is missing");
    assert.ok(h.includes("Video attached"), "the VSL status is missing for a hero with a video");
    assert.ok(h.includes("Draft page (not live)"), "the page status is missing");
    assert.ok(/<table\b/.test(h), "the intake forms table is gone");
    assert.ok(h.includes(">Support Ticket<"), "the intake form's row is missing");
  });

  await step("every tracked metric (views, video plays, leads, community) shows its real number; booked alone stays untracked", () => {
    const h = html.cardsAndTable;
    assert.ok(h.includes(">5</dd>"), "the real 7-day leads count is missing");
    assert.ok(h.includes(">12</dd>"), "the real 7-day views count is missing");
    assert.ok(h.includes(">4</dd>"), "the real 7-day video-plays count is missing");
    assert.ok(h.includes(">1</dd>"), "the real 7-day community count is missing");
    assert.ok(h.includes('aria-label="Booked: not tracked yet"'), "Booked is missing its 'not tracked yet' label");
    assert.ok(!h.includes('aria-label="Views: not tracked yet"'), "Views is tracked now and must not say 'not tracked yet'");
    assert.ok(!h.includes('aria-label="Video plays: not tracked yet"'), "Video plays is tracked now and must not say 'not tracked yet'");
    assert.ok(!h.includes('aria-label="Sent to community: not tracked yet"'), "Sent to community is tracked now and must not say 'not tracked yet'");
    assert.equal((h.match(/>-<\/dd>/g) || []).length, 1, "expected exactly 1 untracked metric (Booked) showing a hyphen");
  });

  await step("a tracked metric with no data for this form reads as a failed read ('couldn't load'), never a false 0", () => {
    // routerPresent supplies no recentFunnel at all for its form -- every
    // tracked metric (views/video_plays/leads/community) must say "couldn't
    // load", not silently render 0 or "not tracked yet".
    const h = html.routerPresent;
    for (const label of ["Views", "Video plays", "Sent to community"]) {
      // React escapes the apostrophe in an attribute as &#x27; — matching the
      // literal rendered markup, not the un-escaped string.
      assert.ok(h.includes(`aria-label="${label}: couldn&#x27;t load"`), `${label} should read as a failed read with no funnel data`);
    }
    assert.ok(h.includes('aria-label="Booked: not tracked yet"'), "Booked stays 'not tracked yet' even here");
  });

  await step("a form at slug 'vsl' is pinned as the Start here router card, by name, with no empty-state text", () => {
    const h = html.routerPresent;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(h.includes("Start here"), "the router eyebrow is missing");
    assert.ok(h.includes("Which one is you"), "the vsl form's own card is missing");
    assert.ok(!h.includes("No start-here page yet"), "the empty state drew even though a vsl form exists");
  });

  await step("with no 'vsl' form, a quiet empty state offers Create instead of a router card", () => {
    const h = html.routerAbsent;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(h.includes("No start-here page yet"), "the empty state is missing");
    assert.ok(h.includes(">Create<"), "the Create action is missing");
    assert.ok(!h.includes("Which one is you"), "a router card appeared with no vsl form");
  });

  await step("a draft offer shows its editor Open draft and Publish, and never a Copy link to the bare form", () => {
    const h = html.previewEditorEnabled;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(h.includes(">Open draft<"), "Open draft is missing for an editor on an enabled draft");
    assert.ok(h.includes(">Confirm &amp; publish<"), "Publish is missing on a draft offer");
    // CC 2026-10-16: a draft card goes to the one screen that publishes every offer (claims, prices, video).
    assert.match(h, /<a[^>]*href="\/forms\/publish"[^>]*>Confirm &amp; publish<\/a>/, "the draft card does not lead to Confirm & publish");
    assert.doesNotMatch(h, COPY_BUTTON, "a draft card hands out a link that shows only the form");
    assert.ok(!h.includes(">Share<"), "a draft card shares a link that shows only the form");
    assert.ok(h.includes("Not public yet"), "the card does not say why there is no link yet");
  });
  await step("a switched-off offer's editor can open its draft, and nothing public is handed out", () => {
    const h = html.previewEditorDisabled;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    // Since #659 the route draws a switched-off form's draft for its owner, so
    // the owner can check the page before switching it on (Codex review of #659).
    assert.ok(h.includes(">Open draft<"), "a switched-off offer's owner cannot open its draft");
    assert.doesNotMatch(h, COPY_BUTTON, "a switched-off offer's card hands out a closed link");
    assert.ok(!h.includes(">Share<") && !h.includes(">Confirm &amp; publish<"), "a switched-off offer's card offers more than its draft");
    assert.ok(h.includes("Switched off"), "the card does not say the link is closed");
  });
  await step("Open draft and Publish are withheld for a read-only viewer, even on an enabled offer", () => {
    const h = html.previewReadOnlyViewer;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(!h.includes(">Open draft<"), "Open draft is drawn for a viewer the route does not authorize to see a draft");
    assert.ok(!h.includes(">Confirm &amp; publish<"), "Publish is drawn for a viewer who may not edit");
  });
  await step("a live offer's card copies, opens and shares the landing page, and shows its address", () => {
    const h = html.livePage;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.match(h, COPY_BUTTON, "Copy link is missing on a live offer");
    assert.ok(h.includes(">Open page<"), "Open page is missing on a live offer");
    assert.ok(h.includes(">Share<"), "Share is missing on a live offer");
    assert.ok(h.includes(">/f/acme/zeta<"), "the landing page's address is missing");
    assert.ok(h.includes("Copy the landing page"), "Copy link does not say it copies the landing page");
    assert.ok(!h.includes(">Open draft<") && !h.includes(">Preview changes<"), "a live page with no pending edits has one link, not two");
    assert.ok(!h.includes(">Confirm &amp; publish<"), "Publish is offered on a page that is already live with nothing new");
  });
  await step("an OASIS offer's card hands out its own short link (lib/offers/short-links.ts)", () => {
    const h = html.oasisLiveFleet;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(h.includes(">/fleet-audit<"), "FLEET's card does not show its short link");
    assert.ok(h.includes('href="/fleet-audit"'), "Open page does not use the short link");
  });
  await step("a switched-off offer whose page was published never offers Publish (switching on brings it back)", () => {
    const h = html.offPublished;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(!h.includes(">Confirm &amp; publish<"), "Publish is offered for a page that is already published");
    assert.ok(h.includes("its published page is back"), "the card does not say switching on restores the page");
    assert.doesNotMatch(h, COPY_BUTTON, "a switched-off offer's card hands out a closed link");
  });
  await step("an address that could not be built is reported as such, never as an unpublished page", () => {
    const h = html.unresolvedLive;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(h.includes("build this offer"), "the card does not say the link could not be built");
    assert.ok(!h.includes("Not public yet"), "a live page is called unpublished because the address lookup failed");
  });
  await step("a live page with newer edits adds Preview changes, still one public link", () => {
    const h = html.liveWithChanges;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(h.includes(">Preview changes<"), "Preview changes is missing when a newer draft waits");
    assert.ok(h.includes(">Open page<") && COPY_BUTTON.test(h), "the live page's own link is missing");
  });

  // -- 5. offerCreateSlug / slugTakenMessage: the router Create fix ---------
  await step("router mode always submits slug 'vsl', whatever the typed name or slug says", () => {
    assert.equal(offerCreateSlug(true, ""), ROUTER_SLUG);
    assert.equal(offerCreateSlug(true, "whatever-the-visitor-typed"), ROUTER_SLUG);
    assert.equal(offerCreateSlug(true, "totally-different"), "vsl");
  });
  await step("the ordinary flow still submits the typed/derived slug, unchanged", () => {
    assert.equal(offerCreateSlug(false, "my-offer"), "my-offer");
    assert.equal(offerCreateSlug(false, ""), "");
  });
  await step("a taken slug names 'vsl' and suggests refreshing in router mode; the ordinary message is generic", () => {
    const routerMsg = slugTakenMessage(true);
    assert.match(routerMsg, /vsl/);
    assert.doesNotMatch(routerMsg, /—/);
    const ordinaryMsg = slugTakenMessage(false);
    assert.doesNotMatch(ordinaryMsg, /vsl/);
    assert.notEqual(routerMsg, ordinaryMsg);
  });

  done("offers-screen");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
