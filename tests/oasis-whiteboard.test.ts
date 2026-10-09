/**
 * tests/oasis-whiteboard.test.ts - the Oasis Whiteboard on Content > Content
 * Tools (PR #545, review round 2, 2026-10-08).
 *
 * The independent review found the first version could lose a drawing two
 * ways, had phone controls too small to tap, and had tests that could not
 * fail. Every check here runs the real code:
 *
 *   - components/founders/whiteboard-model.ts (the stroke list, Undo/Redo,
 *     drawing, sizes) and whiteboard-surface.ts (pointer input, resize and
 *     devicePixelRatio, keys, download, dispose) against a RASTER canvas fake:
 *     a device-pixel grid that paints discs along each curve, clips at the
 *     canvas edge, wipes on a size change and erases under destination-out,
 *     the way a real canvas does. So "the stroke is still there" is a pixel
 *     read, not a call count.
 *   - Two controls run the FIRST version's bitmap-copy resize
 *     (OasisWhiteboard.tsx:83-100 at 0686c75d) on the same fake and show it
 *     losing the pixels the new code keeps, so the fake can see the bug.
 *   - The component itself, OasisWhiteboard, through a minimal hook runtime:
 *     its effect mounts the board on its own canvas, its real buttons drive
 *     it, and its cleanup leaves nothing attached.
 *   - The toolbar's server markup (tests/oasis-whiteboard.render.ts): every
 *     control has a 44 x 44 px target at phone and desktop widths, and the
 *     colour and eraser buttons carry aria-pressed.
 *
 * Review round 3 (after #545 merged): keys work while the slider or colour
 * picker has focus; the browser asks before a refresh wipes a board with ink;
 * pointer capture (a mouse that leaves the board and comes back, a lost lift,
 * a palm under a pen); thinner strokes and one brush setting per stroke; the
 * download's background is --c-bg-deep; and checks for the controls no test
 * moved before (Brush size, the eraser's width, the 2x download). The fake
 * pointers behave like a browser's: isPrimary, implicit touch capture,
 * lostpointercapture after a lift, and no mouse move off the canvas unless it
 * is captured.
 *
 * Run: node --conditions=react-server --import tsx tests/oasis-whiteboard.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";

import {
  BOARD_BG,
  MAX_CANVAS_PIXELS,
  MIN_POINT_GAP,
  PEN_GLOW,
  backingScale,
  backingSize,
  beginStroke,
  boardPoint,
  canRedo,
  canUndo,
  clearBoard,
  createBoard,
  downloadName,
  drawStroke,
  drawStrokeEnd,
  endStroke,
  exportArea,
  extendStroke,
  redoStep,
  renderBoard,
  undoStep,
  type BoardContext,
  type View,
} from "../components/founders/whiteboard-model";
import { mountWhiteboard, type SurfaceEnv, type WhiteboardHandle, type WhiteboardState } from "../components/founders/whiteboard-surface";

const root = join(__dirname, "..");
const SKY = "#38bdf8";
const GREEN = "#22c55e";

// -- A raster canvas: device pixels, discs along curves, real clipping -------

const COLORS: string[] = [""];
function colorId(color: string): number {
  let i = COLORS.indexOf(color);
  if (i < 0) {
    COLORS.push(color);
    i = COLORS.length - 1;
  }
  return i;
}

type Fn = (e: unknown) => void;
class Listeners {
  readonly map = new Map<string, Set<Fn>>();
  add(type: string, fn: Fn) {
    if (!this.map.has(type)) this.map.set(type, new Set());
    this.map.get(type)!.add(fn);
  }
  remove(type: string, fn: Fn) {
    this.map.get(type)?.delete(fn);
  }
  dispatch(type: string, e: unknown) {
    for (const fn of [...(this.map.get(type) ?? [])]) fn(e);
  }
  count(): number {
    let n = 0;
    for (const s of this.map.values()) n += s.size;
    return n;
  }
  types(): string[] {
    return [...this.map.entries()].filter(([, s]) => s.size > 0).map(([t]) => t).sort();
  }
}

type Seg =
  | { k: "M"; x: number; y: number }
  | { k: "L"; x: number; y: number }
  | { k: "Q"; cx: number; cy: number; x: number; y: number }
  | { k: "A"; x: number; y: number; r: number };
type CtxState = {
  globalCompositeOperation: string;
  lineWidth: number;
  lineCap: string;
  lineJoin: string;
  strokeStyle: string;
  fillStyle: string;
  shadowBlur: number;
  shadowColor: string;
  xf: [number, number, number, number];
};
const freshState = (): CtxState => ({
  globalCompositeOperation: "source-over",
  lineWidth: 1,
  lineCap: "butt",
  lineJoin: "miter",
  strokeStyle: "#000000",
  fillStyle: "#000000",
  shadowBlur: 0,
  shadowColor: "rgba(0, 0, 0, 0)",
  xf: [1, 1, 0, 0],
});

class RasterCtx {
  globalCompositeOperation = "source-over";
  lineWidth = 1;
  lineCap = "butt";
  lineJoin = "miter";
  strokeStyle = "#000000";
  fillStyle = "#000000";
  shadowBlur = 0;
  shadowColor = "rgba(0, 0, 0, 0)";
  private xf: [number, number, number, number] = [1, 1, 0, 0]; // a (x scale), d (y scale), e, f
  private stack: CtxState[] = [];
  private path: Seg[] = [];
  constructor(private readonly canvas: RasterCanvas) {}
  reset() {
    Object.assign(this, freshState());
    this.stack = [];
    this.path = [];
  }
  private X(x: number) {
    return this.xf[0] * x + this.xf[2];
  }
  private Y(y: number) {
    return this.xf[1] * y + this.xf[3];
  }
  private ink(style: string) {
    return this.globalCompositeOperation === "destination-out" ? 0 : colorId(style);
  }
  private disc(cx: number, cy: number, r: number, id: number) {
    const R = Math.max(r, 0.5);
    for (let y = Math.floor(cy - R); y <= Math.ceil(cy + R); y += 1) {
      for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x += 1) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= R * R) this.canvas.setPx(x, y, id);
      }
    }
  }
  setTransform(a: number, _b: number, _c: number, d: number, e: number, f: number) {
    this.xf = [a, d, e, f];
  }
  save() {
    this.stack.push({ ...this.snapshot(), xf: [...this.xf] as CtxState["xf"] });
  }
  restore() {
    const s = this.stack.pop();
    if (s) Object.assign(this, s);
  }
  private snapshot(): CtxState {
    const { globalCompositeOperation, lineWidth, lineCap, lineJoin, strokeStyle, fillStyle, shadowBlur, shadowColor, xf } = this;
    return { globalCompositeOperation, lineWidth, lineCap, lineJoin, strokeStyle, fillStyle, shadowBlur, shadowColor, xf };
  }
  beginPath() {
    this.path = [];
  }
  moveTo(x: number, y: number) {
    this.path.push({ k: "M", x, y });
  }
  lineTo(x: number, y: number) {
    this.path.push({ k: "L", x, y });
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number) {
    this.path.push({ k: "Q", cx, cy, x, y });
  }
  arc(x: number, y: number, r: number) {
    this.path.push({ k: "A", x, y, r });
  }
  fill() {
    for (const s of this.path) if (s.k === "A") this.disc(this.X(s.x), this.Y(s.y), s.r * this.xf[0], this.ink(this.fillStyle));
  }
  stroke() {
    const id = this.ink(this.strokeStyle);
    const r = (this.lineWidth / 2) * this.xf[0];
    let at: [number, number] | null = null;
    for (const s of this.path) {
      if (s.k === "M") at = [s.x, s.y];
      else if (s.k === "L" && at) {
        const [x0, y0] = at;
        const n = Math.max(2, Math.ceil(Math.hypot(s.x - x0, s.y - y0) * this.xf[0] * 2));
        for (let i = 0; i <= n; i += 1) this.disc(this.X(x0 + ((s.x - x0) * i) / n), this.Y(y0 + ((s.y - y0) * i) / n), r, id);
        at = [s.x, s.y];
      } else if (s.k === "Q" && at) {
        const [x0, y0] = at;
        const length = (Math.hypot(s.cx - x0, s.cy - y0) + Math.hypot(s.x - s.cx, s.y - s.cy)) * this.xf[0];
        const n = Math.max(2, Math.ceil(length * 2));
        for (let i = 0; i <= n; i += 1) {
          const t = i / n;
          const u = 1 - t;
          this.disc(this.X(u * u * x0 + 2 * u * t * s.cx + t * t * s.x), this.Y(u * u * y0 + 2 * u * t * s.cy + t * t * s.y), r, id);
        }
        at = [s.x, s.y];
      }
    }
  }
  private rect(x: number, y: number, w: number, h: number, id: number) {
    for (let py = Math.floor(this.Y(y)); py < Math.ceil(this.Y(y + h)); py += 1) {
      for (let px = Math.floor(this.X(x)); px < Math.ceil(this.X(x + w)); px += 1) this.canvas.setPx(px, py, id);
    }
  }
  clearRect(x: number, y: number, w: number, h: number) {
    this.rect(x, y, w, h, 0);
  }
  fillRect(x: number, y: number, w: number, h: number) {
    this.rect(x, y, w, h, this.ink(this.fillStyle));
  }
  drawImage(src: RasterCanvas, dx: number, dy: number, dw = src.width, dh = src.height) {
    const X0 = this.X(dx);
    const Y0 = this.Y(dy);
    const X1 = this.X(dx + dw);
    const Y1 = this.Y(dy + dh);
    if (X1 <= X0 || Y1 <= Y0 || src.width === 0 || src.height === 0) return;
    for (let y = Math.max(0, Math.floor(Y0)); y < Math.min(this.canvas.height, Math.ceil(Y1)); y += 1) {
      for (let x = Math.max(0, Math.floor(X0)); x < Math.min(this.canvas.width, Math.ceil(X1)); x += 1) {
        const sx = Math.floor(((x + 0.5 - X0) / (X1 - X0)) * src.width);
        const sy = Math.floor(((y + 0.5 - Y0) / (Y1 - Y0)) * src.height);
        const id = src.px[sy * src.width + sx];
        if (id) this.canvas.setPx(x, y, this.globalCompositeOperation === "destination-out" ? 0 : id);
      }
    }
  }
}

class RasterCanvas {
  private w = 0;
  private h = 0;
  px = new Uint16Array(0);
  readonly ctx: RasterCtx = new RasterCtx(this);
  readonly listeners = new Listeners();
  rect = { left: 0, top: 0 };
  /** Its size on the page in CSS px; a mouse off it reaches it only while captured. Null: everywhere is on it. */
  cssBox: (() => { width: number; height: number }) | null = null;
  /** Pointers it holds: setPointerCapture, or a touch's implicit capture. */
  readonly captured = new Set<number>();
  encodeFails = false;
  encodes = 0;
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  /** Like a browser: releasing a pointer it held fires lostpointercapture at it. */
  releasePointerCapture(id: number) {
    if (this.captured.delete(id)) this.listeners.dispatch("lostpointercapture", { type: "lostpointercapture", pointerId: id });
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
  get width() {
    return this.w;
  }
  set width(v: number) {
    this.w = Math.max(0, Math.floor(v));
    this.wipe();
  }
  get height() {
    return this.h;
  }
  set height(v: number) {
    this.h = Math.max(0, Math.floor(v));
    this.wipe();
  }
  /** A real canvas: a new size empties the bitmap and resets every context setting. */
  private wipe() {
    this.px = new Uint16Array(this.w * this.h);
    this.ctx.reset();
  }
  getContext(kind: string) {
    return kind === "2d" ? this.ctx : null;
  }
  getBoundingClientRect() {
    return { left: this.rect.left, top: this.rect.top, x: this.rect.left, y: this.rect.top, width: 0, height: 0, right: 0, bottom: 0 };
  }
  addEventListener(type: string, fn: Fn) {
    this.listeners.add(type, fn);
  }
  removeEventListener(type: string, fn: Fn) {
    this.listeners.remove(type, fn);
  }
  toDataURL() {
    this.encodes += 1;
    return this.encodeFails ? "data:," : `data:image/png;base64,${Buffer.from(String(this.inked())).toString("base64")}`;
  }
  setPx(x: number, y: number, id: number) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.px[y * this.w + x] = id;
  }
  /** The colour at device pixel (x, y), or null where nothing is drawn (or there is no such pixel). */
  colorAt(x: number, y: number): string | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const id = this.px[y * this.w + x];
    return id ? COLORS[id] : null;
  }
  inked(): number {
    let n = 0;
    for (const v of this.px) if (v) n += 1;
    return n;
  }
}

// -- The rest of the browser, faked -------------------------------------------

class FakeQuery {
  readonly events = new Listeners();
  constructor(readonly media: string) {}
  addEventListener(type: string, fn: Fn) {
    this.events.add(type, fn);
  }
  removeEventListener(type: string, fn: Fn) {
    this.events.remove(type, fn);
  }
}

class FakeResizeObserver {
  static live: FakeResizeObserver[] = [];
  readonly targets: unknown[] = [];
  disconnected = false;
  constructor(readonly callback: () => void) {
    FakeResizeObserver.live.push(this);
  }
  observe(target: unknown) {
    this.targets.push(target);
  }
  disconnect() {
    this.disconnected = true;
    this.targets.length = 0;
  }
}

class FakeWindow {
  readonly events = new Listeners();
  readonly queries: FakeQuery[] = [];
  readonly ResizeObserver = FakeResizeObserver;
  devicePixelRatio = 1;
  /** The pointers the browser has down right now: id to kind. */
  readonly down = new Map<number, string>();
  addEventListener(type: string, fn: Fn) {
    this.events.add(type, fn);
  }
  removeEventListener(type: string, fn: Fn) {
    this.events.remove(type, fn);
  }
  matchMedia(media: string) {
    const q = new FakeQuery(media);
    this.queries.push(q);
    return q;
  }
  /**
   * The window moved to a screen with another ratio (or the page was zoomed).
   * Like a browser, a `(resolution: Xdppx)` query fires only when whether it
   * matches flips, so a query made for 1x says nothing on a move from 2x to 3x.
   */
  setRatio(ratio: number) {
    const before = this.devicePixelRatio;
    this.devicePixelRatio = ratio;
    for (const q of [...this.queries]) {
      const m = /\(resolution:\s*([\d.]+)dppx\)/.exec(q.media);
      assert.ok(m, `a resolution query: ${q.media}`);
      const x = Number(m![1]);
      if ((before === x) !== (ratio === x)) q.events.dispatch("change", { matches: ratio === x, media: q.media });
    }
  }
  queryListeners(): number {
    return this.queries.reduce((n, q) => n + q.events.count(), 0);
  }
  attached(): number {
    return this.events.count() + this.queryListeners();
  }
}

class FakeAnchor {
  download = "";
  href = "";
  clicks = 0;
  click() {
    this.clicks += 1;
  }
}

class FakeDocument {
  readonly canvases: RasterCanvas[] = [];
  readonly anchors: FakeAnchor[] = [];
  encodeFails = false;
  createElement(tag: string) {
    if (tag === "canvas") {
      const c = new RasterCanvas();
      c.encodeFails = this.encodeFails;
      this.canvases.push(c);
      return c;
    }
    if (tag === "a") {
      const a = new FakeAnchor();
      this.anchors.push(a);
      return a;
    }
    throw new Error(`unexpected element: ${tag}`);
  }
}

type FakeContainer = { clientWidth: number; clientHeight: number };

function resize(container: FakeContainer, width: number, height: number) {
  container.clientWidth = width;
  container.clientHeight = height;
  for (const ro of FakeResizeObserver.live) if (ro.targets.includes(container)) ro.callback();
}

/** `lost`: the browser ends the pointer, but its pointerup or pointercancel (and the capture release) never reach the board. */
type PointerOpts = { id?: number; type?: "mouse" | "touch" | "pen"; button?: number; buttons?: number; lost?: boolean };
type FakePointer = { defaultPrevented: boolean; isPrimary: boolean };

function pointer(canvas: RasterCanvas, win: FakeWindow, type: string, x: number, y: number, o: PointerOpts = {}): FakePointer {
  const ending = type === "pointerup" || type === "pointercancel";
  const id = o.id ?? 1;
  const kind = o.type ?? "mouse";
  // Like a browser: a pointer is primary when no other pointer of its kind is down.
  const isPrimary = ![...win.down].some(([other, k]) => other !== id && k === kind);
  if (type === "pointerdown") win.down.set(id, kind);
  if (ending) win.down.delete(id);
  const e = {
    type,
    pointerId: id,
    pointerType: kind,
    isPrimary,
    button: o.button ?? 0,
    buttons: o.buttons ?? (ending ? 0 : 1),
    clientX: canvas.rect.left + x,
    clientY: canvas.rect.top + y,
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  if (o.lost) {
    canvas.captured.delete(id);
    return e;
  }
  // pointerup and pointercancel bubble to the window, where the board listens
  // for them; then the browser releases the capture (lostpointercapture).
  if (ending) {
    win.events.dispatch(type, e);
    canvas.releasePointerCapture(id);
    return e;
  }
  if (type === "pointerdown") {
    // A touch is captured by what it lands on before any listener runs.
    if (kind === "touch") canvas.captured.add(id);
    canvas.listeners.dispatch(type, e);
    return e;
  }
  // A move reaches the canvas while it is over the canvas, or anywhere while the canvas holds that pointer.
  const box = canvas.cssBox?.();
  const over = !box || (x >= 0 && y >= 0 && x < box.width && y < box.height);
  if (over || canvas.captured.has(id)) canvas.listeners.dispatch(type, e);
  return e;
}

type KeyOpts = { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean; repeat?: boolean; target?: unknown };
function keydown(win: FakeWindow, key: string, o: KeyOpts = {}) {
  const e = {
    key,
    ctrlKey: !!o.ctrl,
    metaKey: !!o.meta,
    shiftKey: !!o.shift,
    altKey: !!o.alt,
    repeat: !!o.repeat,
    target: o.target ?? { tagName: "BODY", isContentEditable: false },
    defaultPrevented: false,
    preventDefault() {
      e.defaultPrevented = true;
    },
  };
  win.events.dispatch("keydown", e);
  return e;
}

type Rig = {
  win: FakeWindow;
  doc: FakeDocument;
  canvas: RasterCanvas;
  container: FakeContainer;
  board: WhiteboardHandle;
  states: WhiteboardState[];
  last: () => WhiteboardState;
  /** The colour on screen at board point (x, y), read from the canvas at its current scale. */
  at: (x: number, y: number) => string | null;
  stroke: (points: Array<[number, number]>, o?: PointerOpts) => void;
};

function rig(width = 400, height = 300, dpr = 1): Rig {
  const win = new FakeWindow();
  win.devicePixelRatio = dpr;
  const doc = new FakeDocument();
  const canvas = new RasterCanvas();
  // The canvas sits below the page header and the toolbar, not at the window's corner.
  canvas.rect = { left: 120, top: 310 };
  const container: FakeContainer = { clientWidth: width, clientHeight: height };
  // It fills its container (absolute inset-0).
  canvas.cssBox = () => ({ width: container.clientWidth, height: container.clientHeight });
  const states: WhiteboardState[] = [];
  const env: SurfaceEnv = {
    win: win as unknown as SurfaceEnv["win"],
    doc: doc as unknown as SurfaceEnv["doc"],
    ResizeObserver: FakeResizeObserver as unknown as SurfaceEnv["ResizeObserver"],
    now: () => new Date(2026, 9, 8, 21, 30),
  };
  const board = mountWhiteboard(canvas as unknown as HTMLCanvasElement, container as unknown as HTMLElement, env, (s) => states.push(s));
  assert.ok(board, "the board mounts on a canvas with a 2D context");
  const at = (x: number, y: number) => {
    const scale = canvas.width / Math.max(1, container.clientWidth);
    return canvas.colorAt(Math.floor(x * scale), Math.floor(y * scale));
  };
  const stroke = (points: Array<[number, number]>, o: PointerOpts = {}) => {
    const [first, ...rest] = points;
    pointer(canvas, win, "pointerdown", first[0], first[1], o);
    for (const [x, y] of rest) pointer(canvas, win, "pointermove", x, y, o);
    const end = rest.length ? rest[rest.length - 1] : first;
    pointer(canvas, win, "pointerup", end[0], end[1], o);
  };
  return { win, doc, canvas, container, board: board!, states, last: () => states[states.length - 1], at, stroke };
}

/** Points every 10 px along a horizontal line, from x0 to x1 inclusive. */
function line(x0: number, x1: number, y: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let x = x0; x <= x1; x += 10) pts.push([x, y]);
  return pts;
}

/** Replaces the timer globals with a queue, so a test can run "everything that was waiting". */
function withQueuedTimers(fn: (flush: () => number) => void) {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { setTimeout: g.setTimeout, requestAnimationFrame: g.requestAnimationFrame };
  const queue: Array<() => void> = [];
  g.setTimeout = (cb: () => void) => queue.push(cb);
  g.requestAnimationFrame = (cb: (t: number) => void) => queue.push(() => cb(0));
  const flush = () => {
    let ran = 0;
    while (queue.length && ran < 1000) {
      queue.shift()!();
      ran += 1;
    }
    return ran;
  };
  try {
    fn(flush);
  } finally {
    g.setTimeout = saved.setTimeout;
    g.requestAnimationFrame = saved.requestAnimationFrame;
  }
}

/**
 * THE FIRST VERSION'S RESIZE (components/founders/OasisWhiteboard.tsx:83-100 at
 * 0686c75d), verbatim apart from the fakes: copy the bitmap out, resize, paint
 * it back at its old logical size. Kept here only as the control that proves
 * the raster fake sees the loss the review reproduced in a real browser.
 */
function firstVersionResize(canvas: RasterCanvas, container: FakeContainer, dpr: number, doc: FakeDocument) {
  const ctx = canvas.getContext("2d")!;
  const temp = doc.createElement("canvas") as RasterCanvas;
  const tctx = temp.getContext("2d");
  temp.width = canvas.width;
  temp.height = canvas.height;
  if (tctx && canvas.width > 0) tctx.drawImage(canvas, 0, 0);
  canvas.width = Math.round(container.clientWidth * dpr);
  canvas.height = Math.round(container.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  if (tctx && temp.width > 0) ctx.drawImage(temp, 0, 0, temp.width / dpr, temp.height / dpr);
}

/** The first version, drawing `points` as a live stroke on a board of this size. */
function firstVersionBoard(width: number, height: number, dpr: number, points: Array<[number, number]>) {
  const doc = new FakeDocument();
  const canvas = new RasterCanvas();
  const container = { clientWidth: width, clientHeight: height };
  firstVersionResize(canvas, container, dpr, doc);
  const board = createBoard();
  const s = beginStroke(board, "pen", SKY, 6, points[0][0], points[0][1]);
  const ctx = canvas.getContext("2d") as unknown as BoardContext;
  drawStroke(ctx, s);
  for (const [x, y] of points.slice(1)) drawStroke(ctx, extendStroke(board, x, y)!, s.points.length / 2 - 1);
  return { canvas, container, doc };
}

/** A 2D context that only counts: brush settings written, paths, paints, and the brush each paint used. */
function countingContext() {
  const state: Record<string, unknown> = { globalCompositeOperation: "source-over", shadowBlur: 0, shadowColor: "" };
  const tally = { sets: 0, beginPath: 0, stroke: 0, fill: 0 };
  const paints: Array<{ op: unknown; blur: unknown; shadow: unknown; color: unknown }> = [];
  const paint = (style: string) =>
    paints.push({ op: state.globalCompositeOperation, blur: state.shadowBlur, shadow: state.shadowColor, color: state[style] });
  const methods: Record<string, () => void> = {
    beginPath: () => {
      tally.beginPath += 1;
    },
    stroke: () => {
      tally.stroke += 1;
      paint("strokeStyle");
    },
    fill: () => {
      tally.fill += 1;
      paint("fillStyle");
    },
  };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get: (_t, k: string) => methods[k] ?? (k in state ? state[k] : () => undefined),
    set: (_t, k: string, v: unknown) => {
      tally.sets += 1;
      state[k] = v;
      return true;
    },
  });
  return { ctx: ctx as unknown as BoardContext, tally, paints };
}

// -- A minimal React hook runtime, to run OasisWhiteboard's own effect --------

type El = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
const hookState: unknown[] = [];
let hookAt = 0;
const pendingEffects: Array<() => void | (() => void)> = [];
const ReactStub = {
  useRef<T>(initial: T) {
    const i = hookAt++;
    if (!(i in hookState)) hookState[i] = { current: initial };
    return hookState[i] as { current: T };
  },
  useState<T>(initial: T) {
    const i = hookAt++;
    if (!(i in hookState)) hookState[i] = initial;
    const set = (v: T | ((prev: T) => T)) => {
      hookState[i] = typeof v === "function" ? (v as (prev: T) => T)(hookState[i] as T) : v;
    };
    return [hookState[i] as T, set] as const;
  },
  useEffect(fn: () => void | (() => void)) {
    const i = hookAt++;
    if (!(i in hookState)) {
      hookState[i] = true;
      pendingEffects.push(fn);
    }
  },
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): El {
    return { type, props: { ...(props ?? {}), children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children } };
  },
  Fragment: "fragment",
};

/** Calls function components (the toolbar) down to host elements. */
function expand(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expand);
  if (!node || typeof node !== "object" || !("type" in node)) return node;
  const el = node as El;
  if (typeof el.type === "function") return expand((el.type as (p: unknown) => unknown)(el.props));
  return { type: el.type, props: { ...el.props, children: expand(el.props.children) } };
}
const nodes = (n: unknown): El[] =>
  Array.isArray(n) ? n.flatMap(nodes) : n && typeof n === "object" && "props" in n ? [n as El, ...nodes((n as El).props.children)] : [];
const textOf = (n: unknown): string =>
  typeof n === "string" || typeof n === "number" ? String(n) : Array.isArray(n) ? n.map(textOf).join("") : n && typeof n === "object" && "props" in n ? textOf((n as El).props.children) : "";
const button = (tree: unknown, label: string): El => {
  const found = nodes(tree).find((n) => n.type === "button" && n.props["aria-label"] === label);
  assert.ok(found, `a button named ${label}`);
  return found!;
};

// -- Markup helpers for the server render -------------------------------------

type Tag = { name: string; attrs: Record<string, string>; index: number };
/** React escapes attribute values; `&` in an arbitrary variant such as `[&::-webkit-slider-thumb]` arrives as `&amp;`. */
const unescapeAttr = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function tagsOf(html: string): Tag[] {
  const out: Tag[] = [];
  for (const m of html.matchAll(/<([a-z]+)((?:\s+[\w:-]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[2].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = unescapeAttr(a[2] ?? "");
    out.push({ name: m[1], attrs, index: m.index ?? 0 });
  }
  return out;
}

const BREAKPOINTS = ["", "sm", "md", "lg", "xl", "2xl"] as const;
/** Tailwind spacing to px: "11" -> 44, "[44px]" -> 44; anything else (full, auto) -> null. */
function spacingPx(v: string): number | null {
  if (/^\d+(?:\.5)?$/.test(v)) return Number(v) * 4;
  const m = /^\[(\d+(?:\.\d+)?)px\]$/.exec(v);
  return m ? Number(m[1]) : null;
}
/**
 * The smallest a control can be along one axis at a breakpoint, from its
 * classes alone: `h-`/`w-`/`size-` and `min-h-`/`min-w-`, mobile first, so a
 * `md:` class overrides the base from md up. "" is a phone.
 */
function minSide(classes: string[], axis: "h" | "w", bp: (typeof BREAKPOINTS)[number]): number {
  let size = 0;
  let min = 0;
  for (const b of BREAKPOINTS.slice(0, BREAKPOINTS.indexOf(bp) + 1)) {
    for (const c of classes) {
      const cut = c.lastIndexOf(":");
      const prefix = cut < 0 ? "" : c.slice(0, cut);
      const util = cut < 0 ? c : c.slice(cut + 1);
      if (prefix !== b) continue;
      let m = new RegExp(`^(?:${axis}|size)-(.+)$`).exec(util);
      if (m && spacingPx(m[1]) !== null) size = spacingPx(m[1])!;
      m = new RegExp(`^min-${axis}-(.+)$`).exec(util);
      if (m) min = spacingPx(m[1]) ?? 0;
    }
  }
  return Math.max(size, min);
}
const classesOf = (t: Tag) => (t.attrs.class ?? "").split(/\s+/).filter(Boolean);

function renderMarkup(cases: unknown[]): Record<string, string> {
  const r = spawnSync(process.execPath, ["--import", "tsx", "tests/oasis-whiteboard.render.ts"], {
    cwd: root,
    input: JSON.stringify({ cases }),
    encoding: "utf8",
    // CI sets NODE_OPTIONS=--conditions=react-server for the whole step;
    // react-dom/server refuses to load under it, so the child drops it.
    env: { ...process.env, NODE_OPTIONS: "" },
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, `render failed: ${r.stderr}`);
  return (JSON.parse(r.stdout) as { markup: Record<string, string> }).markup;
}

// -- The checks ---------------------------------------------------------------

let failures = 0;
async function check(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${((e as Error).stack || (e as Error).message).split("\n").slice(0, 8).join("\n        ")}`);
  }
}

async function main() {
  console.log("oasis-whiteboard:");

  // -- the stroke list -----------------------------------------------------
  await check("model: strokes, Clear, Undo and Redo are list steps; Clear on an empty board adds none", () => {
    const b = createBoard();
    beginStroke(b, "pen", SKY, 4, 10, 10);
    extendStroke(b, 20, 10);
    endStroke(b);
    beginStroke(b, "pen", GREEN, 4, 10, 30);
    endStroke(b);
    assert.equal(b.strokes.length, 2);
    assert.equal(clearBoard(b), true);
    assert.equal(b.strokes.length, 0);
    assert.equal(clearBoard(b), false, "a second Clear on an empty board does nothing");
    assert.equal(undoStep(b), true);
    assert.equal(b.strokes.length, 2, "one Undo brings the whole cleared board back");
    assert.equal(redoStep(b), true);
    assert.equal(b.strokes.length, 0, "Redo clears it again");
    assert.equal(undoStep(b) && undoStep(b), true);
    assert.deepEqual(b.strokes.map((s) => s.color), [SKY], "then Undo takes back the last stroke");
    assert.equal(canRedo(b), true);
    beginStroke(b, "pen", GREEN, 4, 50, 50);
    endStroke(b);
    assert.equal(canRedo(b), false, "a new stroke ends Redo");

    const c = createBoard();
    beginStroke(c, "pen", SKY, 4, 0, 0);
    extendStroke(c, 5, 5);
    assert.equal(canUndo(c), true, "a stroke being drawn can be undone");
    assert.equal(clearBoard(c), true, "Clear while a stroke is open");
    assert.equal(c.active, null);
    assert.equal(extendStroke(c, 9, 9), null, "the cleared stroke takes no more points");
    undoStep(c);
    assert.deepEqual(c.strokes.map((s) => s.points), [[0, 0, 5, 5]], "Undo brings it back as it was when Clear was pressed");
  });

  await check("model: drawing live, point by point, paints exactly the pixels a full redraw paints", () => {
    const view: View = { width: 200, height: 120, scale: 2 };
    const live = new RasterCanvas();
    const full = new RasterCanvas();
    for (const c of [live, full]) {
      c.width = 400;
      c.height = 240;
    }
    const b = createBoard();
    const liveCtx = live.getContext("2d") as unknown as BoardContext;
    renderBoard(liveCtx, b, view);
    const strokes: Array<{ tool: "pen" | "eraser"; color: string; size: number; pts: Array<[number, number]> }> = [
      { tool: "pen", color: SKY, size: 6, pts: [[20, 20], [40, 35], [70, 30], [120, 60], [150, 90]] },
      { tool: "pen", color: GREEN, size: 3, pts: [[30, 100], [90, 20]] },
      { tool: "eraser", color: SKY, size: 4, pts: [[60, 30], [80, 40], [100, 50]] },
      { tool: "pen", color: SKY, size: 10, pts: [[170, 100]] },
    ];
    for (const s of strokes) {
      const st = beginStroke(b, s.tool, s.color, s.size, s.pts[0][0], s.pts[0][1]);
      drawStroke(liveCtx, st);
      for (const [x, y] of s.pts.slice(1)) drawStroke(liveCtx, extendStroke(b, x, y)!, st.points.length / 2 - 1);
      drawStrokeEnd(liveCtx, st);
      endStroke(b);
    }
    renderBoard(full.getContext("2d") as unknown as BoardContext, b, view);
    assert.ok(live.inked() > 500, `the strokes painted something: ${live.inked()} px`);
    assert.deepEqual(full.px, live.px, "a redraw (after a resize, an Undo) looks exactly like the board drawn live");
  });

  await check("model: canvas size, the download area, the file name and the pointer position", () => {
    assert.equal(backingScale(800, 600, 2), 2);
    assert.equal(backingScale(800, 600, Number.NaN), 1, "an unknown ratio draws at 1");
    const capped = backingScale(5000, 4000, 2);
    assert.ok(capped < 2 && 5000 * 4000 * capped * capped <= MAX_CANVAS_PIXELS + 1, `a huge board stays under the iOS canvas limit: ${capped}`);
    assert.deepEqual(backingSize({ width: 401, height: 300, scale: 1.5 }), { width: 601, height: 450 });
    const b = createBoard();
    beginStroke(b, "pen", SKY, 6, 780, 350);
    endStroke(b);
    beginStroke(b, "eraser", SKY, 6, 1900, 1900);
    endStroke(b);
    assert.deepEqual(exportArea(b, { width: 400, height: 300, scale: 1 }), { width: 787, height: 357 }, "grown to the pen stroke past the edge; the eraser adds nothing");
    assert.deepEqual(exportArea(createBoard(), { width: 400, height: 300, scale: 1 }), { width: 400, height: 300 });
    assert.equal(downloadName(new Date(2026, 9, 8, 23, 59)), "Oasis-Whiteboard-2026-10-08.png", "the presenter's calendar day, not UTC's");
    assert.deepEqual(boardPoint(520, 410, { left: 120, top: 310 }), [400, 100]);
  });

  // -- review round 3: a long session stays cheap to redraw ----------------
  await check("model: a pen held still adds no points, a slow drag keeps one per MIN_POINT_GAP, and a redraw sets the brush once per stroke", () => {
    const b = createBoard();
    beginStroke(b, "pen", SKY, 4, 10, 10);
    for (let i = 0; i < 50; i += 1) assert.equal(extendStroke(b, 10.4, 10.3), null, "a pen held still (only its pressure changing) adds nothing");
    assert.equal(extendStroke(b, 11, 11), null, "nor does a move shorter than the gap");
    assert.ok(extendStroke(b, 10 + MIN_POINT_GAP, 10), "a move of the gap is a new point");
    for (let x = 12; x <= 112; x += 0.5) extendStroke(b, x, 10);
    endStroke(b);
    const kept = b.strokes[0].points;
    assert.ok(kept.length / 2 >= 60 && kept.length / 2 <= 75, `a slow 100 px drag sampled every half pixel keeps about one point per 1.5 px, not one per sample: ${kept.length / 2}`);
    assert.ok(112 - kept[kept.length - 2] < MIN_POINT_GAP, "and still reaches to within the gap of where the pointer went");

    // About ten minutes of ink: 300 strokes of 120 points, every seventh one the eraser.
    const big = createBoard();
    for (let s = 0; s < 300; s += 1) {
      beginStroke(big, s % 7 === 6 ? "eraser" : "pen", SKY, 4, 0, s);
      for (let i = 1; i < 120; i += 1) extendStroke(big, i * 3, s + (i % 2));
      endStroke(big);
    }
    const { ctx, tally, paints } = countingContext();
    renderBoard(ctx, big, { width: 400, height: 300, scale: 1 });
    assert.equal(tally.fill, 300, "each stroke still paints its first dot");
    assert.equal(tally.stroke, 300 * 120, "and its 119 curves plus the last stretch, so a redraw matches the board drawn live");
    assert.equal(tally.beginPath, tally.stroke + tally.fill, "one path per paint");
    assert.ok(tally.sets <= 300 * 16, `brush settings written by one redraw: ${tally.sets} (one per point was over 200,000)`);
    const pens = paints.filter((p) => p.op === "source-over");
    const erasers = paints.filter((p) => p.op === "destination-out");
    assert.ok(pens.length > 0 && erasers.length > 0);
    assert.ok(pens.every((p) => p.blur === PEN_GLOW && p.shadow === SKY && p.color === SKY), "every pen paint has its colour and its soft glow");
    assert.ok(erasers.every((p) => p.blur === 0), "the eraser cuts with no glow");
  });

  // -- Codex HIGH 1: a resize lost the drawing -----------------------------
  await check("a resize never loses the drawing: drawn by the right edge, shrunk, grown back, it is all there (and the first version lost it)", () => {
    const pts = line(720, 790, 200);
    const old = firstVersionBoard(800, 400, 1, pts);
    assert.equal(old.canvas.colorAt(770, 200), SKY, "control: the first version drew the stroke");
    resize(old.container, 400, 400);
    firstVersionResize(old.canvas, old.container, 1, old.doc);
    resize(old.container, 800, 400);
    firstVersionResize(old.canvas, old.container, 1, old.doc);
    assert.equal(old.canvas.colorAt(770, 200), null, "control: the first version's shrink-and-grow erased it, as the review measured");

    const r = rig(800, 400);
    r.stroke(pts);
    assert.equal(r.at(770, 200), SKY);
    resize(r.container, 400, 400);
    assert.equal(r.canvas.width, 400, "the canvas follows the smaller board");
    resize(r.container, 800, 400);
    assert.equal(r.canvas.width, 800);
    assert.equal(r.at(770, 200), SKY, "the part that was off the smaller board is back");
    assert.equal(r.at(725, 200), SKY);

    // A phone turned sideways and back: the bottom of the drawing survives a short board.
    const p = rig(390, 700, 3);
    p.stroke([[100, 650], [150, 660], [200, 670], [250, 680]], { type: "touch", id: 11 });
    assert.equal(p.at(175, 665), SKY);
    resize(p.container, 700, 390);
    resize(p.container, 390, 700);
    assert.equal(p.at(175, 665), SKY, "rotation and back");
    assert.equal(p.canvas.width, 1170, "drawn at the phone's 3x");
  });

  await check("a devicePixelRatio change redraws the board sharp at the new ratio, in the same place (the first version shrank it)", () => {
    const old = firstVersionBoard(400, 300, 1, [[100, 100]]);
    firstVersionResize(old.canvas, old.container, 2, old.doc);
    assert.equal(old.canvas.colorAt(200, 200), null, "control: after the first version's resize at 2x the dot is not where it was drawn");
    assert.equal(old.canvas.colorAt(100, 100), SKY, "control: it shrank to half the distance from the corner");

    const r = rig(400, 300, 1);
    r.stroke([[100, 100]]);
    assert.equal(r.canvas.colorAt(100, 100), SKY);
    r.win.setRatio(2);
    assert.equal(r.canvas.width, 800, "the bitmap now has 2 device pixels per board pixel");
    assert.equal(r.canvas.colorAt(200, 200), SKY, "the dot is where it was drawn");
    assert.equal(r.canvas.colorAt(100, 100), null, "and nowhere else");
    assert.equal(r.at(100, 100), SKY);
    r.win.setRatio(1.5);
    assert.equal(r.canvas.width, 600, "the resolution query is made again for each new ratio");
    assert.equal(r.win.queryListeners(), 1, "and only one is listened to at a time");
  });

  await check("a board hidden to 0 x 0 keeps its drawing for when it shows again", () => {
    const r = rig(400, 300);
    r.stroke(line(50, 150, 80));
    resize(r.container, 0, 0);
    assert.equal(r.canvas.width, 0);
    resize(r.container, 400, 300);
    assert.equal(r.at(100, 80), SKY);
  });

  // -- Codex HIGH 2: Clear could erase work drawn after it -----------------
  await check("Clear is immediate and can never erase a stroke drawn after it; Undo brings the cleared board back", () => {
    withQueuedTimers((flush) => {
      const r = rig(400, 300);
      r.stroke(line(40, 140, 60));
      assert.equal(r.at(90, 60), SKY);
      r.board.clear();
      assert.equal(r.at(90, 60), null, "the board is empty the moment Clear is pressed");
      assert.equal(r.last().notice, "cleared", "and says how to get it back");
      assert.equal(r.last().canUndo, true);
      assert.equal(r.last().empty, true);
      r.stroke(line(40, 140, 200), { type: "touch", id: 5 });
      flush();
      assert.equal(r.at(90, 200), SKY, "the next sketch, started straight after Clear, is still there once everything pending has run");
      assert.equal(r.last().notice, null, "the next stroke takes the notice away");
      r.board.undo();
      assert.equal(r.at(90, 200), null, "Undo takes back the newest stroke first");
      r.board.undo();
      assert.equal(r.at(90, 60), SKY, "then the Clear: the first sketch is back");
      r.board.redo();
      assert.equal(r.at(90, 60), null, "Redo clears it again");
    });
  });

  await check("pressing Clear again and again adds nothing to undo: one Undo still brings the board back", () => {
    withQueuedTimers((flush) => {
      const r = rig(400, 300);
      r.stroke(line(40, 140, 60));
      r.board.clear();
      r.board.clear();
      r.board.clear();
      flush();
      assert.equal(r.last().notice, "cleared");
      r.board.undo();
      assert.equal(r.at(90, 60), SKY);
      assert.equal(r.last().empty, false);
      assert.equal(r.last().notice, null, "Undo takes the 'Board cleared' line away: the board is back");
    });
  });

  await check("Clear while a finger is still drawing: the stroke goes with the board, the finger draws no more, Undo restores it", () => {
    const r = rig(400, 300);
    pointer(r.canvas, r.win, "pointerdown", 50, 100, { type: "touch", id: 9 });
    pointer(r.canvas, r.win, "pointermove", 100, 100, { type: "touch", id: 9 });
    pointer(r.canvas, r.win, "pointermove", 150, 100, { type: "touch", id: 9 });
    r.board.clear();
    assert.equal(r.canvas.inked(), 0);
    pointer(r.canvas, r.win, "pointermove", 250, 100, { type: "touch", id: 9 });
    pointer(r.canvas, r.win, "pointerup", 250, 100, { type: "touch", id: 9 });
    assert.equal(r.canvas.inked(), 0, "the finger that was down when Clear was pressed draws nothing more");
    r.board.undo();
    assert.equal(r.at(90, 100), SKY);
    assert.equal(r.at(220, 100), null);
  });

  await check("the eraser removes ink, and what it removed stays removed through a redraw", () => {
    const r = rig(400, 300);
    r.stroke(line(100, 300, 150));
    keydown(r.win, "e");
    assert.equal(r.last().erasing, true);
    r.stroke([[200, 150]]);
    assert.equal(r.at(200, 150), null, "erased");
    assert.equal(r.at(150, 150), SKY, "the rest of the line stays");
    resize(r.container, 500, 300);
    assert.equal(r.at(200, 150), null, "still erased after the board redraws");
    assert.equal(r.at(150, 150), SKY);
    r.board.setColor(GREEN);
    assert.equal(r.last().erasing, false, "picking a colour puts the pen back");
  });

  await check("Brush size: kept to 1..50 and rounded, a non-number ignored, the next stroke drawn that wide; the eraser cuts 2.5x wider", () => {
    const r = rig(400, 300);
    assert.equal(r.last().size, 4, "it starts at the default");
    r.board.setSize(0);
    assert.equal(r.last().size, 1, "never below 1");
    r.board.setSize(80);
    assert.equal(r.last().size, 50, "never above 50");
    r.board.setSize(Number.NaN);
    assert.equal(r.last().size, 50, "a value that is not a number changes nothing");
    r.board.setSize(19.6);
    assert.equal(r.last().size, 20, "rounded to a whole pixel");
    r.stroke(line(50, 350, 100));
    assert.equal(r.at(200, 108), SKY, "a size-20 pen covers 10 px each side of its line");
    assert.equal(r.at(200, 112), null, "and no more");
    r.board.setSize(4);
    r.board.toggleEraser();
    r.stroke(line(100, 300, 100));
    assert.equal(r.at(200, 104), null, "a size-4 eraser is 10 px wide, so it cuts 5 px each side");
    assert.equal(r.at(200, 107), SKY, "and leaves the ink 7 px away");
    assert.equal(r.at(200, 93), SKY);
  });

  await check("a stroke ends where the pointer lifted, live and after a redraw (CodeRabbit: a quick flick stopped halfway)", () => {
    const r = rig(400, 300);
    r.stroke([[100, 100], [200, 100]]);
    assert.equal(r.at(195, 100), SKY, "one quick move: the line reaches the pointer, not the halfway point");
    assert.equal(r.at(206, 100), null, "and stops there");
    resize(r.container, 401, 300);
    assert.equal(r.at(195, 100), SKY, "the same after a redraw");
    pointer(r.canvas, r.win, "pointerdown", 100, 200);
    pointer(r.canvas, r.win, "pointermove", 200, 200);
    resize(r.container, 400, 300);
    assert.equal(r.at(195, 200), null, "a stroke still being drawn is not closed early by a redraw");
    pointer(r.canvas, r.win, "pointerup", 200, 200);
    assert.equal(r.at(195, 200), SKY, "it is finished when the pointer lifts");
  });

  // -- input ---------------------------------------------------------------
  await check("input: mouse, finger and pen draw; a right click, a second finger and a cancelled touch do not", () => {
    const r = rig(400, 300);
    pointer(r.canvas, r.win, "pointerdown", 50, 50, { button: 2, buttons: 2 });
    pointer(r.canvas, r.win, "pointermove", 90, 50, { button: 2, buttons: 2 });
    pointer(r.canvas, r.win, "pointerup", 90, 50, { button: 2 });
    assert.equal(r.canvas.inked(), 0, "a right click opens no stroke");

    const down = pointer(r.canvas, r.win, "pointerdown", 20, 120, { type: "touch", id: 3 });
    assert.equal(down.defaultPrevented, true, "drawing never selects text or scrolls the page");
    pointer(r.canvas, r.win, "pointerdown", 300, 250, { type: "touch", id: 4 });
    pointer(r.canvas, r.win, "pointermove", 360, 250, { type: "touch", id: 4 });
    pointer(r.canvas, r.win, "pointermove", 60, 120, { type: "touch", id: 3 });
    pointer(r.canvas, r.win, "pointermove", 100, 120, { type: "touch", id: 3 });
    pointer(r.canvas, r.win, "pointerup", 360, 250, { type: "touch", id: 4 });
    pointer(r.canvas, r.win, "pointerup", 100, 120, { type: "touch", id: 3 });
    assert.equal(r.at(50, 120), SKY, "the first finger drew");
    assert.equal(r.at(330, 250), null, "the second finger, down while the first drew, did not");

    r.stroke([[40, 200], [80, 200], [120, 200]], { type: "pen", id: 21 });
    assert.equal(r.at(70, 200), SKY, "a pen draws like a finger");

    pointer(r.canvas, r.win, "pointerdown", 200, 40, { type: "touch", id: 30 });
    pointer(r.canvas, r.win, "pointermove", 240, 40, { type: "touch", id: 30 });
    pointer(r.canvas, r.win, "pointercancel", 240, 40, { type: "touch", id: 30 });
    assert.equal(r.at(238, 40), SKY, "a cancelled touch keeps what it drew, up to where it was");
    pointer(r.canvas, r.win, "pointermove", 300, 40, { type: "touch", id: 30 });
    assert.equal(r.at(250, 40), null, "and draws nothing after the cancel");
    r.board.undo();
    assert.equal(r.at(215, 40), null, "and it was a whole step Undo can take back");

    pointer(r.canvas, r.win, "pointerdown", 20, 280);
    pointer(r.canvas, r.win, "pointermove", 60, 280);
    pointer(r.canvas, r.win, "pointermove", 200, 280, { buttons: 0 });
    pointer(r.canvas, r.win, "pointermove", 300, 280, { buttons: 0 });
    assert.equal(r.at(250, 280), null, "a mouse released outside the window draws no more");
  });

  // -- review round 3: pointers that leave, or never lift ------------------
  await check("a mouse stroke that runs off the board and back is one line, not a straight cut across the gap (pointer capture)", () => {
    const r = rig(400, 300);
    pointer(r.canvas, r.win, "pointerdown", 350, 100);
    assert.equal(r.canvas.hasPointerCapture(1), true, "the canvas holds the pointer that draws");
    pointer(r.canvas, r.win, "pointermove", 390, 100);
    pointer(r.canvas, r.win, "pointermove", 450, 50);
    pointer(r.canvas, r.win, "pointermove", 450, 250);
    pointer(r.canvas, r.win, "pointermove", 390, 250);
    pointer(r.canvas, r.win, "pointerup", 390, 250);
    assert.equal(r.at(390, 175), null, "no straight line joins where it left the board to where it came back");
    assert.equal(r.at(395, 250), SKY, "it finished where the mouse lifted");
    resize(r.container, 500, 300);
    assert.equal(r.at(450, 150), SKY, "the part drawn off the edge was kept, and shows on a wider board");
  });

  await check("a lift that never arrives does not lock the board: the next finger finishes that stroke and draws; a palm under a pen still draws nothing", () => {
    const r = rig(400, 300);
    pointer(r.canvas, r.win, "pointerdown", 40, 60, { type: "touch", id: 3 });
    pointer(r.canvas, r.win, "pointermove", 100, 60, { type: "touch", id: 3 });
    pointer(r.canvas, r.win, "pointerup", 100, 60, { type: "touch", id: 3, lost: true });
    assert.equal(r.at(95, 60), null, "still open: its last stretch is drawn when it ends");
    r.stroke(line(40, 140, 200), { type: "touch", id: 4 });
    assert.equal(r.at(90, 200), SKY, "the next finger draws (before: every other finger was ignored until a reload)");
    assert.equal(r.at(95, 60), SKY, "and the stroke that never lifted is finished up to where the finger was");
    r.board.undo();
    assert.equal(r.at(90, 200), null);
    assert.equal(r.at(95, 60), SKY, "each is its own Undo step");

    pointer(r.canvas, r.win, "pointerdown", 100, 120);
    pointer(r.canvas, r.win, "pointermove", 200, 120);
    pointer(r.canvas, r.win, "pointerup", 200, 120, { lost: true });
    assert.equal(r.at(190, 120), null);
    pointer(r.canvas, r.win, "pointerdown", 100, 250);
    assert.equal(r.at(190, 120), SKY, "the same mouse pressed again finishes its unlifted stroke first");
    pointer(r.canvas, r.win, "pointerup", 100, 250);

    const pen = rig(400, 300);
    pointer(pen.canvas, pen.win, "pointerdown", 40, 150, { type: "pen", id: 21 });
    pointer(pen.canvas, pen.win, "pointermove", 80, 150, { type: "pen", id: 21 });
    const palm = pointer(pen.canvas, pen.win, "pointerdown", 300, 250, { type: "touch", id: 40 });
    assert.equal(palm.isPrimary, true, "the palm is the first touch, so the browser calls it primary");
    pointer(pen.canvas, pen.win, "pointermove", 350, 250, { type: "touch", id: 40 });
    pointer(pen.canvas, pen.win, "pointermove", 120, 150, { type: "pen", id: 21 });
    pointer(pen.canvas, pen.win, "pointerup", 350, 250, { type: "touch", id: 40 });
    pointer(pen.canvas, pen.win, "pointerup", 120, 150, { type: "pen", id: 21 });
    assert.equal(pen.at(325, 250), null, "a palm resting on the screen while the pen draws does not draw");
    assert.equal(pen.at(115, 150), SKY, "and the pen's stroke went on to where it lifted");
  });

  await check("a pointer whose capture is taken away ends its stroke where it was, and draws no more", () => {
    const r = rig(400, 300);
    pointer(r.canvas, r.win, "pointerdown", 40, 30, { type: "pen", id: 7 });
    pointer(r.canvas, r.win, "pointermove", 100, 30, { type: "pen", id: 7 });
    r.canvas.releasePointerCapture(7);
    assert.equal(r.at(95, 30), SKY, "finished up to where the pen was");
    assert.equal(r.last().canUndo, true);
    pointer(r.canvas, r.win, "pointermove", 200, 30, { type: "pen", id: 7 });
    assert.equal(r.at(150, 30), null, "the pen draws no more until it is put down again");
    r.stroke([[60, 120], [120, 120]], { type: "pen", id: 7 });
    assert.equal(r.at(115, 120), SKY, "put down again, it draws");
  });

  await check("keys: E toggles the eraser, Ctrl/Cmd+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo; never while typing", () => {
    const r = rig(400, 300);
    r.stroke(line(40, 120, 50));
    keydown(r.win, "e", { target: { tagName: "INPUT", isContentEditable: false } });
    keydown(r.win, "e", { target: { tagName: "DIV", isContentEditable: true } });
    keydown(r.win, "e", { ctrl: true });
    assert.equal(r.last().erasing, false, "E in a field, in an editable box, or with Ctrl is not the eraser");
    keydown(r.win, "E");
    assert.equal(r.last().erasing, true);
    keydown(r.win, "e", { repeat: true });
    assert.equal(r.last().erasing, true, "holding E does not flicker the eraser");
    keydown(r.win, "e");

    const z = keydown(r.win, "z", { ctrl: true });
    assert.equal(z.defaultPrevented, true);
    assert.equal(r.at(80, 50), null, "Ctrl+Z undid the stroke");
    keydown(r.win, "Z", { ctrl: true, shift: true });
    assert.equal(r.at(80, 50), SKY, "Ctrl+Shift+Z redid it");
    keydown(r.win, "z", { meta: true });
    assert.equal(r.at(80, 50), null, "Cmd+Z on a Mac");
    keydown(r.win, "y", { meta: true });
    assert.equal(r.at(80, 50), null, "Cmd+Y is the browser's History on a Mac, not Redo");
    keydown(r.win, "y", { ctrl: true });
    assert.equal(r.at(80, 50), SKY, "Ctrl+Y redid it");
    keydown(r.win, "z", { ctrl: true, target: { tagName: "TEXTAREA", isContentEditable: false } });
    assert.equal(r.at(80, 50), SKY, "Ctrl+Z in a text box is that box's undo");
  });

  await check("keys still work while the Brush size slider or the colour picker has focus (review round 3), and never while typing in a text field", () => {
    const r = rig(400, 300);
    r.stroke(line(40, 120, 50));
    const slider = { tagName: "INPUT", type: "range", isContentEditable: false };
    const picker = { tagName: "INPUT", type: "color", isContentEditable: false };
    const z = keydown(r.win, "z", { ctrl: true, target: slider });
    assert.equal(z.defaultPrevented, true);
    assert.equal(r.at(80, 50), null, "Ctrl+Z right after dragging Brush size undoes, as the board's hint promises");
    keydown(r.win, "z", { ctrl: true, shift: true, target: picker });
    assert.equal(r.at(80, 50), SKY, "Ctrl+Shift+Z from the colour picker redoes");
    keydown(r.win, "e", { target: slider });
    assert.equal(r.last().erasing, true, "E from the slider is the eraser");
    keydown(r.win, "e", { target: picker });
    assert.equal(r.last().erasing, false, "and from the colour picker");
    keydown(r.win, "e", { target: { tagName: "BUTTON", isContentEditable: false } });
    assert.equal(r.last().erasing, true, "and from a toolbar button");
    keydown(r.win, "e");

    for (const type of ["text", "search", "email", "url", "tel", "password", "number", "date", undefined]) {
      const field = { tagName: "INPUT", type, isContentEditable: false };
      keydown(r.win, "e", { target: field });
      assert.equal(r.last().erasing, false, `E typed into an input of type ${type ?? "(none)"} is a letter`);
      const typed = keydown(r.win, "z", { ctrl: true, target: field });
      assert.equal(typed.defaultPrevented, false, `Ctrl+Z in an input of type ${type ?? "(none)"} is the field's own undo`);
    }
    assert.equal(r.at(80, 50), SKY, "nothing typed into a field undid the board");
  });

  // -- review round 3: leaving the page ------------------------------------
  await check("leaving: with ink on the board a refresh or a closed tab asks first; an empty board asks nothing and listens for nothing", () => {
    const r = rig(400, 300);
    const leave = () => {
      const e = {
        type: "beforeunload",
        returnValue: "" as unknown,
        defaultPrevented: false,
        preventDefault() {
          e.defaultPrevented = true;
        },
      };
      r.win.events.dispatch("beforeunload", e);
      return e;
    };
    assert.equal(leave().defaultPrevented, false, "an empty board lets the page go");
    assert.ok(!r.win.events.types().includes("beforeunload"), "and adds no listener, so Back and Forward can keep the page cached");
    r.stroke(line(40, 140, 60));
    const asked = leave();
    assert.equal(asked.defaultPrevented, true, "ink on the board: the browser asks before a refresh or close wipes it");
    assert.ok(asked.returnValue, "including browsers that only look at returnValue");
    r.board.clear();
    assert.equal(leave().defaultPrevented, false, "after Clear the board is empty: nothing to lose");
    r.board.undo();
    assert.equal(leave().defaultPrevented, true, "Undo brought the drawing back, so it asks again");
    r.board.dispose();
    assert.equal(leave().defaultPrevented, false, "a board that has left the page never holds the page");
    assert.equal(r.win.attached(), 0);
  });

  // -- download ------------------------------------------------------------
  await check("Download: today's file name, everything drawn (even past a shrunken edge), the board colour behind it and under erased ink", () => {
    const r = rig(800, 400);
    r.stroke(line(720, 790, 200));
    r.stroke(line(100, 300, 100));
    keydown(r.win, "e");
    r.stroke([[200, 100]]);
    resize(r.container, 400, 400);
    r.board.download();
    assert.equal(r.doc.anchors.length, 1);
    const link = r.doc.anchors[0];
    assert.equal(link.clicks, 1, "the download starts");
    assert.equal(link.download, "Oasis-Whiteboard-2026-10-08.png");
    assert.match(link.href, /^data:image\/png;base64,/);
    const sheet = r.doc.canvases.find((c) => c.encodes > 0)!;
    assert.ok(sheet.width >= 790, `the picture is as wide as the drawing, not the smaller board: ${sheet.width}`);
    assert.equal(sheet.colorAt(770, 200), SKY, "the stroke past the board's current edge is in it");
    assert.equal(sheet.colorAt(150, 100), SKY);
    assert.equal(sheet.colorAt(5, 5), BOARD_BG, "the board colour, not a transparent background");
    assert.equal(sheet.colorAt(200, 100), BOARD_BG, "where the eraser went, the board colour (not a hole)");

    r.doc.encodeFails = true;
    r.board.download();
    assert.equal(r.doc.anchors.length, 1, "a picture the browser could not make is not offered as a file");
    assert.equal(r.last().notice, "download_failed", "the board says so instead");
    r.doc.encodeFails = false;
    r.board.download();
    assert.equal(r.doc.anchors.length, 2, "the next try saves the picture");
    assert.equal(r.last().notice, null, "and the failure line goes away");

    // A 2x screen (a phone, a retina laptop) saves a 2x picture, as sharp as the board looked.
    const hi = rig(400, 300, 2);
    hi.stroke(line(100, 300, 150));
    hi.board.download();
    const pic = hi.doc.canvases.find((c) => c.encodes > 0)!;
    assert.equal(pic.width, 800, "twice the board's width in pixels");
    assert.equal(pic.height, 600);
    assert.equal(pic.colorAt(400, 300), SKY, "the stroke at its place on the 2x picture");
  });

  await check("the download's background is the colour the board shows on screen: --c-bg-deep in app/globals.css", () => {
    const css = readFileSync(join(root, "app/globals.css"), "utf8");
    const m = /--c-bg-deep:\s*(\d+)\s+(\d+)\s+(\d+)\s*;/.exec(css);
    assert.ok(m, "app/globals.css defines --c-bg-deep");
    const hex = `#${m!.slice(1, 4).map((c) => Number(c).toString(16).padStart(2, "0")).join("")}`;
    assert.equal(BOARD_BG, hex, "BOARD_BG is the token behind the board's bg-bg-deep");
  });

  // -- unmount -------------------------------------------------------------
  await check("dispose removes every listener the board added, and nothing reaches the page afterwards", () => {
    const r = rig(400, 300);
    const ro = FakeResizeObserver.live[FakeResizeObserver.live.length - 1];
    assert.deepEqual(ro.targets, [r.container], "the board watches its container's size");
    assert.deepEqual(r.canvas.listeners.types(), ["lostpointercapture", "pointerdown", "pointermove"]);
    assert.deepEqual(r.win.events.types(), ["keydown", "pointercancel", "pointerup"]);
    assert.equal(r.win.queryListeners(), 1, "and the screen's pixel ratio");
    r.stroke(line(40, 140, 60));
    assert.deepEqual(r.win.events.types(), ["beforeunload", "keydown", "pointercancel", "pointerup"], "with ink on the board, the leave question too");
    r.board.dispose();
    assert.equal(r.canvas.listeners.count(), 0, "canvas listeners removed");
    assert.equal(r.win.attached(), 0, "window and media-query listeners removed");
    assert.equal(ro.disconnected, true, "the ResizeObserver is disconnected");
    const before = r.states.length;
    const inked = r.canvas.inked();
    pointer(r.canvas, r.win, "pointerdown", 10, 10);
    keydown(r.win, "e");
    r.win.setRatio(2);
    resize(r.container, 200, 200);
    r.board.setColor(GREEN);
    r.board.setSize(9);
    r.board.toggleEraser();
    assert.equal(r.states.length, before, "no state reaches an unmounted page, even from a late toolbar call");
    assert.equal(r.win.attached(), 0, "and nothing is attached again");
    assert.equal(r.canvas.inked(), inked);
  });

  // -- the component itself ------------------------------------------------
  await check("OasisWhiteboard mounts the board on its own canvas, its buttons drive it, and unmounting leaves nothing attached", async () => {
    const reactPath = require.resolve("react");
    const savedReact = require.cache[reactPath];
    require.cache[reactPath] = { id: reactPath, filename: reactPath, path: dirname(reactPath), loaded: true, children: [], paths: [], exports: ReactStub } as unknown as NodeModule;
    const g = globalThis as unknown as Record<string, unknown>;
    const win = new FakeWindow();
    const doc = new FakeDocument();
    g.React = ReactStub;
    g.window = win;
    g.document = doc;
    try {
      const { OasisWhiteboard } = await import("../components/founders/OasisWhiteboard");
      const render = () => {
        hookAt = 0;
        return expand(OasisWhiteboard());
      };
      let tree = render();
      const canvasEl = nodes(tree).find((n) => n.type === "canvas");
      const containerEl = nodes(tree).find((n) => n.type === "div" && n.props.ref && nodes(n.props.children).includes(canvasEl!));
      assert.ok(canvasEl && containerEl, "a canvas inside a sized container");
      const canvas = new RasterCanvas();
      const container: FakeContainer = { clientWidth: 400, clientHeight: 300 };
      (canvasEl!.props.ref as { current: unknown }).current = canvas;
      (containerEl!.props.ref as { current: unknown }).current = container;
      assert.equal(pendingEffects.length, 1, "one mount effect");
      const cleanup = pendingEffects[0]();
      assert.equal(typeof cleanup, "function", "the effect returns its cleanup");
      assert.equal(canvas.width, 400, "the effect sized the canvas to its container");
      const hint = (t: unknown) => nodes(t).find((n) => n.type === "p" && n.props["aria-live"] === "polite")!;
      const slider = (t: unknown) => nodes(t).find((n) => n.type === "input" && n.props.type === "range")!;
      tree = render();
      assert.match(String(hint(tree).props.className), /\bopacity-75\b/, "the how-to hint shows on an empty board");

      (slider(tree).props.onChange as (e: unknown) => void)({ target: { value: "12" } });
      tree = render();
      assert.equal(slider(tree).props.value, 12, "moving the Brush size slider sets the size");
      for (const [type, x] of [["pointerdown", 40], ["pointermove", 80], ["pointermove", 120], ["pointerup", 120]] as const) {
        pointer(canvas, win, type, x, 60);
      }
      assert.equal(canvas.colorAt(80, 60), SKY, "a stroke drawn on the page's canvas");
      assert.equal(canvas.colorAt(80, 65), SKY, "at the size the slider set (12 px: 6 each side)");
      assert.equal(canvas.colorAt(80, 68), null);
      tree = render();
      assert.match(String(hint(tree).props.className), /\bopacity-0\b/, "the hint goes once the first stroke starts");
      assert.equal(button(tree, "Clear").props.disabled, false);
      assert.equal(button(tree, "Redo").props.disabled, true);
      (button(tree, "Clear").props.onClick as () => void)();
      assert.equal(canvas.colorAt(80, 60), null, "the Clear button empties the board at once");
      tree = render();
      assert.match(textOf(tree), /Board cleared\. Undo brings it back\./);
      (button(tree, "Undo").props.onClick as () => void)();
      assert.equal(canvas.colorAt(80, 60), SKY, "the Undo button brings it back");
      tree = render();
      (button(tree, "Eraser").props.onClick as () => void)();
      tree = render();
      assert.equal(button(tree, "Eraser").props["aria-pressed"], true, "the Eraser button shows it is on");
      assert.equal(button(tree, "Draw in Sky").props["aria-pressed"], false);

      (cleanup as () => void)();
      assert.equal(canvas.listeners.count(), 0, "unmount removed the canvas listeners");
      assert.equal(win.attached(), 0, "and the window's");
      assert.ok(FakeResizeObserver.live.filter((ro) => ro.targets.includes(container)).length === 0, "and stopped watching the container");
    } finally {
      if (savedReact) require.cache[reactPath] = savedReact;
      else delete require.cache[reactPath];
      delete g.window;
      delete g.document;
    }
  });

  // -- the toolbar, as the server draws it ---------------------------------
  await check("every control has a 44 x 44 px target at phone and desktop widths; colour and eraser carry aria-pressed", () => {
    const m = renderMarkup([
      { id: "page", kind: "page" },
      { id: "start", kind: "toolbar", ui: {} },
      { id: "erasing", kind: "toolbar", ui: { erasing: true, empty: false, canUndo: true } },
      { id: "custom", kind: "toolbar", ui: { color: "#123456", empty: false, canUndo: true, canRedo: true } },
    ]);
    const tags = tagsOf(m.start);
    const group = tags.find((t) => t.attrs.role === "group");
    assert.equal(group?.attrs["aria-label"], "Whiteboard tools");
    assert.ok(classesOf(group!).includes("flex-wrap"), "the toolbar wraps on a phone instead of running off the screen");
    assert.ok(!classesOf(group!).some((c) => /(^|:)absolute$/.test(c)), "the toolbar never floats over the drawing");

    const buttons = tags.filter((t) => t.name === "button");
    assert.equal(buttons.length, 11, "6 colours + Eraser, Undo, Redo, Clear, Download");
    const range = tags.find((t) => t.name === "input" && t.attrs.type === "range")!;
    const colorInput = tags.find((t) => t.name === "input" && t.attrs.type === "color")!;
    const colorLabel = tags.filter((t) => t.name === "label" && t.index < colorInput.index).pop()!;
    assert.deepEqual(classesOf(colorInput).filter((c) => ["absolute", "inset-0", "h-full", "w-full"].includes(c)).sort(), ["absolute", "h-full", "inset-0", "w-full"], "the colour picker fills its label");
    for (const bp of BREAKPOINTS) {
      for (const t of [...buttons, colorLabel, range]) {
        const name = t.attrs["aria-label"] ?? t.name;
        assert.ok(minSide(classesOf(t), "h", bp) >= 44, `${name} is at least 44 px tall at ${bp || "phone"} width: ${t.attrs.class}`);
        if (t !== range) assert.ok(minSide(classesOf(t), "w", bp) >= 44, `${name} is at least 44 px wide at ${bp || "phone"} width`);
      }
    }
    assert.ok(minSide(classesOf(range), "w", "") >= 100, "the size slider is long enough to steer");
    for (const thumb of ["[&::-webkit-slider-thumb]:h-11", "[&::-webkit-slider-thumb]:w-11", "[&::-moz-range-thumb]:h-11", "[&::-moz-range-thumb]:w-11"]) {
      assert.ok(classesOf(range).includes(thumb), `the slider's handle is a 44 px target (${thumb})`);
    }
    assert.equal(range.attrs["aria-label"], "Brush size");
    assert.equal(colorInput.attrs["aria-label"], "Pick any color");
    for (const b of buttons) assert.ok((b.attrs["aria-label"] ?? "").length > 2, "every button has a name, even when a phone shows only its icon");

    const pressed = (html: string) =>
      tagsOf(html)
        .filter((t) => t.name === "button" && t.attrs["aria-pressed"] === "true")
        .map((t) => t.attrs["aria-label"]);
    assert.deepEqual(pressed(m.start), ["Draw in Sky"], "at the start: the Sky pen");
    assert.deepEqual(pressed(m.erasing), ["Eraser"], "erasing: no colour is on");
    assert.deepEqual(pressed(m.custom), [], "a colour from the picker: no swatch claims it");
    for (const b of buttons) assert.ok(b.attrs["aria-pressed"] !== undefined || ["Undo", "Redo", "Clear", "Download"].includes(b.attrs["aria-label"]), `${b.attrs["aria-label"]} says whether it is on`);

    const disabled = (html: string) =>
      tagsOf(html)
        .filter((t) => t.name === "button" && "disabled" in t.attrs)
        .map((t) => t.attrs["aria-label"]);
    assert.deepEqual(disabled(m.start), ["Undo", "Redo", "Clear", "Download"], "nothing to undo, clear or download on an empty board");
    assert.deepEqual(disabled(m.erasing), ["Redo"]);
    assert.deepEqual(disabled(m.custom), []);

    const page = tagsOf(m.page);
    const canvas = page.find((t) => t.name === "canvas")!;
    const boardBox = page.filter((t) => t.name === "div" && t.index < canvas.index).pop()!;
    assert.ok(classesOf(boardBox).includes("bg-bg-deep"), "the board shows bg-bg-deep behind its transparent canvas: the colour a download is filled with");
    assert.equal(canvas.attrs.role, "img");
    assert.match(canvas.attrs["aria-label"], /Whiteboard/);
    assert.ok(classesOf(canvas).includes("touch-none"), "a finger on the board draws instead of scrolling the page");
    assert.ok(page.findIndex((t) => t.attrs.role === "group") < page.indexOf(canvas), "the toolbar comes before (above) the board");
    assert.match(m.page, /Draw with your finger or a pen\./, "the phone hint");
    assert.match(m.page, /Drag to sketch/, "the desktop hint");
  });

  // -- source rules --------------------------------------------------------
  await check("client-only and ASCII: no window or document outside a function; the page says the board is not saved", () => {
    const files = ["components/founders/OasisWhiteboard.tsx", "components/founders/whiteboard-model.ts", "components/founders/whiteboard-surface.ts"];
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      assert.doesNotMatch(src, /[^\x00-\x7f]/, `${f} is ASCII (tests/worker-source-one-byte.test.ts)`);
      const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const atModuleScope: string[] = [];
      const visit = (n: ts.Node, inFunction: boolean): void => {
        if (!inFunction && ts.isIdentifier(n) && ["window", "document", "navigator", "localStorage"].includes(n.text)) {
          atModuleScope.push(`${n.text} at line ${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`);
        }
        ts.forEachChild(n, (c) => visit(c, inFunction || ts.isFunctionLike(n)));
      };
      visit(sf, false);
      assert.deepEqual(atModuleScope, [], `${f} touches the browser only inside functions (it is server-rendered too)`);
    }
    const page = readFileSync(join(root, "app/founders/marketing/tools/page.tsx"), "utf8");
    assert.match(page, /The board is not saved when you leave this page: Download keeps a picture of it\./);
  });

  if (failures > 0) {
    console.error(`oasis-whiteboard: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("oasis-whiteboard: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
