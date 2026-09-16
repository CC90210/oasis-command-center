/**
 * The copy rules for every sentence a rep says out loud.
 *
 * ITS OWN MODULE, AND PURE, for a reason the build found rather than a
 * preference. These rules started life inside admin.ts, which imports
 * supabase-server. The practice trainer is a CLIENT component and needs the
 * same rules to check what a rep typed, so importing them from admin.ts
 * dragged a server-only module into the browser bundle and the build refused
 * it. The rules are doctrine shared by every door into the objection copy, not
 * something the authoring path owns, so they live where anything can reach
 * them: no I/O, no imports.
 *
 * Every door into the copy uses these. The seed's own test pins the same rules
 * over the seeded source, the authoring routes run them before any insert or
 * update, the model-drafting path runs them over generated text, and the
 * trainer runs them over what a rep types. A rule enforced at one door and not
 * another is decorative.
 */

// ---------------------------------------------------------------------------
// Copy rules on the WRITE path.
//
// tests/objection-copy.test.ts pins the same rules over the SEED source, which
// is the only door that existed when it was written. This surface is a second
// door into the same table, and a guard that covers one of two doors is
// decorative. These run before any insert or update, so a sentence typed into
// the UI faces exactly what a seeded one faces.
// ---------------------------------------------------------------------------

/** Em dash and en dash. Both are the standing tell of generated text in
 *  customer-facing copy, and both render as a dash a rep stumbles over. */
const DASH = /[—–]/;
/** A double hyphen renders literally on the card rather than as a dash. */
const DOUBLE_HYPHEN = /--/;
/** A currency symbol, or a figure attached to a money word. A rep reading a
 *  number off a script is quoting a price nobody scoped to that business. */
const MONEY = /[$£€]|\b\d[\d,.]*\s*(?:dollars?|bucks|grand|cents?|k)\b/i;

/** The longest a single spoken answer may be. Not a style preference: past
 *  this a rep stops reading it and starts paraphrasing, and a paraphrased
 *  answer is not the one the scoreboard thinks was used. */
export const MAX_BODY_LENGTH = 1200;
/** The longest an objection itself may be. It is a sentence a customer said. */
export const MAX_SAYS_LENGTH = 400;

/**
 * Every copy rule violated by `text`, as human-readable sentences. Empty means
 * it passes. Returns ALL of them rather than the first, so somebody pasting a
 * batch fixes their wording once instead of discovering the rules one at a
 * time.
 */
export function copyViolations(text: string, field: string, maxLength: number): string[] {
  const out: string[] = [];
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    out.push(`${field} is empty.`);
    return out;
  }
  if (trimmed.length > maxLength) {
    out.push(`${field} is ${trimmed.length} characters, over the ${maxLength} limit.`);
  }
  if (DASH.test(trimmed)) out.push(`${field} contains an em or en dash. Use a comma, a period or a hyphen.`);
  if (DOUBLE_HYPHEN.test(trimmed)) out.push(`${field} contains a double hyphen, which renders literally on the card.`);
  if (MONEY.test(trimmed)) out.push(`${field} states a money figure. A spoken line must never quote an unscoped price.`);
  return out;
}
