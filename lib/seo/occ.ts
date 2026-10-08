/**
 * The SEO module's only contact with OCC itself: the Worker env (service binding + keys)
 * and the signed-in operator. Moving the module to another product means rewriting this
 * file and nothing else under lib/seo or components/seo.
 */
import "server-only";
import { getSessionUser } from "@/lib/supabase-server";
import { resolvePlatformOperatorForAuthUser } from "@/lib/platform-operator";
import { clientFromEnv, SeoUnavailable, type SeoClient } from "./client";

/** A client over the SEO_MEASURE service binding. Outside the Worker (local dev) it is unavailable. */
export async function seoClient(): Promise<SeoClient> {
  let env: Record<string, unknown>;
  try {
    const mod = await import("@opennextjs/cloudflare");
    env = mod.getCloudflareContext().env as unknown as Record<string, unknown>;
  } catch {
    throw new SeoUnavailable("no_worker_context");
  }
  return clientFromEnv(env);
}

/**
 * The signed-in operator's email, or null. Same rule as requireOperator() (auth user id AND
 * an active OASIS owner/admin membership), read here because route handlers need the
 * identity, not just a yes. Fails closed: any lookup error is null.
 */
export async function seoOperatorEmail(): Promise<string | null> {
  try {
    const user = await getSessionUser();
    const email = typeof user?.email === "string" ? user.email.trim().toLowerCase() : "";
    if (!user?.id || !email) return null;
    const check = await resolvePlatformOperatorForAuthUser(user.id, email);
    return check.operator ? email : null;
  } catch (err) {
    console.error(JSON.stringify({ seo_operator_lookup_failed: (err as Error)?.name ?? "error" }));
    return null;
  }
}
