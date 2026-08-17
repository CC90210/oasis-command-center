import assert from "node:assert/strict";
import { CC_NAV, SUGA_NAV, SUN_NAV } from "../lib/nav-config";

const href = "/arthrisil-marketing";

assert.equal(
  CC_NAV.some((item) => item.href === href && item.label === "Arthrisil Marketing"),
  true,
  "the OASIS operator navigation should expose Arthrisil Marketing",
);

assert.equal(
  SUN_NAV.some((item) => item.href === href),
  false,
  "the SunBiz tenant must not receive the Arthrisil tab",
);

assert.equal(
  SUGA_NAV.some((item) => item.href === href),
  false,
  "the Suga tenant must not receive the Arthrisil tab",
);

console.log("arthrisil marketing nav boundary: passed");
