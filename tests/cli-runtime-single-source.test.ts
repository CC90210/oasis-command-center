/**
 * The chat's CLI-runtime storage key must be declared exactly once.
 *
 * Settings → "Local AI CLIs" and the chat header both write which local
 * subscription powers a conversation, and they agree by using the same
 * localStorage slot. Until 2026-08-17 that key was a string literal declared
 * TWICE, kept in step by a comment:
 *
 *     // Keep the string in lock-step with components/ChatWidget.tsx
 *     // CLI_RUNTIME_STORAGE_KEY … the value sync is the contract.
 *
 * A contract enforced by a comment is not enforced. Change one literal and
 * nothing breaks loudly: Settings writes one key, the header reads another, the
 * selector silently stops reflecting the choice, and both screens keep rendering
 * a confident answer. No error, no log, no test — just a control that quietly
 * stops working.
 *
 * This is a repo invariant rather than a feature test, in the same spirit as
 * paged-reads-ordered: cheap to check, and the failure it prevents is invisible.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { CLI_RUNTIME_STORAGE_KEY, isCliRuntime, readCliRuntime } from "../lib/cli-runtime";

const ROOT = process.cwd();
const SEARCH_DIRS = ["app", "components", "lib"];
const OWNER = join("lib", "cli-runtime.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

test("the storage key literal appears in exactly one file", () => {
  const files = SEARCH_DIRS.flatMap((d) => walk(join(ROOT, d)));
  const holders = files.filter((f) =>
    readFileSync(f, "utf8").includes(CLI_RUNTIME_STORAGE_KEY),
  );
  const relative = holders.map((f) => f.slice(ROOT.length + 1));

  assert.deepEqual(
    relative,
    [OWNER],
    `the CLI-runtime storage key must live only in ${OWNER}. Found in:\n  ` +
      relative.join("\n  ") +
      "\nImport CLI_RUNTIME_STORAGE_KEY instead of re-declaring the string — two " +
      "copies desync silently and the runtime picker just stops working.",
  );
});

test("the shared accessors behave on a server render", () => {
  // Both callers are client components that also render on the server, where
  // `window` is absent. Defaulting rather than throwing is the contract.
  assert.equal(readCliRuntime(), "claude");
});

test("only the three real runtimes validate", () => {
  for (const ok of ["claude", "codex", "gemini"]) assert.ok(isCliRuntime(ok));
  for (const bad of ["", "CLAUDE", "gpt", null, undefined, 3]) {
    assert.equal(isCliRuntime(bad), false, `${String(bad)} must not validate`);
  }
});
