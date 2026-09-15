/**
 * The shop-out routes must never answer with an empty body.
 *
 * 2026-09-15 outage: lib/config/agents.ts called readFileSync, which throws on
 * Cloudflare Workers (no filesystem). Nothing caught it, so Next returned a
 * 500 with ZERO bytes. The browser's `response.json()` then failed with
 * "Unexpected end of JSON input" — a message that names the JSON parser and
 * says nothing about the filesystem, the roster, or the runtime. That single
 * misleading string is why the outage survived an earlier repair attempt aimed
 * at the client.
 *
 * The root cause is fixed (static import — see
 * tests/agents-config-runtime-portable.test.ts). This test covers the SECOND
 * failure: whatever throws next must arrive as a named JSON error, so the
 * diagnosis is in the operator's hands instead of in a parser complaint.
 *
 * Both lender grids (SunBiz + FundMate) share one client, so both routes are
 * covered.
 */

import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// Deliberately leave the authed-Supabase anon key unset. That makes
// getSessionUser() throw from deep inside the handler — a genuine uncaught
// exception of exactly the shape the outage produced, not a simulated one.
process.env.BRAVO_SUPABASE_URL ||= "https://unused.invalid";
process.env.BRAVO_SUPABASE_SERVICE_ROLE_KEY ||= "unused";
delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
delete process.env.BRAVO_SUPABASE_ANON_KEY;

const APP_ID = "ffa0114c-f625-414c-819b-1f7369ab5f34";

async function main() {

  // PROVE THE PRECONDITION. If this ever stops throwing, the test below would
  // pass for the wrong reason — it would be asserting that a SUCCESSFUL call
  // returns JSON, which proves nothing about the envelope.
  const { resolveSessionContext } = await import("@/lib/api-auth");
  await assert.rejects(
    async () => resolveSessionContext(),
    "precondition: resolveSessionContext must throw here, otherwise this test proves nothing",
  );

  const routes: Array<[string, string]> = [
    ["sunbiz", "@/app/api/applications/[id]/shop-out/route"],
    ["funmate", "@/app/api/applications/[id]/shop-out/funmate/route"],
  ];

  for (const [label, specifier] of routes) {
    const mod = (await import(specifier)) as {
      POST: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    };

    const req = new NextRequest(`https://oasisai.work/api/applications/${APP_ID}/shop-out`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lender_ids: ["a"], cc_emails: [], attachments: [], dry_run: true }),
    });

    // The handler must RESOLVE, not reject. A rejection here is what Next turns
    // into the empty-bodied 500.
    const res = await mod.POST(req, { params: Promise.resolve({ id: APP_ID }) });

    const text = await res.text();
    assert.ok(text.length > 0, `${label}: response body must not be empty — that is the whole bug`);

    // The exact client-side failure being prevented: JSON.parse must succeed.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text) as Record<string, unknown>;
    } catch {
      assert.fail(`${label}: body must be valid JSON, got: ${text.slice(0, 120)}`);
    }

    assert.equal(res.status, 500, `${label}: an unhandled fault is a 500`);
    assert.equal(parsed.ok, false, `${label}: envelope carries ok:false`);
    assert.equal(
      parsed.error,
      "shop_out_unhandled_error",
      `${label}: envelope carries a stable machine-readable error code`,
    );
    assert.equal(
      typeof parsed.message,
      "string",
      `${label}: envelope names the actual fault so the operator can act on it`,
    );
    assert.ok(
      (parsed.message as string).length > 0,
      `${label}: the message must not be blank — a blank message is the empty body again`,
    );

    console.log(`shop-out-route-error-envelope [${label}]: OK — ${res.status}, ${text.length}B JSON`);
  }

}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
