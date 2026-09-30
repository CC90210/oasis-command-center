/**
 * lib/bridge-install-command.ts — the operator's bridge commands.
 *
 * Operator only (F0 containment, 2026-09-29). Imported by the two surfaces a
 * verified platform operator alone reaches: the /settings/devices/install
 * wizard (InstallBridgeWizard) and the Settings › Devices modal
 * (InstallBridgeModal). The client pair-only page (PairBridgeOnly) does not
 * import this module, so the full-install command is in no module a client's
 * page loads. The repository is never a constant here: it arrives as `repo`,
 * a prop from an operator-gated server component (HARNESS_REPO).
 */
import type { PairMode } from "@/hooks/useBridgePairing";
import { bridgePairCommand, type BridgeHostOS } from "@/lib/bridge-install-guidance";

/** The variable prefix the operator's machines already read (install.sh, the bridge). */
const OPERATOR_ENV_PREFIX = "BRAVO";

/**
 * Full-install command for a brand-new machine. `repo` is private, so an
 * anonymous raw.githubusercontent.com fetch is a 404 for everyone; both forms
 * read the installer through the GitHub CLI's authenticated API instead, the
 * same fallback /install.ps1 and /install.sh use. PowerShell decodes the base64
 * `content` as UTF-8 (a native pipe would decode it with the console code
 * page); bash takes the raw media type straight into `bash`.
 *
 * The installer then runs `git clone` over HTTPS, so git itself needs GitHub
 * credentials too, not just the gh session: `gh auth login` choosing HTTPS, or
 * `gh auth setup-git` once gh is signed in.
 *
 * The env-var placement is the one verified 2026-05-10: PowerShell sets it
 * before iex runs, and bash puts it on `bash` (not `gh`) so the shell that runs
 * the script inherits it.
 */
export function installOneLiner(os: BridgeHostOS, code: string, repo: string): string {
  const v = `${OPERATOR_ENV_PREFIX}_PAIR_CODE`;
  const winShell = `$env:${v}="${code}"; iex ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String((gh api repos/${repo}/contents/install.ps1 --jq .content) -join '')))`;
  const nixShell = `gh api -H "Accept: application/vnd.github.raw" repos/${repo}/contents/install.sh | ${v}=${code} bash`;
  return os === "windows" ? winShell : nixShell;
}

/** The command the operator's wizard shows for the chosen mode. */
export function operatorBridgeCommand(os: BridgeHostOS, code: string, mode: PairMode, repo: string): string {
  return mode === "pair" ? bridgePairCommand(os, code, OPERATOR_ENV_PREFIX) : installOneLiner(os, code, repo);
}
