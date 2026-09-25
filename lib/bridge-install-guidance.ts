/**
 * Copy-safe bridge recovery commands for the paired-machine wizard.
 *
 * The installer always writes the OASIS launcher under `~/.oasis/bin`. Using
 * that absolute per-user path avoids depending on the terminal's current
 * directory or on a just-installed PATH entry becoming visible in the same
 * shell. The launcher itself chooses Task Scheduler/Startup, launchd, or
 * systemd for the host OS.
 */

export type BridgeHostOS = "windows" | "macos" | "linux";

/** Resolve the viewer's machine family without guessing for mobile/unknown UAs. */
export function bridgeHostOSFromPlatform(platform: string | null | undefined): BridgeHostOS | null {
  const value = (platform || "").trim().toLowerCase();
  if (value.startsWith("win")) return "windows";
  if (value.startsWith("mac")) return "macos";
  if (value.includes("linux")) return "linux";
  return null;
}

function oasisLauncher(os: BridgeHostOS): string {
  return os === "windows"
    ? '& "$HOME\\.oasis\\bin\\oasis.cmd"'
    : '"$HOME/.oasis/bin/oasis"';
}

export function bridgeRestartCommand(os: BridgeHostOS): string {
  return `${oasisLauncher(os)} bridge restart`;
}

/**
 * Recovery copy for a paired host. Browser surfaces can pass the detected OS
 * and get a copy-safe installed-launcher command. Server-rendered prompts do
 * not know the operator's host OS, so their safe fallback is the Devices page
 * plus the portable launcher name (never a repo-relative Python script).
 */
export function bridgeRecoveryGuidance(os: BridgeHostOS | null): string {
  if (!os) {
    return "Open Settings → Devices, or run `oasis bridge status` followed by `oasis bridge restart` on the paired machine";
  }
  return `Run \`${oasisLauncher(os)} bridge status\`, then \`${bridgeRestartCommand(os)}\` if it is down`;
}

export function bridgeInstallCommands(os: BridgeHostOS): string {
  const launcher = oasisLauncher(os);
  return [
    `${launcher} bridge install`,
    `${launcher} bridge restart`,
    `${launcher} bridge status`,
  ].join("\n");
}

export function bridgeSupervisorLabel(os: BridgeHostOS): string {
  if (os === "windows") return "Windows Task Scheduler (with a Startup-folder fallback)";
  if (os === "macos") return "launchd";
  return "the systemd user service";
}
