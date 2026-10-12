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
 *   4. Preview is drawn only for canEdit && enabled (Codex review, PR #596):
 *      the public route 404s a disabled form before preview authorization
 *      runs, and only honours ?offer_preview=1 for an editor.
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
    const src = readFileSync(join(ROOT, "components", "forms", "OfferCard.tsx"), "utf8");
    assert.ok(/funnelCell\(value, m\.key === "leads" \? "unavailable" : "untracked"\)/.test(src));
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

  await step("the tracked leads metric shows its real number; every untracked metric shows a hyphen with its label, never 0", () => {
    const h = html.cardsAndTable;
    assert.ok(h.includes(">5</dd>"), "the real 7-day leads count is missing");
    for (const label of ["Views", "Video plays", "Booked", "Sent to community"]) {
      assert.ok(h.includes(`aria-label="${label}: not tracked yet"`), `${label} is missing its accessible label`);
    }
    assert.equal((h.match(/>-<\/dd>/g) || []).length, 4, "expected exactly 4 untracked metrics showing a hyphen");
    assert.ok(!/>0<\/dd>/.test(h), "an untracked metric rendered as 0");
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

  await step("Preview is drawn for an editor on an enabled offer", () => {
    const h = html.previewEditorEnabled;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(h.includes(">Preview<"), "Preview is missing for an editor on an enabled offer");
  });
  await step("Preview is withheld for a switched-off offer, even for an editor", () => {
    const h = html.previewEditorDisabled;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(!h.includes(">Preview<"), "Preview is drawn for a disabled offer, which 404s the preview route");
  });
  await step("Preview is withheld for a read-only viewer, even on an enabled offer", () => {
    const h = html.previewReadOnlyViewer;
    assert.doesNotMatch(h, /^RENDER FAILED/, h.slice(0, 300));
    assert.ok(!h.includes(">Preview<"), "Preview is drawn for a viewer who may not edit, who the route does not authorize to see a draft");
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
