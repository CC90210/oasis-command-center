/**
 * A client's book must not render on OASIS's own surfaces.
 *
 * THE LEAK THIS EXISTS FOR (2026-08-17). components/automations/AutomationsContent
 * gated the Breeze/MCA underwriting section on:
 *
 *     {(isOperator || tenantSlug === "sun") && ( ... <BreezeDealsPanel /> ... )}
 *
 * `isOperatorEmail` is true for CC. Top-level `/automations` on oasisai.work is
 * the OASIS surface — `tenantSlug` is not "sun" — and the panel rendered anyway.
 *
 * It was not a cosmetic slip. GET /api/automations/breeze-deals deliberately
 * resolves an empire operator to the SunBiz tenant (`tenants.slug =
 * 'submissions'`), so the fetch returned REAL rows: named merchants, monthly
 * revenue, leverage ratios, ISO names, 146 pending submissions. CC opened his own
 * operations page and read a client's underwriting queue.
 *
 * ROLE AND SURFACE ARE DIFFERENT QUESTIONS. Role answers "may this person see
 * it" — CC may; he runs the company. Surface answers "is this the place" — and
 * only that belongs in a render condition. Being permitted to see something
 * somewhere is not permission to paint it everywhere.
 *
 * WHY THIS TEST READS SOURCE. The defect is a rendering CONDITION, so the
 * property is about the code rather than about one query's output — the same
 * reason tests/marketing-degraded-render.test.ts reads its page. A behavioural
 * test here would need a session, a tenant, a Supabase client and a React
 * renderer, and would still only cover the one arrangement it was written for.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SRC = readFileSync(
  join(process.cwd(), "components", "automations", "AutomationsContent.tsx"),
  "utf8",
);

/**
 * Components that render another tenant's business data and must therefore be
 * gated on the SURFACE, never on who is looking.
 */
const CLIENT_ONLY_PANELS = ["BreezeDealsPanel", "BackgroundWorkersPanel"];

test("the automations page still renders the client panels at all", () => {
  // Guards the guard. If these are renamed or removed, every assertion below
  // passes vacuously and this file becomes decoration.
  for (const panel of CLIENT_ONLY_PANELS) {
    assert.ok(SRC.includes(`<${panel}`), `${panel} is no longer rendered — update this test`);
  }
});

test("client panels are gated on the surface, not on the viewer's role", () => {
  // The exact shape of the leak, pinned as a literal. An operator-role term
  // anywhere in this gate re-opens it.
  assert.ok(
    !/\{\s*\(\s*isOperator\s*\|\|/.test(SRC),
    "the Breeze section is gated on `isOperator || ...` again — that renders a " +
      "client's underwriting queue on OASIS's own /automations page, and the API " +
      "will happily serve it because empire operators resolve to the SunBiz tenant",
  );
  assert.ok(
    SRC.includes('{tenantSlug === "sun" && ('),
    "the client section must be gated on tenantSlug === \"sun\" alone",
  );
});

test("no operator-identity check survives in this component at all", () => {
  // Stronger than policing one expression: the component has no legitimate use
  // for "who is looking" now. Keeping the helper around invites the next person
  // to reach for it, which is exactly how this was written the first time.
  for (const token of ["isOperatorEmail", "isOperator"]) {
    const uses = SRC.split(token).length - 1;
    const inComment = SRC.split(new RegExp(`//.*${token}`)).length - 1;
    assert.equal(
      uses - inComment,
      0,
      `${token} is referenced in live code again. Gate on tenantSlug; role is not ` +
        `a rendering decision on a multi-tenant surface.`,
    );
  }
});

test("the client section names the client, so it can never look like OASIS's own", () => {
  // Defence in depth for the human reading the screen: even on the correct
  // surface, the section says whose desk it is. CC's original report was that he
  // could not tell whose deals he was looking at.
  assert.ok(
    /Underwriting \/ Breeze/.test(SRC),
    "the client section must keep its own heading",
  );
});
