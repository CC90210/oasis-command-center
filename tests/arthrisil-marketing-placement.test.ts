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
assert.match(library, /arthrisil-social-proof-v6\.mp4/, "Library → Clients must render the V6 single-source edit");
assert.match(library, /internal-review/, "the client asset must carry its rights metadata");
assert.match(library, /group === "clients"/, "the client asset must be scoped to the Clients library tab");
// Through the Library's lazy player, like every tile: a cover until someone
// presses play. It used to mount a <video> (and its 983 KB poster) whenever the
// Clients tab opened.
assert.match(
  library,
  /<TileVideo\s+src="\/media\/arthrisil-marketing\/arthrisil-social-proof-v6\.mp4"/,
  "the V6 edit must render through TileVideo",
);
const libraryCode = library.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
assert.doesNotMatch(libraryCode, /<video\b/, "no <video> mounts on arrival anywhere in the Library page");

const legacy = readFileSync(join(root, "app/arthrisil-marketing/page.tsx"), "utf8");
assert.match(legacy, /redirect\("\/founders\/marketing\/library\?group=clients&brand=arthrisil"\)/, "the old URL must redirect into Library → Clients");

console.log("arthrisil marketing placement: passed");
