/**
 * The Schedule's Settings dialog can always be saved with any place it offers or has saved.
 *
 * Found in review (2026-10-25): the coordinate inputs used step="0.0001", so a preset or a
 * saved place with a fifth decimal (Collingwood, -80.24071) made the browser mark the form
 * invalid and Save silently never ran. The inputs now accept any precision; every preset is a
 * valid saved place.
 *
 * Run: node --conditions=react-server --import tsx tests/calendar-settings-dialog.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

process.env.TZ = "America/Toronto";

async function main() {
  const source = readFileSync(join(__dirname, "..", "components", "calendar", "SettingsDialog.tsx"), "utf8");
  assert.equal((source.match(/step="0\.0001"/g) || []).length, 0, "no coordinate input may use a fixed 4-decimal step");
  assert.equal((source.match(/type="number" step="any"/g) || []).length, 2, "latitude and longitude accept any precision");

  const { PLACES } = await import("../components/calendar/SettingsDialog");
  const { validatePrefs, salvagePrefs } = await import("../lib/calendar/validate");
  const { NEUTRAL_PREFS } = await import("../lib/calendar/types");
  assert.ok(PLACES.length >= 7, "the presets are exported");
  for (const place of PLACES) {
    const r = validatePrefs({ ...NEUTRAL_PREFS, location: place, shabbatProtection: true });
    assert.ok(r.ok, `${place.label} is a valid saved place`);
    assert.ok(Number.isFinite(place.lat) && Number.isFinite(place.lon), `${place.label} has numeric coordinates`);
  }

  // A stored row with one bad key keeps the rest, place before lock, so an opted-in lock never fails open.
  const toronto = { label: "Toronto", lat: 43.6532, lon: -79.3832 };
  const salvaged = salvagePrefs({ weekStartsOn: 9, location: toronto, shabbatProtection: true, candleMinutesBeforeSunset: 500 }, NEUTRAL_PREFS);
  assert.deepEqual(
    [salvaged.weekStartsOn, salvaged.location?.label, salvaged.shabbatProtection, salvaged.candleMinutesBeforeSunset],
    [NEUTRAL_PREFS.weekStartsOn, "Toronto", true, NEUTRAL_PREFS.candleMinutesBeforeSunset],
    "valid keys survive; invalid ones fall back",
  );
  const lockWithoutPlace = salvagePrefs({ location: "nowhere", shabbatProtection: true }, NEUTRAL_PREFS);
  assert.equal(lockWithoutPlace.shabbatProtection, false, "a lock with no valid place cannot be kept");
  console.log("calendar-settings-dialog: all passed");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
