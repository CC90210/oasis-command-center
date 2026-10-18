import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MEET_RECORDING_NOTICE, withRecordingNotice } from "../lib/meet/recording-notice";

const booking = readFileSync("components/booking/BookingPage.tsx", "utf8");
assert.match(booking, /`LOCATION:\$\{booked\.meetUrl\}`/);
// The .ics names the link, then Maven's recording notice when the room records (lib/meet/recording-notice.ts).
assert.match(booking, /`DESCRIPTION:Join the call: \$\{booked\.meetUrl\}\$\{booked\.recorded \? `\\\\n\$\{MEET_RECORDING_NOTICE\}` : ""\}`/);
assert.match(booking, /withRecordingNotice\(\s*props\.thanksMessage \|\|[^)]*booked\.recorded,\s*\)/, "the confirmation says so too, as text");
assert.match(booking, /`URL:\$\{booked\.meetUrl\}`/);
assert.match(booking, />\s*Join the call\s*</);
assert.match(booking, /<dd className="text-fg">Video call<\/dd>/);

const publicCalendar = readFileSync("components/forms/PublicBookingCalendar.tsx", "utf8");
assert.match(publicCalendar, /Join the call/);
assert.match(publicCalendar, /video call invite arrives instantly/);
// "video call link", never "Meet link": beside "Google sent", Meet reads as Google's, and the room is ours (Maven).
assert.match(publicCalendar, /It includes your private video call link\./);
assert.doesNotMatch(publicCalendar, /private Meet link/);
assert.match(publicCalendar, /withRecordingNotice\([\s\S]*?receipt\.call_recorded === true,\s*\)/);

// The notice joins a confirmation line as its own sentence (Maven's review): a line with no closing stop, such as a
// workspace's custom thanks message, gets one, so the two never run together.
assert.equal(withRecordingNotice("Thanks, talk soon.", false), "Thanks, talk soon.", "unrecorded: the line as given");
assert.equal(withRecordingNotice("Thanks, talk soon.", true), `Thanks, talk soon. ${MEET_RECORDING_NOTICE}`);
assert.equal(withRecordingNotice("Thanks, talk soon", true), `Thanks, talk soon. ${MEET_RECORDING_NOTICE}`);
assert.equal(withRecordingNotice("See you then!", true), `See you then! ${MEET_RECORDING_NOTICE}`);
assert.equal(withRecordingNotice('We said "see you soon."', true), `We said "see you soon." ${MEET_RECORDING_NOTICE}`);
assert.equal(withRecordingNotice("  ", true), MEET_RECORDING_NOTICE);

const route = readFileSync("app/api/forms/booking/route.ts", "utf8");
assert.match(route, /Video call: \$\{meeting\.receipt\.meetLink\}/);
assert.doesNotMatch(route, /Google Meet: \$\{meeting\.receipt\.meetLink\}/);


const founderPanel = readFileSync("components/web-leads/BookMeetPanel.tsx", "utf8");
assert.match(founderPanel, />Video call<\/dt>/);
assert.doesNotMatch(founderPanel, />Google Meet<\/dt>/);

const bookingCopy = readFileSync("lib/website-sales-booking.ts", "utf8");
assert.match(bookingCopy, /short video call with one of our founders/);
assert.doesNotMatch(bookingCopy, /short Google Meet call/);

const lifecycle = readFileSync("app/pipeline/[id]/LeadLifecycleActions.tsx", "utf8");
assert.match(lifecycle, /updates the existing Calendar invite and its video call details/);
assert.doesNotMatch(lifecycle, /preserves its video call link/);

const lifecycleRoute = readFileSync("app/api/website-sales/[leadId]/route.ts", "utf8");
assert.match(
  lifecycleRoute,
  /google_meet_link:verifiedMeeting\?\.receipt\.meetLink/,
  "a replacement room's verified link is written into the lead record",
);

console.log("booking-oasis-meet-ui: OK");
