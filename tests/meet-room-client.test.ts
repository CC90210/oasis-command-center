/**
 * The browser side of an Oasis Meet room (lib/meet/room-client.ts), driven against a stand-in RTCPeerConnection
 * and a stand-in room API that behaves like lib/meet/handlers.ts. It holds the engine to:
 *  - a host connects at once; a guest waits for a host, then connects;
 *  - session, then one publish of "mic" and "cam" on one offer; changes to the session never overlap
 *    (Cloudflare needs each SDP exchange finished before the next);
 *  - what others publish is pulled (and the SFU's offer answered), and closed when they leave;
 *  - mic off stops sending AND disables the track (so a recording hears nothing);
 *  - removal, an ended room and a deleted one end the call and release the camera;
 *  - only a browser the join named as the recorder records; End asks the room to end first and stops the
 *    recorder only once it has (an End that fails keeps the call recorded), then finalizes; a room that ends
 *    some other way finalizes too, and leaving only stops it.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-room-client.test.ts
 */
import assert from "node:assert/strict";
import { createMeetRoomController, type MeetRoomController, type MeetRoomOptions, type RecorderPort } from "../lib/meet/room-client";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

class FakeTrack extends EventTarget {
  enabled = true;
  muted = false;
  readyState: "live" | "ended" = "live";
  constructor(readonly kind: "audio" | "video", readonly label = kind) {
    super();
  }
  stop() {
    this.readyState = "ended";
  }
}

class FakeTransceiver {
  mid: string | null = null;
  stopped = false;
  sender: { track: FakeTrack | null; replaceTrack: (t: FakeTrack | null) => Promise<void> };
  constructor(track: FakeTrack | null, readonly direction: string) {
    this.sender = {
      track,
      replaceTrack: async (t) => {
        this.sender.track = t;
      },
    };
  }
  stop() {
    this.stopped = true;
  }
}

class FakePeer extends EventTarget {
  connectionState = "new";
  iceGatheringState = "complete";
  /** Answering the SFU's offer leaves ICE gathering, the step that can take seconds, unfinished. */
  slowAnswers = false;
  localDescription: { type: string; sdp: string } | null = null;
  transceivers: FakeTransceiver[] = [];
  closed = false;
  constructor(readonly config: unknown) {
    super();
  }
  addTransceiver(trackOrKind: FakeTrack | string, init: { direction: string }) {
    const t = new FakeTransceiver(typeof trackOrKind === "string" ? null : trackOrKind, init.direction);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  /** A closed RTCPeerConnection refuses every further step (InvalidStateError), as a browser's does. */
  private open() {
    if (this.closed) throw new Error("InvalidStateError: the RTCPeerConnection is closed");
  }
  async createOffer() {
    this.open();
    this.transceivers.forEach((t, i) => {
      if (t.mid === null) t.mid = String(i);
    });
    return { type: "offer", sdp: `offer ${this.transceivers.filter((t) => !t.stopped).map((t) => t.mid).join(",")}` };
  }
  async createAnswer() {
    this.open();
    return { type: "answer", sdp: "answer" };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.open();
    this.localDescription = d;
    if (d.type === "answer" && this.slowAnswers) this.iceGatheringState = "gathering";
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.open();
    if (d.type === "answer" && this.connectionState !== "connected") {
      this.connectionState = "connected";
      this.dispatchEvent(new Event("connectionstatechange"));
    }
    if (d.type === "offer" && d.sdp.startsWith("pull ")) {
      // The SFU's offer carries the pulled tracks: the browser makes a receiver per mid and fires "track".
      for (const item of d.sdp.slice(5).split(",")) {
        const [mid, kind] = item.split(":");
        const t = new FakeTransceiver(null, "recvonly");
        t.mid = mid;
        this.transceivers.push(t);
        const event = Object.assign(new Event("track"), { transceiver: t, track: new FakeTrack(kind as "audio" | "video", `remote-${mid}`) });
        queueMicrotask(() => this.dispatchEvent(event));
      }
    }
  }
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

/** `session` stands for the tag the server sends of their SFU session: it changes when they reconnect. */
type Person = { id: string; name: string; role: "host" | "guest"; session?: string; tracks: Array<{ trackName: string; kind: "audio" | "video" }> };
/** The room refuses something this many times with this answer, then takes it. */
type Refusal = { times: number; status: number; error: string };

/** A stand-in room API: what the handlers answer, plus a log and a check that SFU steps never overlap. */
function fakeRoom(opts: {
  role: "host" | "guest";
  records?: boolean;
  recordAudio?: boolean;
  joinDelayMs?: number;
  failPublishOnce?: boolean;
  /** How long an SFU action takes (ms): a pull 40 and the rest 3, unless set; long enough to act while one is on its way. */
  delays?: Partial<Record<"session" | "publish" | "pull" | "renegotiate" | "close", number>>;
  /** How long a host action (end, remove) takes, in ms. */
  hostDelayMs?: number;
  /** The SFU refuses this many answers to its pull offers, then takes them. */
  failRenegotiate?: number;
  /** The SFU refuses this many screen publishes, then takes them. */
  failScreenPublish?: number;
  /** The SFU refuses this many closes, then takes them. */
  failClose?: number;
  /** This many new sessions are refused with this answer (a reconnect waiting on its old session's cut), then made. */
  refuseSessions?: Refusal;
  /** This many joins are refused with this answer, then taken. */
  refuseJoins?: Refusal;
}) {
  let renegotiateFailures = opts.failRenegotiate ?? 0;
  let screenFailures = opts.failScreenPublish ?? 0;
  let closeFailures = opts.failClose ?? 0;
  let sessionRefusal = opts.refuseSessions ?? null;
  let sessionRefusals = opts.refuseSessions?.times ?? 0;
  let joinRefusals = opts.refuseJoins?.times ?? 0;
  /** The next poll hangs until the browser gives up on it (its AbortSignal). */
  let hangNextPoll = false;
  const delays = { pull: 40, ...opts.delays };
  const log: string[] = [];
  const me: Person = { id: "me", name: "Me", role: opts.role, tracks: [] };
  const others: Person[] = [];
  let hostPresent = opts.role === "host";
  let stateError: { status: number; error: string; reason?: string } | null = null;
  let hostError: { status: number; error: string } | null = null;
  let statePolls = 0;
  let recording = false;
  let publishFailures = opts.failPublishOnce ? 1 : 0;
  let sfuInFlight = 0;
  let overlapped = false;
  let pulledMid = 0;
  let busyWith: string | null = null;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api\/meet\/[a-z-]+/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (path === "/join") {
      if (opts.joinDelayMs) await new Promise((r) => setTimeout(r, opts.joinDelayMs));
      if (joinRefusals > 0 && opts.refuseJoins) {
        joinRefusals -= 1;
        log.push(`join:refused:${opts.refuseJoins.error}`);
        return reply({ ok: false, error: opts.refuseJoins.error }, opts.refuseJoins.status);
      }
      log.push("join");
      return reply({ ok: true, participantId: me.id, role: me.role, name: me.name, records: opts.records === true, room: { code: "abc-defg-hjk", title: "Call", status: "live", recordAudio: opts.recordAudio ?? true, startedAt: null }, iceServers: [] });
    }
    if (path === "/state") {
      statePolls += 1;
      if (hangNextPoll) {
        hangNextPoll = false;
        log.push("state:hung");
        await new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
      }
      if (stateError) return reply({ ok: false, error: stateError.error, ...(stateError.reason ? { reason: stateError.reason } : {}) }, stateError.status);
      return reply({
        ok: true,
        room: { code: "abc-defg-hjk", title: "Call", status: "live", recordAudio: opts.recordAudio ?? true, startedAt: null },
        me: { id: me.id, role: me.role, name: me.name },
        hostPresent,
        recording,
        participants: [me, ...others].map((p) => ({ id: p.id, name: p.name, role: p.role, me: p.id === me.id, session: p.session ?? null, tracks: p.tracks })),
      });
    }
    if (path === "/sfu") {
      sfuInFlight += 1;
      if (sfuInFlight > 1) overlapped = true;
      busyWith = String(body.action);
      try {
        // A pull takes a while, so a test can start something else while it is in flight.
        await new Promise((r) => setTimeout(r, delays[body.action as keyof typeof delays] ?? 3));
        const action = String(body.action);
        log.push(`sfu:${action}`);
        if (action === "session") {
          if (sessionRefusals > 0 && sessionRefusal) {
            sessionRefusals -= 1;
            log.push(`session:refused:${sessionRefusal.error}`);
            return reply({ ok: false, error: sessionRefusal.error }, sessionRefusal.status);
          }
          return hostPresent ? reply({ ok: true }) : reply({ ok: false, error: "waiting_for_host" }, 409);
        }
        if (action === "publish") {
          if (publishFailures > 0) {
            publishFailures -= 1;
            log.push("publish:failed");
            return reply({ ok: false, error: "sfu_failed" }, 502);
          }
          const tracks = body.tracks as Array<{ mid: string; trackName: string; kind: "audio" | "video" }>;
          if (screenFailures > 0 && tracks.some((t) => t.trackName === "screen")) {
            screenFailures -= 1;
            log.push("publish:screen:failed");
            return reply({ ok: false, error: "sfu_failed" }, 502);
          }
          log.push(`publish:${tracks.map((t) => `${t.trackName}@${t.mid}`).join(",")}`);
          for (const t of tracks) me.tracks.push({ trackName: t.trackName, kind: t.kind });
          return reply({ ok: true, sessionDescription: { type: "answer", sdp: "answer" }, tracks: tracks.map((t) => ({ trackName: t.trackName, mid: t.mid, errorCode: null })) });
        }
        if (action === "pull") {
          const wanted = body.tracks as Array<{ participantId: string; trackName: string }>;
          log.push(`pull:${wanted.map((w) => `${w.participantId}.${w.trackName}`).join(",")}`);
          const results = wanted.map((w) => {
            const owner = others.find((o) => o.id === w.participantId);
            const kind = owner?.tracks.find((t) => t.trackName === w.trackName)?.kind ?? "audio";
            return { participantId: w.participantId, trackName: w.trackName, mid: `r${(pulledMid += 1)}`, errorCode: null, kind };
          });
          return reply({
            ok: true,
            requiresImmediateRenegotiation: true,
            sessionDescription: { type: "offer", sdp: `pull ${results.map((r) => `${r.mid}:${r.kind}`).join(",")}` },
            tracks: results.map(({ kind: _kind, ...r }) => r),
          });
        }
        if (action === "renegotiate") {
          if (renegotiateFailures > 0) {
            renegotiateFailures -= 1;
            log.push("renegotiate:failed");
            return reply({ ok: false, error: "sfu_failed" }, 502);
          }
          return reply({ ok: true });
        }
        if (action === "close") {
          if (closeFailures > 0) {
            closeFailures -= 1;
            log.push("close:failed");
            return reply({ ok: false, error: "sfu_failed" }, 502);
          }
          log.push(`close:${(body.mids as string[]).join(",")}`);
          return reply({ ok: true, sessionDescription: { type: "answer", sdp: "answer" }, tracks: [] });
        }
        return reply({ ok: false, error: "invalid_body" }, 400);
      } finally {
        sfuInFlight -= 1;
        if (sfuInFlight === 0) busyWith = null;
      }
    }
    if (path === "/host") {
      if (opts.hostDelayMs) await new Promise((r) => setTimeout(r, opts.hostDelayMs));
      log.push(`host:${String(body.action)}${hostError ? `:${hostError.status}` : ""}`);
      return hostError ? reply({ ok: false, error: hostError.error }, hostError.status) : reply({ ok: true });
    }
    if (path === "/recording/finalize") {
      log.push(`finalize:${JSON.stringify(body)}`);
      return reply({ ok: true, state: "queued" });
    }
    if (path === "/leave") {
      log.push("leave");
      return reply({ ok: true });
    }
    return reply({ ok: false, error: "not_found" }, 404);
  };
  return {
    fetchImpl: fetchImpl as typeof fetch,
    log,
    others,
    setHostPresent: (v: boolean) => {
      hostPresent = v;
    },
    failState: (status: number, error: string, reason?: string) => {
      stateError = { status, error, reason };
    },
    failHost: (failure: { status: number; error: string } | null) => {
      hostError = failure;
    },
    polls: () => statePolls,
    setRecording: (v: boolean) => {
      recording = v;
    },
    hangNextPoll: () => {
      hangNextPoll = true;
    },
    /** From now on, refuse new sessions (a call that is already live, reconnecting). */
    refuseSessions: (refusal: Refusal) => {
      sessionRefusal = refusal;
      sessionRefusals = refusal.times;
    },
    overlapped: () => overlapped,
    busyWith: () => busyWith,
  };
}

async function waitFor(what: string, test: () => boolean, ms = 2_000) {
  const until = Date.now() + ms;
  while (!test()) {
    if (Date.now() > until) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A browser whose camera, microphone and screen answers are released by hand, so a test can make one come late. */
function heldMedia() {
  const waiting: Array<{ release: () => FakeTrack }> = [];
  const answer = (kind: "audio" | "video", label: string, wrap: (t: FakeTrack) => unknown) =>
    new Promise((resolve) => {
      waiting.push({
        release: () => {
          const track = new FakeTrack(kind, label);
          resolve(wrap(track));
          return track;
        },
      });
    });
  const media = {
    getUserMedia: (c: MediaStreamConstraints) =>
      answer(c.audio ? "audio" : "video", c.audio ? "mic" : "cam", (t) => ({ getAudioTracks: () => (c.audio ? [t] : []), getVideoTracks: () => (c.video ? [t] : []) })),
    getDisplayMedia: () => answer("video", "screen", (t) => ({ getVideoTracks: () => [t] })),
  } as unknown as MeetRoomOptions["media"];
  return { media, waiting };
}

function controller(
  room: ReturnType<typeof fakeRoom>,
  extra: { recorder?: () => RecorderPort; gatherMs?: number; media?: MeetRoomOptions["media"]; pollTimeoutMs?: number; reconnectMs?: number } = {},
) {
  const peers: FakePeer[] = [];
  const c = createMeetRoomController({
    code: "abc-defg-hjk",
    fetchImpl: room.fetchImpl,
    pollMs: 10,
    gatherMs: 5,
    connectMs: 500,
    makePeer: (config) => {
      const peer = new FakePeer(config);
      peers.push(peer);
      return peer as unknown as RTCPeerConnection;
    },
    media: {
      getUserMedia: async (c: MediaStreamConstraints) => ({ getAudioTracks: () => (c.audio ? [new FakeTrack("audio")] : []), getVideoTracks: () => (c.video ? [new FakeTrack("video")] : []) }) as unknown as MediaStream,
      getDisplayMedia: async () => ({ getVideoTracks: () => [new FakeTrack("video", "screen")] }) as unknown as MediaStream,
    },
    ...extra,
  });
  return { c, peers };
}

const leaveQuietly = async (c: MeetRoomController) => {
  await c.leave();
};

async function main() {
  console.log("meet room client:");

  await check("a host connects at once: session, then one publish of mic and cam on one offer", async () => {
    const room = fakeRoom({ role: "host" });
    const { c, peers } = controller(room);
    const mic = new FakeTrack("audio");
    const cam = new FakeTrack("video");
    await c.join({ consent: true, mic: mic as unknown as MediaStreamTrack, cam: cam as unknown as MediaStreamTrack });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    assert.deepEqual(room.log.filter((l) => l.startsWith("sfu:") || l.startsWith("publish:")).slice(0, 3), ["sfu:session", "sfu:publish", "publish:mic@0,cam@1"]);
    assert.equal(peers[0].transceivers[0].sender.track, mic, "the microphone is on the mic sender");
    assert.equal(peers[0].transceivers[1].sender.track, cam);
    assert.ok(peers[0].transceivers.every((t) => t.direction === "sendonly"));
    await leaveQuietly(c);
  });

  await check("a guest waits for the host, and connects once the host is there", async () => {
    const room = fakeRoom({ role: "guest" });
    room.setHostPresent(false);
    const { c } = controller(room);
    await c.join({ name: "Jane", consent: true, mic: null, cam: null });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(c.snapshot().phase.kind, "waiting_for_host");
    assert.ok(!room.log.includes("sfu:session"), "no session while no host is present");
    room.setHostPresent(true);
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    await leaveQuietly(c);
  });

  await check("what others publish is pulled and answered; when they leave it is closed; steps never overlap", async () => {
    const room = fakeRoom({ role: "host" });
    const { c, peers } = controller(room);
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }, { trackName: "cam", kind: "video" }] });
    await waitFor("both tracks arrive", () => {
      const tile = c.snapshot().tiles.find((t) => t.participantId === "g1");
      return !!tile?.audio && !!tile?.video;
    });
    assert.ok(room.log.includes("pull:g1.mic,g1.cam"));
    const pullAt = room.log.indexOf("pull:g1.mic,g1.cam");
    await waitFor("the SFU's offer is answered", () => room.log.slice(pullAt).includes("sfu:renegotiate"));
    room.others.splice(0, 1);
    await waitFor("closed", () => room.log.some((l) => l.startsWith("close:")));
    const closed = room.log.find((l) => l.startsWith("close:"))!;
    assert.deepEqual(closed.slice(6).split(",").sort(), ["r1", "r2"]);
    assert.ok(peers[0].transceivers.filter((t) => t.direction === "recvonly").every((t) => t.stopped), "their receivers are stopped");
    await waitFor("their tile is gone", () => !c.snapshot().tiles.some((t) => t.participantId === "g1"));
    assert.equal(room.overlapped(), false, "no two SFU steps ran at once");
    await leaveQuietly(c);
  });

  await check("a screen share started while a pull is in flight waits its turn", async () => {
    const room = fakeRoom({ role: "host" });
    const { c } = controller(room);
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("a pull in flight", () => room.busyWith() === "pull");
    const sharing = c.shareScreen(true);
    await sharing;
    await waitFor("the screen is published", () => room.log.includes("publish:screen@1") || room.log.some((l) => l.startsWith("publish:screen@")));
    assert.equal(room.overlapped(), false, "the screen's publish did not start until the pull's exchange was done");
    await leaveQuietly(c);
  });

  await check("mic off stops sending and disables the track; mic on brings both back", async () => {
    const room = fakeRoom({ role: "host" });
    const { c, peers } = controller(room);
    const mic = new FakeTrack("audio");
    await c.join({ consent: true, mic: mic as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    await c.setMic(false);
    assert.equal(mic.enabled, false, "a recording of this track hears nothing");
    assert.equal(peers[0].transceivers[0].sender.track, null, "and the room gets nothing");
    assert.equal(c.snapshot().micOn, false);
    await c.setMic(true);
    assert.equal(mic.enabled, true);
    assert.equal(peers[0].transceivers[0].sender.track, mic);
    await c.setCam(true);
    const cam = peers[0].transceivers[1].sender.track!;
    assert.equal(cam.kind, "video");
    await c.setCam(false);
    assert.equal(cam.readyState, "ended", "turning the camera off releases it (its light goes out)");
    await leaveQuietly(c);
  });

  await check("removed, ended or deleted: the call ends, says who ended it only when a host did, and releases the camera", async () => {
    const cases = [
      [403, "removed", undefined, "removed"],
      [410, "room_ended", "host_ended", "host_ended"],
      [410, "room_ended", "host_left", "room_closed"],
      [410, "room_ended", undefined, "room_closed"],
      // Its host deleted the meeting mid-call: gone for good, never "Reconnecting to the room...".
      [404, "room_not_found", undefined, "room_closed"],
    ] as const;
    for (const [status, error, why, reason] of cases) {
      const room = fakeRoom({ role: "guest" });
      room.setHostPresent(true);
      const { c, peers } = controller(room);
      const cam = new FakeTrack("video");
      await c.join({ name: "Jane", consent: true, mic: null, cam: cam as unknown as MediaStreamTrack });
      await waitFor("live", () => c.snapshot().phase.kind === "live");
      room.failState(status, error, why);
      await waitFor(`ended ${reason}`, () => c.snapshot().phase.kind === "ended");
      assert.deepEqual(c.snapshot().phase, { kind: "ended", reason }, `${status} ${error} ${why ?? "-"}`);
      assert.equal(cam.readyState, "ended");
      assert.equal(peers[0].closed, true);
    }
  });

  await check("leaving while it reconnects, or while the join is on its way, stays left", async () => {
    // A publish that fails makes the room reconnect after a wait; Leave during that wait must hold.
    const flaky = fakeRoom({ role: "host", failPublishOnce: true });
    const a = controller(flaky);
    void a.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("the first publish failed", () => flaky.log.includes("publish:failed"));
    await waitFor("waiting to reconnect", () => a.c.snapshot().notice === "Reconnecting...");
    await a.c.leave();
    await new Promise((r) => setTimeout(r, 1_300)); // past the reconnect wait
    await a.c.setMic(false); // any later update redraws the snapshot: it must still read ended
    assert.deepEqual(a.c.snapshot().phase, { kind: "ended", reason: "left" });
    assert.ok(!flaky.log.slice(flaky.log.indexOf("publish:failed") + 1).includes("sfu:session"), "and it did not connect again");

    const slow = fakeRoom({ role: "guest", joinDelayMs: 80 });
    slow.setHostPresent(true);
    const b = controller(slow);
    const joining = b.c.join({ name: "Jane", consent: true, mic: null, cam: null });
    await b.c.leave();
    await joining;
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(b.c.snapshot().phase, { kind: "ended", reason: "left" }, "the join's answer arriving after Leave does not bring the call back");
  });

  const REPORT = 'finalize:{"sent":3,"failed":0,"segments":2,"errored":0}';
  /**
   * A stand-in recorder that writes what it is told into the room's own log, so the order is one timeline. `stopMs`:
   * how long stop() takes to hand over its last chunks (a real one waits for its uploads).
   */
  const recorderInto = (log: string[], events: string[] = [], stopMs = 0) => () => ({
    addTrack: ({ participantId }: { participantId: string }) => events.push(`add:${participantId}`),
    removeTrack: (participantId: string) => events.push(`remove:${participantId}`),
    stop: async () => {
      events.push("stop");
      log.push("recorder:stop");
      if (stopMs) await new Promise((r) => setTimeout(r, stopMs));
      return { sent: 3, failed: 0, segments: 2, errored: 0 };
    },
  });
  const recordingHost = async () => {
    const room = fakeRoom({ role: "host", records: true });
    const { c } = controller(room, { recorder: recorderInto(room.log) });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    assert.equal(c.snapshot().recording, true);
    return { room, c };
  };
  const after = (log: string[], from: string) => log.slice(log.indexOf(from));

  await check("only the browser the join names records; End asks the room first, then stops the recorder, then finalizes", async () => {
    const events: string[] = [];
    const room = fakeRoom({ role: "host", records: true });
    const recorderFor = recorderInto(room.log, events);
    const notRecording = fakeRoom({ role: "host", records: false });
    const a = controller(notRecording, { recorder: recorderFor });
    await a.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => a.c.snapshot().phase.kind === "live");
    assert.deepEqual(events, [], "a second host never records");
    assert.equal(a.c.snapshot().recording, false);
    await leaveQuietly(a.c);

    const { c } = controller(room, { recorder: recorderFor });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    assert.equal(c.snapshot().recording, true);
    room.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("the guest's mic is recorded", () => events.includes("add:g1"));
    assert.deepEqual(events.slice(0, 2), ["add:me", "add:g1"]);
    room.others.splice(0, 1);
    await waitFor("their recording segment ends", () => events.includes("remove:g1"));
    await c.end();
    const order = room.log.filter((l) => l.startsWith("host:") || l === "recorder:stop" || l.startsWith("finalize:"));
    assert.deepEqual(order, ["host:end", "recorder:stop", REPORT], "the room ends first; the recorder stops once it has; then the PC is told, with the report");
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "host_ended" });
  });

  await check("an End that fails keeps the call going and recorded, and the room's poll going; the next End finishes it", async () => {
    const { room, c } = await recordingHost();
    room.failHost({ status: 502, error: "sfu_failed" });
    await c.end();
    assert.equal(c.snapshot().phase.kind, "live");
    assert.equal(c.snapshot().recording, true, "still recording");
    assert.equal(c.snapshot().notice, "Could not end the meeting. Try again.");
    assert.ok(!room.log.includes("recorder:stop"), "the recorder was never stopped");
    const polls = room.polls();
    await waitFor("the room's poll goes on", () => room.polls() >= polls + 3);
    room.failHost(null);
    await c.end();
    const order = room.log.filter((l) => l.startsWith("host:") || l === "recorder:stop" || l.startsWith("finalize:"));
    assert.deepEqual(order, ["host:end:502", "host:end", "recorder:stop", REPORT], "nothing was lost between the two");
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "host_ended" });
  });

  await check("a room that ends some other way (another host, its host gone) still finishes the recording; leaving only stops it", async () => {
    const ended = await recordingHost();
    ended.room.failState(410, "room_ended", "host_ended");
    await waitFor("ended", () => ended.c.snapshot().phase.kind === "ended");
    await waitFor("the PC is told", () => ended.room.log.includes(REPORT));
    assert.deepEqual(after(ended.room.log, "recorder:stop").filter((l) => l === "recorder:stop" || l.startsWith("finalize:")), ["recorder:stop", REPORT]);

    const left = await recordingHost();
    await left.c.leave();
    await waitFor("stopped", () => left.room.log.includes("recorder:stop"));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!left.room.log.some((l) => l.startsWith("finalize:")), "a creator who leaves may come back: the room's end hands the recording over");
  });

  await check("a pull or a close still on its way when the call ends is dropped quietly, never answered on a closed connection", async () => {
    const room = fakeRoom({ role: "host" });
    const { c } = controller(room);
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("a pull on its way", () => room.busyWith() === "pull");
    await c.leave(); // the pull's answer arrives after the connection has closed
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "left" });
    assert.ok(!room.log.includes("sfu:renegotiate"), "the SFU's offer from that pull was never answered");

    // Leaving while the browser is still gathering ICE for its answer (that can take seconds): never sent.
    const gathering = fakeRoom({ role: "host" });
    const slow = controller(gathering, { gatherMs: 120 });
    await slow.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => slow.c.snapshot().phase.kind === "live");
    slow.peers[0].slowAnswers = true;
    gathering.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("gathering for the answer", () => slow.peers[0].iceGatheringState === "gathering");
    await slow.c.leave();
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!gathering.log.includes("sfu:renegotiate"), "an answer for a call that has ended is never sent");

    const closing = fakeRoom({ role: "host", delays: { close: 60 } });
    const second = controller(closing);
    await second.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => second.c.snapshot().phase.kind === "live");
    closing.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("pulled", () => second.c.snapshot().tiles.some((t) => t.participantId === "g1" && t.audio));
    closing.others.splice(0, 1);
    await waitFor("a close on its way", () => closing.busyWith() === "close");
    await second.c.leave();
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(second.c.snapshot().phase, { kind: "ended", reason: "left" });

    // Leaving while a screen share is being published: no "Could not share your screen" for a call that is over.
    const sharing = fakeRoom({ role: "host", delays: { publish: 60 } });
    const third = controller(sharing);
    await third.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => third.c.snapshot().phase.kind === "live");
    const share = third.c.shareScreen(true);
    await waitFor("the share on its way", () => sharing.busyWith() === "publish");
    await third.c.leave();
    await share;
    assert.deepEqual(third.c.snapshot().phase, { kind: "ended", reason: "left" });
    assert.equal(third.c.snapshot().notice, null);
  });

  await check("someone who reconnects is pulled anew, and their new microphone recorded: a track from their old session never stands in for them", async () => {
    const events: string[] = [];
    const room = fakeRoom({ role: "host", records: true });
    const { c } = controller(room, { recorder: recorderInto(room.log, events) });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.others.push({ id: "g1", name: "Guest", role: "guest", session: "s1", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("recorded", () => events.includes("add:g1"));
    const pulls = room.log.filter((l) => l.startsWith("pull:")).length;
    room.others[0].session = "s2"; // they reconnected and published the same tracks again, all between two polls
    await waitFor("pulled again", () => room.log.filter((l) => l.startsWith("pull:")).length > pulls);
    await waitFor("the old one closed", () => room.log.some((l) => l.startsWith("close:")));
    await waitFor("recorded again", () => events.filter((e) => e === "add:g1").length === 2);
    assert.equal(c.snapshot().tiles.filter((t) => t.participantId === "g1").length, 1, "still one tile for them");
    await leaveQuietly(c);
  });

  await check("End and a poll that sees the end land together: the recording is finished, and the PC told, exactly once", async () => {
    const room = fakeRoom({ role: "host", records: true, hostDelayMs: 60 });
    // The recorder takes longer to hand over its last chunks than End's answer takes to arrive, so End comes to the
    // recorder while the poll's stop is still under way.
    const { c } = controller(room, { recorder: recorderInto(room.log, [], 150) });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    const ending = c.end(); // the room ends at once; its answer takes a while to come back
    room.failState(410, "room_ended", "host_ended"); // so a poll sees the end first
    await ending;
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(room.log.filter((l) => l === "recorder:stop").length, 1, "the recorder is stopped once");
    assert.equal(room.log.filter((l) => l.startsWith("finalize:")).length, 1, "and the PC is told once");
    assert.equal(c.snapshot().phase.kind, "ended");
  });

  await check("a camera, microphone or screen answered after it stopped being wanted is stopped, never held: no light left on", async () => {
    // Camera tapped twice: only the second answer is kept.
    {
      const room = fakeRoom({ role: "host" });
      const held = heldMedia();
      const { c } = controller(room, { media: held.media });
      await c.join({ consent: true, mic: null, cam: null });
      await waitFor("live", () => c.snapshot().phase.kind === "live");
      const first = c.setCam(true);
      const second = c.setCam(true);
      await waitFor("two asks", () => held.waiting.length === 2);
      const a = held.waiting[0].release();
      const b = held.waiting[1].release();
      await Promise.all([first, second]);
      assert.equal(a.readyState, "ended", "the first answer is stopped");
      assert.equal(b.readyState, "live");
      assert.equal(c.snapshot().camOn, true);
      await leaveQuietly(c);
      assert.equal(b.readyState, "ended");
    }
    // Answered after Leave, or after it was turned off again: camera, microphone and screen alike.
    for (const [ask, then] of [["cam", "leave"], ["mic", "leave"], ["screen", "leave"], ["cam", "off"], ["mic", "off"], ["screen", "off"]] as const) {
      const room = fakeRoom({ role: "host" });
      const held = heldMedia();
      const { c } = controller(room, { media: held.media });
      await c.join({ consent: true, mic: null, cam: null });
      await waitFor("live", () => c.snapshot().phase.kind === "live");
      const asking = ask === "cam" ? c.setCam(true) : ask === "mic" ? c.setMic(true) : c.shareScreen(true);
      await waitFor("asked", () => held.waiting.length === 1);
      if (then === "leave") await c.leave();
      else await (ask === "cam" ? c.setCam(false) : ask === "mic" ? c.setMic(false) : c.shareScreen(false));
      const late = held.waiting[0].release();
      await asking;
      assert.equal(late.readyState, "ended", `${ask} answered after ${then} is stopped`);
      assert.equal(c.snapshot()[ask === "cam" ? "camOn" : ask === "mic" ? "micOn" : "sharing"], false, `${ask} after ${then}: not on`);
      if (then === "off") await leaveQuietly(c);
    }
  });

  await check("a pull whose answer the SFU refused is pulled again on the next poll, never left silent", async () => {
    const room = fakeRoom({ role: "host", failRenegotiate: 1 });
    const { c } = controller(room);
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    const errors = console.error;
    console.error = () => {}; // the refused answer is logged on purpose
    try {
      room.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
      await waitFor("refused once", () => room.log.includes("renegotiate:failed"));
      await waitFor("pulled again and answered", () => room.log.filter((l) => l.startsWith("pull:g1.mic")).length >= 2 && room.log.includes("sfu:renegotiate"));
      await waitFor("their voice arrives", () => c.snapshot().tiles.some((t) => t.participantId === "g1" && t.audio));
    } finally {
      console.error = errors;
    }
    await leaveQuietly(c);
  });

  await check("a screen share the SFU refused is published anew next time, never fed to a sender nobody receives", async () => {
    const room = fakeRoom({ role: "host", failScreenPublish: 1 });
    const { c } = controller(room);
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    await c.shareScreen(true);
    assert.equal(c.snapshot().notice, "Could not share your screen. Try again.");
    assert.equal(c.snapshot().sharing, false);
    await c.shareScreen(true);
    assert.ok(room.log.some((l) => /^publish:screen@/.test(l)), "the second try publishes the screen to the SFU");
    assert.equal(c.snapshot().sharing, true);
    await leaveQuietly(c);
  });

  await check("a poll that hangs is given up, and the polls after it go on", async () => {
    const room = fakeRoom({ role: "host" });
    const { c } = controller(room, { pollTimeoutMs: 50 });
    await c.join({ consent: true, mic: null, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.hangNextPoll();
    await waitFor("a poll hangs", () => room.log.includes("state:hung"));
    const polls = room.polls();
    await waitFor("polling again", () => room.polls() >= polls + 2, 3_000);
    assert.equal(c.snapshot().phase.kind, "live", "still in the call");
    await leaveQuietly(c);
  });

  await check("a reconnect the video service refuses keeps trying for longer than other failures, and others give up after three", async () => {
    const refused = fakeRoom({ role: "host", refuseSessions: { times: 4, status: 502, error: "sfu_failed" } });
    const a = controller(refused, { reconnectMs: 5 });
    await a.c.join({ consent: true, mic: null, cam: null });
    await waitFor("live after four refusals", () => a.c.snapshot().phase.kind === "live", 3_000);
    assert.equal(refused.log.filter((l) => l === "session:refused:sfu_failed").length, 4);
    await leaveQuietly(a.c);
    const broken = fakeRoom({ role: "host", refuseSessions: { times: 4, status: 500, error: "internal" } });
    const b = controller(broken, { reconnectMs: 5 });
    await b.c.join({ consent: true, mic: null, cam: null });
    await waitFor("given up", () => b.c.snapshot().phase.kind === "failed", 3_000);
  });

  await check("a camera or microphone asked for before the call failed is stopped when it answers, even after the join is tried again", async () => {
    // Both ways a join fails: the video service refuses the call, or the room refuses the join itself.
    for (const [how, refusal] of [
      ["the video service refused", { refuseSessions: { times: 1, status: 503, error: "meet_not_configured" } }],
      ["the join was refused", { refuseJoins: { times: 1, status: 409, error: "room_full" } }],
    ] as const) {
      const room = fakeRoom({ role: "host", ...refusal });
      const held = heldMedia();
      const { c } = controller(room, { media: held.media });
      const joining = c.join({ consent: true, mic: null, cam: null });
      const askingCam = c.setCam(true); // asked for while the join is on its way
      const askingMic = c.setMic(true);
      await joining;
      await waitFor("failed", () => c.snapshot().phase.kind === "failed");
      await c.join({ consent: true, mic: null, cam: null }); // tried again: the controller is open once more
      await waitFor("live", () => c.snapshot().phase.kind === "live");
      const cam = held.waiting[0].release();
      const mic = held.waiting[1].release();
      await Promise.all([askingCam, askingMic]);
      assert.equal(cam.readyState, "ended", `${how}: the camera answer belongs to the call that failed`);
      assert.equal(mic.readyState, "ended", `${how}: the microphone answer too`);
      assert.equal(c.snapshot().camOn, false, how);
      assert.equal(c.snapshot().micOn, false, how);
      await leaveQuietly(c);
    }
  });

  await check("a screen picked while the call failed is stopped when it is chosen, never shared into the call joined again", async () => {
    const room = fakeRoom({ role: "host" });
    const held = heldMedia();
    const { c, peers } = controller(room, { media: held.media, reconnectMs: 5 });
    await c.join({ consent: true, mic: null, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    const picking = c.shareScreen(true);
    await waitFor("picking", () => held.waiting.length === 1);
    room.refuseSessions({ times: 1, status: 503, error: "meet_not_configured" });
    const line = peers[peers.length - 1];
    line.connectionState = "failed";
    line.dispatchEvent(new Event("connectionstatechange"));
    await waitFor("failed", () => c.snapshot().phase.kind === "failed");
    await c.join({ consent: true, mic: null, cam: null });
    await waitFor("live again", () => c.snapshot().phase.kind === "live");
    const screen = held.waiting[0].release();
    await picking;
    assert.equal(screen.readyState, "ended", "the screen was picked for the call that failed");
    assert.equal(c.snapshot().sharing, false);
    assert.ok(!room.log.some((l) => l.includes("screen@")), "nothing is shared into the new call");
    await leaveQuietly(c);
  });

  await check("a screen being shared goes out again on the new session after a reconnect", async () => {
    const room = fakeRoom({ role: "host" });
    const { c, peers } = controller(room, { reconnectMs: 5 });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    await c.shareScreen(true);
    assert.ok(room.log.some((l) => /^publish:screen@/.test(l)), "shared");
    const line = peers[peers.length - 1];
    line.connectionState = "failed";
    line.dispatchEvent(new Event("connectionstatechange"));
    await waitFor("a new line", () => peers.length === 2 && c.snapshot().phase.kind === "live");
    const publishes = room.log.filter((l) => l.startsWith("publish:"));
    assert.match(publishes[publishes.length - 1], /^publish:mic@\d+,cam@\d+,screen@\d+$/, "the new session publishes the screen with the mic and camera");
    assert.equal(c.snapshot().sharing, true);
    await leaveQuietly(c);
  });

  await check("a close the SFU refuses is logged, and the call goes on", async () => {
    const room = fakeRoom({ role: "host", failClose: 1 });
    const { c } = controller(room);
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("pulled", () => c.snapshot().tiles.some((t) => t.participantId === "g1" && t.audio));
    const errors = console.error;
    console.error = () => {}; // the refused close is logged on purpose
    try {
      room.others.splice(0, 1);
      await waitFor("refused", () => room.log.includes("close:failed"));
      await new Promise((r) => setTimeout(r, 40));
    } finally {
      console.error = errors;
    }
    assert.equal(c.snapshot().phase.kind, "live");
    await leaveQuietly(c);
  });

  await check("a recorder that cannot stop cleanly never keeps the call from ending", async () => {
    const room = fakeRoom({ role: "host", records: true });
    const broken = () => ({ addTrack: () => undefined, removeTrack: () => undefined, stop: async () => { throw new Error("recorder died"); } });
    const { c } = controller(room, { recorder: broken });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    const errors = console.error;
    console.error = () => {}; // the failure is logged on purpose
    try {
      await c.end();
    } finally {
      console.error = errors;
    }
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "host_ended" });
    assert.ok(!room.log.some((l) => l.startsWith("finalize:")), "no report to send: the server hands the recording over on its own");
  });

  await check("the room's recording is shown as running only when the room says so", async () => {
    const room = fakeRoom({ role: "guest" });
    room.setHostPresent(true);
    const { c } = controller(room);
    await c.join({ name: "Jane", consent: true, mic: null, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    assert.equal(c.snapshot().roomRecording, false, "a host is here, but not the browser that records");
    room.setRecording(true);
    await waitFor("shown", () => c.snapshot().roomRecording === true);
    room.setRecording(false);
    await waitFor("no longer shown", () => c.snapshot().roomRecording === false);
    await leaveQuietly(c);
  });

  await check("a join the room refuses is said in plain words, and nothing is held", async () => {
    const room = fakeRoom({ role: "guest" });
    const refusing = { ...room, fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: "room_full" }), { status: 409 })) as typeof fetch };
    const { c } = controller(refusing);
    const cam = new FakeTrack("video");
    await c.join({ name: "Jane", consent: true, mic: null, cam: cam as unknown as MediaStreamTrack });
    assert.deepEqual(c.snapshot().phase, { kind: "failed", error: "This meeting is full.", code: "room_full" }, "the words to show, and the code a page acts on");
    assert.equal(cam.readyState, "ended", "the camera is released");
  });

  if (failures) {
    console.error(`meet room client: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("meet room client: all checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
