import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FOUNDERS_PORTAL } from "../lib/portals/registry";

const root = join(__dirname, "..");
const href = "/founders/marketing/arthrisil";

assert.equal(
  FOUNDERS_PORTAL.sections.some((section) => section.href === href),
  false,
  "Arthrisil must not remain a standalone Marketing tab",
);

const pagePath = join(root, "app/founders/marketing/arthrisil/page.tsx");
const page = readFileSync(pagePath, "utf8");
assert.match(page, /redirect\("\/founders\/marketing\/library\?group=clients&brand=arthrisil"\)/, "the former tab must redirect into Library → Clients");

const library = readFileSync(join(root, "app/founders/marketing/library/page.tsx"), "utf8");
assert.match(library, /arthrisil-social-proof-v2\.mp4/, "Library → Clients must render the V2 edit");
assert.match(library, /internal-review/, "the client asset must carry its rights metadata");
assert.match(library, /group === "clients"/, "the client asset must be scoped to the Clients library tab");

const legacy = readFileSync(join(root, "app/arthrisil-marketing/page.tsx"), "utf8");
assert.match(legacy, /redirect\("\/founders\/marketing\/library\?group=clients&brand=arthrisil"\)/, "the old URL must redirect into Library → Clients");

console.log("arthrisil marketing placement: passed");
