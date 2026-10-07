/**
 * The SEO screen's two write actions as pure functions of (Request, deps), so the route
 * files stay three lines and every rule here is tested without a Worker or a session.
 *
 * Order is the security order: operator check (404, so the route's existence is not
 * confirmed), then same-origin (403), then the body. The operator's identity always comes
 * from deps.operatorEmail(), never from the form.
 */
import { SeoApiError, SeoUnavailable, type SeoClient } from "./client";

export type ActionDeps = {
  operatorEmail: () => Promise<string | null>;
  client: () => Promise<SeoClient>;
};

const MAX_BODY = 4096;

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const notFound = () => reply({ error: "not found", code: "not_found" }, 404);
const bad = (code: string, error: string) => reply({ error, code }, 400);

/** A browser POST always carries Origin. A missing or foreign one is a forged request: refuse. */
function crossSite(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text();
  if (text.length > MAX_BODY) return null;
  try {
    const j: unknown = JSON.parse(text || "{}");
    return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function failure(e: unknown): Response {
  if (e instanceof SeoApiError) return e.status === 404 ? notFound() : bad(e.code, e.message);
  const reason = e instanceof SeoUnavailable ? e.reason : "error";
  console.error(JSON.stringify({ seo_action_unavailable: reason }));
  return reply({ error: "The SEO service did not answer. Try again in a minute.", code: "unavailable" }, 503);
}

export async function addSiteAction(req: Request, deps: ActionDeps): Promise<Response> {
  const who = await deps.operatorEmail();
  if (!who) return notFound();
  if (crossSite(req)) return reply({ error: "forbidden", code: "forbidden" }, 403);
  const body = await readJson(req);
  if (!body) return bad("bad_json", "Send a JSON object under 4 KB.");
  if (typeof body.domain !== "string" || !body.domain.trim()) return bad("bad_domain", "Enter a domain, like example.com");
  if (body.dpa_confirmed !== true) return bad("dpa_required", "Confirm the client has signed our data processing agreement");
  if (body.is_test !== undefined && typeof body.is_test !== "boolean") return bad("bad_is_test", "is_test must be true or false");
  try {
    const client = await deps.client();
    const r = await client.addSite({ domain: body.domain, dpaConfirmedBy: who, isTest: body.is_test === true });
    return reply(r, r.created ? 201 : 409);
  } catch (e) {
    return failure(e);
  }
}

export async function checkAccessAction(req: Request, siteId: string, deps: ActionDeps): Promise<Response> {
  const who = await deps.operatorEmail();
  if (!who) return notFound();
  if (crossSite(req)) return reply({ error: "forbidden", code: "forbidden" }, 403);
  try {
    const client = await deps.client();
    return reply(await client.checkAccess(siteId, who), 200);
  } catch (e) {
    return failure(e);
  }
}
