/**
 * The render half of tests/devices-copy-guard.test.ts's DevicesEditor checks
 * (CC 2026-10-16). The suite runs under --conditions=react-server, where
 * client components cannot run their hooks, so the test spawns this file with
 * plain `node --import tsx` and asserts against the one JSON line it prints.
 * It asserts nothing itself.
 *
 * Draws "Devices (advanced)" (DevicesEditor) by its real hooks against a
 * stubbed GET /api/devices: one of the viewer's own computers last seen days
 * ago, a teammate's computer, and a revoked one, for the agents owner
 * (installRepo set) and for everyone else (installRepo null).
 */
import type { ReactElement } from "react";

type El = ReactElement<Record<string, unknown>>;
type Frames<P> = ((props: P) => El) & { unmount: () => void };

/** A component called as a plain function, frame after frame, hook slots kept between calls. useState, useRef, useEffect only. */
function framesOf<P>(component: (props: P) => unknown): Frames<P> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the CJS object whose dispatcher slot react's hooks read
  const internals = (require("react") as Record<string, { H: unknown }>).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const slots: unknown[] = [];
  const pending: Array<() => void> = [];
  const cleanups = new Map<number, () => void>();
  let cursor = 0;
  const dispatcher = {
    useState(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        slots[at] = typeof next === "function" ? (next as (prev: unknown) => unknown)(slots[at]) : next;
      };
      return [slots[at], set];
    },
    useRef(initial: unknown) {
      const at = cursor++;
      if (!(at in slots)) slots[at] = { current: initial };
      return slots[at];
    },
    useEffect(effect: () => void | (() => void), deps?: unknown[]) {
      const at = cursor++;
      const before = slots[at] as { deps?: unknown[] } | undefined;
      const changed =
        !before || !deps || !before.deps || deps.length !== before.deps.length || deps.some((d, i) => !Object.is(d, before.deps![i]));
      slots[at] = { deps };
      if (!changed) return;
      pending.push(() => {
        cleanups.get(at)?.();
        const cleanup = effect();
        if (typeof cleanup === "function") cleanups.set(at, cleanup);
        else cleanups.delete(at);
      });
    },
  };
  const frames = (props: P) => {
    cursor = 0;
    pending.length = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    let frame: El;
    try {
      frame = component(props) as El;
    } finally {
      internals.H = previous;
    }
    for (const run of pending.splice(0)) run();
    return frame;
  };
  return Object.assign(frames, {
    unmount: () => {
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
    },
  });
}

/** Every element under a node. */
function all(node: unknown): El[] {
  const found: El[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== "object" || !("props" in n)) return;
    found.push(n as El);
    walk((n as El).props.children);
  };
  walk(node);
  return found;
}

/** All the text under an element. */
function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as El).props.children);
  return "";
}

const tick = (ms = 30) => new Promise<void>((r) => setTimeout(r, ms));
const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const DAY = 24 * 60 * 60_000;

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;

  const now = Date.now();
  const stamps = {
    mineSeen: new Date(now - 5 * DAY).toISOString(),
    minePaired: new Date(now - 40 * DAY).toISOString(),
    theirsSeen: new Date(now - 20_000).toISOString(),
    theirsPaired: new Date(now - 12 * DAY).toISOString(),
    revoked: new Date(now - 3 * DAY).toISOString(),
  };
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url) !== "/api/devices") return new Response("{}", { status: 404 });
    return new Response(
      JSON.stringify({
        ok: true,
        devices: [
          { id: "p-mine", label: "CCPC", machine_fingerprint: "fp-1", last_seen_at: stamps.mineSeen, last_seen_ip: null, created_at: stamps.minePaired, revoked_at: null, mine: true },
          { id: "p-theirs", label: "Riley's laptop", machine_fingerprint: "fp-2", last_seen_at: stamps.theirsSeen, last_seen_ip: null, created_at: stamps.theirsPaired, revoked_at: null, mine: false },
          { id: "p-old", label: "Old box", machine_fingerprint: null, last_seen_at: null, last_seen_ip: null, created_at: stamps.minePaired, revoked_at: stamps.revoked, mine: true },
        ],
      }),
      { status: 200 },
    );
  }) as typeof fetch;

  const { DevicesEditor } = await import("../components/settings/DevicesEditor");
  const { timeAgo } = await import("../lib/devices/presence");

  async function draw(installRepo: string | null) {
    const frames = framesOf(DevicesEditor as (p: { installRepo: string | null }) => unknown);
    let tree = frames({ installRepo });
    for (let i = 0; i < 20 && !all(tree).some((e) => e.type === "li"); i++) {
      await tick();
      tree = frames({ installRepo });
    }
    const rows = all(tree)
      .filter((e) => e.type === "li")
      .map((li) => ({
        text: squash(textOf(li)),
        revoke: all(li.props.children).some((e) => e.type === "button" && squash(textOf(e)) === "Revoke"),
      }));
    frames.unmount();
    return rows;
  }

  console.log(
    JSON.stringify({
      owner: await draw("owner/repo"),
      notOwner: await draw(null),
      // What "Offline since" says for the same moments (lib/devices/presence.ts, the one helper).
      expected: {
        mineSeen: timeAgo(stamps.mineSeen),
        minePaired: timeAgo(stamps.minePaired),
        theirsPaired: timeAgo(stamps.theirsPaired),
        revoked: timeAgo(stamps.revoked),
      },
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
