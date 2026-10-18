/**
 * lib/runtime/secret-digests.ts - prove a secret's bundled copy is the value the Worker uses, without showing either.
 *
 * Moving a secret into a bundle (lib/runtime/secret-bundles.ts) is safe only when the bundle holds the SAME value the
 * Worker serves today: the store an agent builds a bundle from can be stale. So, for each name asked: `served` is the
 * digest of the value the app reads (the individual secret while it exists), and `bundled` is the digest of its copy
 * in a bundle. Equal means the individual may be deleted; the bundled copy then takes over unchanged. A digest is the
 * first 12 hex characters of SHA-256: it names a value without revealing it.
 *
 * Asked by OASIS's own PC through POST /api/internal/tools/secret-digests, signed like the tool runner
 * (lib/tools/runner-auth.ts). A name that is not an env-style key is refused; the bundle keys themselves are not
 * answered. At most 200 names per request.
 */
import { authenticateToolsRequest, toolsJson, toolsRefuse } from "@/lib/tools/runner-auth";
import { SECRET_BUNDLE_DIGESTS_KEY, SECRET_BUNDLE_KEY, secretDigest } from "@/lib/runtime/secret-bundles";

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const SECRET_DIGEST_MAX_NAMES = 200;

export type SecretDigestDeps = { env: Record<string, string | undefined>; now: Date };

export async function handleSecretDigests(req: Request, deps: SecretDigestDeps): Promise<Response> {
  const auth = await authenticateToolsRequest(req, deps.env, deps.now);
  if (!auth.ok) return auth.response;
  const extra = Object.keys(auth.body).find((key) => key !== "names");
  if (extra) return toolsRefuse(422, "invalid_payload", { field: extra });
  const names = auth.body.names;
  if (!Array.isArray(names) || names.length === 0 || names.length > SECRET_DIGEST_MAX_NAMES) {
    return toolsRefuse(422, "invalid_payload", { field: "names" });
  }
  if (!names.every((name) => typeof name === "string" && NAME.test(name) && !SECRET_BUNDLE_KEY.test(name) && name !== SECRET_BUNDLE_DIGESTS_KEY)) {
    return toolsRefuse(422, "invalid_payload", { field: "names" });
  }
  let bundled: Record<string, unknown> = {};
  const raw = deps.env[SECRET_BUNDLE_DIGESTS_KEY];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) bundled = parsed as Record<string, unknown>;
    } catch {
      return toolsRefuse(500, "bundle_digests_unreadable");
    }
  }
  const digests: Record<string, { served: string | null; bundled: string | null }> = {};
  for (const name of names as string[]) {
    const served = deps.env[name];
    const copy = bundled[name];
    digests[name] = {
      served: typeof served === "string" && served !== "" ? secretDigest(served) : null,
      bundled: typeof copy === "string" ? copy : null,
    };
  }
  return toolsJson(200, { ok: true, digests });
}
