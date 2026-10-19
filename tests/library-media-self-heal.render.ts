/**
 * useSignedSrc driven frame by frame (tests/library-media-self-heal.test.ts runs this).
 *
 * WHY A SEPARATE PROCESS. The suite runs with `--conditions=react-server`, where React has no client hooks; this is
 * spawned with plain `node --import tsx`, as tests/library-phone-preview.render.ts is, and drives the hook with the
 * same kind of minimal dispatcher (useState and useRef; anything else fails loudly). The network is a stubbed fetch.
 */
import assert from "node:assert/strict";

import { MEDIA_FAILED_TEXT, useSignedSrc } from "../components/founders/SignedMedia";

type Hook = ReturnType<typeof useSignedSrc>;

function driver() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
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
  };
  return (src: string | null): Hook => {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      return useSignedSrc(src);
    } finally {
      internals.H = previous;
    }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function main() {
  const asked: string[] = [];
  let answer: (url: string) => Promise<Response> = async () => Response.json({ ok: true, url: "https://fresh" });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const url = (JSON.parse(String(init?.body)) as { url: string }).url;
    asked.push(url);
    return answer(url);
  }) as typeof fetch;

  // An expired link: one request, the fresh link rendered, no failure.
  const frame = driver();
  let h = frame("https://old");
  assert.deepEqual([h.src, h.failed], ["https://old", false]);
  h.onError();
  await settle();
  h = frame("https://old");
  assert.deepEqual([h.src, h.failed], ["https://fresh", false], "the element retries with the fresh link");
  assert.deepEqual(asked, ["https://old"]);
  // The fresh link fails too: it gives up, with no second request.
  h.onError();
  h = frame("https://old");
  assert.equal(h.failed, true, "a second failure is the plain line");
  assert.deepEqual(asked, ["https://old"], "only ONE retry per link");

  // A new link (the next slide) starts over; the same link back means the object, not the signature, is broken.
  answer = async (url) => Response.json({ ok: true, url });
  h = frame("https://slide-2");
  assert.deepEqual([h.src, h.failed], ["https://slide-2", false]);
  h.onError();
  await settle();
  h = frame("https://slide-2");
  assert.equal(h.failed, true, "nothing fresher to try");

  // The route refusing, or the network failing, is the plain line, never a throw.
  answer = async () => new Response("no", { status: 404 });
  const other = driver();
  h = other("https://theirs");
  h.onError();
  await settle();
  assert.equal(other("https://theirs").failed, true);
  // No link at all: nothing to retry and nothing to report.
  const none = driver();
  none(null).onError();
  await settle();
  assert.equal(none(null).failed, false);

  assert.equal(MEDIA_FAILED_TEXT, "Couldn't load this. Reload the page.");
  console.log("library-media-self-heal.render: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
