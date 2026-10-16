#!/usr/bin/env node
/**
 * seed-book-form.ts - create the OASIS "Book a call" form behind oasisai.work/book,
 * and optionally the workspace's booking settings.
 *
 * INSERT-ONLY. Once the form exists it is edited in the form builder (Maven owns
 * the words), so a re-run never overwrites it; it only reports what is there.
 * Same for the booking settings: written only when nothing is saved yet.
 *
 * --settings also saves the booking settings (lib/booking/hours.ts
 * defaultOasisBookingSettings: CC every day 10:00-21:00, Adon Sunday to Thursday
 * 10:00-21:00) with CC's copies landing on HIS calendar named exactly
 * "Meetings" when he has one. The calendar is looked up at run time and printed.
 *
 *   node --import tsx scripts/seed-book-form.ts                       # dry run
 *   node --import tsx scripts/seed-book-form.ts --apply               # form only
 *   node --import tsx scripts/seed-book-form.ts --apply --settings    # form + settings
 *
 * REQUIRES: EMPIRE_DATA_BACKEND=turso_cloud with TURSO_DATABASE_URL +
 * TURSO_AUTH_TOKEN (what getServiceSupabase()/getTursoClient() read).
 */
import { createRequire } from "node:module";
import { tursoConfigured } from "../lib/turso";
import { parseFormBranding, parseFormSteps } from "../lib/forms/types";
import { AI_AUDIT_TENANT_ID, AI_AUDIT_TENANT_SLUG } from "../lib/forms/oasis-ai-audit-seed";
import { BOOK_FORM_SLUG } from "../lib/forms/public-booking-config";
import { buildBookFormRow } from "../lib/forms/oasis-book-seed";

createRequire(import.meta.url)("./allow-server-only.cjs");

const apply = process.argv.includes("--apply");
const withSettings = process.argv.includes("--settings");

if (process.env.EMPIRE_DATA_BACKEND !== "turso_cloud" || !tursoConfigured()) {
  console.error("ERROR: set EMPIRE_DATA_BACKEND=turso_cloud with TURSO_DATABASE_URL + TURSO_AUTH_TOKEN.");
  process.exit(2);
}

async function main(): Promise<void> {
  const { getServiceSupabase } = await import("../lib/supabase-server");
  const { getTursoClient } = await import("../lib/turso");
  const { loadBookingSettings, saveBookingSettings } = await import("../lib/booking/settings-store");
  const { listCalendars } = await import("../lib/calendar/store");
  const db = getServiceSupabase();

  const row = buildBookFormRow(AI_AUDIT_TENANT_ID);
  parseFormSteps(row.steps);
  parseFormBranding(row.branding);

  const existing = await db
    .from("forms")
    .select("id, slug, enabled")
    .eq("tenant_id", AI_AUDIT_TENANT_ID)
    .eq("slug", BOOK_FORM_SLUG)
    .maybeSingle();
  if (existing.error) throw new Error(`forms read failed: ${existing.error.message}`);
  const origin = (process.env.OASIS_PUBLIC_ORIGIN || "https://oasisai.work").replace(/\/$/, "");
  console.log(`workspace  : ${AI_AUDIT_TENANT_SLUG} (${AI_AUDIT_TENANT_ID})`);
  console.log(`form       : ${BOOK_FORM_SLUG} - ${existing.data ? "EXISTS (left as it is)" : "NEW (will insert)"}`);
  console.log(`fields     : ${row.steps[0].fields.map((f) => `${f.name}${f.required ? "*" : ""}`).join(", ")}`);
  console.log(`public URL : ${origin}/book`);

  const loaded = await loadBookingSettings(AI_AUDIT_TENANT_ID);
  let settingsToSave = null as null | typeof loaded.settings;
  if (withSettings) {
    if (loaded.saved) {
      console.log(`settings   : SAVED already (version ${loaded.version}) - left as they are`);
    } else {
      const hosts = await Promise.all(loaded.settings.hosts.map(async (host) => {
        const calendars = await listCalendars({ tenantId: AI_AUDIT_TENANT_ID, userId: host.userId }, { create: false });
        const meetings = calendars.find((c) => c.name.trim().toLowerCase() === "meetings");
        console.log(
          `host       : ${host.role} ${host.userId.slice(0, 8)} -> ${meetings ? `"${meetings.name}" (${meetings.id})` : "default calendar"}`,
        );
        return { ...host, targetCalendarId: meetings ? meetings.id : null };
      }));
      settingsToSave = { ...loaded.settings, hosts };
    }
  }

  if (!apply) {
    console.log("\nDRY RUN - re-run with --apply to write.");
    return;
  }

  if (!existing.data) {
    const res = await db.from("forms").insert(row).select("id, slug").maybeSingle();
    if (res.error) throw new Error(`form insert failed: ${res.error.message}`);
    console.log(`inserted form ${res.data?.id}`);
  }
  if (settingsToSave) {
    const saved = await saveBookingSettings({
      tenantId: AI_AUDIT_TENANT_ID,
      settings: settingsToSave,
      expectedVersion: 0,
      actorUserId: "seed-book-form",
      db: getTursoClient(),
    });
    if (!saved.ok) throw new Error(`settings not saved: ${saved.error} (current version ${saved.version})`);
    console.log(`saved booking settings (version ${saved.version})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
