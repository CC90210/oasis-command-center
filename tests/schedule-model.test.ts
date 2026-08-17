import assert from "node:assert/strict";
import {
  createPlaceholderSchedule,
  createScheduleBlock,
  isEditableBlock,
  isScheduleDocument,
  overlapsProtectedTime,
} from "../lib/schedule/model";

const schedule = createPlaceholderSchedule(
  new Date("2026-08-17T12:00:00.000Z"),
);
assert.equal(schedule.schemaVersion, 1);
assert.equal(schedule.weekStartsOn, "2026-08-17");
assert.ok(isScheduleDocument(schedule));

const work = schedule.blocks.find((block) => block.title === "Work");
assert.ok(work);
assert.equal(
  schedule.blocks.filter((block) => block.parentId === work.id).length,
  3,
);

const shabbat = schedule.blocks.filter((block) => block.system === "shabbat");
assert.equal(shabbat.length, 2);
assert.ok(shabbat.every((block) => !isEditableBlock(block)));
assert.equal(
  shabbat.find((block) => block.day === "Friday")?.startMinute,
  18 * 60,
);
assert.equal(
  shabbat.find((block) => block.day === "Saturday")?.endMinute,
  19 * 60,
);

const fridayDinner = createScheduleBlock({
  title: "Dinner",
  day: "Friday",
  startMinute: 17 * 60,
  endMinute: 18 * 60,
  category: "personal",
});
assert.equal(fridayDinner.title, "Dinner");
assert.equal(overlapsProtectedTime(fridayDinner, schedule.blocks), false);
assert.equal(
  overlapsProtectedTime(
    { ...fridayDinner, endMinute: 18 * 60 + 15 },
    schedule.blocks,
  ),
  true,
);
assert.equal(
  overlapsProtectedTime(
    {
      ...fridayDinner,
      day: "Saturday",
      startMinute: 12 * 60,
      endMinute: 13 * 60,
    },
    schedule.blocks,
  ),
  true,
);

console.log("schedule-model: all assertions passed");
