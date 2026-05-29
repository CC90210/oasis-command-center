import assert from "node:assert/strict";
import { getPersona } from "../lib/agent-personas";

// Regression locks for the 2026-05-29 per-user agent rename feature.
// The expected behaviour: when displayNameOverride is supplied, the
// persona returned by getPersona() starts with a "[OPERATOR-FACING
// DISPLAY NAME]" prelude binding the agent to the supplied name.
// When the override is null/empty/whitespace, the prelude is NOT
// injected and the canonical agent persona surfaces unmodified.

// Case 1 — explicit display name supplied; prelude appears with the
// exact name baked in.
const renamed = getPersona("solara", null, "Ada");
assert.ok(
  renamed.includes("[OPERATOR-FACING DISPLAY NAME]"),
  "non-empty override must inject the display-name prelude",
);
assert.ok(
  renamed.includes('display name is "Ada"'),
  "prelude must echo the supplied name verbatim",
);
// The canonical Solara persona MUST still be present below the prelude
// so the agent's reasoning/behaviours are unchanged.
assert.ok(
  renamed.includes("operations agent for a business-funding shop"),
  "canonical Solara persona body must survive the rename",
);
// Identity lock overlay always appended.
assert.ok(
  renamed.includes("[IDENTITY LOCK"),
  "identity lock overlay must always be appended",
);

// Case 2 — null override; canonical persona untouched, no prelude.
const canonical = getPersona("solara", null, null);
assert.ok(
  !canonical.includes("[OPERATOR-FACING DISPLAY NAME]"),
  "null override must NOT inject the prelude",
);
assert.ok(
  canonical.includes("operations agent for a business-funding shop"),
  "canonical Solara persona renders without prelude",
);

// Case 3 — empty string and whitespace-only treated as no override.
const empty = getPersona("solara", null, "");
const whitespace = getPersona("solara", null, "   ");
assert.ok(
  !empty.includes("[OPERATOR-FACING DISPLAY NAME]"),
  "empty-string override is a no-op",
);
assert.ok(
  !whitespace.includes("[OPERATOR-FACING DISPLAY NAME]"),
  "whitespace-only override is a no-op",
);

// Case 4 — display name + system_prompt_override stack. Override
// replaces the base persona, then the display name prelude wraps
// THAT, so the agent self-identifies with the rename even when the
// operator has provided custom system prompt content.
const stacked = getPersona("solara", "You are a custom agent for X tenant.", "Ada");
assert.ok(
  stacked.includes("[OPERATOR-FACING DISPLAY NAME]"),
  "display name prelude fires even when system_prompt_override is set",
);
assert.ok(
  stacked.includes('display name is "Ada"'),
  "display name prelude echoes name even with custom system prompt",
);
assert.ok(
  stacked.includes("You are a custom agent for X tenant."),
  "system_prompt_override body survives display-name wrap",
);
assert.ok(
  !stacked.includes("operations agent for a business-funding shop"),
  "system_prompt_override fully replaces the canonical Solara persona",
);

// Case 5 — name is trimmed before embedding. Padding shouldn't leak
// into the prelude string.
const padded = getPersona("solara", null, "  Ada  ");
assert.ok(
  padded.includes('display name is "Ada"'),
  "leading/trailing whitespace must be trimmed before embedding",
);
assert.ok(
  !padded.includes('display name is "  Ada  "'),
  "raw padded value must not appear in the prelude",
);

console.log("Agent display-name override tests passed");
