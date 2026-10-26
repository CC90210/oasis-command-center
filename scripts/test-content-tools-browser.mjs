/**
 * scripts/test-content-tools-browser.mjs - drive the real Content Tools client
 * components in Chromium against synthetic API answers.
 *
 * Bundles tests/tools-grid.browser.tsx (ToolGrid, ContentTabs, RefreshOnToolRun,
 * the real registry) with esbuild, serves it with the app's own Tailwind CSS from
 * a local port, and runs tests/tools-grid.browser.py (Playwright for Python)
 * against it. Every /api/* request is answered by the test's route handlers;
 * one that is not mocked fails with 500. No session, no database, no runner, no
 * network beyond localhost, nothing written outside tmp/.
 *
 * Needs a Python with `playwright` and its Chromium installed:
 *   OASIS_TEST_PYTHON=~/CEO-Agent/.venv/bin/python3 npm run test:content-tools-browser
 * Not in CI (the runner has no Playwright browser): run it before shipping a
 * change to the card and paste its PASS lines in the PR.
 */
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const temp = await mkdtemp(join(tmpdir(), "oasis-content-browser-"));
const server = createServer(async (req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const asset = pathname === "/fixture.js" ? ["fixture.js", "application/javascript"] : pathname === "/fixture.css" ? ["fixture.css", "text/css"] : null;
  if (pathname.startsWith("/api/")) {
    res.writeHead(500);
    res.end("Unmocked fixture request");
    return;
  }
  if (asset) {
    res.setHeader("Content-Type", asset[1]);
    res.end(await readFile(join(temp, asset[0])));
    return;
  }
  res.setHeader("Content-Type", "text/html");
  res.end(
    '<!doctype html><html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>',
  );
});
try {
  await build({
    entryPoints: ["tests/tools-grid.browser.tsx"],
    bundle: true,
    outfile: join(temp, "fixture.js"),
    platform: "browser",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"development"' },
    plugins: [
      {
        name: "fixture-router",
        setup(b) {
          // No Next app router here: the pathname is the address bar's, and the
          // router's refresh() is a window event the test counts.
          b.onResolve({ filter: /^next\/(navigation|link)$/ }, ({ path }) => ({ path, namespace: "fixture" }));
          b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
            contents: path.endsWith("navigation")
              ? 'export const usePathname=()=>location.pathname; export const useRouter=()=>({refresh(){window.dispatchEvent(new Event("fixture:refresh"))}});'
              : 'import React from "react"; export default function Link(p){return React.createElement("a",p)}',
            resolveDir: process.cwd(),
            loader: "js",
          }));
        },
      },
    ],
  });
  const css = spawnSync(process.execPath, ["node_modules/tailwindcss/lib/cli.js", "-i", "app/globals.css", "-o", join(temp, "fixture.css"), "--minify"], { encoding: "utf8" });
  if (css.status !== 0) throw new Error(css.stderr);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const child = spawn(process.env.OASIS_TEST_PYTHON || "python3", ["tests/tools-grid.browser.py", `http://127.0.0.1:${port}`], { stdio: "inherit" });
  process.exitCode = await new Promise((resolve, reject) => {
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", reject);
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
