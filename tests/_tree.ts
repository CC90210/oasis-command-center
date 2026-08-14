/**
 * Shared tree-walk for the STATIC whole-tree tests.
 *
 * tests/portal-boundaries.test.ts established the pattern: some properties are
 * true of the whole source tree ("no portal imports another", "nothing fetches a
 * font at build time") and cannot be established by exercising any one function.
 * Each such test needs the same walker, and I copied it twice in one sitting
 * before noticing — so it lives here now.
 *
 * Deliberately dependency-free and tiny: these tests run under bare tsx with no
 * test framework, and a helper that needs its own setup would defeat the point.
 */
import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export const REPO_ROOT = join(__dirname, "..");

/** Never walk into these — build output and vendored code are not our source. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "__pycache__", "coverage"]);

/** Every .ts/.tsx file under `dir`, recursively. Missing dir = empty, not a throw. */
export function walkSource(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkSource(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Absolute path -> repo-relative, forward slashes, so messages read the same on Windows and CI. */
export function repoRelative(file: string): string {
  return file.slice(REPO_ROOT.length + 1).split(sep).join("/");
}

/**
 * Walk several top-level directories at once.
 * `sourceTree("app", "lib", "components")` is the common case.
 */
export function sourceTree(...dirs: string[]): string[] {
  return dirs.flatMap((d) => walkSource(join(REPO_ROOT, d)));
}
