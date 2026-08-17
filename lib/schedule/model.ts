export const SCHEDULE_SCHEMA_VERSION = 1 as const;
export const MINUTES_PER_DAY = 24 * 60;
export const DAYS = [
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
] as const;

export type ScheduleDay = (typeof DAYS)[number];
export type ScheduleCategory = "morning" | "work" | "personal" | "observance";

export type ScheduleBlock = {
  id: string;
  title: string;
  day: ScheduleDay;
  startMinute: number;
  endMinute: number;
  category: ScheduleCategory;
  parentId?: string;
  locked?: boolean;
  system?: "shabbat";
};

export type ScheduleDocument = {
  schemaVersion: typeof SCHEDULE_SCHEMA_VERSION;
  timezone: string;
  weekStartsOn: string;
  updatedAt: string;
  blocks: ScheduleBlock[];
};

export const isEditableBlock = (block: ScheduleBlock) => !block.locked && !block.system;

export function clampBlock(block: ScheduleBlock): ScheduleBlock {
  const startMinute = Math.max(0, Math.min(MINUTES_PER_DAY - 15, block.startMinute));
  const endMinute = Math.max(startMinute + 15, Math.min(MINUTES_PER_DAY, block.endMinute));
  return { ...block, startMinute, endMinute };
}

const morning = [
  ["wake-up", "Wake up", 390, 420],
  ["praying", "Praying", 420, 450],
  ["run", "Run", 450, 495],
  ["abs", "Abs", 495, 525],
  ["breakfast", "Breakfast", 525, 570],
  ["eating", "Eating", 570, 600],
] as const;

export function createPlaceholderSchedule(now = new Date()): ScheduleDocument {
  const monday = new Date(now);
  const mondayOffset = (now.getDay() + 6) % 7;
  monday.setDate(now.getDate() - mondayOffset);
  const weekStartsOn = monday.toISOString().slice(0, 10);
  const blocks: ScheduleBlock[] = [];

  for (const day of DAYS) {
    if (day === "Saturday" || day === "Sunday") continue;
    for (const [id, title, startMinute, endMinute] of morning) {
      blocks.push({ id: `${day}-${id}`, title, day, startMinute, endMinute, category: "morning" });
    }
    const parentId = `${day}-work`;
    blocks.push({ id: parentId, title: "Work", day, startMinute: 600, endMinute: 1020, category: "work" });
    blocks.push(
      { id: `${parentId}-clients`, parentId, title: "Client fulfillment", day, startMinute: 600, endMinute: 780, category: "work" },
      { id: `${parentId}-systems`, parentId, title: "Internal systems", day, startMinute: 810, endMinute: 900, category: "work" },
      { id: `${parentId}-rnd`, parentId, title: "Agent training / R&D", day, startMinute: 930, endMinute: 1020, category: "work" },
    );
  }

  // Scaffold times until the weekly sundown calculator is connected. These
  // blocks are system-owned and deliberately cannot be moved or resized.
  blocks.push(
    { id: "shabbat-friday", title: "Shabbat begins · sundown", day: "Friday", startMinute: 1080, endMinute: 1440, category: "observance", locked: true, system: "shabbat" },
    { id: "shabbat-saturday", title: "Shabbat · until sundown", day: "Saturday", startMinute: 0, endMinute: 1140, category: "observance", locked: true, system: "shabbat" },
  );

  return {
    schemaVersion: SCHEDULE_SCHEMA_VERSION,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Toronto",
    weekStartsOn,
    updatedAt: now.toISOString(),
    blocks,
  };
}

export function isScheduleDocument(value: unknown): value is ScheduleDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as Partial<ScheduleDocument>;
  return doc.schemaVersion === SCHEDULE_SCHEMA_VERSION && Array.isArray(doc.blocks) &&
    doc.blocks.every((block) => {
      if (!block || typeof block !== "object") return false;
      const item = block as Partial<ScheduleBlock>;
      return typeof item.id === "string" && typeof item.title === "string" &&
        DAYS.includes(item.day as ScheduleDay) && typeof item.startMinute === "number" &&
        typeof item.endMinute === "number" && item.endMinute > item.startMinute;
    });
}

export function formatTime(minutes: number) {
  if (minutes === MINUTES_PER_DAY) return "12 AM";
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = hours >= 12 ? "PM" : "AM";
  const hour = hours % 12 || 12;
  return `${hour}${mins ? `:${String(mins).padStart(2, "0")}` : ""} ${suffix}`;
}
