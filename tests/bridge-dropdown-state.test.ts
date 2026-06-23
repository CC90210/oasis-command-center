import assert from "node:assert/strict";
import {
  deriveDropdownState,
  DROPDOWN_SUFFIX,
  isDropdownEnabled,
  type DropdownState,
} from "../lib/bridge-dropdown-state";

// Regression locks for the chat-picker state machine. Mirrors the cases in
// bridge-effective-online.test.ts but adds the 4-state distinction the UI
// needs to render distinct suffixes + enable/disable behavior.

// ---- 1. State derivation matrix ----
const matrix: Array<[boolean | null, boolean | undefined, DropdownState]> = [
  // bridgeOnline, serverBridgeOnline, expectedState
  [true, true, "online"],
  [true, false, "online"],
  [true, undefined, "online"],
  [false, true, "degraded"],
  [null, true, "degraded"],
  [false, false, "offline"],
  [false, undefined, "offline"],
  [null, false, "checking"],
  [null, undefined, "checking"],
];

for (const [b, sb, expected] of matrix) {
  assert.equal(
    deriveDropdownState(b, sb),
    expected,
    `deriveDropdownState(${JSON.stringify(b)}, ${JSON.stringify(sb)}) should be ${expected}`,
  );
}

// ---- 2. Suffix table is exhaustive ----
const states: DropdownState[] = ["online", "degraded", "checking", "offline"];
for (const s of states) {
  assert.ok(
    s in DROPDOWN_SUFFIX,
    `DROPDOWN_SUFFIX must define a string for ${s}`,
  );
  assert.equal(
    typeof DROPDOWN_SUFFIX[s],
    "string",
    `DROPDOWN_SUFFIX[${s}] must be a string`,
  );
}
// Online state has no suffix; others do.
assert.equal(DROPDOWN_SUFFIX.online, "");
assert.ok(DROPDOWN_SUFFIX.degraded.includes("degraded"));
assert.ok(DROPDOWN_SUFFIX.checking.includes("checking"));
assert.ok(DROPDOWN_SUFFIX.offline.includes("offline"));

// ---- 3. isDropdownEnabled — online + degraded enabled; checking + offline disabled ----
// The Matt scenario (round 3 / 4) is specifically that degraded must
// remain ENABLED. The user can click and the tool call surfaces a clear
// error if the proxy is genuinely broken — but we no longer silently
// disable the dropdown when the daemon is alive.
assert.equal(isDropdownEnabled("online"), true, "online → enabled");
assert.equal(isDropdownEnabled("degraded"), true, "degraded → ENABLED (Matt fix)");
assert.equal(isDropdownEnabled("checking"), false, "checking → disabled");
assert.equal(isDropdownEnabled("offline"), false, "offline → disabled");

console.log("bridge-dropdown-state.test.ts: OK");
