/**
 * useSignedSrc and useSignedVideo driven frame by frame (tests/library-media-self-heal.test.ts runs this).
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`, where React has no client hooks; this is
 * spawned with plain `node --import tsx`, as tests/library-phone-preview.render.ts is, and drives the hooks with the
 * same kind of minimal dispatcher (useState, useRef and useEffect; anything else fails loudly). The network is a
 * stubbed fetch whose answers the test releases in the order it chooses.
 */
import assert from "node:assert/strict";

import { MEDIA_FAILED_TEXT, useSignedSrc, useSignedVideo } from "../components/founders/SignedMedia";

function driver<T>(hook: () => T) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const effectDeps: Array<unknown[] | undefined> = [];
  let queued: Array<() => unknown> = [];
  let cursor = 0;
  const dispatcher = {
    useState(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [slots[at], (next: unknown) => (slots[at] = typeof next === "function" ? (next as (p: unknown) => unknown)(slots[at]) : next)];
    },
    useRef(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect: () => unknown, deps?: unknown[]) {
      const at = cursor++;
      const prev = effectDeps[at];
      const changed = !(at in effectDeps) || !deps || !prev || deps.length !== prev.length || deps.some((d, i) => !Object.is(d, prev[i]));
      effectDeps[at] = deps;
      if (changed) queued.push(effect);
    },
  };
  return {
    render(): T {
      cursor = 0;
      const previous = internals.H;
      internals.H = dispatcher;
      try {
        return hook();
      } finally {
        internals.H = previous;
      }
    },
    effects() {
      const run = queued;
      queued = [];
      for (const effect of run) effect();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  const asked: string[] = [];
  const held = new Map<string, (res: Response) => void>();
  let mode: "answer" | "hold" = "answer";
  let answer: (url: string) => Promise<Response> = async () => Response.json({ ok: true, url: "https://fresh" });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = (JSON.parse(String(init?.body)) as { url: string }).url;
    asked.push(url);
    if (mode === "hold") return new Promise<Response>((resolve) => held.set(url, resolve));
    return answer(url);
  }) as typeof fetch;
  const release = async (url: string, fresh: string) => {
    held.get(url)!(Response.json({ ok: true, url: fresh }));
    await settle();
  };

  // An expired link: one request, the fresh link rendered, no failure.
  let src: string | null = "https://old";
  const frame = driver(() => useSignedSrc(src));
  let h = frame.render();
  assert.deepEqual([h.src, h.failed], ["https://old", false]);
  h.onError();
  await settle();
  h = frame.render();
  assert.deepEqual([h.src, h.failed], ["https://fresh", false], "the element retries with the fresh link");
  assert.deepEqual(asked, ["https://old"]);
  // The fresh link fails too: it gives up, with no second request.
  h.onError();
  h = frame.render();
  assert.equal(h.failed, true, "a second failure is the plain line");
  assert.deepEqual(asked, ["https://old"], "only ONE retry per link");

  // A new link (the next slide) starts over; the same link back means the object, not the signature, is broken.
  answer = async (url) => Response.json({ ok: true, url });
  src = "https://slide-2";
  h = frame.render();
  assert.deepEqual([h.src, h.failed], ["https://slide-2", false]);
  h.onError();
  await settle();
  assert.equal(frame.render().failed, true, "nothing fresher to try");

  // Two slides of ONE element whose renewals settle out of order: each keeps its own answer (CodeRabbit on #706).
  mode = "hold";
  const carousel = driver(() => useSignedSrc(src));
  src = "https://slide-a";
  carousel.render().onError();
  src = "https://slide-b";
  carousel.render().onError();
  await release("https://slide-b", "https://slide-b-fresh");
  await release("https://slide-a", "https://slide-a-fresh");
  assert.equal(carousel.render().src, "https://slide-b-fresh", "A's late answer does not overwrite B's");
  src = "https://slide-a";
  assert.deepEqual([carousel.render().src, carousel.render().failed], ["https://slide-a-fresh", false]);

  // The old link failing again while its renewal is on the way waits for it, never counts as the retry failing
  // (Codex on #706: the viewer went to B and back to A before A's answer came).
  src = "https://slide-c";
  const again = driver(() => useSignedSrc(src));
  again.render().onError();
  again.render().onError();
  await release("https://slide-c", "https://slide-c-fresh");
  assert.deepEqual([again.render().src, again.render().failed], ["https://slide-c-fresh", false]);
  assert.equal(asked.filter((u) => u === "https://slide-c").length, 1);
  mode = "answer";

  // The route refusing, or the network failing, is the plain line, never a throw.
  answer = async () => new Response("no", { status: 404 });
  src = "https://theirs";
  const other = driver(() => useSignedSrc(src));
  other.render().onError();
  await settle();
  assert.equal(other.render().failed, true);
  // No link at all: nothing to retry and nothing to report.
  src = null;
  const none = driver(() => useSignedSrc(src));
  none.render().onError();
  await settle();
  assert.equal(none.render().failed, false);

  // A video whose link expired while it played: the renewed link plays on from the same second (CodeRabbit on #706).
  answer = async (url) => Response.json({ ok: true, url: `${url}-fresh` });
  const media = { currentTime: 12, plays: 0, play() {
    this.plays += 1;
    return Promise.resolve();
  } };
  let refused = 0;
  const vsrc = "https://reel";
  const player = driver(() => useSignedVideo(vsrc, () => media as unknown as HTMLVideoElement, () => (refused += 1)));
  let v = player.render();
  player.effects();
  v.onPlay();
  v.onError();
  media.currentTime = 0; // the failing element has reset
  await settle();
  v = player.render();
  player.effects();
  assert.equal(v.src, "https://reel-fresh");
  assert.deepEqual([media.plays, media.currentTime, refused], [1, 12, 0], "plays on from where it failed");
  // A viewer who paused is not started by a renewal; the pause a failing link causes does not count as theirs.
  const still = { currentTime: 5, plays: 0, play() {
    this.plays += 1;
    return Promise.resolve();
  } };
  const paused = driver(() => useSignedVideo("https://clip", () => still as unknown as HTMLVideoElement));
  let p = paused.render();
  paused.effects();
  p.onPlay();
  p.onPause({ currentTarget: { error: null } });
  p.onError();
  await settle();
  p = paused.render();
  paused.effects();
  assert.deepEqual([p.src, still.plays, still.currentTime], ["https://clip-fresh", 0, 5]);
  const failing = { currentTime: 3, plays: 0, play() {
    this.plays += 1;
    return Promise.resolve();
  } };
  const broken = driver(() => useSignedVideo("https://cut", () => failing as unknown as HTMLVideoElement));
  let b = broken.render();
  broken.effects();
  b.onPlay();
  b.onPause({ currentTarget: { error: { code: 2 } } });
  b.onError();
  await settle();
  b = broken.render();
  broken.effects();
  assert.equal(failing.plays, 1, "a pause caused by the failure keeps the wish to play");

  assert.equal(MEDIA_FAILED_TEXT, "Couldn't load this. Reload the page.");
  console.log("library-media-self-heal.render: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
