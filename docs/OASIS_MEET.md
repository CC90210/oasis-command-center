# Oasis Meet

Our own video meetings (CC, 2026-10-17). A host starts a meeting from the **Schedule** page (the Meet button), sends
the link, and people join in the browser with no account: `oasisai.work/meet/abc-defg-hjk`. The room creator's
browser records each speaker's audio; OASIS's PC transcribes it on the CPU and keeps the audio; the Command Center
keeps the transcript. No meeting vendor bill: media runs on Cloudflare Realtime inside its free tier.

## How it works

| Piece | Where | What it does |
|---|---|---|
| Rooms and people | `lib/meet/rooms.ts`, `lib/meet/participants.ts`, migration `bravo__230` | `meet_rooms` (the link code, title, host, scheduled/live/ended, record on/off, Schedule event, lead) and `meet_participants` (one row per person per join: role, name, consent, SFU session, published tracks, left/removed). Every query names the room's tenant; the code lookup is the one read not by workspace, because the code is what a guest holds. |
| Who may do what | `lib/meet/access.ts` | Host: the room's creator, or an owner/admin of its workspace by base role. Guest: anyone with the link. A guest's join sets an HMAC participant token (`MEET_TOKEN_SECRET`) in an HttpOnly, Secure, SameSite=Lax cookie scoped to `/api/meet/<code>`; every call re-reads the participant row, so leaving, removal and an ended room apply at once. In a recorded room everyone but its creator, a second host too, ticks the recording notice. A member's meeting list shows the meetings they made; an owner/admin's shows all of the workspace's. |
| The room API | `lib/meet/handlers.ts`, `app/api/meet/[code]/*` | `join`, `state` (polled every 2 s), `sfu` (session, publish, pull, renegotiate, close), `leave`, `host` (remove, end, delete). Public at the middleware; each route checks same origin, the code, a rate limit, then the token or the host's session. |
| Host management | `app/api/calendar/meet` | List and make rooms (signed in). A meeting with a time also goes on the host's Schedule through the Schedule's own write path (`lib/meet/schedule.ts`, Shabbat lock included). The list says `recordingAvailable`; where it is false a room never records, so no guest is asked to agree to a recording nobody makes. |
| Deleting a meeting | `host` action `delete` | A host only. In this order: a meeting still going is ended and its media cut; the recording is deleted (`deleteMeetRecording`: the transcript, the relay, the PC's copy); the creator's Schedule entry is removed (never another person's calendar); then the room's rows. If the recording cannot be deleted, the meeting is kept, so nothing is orphaned. |
| Media | `lib/meet/sfu.ts`, `lib/meet/ice.ts` | Cloudflare Realtime SFU through our API (the app secret never reaches a browser). A pull names a participant and a track; the server allows only what someone else in the same room publishes now. TURN credentials are minted per join (STUN only when unset). Remove and end close every track on the affected sessions at the SFU, sent and received. |
| The browser | `lib/meet/room-client.ts`, `components/meet/*`, `app/meet/[code]` | One RTCPeerConnection per person; each SDP exchange finishes before the next change. The page asks for the recording tick before the camera (Quebec Law 25: notice before collection). `next.config.js` lets `/meet/*` use the camera and microphone; every other page keeps them off. |
| Recording and transcripts | `lib/meet/recorder.ts`, `lib/meet/recording*.ts`, BEA `scripts/meet/` | Each speaker's audio, recorded separately in the creator's browser, uploaded in 10 s chunks to a private R2 relay, transcribed on OASIS's PC by a separate runner (faster-whisper on CPU), saved there with the audio; the relay copy is deleted once the PC has it. Only OASIS workspaces record. |

## Switching it on (one time)

1. Cloudflare API token: **Realtime > Realtime Admin** on the OASIS account (the API reference calls it `Calls Write`;
   it is the only permission that creates an SFU app or a TURN key). Then BEA `scripts/integrations/cf_realtime_tool.py
   create` makes both and stores their secrets without showing them.
2. Worker secrets (names in BEA `config/cloudflare/manifests/oasis-command-center.json`; push with
   `wrangler_tool.py secrets-push --app oasis-command-center --only <KEY>`): `MEET_TOKEN_SECRET` (done 2026-10-17),
   `CF_REALTIME_APP_ID`, `CF_REALTIME_APP_SECRET`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`. Without the SFU app every
   media call answers 503 `meet_not_configured`.
3. Recording: migration `bravo__231`, an R2 lifecycle rule on `meet-relay/`, the Meet runner as its own Windows task
   on OASIS's PC, and the `oasis-cc-cron` Worker deployed so `/api/cron/meet-relay` runs.

## Limits, on purpose

- Eight people per room at most (one statement with the join, so it cannot be overshot). Guests hold seven places at most, so a leaked link filled with guests never locks the host out of the room they need to be in to remove them. A place stays held until its person has been silent for 5 minutes, because until then they can come back to it: a newcomer never takes the place of someone whose laptop slept.
- A live room ends itself when no host has been seen for 10 minutes, but only after a call happened in it: two different people in the room at once, one of them a host (CC and Adon, both owners, are both hosts; one person in two tabs is not a call). A host who opens a meeting alone, to test or early, leaves it waiting for its guests. A call nobody polls any more (every tab closed) ends when a host opens the Meet panel, and in the recording relay's sweep, so its recording is handed over. Backstop: a room nobody has been in for 12 hours, whose start (if it has one) is 12 hours past, ends as `expired`.
- Someone not heard from for 5 minutes has left (their session is cut; coming back is a new join, through the cap), so a browser that stops polling but keeps its connection is never left listening unseen. Their page says "You were disconnected from the meeting." with Rejoin; nothing rejoins them by itself, because a new join in a recorded room needs the notice ticked again. Less than that (a laptop that slept a moment, a locked phone, a short outage) is only a gap in the People list. A poll that hangs is given up after 10 seconds, so it never stops the polls after it; every other call to the room (the join, each SFU step, a host action) after 20, so no screen waits on one for good. Safari before 16, which lacks `AbortSignal.timeout`, gets the same deadline from a timer. Leave ends the call at once, camera and all, and tells the room after.
- A meeting made for a time counts a call only if it reaches that time (less 10 minutes): hosts trying the room out early never end the link its guests were sent.
- A reconnect replaces the SFU session only once the old one is cut, so the browser tries six times when the video service refuses it (three for anything else) before it gives up. The others see each person's session as a tag that changes on a reconnect, and pull their tracks anew; a screen being shared goes out again on the new session, and one stopped during the reconnect (the browser's own "Stop sharing" works in every phase) does not.
- A camera, microphone or screen asked for and answered after it stopped being wanted (asked again, turned off, the call left or failed, even with the join then tried again) is stopped, never held: no light left on.
- A browser prompt nobody answers never locks the pre-join screen: "Join without your camera" (or microphone, or both) stops waiting and joins with what is already on; "Join now" stays off while the browser is still answering, so nobody joins without the camera they just allowed.
- "Recorded" is shown in the call only while the room's creator, whose browser records, is in it.
- End asks the room to end before the recorder stops: an End that fails keeps the meeting going and recorded.
- Media is cut at the SFU on leave, remove, end and delete. A row keeps its session id until the cut goes through; a failed one is retried from the room's polls (after the answer, at most every 30 seconds per room) for an hour, and by Delete. Delete never waits on an SFU that does not answer.
- Only the room creator's browser records; if the creator is not in the call, nothing records.
- Remove is not a ban: the person can come back with the link from a new browser window (there is no account to ban).
- Rate limits are per Worker isolate (a slowdown for guessing links); the participant cap is the hard ceiling. Up to eight people behind one office address fit the poll limit.

## Tests

`tests/meet-foundation`, `meet-room` (every route on a real libSQL file with a stand-in SFU), `meet-sfu` (the real
Cloudflare request shapes), `meet-room-client` (the browser engine against a stand-in peer), `meet-schedule` and
`meet-schedule-store` (the Schedule hookup, the second on the real calendar store), `meet-ui`, `meet-delete` (Delete
meeting and recording availability on the real recording code and tables), and `meet-recorder` / `meet-recording` for
recording. All in `npm run test:calendar`.
