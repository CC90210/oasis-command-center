import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const booking = readFileSync("components/booking/BookingPage.tsx", "utf8");
assert.match(booking, /`LOCATION:\$\{booked\.meetUrl\}`/);
assert.match(booking, /`DESCRIPTION:Join the call: \$\{booked\.meetUrl\}`/);
assert.match(booking, /`URL:\$\{booked\.meetUrl\}`/);
assert.match(booking, />\s*Join the call\s*</);
assert.match(booking, /<dd className="text-fg">Video call<\/dd>/);

const publicCalendar = readFileSync("components/forms/PublicBookingCalendar.tsx", "utf8");
assert.match(publicCalendar, /Join the call/);
assert.match(publicCalendar, /video call invite arrives instantly/);

const route = readFileSync("app/api/forms/booking/route.ts", "utf8");
assert.match(route, /Video call: \$\{meeting\.receipt\.meetLink\}/);
assert.doesNotMatch(route, /Google Meet: \$\{meeting\.receipt\.meetLink\}/);

console.log("booking-oasis-meet-ui: OK");