/**
 * video-picker-ids.test.ts - two VideoPicker instances in one tree (the
 * shape WhatYouGetItems' per-item demo video renders) get DISTINCT ids for
 * their upload file/poster/caption inputs, never the same fixed string.
 *
 * WHY THIS EXISTS (Codex review of e99e9a90, P2)
 * VideoPicker's upload-mode <input id="video-picker-upload-file"> (and the
 * poster/caption inputs) used a fixed string id. With two pickers open at
 * once, both inputs shared one id: clicking the SECOND picker's label
 * activated the FIRST picker's file input, uploading into the wrong item and
 * leaving the second input's label pointing at nothing of its own.
 *
 * WHAT IS PINNED
 * Each picker now derives its ids from React's own useId(), which assigns a
 * distinct value per component instance by tree position. The upload inputs
 * only exist in the DOM once mode==="upload" (an interactive click this
 * static server render cannot drive), so this reads the SAME useId() value
 * off a stable data attribute (data-picker-instance) present in every mode -
 * proving the root cause fixed (useId(), not a fixed string) without
 * needing a real browser click.
 *
 * Run: node --conditions=react-server --import tsx tests/video-picker-ids.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

function render(): string {
  const childNodeOptions = (process.env.NODE_OPTIONS || "")
    .split(/\s+/)
    .filter((tok) => tok && !/^(--conditions|-C)(=|$)/.test(tok) && tok !== "react-server")
    .join(" ");
  const childEnv: NodeJS.ProcessEnv = { ...process.env, NODE_OPTIONS: childNodeOptions };
  if (!childNodeOptions) delete childEnv.NODE_OPTIONS;
  const child = spawnSync(process.execPath, ["--import", "tsx", "tests/video-picker-ids.render.ts"], {
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    cwd: ROOT,
  });
  assert.equal(child.status, 0, `render child failed:\n${child.stderr}`);
  return (JSON.parse(child.stdout) as { markup: string }).markup;
}

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures += 1;
    console.log(`  FAIL  ${name}\n        ${(e as Error).message}`);
  }
}

console.log("video-picker-ids:");
const markup = render();

check("two sibling pickers get two DIFFERENT instance ids, never the same value", () => {
  const ids = [...markup.matchAll(/data-picker-instance="([^"]*)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 2, `expected exactly two pickers in the markup, got ${ids.length}`);
  assert.notEqual(ids[0], "", "an empty instance id");
  assert.notEqual(ids[1], "", "an empty instance id");
  assert.notEqual(ids[0], ids[1], "both pickers share one instance id - the regression this test exists to catch");
});

check("the upload inputs' ids are built from that SAME per-instance value (source-level: VideoPicker never falls back to a fixed string)", () => {
  const src = readFileSync(join(ROOT, "components", "offer-pages", "builder", "VideoPicker.tsx"), "utf8");
  assert.match(src, /const instanceId = useId\(\);/, "VideoPicker no longer calls useId()");
  for (const idVar of ["fileInputId", "posterInputId", "captionInputId"]) {
    assert.match(src, new RegExp(`const ${idVar} = \\\`\\$\\{instanceId\\}-`), `${idVar} is not derived from useId()'s instanceId`);
  }
  assert.doesNotMatch(src, /id="video-picker-upload-(file|poster|captions)"/, "a fixed-string id literal is still present");
});

if (failures) {
  console.log(`video-picker-ids: ${failures} failure(s)`);
  process.exit(1);
}
console.log("video-picker-ids: all passed");
