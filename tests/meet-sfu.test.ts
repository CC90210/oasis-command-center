/**
 * Oasis Meet's calls to Cloudflare (lib/meet/sfu.ts, lib/meet/ice.ts): the exact requests the room API sends to
 * the Realtime SFU and the TURN service, checked against Cloudflare's Connection API (OpenAPI
 * realtime-api-2024-05-21: sessions/new, tracks/new local and remote, renegotiate, tracks/close with `force`
 * required, GET session) and its TURN credentials call. The room tests stand a fake in for this client, so this
 * file is what proves the real one is right.
 *
 * Run: node --conditions=react-server --import tsx tests/meet-sfu.test.ts
 */
import assert from "node:assert/strict";
import { MeetNotConfiguredError } from "../lib/meet/access";
import { STUN_ONLY, meetIceServers } from "../lib/meet/ice";
import { SFU_BASE, SfuError, cutSession, settledMids, sfuClient } from "../lib/meet/sfu";

let failures = 0;
async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 6).join("\n        ")}`);
  }
}

type Sent = { url: string; method: string; auth: string | null; type: string | null; body: unknown };

/** A fetch that records each request and answers from a queue. */
function recorder(answers: Array<{ status?: number; body?: unknown; throws?: Error }>) {
  const sent: Sent[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: headers.get("authorization"),
      type: headers.get("content-type"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = answers.shift() ?? { body: {} };
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 });
  }) as typeof fetch;
  return { impl, sent };
}

const ENV = { CF_REALTIME_APP_ID: "app123", CF_REALTIME_APP_SECRET: "secret-xyz" };
const offer = { type: "offer" as const, sdp: "v=0 offer" };
const answer = { type: "answer" as const, sdp: "v=0 answer" };

async function main() {
  console.log("meet sfu:");

  await check("no app set: the client refuses to exist (the routes answer 503)", async () => {
    assert.throws(() => sfuClient({}), MeetNotConfiguredError);
    assert.throws(() => sfuClient({ CF_REALTIME_APP_ID: "app123" }), MeetNotConfiguredError);
  });

  await check("a session: POST /apps/<app>/sessions/new with the app secret as a bearer, no body", async () => {
    const { impl, sent } = recorder([{ status: 201, body: { sessionId: "S1" } }]);
    assert.equal(await sfuClient(ENV, impl).newSession(), "S1");
    assert.deepEqual(sent[0], { url: `${SFU_BASE}/apps/app123/sessions/new`, method: "POST", auth: "Bearer secret-xyz", type: "application/json", body: undefined });
    const { impl: none } = recorder([{ status: 201, body: {} }]);
    await assert.rejects(sfuClient(ENV, none).newSession(), (e: unknown) => e instanceof SfuError && e.code === "sfu_no_session");
  });

  await check("publish: the browser's offer and local tracks by mid and name; the answer comes back", async () => {
    const { impl, sent } = recorder([{ body: { sessionDescription: answer, tracks: [{ trackName: "mic", mid: "0" }, { trackName: "cam", mid: "1", errorCode: "x", errorDescription: "y" }] } }]);
    const res = await sfuClient(ENV, impl).publish("S 1/x", offer, [{ mid: "0", trackName: "mic" }, { mid: "1", trackName: "cam" }]);
    assert.equal(sent[0].url, `${SFU_BASE}/apps/app123/sessions/S%201%2Fx/tracks/new`, "a session id is a path segment, encoded");
    assert.equal(sent[0].method, "POST");
    assert.deepEqual(sent[0].body, {
      sessionDescription: offer,
      tracks: [{ location: "local", mid: "0", trackName: "mic" }, { location: "local", mid: "1", trackName: "cam" }],
    });
    assert.deepEqual(res.sessionDescription, answer);
    assert.equal(res.requiresImmediateRenegotiation, false);
    assert.equal(res.tracks[1].errorCode, "x", "a per-track error is handed back, never thrown");
  });

  await check("pull: remote tracks by publisher session and name, with no SDP; the SFU's offer comes back", async () => {
    const { impl, sent } = recorder([{ body: { requiresImmediateRenegotiation: true, sessionDescription: { type: "offer", sdp: "sfu" }, tracks: [{ location: "remote", sessionId: "P", trackName: "mic", mid: "3" }] } }]);
    const res = await sfuClient(ENV, impl).pull("S1", [{ sessionId: "P", trackName: "mic" }]);
    assert.deepEqual(sent[0].body, { tracks: [{ location: "remote", sessionId: "P", trackName: "mic" }] });
    assert.ok(!("sessionDescription" in (sent[0].body as object)));
    assert.equal(res.requiresImmediateRenegotiation, true);
    assert.deepEqual(res.sessionDescription, { type: "offer", sdp: "sfu" });
    assert.equal(res.tracks[0].mid, "3");
  });

  await check("renegotiate: PUT the browser's answer; close: PUT the mids with force set, an offer only when negotiated", async () => {
    const { impl, sent } = recorder([{ body: {} }, { body: { tracks: [{ mid: "3" }] } }, { body: { sessionDescription: answer, tracks: [] } }]);
    const sfu = sfuClient(ENV, impl);
    await sfu.renegotiate("S1", answer);
    assert.deepEqual(sent[0], { url: `${SFU_BASE}/apps/app123/sessions/S1/renegotiate`, method: "PUT", auth: "Bearer secret-xyz", type: "application/json", body: { sessionDescription: answer } });
    await sfu.close("S1", ["3"]);
    assert.equal(sent[1].url, `${SFU_BASE}/apps/app123/sessions/S1/tracks/close`);
    assert.equal(sent[1].method, "PUT");
    assert.deepEqual(sent[1].body, { tracks: [{ mid: "3" }], force: true }, "forced: no SDP, and force is always sent (it is required)");
    const res = await sfu.close("S1", ["4"], offer);
    assert.deepEqual(sent[2].body, { tracks: [{ mid: "4" }], force: false, sessionDescription: offer });
    assert.deepEqual(res.sessionDescription, answer);
  });

  await check("a session's tracks: GET /sessions/<id>", async () => {
    const { impl, sent } = recorder([{ body: { tracks: [{ location: "local", mid: "0", trackName: "mic", status: "active" }] } }]);
    const tracks = await sfuClient(ENV, impl).sessionTracks("S1");
    assert.equal(sent[0].method, "GET");
    assert.equal(sent[0].url, `${SFU_BASE}/apps/app123/sessions/S1`);
    assert.equal(tracks[0].status, "active");
  });

  await check("failures are thrown with what went wrong: the SFU's own code, an HTTP status, or no answer at all", async () => {
    const { impl } = recorder([
      { status: 400, body: { errorCode: "invalid_request", errorDescription: "bad sdp" } },
      { status: 200, body: { errorCode: "session_error", errorDescription: "gone" } },
      { status: 503, body: {} },
      { throws: new TypeError("network down") },
    ]);
    const sfu = sfuClient(ENV, impl);
    const code = async (p: Promise<unknown>) => p.then(() => "resolved", (e: unknown) => (e instanceof SfuError ? `${e.code}:${e.status ?? "-"}` : `other:${String(e)}`));
    assert.equal(await code(sfu.newSession()), "invalid_request:400");
    assert.equal(await code(sfu.renegotiate("S1", answer)), "session_error:200", "an errorCode on a 200 is still a failure");
    assert.equal(await code(sfu.newSession()), "sfu_http_503:503");
    assert.equal(await code(sfu.newSession()), "sfu_unreachable:-");
  });

  await check("cutting a session closes every active track by force; it says whether anything is left to cut, and a failure is logged, never thrown", async () => {
    const calls: string[] = [];
    const fake = {
      sessionTracks: async () => [
        { mid: "0", status: "active" }, { mid: "1", status: "inactive" }, { mid: "r2", status: "active" }, { status: "active" },
      ],
      close: async (_s: string, mids: string[], offerArg?: unknown) => {
        calls.push(`${mids.join(",")}|${offerArg === undefined ? "forced" : "negotiated"}`);
        // One closed now, one already gone: both settled.
        return { sessionDescription: null, tracks: [{ mid: "0" }, { mid: "r2", errorCode: "close_track_error" }] };
      },
    } as unknown as Parameters<typeof cutSession>[0];
    assert.equal(await cutSession(fake, "S1", "test"), true);
    assert.deepEqual(calls, ["0,r2|forced"], "sent and received tracks alike; already closed ones skipped");
    assert.equal(await cutSession(fake, null, "test"), true, "no session, nothing to cut");
    const failing = (err: Error) => ({ sessionTracks: async () => { throw err; } }) as unknown as Parameters<typeof cutSession>[0];
    const errors = console.error;
    console.error = () => {}; // the failures below are logged on purpose
    try {
      assert.equal(await cutSession(failing(new SfuError("sfu_unreachable", "down")), "S1", "test"), false, "the SFU did not answer: the caller keeps the session to try again");
      assert.equal(await cutSession(failing(new SfuError("sfu_http_500", "the SFU answered 500", 500)), "S1", "test"), false);
    } finally {
      console.error = errors;
    }
    assert.equal(await cutSession(failing(new SfuError("session_not_found", "gone", 404)), "S1", "test"), true, "a session the SFU no longer has carries no media");
    const closing = (tracks: Array<{ mid?: string; errorCode?: string }>) =>
      ({ ...fake, close: async () => ({ sessionDescription: null, tracks }) }) as unknown as Parameters<typeof cutSession>[0];
    const closeFails = { ...fake, close: async () => { throw new SfuError("sfu_http_502", "bad gateway", 502); } } as unknown as Parameters<typeof cutSession>[0];
    console.error = () => {};
    try {
      assert.equal(await cutSession(closeFails, "S1", "test"), false, "tracks it could not close are still to cut");
      assert.equal(await cutSession(closing([{ mid: "0" }, { mid: "r2", errorCode: "internal_error" }]), "S1", "test"), false, "a 200 that carries a failed track is not a cut");
      assert.equal(await cutSession(closing([{ mid: "0" }]), "S1", "test"), false, "nor one that leaves a track unreported");
    } finally {
      console.error = errors;
    }
    assert.deepEqual([...settledMids({ tracks: [{ mid: "0" }, { mid: "1", errorCode: "close_track_error" }, { mid: "2", errorCode: "internal_error" }, { errorCode: "x" }] })], ["0", "1"]);
  });

  await check("TURN: credentials minted from the key per join, port 53 dropped; unset or down falls back to STUN", async () => {
    assert.deepEqual(await meetIceServers({}, (() => { throw new Error("must not be called"); }) as unknown as typeof fetch), STUN_ONLY);
    const { impl, sent } = recorder([{ status: 201, body: { iceServers: [
      { urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turn:turn.cloudflare.com:53?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    ] } }]);
    const servers = await meetIceServers({ CF_TURN_KEY_ID: "key1", CF_TURN_KEY_API_TOKEN: "tok" }, impl);
    assert.equal(sent[0].url, "https://rtc.live.cloudflare.com/v1/turn/keys/key1/credentials/generate-ice-servers");
    assert.equal(sent[0].method, "POST");
    assert.equal(sent[0].auth, "Bearer tok");
    assert.deepEqual(sent[0].body, { ttl: 43_200 });
    assert.deepEqual(servers, [
      { urls: ["stun:stun.cloudflare.com:3478"] },
      { urls: ["turn:turn.cloudflare.com:3478?transport=udp", "turns:turn.cloudflare.com:443?transport=tcp"], username: "u", credential: "c" },
    ]);
    const down = recorder([{ status: 500, body: {} }]);
    assert.deepEqual(await meetIceServers({ CF_TURN_KEY_ID: "key1", CF_TURN_KEY_API_TOKEN: "tok" }, down.impl), STUN_ONLY);
    const unreachable = recorder([{ throws: new TypeError("offline") }]);
    assert.deepEqual(await meetIceServers({ CF_TURN_KEY_ID: "key1", CF_TURN_KEY_API_TOKEN: "tok" }, unreachable.impl), STUN_ONLY);
  });

  if (failures) {
    console.error(`meet sfu: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("meet sfu: all checks passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
