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
    assert.ok(!page.includes("Not ready to book?"), `${kind}: the required calendar's footer on an optional call`);
  }
});

check("COMMUNITY's last screen links to the community; PROTOCOL's does not (review of #655)", () => {
  // The thanks names the community address only as text; COMMUNITY's next step is to click it.
  const link = /href="\/go\/community\?form=community&amp;t=oasis-ai-cc&amp;step=4"/;
  for (const kind of ["community", "communityNoAnswers"]) {
    assert.match(html[kind], link, `${kind}: no community link to click`);
    assert.equal(html[kind].split(COMMUNITY_FOOTER).length - 1, 1, `${kind}: the community link drawn twice`);
    assert.ok(html[kind].indexOf(COMMUNITY_FOOTER) < html[kind].indexOf(OPTIONAL_HEADING), `${kind}: the community link must come before the optional call`);
  }
  for (const kind of ["protocol", "protocolNoPhone", "protocolBadPhone"]) {
    assert.ok(!html[kind].includes("/go/community"), `${kind}: PROTOCOL's next step is the checkout, not the community`);
  }
});

check("an optional form whose visitor left the phone blank links to /book instead of a calendar it would refuse", () => {
  // Codex review of #655: the founder-meeting engine books only with a phone
  // (client_phone_required), and PROTOCOL and COMMUNITY ask for one as optional.
  // A phone the engine would refuse ("123": invalid_client_phone) is no phone (Codex re-review of #655).
  for (const kind of ["protocolNoPhone", "communityNoAnswers", "protocolBadPhone"]) {
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
  assert.match(html.command, /Not ready to book\?[^<]*<\/p><a href="\/go\/community\?form=command&amp;t=oasis-ai-cc&amp;step=4"/, "the calendar's footer markup changed");
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
  // Review of #655: an optional call is offered, never announced as the next step.
  assert.match(between, /callOptional\s*\?\s*"A few quick questions below\. At the end you can also book a call here, if you would like one\."/);
  assert.match(src, /const callOptional = calendarOnPage && isOptionalPublicBookingFormSlug\(/);
  assert.ok(!between.includes("href="), "the inline-calendar banner must not link anywhere");
  assert.match(src, /isPublicBookingSurface\(\{ tenantSlug: form\.tenantSlug, formSlug: form\.formSlug \}\)/);
});

// ── Book sooner (CC, 2026-10-16: "make joining as easy as possible") ─────────
const EARLY_HEADING = "Book your call now. The questions can wait.";

check("AI audit, COMMAND and FLEET: the early calendar invites the booking, with the questions one click away", () => {
  const page = html.earlyCalendar;
  assert.ok(page.includes(EARLY_HEADING), "the early heading (copy by Maven) is gone");
  assert.match(page, /<button type="button"[^>]*>Answer the questions first<\/button>/, "no way back to the questions");
  assert.ok(!page.includes(REQUIRED_HEADING), "the after-the-form heading on the early calendar");
  assert.ok(!page.includes(COMMUNITY_FOOTER), "the early calendar sends visitors to the community before the questions");
  assert.ok(page.includes("Checking the calendar"), "the early calendar reads the live open times like the other");
});

check("the form still opens on its contact step, and finishing first still ends on the usual calendar", () => {
  assert.match(html.auditFirstScreen, />Your name<span/, "the contact step is not the first screen");
  assert.ok(html.auditFirstScreen.includes("Step 1 / 4"));
  assert.ok(!html.auditFirstScreen.includes(EARLY_HEADING), "the calendar opened before the contact step");
  assert.ok(!html.auditFirstScreen.includes("Checking the calendar"));
  assert.ok(html.auditLastScreen.includes(REQUIRED_HEADING), "finish-first lost its calendar");
  assert.ok(html.auditLastScreen.includes(COMMUNITY_FOOTER));
  assert.ok(!html.auditLastScreen.includes(EARLY_HEADING));
});

check("a homepage visitor (contact step already sent) lands on the early calendar, and only there", () => {
  assert.ok(html.homepageHandoff.includes(EARLY_HEADING), "the homepage's audit visitors never see the early calendar");
  assert.ok(!html.homepageHandoff.includes("Step 2 / 4"), "the step counter over the calendar");
  for (const kind of ["resumeAtStep2", "handoffOnProtocol"]) {
    assert.ok(!html[kind].includes(EARLY_HEADING), `${kind}: the calendar opened without a contact-step handoff on an early form`);
    assert.ok(html[kind].includes("Step 2 / "), `${kind}: the visitor did not resume at step 2`);
  }
  const page = readFileSync("app/f/[tenant_slug]/[form_slug]/[lead_token]/page.tsx", "utf8");
  // initialStep is set ONLY by the narrow homepage handoff marker on the canonical audit form.
  assert.match(page, /contactStepHandoff=\{initialStep !== undefined\}/);
  assert.match(page, /const initialStep =\s*result\.tenant_slug === AI_AUDIT_TENANT_SLUG &&\s*result\.form\.slug === AI_AUDIT_SLUG &&\s*sp\[AUDIT_FORM_HANDOFF\.markerParam\]/);
});

check("the form opens the early calendar once, after the contact step, on both submit paths", () => {
  const src = readFileSync("components/forms/FormPublicClient.tsx", "utf8");
  assert.match(
    src,
    /const booksAfterContact = Boolean\(\s*tenantSlug && formSlug && steps\.length > 1 &&\s*isPublicBookingSurface\(\{ tenantSlug, formSlug \}\) && isEarlyPublicBookingFormSlug\(formSlug\),\s*\);/,
  );
  assert.match(
    src,
    /function advanceFrom\(step: number, next: number\) \{\s*if \(step === 0 && booksAfterContact && !earlyCalendarOffered\.current\) \{\s*earlyCalendarOffered\.current = true;\s*setEarlyCalendarStep\(next\);\s*\} else \{\s*setCurrentStep\(next\);/,
  );
  assert.match(src, /if \(finished\) setDone\(true\);\s*else advanceFrom\(currentStep, currentStep \+ 1\);/, "the preview skips the early calendar");
  assert.match(src, /if \(data\.next_step !== null && data\.next_step !== undefined\) \{\s*advanceFrom\(currentStep, data\.next_step\);/, "a visitor skips the early calendar");
  assert.equal(src.match(/setCurrentStep\(data\.next_step\)/g), null, "a submit path moves on without the early calendar");
});

check("after an early booking the questions are optional, and finishing them never shows the calendar again", () => {
  const src = readFileSync("components/forms/FormPublicClient.tsx", "utf8");
  const early = src.slice(src.indexOf("earlyCalendarStep !== null && publicBookingFormSlug ? ("), src.indexOf("{serverError && ("));
  assert.match(early, /onAnswerFirst: resumeQuestions,\s*onBooked: \(\) => setBookedEarly\(true\),/);
  assert.match(early, /afterBooked: skippedQuestions \? null : \(/, "Skip does not hide the invitation");
  assert.ok(early.includes("Answer the rest of the questions so the call starts with your business. Conaugh reads every one personally."));
  assert.match(early, /onClick=\{resumeQuestions\}[\s\S]{0,300}>\s*Answer the questions\s*</);
  assert.match(early, /onClick=\{\(\) => setSkippedQuestions\(true\)\}[\s\S]{0,300}>\s*Skip\s*</);
  const done = src.slice(src.indexOf("{done ? ("), src.indexOf("earlyCalendarStep !== null && publicBookingFormSlug ? ("));
  assert.ok(done.indexOf("bookedEarly ? (") > 0, "the booked ending is gone");
  assert.ok(done.indexOf("bookedEarly ? (") < done.indexOf("<PublicBookingCalendar"), "a booked visitor reaches the calendar again");
  assert.ok(done.includes("Thanks. Your answers are in, and Conaugh reads every one personally."));
  assert.match(src, /function resumeQuestions\(\) \{\s*if \(earlyCalendarStep !== null\) setCurrentStep\(earlyCalendarStep\);\s*setEarlyCalendarStep\(null\);/);
  const calendar = readFileSync("components/forms/PublicBookingCalendar.tsx", "utf8");
  assert.match(calendar, /setReceipt\(data\);\s*early\?\.onBooked\(\);/, "the form is never told the call is booked");
  const receipt = calendar.slice(calendar.indexOf("if (receipt) {"), calendar.indexOf("return (\n    <div className=\"space-y-5 py-3\">"));
  assert.ok(receipt.includes("{early?.afterBooked}"), "the questions invitation is not under the receipt");
});

check("on an offer page, no banner says the questions come first when the calendar comes first", () => {
  const src = readFileSync("components/offer-pages/OfferBook.tsx", "utf8");
  assert.match(src, /const callAfterContact = calendarOnPage && isEarlyPublicBookingFormSlug\(form\?\.formSlug \?\? ""\);/);
  assert.match(src, /\{mode === "form_then_link" && contactDone && !callAfterContact \? \(/);
});

console.log("offer-book-calendar: all passed");
