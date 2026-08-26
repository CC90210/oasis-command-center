/**
 * tests/calendar-reminder.test.ts — the follow-up reminder adapter.
 *
 * These drive the REAL request building and the REAL status handling against a
 * scripted Google, rather than asserting that a string appears in the source.
 * The distinction matters here more than usual: this repo has already been bitten
 * three times by source-text assertions that cannot tell a safe refactor from a
 * removed protection, going red on the first and staying green on the second.
 *
 * The privacy block is the load-bearing one. A reminder carries the operator's
 * own call notes ("gatekeeper blocks before 10am"), so an attendee on this event
 * would mail that sentence to the prospect.
 */

import assert from "node:assert/strict";
import {
  writeReminderEvent,
  removeReminderEvent,
  isRetryableFailure,
  type ReminderSession,
} from "@/lib/integrations/calendar-reminder";

type Call = { url: string; init: RequestInit };

/** A scripted Google. Each entry answers one HTTP call, in order. */
function session(responses: Array<Response | (() => Promise<never>)>): {
  session: ReminderSession;
  calls: Call[];
} {
  const calls: Call[] = [];
  let i = 0;
  const s: ReminderSession = {
    calendarId: "primary",
    authorizedFetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses[i++];
      if (!next) throw new Error(`unscripted call ${i}: ${url}`);
      if (typeof next === "function") return next();
      return next;
    },
  };
  return { session: s, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function main() {

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const INPUT = {
  summary: "Call Rosetti Plumbing",
  description: "Your note: gatekeeper blocks before 10am, ask for Dana",
  startAt: FUTURE,
  timeZone: "America/Toronto",
};

/* ---------------------------------------------------------------- privacy */

{
  const { session: s, calls } = session([json({ id: "evt_1", htmlLink: "https://cal/1" })]);
  const result = await writeReminderEvent("t1", "u1", null, INPUT, {
    openSession: async () => s,
  });
  assert.equal(result.ok, true);

  const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
  assert.ok(!("attendees" in body), "a reminder must never carry attendees: it would mail the note to the lead");
  assert.ok(!("conferenceData" in body), "a reminder is not a meeting and must not mint a Meet link");
  assert.equal(body.visibility, "private", "the reminder must be private to the operator");
  assert.match(calls[0].url, /sendUpdates=none/, "no invitation mail may be sent, ever");
  assert.equal(
    (body.description as string).includes("gatekeeper"),
    true,
    "the operator's own note is the point of the reminder and must survive",
  );
}

{
  // The shared workspace identity must never host a private reminder. It would
  // publish the operator's call notes to everyone in the workspace AND still
  // not reach the phone the feature exists to reach, which is a plausible
  // wrong answer rather than an honest failure.
  const { calls } = session([]);
  const result = await writeReminderEvent("t1", "u1", null, INPUT, {
    openSession: async () => ({
      calendarId: "oasis-workspace",
      systemFallback: true,
      authorizedFetch: async (url, init) => {
        calls.push({ url, init });
        return json({ id: "evt_leak" });
      },
    }),
  });
  assert.equal(result.ok, false, "a workspace-hosted reminder must be refused, not silently created");
  assert.equal(
    !result.ok && result.reason,
    "not_connected",
    "the operator must be told to connect their OWN account, which is the only thing that can work",
  );
  assert.equal(calls.length, 0, "nothing may be written to the shared workspace calendar");
}

{
  // The same fallback IS correct for the founder-meeting path, so the refusal
  // must be specific to reminders: a normal personal session still works.
  const { session: s } = session([json({ id: "evt_ok" })]);
  const result = await writeReminderEvent("t1", "u1", null, INPUT, {
    openSession: async () => ({ ...s, systemFallback: false }),
  });
  assert.equal(result.ok, true, "a personal connection must still be allowed to write");
}

/* ------------------------------------------------------- the id lifecycle */

{
  // No stored id: insert, and hand back the id GOOGLE chose.
  const { session: s, calls } = session([json({ id: "evt_new", htmlLink: null })]);
  const result = await writeReminderEvent("t1", "u1", null, INPUT, { openSession: async () => s });
  assert.deepEqual(
    { ok: result.ok, id: result.ok ? result.eventId : null, recreated: result.ok ? result.recreated : null },
    { ok: true, id: "evt_new", recreated: false },
  );
  assert.equal(calls[0].init.method, "POST");
}

{
  // Stored id: PATCH it, do not create a second reminder.
  const { session: s, calls } = session([json({ id: "evt_1", htmlLink: null })]);
  const result = await writeReminderEvent("t1", "u1", "evt_1", INPUT, { openSession: async () => s });
  assert.equal(result.ok && result.eventId, "evt_1");
  assert.equal(calls.length, 1, "moving a reminder is one call, not a delete plus a create");
  assert.equal(calls[0].init.method, "PATCH");
}

for (const deadStatus of [404, 410]) {
  // The stored id is dead (deleted, or a cancelled tombstone). Do NOT try to
  // revive or reuse it -- that was two of the six defects in the earlier
  // implementation. Create a fresh event and hand back the NEW id.
  const { session: s, calls } = session([
    json({ error: "gone" }, deadStatus),
    json({ id: "evt_fresh", htmlLink: null }),
  ]);
  const result = await writeReminderEvent("t1", "u1", "evt_dead", INPUT, { openSession: async () => s });
  assert.equal(result.ok, true, `a ${deadStatus} on the stored id must recover, not fail`);
  assert.equal(result.ok && result.eventId, "evt_fresh");
  assert.equal(
    result.ok && result.recreated,
    true,
    "recreated must be true so the caller knows it MUST persist the new id",
  );
  assert.equal(calls[1].init.method, "POST");
  const reinserted = JSON.parse(String(calls[1].init.body)) as Record<string, unknown>;
  assert.ok(!("id" in reinserted), "the dead id must never be reused: Google's ids are not recyclable");
}

{
  // Google accepted the write but told us nothing addressable. Inventing an id
  // here would produce a reminder nothing could ever clear.
  const { session: s } = session([json({ htmlLink: "https://cal/x" })]);
  const result = await writeReminderEvent("t1", "u1", null, INPUT, { openSession: async () => s });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "retryable");
}

/* ------------------------------------------------- failure classification */

const CLASSIFY: Array<[number, string, string]> = [
  [503, "", "retryable"],
  [429, "", "retryable"],
  [500, "", "retryable"],
  // authorizedFetch already refreshed and retried once before we see a 401,
  // so a second one means the grant is gone. Queueing it would retry a revoked
  // token on a timer forever.
  [401, "", "auth_failed"],
  [403, '{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}', "retryable"],
  [403, '{"error":{"errors":[{"reason":"insufficientPermissions"}]}}', "scope_required"],
  [400, "", "rejected"],
];

for (const [status, body, expected] of CLASSIFY) {
  const { session: s } = session([new Response(body, { status })]);
  const result = await writeReminderEvent("t1", "u1", null, INPUT, { openSession: async () => s });
  assert.equal(result.ok, false, `${status} must not report success`);
  assert.equal(
    !result.ok && result.reason,
    expected,
    `HTTP ${status} ${body ? "with " + body : ""} should classify as ${expected}`,
  );
}

assert.equal(isRetryableFailure("retryable"), true);
for (const blocked of ["not_connected", "scope_required", "auth_failed", "rejected"] as const) {
  assert.equal(
    isRetryableFailure(blocked),
    false,
    `${blocked} needs a person, so a timer must never retry it`,
  );
}

/* ------------------------------------------------------------- validation */

{
  // A malformed time must be refused BEFORE any network call: retrying the same
  // bad request on a timer would never once succeed.
  const { session: s, calls } = session([]);
  const result = await writeReminderEvent(
    "t1",
    "u1",
    null,
    { ...INPUT, startAt: "not-a-date" },
    { openSession: async () => s },
  );
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, "rejected");
  assert.equal(calls.length, 0, "an invalid reminder must never reach Google");
}

/* ----------------------------------------------------------------- remove */

{
  const { session: s, calls } = session([]);
  const result = await removeReminderEvent("t1", "u1", null, { openSession: async () => s });
  assert.equal(result.ok, true, "there is nothing to delete, which is the desired end state");
  assert.equal(calls.length, 0);
}

for (const status of [204, 404, 410]) {
  const { session: s } = session([new Response(null, { status })]);
  const result = await removeReminderEvent("t1", "u1", "evt_1", { openSession: async () => s });
  assert.equal(
    result.ok,
    true,
    `${status} means no reminder exists, which is what the caller asked for`,
  );
}

{
  const { session: s } = session([new Response("", { status: 503 })]);
  const result = await removeReminderEvent("t1", "u1", "evt_1", { openSession: async () => s });
  assert.equal(result.ok, false, "a real outage must not be reported as a successful delete");
  assert.equal(!result.ok && result.reason, "retryable");
}

console.log("calendar-reminder.test.ts passed");

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
