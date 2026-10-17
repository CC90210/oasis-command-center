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
};

export type StopReport = { sent: number; failed: number; segments: number };

export type MeetRecorder = {
  addTrack(input: { participantId: string; displayName: string; track: MediaStreamTrack }): void;
  removeTrack(participantId: string): void;
  stop(): Promise<StopReport>;
};

/** Preferred containers, best first. Safari supports only MP4/AAC. */
export const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"] as const;

export const DEFAULT_TIMESLICE_MS = 10_000;
const DEFAULT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const DEFAULT_MAX_ATTEMPTS = 8;

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

/** The default upload: one chunk to the room's recording route, as the host. */
export function uploadToRoom(code: string): UploadChunk {
  return async (chunk) => {
    const res = await fetch(`/api/meet/${encodeURIComponent(code)}/recording/chunk`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": chunk.mimeType || "application/octet-stream",
        "x-meet-participant": chunk.participantId,
        "x-meet-display-name": encodeURIComponent(chunk.displayName),
        "x-meet-segment": chunk.segmentId,
        "x-meet-seq": String(chunk.seq),
        "x-meet-segment-started-at": String(chunk.segmentStartedAt),
      },
      body: chunk.data,
    });
    // 409 duplicate: the chunk is already stored (a retry after a lost response). Done.
    if (res.ok || res.status === 409) return;
    throw new Error(`chunk_upload_${res.status}`);
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
  const mimeType = pickMimeType((t) => recorders.isTypeSupported(t));

  const running = new Map<string, Running>();
  const pending = new Set<Promise<void>>();
  let sent = 0;
  let failed = 0;
  let segments = 0;
  let closed = false;

  async function send(chunk: RecorderChunk): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await upload(chunk);
        sent += 1;
        return;
      } catch (err) {
        if (attempt >= maxAttempts) {
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

  function stopOne(participantId: string): Promise<void> {
    const run = running.get(participantId);
    if (!run) return Promise.resolve();
    running.delete(participantId);
    if (run.recorder.state !== "inactive") run.recorder.stop();
    return run.stopped;
  }

  return {
    addTrack({ participantId, displayName, track }) {
      if (closed) return;
      if (track.kind !== "audio") return;
      // A replaced track is a new segment: close the old one first.
      void stopOne(participantId);
      const recorder = recorders.create(streamOf(track), mimeType);
      let resolveStopped: () => void = () => undefined;
      const stopped = new Promise<void>((r) => {
        resolveStopped = r;
      });
      const run: Running = {
        participantId,
        displayName,
        segmentId: newId(),
        startedAt: now(),
        seq: 0,
        recorder,
        stopped,
      };
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
      recorder.onerror = (ev) => {
        console.error("[meet.recorder] recorder error", { participantId, error: String((ev as { error?: unknown })?.error ?? ev) });
        resolveStopped();
      };
      // A track that ends (the speaker left, a device was unplugged) ends its segment.
      track.addEventListener?.("ended", () => {
        if (running.get(participantId)?.segmentId === run.segmentId) void stopOne(participantId);
      });
      running.set(participantId, run);
      segments += 1;
      recorder.start(timeslice);
    },

    removeTrack(participantId) {
      void stopOne(participantId);
    },

    async stop() {
      closed = true;
      // Every recorder flushes its last chunk on stop; then wait for every upload.
      await Promise.all([...running.keys()].map((id) => stopOne(id)));
      while (pending.size) await Promise.all([...pending]);
      return { sent, failed, segments };
    },
  };
}
