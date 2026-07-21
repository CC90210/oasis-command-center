import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";

const source = fs.readFileSync(path.join(process.cwd(), "components/leads/LeadFileBody.tsx"), "utf8");

assert.match(source, /aria-label="Resize merchant summary"/, "drawer exposes a draggable summary divider");
assert.match(source, /"Collapse merchant summary"/, "drawer summary can be collapsed");
assert.match(source, /overflow-y-auto/, "drawer sections retain independent vertical scrolling");

console.log("lead-drawer-layout ok");
