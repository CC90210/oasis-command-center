/**
 * Builds the geometry harness: the app's real Tailwind CSS, plus a real client
 * bundle of the real components.
 *
 * Nothing here is hand-written CSS or hand-written markup for the components
 * themselves. The whole value of the harness is that the pixels it measures
 * come from the same class strings the app ships; a harness with its own
 * stylesheet measures a layout nobody will ever see.
 *
 *   node .measure/build.mjs [baseline|current]
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const which = process.argv[2] === "baseline" ? "entry-baseline.tsx" : "entry.tsx";

// The package's JS entrypoint, run under this node, NOT the .bin shim: a
// .cmd shim cannot be spawned without a shell on Windows (EINVAL), and a shell
// here would mean interpolating paths into a command string.
const NODE = process.execPath;
const tailwindCli = path.join(repo, "node_modules", "tailwindcss", "lib", "cli.js");
const esbuildCli = path.join(repo, "node_modules", "esbuild", "bin", "esbuild");

console.log(`[harness] tailwind -> harness.css`);
execFileSync(
  NODE,
  [tailwindCli,"-c", path.join(here, "tailwind.config.ts"), "-i", path.join(repo, "app", "globals.css"), "-o", path.join(here, "harness.css"), "--minify"],
  { cwd: here, stdio: "inherit" },
);

console.log(`[harness] esbuild ${which} -> harness.js`);
execFileSync(
  NODE,
  [esbuildCli,
    path.join(here, which),
    "--bundle",
    "--format=iife",
    "--jsx=automatic",
    "--loader:.tsx=tsx",
    "--target=chrome120",
    `--alias:next/link=${path.join(here, "stub-link.tsx")}`,
    `--alias:@=${repo}`,
    "--define:process.env.NODE_ENV=\"production\"",
    `--outfile=${path.join(here, "harness.js")}`,
  ],
  { cwd: repo, stdio: "inherit" },
);

console.log("[harness] built");
