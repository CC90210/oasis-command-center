/**
 * lib/tools/limits.ts - the Toolkit's numbers. The Command Center is their
 * source: a runner reads the job ones from the claim's `limits`, never from its
 * own copy.
 *
 * PURE: no imports.
 */

/** 95 MiB: the approved cap on one downloaded video. */
export const MAX_VIDEO_BYTES = 99_614_720;
/** How long a claim (or a heartbeat) keeps a job this runner's. */
export const LEASE_SECONDS = 900;
/** How often a runner reports that it is still on a job. */
export const HEARTBEAT_SECONDS = 60;
/** How long a runner lets the downloader run before it stops it. */
export const RUN_TIMEOUT_SECONDS = 1200;
/** A runner job is tried at most this many times (a lease that expires counts as a try). */
export const MAX_ATTEMPTS = 3;
/** A runner seen within this many minutes is live: its tools are shown. */
export const RUNNER_LIVE_MINUTES = 10;
/** A queued runner job with no live runner for its workspace fails after this long. */
export const QUEUED_OFFLINE_MINUTES = 30;
/** A run inside a request that has not finished after this long was cut off. */
export const WORKER_INTERRUPTED_MINUTES = 5;
/** A signed runner request is accepted only this close to the server's clock. */
export const SIGNATURE_WINDOW_SECONDS = 300;
/** The largest signed runner request body. */
export const RUNNER_BODY_MAX_BYTES = 64 * 1024;
/**
 * The largest signed body POST /api/internal/tools/complete takes: a meeting's
 * transcript comes back in it, and an hour of talk is well past 64 KiB.
 */
export const COMPLETE_BODY_MAX_BYTES = 2 * 1024 * 1024;
/** How long a presigned upload URL stays valid (lib/r2-storage.ts signs PUTs for this long). */
export const UPLOAD_URL_TTL_SECONDS = 900;
/**
 * The longest one claim may keep a job by heartbeats, counted from the claim:
 * the run timeout, one upload URL's whole life, and 10 minutes of slack (45
 * minutes). A heartbeat after it is answered lease_lost.
 */
export const MAX_LEASE_HOLD_SECONDS = RUN_TIMEOUT_SECONDS + UPLOAD_URL_TTL_SECONDS + 600;
/**
 * The same limit for a meeting transcription: 24 hours. It runs on a CPU, about
 * 0.7 x real time PER SPEAKER TRACK with the small model (measured on OASIS's
 * PC), and a room may hold eight tracks of four hours each, so four hours was
 * shorter than recordings the relay accepts (Codex on #685, P2). The PC also
 * drops to the faster model for a long recording (BEA scripts/meet/runner.py).
 * The limit still ends a run that is stuck while its heartbeat beats.
 */
export const MEET_TRANSCRIBE_MAX_HOLD_SECONDS = 24 * 60 * 60;
/** How long a runner waits between claims when there is nothing to do. */
export const POLL_AFTER_SECONDS = 30;
/** At most this many runner jobs queued or running per workspace. */
export const MAX_RUNNER_JOBS_IN_FLIGHT = 5;
/** The bucket every Library video lives in (private; signed URLs only). */
export const MARKETING_MEDIA_BUCKET = "marketing-media";
