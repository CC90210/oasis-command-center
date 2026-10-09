/**
 * POST /api/bridge/cli-auth  { provider: "claude" | "codex" | "gemini" }
 *
 * The Connect / Reconnect button on each app card in Settings > AI brain (CC,
 * 2026-10-09: "if it says not connected, clicking it takes you to the page
 * that authorizes it"). It asks the PAIRED COMPUTER's bridge to start that
 * app's own sign-in there (the bridge's cli_auth_start tool), which opens the
 * vendor's sign-in page in that computer's browser. Nothing signs in inside
 * OASIS, and no credential passes through it: the app keeps its own sign-in on
 * that computer.
 *
 *   - The coding harness's own gate (lib/bridge-proxy.ts
 *     authorizeBridgeRequest): this workspace's bridge, with its server-only
 *     bearer. Then owners and admins only (403): starting a sign-in on the
 *     operator's computer is theirs to do.
 *   - Every answer carries `command`: the app's real sign-in command
 *     (lib/bridge-cli-status.ts CLI_SIGN_IN), to run in a terminal on that
 *     computer when the bridge cannot start it.
 *   - The bridge's own words come back as `output` (its URL, or what it did),
 *     cut short; a bridge that does not answer is said plainly (502).
 *
 * Install stays where it was (the card, on the computer itself): an npm
 * install is not something to start from a hosted page.
 */
import { NextResponse } from "next/server";
import { authorizeBridgeRequest, callBridgeExecTool } from "@/lib/bridge-proxy";
import { isPrivilegedBridgeRole } from "@/lib/bridge-cli-policy";
import { CLI_SIGN_IN, isSignInProvider } from "@/lib/bridge-cli-status";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGN_IN_TIMEOUT_MS = 20_000;

export async function POST(req: Request) {
  let raw: { provider?: unknown };
  try {
    raw = (await req.json()) as { provider?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json", message: "That request could not be read. Try again." }, { status: 400 });
  }
  const provider = raw.provider;
  if (!isSignInProvider(provider)) {
    return NextResponse.json({ ok: false, error: "invalid_provider", message: "Pick Claude Code, Codex or Gemini CLI." }, { status: 400 });
  }
  const sign = CLI_SIGN_IN[provider];
  const auth = await authorizeBridgeRequest();
  if (!auth.ok) {
    const message =
      auth.status === 401
        ? "Your session ended. Sign in again, then try again."
        : auth.error === "bridge_not_configured"
          ? `No paired computer is set up for this workspace. On that computer, run: ${sign.command}`
          : `This account can't reach the paired computer. On that computer, run: ${sign.command}`;
    return NextResponse.json({ ok: false, error: auth.error, message, command: sign.command }, { status: auth.status });
  }
  if (!isPrivilegedBridgeRole(auth.teamRole)) {
    return NextResponse.json(
      { ok: false, error: "admin_required", message: "Only an owner or admin can start a sign-in on the paired computer.", command: sign.command },
      { status: 403 },
    );
  }
  const r = await callBridgeExecTool(auth.target, { tool_name: "cli_auth_start", input: { provider } }, { timeoutMs: SIGN_IN_TIMEOUT_MS });
  const output = r.output.trim().slice(0, 2000);
  if (r.httpStatus === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "bridge_unreachable",
        message: `The paired computer didn't answer. On that computer, run: ${sign.command}`,
        command: sign.command,
      },
      { status: 502 },
    );
  }
  if (!r.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "sign_in_not_started",
        message: `The paired computer couldn't start the sign-in. On that computer, run: ${sign.command}`,
        output,
        command: sign.command,
      },
      { status: 502 },
    );
  }
  return NextResponse.json({
    ok: true,
    message: `Started the ${sign.label} sign-in on your paired computer. Finish it in the browser window that opened there; this card updates within a minute or two.`,
    output,
    command: sign.command,
  });
}
