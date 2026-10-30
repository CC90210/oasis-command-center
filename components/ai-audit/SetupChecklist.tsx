/**
 * Setup, in one list: what the Free AI Audit needs before a real client, each
 * line from the check its own step makes (lib/ai-audit/setup.ts). Opens by
 * itself while anything is missing; once everything is set up it folds to one
 * line that still says whether client emails and payments are live.
 *
 * A server component with no state: the page reads the checks and hands them in.
 */
import Link from "next/link";
import type { SetupCheck, SetupState } from "@/lib/ai-audit/setup";

const STATE_WORDS: Record<SetupState, string> = { ready: "Ready", test_mode: "Test mode", deferred: "Deferred", missing: "Needs you", unknown: "Not checked" };
const STATE_CLASS: Record<SetupState, string> = {
  ready: "text-status-engaged",
  test_mode: "text-status-warm",
  deferred: "text-status-warm",
  missing: "text-status-hot",
  unknown: "text-status-warm",
};

export function setupSummary(checks: SetupCheck[]): { text: string; tone: SetupState } {
  const missing = checks.filter((c) => c.state === "missing").length;
  const unchecked = checks.filter((c) => c.state === "unknown").length;
  const testing = checks.filter((c) => c.state === "test_mode").length;
  const deferred = checks.filter((c) => c.state === "deferred").length;
  if (missing) return { text: `${missing} thing${missing === 1 ? "" : "s"} to set up before a real client`, tone: "missing" };
  if (unchecked) return { text: `${unchecked} check${unchecked === 1 ? "" : "s"} could not be read`, tone: "unknown" };
  if (testing || deferred) {
    const states = [...(testing ? ["client emails or payments are still in test mode"] : []), ...(deferred ? ["model and web search are deferred"] : [])];
    return { text: `Set up. ${states.join("; ")}.`, tone: testing ? "test_mode" : "deferred" };
  }
  return { text: "Set up and live.", tone: "ready" };
}

export function SetupChecklist({ checks, open }: { checks: SetupCheck[]; open?: boolean }) {
  const summary = setupSummary(checks);
  return (
    <details id="setup" open={open ?? (summary.tone === "missing" || summary.tone === "unknown")} className="rounded-xl border border-hairline bg-bg-panel">
      <summary className="cursor-pointer px-4 py-2.5 text-sm">
        <span className="font-medium text-fg">Setup</span>
        <span className={`ml-2 ${STATE_CLASS[summary.tone]}`}>{summary.text}</span>
      </summary>
      <ul className="divide-y divide-hairline border-t border-hairline text-sm">
        {checks.map((c) => (
          <li key={c.key} className="grid gap-x-3 gap-y-0.5 px-4 py-2 sm:grid-cols-[6.5rem_9.5rem_minmax(0,1fr)]">
            <span className={`text-[13px] font-medium ${STATE_CLASS[c.state]}`}>{STATE_WORDS[c.state]}</span>
            <span className="text-fg">{c.label}</span>
            <span className="text-fg-muted">
              {c.detail}
              {c.link ? (
                <>
                  {" "}
                  <Link href={c.link.href} className="font-medium text-fg underline underline-offset-2">
                    {c.link.label}
                  </Link>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}
