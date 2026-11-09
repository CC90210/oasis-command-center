import type { CheckVerdict } from "./checks-core";

/** Consecutive failures OR three failures in six samples confirm an incident.
 * Recovery needs two real successful observations, not a fresh process heartbeat. */
export function incidentWindow(serialized: string | null | undefined, verdict: CheckVerdict, previouslyFailed = false) {
  let prior: CheckVerdict[] = [];
  try {
    const parsed: unknown = JSON.parse(serialized || "[]");
    if (Array.isArray(parsed)) prior = parsed.filter((v): v is CheckVerdict => ["ok", "degraded", "failing", "check_broken"].includes(v));
  } catch { /* Legacy state has no window; its open episode is one prior failure. */ }
  if (!prior.length && previouslyFailed) prior = ["failing"];
  const samples = [...prior.slice(-5), verdict];
  const bad = (v: CheckVerdict) => v !== "ok";
  return {
    serialized: JSON.stringify(samples),
    confirm: bad(verdict) && ((samples.length >= 2 && samples.slice(-2).every(bad)) || samples.filter(bad).length >= 3),
    recovered: samples.length >= 2 && samples.slice(-2).every((v) => v === "ok"),
  };
}
