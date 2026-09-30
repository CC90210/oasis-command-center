/**
 * lib/install-scripts.ts — the OASIS install one-liners, served to the verified
 * platform operator only (F0 containment, 2026-09-29).
 *
 * These were public/install.ps1 and public/install.sh, which every visitor could
 * fetch from oasisai.work. Both clone the harness repo (CC90210/CEO-Agent),
 * which went private on 2026-09-29. A public script that clones a private repo
 * fails for every visitor and still tells each of them where the harness
 * lives. app/install.ps1/route.ts and app/install.sh/route.ts now serve this
 * text to a verified operator session and answer 404 to everyone else.
 *
 * The text is embedded here rather than read from disk because the Worker has
 * no filesystem to read it from. It is the committed text of the two public
 * files, unchanged. String.raw keeps install.sh's `tr -d '\n'` a backslash-n.
 *
 * Consequence to know: `irm https://oasisai.work/install.ps1 | iex` from a
 * terminal carries no session, so it now gets a 404 even for the operator.
 * The operator opens the URL in a signed-in browser and saves the script.
 */
import { NextResponse } from "next/server";
import { resolvePlatformOperator } from "@/lib/role-surfaces-session";

/**
 * The private harness repo both scripts below clone. Server-side only: the
 * bridge pairing wizard gets it as a prop from a server component that has
 * verified the platform operator, so the name never ships in a client bundle
 * and never reaches a client's page. tests/f0-containment.test.ts pins that the
 * two scripts name this same repo.
 */
export const HARNESS_REPO = "CC90210/CEO-Agent";

export const INSTALL_PS1 = String.raw`# OASIS AI install - stable URL, repo-visibility-proof.
#
#   irm https://oasisai.work/install.ps1 | iex
#   $env:OASIS_PROFILE='hermes'; irm https://oasisai.work/install.ps1 | iex
#
# This URL is the canonical install entry point. The underlying GitHub
# repo (CC90210/CEO-Agent) may flip visibility - this script always fetches
# the latest install/quickstart.ps1, transparently bridging public->gh-auth
# if the public path 404s.

$ErrorActionPreference = 'Stop'
$Repo = 'CC90210/CEO-Agent'
$File = 'install/quickstart.ps1'
$RawUrl = "https://raw.githubusercontent.com/$Repo/main/$File"

Write-Host "==> OASIS AI install" -ForegroundColor Cyan
Write-Host "    repo: https://github.com/$Repo" -ForegroundColor DarkGray
Write-Host ""

# Try the public path first - the simplest and most common case.
try {
    $script = (Invoke-RestMethod -Uri $RawUrl -ErrorAction Stop)
    Invoke-Expression $script
    exit $LASTEXITCODE
} catch {
    Write-Host "Public URL returned an error (repo may be private)." -ForegroundColor Yellow
    Write-Host "Falling back to authenticated GitHub CLI..." -ForegroundColor Yellow
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "GitHub CLI not installed. Install it first:" -ForegroundColor Red
    Write-Host "  winget install GitHub.cli" -ForegroundColor Yellow
    Write-Host "Then re-run: irm https://oasisai.work/install.ps1 | iex" -ForegroundColor Yellow
    exit 1
}

& gh auth status -h github.com *> $null
if ($LASTEXITCODE -ne 0) {
    & gh auth login -h github.com
}

$contentB64 = (& gh api "repos/$Repo/contents/$File" --jq .content) -join ''
$script = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($contentB64))
Invoke-Expression $script
`;

export const INSTALL_SH = String.raw`#!/usr/bin/env bash
# OASIS AI install ${"\u2014"} stable URL, repo-visibility-proof.
#
#   curl -fsSL https://oasisai.work/install.sh | bash
#   OASIS_PROFILE=hermes curl -fsSL https://oasisai.work/install.sh | bash
#
# This URL is the canonical install entry point. The underlying GitHub
# repo (CC90210/CEO-Agent) may flip visibility ${"\u2014"} this script always fetches
# the latest install/quickstart.sh, transparently bridging public${"\u2192"}gh-auth
# if the public path 404s.

set -euo pipefail
REPO="CC90210/CEO-Agent"
FILE="install/quickstart.sh"

echo "==> OASIS AI install"
echo "    repo: https://github.com/$REPO"
echo

if SCRIPT="$(curl -fsSL "https://raw.githubusercontent.com/$REPO/main/$FILE" 2>/dev/null)"; then
    bash -c "$SCRIPT"
    exit $?
fi

echo "Public URL returned 404 (repo may be private)." >&2
echo "Falling back to authenticated GitHub CLI..." >&2

if ! command -v gh >/dev/null 2>&1; then
    cat >&2 <<EOF
GitHub CLI not installed. Install it first:
  macOS:    brew install gh
  Ubuntu:   sudo apt install gh
  Windows:  winget install GitHub.cli
Then re-run this install command.
EOF
    exit 1
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
    gh auth login -h github.com
fi

SCRIPT_B64="$(gh api "repos/$REPO/contents/$FILE" --jq .content | tr -d '\n')"
SCRIPT="$(printf '%s' "$SCRIPT_B64" | { base64 -d 2>/dev/null || base64 -D; })"
bash -c "$SCRIPT"
`;

/**
 * The response for GET /install.ps1 and /install.sh. A verified platform
 * operator gets the script as plain text; everyone else, signed in or not, gets
 * the same bare 404 an unknown path would, so the URL does not confirm that an
 * installer exists. no-store on both, so no cache hands one viewer's answer to
 * another.
 */
export async function operatorInstallScript(script: string): Promise<NextResponse> {
  const op = await resolvePlatformOperator();
  if (!op.operator) {
    return new NextResponse("Not found\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return new NextResponse(script, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}
