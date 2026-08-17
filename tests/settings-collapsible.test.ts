/**
 * The settings page collapses, and its deep links still land somewhere visible.
 *
 * CC, 2026-08-17: "instead of it being a long page with all these different
 * features and settings, it should be a bunch of subheadings that I can click
 * on… That's all I'm asking for."
 *
 * The risk in granting that is not the collapsing — it is what collapsing does
 * to the anchors. `/settings#providers` and `/settings#agents` are linked from
 * eight places, several of them chat FAILURE states ("the chat retried 3 times…
 * switch model in Settings"). A browser scrolls to a `<details>` without opening
 * it, so someone following a link because something is already broken would land
 * on a closed bar with the control hidden inside, and conclude the link is dead.
 *
 * These assertions pin the three things that keep that from happening.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const SETTINGS = readFileSync(join(ROOT, "components/settings/SettingsContent.tsx"), "utf8");

/** Sections that must be reachable by fragment, and who links to them. */
const ANCHORED = ["providers", "agents"];

test("the settings page is built from collapsible sections", () => {
  const sections = SETTINGS.split("<SettingsSection").length - 1;
  assert.ok(
    sections >= 8,
    `expected the settings body to be collapsible sections, found ${sections}. ` +
      "If these went back to <Card>, the page is a single scroll again.",
  );
});

test("every anchored section still carries its id", () => {
  for (const id of ANCHORED) {
    assert.ok(
      new RegExp(`id="${id}"`).test(SETTINGS),
      `#${id} is linked from elsewhere in the app and its section lost the id`,
    );
  }
});

test("something opens the section a fragment points at", () => {
  // Without this, collapsing silently breaks every deep link on the page.
  assert.ok(
    SETTINGS.includes("<OpenSectionOnHash"),
    "SettingsContent must render OpenSectionOnHash, or /settings#providers scrolls " +
      "to a collapsed bar and the control stays hidden",
  );
  const opener = readFileSync(
    join(ROOT, "components/settings/OpenSectionOnHash.tsx"), "utf8",
  );
  assert.ok(opener.includes('"use client"'), "the opener needs the browser");
  assert.ok(
    opener.includes("hashchange"),
    "clicking a second #agents link while already on /settings changes only the " +
      "fragment and fires no navigation — without a hashchange listener the " +
      "section never opens",
  );
  assert.ok(
    /\.open\s*=\s*true/.test(opener),
    "the opener must actually open the <details>",
  );
});

test("the deep links this protects still exist", () => {
  // Guards the guard: if nothing links to these anchors any more, the
  // assertions above are protecting a contract nobody holds, and this test
  // should be revisited rather than left as decoration.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e.startsWith(".")) continue;
      const full = join(dir, e);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e)) files.push(full);
    }
  };
  walk(join(ROOT, "app"));
  walk(join(ROOT, "components"));

  for (const id of ANCHORED) {
    const linkers = files.filter((f) => readFileSync(f, "utf8").includes(`/settings#${id}`));
    assert.ok(
      linkers.length > 0,
      `nothing links to /settings#${id} any more — re-check whether this anchor ` +
        "is still worth protecting",
    );
  }
});
