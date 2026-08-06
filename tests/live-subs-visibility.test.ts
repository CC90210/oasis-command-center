import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isLeadListVisible } from "../lib/lead-list-visibility";

assert.equal(isLeadListVisible({ stage: "uw_sheet", transferred_at: "2026-01-01T00:00:00Z" }), true,
  "legacy transferred Live Subs remain visible");
assert.equal(isLeadListVisible({ stage: "uw_sheet", transferred_at: null }), true,
  "normal Live Subs remain visible");
assert.equal(isLeadListVisible({ stage: "hot_lead", transferred_at: "2026-01-01T00:00:00Z" }), false,
  "ordinary transferred leads stay on Applications only");

const source = fs.readFileSync(path.join(process.cwd(), "lib/manifest/data.ts"), "utf8");
assert.equal((source.match(/data->>transferred_at\.is\.null,data->>stage\.eq\.uw_sheet/g) || []).length, 2,
  "owned/admin and collaborator lead queries preserve Live Subs");

console.log("Live Subs visibility tests passed");
