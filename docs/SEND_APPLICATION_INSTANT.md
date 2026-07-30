# Send Application: instant email

**Context (2026-07-30):** Saving a lead at the Sent Application stage used to
write the lead and send nothing. The application email came from the drip
engine through four composing delays (the 15-minute enroll cron, up to 90
minutes of enroll jitter, the 08:00-20:00 ET email window, and the 5-minute
dispatch cron), so a midnight Save landed at 08:00. This document covers what
changed, what the operator sees, and the one thing this system genuinely
cannot tell you.

Code: `lib/drips/immediate.ts`, `lib/drips/immediate-core.ts`,
`lib/drips/executor.ts`, `components/manifest/QuickAddLeadModal.tsx`,
`app/api/leads/quick-add/route.ts`.

---

## 1. What Save does now

Saving a lead at Sent Application enrolls it into the stage's transactional
drip sequence and dispatches the first email inline, in the same request, so
it reaches the merchant in seconds at any hour instead of waiting on the enroll
cron, jitter, and send window described above. The Save response carries the
real outcome of that attempt, never an optimistic guess, because a failed send
must never be reported as a successful one.

---

## 2. Status table

One row per `InstantEmailStatus` value. The middle column is copied verbatim
from `EMAIL_STATUS_COPY` in `components/manifest/QuickAddLeadModal.tsx` so this
table and the UI cannot drift; if you change one, change the other.

| Status | What the rep sees | Meaning |
| --- | --- | --- |
| `sent` | "Application emailed." | A real, non-dry-run send happened. See the limitation below before reading this as "delivered." |
| `queued` | "Lead saved. The application email is queued." | The lead is enrolled; the email goes out on the normal dispatch cadence instead of inline. Most often this is the hourly-bypass ceiling (section 6). |
| `disabled` | "Lead saved. Instant send is off, so the drip will pick it up." | `SEND_APPLICATION_INSTANT=0`. The lead is still enrolled; only the inline dispatch was skipped. |
| `duplicate` | "Already queued or emailed. Not sending it again." | An active run for this lead and sequence already exists (double Save, retry, or a refresh), or the re-drip cooldown since the last run hasn't elapsed. `already_enrolled` covers BOTH a terminal (sent) run and an ACTIVE row that is merely scheduled/held (e.g. behind the volume gate) — the copy says "queued or emailed" rather than asserting a send that may not have happened yet. |
| `failed` | "Lead saved, but the application email failed to send." | The inline dispatch threw, or the sequence's first step is malformed. |
| `skipped_no_email` | "Lead saved. No email address on file, so nothing was sent." | The lead has no usable contact method for an email-first step. |
| `skipped_suppressed` | "Lead saved. That address is unsubscribed, so nothing was sent." | The recipient previously opted out or is on the suppression list. |
| `skipped_paused` | "Lead saved. Drips are paused for this lead, so nothing was sent." | The lead is paused, dead/declined, was shopped recently, or has an active accelerated-chase run. |
| `skipped_other` | "Lead saved. The application email was skipped. Check the lead's drip log." | Two distinct causes share this status: (1) no enabled transactional sequence is configured for this stage (or the lead itself couldn't be loaded), so **no `drip_runs` row was ever created** — nothing is queued and nothing will send until the sequence is configured; (2) an existing row's `last_error` carried a `skipped:` prefix that isn't one of the recognized causes above. Case (1) is a configuration problem, fixed at `/sequences`, not a transient failure to retry. Case (2) needs `drip_runs.last_error` read directly (section 5). |
| `held_circuit_open` | "Lead saved. Sending is halted right now, so nothing was sent." | `DRIPS_CIRCUIT_OPEN=1`. Checked before the lead is even enrolled; see section 3. |
| `held_no_app_link` | "Lead saved. No application link could be created, so nothing was sent." | The per-lead application link couldn't be minted. |
| `held_blocked_by_guard` | "Lead saved. The compliance guard blocked this email, so nothing was sent." | The blast-safety / positioning guard rejected the rendered content. |

---

## 3. Environment

**`SEND_APPLICATION_INSTANT`** — default on (any value other than the literal
`"0"` counts as enabled). Set to `0` to disable: Save still enrolls the lead,
it just doesn't dispatch inline, and the normal drip cadence picks it up. The
rep sees `disabled`, not a failure.

**Deliberately independent of `DRIPS_LIVE`.** `DRIPS_LIVE` is the kill switch
for *automated* drip output. The instant send is operator-initiated
transactional mail, semantically identical to a rep composing the email by
hand and hitting send themselves. Pausing the marketing engine must not
silently disable a button a rep just pressed. So `DRIPS_LIVE=0` (or unset)
does **not** block the instant send.

**`DRIPS_CIRCUIT_OPEN=1` and `BRAVO_FORCE_DRY_RUN=1` do still stop it.** These
are the two genuine safety switches, and they win over an operator action. The
real precedence, from `dripSendEnabled(immediate)` in `lib/drips/executor.ts`:

```
function dripSendEnabled(immediate = false): boolean {
  if (BRAVO_FORCE_DRY_RUN === "1") return false;   // 1. wins over everything
  if (circuitOpen())              return false;   // 2. DRIPS_CIRCUIT_OPEN=1
  if (immediate)                  return true;    // 3. bypasses DRIPS_LIVE
  return DRIPS_LIVE === "1";                       // 4. scheduled drips only
}
```

For an instant send specifically, the circuit breaker is checked a second,
earlier time that matters more in practice: `sendApplicationNow()` in
`lib/drips/immediate.ts` calls `circuitOpen()` before the lead is even
enrolled ("emergency stop wins over everything, including an operator
action"), and returns `held_circuit_open` with no `drip_runs` row created at
all. `BRAVO_FORCE_DRY_RUN` has no equivalent upfront check on the instant
path; it only takes effect once dispatch is attempted, inside
`dripSendEnabled`, where it forces a dry run and the reported outcome clamps
to `queued`.

---

## 4. The limitation, stated plainly

**Gmail returns `250 OK` for a message it accepts and then files as spam.**
That acceptance is indistinguishable, over SMTP, from a message that reaches
the inbox. Spam placement is **not observable from this system**, at any
point in this pipeline.

There is no `filtered` status in the table above, and there will not be one,
because nothing in this stack can produce that signal.

`sent` means: `dispatchRuns` recorded a real, non-dry-run send and SMTP
accepted it (`tallies.sent > 0` in `sendApplicationNow`). It does **not** mean
the email reached the merchant's inbox. Do not read `sent` as `inboxed` or
`delivered`.

Open and click tracking (the pixel and the wrapped links) are a weak proxy at
best. Many mail clients block remote images by default whether the message
sits in the inbox or in spam, so a merchant who never opens an email produces
identical "no signal" in both cases. Absence of an open is not evidence of
spam placement. Presence of an open is not proof of inbox placement either,
only evidence that some client rendered the message somewhere.

Treat `sent` as "handed to SMTP and accepted." Nothing more.

---

## 5. Tracing one send

Given a `lead_id`:

**1. `drip_runs` — did a run exist, and what state is it in.**

```sql
select status, last_error, sequence_name, created_at
from drip_runs
where lead_id = '<lead-id>'
order by created_at desc;
```

`status` and `last_error` are what `statusFromRow` (`lib/drips/immediate-core.ts`)
reads to build the operator-facing status in section 2. `last_error` is never
cleared once written, so on an older or already-terminal row it can be stale
residue from an earlier hold rather than the current reason. See that
function's header comment before trusting it at face value.

**2. `lead_interactions` — did a message actually go out, and which path sent it.**

```sql
select agent_source, channel, created_at,
       metadata->>'sent_via' as sent_via,
       metadata->>'dry_run'  as dry_run
from lead_interactions
where lead_id = '<lead-id>'
order by created_at desc;
```

Rows written by the drip engine carry `agent_source = 'sequence:<name>'`.
`metadata.sent_via` is `"instant"` for a Save-triggered send and `"drip"` for
one the dispatch cron picked up on its normal cadence, stamped in
`lib/drips/executor.ts` at send time. That marker is the only way to tell the
two paths apart after the fact, since both write the same row shape.

---

## 6. Why an instant send can come back "queued"

`SEND_APPLICATION_INSTANT_HOURLY_BYPASS` caps how many instant sends per
tenant, per rolling hour, may bypass the volume pacing. Default 15
(`instantBypassCap()` in `lib/drips/immediate.ts`), comfortably above a human
working at typing speed and well under the governor's 25/hour hourly cap.

Past that ceiling, the lead is still enrolled (the `drip_runs` row exists) and
the email still goes out, just on the normal dispatch cadence rather than
inline. Only the *bypass* stops; nothing is lost. The rep is told `queued`,
which is true, rather than `sent`, which would not be.

This exists because the sending domain is mid-warmup: without a ceiling, a rep
working through a large batch of Saves could burn through the reputation-safe
hourly pacing in minutes.
