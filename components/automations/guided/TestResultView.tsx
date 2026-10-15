/**
 * components/automations/guided/TestResultView.tsx - what "Test now" found, in the words the run wrote.
 *
 * Used on Review and in the list, so a test reads the same in both. A preview never sends, posts or
 * files anything; every email it WOULD have drafted is drawn as a card marked as a preview, so it can
 * never be mistaken for one waiting in Needs you. Only what the server returned is shown.
 */
import type { TestResult } from "@/lib/automations/guided/api-types";
import type { Failure } from "@/lib/automations/guided/flow";
import { Notice, RepairAnchor } from "./ui";

export const PREVIEW_MARK = "Preview only. Nothing was sent or filed.";

export function TestResultView({ result, expectsDrafts }: { result: TestResult; expectsDrafts: boolean }) {
  if (result.status === "failed") {
    return <Notice tone="error">{result.failure && result.failure.trim() ? result.failure.trim() : "The test did not finish. Try again in a moment."}</Notice>;
  }
  if (result.status === "cancelled") return <Notice tone="info">The test was cancelled before it finished.</Notice>;
  const drafts = result.wouldDraft;
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-fg">The test finished. This is what it found:</p>
      <div className="whitespace-pre-wrap break-words rounded-lg border border-hairline bg-bg-deep p-3 text-sm leading-relaxed text-fg">
        {result.finalText.trim() ? result.finalText.trim() : "It finished without writing any text."}
      </div>
      {drafts.length > 0 ? (
        <div className="space-y-2">
          <p className="text-sm font-medium text-fg">
            It would have drafted {drafts.length} {drafts.length === 1 ? "email" : "emails"}:
          </p>
          <ul className="space-y-2">
            {drafts.map((d, i) => (
              <li key={`${d.to}-${i}`} className="space-y-1 rounded-lg border border-dashed border-bg-border-strong bg-bg-panel p-3">
                <p className="break-words text-sm text-fg">
                  <span className="text-fg-muted">To:</span> {d.to}
                </p>
                <p className="break-words text-sm font-medium text-fg">
                  <span className="font-normal text-fg-muted">Subject:</span> {d.subject}
                </p>
                <p className="whitespace-pre-wrap break-words text-sm text-fg-muted">{d.body}</p>
                <p className="pt-1 text-xs font-medium text-fg-muted">{PREVIEW_MARK}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        expectsDrafts && <p className="text-sm text-fg-muted">It would not have drafted any emails right now.</p>
      )}
    </div>
  );
}

/** A refusal: the sentence, then the way to fix it, then every problem with its own fix. */
export function FailureView({ failure }: { failure: Failure }) {
  return (
    <div className="space-y-1">
      <Notice tone="error">{failure.message}</Notice>
      {failure.repair && <RepairAnchor link={failure.repair} />}
      {failure.problems.length > 0 && (
        <ul className="space-y-1 pl-1">
          {failure.problems.map((p, i) => (
            <li key={`${p.code}-${i}`} className="text-sm text-fg-muted">
              <span>{p.message}</span>
              {p.repair && (
                <>
                  {" "}
                  <RepairAnchor link={p.repair} />
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
