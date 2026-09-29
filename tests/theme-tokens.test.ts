/**
 * Theme tokens: variables that resolve, names that did not move, contrast that
 * clears AA.
 *
 * WHY. The OASIS OS re-theme turned every dashboard colour into a CSS variable
 * (tailwind.config.ts → app/globals.css :root). Three silent failures follow
 * from that and none of them shows up in a build:
 *
 *   1. A token pointing at an undefined variable renders transparent/black.
 *      This app has been here before — `bg-bg-deep` was referenced by ~85
 *      components before it was defined and every overlay rendered see-through.
 *   2. A renamed token breaks the public light form. `.form-light` remaps the
 *      dark palette BY CLASS NAME for a prospect-facing form; a rename drops it
 *      back to dark with nothing failing.
 *   3. A re-valued grey falls under WCAG AA. The design spec's own #75757d
 *      measured 4.3:1 on the canvas; this test is how that was caught.
 *
 * Run: node --conditions=react-server --import tsx tests/theme-tokens.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import config from "../tailwind.config";

// Comments stripped: a prose mention like "rgb(var(--c-x) / …)" is not a use.
// CRLF normalised: the checkout is CRLF on Windows (core.autocrlf) and LF in CI.
const css = readFileSync(join(process.cwd(), "app", "globals.css"), "utf8")
  .replace(/\r\n/g, "\n")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const colors = (config.theme?.extend?.colors ?? {}) as Record<string, string | Record<string, string>>;

// ── parse :root ───────────────────────────────────────────────────────────
const rootBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/);
assert.ok(rootBlock, "globals.css must have a :root block");
const defined = new Map<string, string>();
for (const m of rootBlock![1].matchAll(/(--c-[a-z0-9-]+)\s*:\s*([^;]+);/g)) defined.set(m[1], m[2].trim());

type Leaf = { path: string; value: string };
const leaves: Leaf[] = [];
for (const [ns, v] of Object.entries(colors)) {
  if (typeof v === "string") leaves.push({ path: ns, value: v });
  else for (const [k, inner] of Object.entries(v)) leaves.push({ path: k === "DEFAULT" ? ns : `${ns}.${k}`, value: inner });
}

// ── 1. every variable a token names is defined ────────────────────────────
let varRefs = 0;
for (const { path, value } of leaves) {
  for (const m of value.matchAll(/var\((--[a-z0-9-]+)\)/g)) {
    varRefs++;
    assert.ok(defined.has(m[1]), `tailwind colour ${path} uses ${m[1]}, which globals.css :root does not define`);
  }
}
// …and globals.css uses no --c- variable that :root forgot either.
for (const m of css.matchAll(/var\((--c-[a-z0-9-]+)\)/g)) {
  assert.ok(defined.has(m[1]), `globals.css uses ${m[1]} but :root does not define it`);
}

// ── 2. dashboard tokens are variables and take opacity modifiers ──────────
const FIXED_ALPHA = new Set(["accent.soft", "accent.glow", "hairline", "active", "active.hover"]);
for (const ns of ["bg", "fg", "accent", "status", "unread", "hairline", "active"]) {
  assert.ok(ns in colors, `colour namespace ${ns} is missing — a rename breaks every class that used it`);
}
for (const { path, value } of leaves) {
  const ns = path.split(".")[0];
  if (ns === "ops" || ns === "signal") {
    // The public marketing site keeps literal scales: a dashboard re-theme
    // must never restyle it.
    assert.ok(!value.includes("var("), `${path} is marketing-only and must stay literal`);
    continue;
  }
  assert.ok(value.includes("var(--c-"), `${path} must be a --c- variable (got ${value})`);
  if (!FIXED_ALPHA.has(path)) {
    assert.ok(value.includes("<alpha-value>"), `${path} must keep <alpha-value> so /40-style modifiers still work`);
  }
}
// The tokens the whole app depends on, by name. Never renamed.
const REQUIRED = [
  "bg", "bg.deep", "bg.panel", "bg.raised", "bg.elev", "bg.border", "bg.border-strong", "bg.hover", "bg.rail",
  "fg", "fg.muted", "fg.dim", "fg.faint", "accent", "accent.muted", "accent.soft", "accent.glow",
  "status.hot", "status.warm", "status.engaged", "status.info", "status.cold", "status.dormant", "status.lost",
  "unread", "hairline", "active", "active.hover",
];
const have = new Set(leaves.map((l) => l.path));
for (const token of REQUIRED) assert.ok(have.has(token), `token ${token} is missing`);

// ── 3. .form-light still names classes that exist ─────────────────────────
const tokenClass = /\.form-light\s+\.(text|bg|border|placeholder)-((?:bg|fg|accent|status)(?:-[a-z]+)*)/g;
let formLightRefs = 0;
for (const m of css.matchAll(tokenClass)) {
  formLightRefs++;
  const [ns, ...rest] = m[2].split("-");
  const key = rest.length ? rest.join("-") : "DEFAULT";
  const scale = colors[ns];
  const exists = typeof scale === "string" ? key === "DEFAULT" : !!scale && key in scale;
  assert.ok(exists, `.form-light remaps .${m[1]}-${m[2]}, but there is no ${ns}.${key} token — the light form would fall back to dark`);
}
assert.ok(formLightRefs >= 6, `expected the .form-light remap block, found ${formLightRefs} token selectors`);

// ── 4. the spec's values, and AA contrast on every surface ────────────────
function rgbOf(name: string): [number, number, number] {
  const raw = defined.get(name);
  assert.ok(raw, `${name} undefined`);
  const parts = raw!.split("/")[0].trim().split(/\s+/).map(Number);
  assert.equal(parts.length, 3, `${name} must be three space-separated channels (got "${raw}")`);
  return parts as [number, number, number];
}
const hex = (name: string) => "#" + rgbOf(name).map((c) => c.toString(16).padStart(2, "0")).join("");
assert.equal(hex("--c-bg-rail"), "#030304", "rail + window ground");
assert.equal(hex("--c-bg"), "#0a0a0b", "canvas");
assert.equal(hex("--c-bg-panel"), "#0e0e10", "panel");
assert.equal(hex("--c-bg-raised"), "#131315", "raised");
assert.equal(hex("--c-bg-elev"), "#18181b", "elev");
assert.equal(hex("--c-fg"), "#ededef", "text");
assert.equal(hex("--c-fg-muted"), "#a0a0a7", "muted text");
assert.equal(defined.get("--c-hairline"), "255 255 255 / 0.07", "hairline");
assert.equal(defined.get("--c-active"), "255 255 255 / 0.06", "neutral active row");

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const WHITE: [number, number, number] = [255, 255, 255];
const SURFACES = ["--c-bg-rail", "--c-bg", "--c-bg-deep", "--c-bg-panel", "--c-bg-raised", "--c-bg-elev"];
for (const text of ["--c-fg", "--c-fg-muted", "--c-fg-dim"]) {
  for (const surface of SURFACES) {
    const ratio = contrast(rgbOf(text), rgbOf(surface));
    assert.ok(ratio >= 4.5, `${text} on ${surface} is ${ratio.toFixed(2)}:1 — under WCAG AA 4.5:1`);
  }
}
for (const surface of ["--c-bg", "--c-bg-panel"]) {
  const ratio = contrast(rgbOf("--c-accent"), rgbOf(surface));
  assert.ok(ratio >= 4.5, `links (accent) on ${surface} are ${ratio.toFixed(2)}:1`);
}
for (const fill of ["--c-unread", "--c-accent-muted"]) {
  const ratio = contrast(WHITE, rgbOf(fill));
  assert.ok(ratio >= 4.5, `white text on ${fill} is ${ratio.toFixed(2)}:1 — pills and filled buttons carry small text`);
}

// ── 5. the retuned primitives stay flat ───────────────────────────────────
function rule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `globals.css must define ${selector}`);
  return m![1];
}
assert.ok(!/gradient/.test(rule(".btn-primary")), ".btn-primary must be flat — no gradient");
assert.ok(!/box-shadow/.test(rule(".btn-primary")), ".btn-primary must not glow");
assert.ok(!/box-shadow/.test(rule(".input:focus, .textarea:focus, .select:focus")), "focus is a border, not a halo ring");
assert.ok(!/uppercase/.test(rule(".label")), ".label is sentence case");
assert.ok(!/#[0-9a-f]{6}/i.test(rule("html,\nbody")), "the window ground reads the variable");
// Motion budget for the page entrance.
const pageIn = css.match(/main > div \{\s*animation:\s*pageIn\s+([\d.]+)s/);
assert.ok(pageIn && Number(pageIn[1]) <= 0.16, "page entrance must fit the 120-160ms motion budget");

console.log(
  `theme-tokens: OK — ${leaves.length} colour tokens, ${varRefs} variable refs defined, ` +
    `${formLightRefs} .form-light remaps resolve, AA holds on ${SURFACES.length} surfaces`,
);
