/**
 * POST /api/lead-documents/[id]/unwatermark
 *
 * Back-compat alias (2026-06-29): "unwatermark" == set the CLEAN variant active.
 * Delegates to the sibling /watermark-variant handler with target:"clean" so
 * there's one source of truth for the toggle logic + auth. The duplicate-file
 * model keeps both copies, so this just flips the active pointer (it no longer
 * deletes the watermarked copy).
 */
import { type NextRequest } from "next/server";
import { POST as variantPost } from "../watermark-variant/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  // Re-issue the request to the variant handler with target forced to "clean".
  // resolveSessionContext reads cookies from the ambient request context, so a
  // rebuilt Request body doesn't lose the session.
  const forced = new Request(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify({ target: "clean" }),
  }) as NextRequest;
  return variantPost(forced, context);
}
