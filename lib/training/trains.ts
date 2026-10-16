/**
 * lib/training/trains.ts - which agent a training note trains.
 *
 * A note learned on Admin > Agent training (or listed on Content > Training) is a marketing_corpus row.
 * Its `trains` column (bravo__226) says which department agent reads it before it answers:
 *
 *   a department key   that department's agent ("sales", "chief_of_staff", ...)
 *   "all"              every department agent
 *   NULL               a note saved before an agent could be chosen, or by a path that does not choose
 *                      (the Content Training page, the background reader). It trains the MARKETING agent:
 *                      that is who the notes were always written for (the analysis prompt reads "so a
 *                      marketing agent can learn its craft").
 *
 * PURE. The Learn form (a client card), the Agent training page and the server read all use it.
 */
import { OS_DEPARTMENTS } from "@/lib/os/departments";
import type { DepartmentKey } from "@/lib/os/types";

export const TRAINS_ALL = "all" as const;

/** How many notes an agent reads before it answers: its newest ones (lib/os/training-notes.ts). */
export const TRAINING_NOTES_MAX = 5;

/** Who a note with no recorded choice trains. */
export const TRAINS_LEGACY: DepartmentKey = "marketing";

export type Trains = DepartmentKey | typeof TRAINS_ALL;

/** Every value the Learn form offers, "all" first, then the departments in the order the rail shows them. */
export const TRAINS_VALUES: readonly Trains[] = [TRAINS_ALL, ...OS_DEPARTMENTS.map((d) => d.key)];

export function isTrains(value: unknown): value is Trains {
  return typeof value === "string" && (TRAINS_VALUES as readonly string[]).includes(value);
}

/** "All agents", "Sales", "Chief of Staff": the words a person reads. */
export function trainsLabel(value: string | null | undefined): string {
  if (value === TRAINS_ALL) return "All agents";
  const key = value ?? TRAINS_LEGACY;
  return OS_DEPARTMENTS.find((d) => d.key === key)?.label ?? "Marketing";
}

/** The agent a stored value trains, with the legacy rule applied. */
export function effectiveTrains(value: string | null | undefined): Trains {
  return isTrains(value) ? value : TRAINS_LEGACY;
}

/** Whether a note with this stored value trains this department's agent. */
export function notesTrain(stored: string | null | undefined, department: DepartmentKey): boolean {
  const trains = effectiveTrains(stored);
  return trains === TRAINS_ALL || trains === department;
}

/** The Learn form's choices. */
export function trainsOptions(): { value: Trains; label: string }[] {
  return TRAINS_VALUES.map((value) => ({ value, label: trainsLabel(value) }));
}
