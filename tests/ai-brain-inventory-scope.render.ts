/**
 * The render half of tests/ai-brain-inventory-scope.test.ts (CC 2026-10-16).
 * The suite runs under --conditions=react-server, where client components
 * cannot run their hooks, so the test spawns this file with plain
 * `node --import tsx` and asserts against the one JSON line it prints. It
 * asserts nothing itself.
 *
 * Three client components, drawn by their real hooks (useState, useRef,
 * useEffect) frame after frame against a stubbed fetch that answers every
 * screen from the same GET /api/ai/engine and GET /api/devices bodies:
 *   - Settings > AI brain (AgentEnginePanel): the "Choose your own" button for
 *     a person who inherits the workspace default, pressed, and what it moves
 *     to; the words each app reads under "Installed apps and local models";
 *     and each computer card's presence word.
 *   - Settings > Devices (YourComputersCard): the app lines under each of the
 *     same computers, the row lines, and whether Team computers starts open.
 *   - Devices (advanced) (DevicesEditor): each pairing's presence badge.
 */
import { dirname } from "node:path";
import type { ReactElement } from "react";

function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

type El = ReactElement<Record<string, unknown>> & { ref?: unknown };
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

const PROTOCOLS = ["runtime_action_v1", "department_task_v2", "coding_harness_task_v1"];
const NOW = Date.now();
const runtime = (over: Record<string, unknown> = {}) => ({
  installed: false,
  signedIn: false,
  executionReady: false,
  unsupported: false,
  version: null,
  lastTestedAt: null,
  code: null,
  ...over,
});
const device = (pairingId: string, label: string, over: Record<string, unknown>, runtimes: Record<string, unknown>) => ({
  pairingId,
  label,
  ownerName: null,
  ownedByViewer: true,
  workspaceEligible: false,
  agentClaimEligible: true,
  os: "windows",
  lastSeenAt: new Date(NOW - 10_000).toISOString(),
  approved: true,
  online: true,
  busy: false,
  protocols: PROTOCOLS,
  localModels: [],
  ...over,
  runtimes: { claude: runtime(), codex: runtime(), gemini: runtime(), ...runtimes },
});

/**
 * One client workspace (so Codex is refused by the rollout gate on both
 * screens), four of the viewer's own computers, each app in a different state.
 */
const DEVICES = [
  device("p-studio", "Studio PC", {}, {
    claude: runtime({ installed: true, signedIn: true, executionReady: true }),
    codex: runtime({ installed: true, signedIn: true }),
  }),
  device("p-mac", "Old Mac", {}, {
    claude: runtime({ installed: true, signedIn: true }),
    gemini: runtime({ installed: true, signedIn: false, code: "auth_required" }),
  }),
  device("p-laptop", "Laptop", { approved: false }, {
    claude: runtime({ installed: true }),
  }),
  device("p-tower", "Tower", { online: false, lastSeenAt: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString() }, {
    claude: runtime({ installed: true, signedIn: true }),
  }),
];

const engineBody = (personEngine: Record<string, unknown>) => ({
  ok: true,
  engine: { mode: "api", provider: "anthropic" },
  engineVersion: "v-1",
  engineVersions: { workspace: "v-1", person: null },
  personEngine,
  devices: DEVICES,
  account: null,
  savedProviders: [],
  savedKeyReceipts: {},
  bridge: { reachable: true },
  workspace: "client",
  canManage: false,
});

/** Stamped when the page asks (module compile time would otherwise age "checked 5 s ago"). */
const deviceRow = (id: string, label: string, mine: boolean, over: Record<string, unknown> = {}, now = Date.now()) => ({
  id,
  user_id: mine ? "u-me" : "u-riley",
  label,
  last_seen_at: new Date(now - 10_000).toISOString(),
  revoked_at: null,
  scope: "connector",
  paired_via: "connector",
  claim_enabled_at: new Date(now - 60_000).toISOString(),
  claim_state_at: new Date(now - 5_000).toISOString(),
  claim_blocked_reason: null,
  claim_capacity: 1,
  mine,
  owner_name: mine ? null : "Riley",
  ...over,
});

async function main() {
  const React = await import("react");
  (globalThis as unknown as { React: typeof React }).React = React;
  stub("next/navigation", {
    useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
    usePathname: () => "/settings/ai",
    useSearchParams: () => new URLSearchParams(),
  });

  // The panel listens for account changes on window; nothing here dispatches one.
  (globalThis as unknown as { window: unknown }).window = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };

  let personEngine: Record<string, unknown> = { source: "workspace", selection: null };
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    seen.push(`${method} ${u}`);
    if (u === "/api/ai/engine" && method === "GET") return new Response(JSON.stringify(engineBody(personEngine)), { status: 200 });
    if (u === "/api/devices" && method === "GET") {
      return new Response(
        JSON.stringify({
          ok: true,
          devices: [
            deviceRow("p-studio", "Studio PC", true),
            deviceRow("p-mac", "Old Mac", true),
            deviceRow("p-laptop", "Laptop", true, { claim_enabled_at: null, paired_via: "connector" }),
            deviceRow("p-tower", "Tower", true, { last_seen_at: new Date(NOW - 3 * 24 * 60 * 60_000).toISOString(), claim_state_at: null }),
            deviceRow("p-riley", "Riley's laptop", false),
            // Two of a teammate's computers not approved yet: their Team computers rows print the heartbeat's
            // word, one online and one idle (5 minutes), for the three-screen presence check.
            deviceRow("p-riley-desk", "Riley's desktop", false, { claim_enabled_at: null, claim_state_at: null }),
            deviceRow("p-riley-old", "Riley's old PC", false, { claim_enabled_at: null, claim_state_at: null, last_seen_at: new Date(Date.now() - 5 * 60_000).toISOString() }),
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  const { AgentEnginePanel } = await import("../components/settings/AgentEnginePanel");
  const { YourComputersCard } = await import("../components/settings/YourComputersCard");
  const { DevicesEditor } = await import("../components/settings/DevicesEditor");

  // ── Settings > AI brain ──────────────────────────────────────────────────
  async function drawPanel() {
    const frames = framesOf(AgentEnginePanel as (p: { children?: unknown }) => unknown);
    let tree = frames({});
    for (let i = 0; i < 20 && !all(tree).some((e) => e.props["data-testid"] === "agent-engine"); i++) {
      await tick();
      tree = frames({});
    }
    return { frames, tree };
  }

  const inherited = await drawPanel();
  const panelEls = all(inherited.tree);
  const chooseOwn = panelEls.find((e) => e.type === "button" && e.props["data-testid"] === "engine-choose-own");
  const group = panelEls.find((e) => e.props.role === "radiogroup" && e.props["aria-label"] === "AI runtime type");
  const radios = group ? all(group.props.children).filter((e) => e.type === "input" && e.props.type === "radio") : [];
  // A stand-in for the mounted radiogroup: its radios are the ones this frame drew.
  const pressed: { scrolled: unknown; focused: string | null; focusOptions: unknown } = { scrolled: null, focused: null, focusOptions: null };
  const groupRef = (group?.props.ref ?? group?.ref) as { current: unknown } | undefined;
  const asNode = (radio: El | undefined) =>
    radio
      ? {
          focus: (opts: unknown) => {
            pressed.focused = String(radio.props.value);
            pressed.focusOptions = opts;
          },
        }
      : null;
  if (groupRef && typeof groupRef === "object") {
    groupRef.current = {
      scrollIntoView: (opts: unknown) => {
        pressed.scrolled = opts ?? true;
      },
      querySelector: (selector: string) =>
        selector.includes(":checked") ? asNode(radios.find((r) => r.props.checked === true)) : asNode(radios[0]),
    };
  }
  if (chooseOwn) (chooseOwn.props.onClick as () => void)();
  const inUseLine = squash(textOf(panelEls.find((e) => e.type === "p" && textOf(e).includes("In use for"))));
  const inheritedNote = squash(textOf(panelEls.find((e) => e.type === "p" && textOf(e).includes("workspace default."))));

  // The inventory: one card per computer, one status line per app, in order.
  const statuses = panelEls.filter((e) => e.props["data-testid"] === "engine-inventory-status").map((e) => squash(textOf(e)));
  const apps = ["Claude Code", "Codex", "Gemini CLI"];
  const aiBrain: Record<string, Record<string, string>> = {};
  DEVICES.forEach((d, i) => {
    aiBrain[String(d.label)] = Object.fromEntries(apps.map((app, j) => [app, statuses[i * apps.length + j]]));
  });
  // Each computer card's own presence word, in the same order.
  const presences = panelEls.filter((e) => e.props["data-testid"] === "engine-device-presence").map((e) => squash(textOf(e)));
  const aiBrainPresence: Record<string, string> = Object.fromEntries(DEVICES.map((d, i) => [String(d.label), presences[i]]));
  inherited.frames.unmount();

  // The same panel for a person who chose their own setup: no button.
  personEngine = { source: "person", selection: { mode: "api", provider: "anthropic" } };
  const own = await drawPanel();
  const ownEls = all(own.tree);
  const ownHasButton = ownEls.some((e) => e.props["data-testid"] === "engine-choose-own");
  const ownInherited = ownEls.some((e) => e.props["data-testid"] === "engine-inherited");
  own.frames.unmount();

  // ── Settings > Devices ───────────────────────────────────────────────────
  const card = framesOf(YourComputersCard as () => unknown);
  let cardTree = card(undefined as never);
  for (let i = 0; i < 20 && !all(cardTree).some((e) => e.type === "li"); i++) {
    await tick();
    cardTree = card(undefined as never);
  }
  const cardEls = all(cardTree);
  const devices: Record<string, { row: string; apps: Record<string, string> }> = {};
  for (const li of cardEls.filter((e) => e.type === "li")) {
    const lines = all(li.props.children)
      .filter((e) => e.type === "div" && typeof e.props.children === "string")
      .map((e) => String(e.props.children));
    const row = lines.find((l) => / · /.test(l));
    if (!row) continue;
    const label = row.split(" · ")[0];
    const appLines = lines.filter((l) => /^(Claude Code|Codex|Gemini CLI): /.test(l));
    devices[label] = {
      row,
      apps: Object.fromEntries(appLines.map((l) => [l.slice(0, l.indexOf(": ")), l.slice(l.indexOf(": ") + 2)])),
    };
  }
  const team = cardEls.find((e) => e.type === "details" && textOf(all(e.props.children).find((c) => c.type === "summary")).startsWith("Team computers"));
  const teamRows = team ? all(team.props.children).filter((e) => e.type === "li").map((e) => squash(textOf(e))) : [];
  const caption = squash(textOf(cardEls.find((e) => e.props["data-testid"] === "signed-in-caption")));
  card.unmount();

  // ── Settings > Devices (advanced): the same pairings, each row's presence badge ──
  const advanced = framesOf(DevicesEditor as (p: { installRepo: string | null }) => unknown);
  let advancedTree = advanced({ installRepo: null });
  for (let i = 0; i < 20 && !all(advancedTree).some((e) => e.type === "li"); i++) {
    await tick();
    advancedTree = advanced({ installRepo: null });
  }
  const advancedPresence: Record<string, string> = {};
  for (const li of all(advancedTree).filter((e) => e.type === "li")) {
    const els = all(li.props.children);
    const label = els.find((e) => e.type === "span" && typeof e.props.title === "string");
    const badge = els.find((e) => e.props["data-testid"] === "device-presence");
    if (label && badge) advancedPresence[String(label.props.title)] = squash(textOf(badge));
  }
  advanced.unmount();

  console.log(
    JSON.stringify({
      panel: {
        chooseOwnPresent: Boolean(chooseOwn),
        chooseOwnText: chooseOwn ? squash(textOf(chooseOwn)) : null,
        radiogroupHasRef: Boolean(groupRef),
        radios: radios.map((r) => ({ value: r.props.value, checked: r.props.checked === true })),
        pressed,
        inUseLine,
        inheritedNote,
        ownHasButton,
        ownInherited,
      },
      aiBrain,
      aiBrainPresence,
      advancedPresence,
      devices,
      team: { present: Boolean(team), open: team ? team.props.open === true : null, rows: teamRows },
      caption,
      fetched: [...new Set(seen)],
    }),
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
