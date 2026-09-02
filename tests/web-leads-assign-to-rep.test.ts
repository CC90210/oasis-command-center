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

  it('keeps the batch ceiling and the de-duplication', () => {
    // Assignment goes through the same body parsing, so the id list is still
    // bounded and de-duplicated -- the same id twice would otherwise burn two
    // slots against the target's cap for one lead.
    assert.match(code, /MAX_IDS_PER_REQUEST/);
    assert.match(code, /new Set\(/);
  });
});
