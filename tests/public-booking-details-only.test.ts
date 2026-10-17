/**
 * The /book details-only alert (app/api/forms/booking/details-only): a visitor
 * whose calendar would not load, or whose every time was taken, leaves details
 * instead. They asked for a call and got none, so the sales desk hears about it
 * once, and only on that explicit submit (e9, 2026-10-17).
 *
 * Real SQL on a throwaway libSQL file for the once-only claim.
 *
 * Run: node --conditions=react-server --import tsx tests/public-booking-details-only.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { buildDetailsOnlyLeadAlert } from "../lib/forms/public-booking-alert";
import { publicBookingDetailsOnlySchema } from "../lib/forms/public-booking";
import {
  claimDetailsOnlyAlert,
  claimDetailsOnlyAlertLegacy,
  tursoHoldsTheLeads,
} from "../lib/forms/public-booking-details-only";

async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  console.log(`  ok - ${name}`);
}

const ROOT = join(__dirname, "..");
const OASIS = "ef8d389e-3f15-43f2-ae00-3660f69a1452";
const OTHER = "aaaaaaaa-0000-4000-8000-00000000000a";
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), "utf8").replace(/\r\n/g, "\n");

async function main() {
  console.log("public booking details-only alert");

  await check("the alert names the lead, says why no time was picked, links the lead, and escapes what a stranger typed", () => {
    const text = buildDetailsOnlyLeadAlert({
      offerName: "Book a call",
      name: "<script>x</script>Dana",
      company: "Acme & Co",
      reason: "calendar_error",
      leadUrl: "https://oasisai.work/pipeline/lead-1",
    });
    assert.match(text, /^<b>Book a call: details left, no time picked<\/b>/);
    assert.match(text, /&lt;script&gt;x&lt;\/script&gt;Dana/);
    assert.doesNotMatch(text, /<script>/);
    assert.match(text, /Acme &amp; Co/);
    assert.match(text, /The calendar would not load, so they asked us to set the time\./);
    assert.match(text, /<a href="https:\/\/oasisai\.work\/pipeline\/lead-1">Open the lead in Command Center<\/a>/);
    assert.match(buildDetailsOnlyLeadAlert({ offerName: "Book", name: "", company: "", reason: "no_times", leadUrl: "u" }), /Every open time was taken/);
    assert.match(text, /^[\x20-\x7E\n]*$/, "the alert text is not plain ASCII");
  });

  await check("a lead's alert is claimed once a day; another workspace's lead never alerts", async () => {
    const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "details-only-")), "t.db")}` });
    await db.execute(`CREATE TABLE tenant_records (id text primary key, tenant_id text not null, entity_type text not null,
      data text not null, created_at text not null, updated_at text not null)`);
    const lead = async (id: string, tenant: string, data: Record<string, unknown>) =>
      db.execute({ sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, '2026-10-17', '2026-10-17')", args: [id, tenant, JSON.stringify(data)] });
    const now = new Date("2026-10-17T15:00:00.000Z");
    await lead("waiting", OASIS, { name: "Dana" });
    // A past or cancelled call leaves its id on the lead: that is the route's
    // check (bookedCallFromAppointment), never a reason to skip the claim.
    await lead("old-call", OASIS, { name: "Lee", calendar_appointment_id: "appt-1" });
    await lead("alerted-today", OASIS, { details_only_alerted_at: "2026-10-17T09:00:00.000Z" });
    await lead("alerted-last-week", OASIS, { details_only_alerted_at: "2026-10-10T09:00:00.000Z" });
    await lead("theirs", OTHER, { name: "Sam" });
    await lead("racer", OASIS, {});

    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "waiting", now }), true);
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "waiting", now }), false, "a repeat alerted twice");
    const stamped = (await db.execute({ sql: "SELECT json_extract(data, '$.details_only_alerted_at') AS at, json_extract(data, '$.name') AS name FROM tenant_records WHERE id = 'waiting'", args: [] })).rows[0];
    assert.equal(stamped.at, now.toISOString());
    assert.equal(stamped.name, "Dana", "the claim changed the lead's other fields");
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "old-call", now }), true, "an old call's id blocked the alert (Codex review of #677)");
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "alerted-today", now }), false, "a lead alerted today alerted again");
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "alerted-last-week", now }), true, "a lead who came back another day never alerts again");
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "theirs", now }), false, "another workspace's lead was claimed");
    const racing = await Promise.all(Array.from({ length: 4 }, () => claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "racer", now })));
    assert.equal(racing.filter(Boolean).length, 1, "racing requests alerted more than once");
    db.close();
  });

  await check("a rolled-back deploy (leads on Supabase) claims through the lead it read, once a day (Codex review of #677)", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const service = (error: unknown = null) => ({
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { error };
      },
    });
    const now = new Date("2026-10-17T15:00:00.000Z");
    const base = { tenantId: OASIS, leadId: "lead-1", now };
    assert.equal(await claimDetailsOnlyAlertLegacy(service(), { ...base, lead: { name: "Dana" } }), true);
    assert.deepEqual(calls.pop(), {
      name: "patch_tenant_record_data",
      args: { p_id: "lead-1", p_tenant_id: OASIS, p_patch: { details_only_alerted_at: now.toISOString() } },
    });
    assert.equal(await claimDetailsOnlyAlertLegacy(service(), { ...base, lead: { details_only_alerted_at: "2026-10-17T09:00:00.000Z" } }), false);
    assert.equal(calls.length, 0, "a lead alerted today was written to");
    assert.equal(await claimDetailsOnlyAlertLegacy(service(), { ...base, lead: { details_only_alerted_at: "2026-10-10T09:00:00.000Z" } }), true, "a lead alerted last week never alerts again");
    calls.length = 0;
    assert.equal(await claimDetailsOnlyAlertLegacy(service({ message: "down" }), { ...base, lead: {} }), false, "a failed stamp still alerted");
  });

  await check("Turso holds the leads only on the turso_cloud backend with Turso configured, the switch getServiceSupabase reads", () => {
    const saved = { url: process.env.TURSO_DATABASE_URL, path: process.env.TURSO_DB_PATH, dbUrl: process.env.TURSO_DB_URL };
    try {
      process.env.TURSO_DATABASE_URL = "libsql://example.turso.io";
      assert.equal(tursoHoldsTheLeads({ EMPIRE_DATA_BACKEND: "turso_cloud" }), true);
      assert.equal(tursoHoldsTheLeads({ EMPIRE_DATA_BACKEND: "supabase_legacy" }), false, "a rolled-back deploy stamped Turso");
      assert.equal(tursoHoldsTheLeads({}), false);
      delete process.env.TURSO_DATABASE_URL;
      delete process.env.TURSO_DB_PATH;
      delete process.env.TURSO_DB_URL;
      assert.equal(tursoHoldsTheLeads({ EMPIRE_DATA_BACKEND: "turso_cloud" }), false, "an unconfigured Turso was written to");
    } finally {
      for (const [k, v] of [["TURSO_DATABASE_URL", saved.url], ["TURSO_DB_PATH", saved.path], ["TURSO_DB_URL", saved.dbUrl]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  await check("the request body is exactly a token and a known reason (Codex review of #677)", () => {
    assert.deepEqual(publicBookingDetailsOnlySchema.safeParse({ token: "t", reason: "no_times" }), { success: true, data: { token: "t", reason: "no_times" } });
    assert.equal(publicBookingDetailsOnlySchema.safeParse({ token: "t", reason: "other" }).success, false);
    assert.equal(publicBookingDetailsOnlySchema.safeParse({ token: "t" }).success, false);
    assert.equal(publicBookingDetailsOnlySchema.safeParse({ token: "t", reason: "no_times", tenant_id: "x" }).success, false, "an extra field was accepted");
    assert.equal(publicBookingDetailsOnlySchema.safeParse({ token: "x".repeat(4097), reason: "no_times" }).success, false);
  });

  await check("the route is same-origin, rate-limited, capped, token-proven, /book only, and claims before it alerts the sales desk", () => {
    const route = read("app", "api", "forms", "booking", "details-only", "route.ts");
    assert.match(route, /if \(!sameOrigin\(req\)\) \{\s*return NextResponse\.json\(\{ ok: false, error: "cross_origin_refused" \}, \{ status: 403 \}\);/);
    assert.match(route, /rateLimit\(\{ key: `public-booking-details-only:\$\{getClientIp\(req\)\}`, capacity: 10, refillPerSec: 10 \/ 60 \}\)/, "the limit is tighter than the form's own, past the page's retry");
    // A resolution read that fails is retryable (503); only a bad link, form or lead is final (Codex review of #677).
    assert.match(route, /if \(resolutionIsFinal\(error\)\) \{\s*return NextResponse\.json\(\{ ok: false, error: "invalid_booking_token" \}, \{ status: 400 \}\);\s*\}[\s\S]{0,240}\{ status: 503 \}/);
    assert.match(route, /return code\.startsWith\("token_"\) \|\| FINAL_RESOLUTION_ERRORS\.has\(code\);/);
    // A live call is judged on the appointment, before the claim, tenant-scoped.
    const liveAt = route.indexOf("if (await holdsLiveCall(db, context.tenantId, context.leadId,");
    assert.ok(liveAt > 0 && liveAt < route.indexOf("const claimed = tursoHoldsTheLeads()"), "the live-call check is missing or after the claim");
    assert.match(route, /\.eq\("tenant_id", tenantId\)\s*\.eq\("lead_id", leadId\)\s*\.eq\("id", appointmentId\)/);
    assert.match(route, /return !appt\.error && Boolean\(bookedCallFromAppointment\(/);
    assert.match(route, /publicBookingDetailsOnlySchema\.safeParse\(await readPublicBookingJson\(req\)\)/, "the body is read without the 8 KB cap");
    assert.doesNotMatch(route, /req\.json\(/, "the body is read without the 8 KB cap");
    assert.match(route, /context = await resolvePublicFunnelBooking\(db, token\);/);
    assert.match(route, /if \(context\.formSlug !== BOOK_FORM_SLUG\) \{/, "any form's lead could raise the /book alert");
    assert.match(
      route,
      /const claimed = tursoHoldsTheLeads\(\)\s*\? await claimDetailsOnlyAlert\(getTursoClient\(\), claim\)\s*: await claimDetailsOnlyAlertLegacy\(db, \{ \.\.\.claim, lead: context\.lead \}\);/,
      "the claim ignores which store holds the leads",
    );
    const claimAt = route.indexOf("const claimed = tursoHoldsTheLeads()");
    assert.ok(claimAt > 0 && claimAt < route.indexOf("await pushWorkspaceAlert("), "the alert is sent before it is claimed");
    assert.match(route, /if \(!claimed\) return NextResponse\.json\(\{ ok: true, alerted: false \}\);/);
    assert.match(route, /\{ desk: "sales" \},/, "the alert does not go to the sales desk");
    assert.match(route, /if \(!sent\.delivered\) \{\s*await recordAlertFailure\(/, "an undelivered alert leaves no mark on the lead");
  });

  await check("/book raises it only on the explicit details-only submit, after the lead is saved, never for a script", () => {
    const page = read("components", "booking", "BookingPage.tsx");
    const callAt = page.indexOf("if (detailsOnly) void raiseDetailsOnlyAlert(token, detailsWhy);");
    assert.ok(callAt > 0, "the page never raises the alert on the details-only submit");
    assert.equal(page.split("raiseDetailsOnlyAlert(").length - 1, 2, "the alert is raised from more than one place");
    assert.equal(page.match(/fetchWithRetry\(\s*"\/api\/forms\/booking\/details-only",/g)?.length, 1, "the alert does not go through the shared retry");
    assert.doesNotMatch(page, /\bfetch\(\s*"\/api\/forms\/booking\/details-only"/, "the alert bypasses the shared retry");
    assert.match(page.slice(callAt - 600, callAt), /if \(detailsOnly \|\| !slot\) \{/, "the alert is not tied to the details-only submit");
    assert.ok(callAt > page.indexOf("tokenRef.current = token;"), "the alert is raised before the lead is saved");
    assert.ok(callAt > page.indexOf("const honeypot = trapValue(trapRef.current, trapLatch);"), "a script could raise the alert");
    assert.equal(page.match(/setDetailsWhy\("calendar_error"\);\s*setDetailsOnly\(true\);/g)?.length, 1);
    assert.equal(page.match(/setDetailsWhy\("no_times"\);\s*setDetailsOnly\(true\);/g)?.length, 1);
  });

  await check("the page retries (lib/retry.ts) a network error, a 5xx or a 429 up to three times, and stops on any other answer (Codex review of #677)", async () => {
    const { raiseDetailsOnlyAlert } = await import("../components/booking/BookingPage");
    const realFetch = globalThis.fetch;
    const realTimeout = globalThis.setTimeout;
    const waits: number[] = [];
    // Waits are recorded, not slept, so the test is instant.
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0);
      fn();
      return 0;
    }) as unknown as typeof setTimeout;
    const run = async (answers: Array<number | "network">) => {
      const sent: string[] = [];
      let i = 0;
      globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        sent.push(String(init?.body));
        const a = answers[Math.min(i++, answers.length - 1)];
        if (a === "network") throw new TypeError("offline");
        return new Response(JSON.stringify(a === 429 ? { ok: false, retry_in_sec: 7 } : { ok: a < 300 }), { status: a });
      }) as typeof fetch;
      waits.length = 0;
      await raiseDetailsOnlyAlert("tok", "no_times");
      return sent;
    };
    try {
      assert.equal((await run([200])).length, 1);
      assert.equal((await run([400])).length, 1, "a refusal a retry cannot fix was retried");
      assert.equal((await run([503, "network", 200])).length, 3, "a 5xx or network error was not retried");
      assert.equal((await run([503])).length, 3, "it retried more than three times");
      assert.equal((await run([429, 200])).length, 2, "a rate limit was not retried");
      assert.equal(waits.length, 1, "a retry did not back off");
      assert.deepEqual(JSON.parse((await run([200]))[0]), { token: "tok", reason: "no_times" });
    } finally {
      globalThis.fetch = realFetch;
      globalThis.setTimeout = realTimeout;
    }
  });

  console.log("public-booking-details-only: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
