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
 *
 * (1) and (3) render FormsListClient the same way
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
import { ROOT, done, step } from "./_offer-pages-harness";
import { funnelCell } from "../lib/offers/funnel-strip";

const AT = "2026-10-08T12:00:00.000Z";
const row = (id: string, slug: string, name: string) => ({
  id,
  slug,
  name,
  description: null,
  enabled: true,
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

  done("offers-screen");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
