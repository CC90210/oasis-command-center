/**
 * The owner's offer-page preview is the REAL form and calendar, and sends
 * nothing (CC, 2026-10-16: "there's no actual intake form on the offers page";
 * the preview drew a placeholder).
 *
 *   1. The open-times route shows a form that is OFF only to its owner's
 *      preview (?preview=1 and a signed-in OASIS owner); everyone else gets the
 *      same 404 as before, and an enabled form is unchanged.
 *   2. FormPublicClient in preview mode advances its steps without a request,
 *      starts no upload lead and records no tracking event.
 *   3. PublicBookingCalendar in preview mode reads the open-times route, books
 *      nothing and counts no community click.
 *
 * The page itself (who sees the preview, a form that is off, the props the
 * preview's form carries) is tests/offer-pages-public.test.ts.
 *
 * Run: node --conditions=react-server --import tsx tests/offer-preview-form.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve(fn()).then(() => console.log(`  ok - ${name}`));
}

function stub(path: string, exports: Record<string, unknown>): void {
  const p = require.resolve(path);
  require.cache[p] = { id: p, filename: p, path: dirname(p), loaded: true, children: [], paths: [], exports } as unknown as NodeModule;
}

async function main(): Promise<void> {
  console.log("offer preview form");
  const ROOT = process.cwd();

  // -- 1. The open-times route --------------------------------------------
  let formOn = false;
  let owner = false;
  let ownerAsked = 0;
  const real = await import("../lib/forms/public-booking");
  stub(join(ROOT, "lib", "forms", "public-booking.ts"), {
    ...real,
    publicBookingFormEnabled: async () => formOn,
    loadPublicBookingAvailability: async () => [{ start: "2026-10-20T14:00:00.000Z", hosts: [] }],
  });
  // The route opens its database client before the (stubbed) enabled check; CI
  // has no database configured, so the client is stood in too.
  const realSupabase = await import("../lib/supabase-server");
  stub(join(ROOT, "lib", "supabase-server.ts"), { ...realSupabase, getServiceSupabase: () => ({}) });
  stub(join(ROOT, "lib", "offer-pages", "preview-access.ts"), {
    canPreviewOfferPage: async () => {
      ownerAsked += 1;
      return owner;
    },
  });
  const { NextRequest } = await import("next/server");
  const { GET } = await import("../app/api/forms/booking/slots/route");
  let ip = 0;
  const slots = async (query: string) => {
    ip += 1; // one address per call: the per-address rate cap is not what this tests
    const res = await GET(new NextRequest(`http://oasis.test/api/forms/booking/slots?${query}`, { headers: { "x-forwarded-for": `10.0.0.${ip}` } }));
    return { status: res.status, body: (await res.json()) as { ok: boolean; slots?: string[]; error?: string } };
  };

  await check("a form that is off: its open times reach its owner's preview, and nobody else", async () => {
    formOn = false;
    owner = true;
    const preview = await slots("form=command&preview=1");
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.slots, ["2026-10-20T14:00:00.000Z"]);

    owner = false;
    const stranger = await slots("form=command&preview=1");
    assert.equal(stranger.status, 404, "someone but the owner read a closed form's times");
    assert.equal(stranger.body.error, "booking_form_not_found");

    owner = true;
    ownerAsked = 0;
    const plain = await slots("form=command");
    assert.equal(plain.status, 404, "without ?preview a closed form's times are public");
    assert.equal(ownerAsked, 0, "the session is read only for a preview");
  });

  await check("an enabled form is unchanged: public times, no session read", async () => {
    formOn = true;
    owner = false;
    ownerAsked = 0;
    for (const query of ["form=command", "form=command&preview=1"]) {
      const res = await slots(query);
      assert.equal(res.status, 200, query);
      assert.deepEqual(res.body.slots, ["2026-10-20T14:00:00.000Z"]);
    }
    assert.equal(ownerAsked, 0);
    const unknown = await slots("form=vsl&preview=1");
    assert.equal(unknown.status, 404, "a form with no calendar has none in preview either");
  });

  // -- 2. The form in preview mode -----------------------------------------
  const form = readFileSync(join(ROOT, "components", "forms", "FormPublicClient.tsx"), "utf8");
  const submitFn = form.slice(form.indexOf("  async function submit() {"), form.indexOf("  const primary = branding.primary_color"));
  await check("the preview's form advances step by step and sends nothing", () => {
    const previewAt = submitFn.indexOf("    if (preview) {");
    assert.ok(previewAt > 0, "submit() has no preview branch");
    assert.ok(submitFn.indexOf("validateRef.current()") < previewAt, "the preview skips validation: an owner could not see what a visitor is asked to fix");
    const firstNetwork = Math.min(
      ...["fetch(", "captureConsent(", "buildSubmitPayloadRef.current()", "trackEvent("].map((call) => {
        const at = submitFn.indexOf(call);
        return at < 0 ? Infinity : at;
      }),
    );
    assert.ok(previewAt < firstNetwork, "the preview branch comes after a request, an upload or a tracking event");
    const branch = submitFn.slice(previewAt, submitFn.indexOf("\n    }\n", previewAt));
    assert.match(branch, /onStepSubmitted\?\.\(currentStep, finished\)/, "the offer page is not told the step was done");
    // advanceFrom: the next step, or first the early calendar after the
    // contact step on AI audit, COMMAND and FLEET (book sooner, 2026-10-16).
    assert.match(branch, /if \(finished\) setDone\(true\);\s*else advanceFrom\(currentStep, currentStep \+ 1\);/);
    assert.match(branch, /return;/);
  });

  await check("the preview's form starts no upload lead and records no tracking event", () => {
    assert.match(form, /const ensureUploadToken = useCallback\(async \(\): Promise<string \| null> => \{\s*\/\/[^\n]*\n\s*if \(preview\) return null;/);
    assert.match(form, /if \(preview \|\| pageViewFired\.current \|\| !tenantSlug \|\| !formSlug\) return;/);
    assert.match(form, /if \(preview \|\| !tenantSlug \|\| !formSlug \|\| earlyCalendarStep !== null\) return;\s*trackEvent\(\{ tenant: tenantSlug, form: formSlug, event: "step_viewed"/);
    assert.equal(
      (form.match(/preview=\{preview\}/g) || []).length,
      4,
      "all three calendars (required, optional, early) and COMMUNITY's own community link must know they are a preview",
    );
  });

  // Codex review of #659: nothing typed leaves the browser (no address lookup
  // service), and a required upload cannot strand the preview before the calendar.
  await check("the preview's address field calls no lookup service, and its upload is skipped, never required", () => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, TSX_TSCONFIG_PATH: "tests/tsconfig.render.json" };
    const kept = (process.env.NODE_OPTIONS ?? "").split(/\s+/).filter((t) => t && !/^(--conditions=|-C=)/.test(t) && t !== "--conditions" && t !== "-C");
    if (kept.length) childEnv.NODE_OPTIONS = kept.join(" ");
    else delete childEnv.NODE_OPTIONS;
    const r = spawnSync(process.execPath, ["--import", "tsx", "tests/offer-preview-form.render.ts"], { encoding: "utf8", env: childEnv });
    assert.equal(r.status, 0, `renderer failed:\n${r.stderr}`);
    const html = JSON.parse(r.stdout) as { preview: string; live: string };
    assert.match(html.live, /role="combobox"/, "control: the live address field is the lookup field");
    assert.doesNotMatch(html.preview, /role="combobox"|aria-autocomplete/, "the preview's address field calls the lookup service");
    assert.match(html.preview, /<label for="([^"]+)"[^>]*>Business address[\s\S]*?<input id="\1" type="text"/, "the preview's address is not a plain box");
    assert.ok(html.preview.includes("file uploads are skipped here"), "the preview offers an upload it cannot make");
    assert.ok(!html.live.includes("file uploads are skipped here"), "a visitor is told uploads are skipped");
    const validate = form.slice(form.indexOf("  const validate = useCallback("), form.indexOf("  const validateRef = useRef(validate);"));
    const skip = validate.indexOf('if (preview && field.type === "file_upload_multi") continue;');
    assert.ok(skip > validate.indexOf("if (!field.required) continue;"), "the preview skips more than a required upload");
    assert.ok(skip > 0 && skip < validate.indexOf('next[field.name] = "Required";'), "a required upload holds the preview back");
    assert.match(form, /onAddressResolvingChange=\{setAddressResolving\}\s*sandbox=\{preview\}/, "the form does not tell its fields it is a preview");
  });

  // -- 3. The calendar in preview mode -------------------------------------
  const calendar = readFileSync(join(ROOT, "components", "forms", "PublicBookingCalendar.tsx"), "utf8");
  await check("the preview's calendar reads live open times and books nothing", () => {
    assert.match(calendar, /async function load\(\) \{\s*if \(preview\) return loadPreview\(\);/, "the preview asks for a lead's availability");
    assert.match(calendar, /fetch\(`\/api\/forms\/booking\/slots\?form=\$\{encodeURIComponent\(formSlug\)\}&preview=1`\)/);
    const book = calendar.slice(calendar.indexOf("  async function book() {"));
    const previewAt = book.indexOf("if (preview) {");
    assert.ok(previewAt > 0 && previewAt < book.indexOf("fetch("), "the preview can book");
    assert.match(book.slice(previewAt, book.indexOf("}", previewAt) + 30), /return;/);
    assert.match(calendar, /const link = preview \? \(\s*<span[^>]*>\s*Join the free OASIS Telegram community/, "a preview counts a community click");
    assert.match(calendar, /lead="Not ready to book\? Stay close without starting a sales process\."\s*preview=\{preview\}/, "the calendar's footer counts a preview's click");
  });

  console.log("offer-preview-form: all passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
