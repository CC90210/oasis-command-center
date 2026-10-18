/**
 * The browser side of an Oasis Meet room (lib/meet/room-client.ts), driven against a stand-in RTCPeerConnection
 * and a stand-in room API that behaves like lib/meet/handlers.ts. It holds the engine to:
 *  - a host connects at once; a guest waits for a host, then connects;
 *  - session, then one publish of "mic" and "cam" on one offer; changes to the session never overlap
 *    (Cloudflare needs each SDP exchange finished before the next);
 *  - what others publish is pulled (and the SFU's offer answered), and closed when they leave;
 *  - mic off stops sending AND disables the track (so a recording hears nothing);
 *  - removal, an ended room and a deleted one end the call and release the camera;
 *  - only the browser the room names its recorder records (its join, then every poll): one handed the recording
 *    mid-call records from then, the voices already in the call too, and one it is taken from stops without
 *    handing it over; End asks the room to end first and stops the recorder only once it has (an End that fails
 *    keeps the call recorded), then finalizes; a room that ends some other way finalizes too, and leaving only
 *    stops it; the recorder's clock is the room's, read off the quickest answer.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-room-client.test.ts
 */
import assert from "node:assert/strict";
import {
  POLL_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
  createMeetRoomController,
  meetErrorWords,
  type MeetRoomController,
  type MeetRoomOptions,
} from "../lib/meet/room-client";
import { TAB_ASK_FRESH_MS, TAB_HANDOVER_MS, browserTabs } from "../lib/meet/tabs";

let failures = 0;
let finished = false;
// A check left waiting on nothing but an unref'd timer (AbortSignal.timeout's) lets Node exit 0 mid-suite: that is a
// failure, never a pass (the same guard as tests/meet-recorder.test.ts).
process.on("beforeExit", () => {
  if (!finished) {
    console.log("meet room client: exited before every check finished");
    process.exitCode = 1;
  }
});
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
  /** `closed` reads its connection: a sender on a closed RTCPeerConnection refuses replaceTrack, as a browser's does. */
  constructor(track: FakeTrack | null, readonly direction: string, closed: () => boolean) {
    this.sender = {
      track,
      replaceTrack: async (t) => {
        if (closed()) throw new Error("InvalidStateError: the RTCPeerConnection is closed");
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
    const t = new FakeTransceiver(typeof trackOrKind === "string" ? null : trackOrKind, init.direction, () => this.closed);
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
        const t = new FakeTransceiver(null, "recvonly", () => this.closed);
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
  /** This many joins hang until the browser gives up on them (their AbortSignal), then they are taken. */
  hangJoins?: number;
  /** The room never answers a leave (a dropped network). */
  hangLeave?: boolean;
  /** What the server's clock reads on each join and poll answer (default: Date.now()). */
  serverTime?: () => number;
}) {
  let joinHangs = opts.hangJoins ?? 0;
  /** The deadline each kind of request was last sent with, by path. */
  const signals = new Map<string, AbortSignal | undefined>();
  const hang = (init: RequestInit | undefined) =>
    new Promise<never>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
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
  /** What each poll says about this browser recording the room; undefined says nothing (a server from before). */
  let recordsNow: boolean | undefined = opts.records === true;
  const serverTime = opts.serverTime ?? (() => Date.now());
  let publishFailures = opts.failPublishOnce ? 1 : 0;
  let sfuInFlight = 0;
  let overlapped = false;
  let pulledMid = 0;
  let busyWith: string | null = null;
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).replace(/^\/api\/meet\/[a-z-]+/, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    signals.set(path, init?.signal ?? undefined);
    if (path === "/join") {
      if (joinHangs > 0) {
        joinHangs -= 1;
        log.push("join:hung");
        await hang(init);
      }
      if (opts.joinDelayMs) await new Promise((r) => setTimeout(r, opts.joinDelayMs));
      if (joinRefusals > 0 && opts.refuseJoins) {
        joinRefusals -= 1;
        log.push(`join:refused:${opts.refuseJoins.error}`);
        return reply({ ok: false, error: opts.refuseJoins.error }, opts.refuseJoins.status);
      }
      log.push("join");
      return reply({
        ok: true, participantId: me.id, role: me.role, name: me.name, records: opts.records === true, serverTime: serverTime(),
        room: { code: "abc-defg-hjk", title: "Call", status: "live", recordAudio: opts.recordAudio ?? true, startedAt: null }, iceServers: [],
      });
    }
    if (path === "/state") {
      statePolls += 1;
      if (hangNextPoll) {
        hangNextPoll = false;
        log.push("state:hung");
        await hang(init);
      }
      if (stateError) return reply({ ok: false, error: stateError.error, ...(stateError.reason ? { reason: stateError.reason } : {}) }, stateError.status);
      return reply({
        ok: true,
        room: { code: "abc-defg-hjk", title: "Call", status: "live", recordAudio: opts.recordAudio ?? true, startedAt: null },
        me: { id: me.id, role: me.role, name: me.name },
        hostPresent,
        ...(recordsNow === undefined ? {} : { records: recordsNow }),
        serverTime: serverTime(),
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
      if (opts.hangLeave) await hang(init);
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
    signalOf: (path: string) => signals.get(path),
    setRecording: (v: boolean) => {
      recording = v;
    },
    /** Hand this browser the room's recording, or take it away (another host's browser has it now). */
    setRecords: (v: boolean | undefined) => {
      recordsNow = v;
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

/**
 * Node has Web Locks from 24 only (CI runs 22): there, a stand-in with the same rules is installed for the whole
 * process, so lib/meet/tabs.ts browserTabs runs unchanged on either. One holder per name; ifAvailable gets null
 * while it is held; a waiter is handed the lock straight from its holder (nobody can take it in between) and can
 * give up through its signal (an AbortError, as the browser's).
 */
function installLocksWhereMissing() {
  // MEET_TEST_STAND_IN_LOCKS=1 runs the stand-in on a Node that has its own, to check what CI runs.
  if (process.env.MEET_TEST_STAND_IN_LOCKS !== "1" && typeof navigator !== "undefined" && navigator.locks) return;
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const locks = {
    async request(name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) {
      if (held.has(name)) {
        if (options.ifAvailable) return callback(null);
        await new Promise<void>((resolve, reject) => {
          const queue = waiting.get(name) ?? [];
          waiting.set(name, queue);
          queue.push(resolve);
          options.signal?.addEventListener("abort", () => {
            const at = queue.indexOf(resolve);
            if (at < 0) return;
            queue.splice(at, 1);
            reject(new DOMException("The request was aborted.", "AbortError"));
          });
        });
      } else {
        held.add(name);
      }
      try {
        return await callback({ name, mode: "exclusive" } as Lock);
      } finally {
        const next = waiting.get(name)?.shift();
        if (next) next();
        else held.delete(name);
      }
    },
    query: async () => ({ held: [], pending: [] }),
  };
  Object.defineProperty(navigator, "locks", { value: locks, configurable: true });
}
installLocksWhereMissing();

let codes = 0;
/**
 * A room code of its own for each controller: the real browserTabs holds a Web Lock per code (Node has them), so each
 * check's tab holds its own room. The checks about two tabs of one browser pass the same `code` to both.
 */
const nextCode = () => `room-${String.fromCharCode(97 + (codes % 26))}${String.fromCharCode(97 + (Math.floor(codes++ / 26) % 26))}`;

function controller(
  room: ReturnType<typeof fakeRoom>,
  extra: Pick<MeetRoomOptions, "code" | "tabs" | "recorder" | "gatherMs" | "media" | "pollTimeoutMs" | "requestTimeoutMs" | "reconnectMs" | "deadline" | "now"> = {},
) {
  const peers: FakePeer[] = [];
  const c = createMeetRoomController({
    code: nextCode(),
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

/** The browser's connection to the SFU drops (its ICE failed, as on a network change): the controller reconnects. */
function dropLine(peers: FakePeer[]) {
  const line = peers[peers.length - 1];
  line.connectionState = "failed";
  line.dispatchEvent(new Event("connectionstatechange"));
}

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
    // The join goes out once this tab holds the room (MeetTabs); Leave comes while it is on its way.
    await waitFor("the join is on its way", () => slow.signalOf("/join") !== undefined);
    const leaving = b.c.leave();
    assert.deepEqual(b.c.snapshot().phase, { kind: "ended", reason: "left" }, "out at once, before the join answers");
    await leaving;
    await joining;
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(b.c.snapshot().phase, { kind: "ended", reason: "left" }, "the join's answer arriving after Leave does not bring the call back");
    // The place is made when the join answers, and only that answer carries the cookie a leave needs.
    assert.deepEqual(slow.log.filter((l) => l === "join" || l === "leave"), ["join", "leave"], "the room is told once the join has answered, so it frees the place");

    const refused = fakeRoom({ role: "guest", joinDelayMs: 80, refuseJoins: { times: 1, status: 409, error: "room_full" } });
    const d = controller(refused);
    const refusing = d.c.join({ name: "Jane", consent: true, mic: null, cam: null });
    await waitFor("the join is on its way", () => refused.signalOf("/join") !== undefined);
    await d.c.leave();
    await refusing;
    assert.deepEqual(d.c.snapshot().phase, { kind: "ended", reason: "left" }, "nor does a refusal arriving after Leave turn it into a failed join");

    // Leave before the join went out at all (this tab was still taking hold of the room): nothing is sent, so no
    // place is made, and no leave either.
    const early = fakeRoom({ role: "guest" });
    early.setHostPresent(true);
    const e = controller(early);
    const notYet = e.c.join({ name: "Jane", consent: true, mic: null, cam: null });
    await e.c.leave();
    await notYet;
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(early.log.filter((l) => l === "join" || l === "leave"), [], "a Leave before the join went out sends nothing");
    assert.deepEqual(e.c.snapshot().phase, { kind: "ended", reason: "left" });
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

  await check("only the browser the room names its recorder records; End asks the room first, then stops the recorder, then finalizes", async () => {
    const events: string[] = [];
    const room = fakeRoom({ role: "host", records: true });
    const recorderFor = recorderInto(room.log, events);
    const notRecording = fakeRoom({ role: "host", records: false });
    const a = controller(notRecording, { recorder: recorderFor });
    await a.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => a.c.snapshot().phase.kind === "live");
    assert.deepEqual(events, [], "a host whose browser the room does not name never records");
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

  await check("handed the recording mid-call (its recorder left or went silent), a host's browser records from then, with the voices already in the call", async () => {
    const events: string[] = [];
    const room = fakeRoom({ role: "host", records: false });
    const { c } = controller(room, { recorder: recorderInto(room.log, events) });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("the guest is heard", () => c.snapshot().tiles.some((t) => t.participantId === "g1" && t.audio));
    assert.deepEqual(events, [], "not its recorder yet: nothing is recorded");
    room.setRecords(true);
    await waitFor("recording", () => c.snapshot().recording);
    assert.deepEqual(events, ["add:me", "add:g1"], "its own microphone, and the guest who was already talking");
    room.setRecords(false);
    await waitFor("stopped", () => !c.snapshot().recording);
    assert.deepEqual(events.slice(2), ["stop"]);
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(!room.log.some((l) => l.startsWith("finalize:")), "another browser records the room now: this one hands nothing over");
    assert.equal(c.snapshot().phase.kind, "live", "and the call goes on");
    room.setRecords(true);
    await waitFor("recording again", () => events.filter((e) => e === "add:me").length === 2);
    assert.deepEqual(events.slice(3), ["add:me", "add:g1"], "a new recorder, so new segments");
    await leaveQuietly(c);
  });

  await check("handed the recording while it is still connecting, a host's browser starts recording once the call is live, not before", async () => {
    const room = fakeRoom({ role: "host", records: false, delays: { publish: 80 } });
    room.setRecords(true); // its first poll says so while the publish is still on its way
    const make = recorderInto(room.log);
    const { c } = controller(room, {
      recorder: () => {
        room.log.push("recorder:start");
        return make();
      },
    });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("recording", () => c.snapshot().recording);
    assert.ok(room.log.indexOf("sfu:publish") < room.log.indexOf("recorder:start"), room.log.join(" "));
    await leaveQuietly(c);
  });

  await check("a poll that does not say who records (a server from before this) leaves the join's answer standing", async () => {
    const { room, c } = await recordingHost();
    room.setRecords(undefined);
    const polls = room.polls();
    await waitFor("the room's poll goes on", () => room.polls() >= polls + 3);
    assert.equal(c.snapshot().recording, true);
    assert.ok(!room.log.includes("recorder:stop"));
    await leaveQuietly(c);
  });

  await check("the recorder's segment times come from the room's clock, read off the quickest answer: two hosts' recordings line up whatever their own clocks say", async () => {
    const HOUR = 3_600_000;
    // This browser's own clock, moved by the stand-in room: each answer spends `rtt` ms in transit and reads the
    // server's clock at its midpoint, `skew` ms ahead, so each reading alone puts the room's clock exactly `skew` ahead.
    let t = 5_000_000;
    let usual = { rtt: 80, skew: HOUR }; // the join, and the polls until told otherwise: a slow line
    const next: Array<{ rtt: number; skew: number }> = [];
    const room = fakeRoom({
      role: "host",
      records: true,
      serverTime: () => {
        const step = next.shift() ?? usual;
        const at = t + step.rtt / 2 + step.skew;
        t += step.rtt;
        return at;
      },
    });
    const clocks: Array<{ now: () => number }> = [];
    const make = recorderInto(room.log);
    const { c } = controller(room, {
      now: () => t,
      recorder: (clock) => {
        clocks.push(clock);
        return make();
      },
    });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("recording", () => c.snapshot().recording);
    const ahead = () => clocks[0].now() - t;
    assert.equal(ahead(), HOUR, "read off the join, 80 ms in transit");
    /** One answer read this way: a poll's request goes only once the one before was answered, so two more did. */
    const answered = async (step?: { rtt: number; skew: number }) => {
      if (step) next.push(step);
      const polls = room.polls();
      await waitFor("answered", () => next.length === 0 && room.polls() >= polls + 2);
    };
    usual = { rtt: 2, skew: HOUR + 500 };
    await answered();
    assert.equal(ahead(), HOUR + 500, "a quicker answer (2 ms) replaces it");
    // From here every poll is a little slower, with a reading of its own: one taken wrongly would stay visible.
    usual = { rtt: 3, skew: HOUR + 300 };
    await answered({ rtt: 60, skew: HOUR + 9_000 });
    assert.equal(ahead(), HOUR + 500, "a slower one never does");
    await answered({ rtt: 2, skew: HOUR + 7_000 });
    assert.equal(ahead(), HOUR + 500, "nor one no quicker");
    await answered({ rtt: 1, skew: HOUR + 600 });
    assert.equal(ahead(), HOUR + 600, "a quicker one does");
    assert.equal(clocks.length, 1, "one recorder, which reads the clock each time");
    await leaveQuietly(c);
  });

  // ONE TAB PER BROWSER (MeetTabs, on Node's own Web Locks and BroadcastChannel): two tabs of one browser share the
  // room's cookie, so they are one participant, and would cut each other's media and record the room twice.
  const mic = () => new FakeTrack("audio");
  const phaseCode = (c: MeetRoomController) => {
    const p = c.snapshot().phase;
    return p.kind === "failed" ? p.code : p.kind;
  };

  await check("a second tab of this browser is told the meeting is open in another tab: it asks the room for nothing, lets go of its microphone, and its Leave says nothing", async () => {
    const code = "tabs-told";
    const a = controller(fakeRoom({ role: "host" }), { code });
    await a.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => a.c.snapshot().phase.kind === "live");
    assert.equal(a.c.inRoom(), true);
    const roomB = fakeRoom({ role: "host" });
    const b = controller(roomB, { code });
    const handed = mic();
    await b.c.join({ consent: true, mic: handed as unknown as MediaStreamTrack, cam: null });
    assert.equal(phaseCode(b.c), "open_in_another_tab");
    assert.equal((b.c.snapshot().phase as { error?: string }).error, meetErrorWords("open_in_another_tab"));
    assert.ok(!roomB.log.includes("join"), "it asks the room for nothing");
    assert.equal(handed.readyState, "ended", "and lets go of the microphone it was handed");
    assert.equal(b.c.inRoom(), false);
    await b.c.leave();
    assert.ok(!roomB.log.includes("leave"), "a Leave from a tab that never got in says nothing: it would end the other tab's place");
    assert.equal(a.c.snapshot().phase.kind, "live", "the first tab is untouched");
    await leaveQuietly(a.c);
  });

  await check("Join here instead moves the meeting: the tab that had it ends as moved, tells the room nothing, and its recorder stops without handing over; this tab carries on and records", async () => {
    const code = "tabs-moved";
    const events: string[] = [];
    const roomA = fakeRoom({ role: "host", records: true });
    const a = controller(roomA, { code, recorder: recorderInto(roomA.log, events) });
    await a.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("recording", () => a.c.snapshot().recording);
    const roomB = fakeRoom({ role: "host", records: true });
    const b = controller(roomB, { code, recorder: recorderInto(roomB.log) });
    await b.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    assert.equal(phaseCode(b.c), "open_in_another_tab");
    await b.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null, here: true });
    await waitFor("this tab is in the call", () => b.c.snapshot().phase.kind === "live");
    assert.deepEqual(a.c.snapshot().phase, { kind: "ended", reason: "moved" });
    assert.ok(!roomA.log.includes("leave"), "the tab that had it tells the room nothing: this one carries on as the same participant");
    assert.ok(events.includes("stop"), "its recorder stopped");
    assert.ok(!roomA.log.some((l) => l.startsWith("finalize:")), "with nothing handed over: the meeting goes on");
    assert.equal(b.c.snapshot().recording, true, "and this tab records the room now");
    assert.deepEqual([a.c.inRoom(), b.c.inRoom()], [false, true]);
    await leaveQuietly(b.c);
  });

  await check("Join here instead asked for while the other tab's join is on its way waits for that join: this tab comes in as the participant it made, never as a second", async () => {
    const code = "tabs-join-on-its-way";
    const roomA = fakeRoom({ role: "host", joinDelayMs: 80 });
    const a = controller(roomA, { code });
    const joiningA = a.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("A's join is on its way", () => roomA.signalOf("/join") !== undefined);
    const roomB = fakeRoom({ role: "host" });
    const b = controller(roomB, { code });
    await b.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    assert.equal(phaseCode(b.c), "open_in_another_tab");
    const takingOver = b.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null, here: true });
    await waitFor("this tab asks the room", () => roomB.signalOf("/join") !== undefined, 3_000);
    assert.ok(roomA.log.includes("join"), "the other tab's join had answered first (its cookie is the one this join carries)");
    await takingOver;
    await joiningA;
    await waitFor("this tab is in the call", () => b.c.snapshot().phase.kind === "live");
    assert.deepEqual(a.c.snapshot().phase, { kind: "ended", reason: "moved" });
    assert.ok(!roomA.log.some((l) => l.startsWith("sfu:")), "the tab handing over set up no media it would only hand on");
    await leaveQuietly(b.c);
  });

  await check("a hand-over while an SFU step of the other tab is on its way lets go only once that step has answered: a late one would act on this tab's session", async () => {
    const code = "tabs-sfu-in-flight";
    const roomA = fakeRoom({ role: "host", delays: { pull: 300 } });
    const a = controller(roomA, { code });
    await a.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => a.c.snapshot().phase.kind === "live");
    roomA.others.push({ id: "g1", name: "Guest", role: "guest", tracks: [{ trackName: "mic", kind: "audio" }] });
    await waitFor("a pull is on its way", () => roomA.busyWith() === "pull");
    const roomB = fakeRoom({ role: "host" });
    const b = controller(roomB, { code });
    await b.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    assert.equal(phaseCode(b.c), "open_in_another_tab");
    const takingOver = b.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null, here: true });
    await waitFor("the other tab has moved on", () => a.c.snapshot().phase.kind === "ended", 3_000);
    await waitFor("this tab asks the room", () => roomB.signalOf("/join") !== undefined, 3_000);
    assert.ok(roomA.log.includes("sfu:pull"), "the other tab's pull had answered before this tab asked for anything");
    assert.ok(!roomA.log.includes("sfu:renegotiate"), "and nothing more of that tab's went to the room after it moved");
    await takingOver;
    await waitFor("this tab is in the call", () => b.c.snapshot().phase.kind === "live");
    await leaveQuietly(b.c);
  });

  await check("a call ended while it is connecting (Leave on the Connecting screen) stays ended: the connect on its way never brings it back to live", async () => {
    const room = fakeRoom({ role: "host", delays: { publish: 120 } });
    const { c } = controller(room);
    void c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("the publish is on its way", () => room.busyWith() === "publish");
    await c.leave();
    await waitFor("the publish has answered", () => room.log.some((l) => l.startsWith("publish:")));
    await new Promise((r) => setTimeout(r, 40));
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "left" });
  });

  await check("Join here instead waits longer than a fresh ask plus a join's own deadline, so the tab it asks is never left with no one in the call", () => {
    assert.ok(TAB_HANDOVER_MS > TAB_ASK_FRESH_MS + REQUEST_TIMEOUT_MS, `${TAB_HANDOVER_MS} > ${TAB_ASK_FRESH_MS} + ${REQUEST_TIMEOUT_MS}`);
    return Promise.resolve();
  });

  await check("a hand-over asked for long ago (it reached a tab frozen meanwhile) is ignored: the call goes on, since nobody is waiting to take it", async () => {
    const code = "tabs-stale-ask";
    const a = controller(fakeRoom({ role: "host" }), { code });
    await a.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => a.c.snapshot().phase.kind === "live");
    const asker = new BroadcastChannel(`oasis-meet:${code}`);
    try {
      asker.postMessage({ type: "hand-over", at: Date.now() - TAB_ASK_FRESH_MS - 1_000 });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(a.c.snapshot().phase.kind, "live", "a stale ask ends nothing");
      asker.postMessage({ type: "hand-over", at: Date.now() });
      await waitFor("a fresh ask is answered", () => a.c.snapshot().phase.kind === "ended");
      assert.deepEqual(a.c.snapshot().phase, { kind: "ended", reason: "moved" });
    } finally {
      asker.close();
    }
  });

  await check("Leave lets go of the room only once the room has heard it, so a tab joining next is never ended by it; every other ending lets go at once", async () => {
    const code = "tabs-leave";
    const roomA = fakeRoom({ role: "host", hangLeave: true });
    const a = controller(roomA, { code, requestTimeoutMs: 150 });
    await a.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => a.c.snapshot().phase.kind === "live");
    const leaving = a.c.leave();
    await waitFor("the leave is on its way", () => roomA.log.includes("leave"));
    assert.equal(await browserTabs(code).hold(), null, "the room has not heard yet: still this tab's");
    await leaving; // the leave's own deadline
    const free = await browserTabs(code).hold();
    assert.ok(free, "then another tab may have it");
    free!.release();

    const removedCode = "tabs-removed";
    const roomR = fakeRoom({ role: "host" });
    const r = controller(roomR, { code: removedCode });
    await r.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => r.c.snapshot().phase.kind === "live");
    roomR.failState(403, "removed");
    await waitFor("removed", () => r.c.snapshot().phase.kind === "ended");
    const after = await browserTabs(removedCode).hold();
    assert.ok(after, "removed: free for another tab at once");
    after!.release();
  });

  await check("Join here instead gives up when the other tab never lets go, and says the meeting is still open there", async () => {
    const code = "tabs-stuck";
    const stuck = await browserTabs(code).hold(); // a tab that holds the room and never answers
    assert.ok(stuck);
    const roomB = fakeRoom({ role: "host" });
    const b = controller(roomB, { code, tabs: browserTabs(code, 60) });
    await b.c.join({ consent: true, mic: mic() as unknown as MediaStreamTrack, cam: null, here: true });
    assert.equal(phaseCode(b.c), "open_in_another_tab");
    assert.ok(!roomB.log.includes("join"));
    stuck!.release();
  });

  await check("a browser without Web Locks keeps today's behaviour: no tab is kept out", async () => {
    const own = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", { value: undefined, configurable: true });
    try {
      const tabs = browserTabs("tabs-no-locks");
      assert.ok((await tabs.hold()) && (await tabs.hold()), "nothing to hold the room with, so nobody is kept out");
      assert.ok(await tabs.take());
    } finally {
      if (own) Object.defineProperty(navigator, "locks", own);
      else delete (navigator as { locks?: unknown }).locks;
    }
    assert.ok(navigator.locks, "and the browser's own locks are back for the checks after");
  });

  await check("without a BroadcastChannel to ask on, Join here instead still waits for the room: it gets it once the other tab closes", async () => {
    const code = "tabs-no-channel";
    const other = await browserTabs(code).hold();
    assert.ok(other);
    const channel = globalThis.BroadcastChannel;
    (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
    try {
      let settled = false;
      const taking = browserTabs(code, 500)
        .take()
        .then((held) => {
          settled = true;
          return held;
        });
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(settled, false, "it waits while the other tab holds the room: it never joins beside it");
      other!.release(); // the other tab closes
      const held = await taking;
      assert.ok(held, "and gets the room as soon as it is free");
      held!.release();
    } finally {
      globalThis.BroadcastChannel = channel;
    }
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

  await check("every call carries a deadline unless set: ten seconds for a poll, twenty for anything else", async () => {
    assert.equal(POLL_TIMEOUT_MS, 10_000, "far longer than any answer takes, far shorter than the five minutes after which a silent person has left");
    assert.equal(REQUEST_TIMEOUT_MS, 20_000, "the room's API answers in a second or two");
    const room = fakeRoom({ role: "host" });
    // What each call's deadline was made for, by the signal it was sent with.
    const madeFor = new WeakMap<AbortSignal, number>();
    const { c } = controller(room, {
      deadline: (ms) => {
        const signal = new AbortController().signal; // never fires: only the length asked for is read here
        madeFor.set(signal, ms);
        return { signal, done: () => undefined };
      },
    }); // no lengths set: the defaults
    const length = (path: string) => {
      const signal = room.signalOf(path);
      return signal ? madeFor.get(signal) : undefined;
    };
    await c.join({ consent: true, mic: null, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    await waitFor("polled", () => room.polls() >= 2);
    assert.equal(length("/state"), POLL_TIMEOUT_MS, "a poll gives up after ten seconds");
    for (const path of ["/join", "/sfu"]) assert.equal(length(path), REQUEST_TIMEOUT_MS, `${path} gives up after twenty`);
    await leaveQuietly(c);
    assert.equal(length("/leave"), REQUEST_TIMEOUT_MS, "and so does the leave");
  });

  await check("a join that never answers gives up at its deadline, and the person can try again, in a browser without AbortSignal.timeout too", async () => {
    const timeout = AbortSignal.timeout;
    for (const browser of ["today's", "without AbortSignal.timeout (Safari before 16)"]) {
      if (browser !== "today's") (AbortSignal as unknown as { timeout?: unknown }).timeout = undefined;
      try {
        const room = fakeRoom({ role: "host", hangJoins: 1 });
        const { c } = controller(room, { requestTimeoutMs: 50 });
        const joining = c.join({ consent: true, mic: null, cam: null });
        await waitFor(`${browser}: given up, not left on "Joining..."`, () => c.snapshot().phase.kind === "failed");
        await joining;
        assert.ok(room.log.includes("join:hung"), browser);
        await c.join({ consent: true, mic: null, cam: null });
        await waitFor("live", () => c.snapshot().phase.kind === "live");
        await leaveQuietly(c);
      } finally {
        (AbortSignal as unknown as { timeout: typeof timeout }).timeout = timeout;
      }
    }
  });

  await check("Leave ends the call at once, camera and all, even when the room cannot be told", async () => {
    const room = fakeRoom({ role: "host", hangLeave: true });
    const cam = new FakeTrack("video");
    const { c } = controller(room, { requestTimeoutMs: 50 });
    await c.join({ consent: true, mic: null, cam: cam as unknown as MediaStreamTrack });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    let settled = false;
    const leaving = c.leave().then(() => {
      settled = true;
    });
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "left" }, "out before the room answers");
    assert.equal(cam.readyState, "ended", "the camera is off now");
    await waitFor("the unanswered leave gives up at its deadline", () => settled);
    await leaving;
    assert.ok(room.log.includes("leave"), "the room was still told");
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

  await check("a room that no longer knows this person (silent past the room's limit) ends the call as dropped, never as left, and lets the camera go", async () => {
    const room = fakeRoom({ role: "host" });
    const cam = new FakeTrack("video");
    const { c } = controller(room);
    await c.join({ consent: true, mic: null, cam: cam as unknown as MediaStreamTrack });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    room.failState(401, "not_in_room");
    await waitFor("ended", () => c.snapshot().phase.kind === "ended");
    assert.deepEqual(c.snapshot().phase, { kind: "ended", reason: "dropped" }, "they did not leave: the page says they were disconnected");
    assert.equal(cam.readyState, "ended");
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

  await check("after the call fails, turning the microphone, camera or screen off never touches the closed connection", async () => {
    const room = fakeRoom({ role: "host" });
    const { c, peers } = controller(room, { reconnectMs: 5 });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: new FakeTrack("video") as unknown as MediaStreamTrack });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    await c.shareScreen(true);
    room.refuseSessions({ times: 1, status: 503, error: "meet_not_configured" });
    dropLine(peers);
    await waitFor("failed", () => c.snapshot().phase.kind === "failed");
    await c.setMic(false);
    await c.setCam(false);
    await c.shareScreen(false);
    assert.equal(c.snapshot().phase.kind, "failed");
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
    dropLine(peers);
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
    dropLine(peers);
    await waitFor("a new line", () => peers.length === 2 && c.snapshot().phase.kind === "live");
    const publishes = room.log.filter((l) => l.startsWith("publish:"));
    assert.match(publishes[publishes.length - 1], /^publish:mic@\d+,cam@\d+,screen@\d+$/, "the new session publishes the screen with the mic and camera");
    assert.equal(c.snapshot().sharing, true);
    await leaveQuietly(c);
  });

  await check("a share stopped from the browser's own bar during a reconnect stays stopped: the new session never sends it", async () => {
    const room = fakeRoom({ role: "host" });
    const { c, peers } = controller(room, { reconnectMs: 40 });
    await c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => c.snapshot().phase.kind === "live");
    await c.shareScreen(true);
    const screen = c.snapshot().tiles.find((t) => t.me)?.screen as unknown as FakeTrack;
    dropLine(peers);
    await waitFor("reconnecting", () => c.snapshot().notice === "Reconnecting...");
    screen.readyState = "ended"; // the person clicked the browser's "Stop sharing" while the call reconnects
    screen.dispatchEvent(new Event("ended"));
    await waitFor("a new line", () => peers.length === 2 && c.snapshot().phase.kind === "live");
    const publishes = room.log.filter((l) => l.startsWith("publish:"));
    assert.match(publishes[publishes.length - 1], /^publish:mic@\d+,cam@\d+$/, "the new session publishes no screen");
    assert.equal(c.snapshot().sharing, false);
    await leaveQuietly(c);

    // The same, with the browser's "ended" event still on its way when the new session is made.
    const early = fakeRoom({ role: "host" });
    const e = controller(early, { reconnectMs: 5 });
    await e.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => e.c.snapshot().phase.kind === "live");
    await e.c.shareScreen(true);
    const stopped = e.c.snapshot().tiles.find((t) => t.me)?.screen as unknown as FakeTrack;
    stopped.readyState = "ended";
    dropLine(e.peers);
    await waitFor("a new line", () => e.peers.length === 2 && e.c.snapshot().phase.kind === "live");
    const sent = early.log.filter((l) => l.startsWith("publish:"));
    assert.match(sent[sent.length - 1], /^publish:mic@\d+,cam@\d+$/, "a screen the browser has stopped is never sent on the new session");
    assert.equal(e.c.snapshot().sharing, false, "and the page stops saying it is shared");
    stopped.dispatchEvent(new Event("ended")); // the handler, late, finds nothing left to stop
    assert.equal(e.c.snapshot().sharing, false);
    await leaveQuietly(e.c);

    // And stopped through the call itself while it reconnects, the track still live: stopping works in every phase.
    const own = fakeRoom({ role: "host" });
    const o = controller(own, { reconnectMs: 40 });
    await o.c.join({ consent: true, mic: new FakeTrack("audio") as unknown as MediaStreamTrack, cam: null });
    await waitFor("live", () => o.c.snapshot().phase.kind === "live");
    await o.c.shareScreen(true);
    const shared = o.c.snapshot().tiles.find((t) => t.me)?.screen as unknown as FakeTrack;
    dropLine(o.peers);
    await waitFor("reconnecting", () => o.c.snapshot().notice === "Reconnecting...");
    await o.c.shareScreen(false);
    assert.equal(shared.readyState, "ended", "the share stops at once, mid-reconnect");
    await waitFor("a new line", () => o.peers.length === 2 && o.c.snapshot().phase.kind === "live");
    const out = own.log.filter((l) => l.startsWith("publish:"));
    assert.match(out[out.length - 1], /^publish:mic@\d+,cam@\d+$/, "and nothing goes out on the new session");
    await leaveQuietly(o.c);
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

  finished = true;
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
