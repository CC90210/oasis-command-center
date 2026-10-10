/**
 * POST /api/mcp - the OASIS MCP server (MCP Streamable HTTP, stateless JSON-RPC).
 * Department agents running as CLIs on the operator's PC reach the workspace's
 * live tools here with a 60-minute bearer; the workspace's own credentials never
 * leave the Worker. Auth is the bearer, checked INSIDE (lib/mcp/server.ts):
 * middleware lets the path through because no browser session exists for a CLI.
 * GET and DELETE answer 405: no SSE stream, no session to end.
 */
import { handleMcpPost, methodNotAllowed } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return handleMcpPost(req);
}

export async function GET() {
  return methodNotAllowed();
}

export async function DELETE() {
  return methodNotAllowed();
}
