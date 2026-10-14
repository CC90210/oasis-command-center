import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { moneyBrowserServerEnv, prepareMoneyBrowserFixture } from "./money-browser-fixture";

const ROOT = resolve(__dirname, "../..");

let stopping = false;

async function main() {
  await prepareMoneyBrowserFixture();

  const child = spawn(
    process.execPath,
    [join(ROOT, "node_modules", "next", "dist", "bin", "next"), "dev", "--hostname", "127.0.0.1", "--port", "3117"],
    {
      cwd: ROOT,
      env: moneyBrowserServerEnv(),
      stdio: "inherit",
      windowsHide: true,
    },
  );

  function stop(signal: NodeJS.Signals) {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  }

  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  child.once("error", (error) => {
    console.error("[money-browser-server] Next failed to start", error);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (!stopping && (code ?? 1) !== 0) {
      console.error(`[money-browser-server] Next exited early (${code ?? signal ?? "unknown"})`);
    }
    process.exit(code ?? (stopping ? 0 : 1));
  });
}

void main().catch((error: unknown) => {
  console.error("[money-browser-server] fixture preparation failed", error);
  process.exit(1);
});
