/**
 * Server-renders PhoneTrust and asserts what actually reaches the HTML.
 *
 * WHY THIS IS A RENDER AND NOT A GREP
 *
 * The rule this protects is Adon's, verbatim: *"If you're unsure, you still put
 * the phone number but there's a warning that it might not be the right
 * number."* So a warned number must still be printed, and must still be
 * dialable.
 *
 * The first version of that test grepped the source for ``href={`tel:`` and
 * passed. Then a deliberate plant made the link conditional on the tier
 * (`dialable && lead.phoneTier !== "warned"`) and the test STILL passed, because
 * the `tel:` href was right there in the untaken branch. A source grep cannot
 * tell a rendered link from a dead one. Only rendering can.
 *
 *   TSX_TSCONFIG_PATH=tsconfig.render-check.json \
 *     node --import tsx scripts/render-phone-trust-check.tsx
 */

import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PhoneTrust, PhoneTierBadge } from "../components/web-leads/PhoneTrust";
import type { WebLead } from "../lib/web-leads/data";

type PhoneBits = Pick<WebLead, "phone" | "phoneTier" | "phoneReasons" | "phoneExt" | "phoneAlternates">;

const lead = (over: Partial<PhoneBits> = {}): PhoneBits => ({
  phone: "(514) 990-0199",
  phoneTier: "probable",
  phoneReasons: [],
  phoneExt: null,
  phoneAlternates: [],
  ...over,
});

const text = (html: string) =>
  html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

// ---- THE RULE: a warned number is still printed and still dialable ----------
{
  const warned = lead({
    phoneTier: "warned",
    phoneReasons: ["1 other business in our list show this same number, so it may belong to them."],
  });
  const html = renderToStaticMarkup(<PhoneTrust lead={warned} />);

  assert.ok(text(html).includes("(514) 990-0199"), "a warned number must still be printed in full");
  assert.match(html, /href="tel:5149900199"/, "a warned number must still be dialable");
  assert.ok(
    text(html).includes("1 other business"),
    "the reason must be printed, or the warning is a badge with no meaning",
  );
  assert.ok(text(html).includes("Check before dialling"), "the warned label must be readable, not just a shape");
}

// Every tier renders the number and the link. None of them is a filter.
for (const tier of ["verified", "probable", "warned", null] as const) {
  const html = renderToStaticMarkup(<PhoneTrust lead={lead({ phoneTier: tier })} />);
  assert.ok(text(html).includes("(514) 990-0199"), `${tier}: the number must be printed`);
  assert.match(html, /href="tel:5149900199"/, `${tier}: the number must be dialable`);
}

// ---- an unassessed lead says so, rather than borrowing a tier ---------------
{
  const html = renderToStaticMarkup(<PhoneTrust lead={lead({ phoneTier: null })} />);
  assert.ok(text(html).includes("Not checked yet"), "an unassessed number must say it was never checked");
  assert.ok(!text(html).includes("Confirmed"), "an unassessed number must not read as confirmed");
}

// ---- the extension survives to the screen ----------------------------------
{
  const html = renderToStaticMarkup(<PhoneTrust lead={lead({ phoneExt: "44086" })} />);
  assert.ok(text(html).includes("ext. 44086"), "dialling without a listed extension reaches the main line");
}

// ---- alternates are offered, and dialable ----------------------------------
{
  const html = renderToStaticMarkup(<PhoneTrust lead={lead({ phoneAlternates: ["(888) 777-8601"] })} />);
  assert.ok(text(html).includes("(888) 777-8601"), "a backup number must be shown");
  assert.match(html, /href="tel:8887778601"/, "a backup number must be dialable too");
}

// ---- compact mode drops the prose, NEVER the badge or the number -----------
{
  const warned = lead({ phoneTier: "warned", phoneReasons: ["Some reason about this number."] });
  const html = renderToStaticMarkup(<PhoneTrust lead={warned} compact />);
  assert.ok(text(html).includes("(514) 990-0199"), "compact must still print the number");
  assert.ok(
    text(html).includes("Check before dialling"),
    "compact must still flag a doubtful number, or a scanning rep sees nothing",
  );
  assert.ok(!text(html).includes("Some reason about this number"), "compact drops the prose");
}

// ---- no number at all is stated in words, never rendered blank -------------
{
  const html = renderToStaticMarkup(<PhoneTrust lead={lead({ phone: null })} />);
  assert.ok(text(html).includes("No phone number was listed"), "a missing number must say so");
}

// ---- the badge alone still carries a word, not only a shape ----------------
for (const [tier, word] of [
  ["verified", "Confirmed"],
  ["probable", "Not confirmed"],
  ["warned", "Check before"],
  [null, "Not checked"],
] as const) {
  const html = renderToStaticMarkup(<PhoneTierBadge tier={tier} />);
  assert.ok(
    text(html).includes(word),
    `${tier}: the badge must carry a word; a shape alone is unreadable to a rep in a hurry`,
  );
}

console.log("phone-trust render check ok");
