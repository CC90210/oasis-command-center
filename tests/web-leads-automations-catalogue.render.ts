/**
 * The server-render half of tests/web-leads-automations-catalogue.test.ts.
 *
 * WHY IT IS A SEPARATE PROCESS. `tests/_suite-web-leads.mjs` runs every test
 * with `--conditions=react-server`, under which `react-dom/server` does not
 * resolve and `react` exports no `useState`. `CapabilityCatalogue` and
 * `CapabilityRow` are client components with hooks, so they cannot be
 * rendered inside a suite process at all. The test file therefore spawns
 * THIS file with plain `node --import tsx`, reads the JSON it prints on
 * stdout, and asserts against the markup.
 *
 * WHY `React.createElement` AND NOT JSX, AND WHY THERE IS A SECOND
 * TSCONFIG. `tsconfig.json` sets `jsx: "preserve"` for Next, and `tsx`
 * honours that by falling back to the CLASSIC runtime, which needs `React`
 * in scope in every file containing JSX. Writing this file in `.ts` keeps
 * ITS own code clear of the problem, but the two components it renders are
 * `.tsx` and hit it regardless, so the spawn also sets
 * `TSX_TSCONFIG_PATH=tests/tsconfig.render.json`, which overrides `jsx` for
 * that process alone. That file changes nothing about the build, the
 * typecheck or any other test; see its own note.
 *
 * WHAT IT DOES NOT DO: it asserts nothing. Every assertion lives in the
 * `.test.ts`, so a scenario that stops rendering what it should fails there
 * with a named message rather than silently here. It also runs no browser,
 * so nothing behind a click is reachable: scenarios that need an open row
 * pass `defaultOpenId`, and scenarios that need a specific row state render
 * `CapabilityRow` directly.
 */

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilityCatalogue } from "../components/web-leads/CapabilityCatalogue";
import { CapabilityRow, type RowState } from "../components/web-leads/CapabilityRow";
import { CheckEvidenceLine } from "../components/web-leads/audit-parts";
import { IndustryAutomationGuide } from "../components/playbook/IndustryAutomationGuide";
import { CAPABILITIES } from "../lib/web-leads/automations";
import { hasLiveWebsite } from "../lib/web-leads/automations-match";
import type { CheckResult, DimensionProfile } from "../lib/web-leads/audit";

const check = (code: string, points: number, has: boolean): CheckResult => ({ code, label: `LABEL:${code}`, points, has });

/** What the card's no-score mount passes. Not a fixture standing in for an
 *  audit: no non-scored `AuditResult` variant carries dimensions, so this is
 *  the audit data those leads actually have. */
const NO_DIMENSIONS: DimensionProfile[] = [];

/** The score `quality-model.js` would actually store for these checks. */
function storedScore(checks: CheckResult[]): number {
  const total = checks.reduce((n, c) => n + c.points, 0);
  if (total === 0) return 0;
  return Math.round((checks.reduce((n, c) => (c.has ? n + c.points : n), 0) / total) * 100);
}

function dimension(key: string, weight: number, checks: CheckResult[]): DimensionProfile {
  return { key, label: key, score: storedScore(checks), weight, checks, missing: [] };
}

/** Every code every `today` capability covers, derived from CAPABILITIES so
 *  a new bundle cannot leave this fixture quietly partial. */
const ALL_TODAY_CODES = CAPABILITIES.filter((c) => c.stage === "today").flatMap((c) => c.codes);

/** One dimension carrying every code, all passing: a complete, clean audit. */
const FULL_CLEAN: DimensionProfile[] = [
  dimension("conversion", 0.26, ALL_TODAY_CODES.map((code) => check(code, 10, true))),
];

/** Every code observed, one failing: a complete audit WITH a finding. */
const FULL_WITH_FAILURE: DimensionProfile[] = [
  dimension("conversion", 0.26, ALL_TODAY_CODES.map((code) => check(code, 10, code !== "tel_link"))),
];

/** Only the conversion codes observed, all passing. Nine capabilities are
 *  therefore unscored and `relevant` is empty: the PARTIAL case. */
const PARTIAL_CLEAN: DimensionProfile[] = [
  dimension("conversion", 0.26, [check("tel_link", 18, true), check("phone_in_header", 78, true)]),
];

/** Only the conversion codes observed, one failing. `relevant` has a row, so
 *  the intro is `ranked`, and nine capabilities are still unscored: the case
 *  where the coverage fact has to be visible without an interaction. */
const PARTIAL_WITH_FAILURE: DimensionProfile[] = [
  dimension("conversion", 0.26, [check("tel_link", 18, false), check("phone_in_header", 78, true)]),
];

/** A single failing capability whose weighted value is below 1.0: design
 *  with only `favicon` failing is 0.70 at the shape below (stored score 95,
 *  weight 0.14). Pins that the ranking bar is scaled against the real
 *  maximum and not against a floor of 1, which would draw it at 70%. */
const SOLE_SUB_ONE: DimensionProfile[] = [
  dimension("design", 0.14, [
    check("favicon", 5, false),
    check("web_fonts", 102, true),
  ]),
];

function catalogue(props: Partial<Parameters<typeof CapabilityCatalogue>[0]> = {}) {
  return renderToStaticMarkup(
    React.createElement(CapabilityCatalogue, {
      dimensions: [],
      hasWebsite: true,
      signals: null,
      drawn: true,
      reduced: false,
      selectedAngleKey: null,
      ...props,
    }),
  );
}

function row(state: RowState, props: Partial<Parameters<typeof CapabilityRow>[0]> = {}) {
  const capability = CAPABILITIES.find((c) => c.id === "easy-to-call")!;
  return renderToStaticMarkup(
    React.createElement(
      "ul",
      null,
      React.createElement(CapabilityRow, {
        capability,
        state,
        hue: { from: "#111111", to: "#222222" },
        open: true,
        onToggle: () => {},
        checks: new Map([["tel_link", check("tel_link", 18, false)]]),
        signals: null,
        recoverable: state.kind === "scored" ? 4.94 : null,
        ranking: state.kind === "scored" ? 100 : null,
        drawn: true,
        reduced: false,
        alreadySaidAbove: false,
        ...props,
      }),
    ),
  );
}

const scenarios: Record<string, () => string> = {
  introNoAudit: () => catalogue({ dimensions: [] }),
  introNoWebsite: () => catalogue({ dimensions: [], hasWebsite: false }),
  introClean: () => catalogue({ dimensions: FULL_CLEAN }),
  introPartial: () => catalogue({ dimensions: PARTIAL_CLEAN }),
  introRankedFull: () => catalogue({ dimensions: FULL_WITH_FAILURE }),
  introRankedPartial: () => catalogue({ dimensions: PARTIAL_WITH_FAILURE }),

  // Open rows, reached through `defaultOpenId` because a server render has
  // no click available.
  openScored: () =>
    catalogue({ dimensions: PARTIAL_WITH_FAILURE, defaultOpenId: "easy-to-call", signals: {} }),
  openSoleSubOne: () =>
    catalogue({ dimensions: SOLE_SUB_ONE, defaultOpenId: "look-current" }),
  openLadder: () => catalogue({ dimensions: FULL_WITH_FAILURE, defaultOpenId: "missed-call-text-back" }),

  // Direct row renders, one per state.
  rowScored: () => row({ kind: "scored", failedCodes: ["tel_link"] }, { signals: {} }),
  rowClean: () => row({ kind: "clean" }),
  rowUnscored: () => row({ kind: "unscored" }),
  rowNoWebsite: () => row({ kind: "noWebsite" }),
  rowNoHue: () => row({ kind: "scored", failedCodes: ["tel_link"] }, { hue: null }),

  // ── THE FOUR NON-SCORED CARD STATES, through the card's own inputs ──────
  //
  // Fix round 1, 2026-09-14. The catalogue is now mounted a second time, at
  // container level, for a lead `ScoredBody` never renders for. These four
  // scenarios pass EXACTLY what that mount passes: the empty audit (no
  // non-scored AuditResult variant carries dimensions at all) and
  // `hasLiveWebsite` applied to the real audit state, rather than a hand
  // written `hasWebsite` boolean. So a change to that derivation moves these
  // renders, which is the point: the previous version could not have caught
  // a wrong `true` because the fixture supplied the answer.
  cardNoWebsite: () => catalogue({ dimensions: NO_DIMENSIONS, hasWebsite: hasLiveWebsite({ state: "no_website" }) }),
  cardParked: () => catalogue({ dimensions: NO_DIMENSIONS, hasWebsite: hasLiveWebsite({ state: "parked" }) }),
  cardNotScored: () => catalogue({ dimensions: NO_DIMENSIONS, hasWebsite: hasLiveWebsite({ state: "not_scored" }) }),
  cardUnreachable: () => catalogue({ dimensions: NO_DIMENSIONS, hasWebsite: hasLiveWebsite({ state: "unreachable" }) }),
  // The same two with a row opened, because the per-row state sentences live
  // inside the detail and a server render has no click available. These are
  // the `unscored` and `noWebsite` ROW states, which were unreachable from
  // the card for the same reason the intros were.
  cardNotScoredOpen: () =>
    catalogue({
      dimensions: NO_DIMENSIONS,
      hasWebsite: hasLiveWebsite({ state: "not_scored" }),
      defaultOpenId: "easy-to-call",
    }),
  cardNoWebsiteOpen: () =>
    catalogue({
      dimensions: NO_DIMENSIONS,
      hasWebsite: hasLiveWebsite({ state: "no_website" }),
      defaultOpenId: "easy-to-call",
    }),

  // The unmeasurable branch, rendered directly from its own state.
  //
  // WHY IT IS RENDERED THIS WAY NOW (Task 5, 2026-09-14). The table is empty
  // in production, so this scenario used to reach the branch by writing an
  // entry into it, rendering, and deleting the entry again in a `finally`.
  // That is the only reason the table was exported as mutable module state,
  // which Task 4 flagged as a smell and deferred. The table is now a plain
  // `const` beside the module that turns a code into a sentence, and the
  // ORDER of the four states lives in `evidenceStateFor`, which takes the
  // table as an argument and which the test calls directly with no
  // rendering at all. This scenario is kept to prove the RENDERING half:
  // that an `unmeasurable` state really does put "Not measurable:" on
  // screen, naming it as our flaw.
  rowUnmeasurableLine: () =>
    renderToStaticMarkup(
      React.createElement(CheckEvidenceLine, {
        state: { kind: "unmeasurable" as const, note: "OUR MODEL CANNOT MEASURE THIS ONE YET." },
      }),
    ),
  // The ordinary path through a real row, with the table empty: this code
  // and these signals DO produce an evidence line. It is the control that
  // keeps the ordering claim in the test a real one, by showing there was
  // something for the unmeasurable branch to displace.
  rowEvidenceWithoutUnmeasurable: () =>
    row({ kind: "scored", failedCodes: ["tel_link"] }, { signals: { telLinks: 0 } }),

  // ── THE OTHER SECTION ON THE SAME CARD ─────────────────────────────────
  //
  // `BattleCard.tsx` renders `IndustryAutomationGuide` directly under the
  // catalogue, `defaultOpen`, on every lead. Its menu carries an entry with
  // the same title as a gated ladder capability, so it is rendered here to
  // pin that the gate really reaches the screen and the ask-now question
  // really leaves it. `initialIndustry` is what the card passes
  // (`lead.industry`); "Restaurant" resolves to the group holding the
  // collision.
  industryGuideGated: () =>
    renderToStaticMarkup(React.createElement(IndustryAutomationGuide, { initialIndustry: "Restaurant" })),
};

const out: Record<string, string> = {};
for (const [name, render] of Object.entries(scenarios)) out[name] = render();
process.stdout.write(JSON.stringify(out));
