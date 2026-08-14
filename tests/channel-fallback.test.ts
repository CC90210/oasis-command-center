/**
 * tests/channel-fallback.test.ts — reach the merchant on whatever we have.
 *
 * Adon, 2026-08-10: "The ones that have emails will answer an email. The ones
 * that don't, if we have their number, we have to write a text to them."
 *
 * The behaviour being replaced is the quiet one: an email step for a phone-only
 * lead used to be skipped and the sequence walked on, so the run looked healthy
 * and the person heard nothing. 420 of 1,197 leads are phone-only, so that was
 * a third of the book.
 */

import assert from "node:assert/strict";
import { contactabilityOf, resolveChannel, onProviderGap } from "../lib/drips/channel-fallback";

// ── Reading what we can reach them on ─────────────────────────────────────
assert.deepEqual(contactabilityOf({ email: "a@b.com", phone: "305-555-0147" }), { hasEmail: true, hasPhone: true });
assert.deepEqual(contactabilityOf({ email: "a@b.com" }), { hasEmail: true, hasPhone: false });
assert.deepEqual(contactabilityOf({ phone: "3055550147" }), { hasEmail: false, hasPhone: true });
assert.deepEqual(contactabilityOf({}), { hasEmail: false, hasPhone: false });

// A partial phone is NOT reachable. Counting it would push the step to a
// provider that rejects it, turning an honest "we cannot reach them" into a
// delivery failure charged against the sending number.
assert.equal(contactabilityOf({ phone: "555-0147" }).hasPhone, false);
assert.equal(contactabilityOf({ phone: "" }).hasPhone, false);
// Junk in the email field must not read as an address.
assert.equal(contactabilityOf({ email: "n/a" }).hasEmail, false);
assert.equal(contactabilityOf({ email: "  " }).hasEmail, false);

const both = { hasEmail: true, hasPhone: true };
const emailOnly = { hasEmail: true, hasPhone: false };
const phoneOnly = { hasEmail: false, hasPhone: true };
const neither = { hasEmail: false, hasPhone: false };

// ── The preferred channel wins when it is available ───────────────────────
{
  const d = resolveChannel("email", both);
  assert.equal(d.send && d.channel, "email");
  assert.equal(d.send && d.substituted, false);
}
{
  const d = resolveChannel("sms", both);
  assert.equal(d.send && d.channel, "sms");
  assert.equal(d.send && d.substituted, false);
}

// ── THE RULE: no email, but we have a number, so text them ────────────────
// This is the case that was silently skipped before. 420 leads.
{
  const d = resolveChannel("email", phoneOnly);
  assert.equal(d.send, true);
  assert.equal(d.send && d.channel, "sms");
  assert.equal(d.send && d.substituted, true, "the substitution must be recorded, not hidden");
  assert.match(d.send ? d.reason : "", /no email address/);
}

// And the mirror: an SMS step for someone we only have an email for.
{
  const d = resolveChannel("sms", emailOnly);
  assert.equal(d.send && d.channel, "email");
  assert.equal(d.send && d.substituted, true);
}

// ── Neither: unreachable, and it must SAY so ──────────────────────────────
// 37 leads overall, plus 23 of the 84 live subs, exist with no way to contact
// anyone. Absorbing that as a routine skip is how it stays invisible.
for (const pref of ["email", "sms"] as const) {
  const d = resolveChannel(pref, neither);
  assert.equal(d.send, false);
  assert.equal(d.send === false && d.reason, "unreachable");
  assert.match(d.send === false ? d.detail : "", /neither/);
}

// ── A locked step is not rewritten onto another channel ───────────────────
// Turning a bank-statement request with an attachment into a text is not the
// same message. Better to report the miss than to send something else.
{
  const d = resolveChannel("email", phoneOnly, { channelLocked: true });
  assert.equal(d.send, false);
  assert.equal(d.send === false && d.reason, "unreachable");
  assert.match(d.send === false ? d.detail : "", /locked to email/);
}
// Locked still sends when the channel IS available.
{
  const d = resolveChannel("email", both, { channelLocked: true });
  assert.equal(d.send && d.channel, "email");
}

// ── PROVIDER gap ≠ contact gap ────────────────────────────────────────────
// The outage of 2026-08-14. resolveChannel said "text them, we have a phone",
// then the provider refused, and the row rescheduled. Forever. Nothing overdue,
// nothing failed, no attempt burned — and total drip volume was ONE email in 24
// hours because 274 rows were circling in a hold loop:
//
//   220  Follow-up sequence        Bluerise has no SMS numbers yet      +6h
//    54  Viewed application nudge  19 consecutive carrier failures      +2h
{
  // Bluerise will never have SMS numbers. Holding an emailable lead for a
  // channel that is not coming back is silence with extra steps.
  const d = onProviderGap({ blocked: "sms", contact: both, gap: "Bluerise has no SMS numbers yet" });
  assert.equal(d.action, "fallback");
  assert.equal(d.action === "fallback" && d.channel, "email");
  assert.match(d.reason, /Bluerise has no SMS numbers yet/, "the original gap stays in the reason");
}
{
  // A transient carrier halt is still better answered by an email than by 2h of
  // nothing, when we have an address.
  const d = onProviderGap({ blocked: "sms", contact: both, gap: "19 consecutive carrier failures" });
  assert.equal(d.action, "fallback");
}
{
  // No alternate: waiting really is the only option, so it must still hold —
  // and the reason has to say WHY it could not substitute, or the next person
  // reading the row relearns this from scratch.
  const d = onProviderGap({ blocked: "sms", contact: phoneOnly, gap: "carrier halt" });
  assert.equal(d.action, "hold");
  assert.match(d.reason, /no email for this lead either/);
}
{
  // A locked step is never rewritten, provider gap or not. Same rule as above,
  // applied one layer down.
  const d = onProviderGap({ blocked: "sms", contact: both, channelLocked: true, gap: "carrier halt" });
  assert.equal(d.action, "hold");
  assert.match(d.reason, /locked to sms/);
}
{
  // Symmetric: an email provider outage falls back to text when we have a
  // number. Not wired into the executor today, but the rule must not be
  // one-directional or the next caller gets a surprise.
  const d = onProviderGap({ blocked: "email", contact: both, gap: "mailbox credential rejected" });
  assert.equal(d.action, "fallback");
  assert.equal(d.action === "fallback" && d.channel, "sms");
}
{
  const d = onProviderGap({ blocked: "email", contact: emailOnly, gap: "mailbox credential rejected" });
  assert.equal(d.action, "hold", "no phone to fall back to");
}

console.log("channel-fallback.test.ts — all assertions passed");
