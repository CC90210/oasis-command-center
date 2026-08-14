/**
 * The founders Library must never crop a deliverable.
 * Run: npx tsx tests/media-frame.test.ts
 *
 * WHY THIS EXISTS
 * CC, 2026-08-14, twice: *"it is collapsed for some reason… It's super zoomed in, and I'm
 * not able to see anything."* A 1080x1920 film was rendering as a magnified middle band,
 * in the grid and in fullscreen.
 *
 * The cause was one word. Every tile was `aspect-video` and every video was
 * `object-cover` — cover means FILL AND CROP. Nothing failed, nothing logged, the bytes
 * were perfect, and the only detector was the founder opening the page. That is the kind
 * of defect that comes back, because the next person to write a media tile will reach for
 * `object-cover` again: it is what makes a grid look tidy.
 *
 * THE INVARIANT
 * `object-contain` on asset media. Not the aspect box — that is a nicety that makes a
 * vertical film fill its tile. `contain` is the actual guarantee: even if the aspect
 * column is null, wrong, or a value the UI has never seen, contain letterboxes and the
 * operator still sees the WHOLE frame. Cover crops, silently, forever.
 *
 * These assertions read SOURCE, deliberately. A render test would need a DOM, a signed
 * URL and a session; the defect lives in a class string, so a class string is what gets
 * checked. Same approach as tests/font-selfhost.test.ts and tests/shell-boundary.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SHARED = "components/founders/marketing-shared.tsx";
const shared = read(SHARED);

// ── 1. the invariant: asset media is contained, never covered ────────────────
// Scoped to the media element lines rather than the file, so the explanatory comment
// above the FRAME map (which necessarily contains the words "object-cover") does not
// trip the check. A test that cannot survive its own documentation is a test people
// delete.
const codeLines = shared
  .split("\n")
  .filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*"));

for (const el of ["<video", "<img"] as const) {
  const idx = codeLines.findIndex((l) => l.includes(el));
  assert.ok(idx >= 0, `${SHARED}: expected a ${el} element rendering asset media`);
  const block = codeLines.slice(idx, idx + 12).join("\n");
  assert.ok(
    !/object-cover/.test(block),
    `${SHARED}: ${el} uses object-cover — that crops a vertical asset to a zoomed middle band. ` +
      `Use object-contain: a library exists to show the whole frame.`,
  );
  assert.ok(
    /object-contain/.test(block),
    `${SHARED}: ${el} must declare object-contain so a non-16:9 asset is letterboxed, not cropped.`,
  );
}

// ── 2. the frame follows the asset, not the grid ─────────────────────────────
assert.ok(
  /const FRAME[^=]*=\s*\{/.test(shared),
  `${SHARED}: expected a FRAME map from aspect -> tailwind aspect class.`,
);
// Every aspect the writers can produce must have a frame. scripts/publish_to_library.py
// derives 9:16 / 16:9 / 1:1 from probed pixels; register-marketing-asset.ts also accepts
// 4:5. A missing entry is not fatal (contain still protects the frame) but it renders a
// vertical film small inside a wide box, which is the complaint one notch quieter.
for (const aspect of ["9:16", "4:5", "1:1", "16:9"]) {
  assert.ok(
    shared.includes(`"${aspect}"`),
    `${SHARED}: FRAME has no entry for ${aspect} — a ${aspect} asset would fall back to the 16:9 box.`,
  );
}
assert.ok(
  /FRAME\[[^\]]*aspect/.test(shared),
  `${SHARED}: the media container must select its frame FROM the asset's aspect, ` +
    `not hardcode one. A hardcoded box is how the crop shipped.`,
);

// ── 3. no other founders surface reintroduces the crop ───────────────────────
// The defect is a pattern, not a file. Any founders view that grows its own media
// element must obey the same rule.
const SURFACES = [
  "app/founders/marketing/library/page.tsx",
  "app/founders/marketing/page.tsx",
  "app/founders/marketing/train/page.tsx",
  "components/founders/TrainDropzone.tsx",
];
for (const f of SURFACES) {
  if (!existsSync(join(ROOT, f))) continue;
  const src = read(f);
  const media = src.split("\n").filter((l) => /<video|<img/.test(l));
  for (const line of media) {
    assert.ok(
      !/object-cover/.test(line),
      `${f}: media element uses object-cover — see ${SHARED} for why that crops.`,
    );
  }
}

// ── 4. the aspect the tile trusts is the aspect the writer computed ──────────
// publish_to_library.py derives aspect from ffprobe'd pixels rather than accepting a
// hand-typed value. If that ever regresses to a literal, the tile inherits the lie.
const BRIDGE = join(
  "C:\\Users\\User\\CMO-Agent",
  "scripts",
  "publish_to_library.py",
);
if (existsSync(BRIDGE)) {
  const bridge = readFileSync(BRIDGE, "utf8");
  assert.ok(
    /"aspect":\s*"9:16"\s*if\s*h\s*>\s*w/.test(bridge),
    "publish_to_library.py: aspect must be derived from probed height/width, never declared.",
  );
}

// ── 5. the guard must fail on the code that shipped the bug ──────────────────
// A check that has never been seen to fail is decoration. This runs the same predicate
// over the EXACT markup that was live this morning and asserts it is rejected — so if
// someone later loosens the rule to make a build pass, this line goes with it and the
// loosening is visible in the diff.
const REGRESSION = `
      <div className="relative aspect-video bg-bg-deep flex items-center justify-center overflow-hidden">
        <video
          src={playbackUrl}
          poster={posterUrl || undefined}
          controls
          playsInline
          preload="metadata"
          className="h-full w-full object-cover"
        />
`;
const wouldReject = (snippet: string): boolean => {
  const lines = snippet.split("\n");
  const i = lines.findIndex((l) => l.includes("<video"));
  if (i < 0) return false;
  const block = lines.slice(i, i + 12).join("\n");
  return /object-cover/.test(block) || !/object-contain/.test(block);
};
assert.equal(
  wouldReject(REGRESSION),
  true,
  "the guard does not reject the markup that caused the crop — it is not guarding anything",
);
assert.equal(
  wouldReject(`
      <div className={\`relative \${frame} bg-bg-deep\`}>
        <video src={playbackUrl} className="h-full w-full object-contain bg-black" />
`),
  false,
  "the guard rejects correct markup — it would be disabled within a week",
);

console.log("media-frame: ok — asset media is contained, the frame follows the asset,");
console.log("             and the guard still rejects this morning's markup");
