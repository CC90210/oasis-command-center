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
import { createMeetRoomController, type MeetRoomController, type RecorderPort } from "../lib/meet/room-client";

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

type Person = { id: string; name: string; role: "host" | "guest"; tracks: Array<{ trackName: string; kind: "audio" | "video" }> };

/** A stand-in room API: what the handlers answer, plus a log and a check that SFU steps never overlap. */
function fakeRoom(opts: {
  role: "host" | "guest";
  records?: boolean;
  recordAudio?: boolean;
  joinDelayMs?: number;
  failPublishOnce?: boolean;
  /** How long an SFU action takes (ms): a pull 40 and the rest 3, unless set; long enough to act while one is on its way. */
  delays?: Partial<Record<"session" | "publish" | "pull" | "renegotiate" | "close", number>>;
}) {
  const delays = { pull: 40, ...opts.delays };
  const log: string[] = [];
  const me: Person = { id: "me", name: "Me", role: opts.role, tracks: [] };
  const others: Person[] = [];
  let hostPresent = opts.role === "host";
  let stateError: { status: number; error: string; reason?: string } | null = null;
  let hostError: { status: number; error: string } | null = null;
  let statePolls = 0;
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
      log.push("join");
      return reply({ ok: true, participantId: me.id, role: me.role, name: me.name, records: opts.records === true, room: { code: "abc-defg-hjk", title: "Call", status: "live", recordAudio: opts.recordAudio ?? true, startedAt: null }, iceServers: [] });
    }
    if (path === "/state") {
      statePolls += 1;
      if (stateError) return reply({ ok: false, error: stateError.error, ...(stateError.reason ? { reason: stateError.reason } : {}) }, stateError.status);
      return reply({
        ok: true,
        room: { code: "abc-defg-hjk", title: "Call", status: "live", recordAudio: opts.recordAudio ?? true, startedAt: null },
        me: { id: me.id, role: me.role, name: me.name },
        hostPresent,
        participants: [me, ...others].map((p) => ({ id: p.id, name: p.name, role: p.role, me: p.id === me.id, tracks: p.tracks })),
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
        if (action === "session") return hostPresent ? reply({ ok: true }) : reply({ ok: false, error: "waiting_for_host" }, 409);
        if (action === "publish") {
          if (publishFailures > 0) {
            publishFailures -= 1;
            log.push("publish:failed");
            return reply({ ok: false, error: "sfu_failed" }, 502);
          }
          const tracks = body.tracks as Array<{ mid: string; trackName: string; kind: "audio" | "video" }>;
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
        if (action === "renegotiate") return reply({ ok: true });
        if (action === "close") {
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

function controller(room: ReturnType<typeof fakeRoom>, extra: { recorder?: () => RecorderPort; gatherMs?: number } = {}) {
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
  /** A stand-in recorder that writes what it is told into the room's own log, so the order is one timeline. */
  const recorderInto = (log: string[], events: string[] = []) => () => ({
    addTrack: ({ participantId }: { participantId: string }) => events.push(`add:${participantId}`),
    removeTrack: (participantId: string) => events.push(`remove:${participantId}`),
    stop: async () => {
      events.push("stop");
      log.push("recorder:stop");
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
