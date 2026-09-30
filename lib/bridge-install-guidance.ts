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

/**
 * Pair-only command, for a machine that ALREADY has the bridge installed. It
 * does NOT clone, install anything or run the wizard. It calls the
 * unauthenticated redeem endpoint (the pair code is the credential), receives
 * the bridge token and writes it to ~/.oasis/bridge_token (0600), which is
 * what the bridge reads on every heartbeat. Then the bridge is restarted.
 *
 * Self-contained on purpose (one paste, no repository): bash uses the
 * always-present python3; Windows uses Invoke-RestMethod. `envPrefix` names the
 * two variables the command reads (`<prefix>_PAIR_CODE`, and the optional
 * `<prefix>_DASHBOARD_URL` host override). The operator wizard keeps the
 * prefix its machines already use; a client's pair-only page passes a neutral
 * one, so nothing the harness names reaches a client's screen.
 */
export function bridgePairCommand(os: BridgeHostOS, code: string, envPrefix: string): string {
  const codeVar = `${envPrefix}_PAIR_CODE`;
  const urlVar = `${envPrefix}_DASHBOARD_URL`;
  const nixPair =
    `${codeVar}="${code}" python3 -c "` +
    "import os,json,platform,socket,urllib.request as u;from pathlib import Path;" +
    `c=os.environ['${codeVar}'].strip().upper();` +
    `b=os.environ.get('${urlVar}','https://oasisai.work').rstrip('/');` +
    "d=json.dumps({'code':c,'machine':{'label':platform.node() or 'machine','fingerprint':platform.system()+'|'+platform.machine()+'|'+socket.gethostname()}}).encode();" +
    "r=u.Request(b+'/api/auth/pair-code/redeem',data=d,headers={'content-type':'application/json'},method='POST');" +
    "t=json.loads(u.urlopen(r,timeout=20).read())['bridge']['token'];" +
    "p=Path.home()/'.oasis';p.mkdir(parents=True,exist_ok=True);f=p/'bridge_token';f.write_text(t);os.chmod(f,0o600);" +
    "print('paired ->',str(f))\"";
  const winPair =
    `$env:${codeVar}="${code}"; ` +
    `$b=if($env:${urlVar}){$env:${urlVar}.TrimEnd('/')}else{'https://oasisai.work'}; ` +
    `$body=@{code=$env:${codeVar}.ToUpper();machine=@{label=$env:COMPUTERNAME;fingerprint=('windows|'+$env:PROCESSOR_ARCHITECTURE+'|'+$env:COMPUTERNAME)}} | ConvertTo-Json -Compress; ` +
    "$r=Invoke-RestMethod -Method Post -Uri ($b+'/api/auth/pair-code/redeem') -ContentType 'application/json' -Body $body; " +
    "$d=Join-Path $HOME '.oasis'; New-Item -ItemType Directory -Force -Path $d | Out-Null; " +
    "Set-Content -Path (Join-Path $d 'bridge_token') -Value $r.bridge.token -NoNewline; Write-Host 'paired'";
  return os === "windows" ? winPair : nixPair;
}

export function bridgeSupervisorLabel(os: BridgeHostOS): string {
  if (os === "windows") return "Windows Task Scheduler (with a Startup-folder fallback)";
  if (os === "macos") return "launchd";
  return "the systemd user service";
}
