/**
 * The browser side of an Oasis Meet room (lib/meet/room-client.ts), driven against a stand-in RTCPeerConnection
 * and a stand-in room API that behaves like lib/meet/handlers.ts. It holds the engine to:
 *  - a host connects at once; a guest waits for a host, then connects;
 *  - session, then one publish of "mic" and "cam" on one offer; changes to the session never overlap
 *    (Cloudflare needs each SDP exchange finished before the next);
 *  - what others publish is pulled (and the SFU's offer answered), and closed when they leave;
 *  - mic off stops sending AND disables the track (so a recording hears nothing);
 *  - removal and an ended room end the call and release the camera;
 *  - only a browser the join named as the recorder records, and End stops it before ending, then finalizes.
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
  async createOffer() {
    this.transceivers.forEach((t, i) => {
      if (t.mid === null) t.mid = String(i);
    });
    return { type: "offer", sdp: `offer ${this.transceivers.filter((t) => !t.stopped).map((t) => t.mid).join(",")}` };
  }
  async createAnswer() {
    return { type: "answer", sdp: "answer" };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
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
function fakeRoom(opts: { role: "host" | "guest"; records?: boolean; recordAudio?: boolean; joinDelayMs?: number; failPublishOnce?: boolean }) {
  const log: string[] = [];
  const me: Person = { id: "me", name: "Me", role: opts.role, tracks: [] };
  const others: Person[] = [];
  let hostPresent = opts.role === "host";
  let stateError: { status: number; error: string; reason?: string } | null = null;
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
        await new Promise((r) => setTimeout(r, body.action === "pull" ? 40 : 3));
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
      log.push(`host:${String(body.action)}`);
      return reply({ ok: true });
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

function controller(room: ReturnType<typeof fakeRoom>, extra: { recorder?: () => RecorderPort } = {}) {
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

  await check("removed or ended: the call ends, says who ended it only when a host did, and releases the camera", async () => {
    const cases = [
      [403, "removed", undefined, "removed"],
      [410, "room_ended", "host_ended", "host_ended"],
      [410, "room_ended", "host_left", "room_closed"],
      [410, "room_ended", undefined, "room_closed"],
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

  await check("only the browser the join names records; End stops the recorder, then ends, then finalizes", async () => {
    const events: string[] = [];
    const recorderFor = () => ({
      addTrack: ({ participantId }: { participantId: string }) => events.push(`add:${participantId}`),
      removeTrack: (participantId: string) => events.push(`remove:${participantId}`),
      stop: async () => {
        events.push("stop");
        return { sent: 3, failed: 0, segments: 2, errored: 0 };
      },
    });
    const notRecording = fakeRoom({ role: "host", records: false });
    const a = controller(notRecording, { recorder: recorderFor });
    await a.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => a.c.snapshot().phase.kind === "live");
    assert.deepEqual(events, [], "a second host never records");
    assert.equal(a.c.snapshot().recording, false);
    await leaveQuietly(a.c);

    const room = fakeRoom({ role: "host", records: true });
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
    const order = room.log.filter((l) => l === "host:end" || l.startsWith("finalize:"));
    assert.ok(events.indexOf("stop") >= 0, "the recorder was stopped");
    assert.deepEqual(order, ["host:end", 'finalize:{"sent":3,"failed":0,"segments":2,"errored":0}'], "end, then finalize with the recorder's report");
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "host_ended" });
  });

  await check("a join the room refuses is said in plain words, and nothing is held", async () => {
    const room = fakeRoom({ role: "guest" });
    const refusing = { ...room, fetchImpl: (async () => new Response(JSON.stringify({ ok: false, error: "room_full" }), { status: 409 })) as typeof fetch };
    const { c } = controller(refusing);
    const cam = new FakeTrack("video");
    await c.join({ name: "Jane", consent: true, mic: null, cam: cam as unknown as MediaStreamTrack });
    assert.deepEqual(c.snapshot().phase, { kind: "failed", error: "This meeting is full." });
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
