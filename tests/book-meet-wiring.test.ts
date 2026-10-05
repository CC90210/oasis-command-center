/**
 * Book the Meet is wired where the call happens: the battle card (Hero and the
 * Log panel) and Call Mode (the M key and a button), without breaking the
 * card's seven-section contract or Call Mode's queue loop.
 * Run: node --conditions=react-server --import tsx tests/book-meet-wiring.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const card = strip(readFileSync("components/web-leads/BattleCard.tsx", "utf8"));

assert.match(card, /import \{ BookMeetPanel \} from "\.\/BookMeetPanel"/);
// In the Log panel, before the call log, and never behind a disclosure.
// The NEAREST <Panel> before the call log, not the first one in the file.
const callLogAt = card.indexOf("<CallOutcomeLog");
const panelAt = card.lastIndexOf("<Panel>", callLogAt);
assert.ok(callLogAt > 0 && panelAt > 0, "could not find the Log this call panel");
const logPanel = card.slice(panelAt, card.indexOf("</Panel>", callLogAt));
assert.match(logPanel, /<BookMeetPanel/, "Book the Meet must sit in the Log this call panel");
assert.ok(logPanel.indexOf("<BookMeetPanel") < logPanel.indexOf("<CallOutcomeLog"), "Book the Meet goes above the outcome buttons");
assert.doesNotMatch(card, /<BattleSection[^>]*>[\s\S]{0,400}?<BookMeetPanel/, "Book the Meet must not be behind a collapsible section");
// Only for a rep who may work the lead.
assert.match(card, /canMutate && \(/, "the panel and its trigger render only when canMutate");
// The Hero can open it.
assert.match(card, /onBookMeet=\{/, "the Hero must get an onBookMeet handler");
assert.match(card, /Book the Meet/);
// The card still renders seven sections with the same defaults (pinned in web-leads-battlecard.test.ts).

// Booking logs the call, so the call history sitting right under the form must
// pick that up without a reload (Codex P2 on Task 8): otherwise the rep sees no
// call on record after booking and logs it a second time. BookMeetPanel already
// announces the write on "oasis:lead-touch"; the history listens for it, scoped
// to its own lead, the same way LeadTimelinePanel does.
const panel = strip(readFileSync("components/web-leads/BookMeetPanel.tsx", "utf8"));
assert.match(panel, /dispatchEvent\(new CustomEvent\("oasis:lead-touch", \{ detail: \{ leadId \} \}\)\)/, "the booking flow must announce the call it logged");
const outcomeLog = strip(readFileSync("components/web-leads/CallOutcomeLog.tsx", "utf8"));
assert.match(outcomeLog, /addEventListener\("oasis:lead-touch"/, "the call history must refresh when a booking logs the call");
assert.match(outcomeLog, /removeEventListener\("oasis:lead-touch"/, "the call history must stop listening on unmount or lead change");
assert.match(outcomeLog, /detail\.leadId === leadId/, "a touch on a different lead must not refresh this lead's history");

// ── Call Mode half is added in Task 9. ──
console.log("book-meet-wiring (battle card): OK");
