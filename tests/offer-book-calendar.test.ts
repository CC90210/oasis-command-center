/**
 * Every OASIS offer ends on a place to book a call (CC, 2026-10-16: "make sure
 * they actually have a place to submit and book a calendar meeting").
 *
 *   - AI-AUDIT, COMMAND, FLEET, BOOK: the calendar IS the next step and
 *     replaces the thanks (unchanged).
 *   - PROTOCOL, COMMUNITY: the call is optional. Their own next step (the
 *     checkout email, the community link) stays as the thanks, and the
 *     calendar sits under it, never in its place.
 *   - The VSL router, and every other workspace's forms, never get the calendar.
 *   - On an offer page, a form that ends on the calendar never also shows the
 *     "Pick a time" link to the booking page: that is a second way to book,
 *     through a second form and a second lead.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-book-calendar.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

function render(): Record<string, string> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: "tests/tsconfig.render.json" };
  const tokens = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter((t) => t.length > 0);
  const kept: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === "--conditions" || tokens[i] === "-C") { i += 1; continue; }
    if (/^(--conditions=|-C=)/.test(tokens[i])) continue;
    kept.push(tokens[i]);
  }
  if (kept.length) childEnv.NODE_OPTIONS = kept.join(" ");
  else delete childEnv.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/offer-book-calendar.render.ts"], {
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(r.status, 0, `renderer failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}

function check(name: string, fn: () => void): void {
  fn();
  console.log(`  ok - ${name}`);
}

console.log("offer book calendar");

const html = render();
const THANKS = "A member of the OASIS team will email you a secure checkout link.";
const REQUIRED_HEADING = "Your details are in. Pick a time while you";
const OPTIONAL_HEADING = "Want to talk it through first?";
const COMMUNITY_FOOTER = "Join the free OASIS Telegram community";

check("PROTOCOL and COMMUNITY keep their own next step, with the calendar offered under it", () => {
  for (const kind of ["protocol", "community"]) {
    const page = html[kind];
    assert.ok(page.includes("All set."), `${kind}: the thanks screen is gone`);
    assert.ok(page.includes(THANKS), `${kind}: the form's own next step (its thanks) is gone`);
    assert.ok(page.includes(OPTIONAL_HEADING), `${kind}: no calendar offered`);
    assert.ok(page.indexOf(THANKS) < page.indexOf(OPTIONAL_HEADING), `${kind}: the calendar must sit under the thanks`);
    assert.ok(/Optional: pick a \d+-minute call/.test(page), `${kind}: the call must say it is optional`);
    assert.ok(!page.includes(REQUIRED_HEADING), `${kind}: an optional call must not read as the next step`);
    assert.ok(!page.includes(COMMUNITY_FOOTER), `${kind}: the community link is already in the thanks`);
  }
});

check("an optional form whose visitor left the phone blank links to /book instead of a calendar it would refuse", () => {
  // Codex review of #655: the founder-meeting engine books only with a phone
  // (client_phone_required), and PROTOCOL and COMMUNITY ask for one as optional.
  for (const kind of ["protocolNoPhone", "communityNoAnswers"]) {
    const page = html[kind];
    assert.ok(page.includes("All set.") && page.includes(THANKS), `${kind}: the thanks is gone`);
    assert.ok(page.includes(OPTIONAL_HEADING), `${kind}: no call offered at all`);
    assert.ok(page.includes('href="/book"'), `${kind}: no way to book`);
    assert.ok(page.includes("asks for a phone number"), `${kind}: the booking page's reason is not said`);
    assert.ok(!/Optional: pick a \d+-minute call/.test(page), `${kind}: a calendar that cannot book was offered`);
    assert.ok(!page.includes("Checking the calendar"), `${kind}: a calendar that cannot book was mounted`);
  }
  for (const kind of ["protocol", "community"]) {
    assert.ok(!html[kind].includes('href="/book"'), `${kind}: a visitor with a phone books here, not on another page`);
  }
});

check("COMMAND (a founder call) still opens straight on the calendar", () => {
  assert.ok(html.command.includes(REQUIRED_HEADING));
  assert.ok(html.command.includes(COMMUNITY_FOOTER));
  assert.ok(!html.command.includes("All set."));
  assert.ok(!html.command.includes(OPTIONAL_HEADING));
});

check("the VSL router and another workspace's form never get the calendar", () => {
  for (const kind of ["vsl", "otherWorkspace"]) {
    assert.ok(html[kind].includes("All set."), kind);
    assert.ok(html[kind].includes(THANKS), kind);
    assert.ok(!html[kind].includes(OPTIONAL_HEADING), `${kind} offered OASIS's calendar`);
    assert.ok(!html[kind].includes(REQUIRED_HEADING), `${kind} offered OASIS's calendar`);
  }
});

check("an offer page whose form ends on the calendar shows no second booking link", () => {
  const src = readFileSync("components/offer-pages/OfferBook.tsx", "utf8");
  const calendarBranch = src.indexOf("{calendarOnPage ? (");
  const linkBranch = src.indexOf(") : bookingUrl ? (");
  assert.ok(calendarBranch > 0 && linkBranch > calendarBranch, "the inline-calendar case must be decided before the booking link");
  const between = src.slice(calendarBranch, linkBranch);
  assert.ok(!between.includes("href="), "the inline-calendar banner must not link anywhere");
  assert.match(src, /isPublicBookingSurface\(\{ tenantSlug: form\.tenantSlug, formSlug: form\.formSlug \}\)/);
});

console.log("offer-book-calendar: all passed");
