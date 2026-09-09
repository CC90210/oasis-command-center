/**
 * lead-quick-email-delivery.test.ts — the four defects CC found in one send.
 *
 * On 2026-09-09 one real email to Broadway Locksmith carried all of them:
 *
 *   1. It copied the SENDER, never the rep the lead belongs to. The lead is
 *      schneur@oasisai.work's; he received nothing. Sending from the shared
 *      mailbox, the header read From/Cc/Reply-To all conaugh@oasisai.work — a
 *      copy of a message already in that mailbox's own Sent folder.
 *   2. It greeted "Hi simon," because the scraped name is stored lowercase.
 *   3. It told the owner "The thing I flagged about your website: Has a site,
 *      not good" — an internal verdict, presented as our finding. prospectSafe
 *      is a BLOCKLIST and had never been taught that exact string.
 *   4. Its "grab a 15-minute slot" link pointed at a deleted Google
 *      appointment schedule: "Appointment not found".
 *
 * The existing tests stayed green through all four, because everything about
 * sending and CC is asserted by regex against SOURCE TEXT rather than by
 * running anything. These call the real functions instead.
 */
import assert from "node:assert/strict";

import {
  buildCopyList,
  finalizeCopyList,
  pickReplyTo,
} from "../lib/leads/lead-copy-recipients";
import { buildDraft, conditionProse, titleCaseName } from "../lib/leads/quick-email-draft";
import { renderQuickEmailHtml, toBlocks, safeHref } from "../lib/leads/quick-email-html";
import {
  resolveBookingUrl,
  isUsableBookingUrl,
  bookingUrlMisconfigured,
  RETIRED_BOOKING_URLS,
} from "../lib/booking-link";
import { buildGmailRawMessage } from "../lib/integrations/gmail-oauth-send";
import { composeOasisMessage } from "../lib/integrations/oasis-shared-gmail-send";

function run(name: string, fn: () => void) {
  fn();
  console.log(`  ok  ${name}`);
}

console.log("lead-quick-email-delivery:");

// The live values, from the tenant on 2026-09-09.
const REP = "schneur@oasisai.work";
const MAILBOX = "conaugh@oasisai.work";
const PROSPECT = "broadwaylocksmith@gmail.com";

// ── 1. The assigned rep is copied, and the mailbox never copies itself ──────

run("the ASSIGNED rep is copied, not just whoever pressed send", () => {
  const cc = buildCopyList({
    assignedRepEmail: REP,
    senderEmail: MAILBOX,
    toEmail: PROSPECT,
  });
  assert.ok(cc.includes(REP), "the rep the lead belongs to must be copied");
  assert.equal(cc[0], REP, "the assignee leads, so they become the Reply-To");
});

run("the shared mailbox is never copied on its own outgoing mail", () => {
  // CC sending from his own portal: sess.email IS the From address.
  const cc = finalizeCopyList([REP, MAILBOX], { to: PROSPECT, fromAddress: MAILBOX });
  assert.deepEqual(cc, [REP], "From, Cc and Reply-To were all one address");
});

run("a rep sending on someone else's lead copies BOTH", () => {
  const other = "ariel@oasisai.work";
  const cc = finalizeCopyList(buildCopyList({
    assignedRepEmail: REP,
    senderEmail: other,
    toEmail: PROSPECT,
  }), { to: PROSPECT, fromAddress: MAILBOX });
  assert.deepEqual(cc, [REP, other], "owner first, sender second");
  assert.equal(pickReplyTo(cc), REP, "the prospect's reply goes to the lead's owner");
});

run("the prospect is never also a Cc", () => {
  // A rep emailing themselves, and a lead assigned to the recipient.
  assert.deepEqual(
    buildCopyList({ assignedRepEmail: PROSPECT, senderEmail: PROSPECT, toEmail: PROSPECT }),
    [],
  );
});

run("duplicates and junk never reach an SMTP header", () => {
  const cc = buildCopyList({
    assignedRepEmail: REP,
    senderEmail: REP.toUpperCase(), // same person, different case
    toEmail: PROSPECT,
  });
  assert.deepEqual(cc, [REP], "case-insensitive de-duplication");

  // A malformed roster value must not fail the whole message.
  assert.deepEqual(
    buildCopyList({ assignedRepEmail: "not-an-address", senderEmail: REP, toEmail: PROSPECT }),
    [REP],
  );
});

run("no assignee degrades to the sender, never to nobody", () => {
  const cc = buildCopyList({ assignedRepEmail: null, senderEmail: REP, toEmail: PROSPECT });
  assert.deepEqual(cc, [REP], "an unassigned lead still copies whoever sent");
  assert.equal(pickReplyTo([]), null, "and with nothing to copy, no Reply-To header");
});

// ── 2. The greeting ────────────────────────────────────────────────────────

run("a lowercase scraped name is capitalised, a deliberate one is not", () => {
  assert.equal(titleCaseName("simon"), "Simon");
  assert.equal(titleCaseName("o'brien"), "O'Brien");
  assert.equal(titleCaseName("mary-jane"), "Mary-Jane");
  // Left alone: "Mccarthy" is a visible error where "mccarthy" is only untidy.
  assert.equal(titleCaseName("McCarthy"), "McCarthy");
  assert.equal(titleCaseName("van Veen"), "van Veen");
});

// ── 3. The finding that was never a finding ────────────────────────────────

run("every website_condition in the tenant is safe or silent", () => {
  // The complete live vocabulary: 5 distinct values across 1,973 rows.
  assert.equal(conditionProse("No website"), "From what I can see, you don't have a website yet.");
  assert.equal(
    conditionProse("DOES NOT HAVE A SITE"),
    "From what I can see, you don't have a website yet.",
    "shouty internal casing must still map, not leak",
  );
  assert.match(conditionProse("Website does not load"), /isn't loading/);

  // The two that must say NOTHING.
  assert.equal(conditionProse("Has a site, not good"), "", "a private verdict is not a finding");
  assert.equal(conditionProse("Has a site, not yet reviewed"), "", "nobody looked");
});

run("an unknown condition fails CLOSED", () => {
  // The blocklist failed open, which is how "Has a site, not good" shipped.
  assert.equal(conditionProse("Site is a bit tired honestly"), "");
  assert.equal(conditionProse(""), "");
});

run("the real leaked email no longer contains the verdict", () => {
  const draft = buildDraft(
    "follow_up",
    {
      name: "simon",
      company: "Broadway Locksmith",
      email: PROSPECT,
      industry: "locksmith",
      business_city: "",
      website: "",
      website_condition: "Has a site, not good",
      audit_findings: "Not audited yet - confirm on the call",
      notes: "",
    },
    "https://calendar.app.google/live-one",
  );
  assert.ok(!draft.body.includes("Has a site, not good"), "the verdict reached the owner");
  assert.ok(!draft.body.includes("Not audited yet"), "an internal placeholder reached the owner");
  assert.ok(draft.body.startsWith("Hi Simon,"), `greeting was: ${draft.body.slice(0, 20)}`);
  assert.ok(
    !/flagged about your website/.test(draft.body),
    "with nothing real to say, the paragraph must be absent rather than empty-headed",
  );
});

run("a REAL audit finding still gets through, with its label", () => {
  const draft = buildDraft(
    "follow_up",
    {
      name: "Simon", company: "Broadway Locksmith", email: PROSPECT, industry: "locksmith",
      business_city: "", website: "", website_condition: "Has a site, not good",
      audit_findings: "No mobile layout, and the contact form 500s.",
      notes: "",
    },
    "",
  );
  assert.match(draft.body, /The thing I flagged about your website:\nNo mobile layout/);
});

// ── 4. The booking link ────────────────────────────────────────────────────

run("the deleted booking link is refused even if configured again", () => {
  const dead = "https://calendar.app.google/tpfvJYBGircnGu8G8";
  assert.ok(RETIRED_BOOKING_URLS.length > 0);
  assert.equal(isUsableBookingUrl(dead), false, "this URL renders 'Appointment not found'");
  assert.equal(
    resolveBookingUrl({ NEXT_PUBLIC_BOOKING_URL: dead }),
    "",
    "pasting the old value back must not silently resume the outage",
  );
  assert.equal(bookingUrlMisconfigured({ NEXT_PUBLIC_BOOKING_URL: dead }), true);
});

run("there is NO hardcoded fallback any more", () => {
  assert.equal(resolveBookingUrl({}), "", "absent must be representable");
  assert.equal(bookingUrlMisconfigured({}), false, "unset is not the same as misconfigured");
});

run("a real https link is accepted, http and junk are not", () => {
  const good = "https://calendar.app.google/aBcDeF123";
  assert.equal(resolveBookingUrl({ NEXT_PUBLIC_BOOKING_URL: good }), good);
  assert.equal(isUsableBookingUrl("http://calendar.app.google/aBcDeF123"), false, "https only");
  assert.equal(isUsableBookingUrl("javascript:alert(1)"), false);
  assert.equal(isUsableBookingUrl("calendar.app.google/x"), false, "not a URL");
});

run("with no link the email still ASKS for a meeting", () => {
  const lead = {
    name: "Simon", company: "Broadway Locksmith", email: PROSPECT, industry: "locksmith",
    business_city: "", website: "", website_condition: "No website",
    audit_findings: "", notes: "",
  };
  const draft = buildDraft("follow_up", lead, "");
  assert.match(draft.body, /reply with a couple of times/i, "going silent loses the meeting");
  assert.ok(!draft.body.includes("http"), "and it must not emit a link it does not have");

  const withLink = buildDraft("follow_up", lead, "https://calendar.app.google/live-one");
  assert.match(withLink.body, /grab a 15-minute slot/);
});

// ── The HTML a prospect actually opens ─────────────────────────────────────

run("the booking link becomes a button, and stays visible as a URL", () => {
  const link = "https://calendar.app.google/live-one";
  const blocks = toBlocks(`Hi Simon,\n\nPick a time:\n${link}\n\nThanks.`);
  assert.equal(blocks.filter((b) => b.kind === "cta").length, 1);
  const html = renderQuickEmailHtml(`Hi Simon,\n\nPick a time:\n${link}\n\nThanks.`);
  assert.match(html, /Pick a time that suits you<\/a>/, "the CTA renders as a button");
  assert.ok(html.includes(link), "a button whose target is invisible reads as phishing");
});

run("rep-typed markup is escaped, and only http(s) is ever linked", () => {
  const html = renderQuickEmailHtml('Hi <img src=x onerror=alert(1)>,\n\nSee javascript:alert(2)');
  assert.ok(!html.includes("<img src=x"), "pasted markup became live markup");
  assert.ok(html.includes("&lt;img"), "it should be escaped, not stripped");
  assert.ok(!html.includes('href="javascript:'), "javascript: must never be linkified");
  assert.equal(safeHref("data:text/html,x"), null);
});

run("the HTML identifies OASIS, and no other company", () => {
  const html = renderQuickEmailHtml("Hi Simon,\n\nShort note.");
  assert.match(html, /OASIS AI Solutions/);
  assert.match(html, /Montreal, QC, Canada/);
  assert.match(html, /reply UNSUBSCRIBE/, "CASL: a working opt-out must be stated");
  // The other business on this codebase must never appear on an OASIS email.
  assert.ok(!/sunbiz/i.test(html), "another company's identity leaked into OASIS mail");
  assert.ok(!/Hallandale|Funding LLC/i.test(html));
});

run("no em dashes reach the prospect, as characters OR entities", () => {
  // The existing suite compares the literal character only, so an HTML entity
  // would have slipped straight past it.
  const html = renderQuickEmailHtml("Hi Simon,\n\nA note.", { signerName: "Conaugh" });
  assert.ok(!html.includes("—"), "em dash");
  assert.ok(!html.includes("&mdash;"), "em dash as an entity");
  assert.ok(!html.includes("&#8212;"), "em dash as a numeric entity");
});

run("the sign-off is the rep, above the OASIS identification block", () => {
  const html = renderQuickEmailHtml("Hi Simon,\n\nA note.", {
    signerName: "Conaugh",
    signerEmail: REP,
  });
  assert.ok(html.indexOf("Conaugh") < html.indexOf("Montreal"), "signature sits above the footer");
  assert.match(html, /mailto:schneur@oasisai\.work/, "the reader can see who to answer");
});

// ── THE ACTUAL MESSAGE, composed by the real code ──────────────────────────
//
// This is the assertion that was missing. Everything CC reported wrong lives in
// these headers, and every previous test of this feature compared SOURCE TEXT,
// which is how From/Cc/Reply-To all being one address passed review twice.

run("the header CC reported is gone, on the real composed message", () => {
  const msg = composeOasisMessage({
    to: PROSPECT,
    // Exactly the route's inputs when CC sends from his own seat: the mailbox
    // owner is the sender, and the lead belongs to someone else.
    cc: buildCopyList({ assignedRepEmail: REP, senderEmail: MAILBOX, toEmail: PROSPECT }),
    replyTo: REP,
    subject: "Following up: Broadway Locksmith",
    body: "Hi Simon,\n\nShort note.",
    html: renderQuickEmailHtml("Hi Simon,\n\nShort note."),
    signer: { name: "Conaugh", email: MAILBOX, phone: "" },
    fromAddress: MAILBOX,
  });

  assert.equal(msg.from, MAILBOX);
  assert.equal(msg.to, PROSPECT);
  // The whole complaint, in one line: it used to read cc === from.
  assert.equal(msg.cc, REP, "the mailbox was copying itself instead of the lead's rep");
  assert.notEqual(msg.cc, msg.from, "From and Cc must never be the same address");
  assert.equal(msg.replyTo, REP, "a reply must reach the rep, not the shared inbox");
  assert.notEqual(msg.replyTo, msg.from);
});

run("both parts are on the wire, and only the text part is signed", () => {
  const body = "Hi Simon,\n\nShort note.";
  const msg = composeOasisMessage({
    to: PROSPECT,
    subject: "S",
    body,
    html: renderQuickEmailHtml(body, { signerName: "Conaugh" }),
    signer: { name: "Conaugh", email: MAILBOX, phone: "" },
    fromAddress: MAILBOX,
  });

  assert.ok(msg.text && msg.html, "multipart: a client refusing HTML must still read it");
  // appendSignatureAndFooter is plain-text only. Applied to the markup it would
  // put the sign-off and the legal footer AFTER </body>.
  assert.match(msg.text, /\n---\n/, "the text part carries the plain-text footer");
  assert.ok(!msg.html!.includes("\n---\n"), "the plain-text footer leaked into the markup");
  // The legally-meaningful bit is the identification line — sender plus a real
  // address — and it must appear exactly once. The NAME alone appears several
  // times legitimately (title, logo alt, wordmark, sign-off), so counting that
  // would assert nothing.
  assert.equal(
    (msg.html!.match(/OASIS AI Solutions, Montreal, QC, Canada/g) || []).length,
    1,
    "the identification block must appear exactly once",
  );
  // The other business on this codebase must never appear on an OASIS message.
  assert.ok(!/sunbiz|Hallandale|Funding LLC/i.test(msg.text));
  assert.ok(!/sunbiz|Hallandale|Funding LLC/i.test(msg.html!));
});

run("an opt-out is declared as a header, not only as prose", () => {
  const msg = composeOasisMessage({
    to: PROSPECT, subject: "S", body: "Hi.", fromAddress: MAILBOX,
  });
  assert.equal(msg.headers["List-Unsubscribe"], `<mailto:${MAILBOX}?subject=UNSUBSCRIBE>`);
  assert.match(msg.text, /reply UNSUBSCRIBE/, "the header and the prose must agree");
});

run("no copy recipients means no Cc and no Reply-To headers at all", () => {
  const msg = composeOasisMessage({
    to: PROSPECT, cc: [], subject: "S", body: "Hi.", fromAddress: MAILBOX,
  });
  assert.equal(msg.cc, undefined, "an empty Cc header is malformed, not harmless");
  assert.equal(msg.replyTo, undefined, "replies then land on From, which is correct");
});

// ── Every transport, not just the one in use today ─────────────────────────
//
// Codex flagged on review that the two operator-mailbox branches took no `cc`
// at all. They are dormant right now (no rep on this tenant has a mailbox
// connected) which is exactly why it would have gone unnoticed: the first rep
// to connect Gmail would silently stop copying the lead's owner.

run("the OAuth transport emits a real Cc header", () => {
  const raw = buildGmailRawMessage({
    from: MAILBOX,
    to: PROSPECT,
    cc: REP,
    subject: "Test",
    body: "Body",
  });
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  assert.match(mime, /^Cc: schneur@oasisai\.work$/m, "the assignee gets no copy on this path");
  assert.ok(mime.indexOf("Cc:") > mime.indexOf("To:"), "header order");
});

run("the OAuth transport omits Cc entirely when there is nobody to copy", () => {
  const mime = Buffer.from(
    buildGmailRawMessage({ from: MAILBOX, to: PROSPECT, subject: "S", body: "B" }),
    "base64url",
  ).toString("utf8");
  assert.ok(!/^Cc:/m.test(mime), "an empty Cc header is malformed, not harmless");
});

run("no transport can copy the address it is sending from", () => {
  // The bridge fallback leaves from the shared mailbox and cannot filter it
  // itself, so the route excludes it when the list is BUILT. Both layers agree.
  const built = buildCopyList({
    assignedRepEmail: MAILBOX, // a lead assigned to the mailbox owner
    senderEmail: MAILBOX,
    toEmail: PROSPECT,
    excludeAddresses: [MAILBOX],
  });
  assert.deepEqual(built, [], "the bridge would have Cc'd its own From address");
});

run("the HTML stays small enough that Gmail will not clip it", () => {
  // Gmail clips around 102KB and hides everything after, including the footer
  // that carries the opt-out.
  const html = renderQuickEmailHtml("Hi Simon,\n\n" + "A reasonable paragraph. ".repeat(40));
  assert.ok(html.length < 60_000, `html was ${html.length} bytes`);
});
