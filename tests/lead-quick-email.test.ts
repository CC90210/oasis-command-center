/**
 * lead-quick-email.test.ts — what the one-click email is allowed to say.
 *
 * This feature hands a rep a pre-written message and a Send button during a live
 * call. The failure that matters is not a crash: it is a plausible sentence
 * about a stranger's business that nobody ever verified, arriving in that
 * business owner's inbox under our name. These tests pin the wording rules that
 * stop it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  INTERNAL_PLACEHOLDERS,
  buildDraft,
  defaultNextTouch,
  firstNameOf,
  prospectSafe,
  TEMPLATES,
  type QuickEmailLead,
} from "../lib/leads/quick-email-draft";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("lead-quick-email:");

const BOOKING = "https://calendar.app.google/EXAMPLE";

function lead(over: Partial<QuickEmailLead> = {}): QuickEmailLead {
  return {
    name: "Marc Lefebvre",
    company: "Coastline Auto Detailing",
    email: "marc@coastline.ca",
    industry: "Auto Detailing",
    business_city: "Collingwood",
    website: "https://coastline.ca",
    website_condition: "",
    audit_findings: "",
    notes: "",
    ...over,
  };
}

run("every internal placeholder is stripped, not sent", () => {
  // The exact strings the board stores on un-audited leads. Each one is honest
  // internally and indefensible in a prospect's inbox.
  for (const placeholder of [
    "Not audited yet - confirm on the call",
    "not audited yet",
    "  Not Audited Yet  ",
    "No website found yet, needs checking",
    "Has a site, not yet reviewed",
    "Not checked",
    "site NOT audited (fetch failed at seed time)",
    "no website finding on file, confirm on the call",
  ]) {
    assert.equal(prospectSafe(placeholder), "", `leaked: ${placeholder}`);
  }
});

run("a placeholder MID-TEXT is caught, not just as a prefix", () => {
  // Codex found this on review of the first version, which only checked
  // startsWith(). It is not hypothetical: this is the notes value on a real
  // lead on the board right now (the Vaughan HVAC record), and under a prefix
  // check the whole sentence went to the business owner.
  const realNote =
    "Vaughan, Ontario | HVAC | site NOT audited (fetch failed at seed time; " +
    "site confirmed reachable 2026-08-26) | no website finding on file, confirm on the call";
  assert.equal(prospectSafe(realNote), "", "the live HVAC note leaked");

  for (const mid of [
    "Mobile is slow; not audited yet - confirm on the call",
    "Owner keen. No website finding on file.",
    "Spoke to Dave — site not audited, will revisit",
    "Looks dated.  Not   audited   yet", // collapsed whitespace must not dodge it
  ]) {
    assert.equal(prospectSafe(mid), "", `leaked mid-text: ${mid}`);
  }

  // And through the full draft, on every template.
  for (const t of TEMPLATES) {
    const { body } = buildDraft(t.id, lead({ notes: realNote }), BOOKING);
    assert.ok(
      !/confirm on the call|not audited|no website finding/i.test(body),
      `${t.id} leaked the live HVAC note`,
    );
  }
});

run("real findings survive untouched", () => {
  const real = "Your site takes 9 seconds to load on mobile and the contact form 404s.";
  assert.equal(prospectSafe(real), real);
});

run("a lead with only placeholder findings produces an email naming none of them", () => {
  const l = lead({
    audit_findings: "Not audited yet - confirm on the call",
    website_condition: "Has a site, not yet reviewed",
  });
  for (const t of TEMPLATES) {
    const { body } = buildDraft(t.id, l, BOOKING);
    const hay = body.toLowerCase();
    for (const p of INTERNAL_PLACEHOLDERS) {
      assert.ok(!hay.includes(p), `${t.id} leaked "${p}" into the prospect's email`);
    }
    // And it must not invent a replacement finding either — the paragraph is
    // simply absent.
    assert.ok(
      !/what i noticed about your website/i.test(body),
      `${t.id} kept the findings heading with nothing real behind it`,
    );
  }
});

run("a real finding IS included, with its heading", () => {
  const l = lead({ audit_findings: "No mobile layout; the booking page is a PDF." });
  const { body } = buildDraft("thanks_for_call", l, BOOKING);
  assert.match(body, /What I noticed about your website:/);
  assert.match(body, /No mobile layout; the booking page is a PDF\./);
});

run("findings beat the one-line condition when both are real", () => {
  const l = lead({
    audit_findings: "Contact form 404s.",
    website_condition: "Dated site.",
  });
  const { body } = buildDraft("thanks_for_call", l, BOOKING);
  assert.match(body, /Contact form 404s\./);
  assert.ok(!body.includes("Dated site."), "the weaker signal should not also appear");
});

run("the booking link appears when given and is absent when suppressed", () => {
  const withLink = buildDraft("info_request", lead(), BOOKING);
  assert.ok(withLink.body.includes(BOOKING), "booking link missing");
  assert.match(withLink.body, /15-minute/, "the ask must bound the time commitment");

  // hasBookedMeeting passes "" — a second self-book link would let them book a
  // conflicting time against an already-agreed meeting.
  const suppressed = buildDraft("info_request", lead(), "");
  assert.ok(!suppressed.body.includes("calendar.app.google"), "link leaked while suppressed");
  assert.ok(!/pick whatever time/i.test(suppressed.body), "orphaned booking sentence remained");
});

run("a contact name that is really the company name never becomes a greeting", () => {
  // The live shape on scraped rows: contact name == business name.
  assert.equal(firstNameOf("HVAC Mechanical Systems Inc", "HVAC Mechanical Systems Inc"), "there");
  assert.equal(firstNameOf("HVAC Mechanical Systems Inc.", "HVAC Mechanical Systems Inc"), "there");
  assert.equal(firstNameOf("", "Coastline Auto Detailing"), "there");
  assert.equal(firstNameOf("Marc Lefebvre", "Coastline Auto Detailing"), "Marc");

  const { body } = buildDraft(
    "thanks_for_call",
    lead({ name: "HVAC Mechanical Systems Inc", company: "HVAC Mechanical Systems Inc" }),
    BOOKING,
  );
  assert.match(body, /^Hi there,/, "greeted the prospect by their own company name");
});

run("the next-touch default is a business day, three days out, at 9am", () => {
  // From a Friday, three business days is the following Wednesday.
  const friday = new Date(2026, 8, 11, 14, 30);
  assert.equal(new Date(defaultNextTouch(friday)).getDay(), 3, "landed off a business day");
  assert.match(defaultNextTouch(friday), /T09:00$/);

  // From a Monday it is Thursday, and never a weekend from any start day.
  for (let i = 0; i < 7; i += 1) {
    const start = new Date(2026, 8, 7 + i, 10, 0);
    const day = new Date(defaultNextTouch(start)).getDay();
    assert.ok(day !== 0 && day !== 6, `weekend follow-up scheduled from day ${i}`);
  }
});

run("the send path is wired into the pipeline lead workspace, not just /leads", () => {
  // CC's report was that the feature existed on one screen and not the one reps
  // actually work. A unit test on the draft cannot see that, so assert the wiring.
  const editor = readFileSync("components/leads/LeadContextEditor.tsx", "utf8");
  assert.match(editor, /LeadQuickEmail/, "quick email is not rendered by the lead-details editor");
  assert.match(
    editor,
    /audit_findings:\s*state\.audit_findings/,
    "the draft must read the LIVE form state, not the saved row",
  );

  const page = readFileSync("app/pipeline/[id]/page.tsx", "utf8");
  assert.match(page, /bookingUrl=\{BOOKING_URL\}/, "booking url must be resolved server-side");
  assert.match(page, /hasBookedMeeting=\{/, "booked-meeting suppression is not wired");

  // NOT stage-gated: CC asked for this on every stage, so no stage condition may
  // guard the component.
  const quick = readFileSync("components/leads/LeadQuickEmail.tsx", "utf8");
  assert.ok(
    !/stage\s*===\s*["']connected["']/.test(quick),
    "the quick email must not be restricted to one stage",
  );

  // The recipient must FOLLOW the editor above while untouched. Seeding `to`
  // from lead.email once meant a rep who corrected the Email field kept sending
  // to the stale address, in the one component that claims to track the live
  // form. Codex caught it; this pins the sync.
  assert.match(
    quick,
    /if \(!touched && upstreamEmail !== seenUpstream\)/,
    "recipient no longer follows the live editor state",
  );

  // A send whose response we lost is NOT a failed send: the route commits the
  // queued interaction row before it finishes, so "Send failed" is what makes a
  // rep press the button again and email the owner twice.
  assert.ok(
    !/setStatus\(\s*err instanceof Error \? err\.message : "Send failed\."/.test(quick),
    "the error path claims the send failed when it may already be queued",
  );
  assert.match(quick, /may already have been queued/, "the ambiguous-send warning is missing");

  // ...and the retry is BLOCKED, not merely discouraged. A warning sentence
  // beside a live Send button is not a control: the rep presses it again and
  // the owner gets two identical emails. Codex and CodeRabbit both landed here.
  assert.match(quick, /setUnconfirmed\(true\)/, "an unconfirmed send must latch");
  assert.match(quick, /unconfirmed \?/, "the Send button is not gated on the unconfirmed state");
  assert.match(quick, /Send anyway/, "no deliberate second action to override");
  // ...and that control must actually SEND. It first only cleared the latch, so
  // a rep pressing a button labelled "Send anyway" got nothing.
  assert.match(
    quick,
    /setUnconfirmed\(false\);\s*void send\(\)/,
    '"Send anyway" does not send — it only clears the latch',
  );
  // The outcome of an already-sent message is announced, not just painted.
  assert.match(quick, /role="status" aria-live="polite"/, "send result is not announced");

  // The /leads composer posts to the SAME route and needs the SAME guard —
  // fixing one of two callers leaves the duplicate-send open on the other.
  const file = readFileSync("components/leads/LeadFileBody.tsx", "utf8");
  assert.match(file, /setUncertain\(true\)/, "the /leads composer has no uncertain-send latch");
  // Asserted as separate fragments: the sentence is split across a line break by
  // string concatenation, and a regex spanning that join pins the FORMATTING
  // rather than the behaviour — it would go red on a prettier reflow that
  // changed nothing a rep sees.
  assert.match(file, /Couldn't confirm the send/, "missing the ambiguous-send wording");
  assert.match(file, /have been queued/, "missing the may-still-be-delivered warning");
  assert.match(file, /uncertain \? "Send again" : "Send"/, "the resend is not relabelled");
});
