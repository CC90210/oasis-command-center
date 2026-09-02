import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Per-lead assignment, and the two gates that keep it honest.
 *
 * Assignment moves commission, so the interesting assertions here are all
 * refusals. The happy path is one line; the rest is who may NOT do this.
 *
 * These are source assertions rather than a live POST because the route reaches
 * resolveSessionContext() and the roster, neither of which exists outside a
 * request. What they pin is the SHAPE that cannot be got wrong silently: that
 * the target is checked against the roster, that a plain rep is refused, and
 * above all that assignment reuses claimLeads rather than growing a second
 * write path whose rules can drift from the first.
 */

const ROUTE = 'app/api/web-leads/claim/route.ts';
const src = readFileSync(ROUTE, 'utf8');
/** Assertions about CODE must not trip on the prose explaining the code. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('assigning a lead to another rep', () => {
  it('reuses claimLeads instead of growing a second write path', () => {
    // THE STRUCTURAL POINT. claimLeads already enforces the per-rep cap, the
    // compare-and-set that stops two people taking one lead, the missing-id
    // report and touch tracking. A bespoke assign implementation would have to
    // restate all four, and the day it restates one of them differently is the
    // day two reps hold the same lead.
    assert.match(code, /claimLeads\(\s*claimFor\b/, 'assignment must go through claimLeads');
    assert.ok(
      !/update\s*\(\s*\{[^}]*assigned_to/i.test(code),
      'the route must not write assigned_to directly',
    );
  });

  it('counts the cap against the TARGET, not the caller', () => {
    // claimLeads computes heldCount(userId) for whichever id it is given, so
    // passing the target is what makes the cap follow the person receiving the
    // work. Passing session.userId here would check the manager's book.
    assert.match(code, /const result = await claimLeads\(claimFor,/);
    assert.ok(
      !/claimLeads\(session\.userId, leadIds/.test(code),
      'the claim call must not be pinned to the caller once a target is named',
    );
  });

  it('refuses a plain rep who names someone else', () => {
    assert.match(code, /assign_requires_manager/, 'a non-manager must be refused by name');
    assert.match(code, /isOasisPipelineAdmin\(/);
    assert.match(code, /canReadOasisSalesTeamPipeline\(/);
    // 403, not a silent fall-back to self-claim: a manager-only action that
    // quietly does something else is worse than one that says no.
    assert.match(code, /assign_requires_manager[\s\S]{0,120}status:\s*403/);
  });

  it('refuses a target who is not on the sales roster', () => {
    // Without this, an id typed into a request could park a lead on a founder,
    // a builder, or nobody at all -- and the lead would vanish from every
    // board that scopes by roster.
    assert.match(code, /getOasisSalesRepRoster\(/);
    assert.match(code, /target_not_on_sales_roster/);
    assert.match(code, /target_not_on_sales_roster[\s\S]{0,120}status:\s*400/);
  });

  it('lets a manager assign to themselves without a roster round-trip', () => {
    // A manager is deliberately NOT on the sales roster (getOasisSalesRepRoster
    // excludes owners and admins), so self-assignment has to short-circuit or
    // it would be refused by the check meant to protect it.
    assert.match(code, /target !== session\.userId\.trim\(\)\.toLowerCase\(\)/);
  });

  it('still refuses anyone without a sales role at all', () => {
    // The pre-existing gate must survive: assignment is an addition to this
    // route, not a way around what it already refused.
    assert.match(code, /mayWorkWebsiteSalesLifecycle\(session\.teamRole, session\.isAdmin\)/);
    assert.match(code, /sales_role_required/);
  });

  it('reports who the leads went to', () => {
    // The caller selected rows and named a person; the response has to confirm
    // the person, or a mis-click is invisible until the rep asks why their
    // board changed.
    assert.match(code, /assignedTo: claimFor/);
  });

  it('offers the picker only on the shared pool', () => {
    // "Assigning" a lead already in someone's book is a TRANSFER -- taking work
    // off a rep mid-call -- which is a different decision with different rules
    // and is not what this control does. My leads and Team leads must not show
    // it.
    const browser = readFileSync('components/web-leads/WebLeadsBrowser.tsx', 'utf8');
    assert.match(browser, /assignOptions=\{!mine && !team/);
  });

  it('only fetches the roster for someone who may use it', () => {
    const browser = readFileSync('components/web-leads/WebLeadsBrowser.tsx', 'utf8');
    assert.match(
      browser,
      /if \(!canSeeTeamAndAssign\) return;/,
      'a rep must not pay for a roster read they cannot act on',
    );
  });

  it('says Assign, not Claim, once a rep is chosen', () => {
    // The button is the last thing read before the click. Leaving it on
    // "Claim 12" while a colleague is selected states the wrong outcome.
    const toolbar = readFileSync('components/web-leads/LeadsToolbar.tsx', 'utf8');
    assert.match(toolbar, /assignTo && claimLabel !== "Release" \? "Assign" : claimLabel/);
  });

  it('degrades to plain self-claim when the roster cannot be read', () => {
    // A failed roster fetch must not take the Claim button down with it: the
    // picker simply does not render, and every rep keeps working.
    const browser = readFileSync('components/web-leads/WebLeadsBrowser.tsx', 'utf8');
    assert.match(browser, /\.catch\(\(\) => \{\}\);/);
    const toolbar = readFileSync('components/web-leads/LeadsToolbar.tsx', 'utf8');
    assert.match(toolbar, /assignOptions\.length > 0 && onAssignTo/);
  });

  it('shows the actual leads on the Assign tab', () => {
    // THE BUG THIS TAB HAD. The view short-circuited the fetch and rendered
    // only the sheet control, so "assign" could only mean "hand someone an
    // entire city+industry sheet" -- 1,158 leads or nothing. Assigning ONE lead
    // was not expressible on the screen named Assign.
    const browser = readFileSync('components/web-leads/WebLeadsBrowser.tsx', 'utf8');
    assert.match(
      browser,
      /view === "leads" \|\| mine \|\| team \|\| assignView\) && listBlock/,
      'the Assign view must render the lead list',
    );
    assert.ok(
      !/if \(view === "territories"\) \{\s*setLeads\(\[\]\)/.test(browser),
      'the Assign view must not blank the list before fetching',
    );
  });

  it('keeps sheet assignment, demoted rather than deleted', () => {
    // Handing a rep a whole sheet is still occasionally right when a territory
    // is genuinely one person's patch. It stays, closed, BELOW the list --
    // available without being the only thing the tab can do.
    const browser = readFileSync('components/web-leads/WebLeadsBrowser.tsx', 'utf8');
    assert.match(browser, /<details[\s\S]{0,400}<TerritoryAssignment \/>/);
    assert.match(browser, /Bulk: give a rep an entire sheet/);
  });

  it('every endpoint that reports a sheet size counts the rows', () => {
    // #377 fixed the list and facet endpoints and MISSED the territories one,
    // which is the door the Assign screen reads -- so the dropdown still
    // advertised "Montreal, QC - Restaurants & Bars (1158)" against a board
    // holding a few dozen. Three surfaces quote a sheet size; all three must
    // derive it, or the one left behind becomes the number an operator trusts.
    for (const route of [
      'app/api/web-leads/route.ts',
      'app/api/web-leads/facets/route.ts',
      'app/api/web-leads/territories/route.ts',
    ]) {
      const routeSrc = readFileSync(route, 'utf8');
      const routeCode = routeSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      assert.match(
        routeCode,
        /fetchSheetsScopedToViewer\(/,
        `${route} must derive sheet counts from the rows`,
      );
    }
  });

  it('decides which sheets EXIST from the rows, not the stored column', () => {
    // The counts were derived in #377/#379 while MEMBERSHIP was still decided
    // by the same dead number: fetchSheets() dropped any territory whose stored
    // leads_total was 0, before anything had been counted. That is the one
    // failure the derived counts cannot repair -- a territory holding real
    // leads and a stale 0 never reaches the rail at all, so its leads are
    // unreachable in pool scope no matter how accurate the number would be.
    //
    // 0 territories were hidden that way when measured on 2026-09-02 (the
    // consolidation only REMOVED leads, so stored >= real for everything that
    // existed then). New promotions are the exposure, and promotion is running.
    const src = readFileSync('lib/web-leads/data.ts', 'utf8');
    const fetchSheetsBody = src.slice(
      src.indexOf('export async function fetchSheets('),
      src.indexOf('export async function fetchSheetsScopedToViewer('),
    );
    assert.ok(
      !/\.filter\(\s*\(r: Sheet\)\s*=>\s*\(r\.leads_total/.test(fetchSheetsBody),
      'fetchSheets must not gate membership on the stored leads_total',
    );
  });

  it('still hides genuinely empty sheets, on the derived number', () => {
    // Dropping the stale filter without replacing it would list all 2,356
    // territories, 1,871 of which were measured empty on 2026-09-02 -- a rail
    // of zeros. The filter moves to where the number is true, after counting.
    const src = readFileSync('lib/web-leads/data.ts', 'utf8');
    const scoped = src.slice(src.indexOf('export async function fetchSheetsScopedToViewer('));
    assert.match(
      scoped,
      /\.filter\(\(s\) => s\.leads_total > 0\)/,
      'the derived view must drop sheets that really are empty',
    );
  });

  it('gives the rep dropdown readable options', () => {
    // THE GLITCH CC SCREENSHOTTED. The select is deliberately bg-transparent so
    // it blends into the pill around it -- and that is exactly what makes the
    // native popup fall back to WHITE, while the options inherit text-fg
    // (#faf9f5). White on white: the operator saw a blank box with only the
    // hover-highlighted row legible. color-scheme:dark on :root does not cover
    // it once an author background lands on the select.
    const bar = readFileSync('components/web-leads/LeadsToolbar.tsx', 'utf8');
    const picker = bar.slice(bar.indexOf('Assign the selected leads to'));
    const opts = picker.slice(0, picker.indexOf('</select>')).match(/<option[^>]*>/g) || [];
    assert.ok(opts.length >= 2, 'expected the picker to render options');
    for (const o of opts) {
      assert.match(o, /className="[^"]*bg-bg-panel[^"]*"/, `option needs a background: ${o}`);
      assert.match(o, /className="[^"]*text-fg[^"]*"/, `option needs a colour: ${o}`);
    }
  });

  it('styles every option app-wide, not just this one', () => {
    // Third dropdown in this app to render unreadably for the same underlying
    // reason (see tailwind.config.ts on bg-deep, referenced by ~85 components
    // before it was ever defined). A per-instance fix leaves the next one to be
    // found by an operator, so the rule is global -- with the light-theme
    // counterpart, or a prospect on a light SunBiz form gets a dark popup
    // hanging off a cream field.
    const css = readFileSync('app/globals.css', 'utf8');
    assert.match(css, /select option,\s*\nselect optgroup \{/, 'need a global option rule');
    assert.match(css, /\.form-light select option/, 'need the light-theme counterpart');
    assert.match(css, /\.form-light \{ color-scheme: light; \}/, 'macOS draws the popup natively and reads color-scheme, not the option colours');
  });

  it('offers only reps the server will actually accept', () => {
    // The picker read /api/team/members -- EVERY profile on the tenant -- while
    // the claim route validates the target against getOasisSalesRepRoster,
    // which excludes owners, admin_access holders and non-rep roles. Measured
    // on the live tenant 2026-09-02: 8 names offered, 6 accepted. Choosing CC
    // (is_owner) or Adon (team_role 'admin') returned 400
    // target_not_on_sales_roster -- on a name the UI had just offered.
    const browser = readFileSync('components/web-leads/WebLeadsBrowser.tsx', 'utf8');
    assert.match(browser, /fetch\("\/api\/web-leads\/assignable-reps"/);
    assert.ok(
      !/fetch\("\/api\/team\/members"/.test(browser),
      'the picker must not read the full tenant member list',
    );

    // Same function on both sides, so they cannot drift. A client-side copy of
    // OASIS_PIPELINE_REP_ROLES would go stale the first time a role is added,
    // and it would go stale silently.
    const route = readFileSync('app/api/web-leads/assignable-reps/route.ts', 'utf8');
    const claim = readFileSync('app/api/web-leads/claim/route.ts', 'utf8');
    for (const src of [route, claim]) {
      assert.match(src, /getOasisSalesRepRoster/);
      assert.match(src, /isOasisPipelineAdmin\(/);
      assert.match(src, /canReadOasisSalesTeamPipeline\(/);
    }
    // Enumerating the roster is itself gated: a rep must not be able to read
    // the team list through the picker's endpoint.
    assert.match(route, /assign_requires_manager/);
    assert.match(route, /wrong_tenant/);
  });

  it('keeps the batch ceiling and the de-duplication', () => {
    // Assignment goes through the same body parsing, so the id list is still
    // bounded and de-duplicated -- the same id twice would otherwise burn two
    // slots against the target's cap for one lead.
    assert.match(code, /MAX_IDS_PER_REQUEST/);
    assert.match(code, /new Set\(/);
  });
});
