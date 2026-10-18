/**
 * POST /api/internal/tools/secret-digests - for each named secret, the digest of the value the Worker serves and of its
 * copy in a secret bundle, so a secret moves into a bundle only once the two are proven equal. Signed by OASIS's PC
 * like the tool runner (lib/tools/runner-auth.ts), never a session; middleware lets /api/internal/tools/* through and
 * the handler authenticates first. The work is lib/runtime/secret-digests.ts handleSecretDigests.
 */
import { handleSecretDigests } from "@/lib/runtime/secret-digests";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  try {
    return await handleSecretDigests(req, { env: process.env, now: new Date() });
  } catch (err) {
    console.error("[tools.secret-digests] failed", err instanceof Error ? err.stack : err);
    return Response.json({ ok: false, error: "secret_digests_failed" }, { status: 500 });
  }
}
