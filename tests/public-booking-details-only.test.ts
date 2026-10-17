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
import { claimDetailsOnlyAlert } from "../lib/forms/public-booking-details-only";

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

  await check("a lead's alert is claimed once; a booked lead or another workspace's lead never alerts", async () => {
    const db = createClient({ url: `file:${join(mkdtempSync(join(tmpdir(), "details-only-")), "t.db")}` });
    await db.execute(`CREATE TABLE tenant_records (id text primary key, tenant_id text not null, entity_type text not null,
      data text not null, created_at text not null, updated_at text not null)`);
    const lead = async (id: string, tenant: string, data: Record<string, unknown>) =>
      db.execute({ sql: "INSERT INTO tenant_records VALUES (?, ?, 'lead', ?, '2026-10-17', '2026-10-17')", args: [id, tenant, JSON.stringify(data)] });
    await lead("waiting", OASIS, { name: "Dana" });
    await lead("booked", OASIS, { name: "Lee", calendar_appointment_id: "appt-1" });
    await lead("theirs", OTHER, { name: "Sam" });
    await lead("racer", OASIS, {});
    const now = new Date("2026-10-17T15:00:00.000Z");

    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "waiting", now }), true);
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "waiting", now }), false, "a repeat alerted twice");
    const stamped = (await db.execute({ sql: "SELECT json_extract(data, '$.details_only_alerted_at') AS at, json_extract(data, '$.name') AS name FROM tenant_records WHERE id = 'waiting'", args: [] })).rows[0];
    assert.equal(stamped.at, now.toISOString());
    assert.equal(stamped.name, "Dana", "the claim changed the lead's other fields");
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "booked", now }), false, "a booked lead was reported as waiting");
    assert.equal(await claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "theirs", now }), false, "another workspace's lead was claimed");
    const racing = await Promise.all(Array.from({ length: 4 }, () => claimDetailsOnlyAlert(db, { tenantId: OASIS, leadId: "racer", now })));
    assert.equal(racing.filter(Boolean).length, 1, "racing requests alerted more than once");
    db.close();
  });

  await check("the route is same-origin, rate-limited, token-proven, /book only, and claims before it alerts the sales desk", () => {
    const route = read("app", "api", "forms", "booking", "details-only", "route.ts");
    assert.match(route, /if \(!sameOrigin\(req\)\) \{\s*return NextResponse\.json\(\{ ok: false, error: "cross_origin_refused" \}, \{ status: 403 \}\);/);
    assert.match(route, /rateLimit\(\{ key: `public-booking-details-only:\$\{getClientIp\(req\)\}`/);
    assert.match(route, /context = await resolvePublicFunnelBooking\(db, token\);/);
    assert.match(route, /if \(context\.formSlug !== BOOK_FORM_SLUG\) \{/, "any form's lead could raise the /book alert");
    const claimAt = route.indexOf("await claimDetailsOnlyAlert(getTursoClient(), {");
    assert.ok(claimAt > 0 && claimAt < route.indexOf("await pushWorkspaceAlert("), "the alert is sent before it is claimed");
    assert.match(route, /if \(!claimed\) return NextResponse\.json\(\{ ok: true, alerted: false \}\);/);
    assert.match(route, /\{ desk: "sales" \},/, "the alert does not go to the sales desk");
    assert.match(route, /if \(!sent\.delivered\) \{\s*await recordAlertFailure\(/, "an undelivered alert leaves no mark on the lead");
  });

  await check("/book raises it only on the explicit details-only submit, after the lead is saved, never for a script", () => {
    const page = read("components", "booking", "BookingPage.tsx");
    const callAt = page.indexOf('void fetch("/api/forms/booking/details-only", {');
    assert.ok(callAt > 0, "the page never raises the alert");
    assert.equal(page.split('fetch("/api/forms/booking/details-only"').length - 1, 1, "the alert is raised from more than one place");
    assert.match(page.slice(callAt - 400, callAt), /if \(detailsOnly \|\| !slot\) \{[\s\S]*if \(detailsOnly\) \{\s*$/, "the alert is not tied to the details-only submit");
    assert.ok(callAt > page.indexOf("tokenRef.current = token;"), "the alert is raised before the lead is saved");
    assert.ok(callAt > page.indexOf("const honeypot = trapValue(trapRef.current, trapLatch);"), "a script could raise the alert");
    assert.match(page, /body: JSON\.stringify\(\{ token, reason: detailsWhy \}\),/);
    assert.equal(page.match(/setDetailsWhy\("calendar_error"\);\s*setDetailsOnly\(true\);/g)?.length, 1);
    assert.equal(page.match(/setDetailsWhy\("no_times"\);\s*setDetailsOnly\(true\);/g)?.length, 1);
  });

  console.log("public-booking-details-only: all passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
