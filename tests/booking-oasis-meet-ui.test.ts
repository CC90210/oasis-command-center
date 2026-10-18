import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const booking = readFileSync("components/booking/BookingPage.tsx", "utf8");
assert.match(booking, /`LOCATION:\$\{booked\.meetUrl\}`/);
// The .ics names the link, then Maven's recording notice when the room records (lib/meet/recording-notice.ts).
assert.match(booking, /`DESCRIPTION:Join the call: \$\{booked\.meetUrl\}\$\{booked\.recorded \? `\\\\n\$\{MEET_RECORDING_NOTICE\}` : ""\}`/);
assert.match(booking, /booked\.recorded \? ` \$\{MEET_RECORDING_NOTICE\}` : ""/, "the confirmation says so too, as text");
assert.match(booking, /`URL:\$\{booked\.meetUrl\}`/);
assert.match(booking, />\s*Join the call\s*</);
assert.match(booking, /<dd className="text-fg">Video call<\/dd>/);

const publicCalendar = readFileSync("components/forms/PublicBookingCalendar.tsx", "utf8");
assert.match(publicCalendar, /Join the call/);
assert.match(publicCalendar, /video call invite arrives instantly/);

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
