/**
 * The Oasis Whiteboard's drawing, kept as data.
 *
 * Every stroke is its points in board coordinates: CSS pixels from the board's
 * top-left corner, whatever size the canvas is at the moment. The canvas is
 * only a picture of this list. A resize, a phone rotation or a
 * devicePixelRatio change draws the list again at the new size, so a smaller
 * board hides part of a drawing but never loses it. (The first version copied
 * the canvas bitmap across a resize and kept only what fit the smaller board:
 * growing it again could not bring the rest back.)
 *
 * Clear, Undo and Redo are list operations, done the moment they are asked
 * for. Nothing is deferred, so a stroke started right after Clear can never be
 * erased by it, and a Clear can always be undone.
 *
 * Pure: no window, no document, no timers. whiteboard-surface.ts binds it to a
 * real canvas; tests/oasis-whiteboard.test.ts drives both.
 */

export const PALETTE = [
  { color: "#38bdf8", name: "Sky" },
  { color: "#d946ef", name: "Magenta" },
  { color: "#ec4899", name: "Pink" },
  { color: "#22c55e", name: "Green" },
  { color: "#f59e0b", name: "Amber" },
  { color: "#f8fafc", name: "White" },
] as const;

export const DEFAULT_COLOR: string = PALETTE[0].color;
export const DEFAULT_SIZE = 4;
export const MIN_SIZE = 1;
export const MAX_SIZE = 50;
/**
 * The board's colour on screen: the container's `bg-bg-deep`, which is
 * --c-bg-deep (7 7 8) in app/globals.css. A download is filled with it, so the
 * picture is the board the presenter saw; tests/oasis-whiteboard.test.ts reads
 * the token from globals.css, so the two cannot drift apart.
 */
export const BOARD_BG = "#070708";
/** The eraser is this much wider than the pen at the same size setting. */
export const ERASER_SCALE = 2.5;
/** The pen's soft edge, as canvas shadowBlur in board pixels. */
export const PEN_GLOW = 4;
/** iOS Safari draws nothing at all on a canvas over 4096 x 4096 device pixels. */
export const MAX_CANVAS_PIXELS = 4096 * 4096;
/**
 * A pointer sample closer than this to the stroke's last point, in board
 * pixels, is dropped. A pen held still keeps reporting (pressure, tilt) and a
 * slow drag is sampled faster than it moves; both would only add points that
 * every redraw (Undo, Redo, a resize) has to paint again.
 */
export const MIN_POINT_GAP = 1.5;

export type Tool = "pen" | "eraser";

export type Stroke = {
  readonly tool: Tool;
  readonly color: string;
  readonly size: number;
  /** x0, y0, x1, y1, ... in board coordinates (CSS pixels). */
  readonly points: number[];
};

type Step = { kind: "stroke"; stroke: Stroke } | { kind: "clear"; strokes: Stroke[] };

export type Board = {
  /** What is on the board, oldest first. Order matters: the eraser removes what came before it. */
  strokes: Stroke[];
  /** The stroke a pointer is drawing right now; it is already in `strokes`. */
  active: Stroke | null;
  undo: Step[];
  redo: Step[];
};

/** The canvas size in board pixels, and how many device pixels it holds per board pixel. */
export type View = { width: number; height: number; scale: number };

/** The subset of the 2D canvas context the board draws with. */
export type BoardContext = Pick<
  CanvasRenderingContext2D,
  | "globalCompositeOperation"
  | "lineWidth"
  | "lineCap"
  | "lineJoin"
  | "strokeStyle"
  | "fillStyle"
  | "shadowBlur"
  | "shadowColor"
  | "setTransform"
  | "clearRect"
  | "beginPath"
  | "moveTo"
  | "lineTo"
  | "quadraticCurveTo"
  | "arc"
  | "fill"
  | "stroke"
>;

export function createBoard(): Board {
  return { strokes: [], active: null, undo: [], redo: [] };
}

/** Starts a stroke at (x, y). A stroke still open is finished first. */
export function beginStroke(board: Board, tool: Tool, color: string, size: number, x: number, y: number): Stroke {
  endStroke(board);
  const stroke: Stroke = { tool, color, size, points: [x, y] };
  board.strokes.push(stroke);
  board.active = stroke;
  return stroke;
}

/**
 * Adds a point to the open stroke. Null when nothing was added: no stroke is
 * open (it was cleared or undone mid-draw), or the point is within
 * MIN_POINT_GAP of the stroke's last point.
 */
export function extendStroke(board: Board, x: number, y: number): Stroke | null {
  const stroke = board.active;
  if (!stroke) return null;
  const p = stroke.points;
  if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) < MIN_POINT_GAP) return null;
  p.push(x, y);
  return stroke;
}

/** Finishes the open stroke, so Undo can take it back. A new stroke ends Redo. */
export function endStroke(board: Board): void {
  const stroke = board.active;
  if (!stroke) return;
  board.active = null;
  board.undo.push({ kind: "stroke", stroke });
  board.redo = [];
}

/** Empties the board in one step Undo can reverse. An empty board is left alone (nothing to undo). */
export function clearBoard(board: Board): boolean {
  endStroke(board);
  if (board.strokes.length === 0) return false;
  board.undo.push({ kind: "clear", strokes: board.strokes });
  board.strokes = [];
  board.redo = [];
  return true;
}

export function undoStep(board: Board): boolean {
  endStroke(board);
  const step = board.undo.pop();
  if (!step) return false;
  if (step.kind === "stroke") {
    const at = board.strokes.lastIndexOf(step.stroke);
    if (at >= 0) board.strokes.splice(at, 1);
  } else {
    board.strokes = [...step.strokes, ...board.strokes];
  }
  board.redo.push(step);
  return true;
}

export function redoStep(board: Board): boolean {
  endStroke(board);
  const step = board.redo.pop();
  if (!step) return false;
  if (step.kind === "stroke") {
    board.strokes.push(step.stroke);
    board.undo.push(step);
  } else {
    board.undo.push({ kind: "clear", strokes: board.strokes });
    board.strokes = [];
  }
  return true;
}

export function canUndo(board: Board): boolean {
  return board.undo.length > 0 || board.active !== null;
}

export function canRedo(board: Board): boolean {
  return board.redo.length > 0;
}

/** The line width a stroke draws with, in board pixels. */
export function strokeWidth(stroke: Stroke): number {
  return stroke.tool === "eraser" ? stroke.size * ERASER_SCALE : stroke.size;
}

/**
 * Device pixels per board pixel for a canvas of this size: the screen's
 * devicePixelRatio, lowered only as far as keeps the canvas under
 * MAX_CANVAS_PIXELS.
 */
export function backingScale(width: number, height: number, dpr: number): number {
  const wanted = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const area = width * height;
  if (!(area > 0)) return wanted;
  return Math.min(wanted, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

/** The canvas bitmap size, in device pixels, for a view. */
export function backingSize(view: View): { width: number; height: number } {
  return {
    width: Math.max(0, Math.floor(view.width * view.scale)),
    height: Math.max(0, Math.floor(view.height * view.scale)),
  };
}

/** A pointer's position on the board, from the canvas's box on screen. */
export function boardPoint(clientX: number, clientY: number, box: { left: number; top: number }): [number, number] {
  return [clientX - box.left, clientY - box.top];
}

function applyBrush(ctx: BoardContext, stroke: Stroke): void {
  ctx.lineWidth = strokeWidth(stroke);
  if (stroke.tool === "eraser") {
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0,0,0,1)";
    ctx.fillStyle = "rgba(0,0,0,1)";
    ctx.shadowBlur = 0;
  } else {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.shadowBlur = PEN_GLOW;
    ctx.shadowColor = stroke.color;
  }
}

/**
 * Draws a stroke from point `from` on. Point 0 is a dot; every later point is
 * a quadratic curve from the previous midpoint to the new one, through the
 * previous point (the standalone whiteboard's smoothing). Live drawing calls
 * this once per new point, a full redraw calls it from 0, and both issue the
 * same calls, so a redrawn board looks exactly like the one drawn live.
 *
 * The brush is set once per call, not once per point: nothing in the loop
 * changes it, and a full redraw of a long session paints tens of thousands of
 * points.
 */
export function drawStroke(ctx: BoardContext, stroke: Stroke, from = 0): void {
  const p = stroke.points;
  const count = p.length / 2;
  const start = Math.max(0, from);
  if (start < count) applyBrush(ctx, stroke);
  for (let i = start; i < count; i += 1) {
    ctx.beginPath();
    if (i === 0) {
      ctx.arc(p[0], p[1], strokeWidth(stroke) / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    const px = p[2 * i - 2];
    const py = p[2 * i - 1];
    ctx.moveTo(i === 1 ? px : (p[2 * i - 4] + px) / 2, i === 1 ? py : (p[2 * i - 3] + py) / 2);
    ctx.quadraticCurveTo(px, py, (px + p[2 * i]) / 2, (py + p[2 * i + 1]) / 2);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
}

/**
 * The last stretch of a finished stroke, from its final midpoint to the point
 * where the pointer lifted. Each curve in drawStroke stops at a midpoint, so
 * without this a quick flick (one move) would end halfway to the pointer.
 * Drawn once the stroke is finished, never while it is still being drawn.
 */
export function drawStrokeEnd(ctx: BoardContext, stroke: Stroke): void {
  const p = stroke.points;
  const last = p.length / 2 - 1;
  if (last < 1) return;
  const x = p[2 * last];
  const y = p[2 * last + 1];
  applyBrush(ctx, stroke);
  ctx.beginPath();
  ctx.moveTo((p[2 * last - 2] + x) / 2, (p[2 * last - 1] + y) / 2);
  ctx.lineTo(x, y);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/** Wipes the canvas and draws every stroke on the board, in order, at the view's scale. */
export function renderBoard(ctx: BoardContext, board: Board, view: View): void {
  const size = backingSize(view);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, size.width, size.height);
  ctx.setTransform(view.scale, 0, 0, view.scale, 0, 0);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const stroke of board.strokes) {
    drawStroke(ctx, stroke);
    if (stroke !== board.active) drawStrokeEnd(ctx, stroke);
  }
}

/**
 * The area a download covers: the board as it is now, grown to take in any
 * pen stroke past its right or bottom edge (drawn on a bigger board before a
 * resize), so the picture holds everything on the board.
 */
export function exportArea(board: Board, view: View): { width: number; height: number } {
  let width = view.width;
  let height = view.height;
  for (const stroke of board.strokes) {
    if (stroke.tool !== "pen") continue;
    const reach = strokeWidth(stroke) / 2 + PEN_GLOW;
    for (let i = 0; i < stroke.points.length; i += 2) {
      width = Math.max(width, stroke.points[i] + reach);
      height = Math.max(height, stroke.points[i + 1] + reach);
    }
  }
  return { width: Math.ceil(width), height: Math.ceil(height) };
}

/** "Oasis-Whiteboard-2026-10-08.png", on the presenter's own calendar day. */
export function downloadName(now: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `Oasis-Whiteboard-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.png`;
}
