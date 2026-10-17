/**
 * tests/meet-recorder.test.ts - Oasis Meet's host-browser recorder
 * (lib/meet/recorder.ts): every speaker on their own segment, chunks numbered
 * per segment with the segment's start time, uploads retried and never lost
 * quietly, and stop() flushing everything. A stand-in MediaRecorder; no browser.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-recorder.test.ts
 */
import assert from "node:assert/strict";
import {
  ChunkUploadError,
  createMeetRecorder,
  pickMimeType,
  uploadToRoom,
  type RecorderChunk,
  type RecorderFactory,
  type RecorderLike,
} from "../lib/meet/recorder";

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${String((error as Error).message).split("\n").slice(0, 5).join("\n        ")}`);
  }
}

class FakeRecorder implements RecorderLike {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  started?: number;
  /** When set, stop() returns at once and the last chunk and stop event come later (finishStop). */
  deferStop = false;
  constructor(readonly mimeType: string, readonly stream: unknown) {}
  start(timesliceMs?: number) {
    this.state = "recording";
    this.started = timesliceMs;
  }
  emit(text: string) {
    this.ondataavailable?.({ data: new Blob([text]) });
  }
  stop() {
    this.state = "inactive";
    if (!this.deferStop) this.finishStop();
  }
  finishStop() {
    // A real MediaRecorder hands over its last data, then fires stop.
    this.ondataavailable?.({ data: new Blob(["final"]) });
    this.onstop?.();
  }
  fail() {
    this.state = "inactive";
    this.onerror?.({ error: "NotSupportedError" });
  }
}

function factory(supported: string[]) {
  const made: FakeRecorder[] = [];
  const f: RecorderFactory = {
    create: (stream, mimeType) => {
      const r = new FakeRecorder(mimeType ?? "", stream);
      made.push(r);
      return r;
    },
    isTypeSupported: (t) => supported.includes(t),
  };
  return { f, made };
}

function track(kind = "audio", readyState = "live") {
  const listeners: Record<string, Array<() => void>> = {};
  return {
    kind,
    readyState,
    addEventListener: (ev: string, fn: () => void) => {
      (listeners[ev] ??= []).push(fn);
    },
    fire: (ev: string) => listeners[ev]?.forEach((fn) => fn()),
  } as unknown as MediaStreamTrack & { fire: (ev: string) => void };
}

function harness(opts: { supported?: string[]; upload?: (c: RecorderChunk) => Promise<void> } = {}) {
  const { f, made } = factory(opts.supported ?? ["audio/webm;codecs=opus"]);
  const uploaded: RecorderChunk[] = [];
  const slept: number[] = [];
  let clock = 1_000;
  let ids = 0;
  const rec = createMeetRecorder({
    code: "abcdefghij",
    recorders: f,
    upload: opts.upload ?? (async (c) => void uploaded.push(c)),
    now: () => clock,
    newId: () => `seg-${++ids}`,
    sleep: async (ms) => void slept.push(ms),
    retryDelaysMs: [10, 20],
    maxAttempts: 4,
    streamOf: (t) => t as unknown as MediaStream,
  });
  return { rec, made, uploaded, slept, tick: (ms: number) => (clock += ms) };
}

async function main() {
  console.log("meet-recorder");

  await check("each speaker records on their own segment, chunks numbered per segment", async () => {
    const h = harness();
    h.rec.addTrack({ participantId: "host", displayName: "CC", track: track() });
    h.tick(4_000);
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    assert.equal(h.made.length, 2);
    assert.equal(h.made[0].started, 10_000, "not the 10 s timeslice");
    h.made[0].emit("a0");
    h.made[1].emit("b0");
    h.made[0].emit("a1");
    const report = await h.rec.stop();
    const host = h.uploaded.filter((c) => c.participantId === "host");
    const ada = h.uploaded.filter((c) => c.participantId === "g1");
    assert.deepEqual(host.map((c) => c.seq), [0, 1, 2], "host's chunks misnumbered (the final flush is the last)");
    assert.deepEqual(ada.map((c) => c.seq), [0, 1]);
    assert.ok(host.every((c) => c.segmentId === "seg-1" && c.segmentStartedAt === 1_000));
    assert.ok(ada.every((c) => c.segmentId === "seg-2" && c.segmentStartedAt === 5_000), "Ada's start time is not her own");
    assert.ok(h.uploaded.every((c) => c.mimeType === "audio/webm;codecs=opus"));
    assert.deepEqual(report, { sent: 5, failed: 0, segments: 2, errored: 0 });
  });

  await check("Safari records MP4/AAC; the container is whatever the browser supports", () => {
    assert.equal(pickMimeType((t) => t.startsWith("audio/mp4")), "audio/mp4;codecs=mp4a.40.2");
    assert.equal(pickMimeType(() => false), undefined, "an unsupported browser must let MediaRecorder choose");
    assert.equal(pickMimeType(() => {
      throw new Error("no MediaRecorder");
    }), undefined);
  });

  await check("a rejoined or replaced track starts a new segment from seq 0", async () => {
    const h = harness();
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    h.made[0].emit("x");
    h.tick(60_000);
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    assert.equal(h.made[0].state, "inactive", "the old segment kept recording");
    h.made[1].emit("y");
    await h.rec.stop();
    const segs = [...new Set(h.uploaded.map((c) => `${c.segmentId}@${c.segmentStartedAt}`))];
    assert.deepEqual(segs, ["seg-1@1000", "seg-2@61000"]);
    assert.deepEqual(h.uploaded.filter((c) => c.segmentId === "seg-2").map((c) => c.seq), [0, 1]);
  });

  await check("an ended track ends its segment; a video track is not recorded", async () => {
    const h = harness();
    const t = track();
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: t });
    h.rec.addTrack({ participantId: "g2", displayName: "Bo", track: track("video") });
    assert.equal(h.made.length, 1, "a video track was recorded");
    (t as unknown as { fire: (ev: string) => void }).fire("ended");
    assert.equal(h.made[0].state, "inactive");
    await h.rec.stop();
    assert.equal(h.uploaded.length, 1, "the ended segment's final chunk was not flushed");
  });

  await check("a failed upload is retried with backoff and counted once", async () => {
    let calls = 0;
    const got: RecorderChunk[] = [];
    const h = harness({
      upload: async (c) => {
        calls += 1;
        if (calls <= 2) throw new Error("offline");
        got.push(c);
      },
    });
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    const report = await h.rec.stop();
    assert.equal(got.length, 1);
    assert.deepEqual(h.slept, [10, 20], "no backoff between retries");
    assert.deepEqual(report, { sent: 1, failed: 0, segments: 1, errored: 0 });
  });

  await check("a chunk that never uploads is reported, and stop() still returns", async () => {
    const h = harness({ upload: async () => { throw new Error("server down"); } });
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    h.made[0].emit("a");
    const report = await h.rec.stop();
    assert.deepEqual(report, { sent: 0, failed: 2, segments: 1, errored: 0 });
    // Two chunks retry concurrently, so their waits interleave: three each, the last delay repeating.
    assert.deepEqual([...h.slept].sort((a, b) => a - b), [10, 10, 20, 20, 20, 20], "retries did not repeat the last delay");
  });

  await check("stop() waits for slow uploads to finish before it resolves", async () => {
    const order: string[] = [];
    const h = harness({
      upload: async (c) => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(`up${c.seq}`);
      },
    });
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    h.made[0].emit("a");
    await h.rec.stop();
    order.push("stopped");
    assert.deepEqual([...order].sort(), ["stopped", "up0", "up1"]);
    assert.equal(order[order.length - 1], "stopped", "stop() resolved before the uploads finished");
  });

  await check("stop() waits for a speaker who left just before End to hand over their last chunk (1c on #681)", async () => {
    const h = harness();
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    h.made[0].deferStop = true;
    h.rec.removeTrack("g1"); // Ada leaves; her recorder is still flushing
    setTimeout(() => h.made[0].finishStop(), 30); // her last chunk arrives after End is pressed
    const report = await h.rec.stop();
    assert.deepEqual(h.uploaded.map((c) => c.seq), [0], "Ada's last chunk was lost: stop() resolved before it arrived");
    assert.equal(report.sent, 1);
  });

  await check("stop() stops waiting for a recorder that never fires stop", async () => {
    const { f, made } = factory(["audio/webm;codecs=opus"]);
    const rec = createMeetRecorder({
      code: "abcdefghij", recorders: f, upload: async () => undefined, sleep: async () => undefined,
      streamOf: (t) => t as unknown as MediaStream, flushTimeoutMs: 20,
    });
    rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    made[0].deferStop = true; // never finishes
    const started = Date.now();
    await rec.stop();
    assert.ok(Date.now() - started < 1_000, "End hung on a recorder that never stopped");
  });

  await check("a refusal is not retried: signed out, room ended, too large fail at once (1c on #681)", async () => {
    for (const status of [400, 401, 403, 404, 410, 413]) {
      const h = harness({ upload: async () => { throw new ChunkUploadError(status); } });
      h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
      const report = await h.rec.stop();
      assert.deepEqual(h.slept, [], `${status} was retried`);
      assert.equal(report.failed, 1);
    }
    for (const status of [408, 425, 429, 500, 503]) {
      assert.equal(new ChunkUploadError(status).retryable, true, `${status} should be retried`);
    }
  });

  await check("a recorder that dies restarts the speaker on a new segment, and the host is told (1c on #681)", async () => {
    const h = harness();
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    h.made[0].emit("a");
    h.made[0].fail();
    assert.equal(h.made.length, 2, "the rest of Ada's audio is not being recorded");
    h.made[1].emit("b");
    for (let i = 0; i < 5; i += 1) h.made[h.made.length - 1].fail(); // the last dead one reports again too
    assert.equal(h.made.length, 4, "a recorder that keeps failing was restarted without limit");
    const report = await h.rec.stop();
    assert.equal(report.errored, 4);
    const segs = [...new Set(h.uploaded.map((c) => c.segmentId))];
    assert.ok(segs.length >= 2, "the restart reused the dead segment");
  });

  await check("a dead recorder on an ended track is not restarted", async () => {
    const h = harness();
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track("audio", "ended") });
    h.made[0].fail();
    assert.equal(h.made.length, 1);
    assert.equal((await h.rec.stop()).errored, 1);
  });

  await check("empty data is skipped, and nothing is recorded after stop()", async () => {
    const h = harness();
    h.rec.addTrack({ participantId: "g1", displayName: "Ada", track: track() });
    h.made[0].ondataavailable?.({ data: new Blob([]) });
    await h.rec.stop();
    h.rec.addTrack({ participantId: "g2", displayName: "Bo", track: track() });
    assert.equal(h.made.length, 1, "a track was recorded after stop()");
    assert.deepEqual(h.uploaded.map((c) => c.seq), [0], "an empty blob became a chunk");
  });

  await check("the default upload posts one chunk to the room as the host; a duplicate is fine", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; init: RequestInit }> = [];
    let status = 200;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    try {
      const up = uploadToRoom("abc def");
      const chunk: RecorderChunk = {
        participantId: "p1", displayName: "Ada Lovelace", segmentId: "s1", seq: 3,
        segmentStartedAt: 1234, mimeType: "audio/webm;codecs=opus", data: new Blob(["x"]),
      };
      await up(chunk);
      assert.equal(seen[0].url, "/api/meet/abc%20def/recording/chunk");
      assert.equal(seen[0].init.credentials, "same-origin");
      const headers = seen[0].init.headers as Record<string, string>;
      assert.equal(headers["x-meet-seq"], "3");
      assert.equal(headers["x-meet-segment-started-at"], "1234");
      assert.equal(headers["x-meet-display-name"], "Ada%20Lovelace", "a name with spaces or accents is not header-safe");
      assert.equal(headers["content-type"], "audio/webm;codecs=opus");
      status = 409;
      await up(chunk);
      status = 500;
      await assert.rejects(up(chunk), /chunk_upload_500/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  if (failures) {
    console.log(`meet-recorder: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("meet-recorder: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
