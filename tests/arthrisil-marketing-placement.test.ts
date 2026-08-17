import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FOUNDERS_PORTAL } from "../lib/portals/registry";

const root = join(__dirname, "..");
const href = "/founders/marketing/arthrisil";

assert.equal(
  FOUNDERS_PORTAL.sections.some((section) => section.href === href && section.label === "Arthrisil" && section.enabled),
  true,
  "Arthrisil must appear as an enabled sub-tab in the founders Marketing portal",
);

const pagePath = join(root, "app/founders/marketing/arthrisil/page.tsx");
assert.equal(existsSync(pagePath), true, "the Arthrisil Marketing page must exist");
const page = readFileSync(pagePath, "utf8");
assert.match(page, /resolveFounder/, "the Arthrisil page must use the founders gate");
assert.match(page, /notFound\(\)/, "unauthorized callers must fail closed");
assert.match(page, /doctor-source\.mp4/, "the page must render the doctor video");

const legacy = readFileSync(join(root, "app/arthrisil-marketing/page.tsx"), "utf8");
assert.match(legacy, /redirect\("\/founders\/marketing\/arthrisil"\)/, "the old URL must redirect into Marketing");

console.log("arthrisil marketing placement: passed");
