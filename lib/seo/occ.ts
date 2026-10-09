/**
 * The SEO module's only contact with OCC itself: the Worker env (service binding + keys)
 * and the signed-in owner. Moving the module to another product means rewriting this
 * file and nothing else under lib/seo or components/seo.
 */
import "server-only";
import { notFound } from "next/navigation";
import { resolveSessionContext } from "@/lib/api-auth";
import { resolveFounder } from "@/lib/founders/gate";
import { FINANCE_OWNER_EMAILS, ownerKeyForUser } from "@/lib/founders-finances/access";
import { loadOwnerProfiles } from "@/lib/founders-finances/access-io";
import { clientFromEnv, SeoUnavailable, type SeoClient } from "./client";
import { resolveSeoOwner } from "./owner";

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
 * The signed-in owner's email (CC or Adon), or null. The Money tab's rule: founders portal
 * AND the auth user id behind an owner email (lib/founders-finances/access.ts). Route
 * handlers need the identity, not just a yes. Fails closed (lib/seo/owner.ts).
 */
export async function seoOwnerEmail(): Promise<string | null> {
  return resolveSeoOwner({
    inFoundersPortal: async () => (await resolveFounder()) !== null,
    sessionUserId: async () => {
      const session = await resolveSessionContext();
      return session.ok ? session.userId : null;
    },
    ownerEmailForUser: async (userId) => {
      const key = ownerKeyForUser(userId, await loadOwnerProfiles());
      return key ? FINANCE_OWNER_EMAILS[key] : null;
    },
  });
}

/** Page gate: 404 for anyone but CC and Adon, so the screen's existence is not confirmed. */
export async function requireSeoOwner(): Promise<void> {
  if (!(await seoOwnerEmail())) notFound();
}
