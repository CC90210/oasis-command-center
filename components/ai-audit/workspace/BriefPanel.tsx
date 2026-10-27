"use client";

/**
 * The pre-call research brief, on the engagement's "Call and transcripts" tab.
 *
 * What the client's website shows (Verified: our own reading of it), what they
 * said on the AI-audit form (Client-reported), the likely problems to test on
 * the call (Hypotheses, each with how to test it), the facts to confirm and
 * the questions to spend time on, and what could not be checked. Built by
 * code, never by AI (lib/ai-audit/brief.ts). Internal only.
 *
 * "Build the brief" reads the site again and saves a new version; it is open
 * until CC authorizes the client's information (Gate 1).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EngagementView } from "@/lib/ai-audit/view";
import { DISCOVERY_QUESTIONS } from "@/lib/ai-audit/framework";
import { PROFILE_EDIT_STAGES } from "@/lib/ai-audit/rules";
import { describeError, postAction } from "./api";

const ASK = new Map(DISCOVERY_QUESTIONS.map((q) => [q.id, q.ask]));

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Label({ kind }: { kind: "verified" | "client_reported" | "hypothesis" }) {
  const words = kind === "verified" ? "Verified" : kind === "client_reported" ? "Client-reported" : "Hypothesis";
  return <span className="shrink-0 rounded border border-hairline px-1.5 py-px text-[11px] text-fg-muted">{words}</span>;
}

export function BriefPanel({ view }: { view: EngagementView }) {
  const router = useRouter();
  const e = view.engagement;
  const b = view.brief?.content ?? null;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const open = PROFILE_EDIT_STAGES.includes(e.stage);

  async function build() {
    setBusy(true);
    setMessage(null);
    const r = await postAction(e.id, "build_brief");
    setBusy(false);
    if (!r.ok) {
      setMessage(describeError(r));
      return;
    }
    setMessage(r.status === "partial" ? "Brief built. Some checks could not be made: they are listed under Could not check." : "Brief built.");
    router.refresh();
  }

  const siteFacts = b?.facts.filter((f) => f.source.kind === "site") ?? [];
  const formFacts = b?.facts.filter((f) => f.source.kind === "form") ?? [];

  return (
    <section className="grid gap-3 rounded-xl border border-hairline bg-bg-panel p-4 text-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-fg">Before the call: research brief</h2>
          <div className="text-[12px] text-fg-muted">
            {view.brief
              ? `Version ${view.brief.version_no}, built ${when(view.brief.created_at)}${view.brief.status === "partial" ? ", with some checks missing" : ""}.`
              : open
                ? "Not built yet. It builds by itself once the call is booked, or press the button."
                : "No brief was built before the call."}
          </div>
        </div>
        {open ? (
          <button type="button" className={view.brief ? "btn-secondary" : "btn-primary"} disabled={busy} onClick={() => void build()}>
            {busy ? "Reading the website" : view.brief ? "Build it again" : "Build the brief"}
          </button>
        ) : null}
      </div>
      {message ? <div className="rounded-lg border border-hairline px-3 py-2 text-fg">{message}</div> : null}
      {b ? (
        <>
          <div className="text-fg-muted">
            {b.site.kind === "site" ? (
              <>
                Read {b.site.pages_read === 1 ? "1 page" : `${b.site.pages_read} pages`} of <span className="break-all text-fg">{b.site.url}</span>. Nothing is shown to the client.
              </>
            ) : b.site.kind === "social" ? (
              <>The website answer is a {b.site.platform} profile, so no website was read.</>
            ) : (
              <>No website was read.</>
            )}
          </div>

          {b.hypotheses.length ? (
            <div className="grid gap-2">
              <h3 className="text-[13px] font-semibold text-fg">Likely problems to test</h3>
              <ul className="grid gap-2">
                {b.hypotheses.map((h) => (
                  <li key={h.id} className="grid gap-0.5 rounded-lg border border-hairline px-3 py-2">
                    <div className="flex items-start gap-2">
                      <Label kind="hypothesis" />
                      <span className="text-fg">{h.statement}</span>
                    </div>
                    <div className="text-[12px] text-fg-muted">Test it: {h.test}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {b.weight.length ? (
            <div className="grid gap-1">
              <h3 className="text-[13px] font-semibold text-fg">Spend time on</h3>
              <ul className="grid gap-1">
                {b.weight.map((w) => (
                  <li key={w.question_id}>
                    <span className="text-fg">{ASK.get(w.question_id) ?? w.question_id}</span>
                    <div className="text-[12px] text-fg-muted">{w.why}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {siteFacts.length ? (
            <div className="grid gap-1">
              <h3 className="text-[13px] font-semibold text-fg">What the website shows</h3>
              <ul className="grid gap-1">
                {siteFacts.map((f) => (
                  <li key={f.id} className="flex items-start gap-2">
                    <Label kind="verified" />
                    <span className="min-w-0 break-words text-fg">{f.statement}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {formFacts.length ? (
            <div className="grid gap-1">
              <h3 className="text-[13px] font-semibold text-fg">What they said on the form</h3>
              <ul className="grid gap-1">
                {formFacts.map((f) => (
                  <li key={f.id} className="flex items-start gap-2">
                    <Label kind="client_reported" />
                    <span className="min-w-0 break-words text-fg">{f.statement}</span>
                  </li>
                ))}
              </ul>
              {b.confirm.length ? <div className="text-[12px] text-fg-muted">Confirm these in their own words on the call; the live-call screen marks the questions that do it.</div> : null}
            </div>
          ) : null}

          {b.gaps.length ? (
            <div className="grid gap-1">
              <h3 className="text-[13px] font-semibold text-fg">Could not check</h3>
              <ul className="grid list-disc gap-0.5 pl-5 text-fg-muted">
                {b.gaps.map((g) => (
                  <li key={g} className="min-w-0 break-words">
                    {g}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
