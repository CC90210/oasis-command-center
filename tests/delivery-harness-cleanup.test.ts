/** Regression: importing the delivery harness must not leak its local test DB. */
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function deliveryTempDirs(): Set<string> {
  return new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("delivery-")));
}

async function main(): Promise<void> {
  const before = deliveryTempDirs();
  const child = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      'const harness = await import("./tests/_delivery-harness.ts"); harness.finish("delivery-harness-cleanup-probe");',
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  if (child.status !== 0) {
    throw new Error(
      `cleanup probe exited ${child.status}\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`,
    );
  }

  let leaked = [...deliveryTempDirs()].filter((name) => !before.has(name));
  for (let attempt = 0; leaked.length && attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    leaked = [...deliveryTempDirs()].filter((name) => !before.has(name));
  }
  if (leaked.length) {
    throw new Error(`delivery harness leaked temp director${leaked.length === 1 ? "y" : "ies"}: ${leaked.join(", ")}`);
  }

  console.log("delivery-harness-cleanup: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
