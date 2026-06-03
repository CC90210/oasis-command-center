import assert from "node:assert/strict";

// Phase 3b (TT + Kixie embedding, 2026-06-02): the Conversations inbox
// groups lead_interactions rows into per-contact threads. This locks the
// pure grouping + phone-normalization logic (lib/conversation-threading.ts)
// so a refactor can't silently break threading.

import {
  groupRowsIntoThreads,
  normalizePhoneE164,
  type RawInteractionRow,
} from "../lib/conversation-threading";

// --- normalizePhoneE164 ----------------------------------------------------
assert.equal(normalizePhoneE164("+14165551212"), "+14165551212", "already E.164 passes through");
assert.equal(normalizePhoneE164("4165551212"), "+14165551212", "10-digit → +1");
assert.equal(normalizePhoneE164("14165551212"), "+14165551212", "11-digit leading 1 → +1");
assert.equal(normalizePhoneE164("(416) 555-1212"), "+14165551212", "formatted → E.164");
assert.equal(normalizePhoneE164(""), null, "empty → null");
assert.equal(normalizePhoneE164(null), null, "null → null");

// --- grouping --------------------------------------------------------------
function row(over: Partial<RawInteractionRow>): RawInteractionRow {
  return {
    id: "x",
    channel: "sms",
    direction: "outbound",
    type: null,
    subject: null,
    content_preview: "",
    created_at: "2026-06-02T09:00:00Z",
    sent_at: null,
    from_phone: null,
    to_phone: null,
    to_email: null,
    metadata: null,
    recording_url: null,
    transcript_url: null,
    disposition: null,
    call_outcome: null,
    call_duration_sec: null,
    kixie_call_id: null,
    lead_id: null,
    actor_user_id: null,
    ...over,
  };
}

// Rows arrive newest-first (created_at desc), as the DB query returns them.
const rows: RawInteractionRow[] = [
  // Newest — outbound SMS to lead L1.
  row({ id: "A", lead_id: "L1", direction: "outbound", to_phone: "+14165551212", content_preview: "Newest", created_at: "2026-06-02T10:00:00Z" }),
  // Older — inbound SMS from the same lead, carries a TT chat_id.
  row({ id: "B", lead_id: "L1", direction: "inbound", from_phone: "(416) 555-1212", to_phone: "+19990000000", content_preview: "older", created_at: "2026-06-02T09:00:00Z", metadata: { tt_chat_id: "chat123" } }),
  // No lead — inbound SMS from a bare phone.
  row({ id: "C", direction: "inbound", from_phone: "+14165550000", to_phone: "+18880000000", content_preview: "hi there", created_at: "2026-06-02T09:30:00Z" }),
  // No lead — outbound SMS to the same bare phone (should thread with C).
  row({ id: "D", direction: "outbound", to_phone: "4165550000", content_preview: "earlier reply", created_at: "2026-06-02T09:20:00Z" }),
];

const threads = groupRowsIntoThreads(rows, { L1: "Acme Co" });

// Two threads: the lead thread + the bare-phone thread.
assert.equal(threads.length, 2, "two distinct threads");

const lead = threads.find((t) => t.key === "lead:L1");
assert.ok(lead, "lead-keyed thread exists");
assert.equal(lead.contact_label, "Acme Co", "label resolved from the labels map");
assert.equal(lead.contact_phone, "+14165551212", "counterpart phone normalized");
assert.equal(lead.messages.length, 2, "both lead rows threaded");
assert.equal(lead.messages[0].preview, "older", "messages flipped to chronological (oldest first)");
assert.equal(lead.messages[1].preview, "Newest", "newest message last");
assert.equal(lead.last_preview, "Newest", "last_preview is the newest row");
assert.equal(lead.last_at, "2026-06-02T10:00:00Z", "last_at is the newest timestamp");
assert.equal(lead.inbound_count, 1, "one inbound in the lead thread");
assert.equal(lead.tt_chat_id, "chat123", "tt_chat_id surfaced for AI-reply availability");

const phone = threads.find((t) => t.key === "phone:+14165550000");
assert.ok(phone, "bare-phone thread exists");
assert.equal(phone.messages.length, 2, "inbound + outbound to the same number thread together");
assert.equal(phone.inbound_count, 1, "one inbound in the phone thread");
assert.equal(phone.contact_phone, "+14165550000", "phone-keyed contact phone");

console.log("ok conversations-grouping");
