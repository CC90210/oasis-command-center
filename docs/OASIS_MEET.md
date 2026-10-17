# Oasis Meet

Our own video meetings (CC, 2026-10-17). A host starts a meeting from the **Schedule** page (the Meet button), sends
the link, and people join in the browser with no account: `oasisai.work/meet/abc-defg-hjk`. The room creator's
browser records each speaker's audio; OASIS's PC transcribes it on the CPU and keeps the audio; the Command Center
keeps the transcript. No meeting vendor bill: media runs on Cloudflare Realtime inside its free tier.

## How it works

| Piece | Where | What it does |
|---|---|---|
| Rooms and people | `lib/meet/rooms.ts`, `lib/meet/participants.ts`, migration `bravo__230` | `meet_rooms` (the link code, title, host, scheduled/live/ended, record on/off, Schedule event, lead) and `meet_participants` (one row per person per join: role, name, consent, SFU session, published tracks, left/removed). Every query names the room's tenant; the code lookup is the one read not by workspace, because the code is what a guest holds. |
| Who may do what | `lib/meet/access.ts` | Host: the room's creator, or an owner/admin of its workspace by base role. Guest: anyone with the link. A guest's join sets an HMAC participant token (`MEET_TOKEN_SECRET`) in an HttpOnly, Secure, SameSite=Lax cookie scoped to `/api/meet/<code>`; every call re-reads the participant row, so leaving, removal and an ended room apply at once. |
| The room API | `lib/meet/handlers.ts`, `app/api/meet/[code]/*` | `join`, `state` (polled every 2 s), `sfu` (session, publish, pull, renegotiate, close), `leave`, `host` (remove, end). Public at the middleware; each route checks same origin, the code, a rate limit, then the token or the host's session. |
| Host management | `app/api/calendar/meet` | List and make rooms (signed in). A meeting with a time also goes on the host's Schedule through the Schedule's own write path (`lib/meet/schedule.ts`, Shabbat lock included). |
| Media | `lib/meet/sfu.ts`, `lib/meet/ice.ts` | Cloudflare Realtime SFU through our API (the app secret never reaches a browser). A pull names a participant and a track; the server allows only what someone else in the same room publishes now. TURN credentials are minted per join (STUN only when unset). Remove and end close every track on the affected sessions at the SFU, sent and received. |
| The browser | `lib/meet/room-client.ts`, `components/meet/*`, `app/meet/[code]` | One RTCPeerConnection per person; each SDP exchange finishes before the next change. The page asks for the recording tick before the camera (Quebec Law 25: notice before collection). `next.config.js` lets `/meet/*` use the camera and microphone; every other page keeps them off. |
| Recording and transcripts | `lib/meet/recorder.ts`, `lib/meet/recording*.ts`, BEA `scripts/meet/` | Each speaker's audio, recorded separately in the creator's browser, uploaded in 10 s chunks to a private R2 relay, transcribed on OASIS's PC by a separate runner (faster-whisper on CPU), saved there with the audio; the relay copy is deleted once the PC has it. Only OASIS workspaces record. |

## Switching it on (one time)

1. Cloudflare API token: **Calls / Realtime: Edit** on the OASIS account; then create the SFU app and a TURN key.
2. Worker secrets (names in BEA `config/cloudflare/manifests/oasis-command-center.json`; push with
   `wrangler_tool.py secrets-push --app oasis-command-center --only <KEY>`): `MEET_TOKEN_SECRET` (done 2026-10-17),
   `CF_REALTIME_APP_ID`, `CF_REALTIME_APP_SECRET`, `CF_TURN_KEY_ID`, `CF_TURN_KEY_API_TOKEN`. Without the SFU app every
   media call answers 503 `meet_not_configured`.
3. Recording: migration `bravo__231`, an R2 lifecycle rule on `meet-relay/`, the Meet runner as its own Windows task
   on OASIS's PC, and the `oasis-cc-cron` Worker deployed so `/api/cron/meet-relay` runs.

## Limits, on purpose

- Eight people per room at most (one statement with the join, so it cannot be overshot).
- A live room ends itself when no host has been seen for 10 minutes.
- Only the room creator's browser records; if the creator is not in the call, nothing records.
- Rate limits are per Worker isolate (a slowdown for guessing links); the participant cap is the hard ceiling.

## Tests

`tests/meet-foundation`, `meet-room` (every route on a real libSQL file with a stand-in SFU), `meet-sfu` (the real
Cloudflare request shapes), `meet-room-client` (the browser engine against a stand-in peer), `meet-schedule` and
`meet-schedule-store` (the Schedule hookup, the second on the real calendar store), `meet-ui`, and `meet-recorder` /
`meet-recording` for recording. All in `npm run test:calendar`.
