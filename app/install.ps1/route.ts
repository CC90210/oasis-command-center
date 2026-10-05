import { INSTALL_PS1, operatorInstallScript } from "@/lib/install-scripts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /install.ps1 — the Windows install script, for the verified platform
 * operator only. Everyone else gets a 404. Was a public file under public/
 * until 2026-09-29; see lib/install-scripts.ts for why it moved.
 */
export async function GET() {
  return operatorInstallScript(INSTALL_PS1);
}
