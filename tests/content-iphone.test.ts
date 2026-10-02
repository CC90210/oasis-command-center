/**
 * tests/content-iphone.test.ts - tap any video in Content and it opens in a big
 * iPhone; Content says only what is true.
 * Run: node --conditions=react-server --import tsx tests/content-iphone.test.ts
 *
 * WHY THIS EXISTS
 * CC, 2026-10-01: "when I click on it and make it big screen, it turns into a
 * big iPhone." The Library drew every asset in a phone (W8a) with no way to
 * make it big. And the Content pages described buttons that do not exist
 * ("ask for changes, or reject"; a delete that "can be restored"; "drop links
 * in the Train tab" to fill the Library), named the marketing agent by its
 * internal name and the posting service by its vendor's, hid every channel
 * that went quiet, and drew LinkedIn as "0 views" beside the impressions it
 * reports (MKT-07, MKT-09, MKT-10, MKT-17, MKT-18, MKT-19; D16).
 *
 * WHAT IS PINNED
 *  1. Every Library tile, both views, every kind, opens the big phone: an
 *     Enlarge button named for the asset, and a video's play press too - and
 *     still no <video> in any tile (tests/content-iphone.render.ts draws them).
 *  2. The big phone is a modal dialog, drawn and DRIVEN: Close takes focus,
 *     Tab and Shift+Tab stay inside, Esc / Close / a click outside close it,
 *     focus goes back to the button that opened it, the page behind is held
 *     still, motion only without reduced motion, and its size fits 1280x800
 *     and 390x844.
 *  3. Nothing loads until play: opened by Enlarge, a video is a cover; opened
 *     by a play press, it mounts preload="none" and plays once; a video
 *     playing in place carries on from the same second and stops in place.
 *  4. Performance lists every connected channel: a quiet one with how long
 *     ago it last posted, one with none on record, an unknown said as
 *     unknown, and LinkedIn measured in impressions.
 *  5. No persona, plumbing or vendor name in any string a Content page can put
 *     on the screen; the copy says only what the buttons do; Music and
 *     Requests are gone; no duplicate "Back to Content".
 *  6. The asset page, rendered against a local database through the real
 *     founder gate: "Made by" is the role, the copy card names no agent, and
 *     the preview sits in PhoneEnlarge with an Enlarge control.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ReactNS from "react";
import ts from "typescript";
import { createClient } from "@libsql/client";

const ROOT = join(__dirname, "..");
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const CC = { id: "0f000000-0000-4000-8000-000000000001", email: "conaugh@oasisai.work" };

// The asset page's database: a local libSQL file, the real founder gate.
const dbFile = join(mkdtempSync(join(tmpdir(), "content-iphone-")), "test.db");
process.env.EMPIRE_DATA_BACKEND = "turso_cloud";
process.env.TURSO_DB_PATH = dbFile;
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_DB_URL;
process.env.EMPIRE_AUTH_BACKEND = "turso";
process.env.AUTH_SESSION_SECRET = "content-iphone-test-secret-long-enough-01";
process.env.FOUNDERS_TENANT_IDS = OASIS;
delete process.env.OPERATOR_EMAIL;
delete process.env.OPERATOR_EMAIL_FALLBACK_ENABLED;

let failed = 0;
let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n       ")}`);
  }
}

const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
/** Source without comments. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
const attr = (tag: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const textOfHtml = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

/**
 * Every string a file can put on the screen: JSX text, string literals and
 * template parts, parsed (a comment is never copy). Skipped: console.* calls
 * (the server log), import specifiers, and className values (styling).
 */
function screenText(file: string): string[] {
  const src = read(file);
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "console") return;
    if (ts.isImportDeclaration(n)) return;
    if (ts.isJsxAttribute(n) && ts.isIdentifier(n.name) && n.name.text === "className") return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) {
      out.push(n.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Internal names and plumbing: never on a Content screen (build rules; MKT-10). */
const INTERNAL = /\bMaven\b|send[ _]gateway|kill ?switch|post_queue|\bZernio\b|brand_slug|with provenance|\bTurso\b|\bSupabase\b/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(name)) out.push(rel);
  }
  return out;
}

const CONTENT_FILES = [
  ...walk("app/founders/marketing"),
  ...[
    "marketing-shared.tsx",
    "AssetActions.tsx",
    "AssetPublishPanel.tsx",
    "PhoneEnlarge.tsx",
    "PhoneFrame.tsx",
    "TileVideo.tsx",
    "CarouselFrame.tsx",
    "SlideReorder.tsx",
    "ContentTabs.tsx",
    "TrainDropzone.tsx",
  ].map((f) => `components/founders/${f}`),
];

// -- the render process ------------------------------------------------------
type Drawn = {
  tiles: Record<string, string>;
  enlarge: {
    closedMarkup: string;
    closedPortal: boolean;
    openMarkup: string;
    bigSlot: unknown;
    afterOpen: { focused: string | null; bodyOverflow: string; keydownListeners: number; container: boolean };
    tab: { prevented: boolean; landed: string };
    shiftTab: { prevented: boolean; landed: string };
    strayTab: { prevented: boolean; landed: string };
    esc: { prevented: boolean; openAfter: boolean };
    afterClose: { triggerCalls: string[]; focused: string | null; bodyOverflow: string; keydownListeners: number };
    openAfterPhoneClick: boolean;
    openAfterBackdropClick: boolean;
    openAfterCloseButton: boolean;
    bigPhoneWidth: string;
  };
  handover: { start: unknown; inlineCalls: string[]; pausedStart: unknown; pausedCalls: string[] };
  player: {
    tileMount: string;
    tileAfterPress: string;
    asked: Array<{ start: unknown; opener: string | null }>;
    bigPlayMount: string;
    bigPlayCalls: string[];
    bigCoverMount: string;
    bigCoverCallsBeforePress: string[];
    bigCoverAfterPress: string;
    bigCoverCalls: string[];
    pageCarry: { calls: string[]; at: number };
    pageStillMount: string;
    pageWait: { calls: string[]; at: number };
  };
};

function drawn(): Drawn {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/content-iphone.render.ts"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    throw new Error(`tests/content-iphone.render.ts exited ${r.status}`);
  }
  return JSON.parse(r.stdout) as Drawn;
}

// -- the asset page, server-rendered -----------------------------------------
(globalThis as unknown as { React: typeof ReactNS }).React = ReactNS;
let sessionCookie: string | undefined;
function stub(request: string, exports: Record<string, unknown>) {
  const p = require.resolve(request);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
function stubFile(file: string, exports: Record<string, unknown>) {
  const p = join(ROOT, file);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}
stub("next/headers", {
  cookies: async () => ({
    get: (name: string) => (name === "oasis_session" && sessionCookie ? { name, value: sessionCookie } : undefined),
    getAll: () => (sessionCookie ? [{ name: "oasis_session", value: sessionCookie }] : []),
    has: (name: string) => name === "oasis_session" && Boolean(sessionCookie),
    set: () => undefined,
  }),
  headers: async () => new Headers(),
});
stub("next/navigation", {
  notFound: () => {
    throw new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  },
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT;${url}`);
  },
  usePathname: () => "/founders/marketing/asset/m1",
  useRouter: () => ({ push: () => undefined, refresh: () => undefined, prefetch: () => undefined, replace: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
});
stub("next/link", {
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
    ReactNS.createElement("a", { href, ...rest }, children as ReactNS.ReactNode),
});
// The client components the page renders draw in the browser, not here (their
// hooks do not exist under react-server). Each is a marked element carrying
// its props, so the page's wiring can be read; their own behaviour is
// tests/content-iphone.render.ts's.
const enlargeCalls: Array<Record<string, unknown>> = [];
stubFile("components/founders/PhoneEnlarge.tsx", {
  PhoneEnlarge: (p: Record<string, unknown>) => {
    enlargeCalls.push(p);
    return ReactNS.createElement("phone-enlarge", { "data-title": p.title }, p.children as ReactNS.ReactNode);
  },
  EnlargeButton: (p: { title: string }) => ReactNS.createElement("enlarge-button", { "data-title": p.title }),
  enlargeSlotContext: () => null,
});
for (const [file, name] of [
  ["components/founders/TileVideo.tsx", "TileVideo"],
  ["components/founders/CarouselFrame.tsx", "CarouselFrame"],
  ["components/founders/AssetActions.tsx", "AssetActions"],
  ["components/founders/AssetPublishPanel.tsx", "AssetPublishPanel"],
  ["components/founders/SlideReorder.tsx", "SlideReorder"],
] as const) {
  stubFile(file, { [name]: () => ReactNS.createElement(`stub-${name.toLowerCase()}`) });
}

type Host = { type: string; props: Record<string, unknown> & { children?: unknown } };
async function resolve(node: unknown): Promise<unknown> {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string" || typeof node === "number") return node;
  if (Array.isArray(node)) return Promise.all(node.map((n) => resolve(n)));
  if (typeof node !== "object" || !("type" in node)) return null;
  const el = node as { type: unknown; props: Record<string, unknown> };
  if (el.type === ReactNS.Fragment || el.type === ReactNS.Suspense) return resolve(el.props.children);
  if (typeof el.type === "function") return resolve(await (el.type as (p: unknown) => unknown)(el.props));
  if (typeof el.type === "object") return { type: "icon", props: {} };
  return { type: el.type, props: { ...el.props, children: await resolve(el.props.children) } };
}
const hosts = (n: unknown): Host[] =>
  Array.isArray(n) ? n.flatMap(hosts) : n && typeof n === "object" && "props" in n ? [n as Host, ...hosts((n as Host).props.children)] : [];
const textOf = (n: unknown): string =>
  typeof n === "string" || typeof n === "number"
    ? String(n)
    : Array.isArray(n)
      ? n.map(textOf).join(" ")
      : n && typeof n === "object" && "props" in n
        ? textOf((n as Host).props.children)
        : "";

async function main() {
  console.log("content-iphone");
  const d = drawn();
  const BIG_PHONE_WIDTH = d.enlarge.bigPhoneWidth;

  // -- 1. every tile opens the big phone -------------------------------------
  await check("every Library tile, both views, every kind, has an Enlarge control named for it; a video's play press opens the big phone too", () => {
    const names = Object.keys(d.tiles);
    assert.equal(names.length, 10, `five kinds in two views: ${names.join(", ")}`);
    for (const [name, html] of Object.entries(d.tiles)) {
      const enlarge = tags(html, "button").filter((b) => attr(b, "aria-label") === "Enlarge Asset title");
      assert.equal(enlarge.length, 1, `${name}: one Enlarge control`);
      assert.equal(attr(enlarge[0], "aria-haspopup"), "dialog", `${name}: it says it opens a dialog`);
      assert.equal(tags(html, "video").length, 0, `${name}: a <video> before anyone pressed play`);
      assert.ok(!/role="dialog"/.test(html), `${name}: the big phone is not drawn until it is opened`);
      assert.doesNotMatch(textOfHtml(html), INTERNAL, `${name}: an internal name on the tile`);
    }
    for (const name of ["videoPoster:phone", "videoPoster:grid", "videoBare:phone", "videoBare:grid"]) {
      const play = tags(d.tiles[name], "button").filter((b) => attr(b, "aria-label") === "Play Asset title");
      assert.equal(play.length, 1, `${name}: the cover is a named play button`);
      assert.equal(attr(play[0], "aria-haspopup"), "dialog", `${name}: pressing play opens the big phone`);
    }
    assert.match(d.tiles["carousel:phone"], /aria-roledescription="carousel"/, "the carousel still pages in place");
    // The phone view's control is a labelled button; the plain grid's sits on the card's corner.
    assert.match(d.tiles["videoPoster:phone"], /<button[^>]*aria-label="Enlarge Asset title"[^>]*>.*?Enlarge<\/button>/);
    assert.match(d.tiles["videoPoster:grid"], /<button[^>]*class="absolute bottom-2 left-2[^"]*"[^>]*aria-label="Enlarge Asset title"|<button[^>]*aria-label="Enlarge Asset title"[^>]*class="absolute bottom-2 left-2/);
  });

  // -- 2. the big phone ------------------------------------------------------
  await check("Enlarge opens a modal big phone: a named dialog in a portal on <body>, Close, the asset in its phone frame, motion only without reduced motion", () => {
    const e = d.enlarge;
    assert.equal(e.closedPortal, false, "closed: no big phone in the page");
    assert.match(e.closedMarkup, /aria-label="Enlarge Asset title"/, "closed: the control is there");
    const html = e.openMarkup;
    const dialog = tags(html, "div").find((t) => attr(t, "role") === "dialog");
    assert.ok(dialog, "a dialog");
    assert.equal(attr(dialog!, "aria-modal"), "true");
    assert.equal(attr(dialog!, "aria-label"), "Asset title, enlarged");
    assert.match(attr(dialog!, "class") ?? "", /\bfixed inset-0\b/, "it covers the screen");
    assert.match(attr(dialog!, "class") ?? "", /motion-safe:animate-fade-in/, "fades in only without reduced motion");
    assert.ok(e.afterOpen.container, "drawn into document.body, above every stacking context");
    assert.equal(tags(html, "button").filter((b) => attr(b, "aria-label") === "Close").length, 1, "a Close button");
    assert.ok(html.includes("data-phone-frame"), "the big phone is the PhoneFrame");
    assert.match(html, /aspect-ratio:9 \/ 19\.5/, "a 9:19.5 screen");
    assert.match(html, /Asset title, as it shows on a phone/);
    assert.match(html, /The hook line/, "with the asset's caption");
    assert.ok(html.includes(`class="${BIG_PHONE_WIDTH} motion-safe:animate-slide-up"`), "sized to the screen; rises only without reduced motion");
    assert.equal(tags(html, "video").length, 0, "opened by Enlarge: no <video> until play is pressed");
    assert.match(html, /aria-label="Play Asset title"/, "the video waits behind its play button");
    assert.deepEqual(e.bigSlot, { place: "big", start: { play: false, at: 0 } });
    assert.doesNotMatch(textOfHtml(html), INTERNAL);
  });

  await check("keyboard: Close takes focus, Tab and Shift+Tab stay inside, Esc closes, and focus returns to the Enlarge button", () => {
    const e = d.enlarge;
    assert.equal(e.afterOpen.focused, "close", "focus moves into the dialog, onto Close");
    assert.equal(e.afterOpen.bodyOverflow, "hidden", "the page behind does not scroll");
    assert.equal(e.afterOpen.keydownListeners, 1);
    assert.deepEqual(e.tab, { prevented: true, landed: "close" }, "Tab on the last control wraps to the first");
    assert.deepEqual(e.shiftTab, { prevented: true, landed: "play" }, "Shift+Tab on the first wraps to the last");
    assert.deepEqual(e.strayTab, { prevented: true, landed: "close" }, "focus outside the dialog is pulled back in");
    assert.deepEqual(e.esc, { prevented: true, openAfter: false }, "Esc closes it");
    assert.deepEqual(e.afterClose.triggerCalls, ["focus"], "focus goes back to the button that opened it");
    assert.equal(e.afterClose.focused, "enlarge-button");
    assert.equal(e.afterClose.bodyOverflow, "", "the page scrolls again");
    assert.equal(e.afterClose.keydownListeners, 0, "and its key listener is gone");
  });

  await check("a click outside the phone or on Close closes it; a click on the phone does not", () => {
    assert.equal(d.enlarge.openAfterPhoneClick, true, "a click on the phone is the phone's");
    assert.equal(d.enlarge.openAfterBackdropClick, false, "a click on the dark area closes it");
    assert.equal(d.enlarge.openAfterCloseButton, false, "Close closes it");
  });

  await check("the big phone fits the screen: the full height from sm up, the width (with room for Close) on a phone", () => {
    // The frame's height over its width: a 9:19.5 screen inside a bezel of
    // 2.6% of the width on every side (components/founders/PhoneFrame.tsx).
    const frame = read("components/founders/PhoneFrame.tsx");
    assert.match(frame, /p-\[2\.6cqw\]/);
    assert.match(frame, /aspectRatio: "9 \/ 19\.5"/);
    const ratio = (1 - 2 * 0.026) * (19.5 / 9) + 2 * 0.026;
    assert.ok(Math.abs(ratio - 2.106) < 0.001, `frame ratio ${ratio}`);
    const m = /^w-\[min\(calc\(100vw-(\d+(?:\.\d+)?)rem\),calc\(\(100dvh-(\d+(?:\.\d+)?)rem\)\/(\d+(?:\.\d+)?)\)\)\] sm:w-\[min\(calc\(100vw-(\d+(?:\.\d+)?)rem\),calc\(\(100dvh-(\d+(?:\.\d+)?)rem\)\/(\d+(?:\.\d+)?)\)\)\]$/.exec(BIG_PHONE_WIDTH);
    assert.ok(m, `the width classes parse: ${BIG_PHONE_WIDTH}`);
    const [, baseW, baseH, baseD, smW, smH, smD] = m!.map(Number);
    assert.ok(baseD >= ratio && smD >= ratio, "never taller than the space it is given");
    const size = (vw: number, vh: number) => {
      const sm = vw >= 640;
      const w = sm ? Math.min(vw - smW * 16, (vh - smH * 16) / smD) : Math.min(vw - baseW * 16, (vh - baseH * 16) / baseD);
      return { w: Math.round(w), h: Math.round(w * ratio) };
    };
    const desk = size(1280, 800);
    assert.deepEqual(desk, { w: 356, h: 751 }, "1280x800: as tall as the screen, less the padding");
    assert.ok(desk.h <= 800 - 2 * 24, "inside sm:p-6");
    const laptop = size(1280, 720);
    assert.deepEqual(laptop, { w: 318, h: 671 });
    const phone = size(390, 844);
    assert.deepEqual(phone, { w: 347, h: 731 }, "390x844: nearly the whole screen");
    assert.ok(phone.w <= 390 - 32, "inside p-4");
    assert.ok((844 - phone.h) / 2 >= 12 + 40, "the gap above the phone holds Close (top 0.75rem, 2.5rem tall)");
    const small = size(360, 640);
    assert.ok(small.w <= 360 - 32 && small.h <= 640 - 7 * 16 + 1, `a small phone: ${JSON.stringify(small)}`);
  });

  // -- 3. nothing loads until play -------------------------------------------
  await check("in a tile the play press opens the big phone and mounts nothing in place; there it mounts preload=none and plays once", () => {
    const p = d.player;
    assert.equal(tags(p.tileMount, "video").length, 0);
    assert.match(p.tileMount, /aria-haspopup="dialog"/);
    assert.equal(tags(p.tileAfterPress, "video").length, 0, "the press mounted a <video> in the tile");
    assert.deepEqual(p.asked, [{ start: { play: true, at: 0 }, opener: "cover" }], "it asked the big phone to play, from the start, and named its opener");
    const big = tags(p.bigPlayMount, "video");
    assert.equal(big.length, 1, "opened by a play press, the player is there");
    assert.equal(attr(big[0], "preload"), "none", "and loads nothing before play() asks");
    assert.deepEqual(p.bigPlayCalls, ["play"], "played once");
  });

  await check("opened by Enlarge, a video is a cover until play; the asset page's player opens where it was, playing only if it was", () => {
    const p = d.player;
    assert.equal(tags(p.bigCoverMount, "video").length, 0, "a cover, not a player");
    assert.deepEqual(p.bigCoverCallsBeforePress, []);
    const opened = tags(p.bigCoverAfterPress, "video");
    assert.equal(opened.length, 1);
    assert.equal(attr(opened[0], "preload"), "none");
    assert.deepEqual(p.bigCoverCalls, ["play"]);
    assert.deepEqual(p.pageCarry, { calls: ["play"], at: 12.5 }, "carried on from 12.5s, playing");
    assert.equal(attr(tags(p.pageStillMount, "video")[0], "preload"), "metadata", "the asset page's own rule: its first frame");
    assert.deepEqual(p.pageWait, { calls: [], at: 9 }, "paused at 9s stays paused, at 9s");
  });

  await check("a video playing in place carries on in the big phone from the same second, and stops in place", () => {
    assert.deepEqual(d.handover.start, { play: true, at: 12.5 });
    assert.deepEqual(d.handover.inlineCalls, ["pause"], "two never play at once");
    assert.deepEqual(d.handover.pausedStart, { play: false, at: 9 });
    assert.deepEqual(d.handover.pausedCalls, [], "a paused one is left alone");
  });

  await check("wiring: both Library views and the asset page draw the big phone; nothing in it can preload a Library video", () => {
    const shared = code("components/founders/marketing-shared.tsx");
    assert.equal((shared.match(/<PhoneEnlarge\b/g) ?? []).length, 2, "the phone tile and the plain card");
    assert.match(shared, /const bigMedia = phone \? media : <TileMedia \{\.\.\.mediaProps\} phone \/>;/, "the big phone always gets the phone's media");
    assert.match(shared, /<EnlargeButton title=\{title\} corner \/>/);
    assert.match(shared, /<EnlargeButton title=\{title\} \/>/);
    const page = code("app/founders/marketing/asset/[id]/page.tsx");
    assert.match(page, /<PhoneEnlarge title=\{asset\.title\} frame=\{phoneShape\} media=\{phoneScreen\}/);
    assert.match(page, /<EnlargeButton title=\{asset\.title\} \/>/);
    const enlarge = code("components/founders/PhoneEnlarge.tsx");
    assert.doesNotMatch(enlarge, /<video\b|preload=|initialOpen/, "the big phone draws the caller's media and nothing else");
    assert.match(enlarge, /if \(!slotContext\) slotContext = createContext/, "the context is made on first use, not at import (react-server has no createContext)");
  });

  // -- 4. Performance: every connected channel -------------------------------
  const core = await import("../lib/founders-performance-core");
  const { PUBLISH_CHANNELS } = await import("../lib/founders/publish-targets");
  const connected = PUBLISH_CHANNELS.map((c) => c.id);
  const now = new Date("2026-10-02T12:00:00Z");
  const iso = (daysAgo: number) => new Date(now.getTime() - daysAgo * 86_400_000).toISOString();
  const row = (platform: string, over: Record<string, unknown> = {}) => ({
    platform_post_id: `${platform}-${Math.random()}`,
    platform,
    account_username: null,
    asset_id: null,
    impressions: 0,
    views: 0,
    likes: 0,
    comments: 0,
    shares: 0,
    saves: 0,
    clicks: 0,
    follows: 0,
    engagement_rate: 0,
    avg_watch_s: null,
    duration_s: null,
    content_excerpt: null,
    published_at: iso(1),
    last_synced_at: iso(0),
    ...over,
  });
  const inWindow = core.summarize({
    data: [
      row("instagram", { views: 1000, impressions: 1000, likes: 10 }),
      row("linkedin", { views: 3, impressions: 257, likes: 4 }),
      row("threads", { views: 50, impressions: 50, published_at: iso(20) }),
    ],
  });
  const lastPosted = {
    instagram: iso(1),
    linkedin: iso(1),
    threads: iso(20),
    tiktok: iso(42),
    youtube: iso(42),
  };

  await check("Performance lists every connected channel: a quiet one with how long ago it last posted, none on record said so", () => {
    const rows = core.channelRows({ ...inWindow, lastPosted }, connected, now);
    assert.deepEqual(rows.map((r) => r.platform), ["instagram", "linkedin", "threads", "tiktok", "youtube", "twitter"], "active by reach, then the quiet ones in connected order");
    const by = Object.fromEntries(rows.map((r) => [r.platform, r]));
    assert.equal(by.tiktok.posts, 0);
    assert.equal(by.tiktok.lastPostedDays, 42);
    assert.equal(core.channelNote(by.tiktok), "Last posted 42 days ago", "the quiet channel says how long");
    assert.equal(core.channelNote(by.youtube), "Last posted 42 days ago");
    assert.equal(by.twitter.lastPostedDays, null);
    assert.equal(core.channelNote(by.twitter), "No post on record yet", "never posted: said so, not a made-up zero");
    assert.equal(core.channelNote(by.threads), "Last posted 20 days ago", "posted in the window, but quiet for more than two weeks");
    assert.equal(core.channelNote(by.instagram), null, "an active channel needs no line");
    assert.equal(core.QUIET_AFTER_DAYS, 14);
  });

  await check("LinkedIn's bar uses impressions; the shares are of each channel's own measure", () => {
    const rows = core.channelRows({ ...inWindow, lastPosted }, connected, now);
    const by = Object.fromEntries(rows.map((r) => [r.platform, r]));
    assert.equal(core.reachMetric("linkedin"), "impressions");
    assert.equal(core.reachMetric("instagram"), "views");
    assert.equal(by.linkedin.metric, "impressions");
    assert.equal(by.linkedin.reach, 257, "257 impressions, not 3 views");
    assert.equal(by.instagram.reach, 1000);
    const total = 1000 + 257 + 50;
    assert.ok(Math.abs(by.linkedin.share - 257 / total) < 1e-9, `share ${by.linkedin.share}`);
    assert.equal(by.tiktok.share, 0);
  });

  await check("when the all-time read failed: channels in the window still know their last post; the others say they could not check", () => {
    const rows = core.channelRows({ ...inWindow, lastPosted: null }, connected, now);
    const by = Object.fromEntries(rows.map((r) => [r.platform, r]));
    assert.equal(by.instagram.lastPostedDays, 1);
    assert.equal(by.threads.lastPostedDays, 20);
    assert.equal(by.tiktok.lastPostedDays, undefined);
    assert.equal(core.channelNote(by.tiktok), "Couldn't check when it last posted", "unknown, never 'none'");
    assert.equal(core.channelNote(by.twitter), "Couldn't check when it last posted");
  });

  await check("the Performance page draws every channel row, the note under it, and the metric's own word", () => {
    const page = code("app/founders/marketing/performance/page.tsx");
    assert.match(page, /const channels = channelRows\(perf, PUBLISH_CHANNELS\.map\(\(c\) => c\.id\)\);/);
    assert.match(page, /\{channels\.map\(\(c\) => \{/);
    assert.match(page, /const note = channelNote\(c\);/);
    assert.match(page, /\{nf\.format\(c\.reach\)\} \{c\.metric\}/);
    assert.doesNotMatch(page, /byPlatform\.map/, "not one bar per platform that happened to post");
    // Not hidden behind "posted this month": a month of silence is when it matters.
    const channelCard = page.indexOf("{!perf.degraded && channels.length > 0 && (");
    assert.ok(channelCard > 0, "the channel card is gated on a good read, not on posts");
    const queries = code("lib/founders/performance-queries.ts");
    assert.match(queries, /await Promise\.all\(\[/, "the two reads run side by side");
    assert.match(queries, /MAX\(published_at\) AS last_posted/);
    assert.match(queries, /WHERE tenant_id = \? AND published_at IS NOT NULL/, "scoped to the tenant");
    assert.match(queries, /GROUP BY platform/, "one row per channel");
  });

  // -- 5. the copy says what is true -----------------------------------------
  await check("no persona, plumbing or vendor name in any string a Content page can show", () => {
    assert.ok(CONTENT_FILES.length >= 18, `walked ${CONTENT_FILES.length} files`);
    const hits: string[] = [];
    for (const f of CONTENT_FILES) {
      for (const s of screenText(f)) if (INTERNAL.test(s)) hits.push(`${f}: ${s.trim().slice(0, 120)}`);
    }
    assert.deepEqual(hits, []);
    // Not vacuous: the scan finds what it is looking for where it is.
    assert.ok(screenText("app/founders/marketing/library/page.tsx").some((s) => /daily poster/.test(s)));
  });

  await check("'Made by' says the role, never the agent's internal name", async () => {
    const { madeByLabel } = await import("../lib/founders-marketing-core");
    assert.equal(madeByLabel("maven"), "Marketing agent");
    assert.equal(madeByLabel("maven-codex"), "Marketing agent");
    assert.equal(madeByLabel("MAVEN"), "Marketing agent");
    assert.equal(madeByLabel("human"), null, "a person's asset: 'Added by' already names who");
    assert.equal(madeByLabel(null), null);
    assert.equal(madeByLabel("bravo"), "An AI agent", "any other agent: its kind, not its name");
  });

  await check("D16: no Music tab (its slug files under Personal, never under Clients); no Requests card or count", async () => {
    const m = await import("../lib/founders-marketing-core");
    assert.deepEqual(m.BRAND_GROUPS.map((g) => g.label), ["OASIS AI", "Personal", "Clients"]);
    assert.equal(m.brandGroupFor("nostalgic-requests"), "conaugh", "a music asset lands in Personal");
    for (const g of m.BRAND_GROUPS) assert.doesNotMatch(g.empty, INTERNAL, `${g.label}: ${g.empty}`);
    const overview = code("app/founders/marketing/page.tsx");
    assert.doesNotMatch(overview, /RequestsCard|title="Requests"|open_requests/, "the Requests card and its half of the count are gone");
    assert.match(overview, /const withAgent = summary\.open_reviews;/);
    assert.match(overview, /grid grid-cols-2 gap-4 lg:grid-cols-3/, "three brand tiles, three columns");
  });

  await check("the copy describes only buttons that exist", () => {
    const overview = screenText("app/founders/marketing/page.tsx").join(" | ");
    assert.doesNotMatch(overview, /ask for changes|reject it|request changes/i, "there is no such button");
    assert.match(overview, /Approve or archive each one; archived items can be restored\./);
    assert.match(overview, /approved, not posted/);
    assert.match(overview, /queued by the poster/);
    assert.doesNotMatch(overview, /ready to book|"booked"/);
    const library = screenText("app/founders/marketing/library/page.tsx").join(" | ");
    assert.match(library, /New content appears here when the marketing agent or the daily poster adds it\./);
    assert.doesNotMatch(library, /Drop links/, "training material never adds to the Library");
    const actions = screenText("components/founders/AssetActions.tsx").join(" | ");
    assert.match(actions, /for good\? It cannot be undone\. Archive keeps it, and it can be restored\./);
    assert.match(actions, /Archive instead/);
    assert.match(actions, /Deleted\. It is gone from the Library for good\./);
    assert.doesNotMatch(actions, /Deleted\.[^|]*restored/, "a delete never claims it can be undone");
    const panel = screenText("components/founders/AssetPublishPanel.tsx").join(" | ");
    assert.match(panel, /Posts go out one at a time, within daily limits, and every post is logged\./);
  });

  await check("one way back: no 'Back to Content' under the Content tabs; cut-off text carries a title", () => {
    for (const f of ["app/founders/marketing/library/page.tsx", "app/founders/marketing/performance/page.tsx"]) {
      assert.ok(!screenText(f).some((s) => /Back to Content/.test(s)), `${f}: a second way back under the tabs`);
    }
    const shared = code("components/founders/marketing-shared.tsx");
    assert.match(shared, /href=\{assetHref\(id, returnTo\)\}\s+title=\{title\}\s+className="[^"]*line-clamp-2/, "the clamped title");
    assert.match(shared, /<p title=\{hook\} className="[^"]*line-clamp-2/, "the clamped hook");
    assert.match(code("components/founders/PhoneFrame.tsx"), /<p title=\{text\} className="[^"]*line-clamp-6/, "the text post's six lines");
    const perf = code("app/founders/marketing/performance/page.tsx");
    assert.match(perf, /<td title=\{r\.content_excerpt \|\| undefined\} className="max-w-\[22rem\] truncate/);
    assert.match(perf, /<div title=\{r\.content_excerpt \|\| undefined\} className="truncate/);
  });

  // -- 6. the asset page, rendered -------------------------------------------
  await check("the asset page, through the real gate: 'Made by: Marketing agent', no agent name, and the preview in PhoneEnlarge", async () => {
    const raw = createClient({ url: `file:${dbFile}` });
    await raw.executeMultiple(`
      CREATE TABLE "_supabase_auth_users" (id TEXT PRIMARY KEY, email TEXT NOT NULL,
        session_version INTEGER NOT NULL DEFAULT 0, banned_until TEXT, deleted_at TEXT);
      CREATE TABLE user_profiles (id TEXT PRIMARY KEY, auth_user_id TEXT, email TEXT, tenant_id TEXT,
        team_role TEXT, is_owner INTEGER DEFAULT 0, admin_access INTEGER DEFAULT 0,
        onboarding_completed_at TEXT, full_name TEXT, display_name TEXT, updated_at TEXT);
      CREATE TABLE marketing_asset (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, title TEXT NOT NULL, hook TEXT, body TEXT,
        cta TEXT, landing_url TEXT, brand_slug TEXT NOT NULL, brand_name TEXT, track TEXT, channel TEXT, status TEXT NOT NULL,
        format TEXT, aspect TEXT, duration_s REAL, asset_type TEXT, slide_count INTEGER, media_urls TEXT, platforms TEXT,
        author_email TEXT, author_agent TEXT, campaign TEXT, published_at TEXT, created_at TEXT);
      CREATE TABLE marketing_asset_media (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, kind TEXT,
        storage_bucket TEXT, storage_path TEXT, mime TEXT, bytes INTEGER, width INTEGER, height INTEGER, label TEXT);
      CREATE TABLE marketing_review (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL, acted_on_at TEXT);
      CREATE TABLE marketing_publish_intent (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, asset_id TEXT NOT NULL,
        state TEXT NOT NULL, platforms TEXT, created_at TEXT NOT NULL);
    `);
    await raw.batch(
      [
        { sql: `INSERT INTO "_supabase_auth_users" (id, email) VALUES (?, ?)`, args: [CC.id, CC.email] },
        {
          sql: `INSERT INTO user_profiles (id, auth_user_id, email, tenant_id, team_role, is_owner, onboarding_completed_at, full_name, display_name, updated_at)
                VALUES ('p-cc', ?, ?, ?, 'owner', 1, '2026-09-01T00:00:00Z', 'CC', 'CC', '2026-09-01T00:00:00Z')`,
          args: [CC.id, CC.email, OASIS],
        },
        {
          sql: `INSERT INTO marketing_asset (id, tenant_id, title, hook, body, cta, brand_slug, brand_name, track, channel, status, format,
                  aspect, asset_type, platforms, author_email, author_agent, created_at)
                VALUES ('m1', ?, 'Spring reel', 'Your inbox, handled', 'Body copy', 'Book a call', 'oasis-ai', 'OASIS AI', 'organic',
                  'organic-tiktok', 'in_review', 'copy', '9:16', 'single_image', '["tiktok"]', ?, 'maven-codex', '2026-09-30T00:00:00Z')`,
          args: [OASIS, CC.email],
        },
      ],
      "write",
    );
    const { signSession } = await import("../lib/turso-auth");
    sessionCookie = signSession({ sub: CC.id, email: CC.email, exp: Math.floor(Date.now() / 1000) + 3600, ver: 0 });
    const { default: AssetPage } = await import("../app/founders/marketing/asset/[id]/page");
    const render = async (sp: Record<string, string>) => {
      enlargeCalls.length = 0;
      const tree = await resolve(await AssetPage({ params: Promise.resolve({ id: "m1" }), searchParams: Promise.resolve(sp) }));
      return { tree, text: textOf(tree), calls: [...enlargeCalls] };
    };

    const phone = await render({});
    assert.match(phone.text, /Made by\s+Marketing agent/, "the role, from maven-codex");
    assert.match(phone.text, /The words that go out with it/);
    assert.match(phone.text, /Posted from OASIS's connected accounts/);
    assert.doesNotMatch(phone.text, INTERNAL, `an internal name on the asset page: ${phone.text.match(INTERNAL)?.[0]}`);
    assert.equal(phone.calls.length, 1, "one big phone for the preview");
    const props = phone.calls[0] as { title: string; frame: Record<string, unknown>; media: { type: unknown } };
    assert.equal(props.title, "Spring reel");
    assert.deepEqual(
      { handle: props.frame.handle, chrome: props.frame.chrome, guides: props.frame.guides, caption: props.frame.caption },
      { handle: "OASIS AI", chrome: "tiktok", guides: false, caption: null },
      "the preview's own shape: TikTok-first, and no caption over a text card",
    );
    const big = textOf(await resolve(props.media));
    assert.match(big, /Text post/, "no media: the big phone shows the copy, as the small one does");
    assert.match(big, /Your inbox, handled/);
    const host = hosts(phone.tree);
    const wrapper = host.find((h) => h.type === "phone-enlarge");
    assert.ok(wrapper, "the preview sits inside PhoneEnlarge");
    assert.ok(hosts(wrapper!.props.children).some((h) => h.type === "enlarge-button"), "with Enlarge in its options row");
    assert.ok(hosts(wrapper!.props.children).some((h) => h.props["data-phone-frame"] === ""), "around the small phone");

    // Original view and Safe zones: the big phone keeps the phone's shape and guides.
    const original = await render({ frame: "original" });
    assert.equal(original.calls.length, 1, "Enlarge in the Original view too");
    const guides = await render({ guides: "1", chrome: "instagram" });
    const g = guides.calls[0] as { frame: Record<string, unknown> };
    assert.deepEqual([g.frame.guides, g.frame.chrome], [true, "instagram"], "safe zones and the chosen app carry into the big phone");
    raw.close();
  });

  console.log(`\ncontent-iphone: ${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
