/**
 * lib/meet/recorder.ts - Oasis Meet's recording, in the HOST's browser.
 *
 * CC, 2026-10-17: no vendor bill to record audio, and the recording lives on our
 * own computer. So the host's browser records every speaker's audio SEPARATELY
 * (the host's microphone plus each remote audio track as it arrives) and uploads
 * it in ~10 s chunks. This computer (Business-Empire-Agent scripts/meet/) joins
 * them, transcribes them on its CPU, and keeps the audio; the Command Center's
 * copy is only a relay. Separate tracks give speaker labels without guessing
 * voices.
 *
 * SEGMENTS. MediaRecorder writes the container header only into the first chunk
 * of a run, so a chunk is not playable on its own: every recorder run is a
 * segment with its own id, its chunks numbered from 0, and the wall-clock time it
 * started, which puts every speaker on one timeline. A speaker who drops and
 * rejoins (or whose track is replaced) gets a new segment.
 *
 * NOTHING IS LOST QUIETLY. A chunk upload is retried with backoff; a tab that
 * crashes loses at most one timeslice. `stop()` flushes every recorder and waits
 * for the queue to drain, then reports what could not be sent.
 *
 * The container is whatever the browser records: Opus in WebM on Chrome, Edge
 * and Firefox, AAC in MP4 on Safari. The computer transcodes either.
 *
 * ASCII only (tests/worker-source-one-byte.test.ts).
 */

export type RecorderChunk = {
  participantId: string;
  displayName: string;
  segmentId: string;
  seq: number;
  /** Epoch ms when this segment's recorder started. */
  segmentStartedAt: number;
  mimeType: string;
  data: Blob;
};

export type UploadChunk = (chunk: RecorderChunk) => Promise<void>;

/** The parts of MediaRecorder this module uses, so tests can stand one in. */
export type RecorderLike = {
  readonly mimeType: string;
  state: "inactive" | "recording" | "paused";
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((ev: unknown) => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
};

export type RecorderFactory = {
  create(stream: MediaStream, mimeType: string | undefined): RecorderLike;
  isTypeSupported(type: string): boolean;
};

export type MeetRecorderOptions = {
  code: string;
  timesliceMs?: number;
  upload?: UploadChunk;
  recorders?: RecorderFactory;
  now?: () => number;
  newId?: () => string;
  /** Waits between retries of one chunk; the last value repeats. */
  retryDelaysMs?: number[];
  /** Tries per chunk before it is reported as lost. */
  maxAttempts?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Wraps a single track as a stream (tests have no MediaStream). */
  streamOf?: (track: MediaStreamTrack) => MediaStream;
  /** How long stop() waits for a recorder that is already stopping. */
  flushTimeoutMs?: number;
};

/**
 * sent: chunks stored. failed: chunks that never were (logged each). segments:
 * recorder runs started. errored: recorder runs that died mid-call; the speaker
 * was restarted on a new segment when their track was still live, but some of
 * their audio may be missing, which the host should be told.
 */
export type StopReport = { sent: number; failed: number; segments: number; errored: number };

/**
 * An upload the server answered. Only answers that can change on a retry are
 * retried (a timeout, too many requests, a server error); a refusal (signed out,
 * room ended, too large) fails the chunk at once instead of holding stop() for a
 * minute of backoff. A thrown network error is always retried.
 */
export class ChunkUploadError extends Error {
  constructor(readonly status: number) {
    super(`chunk_upload_${status}`);
  }
  get retryable(): boolean {
    return this.status === 408 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}

export type MeetRecorder = {
  addTrack(input: { participantId: string; displayName: string; track: MediaStreamTrack }): void;
  /** Stop a speaker's recording. With `track`, only if that track is still the one recorded (a stale remove after a replace does nothing). */
  removeTrack(participantId: string, track?: MediaStreamTrack): void;
  stop(): Promise<StopReport>;
};

/** Preferred containers, best first. Safari supports only MP4/AAC. */
export const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"] as const;

export const DEFAULT_TIMESLICE_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const DEFAULT_MAX_ATTEMPTS = 8;
/** A recorder told to stop hands over its last chunk and fires stop; past this, stop() stops waiting for it. */
const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;
/** A speaker whose recorder keeps failing is restarted this many times, then reported. */
const MAX_RESTARTS = 3;

/** The first container this browser can record, or undefined to let it choose. */
export function pickMimeType(isTypeSupported: (type: string) => boolean): string | undefined {
  return RECORDING_TYPES.find((t) => {
    try {
      return isTypeSupported(t);
    } catch {
      return false;
    }
  });
}

/** How long one chunk upload may take before it is abandoned and retried. */
export const UPLOAD_TIMEOUT_MS = 30_000;

/**
 * The text with any lone UTF-16 surrogate replaced by U+FFFD. A name cut mid-emoji
 * (a 60-character cap counts UTF-16 units) would otherwise make encodeURIComponent
 * throw on every chunk. A loop, not a lookbehind regex, which older Safari cannot parse.
 */
export function wellFormed(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i += 1;
      } else {
        out += "\ufffd";
      }
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      out += "\ufffd";
    } else {
      out += text[i];
    }
  }
  return out;
}

/** The default upload: one chunk to the room's recording route, as the host, abandoned after timeoutMs. */
export function uploadToRoom(code: string, { timeoutMs = UPLOAD_TIMEOUT_MS }: { timeoutMs?: number } = {}): UploadChunk {
  return async (chunk) => {
    // A request that never answers would otherwise hold stop() (and the End button) forever.
    // An abort throws, and a throw is retried like any network error.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`/api/meet/${encodeURIComponent(code)}/recording/chunk`, {
        method: "POST",
        credentials: "same-origin",
        signal: controller.signal,
        headers: {
          "content-type": chunk.mimeType || "application/octet-stream",
          "x-meet-participant": chunk.participantId,
          "x-meet-display-name": encodeURIComponent(wellFormed(chunk.displayName)),
          "x-meet-segment": chunk.segmentId,
          "x-meet-seq": String(chunk.seq),
          "x-meet-segment-started-at": String(chunk.segmentStartedAt),
        },
        body: chunk.data,
      });
    } finally {
      clearTimeout(timer);
    }
    // 409 duplicate: the chunk is already stored (a retry after a lost response). Done.
    if (res.ok || res.status === 409) return;
    throw new ChunkUploadError(res.status);
  };
}

function browserRecorders(): RecorderFactory {
  return {
    create: (stream, mimeType) =>
      new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 }) as unknown as RecorderLike,
    isTypeSupported: (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
  };
}

type Running = {
  participantId: string;
  displayName: string;
  track: MediaStreamTrack;
  segmentId: string;
  startedAt: number;
  seq: number;
  recorder: RecorderLike;
  stopped: Promise<void>;
};

export function createMeetRecorder(options: MeetRecorderOptions): MeetRecorder {
  const timeslice = options.timesliceMs ?? DEFAULT_TIMESLICE_MS;
  const upload = options.upload ?? uploadToRoom(options.code);
  const recorders = options.recorders ?? browserRecorders();
  const now = options.now ?? (() => Date.now());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const delays = options.retryDelaysMs?.length ? options.retryDelaysMs : DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const streamOf = options.streamOf ?? ((track: MediaStreamTrack) => new MediaStream([track]));
  const flushTimeoutMs = options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS;
  const mimeType = pickMimeType((t) => recorders.isTypeSupported(t));

  const running = new Map<string, Running>();
  /** Recorders told to stop whose last chunk and stop event have not arrived yet. */
  const stopping = new Set<Promise<void>>();
  const pending = new Set<Promise<void>>();
  const restarts = new Map<string, number>();
  let sent = 0;
  let failed = 0;
  let segments = 0;
  let errored = 0;
  let closed = false;

  async function send(chunk: RecorderChunk): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await upload(chunk);
        sent += 1;
        return;
      } catch (err) {
        const final = attempt >= maxAttempts || (err instanceof ChunkUploadError && !err.retryable);
        if (final) {
          failed += 1;
          console.error("[meet.recorder] chunk not uploaded", {
            participantId: chunk.participantId,
            segmentId: chunk.segmentId,
            seq: chunk.seq,
            error: err instanceof Error ? err.message : String(err),
          });
          return;
        }
        await sleep(delays[Math.min(attempt - 1, delays.length - 1)]);
      }
    }
  }

  function enqueue(chunk: RecorderChunk) {
    const p = send(chunk).finally(() => pending.delete(p));
    pending.add(p);
  }

  /** Stop one speaker's recorder; stop() keeps waiting for it until its last chunk is handed over. */
  function stopOne(participantId: string): Promise<void> {
    const run = running.get(participantId);
    if (!run) return Promise.resolve();
    running.delete(participantId);
    stopping.add(run.stopped);
    void run.stopped.then(() => stopping.delete(run.stopped));
    if (run.recorder.state !== "inactive") run.recorder.stop();
    return run.stopped;
  }

  /** A recorder that could not be made or started: counted and logged, never half-registered. */
  function couldNotRecord(participantId: string, err: unknown) {
    errored += 1;
    console.error("[meet.recorder] could not start recording", { participantId, error: err instanceof Error ? err.message : String(err) });
  }

  function startSegment(participantId: string, displayName: string, track: MediaStreamTrack) {
    let recorder: RecorderLike;
    try {
      recorder = recorders.create(streamOf(track), mimeType);
    } catch (err) {
      couldNotRecord(participantId, err);
      return;
    }
    let resolveStopped: () => void = () => undefined;
    const stopped = new Promise<void>((r) => {
      resolveStopped = r;
    });
    const run: Running = { participantId, displayName, track, segmentId: newId(), startedAt: now(), seq: 0, recorder, stopped };
    const type = recorder.mimeType || mimeType || "audio/webm";
    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      enqueue({
        participantId: run.participantId,
        displayName: run.displayName,
        segmentId: run.segmentId,
        seq: run.seq++,
        segmentStartedAt: run.startedAt,
        mimeType: type,
        data: ev.data,
      });
    };
    recorder.onstop = () => resolveStopped();
    let failedOnce = false;
    recorder.onerror = (ev) => {
      if (failedOnce) return; // one dead recorder is one gap, however many errors it reports
      failedOnce = true;
      errored += 1;
      console.error("[meet.recorder] recorder error", { participantId, error: String((ev as { error?: unknown })?.error ?? ev) });
      resolveStopped();
      // The rest of this speaker's audio is not lost quietly: a track still live gets a new segment.
      if (running.get(participantId)?.segmentId !== run.segmentId) return;
      running.delete(participantId);
      const tries = restarts.get(participantId) ?? 0;
      if (!closed && track.readyState !== "ended" && tries < MAX_RESTARTS) {
        restarts.set(participantId, tries + 1);
        startSegment(participantId, displayName, track);
      }
    };
    try {
      recorder.start(timeslice);
    } catch (err) {
      couldNotRecord(participantId, err);
      return;
    }
    running.set(participantId, run);
    segments += 1;
  }

  return {
    addTrack({ participantId, displayName, track }) {
      if (closed) return;
      if (track.kind !== "audio" || track.readyState === "ended") return;
      // A replaced track is a new segment: close the old one first.
      void stopOne(participantId);
      restarts.delete(participantId);
      startSegment(participantId, displayName, track);
      // A track that ends (the speaker left, a device was unplugged) ends whichever segment records it.
      track.addEventListener?.("ended", () => {
        if (running.get(participantId)?.track === track) void stopOne(participantId);
      });
    },

    removeTrack(participantId, track) {
      // A stale remove (the old track, after a replace) must not stop the new segment.
      if (track && running.get(participantId)?.track !== track) return;
      void stopOne(participantId);
    },

    async stop() {
      closed = true;
      // Stop what is still recording, then wait for every recorder already stopping (a speaker who left
      // just before End) to hand over its last chunk - bounded, so a recorder that never fires stop
      // cannot hold the End button - and then for every upload.
      for (const id of [...running.keys()]) void stopOne(id);
      if (stopping.size) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<void>((r) => {
          timer = setTimeout(r, flushTimeoutMs);
        });
        await Promise.race([Promise.all([...stopping]), timeout]);
        if (timer) clearTimeout(timer);
      }
      while (pending.size) await Promise.all([...pending]);
      return { sent, failed, segments, errored };
    },
  };
}
