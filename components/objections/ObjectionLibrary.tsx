"use client";

/**
 * The objection library and the ingest form.
 *
 * WHAT IT DOES NOT DO, stated rather than implied:
 *   - It does not decide anything. Every button here calls a route that checks
 *     the same permission again. `canApprove` only controls whether a control
 *     is OFFERED, because a hidden button is not a permission and a visible
 *     one that 403s is a worse experience than no button at all.
 *   - It never merges duplicates for you. A paste is previewed, never written:
 *     each line comes back with what it looks like, and a human creates the
 *     ones that are genuinely new, one at a time. Folding two objections
 *     together automatically loses the distinction a rep actually heard.
 *   - No colour is keyed to a judgement. Status is state, not a score, and it
 *     is carried by the word first; the tint only follows the word.
 */

import { useCallback, useMemo, useState } from "react";

import { Card, EmptyState } from "@/components/Card";
import type { AdminObjection } from "@/lib/web-leads/objections/admin";
import {
  OBJECTION_FAMILIES,
  OBJECTION_POSTURES,
  POSTURE_LABEL,
  type ObjectionFamily,
  type ObjectionPosture,
} from "@/lib/web-leads/objections/types";

const FAMILY_LABEL: Record<string, string> = {
  brush_off: "Brush off",
  no_need: "No need",
  no_money: "No money",
  no_trust: "No trust",
  no_authority: "No authority",
  already_handled: "Already handled",
};

const STATUS_STYLE: Record<string, string> = {
  approved: "border-accent/40 text-accent",
  draft: "border-amber-500/40 text-amber-500",
  retired: "border-bg-border text-fg-dim line-through",
};

const PILL = "rounded-full border px-2 py-0.5 text-[11px] font-medium";
const BTN =
  "rounded-md border border-bg-border px-2.5 py-1 text-xs font-medium text-fg-muted transition hover:border-accent/50 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";
const INPUT =
  "w-full rounded-md border border-bg-border bg-bg-raised px-3 py-2 text-sm text-fg placeholder:text-fg-dim focus:border-accent/60 focus:outline-none";

type DuplicateVerdict =
  | { kind: "exact"; slug: string; says: string; status: string }
  | { kind: "near"; slug: string; says: string; status: string; score: number }
  | { kind: "none" };

type Candidate = { says: string; duplicate: DuplicateVerdict };

export function ObjectionLibrary({
  initial,
  canApprove,
  readError,
}: {
  initial: AdminObjection[];
  canApprove: boolean;
  readError: string | null;
}) {
  const [tab, setTab] = useState<"library" | "add">("library");
  const [objections, setObjections] = useState(initial);
  const [statusFilter, setStatusFilter] = useState<"all" | "draft" | "approved" | "retired">("all");
  const [familyFilter, setFamilyFilter] = useState<"all" | ObjectionFamily>("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await fetch("/api/objections/catalog");
    if (!res.ok) {
      setError("Could not re-read the library. What you see may be stale.");
      return;
    }
    const data = (await res.json()) as { objections: AdminObjection[] };
    setObjections(data.objections);
    setError(null);
  }, []);

  const act = useCallback(
    async (key: string, url: string, body: unknown) => {
      setBusy(key);
      setError(null);
      try {
        const res = await fetch(url, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const payload = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
          setError(payload.message || payload.error || "That did not go through.");
          return;
        }
        await refresh();
      } catch {
        setError("That did not go through. Nothing was changed.");
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return objections.filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (familyFilter !== "all" && o.family !== familyFilter) return false;
      if (q && !(o.says.toLowerCase().includes(q) || o.slug.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [objections, statusFilter, familyFilter, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Objections">
        {(["library", "add"] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              tab === t ? "bg-accent text-white" : "border border-bg-border text-fg-muted hover:text-fg"
            }`}
          >
            {t === "library" ? "Library" : "Add objections"}
          </button>
        ))}
      </div>

      {readError && (
        <Card title="The library could not be read">
          <p className="text-sm text-fg-muted">
            The list below is empty because the read failed, not because the library is empty. Reload; if it keeps
            failing, the database is the place to look.
          </p>
        </Card>
      )}

      {error && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-fg">{error}</div>
      )}

      {tab === "library" ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="objection-search"
              className={`${INPUT} sm:max-w-xs`}
              placeholder="Search what they say"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              id="objection-status"
              className={`${INPUT} sm:w-44`}
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
            >
              <option value="all">Every status</option>
              <option value="draft">Waiting for approval</option>
              <option value="approved">Live</option>
              <option value="retired">Retired</option>
            </select>
            <select
              id="objection-family"
              className={`${INPUT} sm:w-44`}
              value={familyFilter}
              onChange={(e) => setFamilyFilter(e.target.value as typeof familyFilter)}
            >
              <option value="all">Every family</option>
              {OBJECTION_FAMILIES.map((f) => (
                <option key={f} value={f}>
                  {FAMILY_LABEL[f] ?? f}
                </option>
              ))}
            </select>
            <span className="text-xs text-fg-dim">
              {visible.length} of {objections.length}
            </span>
          </div>

          {visible.length === 0 ? (
            <EmptyState message="Nothing matches. Widen the filters, or add an objection reps are hearing." />
          ) : (
            <ul className="space-y-3">
              {visible.map((o) => (
                <ObjectionRow
                  key={o.id}
                  objection={o}
                  canApprove={canApprove}
                  busy={busy}
                  act={act}
                  onRefresh={refresh}
                />
              ))}
            </ul>
          )}
        </>
      ) : (
        <AddObjections onCreated={refresh} />
      )}
    </div>
  );
}

function ObjectionRow({
  objection,
  canApprove,
  busy,
  act,
  onRefresh,
}: {
  objection: AdminObjection;
  canApprove: boolean;
  busy: string | null;
  act: (key: string, url: string, body: unknown) => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const url = `/api/objections/catalog/${objection.id}`;
  const liveAnswers = objection.responses.filter((r) => r.status === "approved").length;

  return (
    <li className="rounded-lg border border-bg-border bg-bg-raised/60 p-4">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-fg">&ldquo;{objection.says}&rdquo;</p>
          <p className="mt-1 text-xs italic leading-relaxed text-fg-muted">{objection.meaning}</p>
        </div>
        <span className={`${PILL} ${STATUS_STYLE[objection.status] ?? "border-bg-border text-fg-dim"}`}>
          {objection.status === "approved" ? "Live" : objection.status === "draft" ? "Needs approval" : "Retired"}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-fg-dim">
        <span className={`${PILL} border-bg-border`}>{FAMILY_LABEL[objection.family] ?? objection.family}</span>
        <span className="font-mono">{objection.slug}</span>
        <span>
          {liveAnswers} live {liveAnswers === 1 ? "answer" : "answers"}
          {liveAnswers < 2 && objection.status === "approved" ? " (no posture picker until there are two)" : ""}
        </span>
        {objection.approvedBy && <span>approved by {objection.approvedBy}</span>}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className={BTN} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide answers" : `Show answers (${objection.responses.length})`}
        </button>
        {canApprove && objection.status !== "approved" && (
          <button
            type="button"
            className={BTN}
            disabled={busy === objection.id}
            onClick={() => act(objection.id, url, { objection: { status: "approved" } })}
          >
            Approve this objection
          </button>
        )}
        {canApprove && objection.status !== "retired" && (
          <button
            type="button"
            className={BTN}
            disabled={busy === objection.id}
            onClick={() => act(objection.id, url, { objection: { status: "retired" } })}
          >
            Retire
          </button>
        )}
      </div>

      {open && (
        <ul className="mt-3 space-y-2">
          {objection.responses.length === 0 && (
            <li className="text-xs text-fg-dim">
              No answers yet, so this objection never reaches a rep: the console only serves objections with at least
              one approved answer. Add one below.
            </li>
          )}
          {objection.responses.map((r) => (
            <li key={r.id} className="rounded-md border border-bg-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-fg">
                  {r.label || POSTURE_LABEL[r.posture] || r.posture}
                </span>
                <span className={`${PILL} ${STATUS_STYLE[r.status] ?? "border-bg-border text-fg-dim"}`}>
                  {r.status === "approved" ? "Live" : r.status === "draft" ? "Needs approval" : "Retired"}
                </span>
                {r.isDefault && <span className={`${PILL} border-accent/40 text-accent`}>Read first</span>}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{r.body}</p>
              {canApprove && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {r.status !== "approved" && (
                    <button
                      type="button"
                      className={BTN}
                      disabled={busy === r.id}
                      onClick={() => act(r.id, url, { response: { id: r.id, status: "approved" } })}
                    >
                      Approve
                    </button>
                  )}
                  {r.status === "approved" && !r.isDefault && (
                    <button
                      type="button"
                      className={BTN}
                      disabled={busy === r.id}
                      onClick={() => act(r.id, url, { response: { id: r.id, makeDefault: true } })}
                    >
                      Make this the one read first
                    </button>
                  )}
                  {r.status !== "retired" && (
                    <button
                      type="button"
                      className={BTN}
                      disabled={busy === r.id}
                      onClick={() => act(r.id, url, { response: { id: r.id, status: "retired" } })}
                    >
                      Retire
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
          <li>
            <AddAnswer objection={objection} onCreated={onRefresh} />
          </li>
        </ul>
      )}
    </li>
  );
}

/**
 * Adds one draft answer to an existing objection.
 *
 * WITHOUT THIS THE SURFACE COULD NOT FINISH ITS OWN JOB. A newly created
 * objection has no answers, the console only serves objections with at least
 * one APPROVED answer, and nothing else here ever posts a response. So an
 * objection typed into this page could be approved and still never reach a
 * single rep, which looks from the outside exactly like the feature working.
 * Found in review before it shipped.
 *
 * Only the postures not already taken are offered. A second answer with the
 * same posture gives a rep two buttons with the same name, and the server
 * refuses it anyway; offering it would just be a form that fails on submit.
 */
function AddAnswer({ objection, onCreated }: { objection: AdminObjection; onCreated: () => Promise<void> }) {
  const taken = new Set(objection.responses.filter((r) => r.status !== "retired").map((r) => r.posture));
  const available = OBJECTION_POSTURES.filter((p) => !taken.has(p));

  const [open, setOpen] = useState(false);
  const [posture, setPosture] = useState<ObjectionPosture>(available[0] ?? "agree_and_redirect");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/objections/catalog/${objection.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ posture, body, label: POSTURE_LABEL[posture] }),
      });
      const payload = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      if (!res.ok) {
        setMessage(payload.message || payload.error || "That did not save.");
        return;
      }
      setBody("");
      setOpen(false);
      await onCreated();
    } finally {
      setSaving(false);
    }
  }, [objection.id, posture, body, onCreated]);

  if (available.length === 0) {
    return (
      <p className="text-[11px] text-fg-dim">
        All four moves are taken. Retire one before adding another.
      </p>
    );
  }

  if (!open) {
    return (
      <button type="button" className={BTN} onClick={() => setOpen(true)}>
        Add an answer
      </button>
    );
  }

  return (
    <div className="rounded-md border border-bg-border p-3">
      <label htmlFor={`posture-${objection.id}`} className="text-xs font-medium text-fg-muted">
        Which move
      </label>
      <select
        id={`posture-${objection.id}`}
        className={`${INPUT} mt-1`}
        value={posture}
        onChange={(e) => setPosture(e.target.value as ObjectionPosture)}
      >
        {available.map((p) => (
          <option key={p} value={p}>
            {POSTURE_LABEL[p]}
          </option>
        ))}
      </select>
      <label htmlFor={`body-${objection.id}`} className="mt-3 block text-xs font-medium text-fg-muted">
        What the rep says, word for word
      </label>
      <textarea
        id={`body-${objection.id}`}
        className={`${INPUT} mt-1 min-h-24`}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={BTN} disabled={saving || body.trim().length === 0} onClick={submit}>
          {saving ? "Saving" : "Save as draft"}
        </button>
        <button type="button" className={BTN} onClick={() => setOpen(false)}>
          Cancel
        </button>
        {message && <span className="text-xs text-fg-muted">{message}</span>}
      </div>
    </div>
  );
}

function AddObjections({ onCreated }: { onCreated: () => Promise<void> }) {
  const [paste, setPaste] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const preview = useCallback(async () => {
    setChecking(true);
    setMessage(null);
    try {
      const res = await fetch("/api/objections/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "batch", text: paste }),
      });
      if (!res.ok) {
        setMessage("Could not check that paste against the library.");
        return;
      }
      const data = (await res.json()) as { candidates: Candidate[] };
      setCandidates(data.candidates);
    } finally {
      setChecking(false);
    }
  }, [paste]);

  return (
    <div className="space-y-4">
      <Card
        title="Paste what reps are hearing"
        subtitle="One objection per line. Nothing is saved by this step: it tells you which lines are already in the library first."
      >
        <textarea
          id="objection-paste"
          className={`${INPUT} min-h-32 font-mono text-xs`}
          placeholder={"We already have someone doing this\nYour prices are too high\nSend me something in writing"}
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
        />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" className={BTN} disabled={checking || paste.trim().length === 0} onClick={preview}>
            {checking ? "Checking" : "Check against the library"}
          </button>
          {message && <span className="text-xs text-fg-muted">{message}</span>}
        </div>

        {candidates && (
          <ul className="mt-4 space-y-2">
            {candidates.length === 0 && <li className="text-xs text-fg-dim">Nothing usable in that paste.</li>}
            {candidates.map((c, i) => (
              <li key={`${c.says}-${i}`} className="rounded-md border border-bg-border p-3">
                <p className="text-sm text-fg">&ldquo;{c.says}&rdquo;</p>
                {c.duplicate.kind === "exact" && (
                  <p className="mt-1 text-xs text-fg-muted">
                    Already in the library, word for word, as <span className="font-mono">{c.duplicate.slug}</span>.
                    Skip it.
                  </p>
                )}
                {c.duplicate.kind === "near" && (
                  <p className="mt-1 text-xs text-fg-muted">
                    Looks like <span className="font-mono">{c.duplicate.slug}</span>: &ldquo;{c.duplicate.says}&rdquo;.
                    Add it only if a rep would answer it differently.
                  </p>
                )}
                {c.duplicate.kind === "none" && <p className="mt-1 text-xs text-fg-dim">New to the library.</p>}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <SingleObjectionForm onCreated={onCreated} />
    </div>
  );
}

function SingleObjectionForm({ onCreated }: { onCreated: () => Promise<void> }) {
  const [says, setSays] = useState("");
  const [meaning, setMeaning] = useState("");
  const [prevent, setPrevent] = useState("");
  const [family, setFamily] = useState<ObjectionFamily>("brush_off");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const submit = useCallback(async () => {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/objections/catalog", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ says, meaning, prevent, family }),
      });
      const payload = (await res.json().catch(() => ({}))) as { message?: string; error?: string; slug?: string };
      if (!res.ok) {
        setResult(payload.message || payload.error || "That did not save.");
        return;
      }
      setResult(`Saved as ${payload.slug}, waiting for approval. It is not on any rep's screen yet.`);
      setSays("");
      setMeaning("");
      setPrevent("");
      await onCreated();
    } finally {
      setSaving(false);
    }
  }, [says, meaning, prevent, family, onCreated]);

  return (
    <Card title="Add one" subtitle="It saves as a draft. Approving it is a separate, deliberate step.">
      <div className="space-y-3">
        <div>
          <label htmlFor="says" className="text-xs font-medium text-fg-muted">
            What the customer says
          </label>
          <input id="says" className={`${INPUT} mt-1`} value={says} onChange={(e) => setSays(e.target.value)} />
        </div>
        <div>
          <label htmlFor="meaning" className="text-xs font-medium text-fg-muted">
            What they really mean
          </label>
          <textarea
            id="meaning"
            className={`${INPUT} mt-1 min-h-20`}
            value={meaning}
            onChange={(e) => setMeaning(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="prevent" className="text-xs font-medium text-fg-muted">
            How a rep stops it coming up at all
          </label>
          <textarea
            id="prevent"
            className={`${INPUT} mt-1 min-h-20`}
            value={prevent}
            onChange={(e) => setPrevent(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="family" className="text-xs font-medium text-fg-muted">
            Family
          </label>
          <select
            id="family"
            className={`${INPUT} mt-1`}
            value={family}
            onChange={(e) => setFamily(e.target.value as ObjectionFamily)}
          >
            {OBJECTION_FAMILIES.map((f) => (
              <option key={f} value={f}>
                {FAMILY_LABEL[f] ?? f}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN}
            disabled={saving || says.trim().length === 0 || meaning.trim().length === 0 || prevent.trim().length === 0}
            onClick={submit}
          >
            {saving ? "Saving" : "Save as draft"}
          </button>
          {result && <span className="text-xs text-fg-muted">{result}</span>}
        </div>
        <p className="text-[11px] leading-relaxed text-fg-dim">
          The four moves a rep can make are {OBJECTION_POSTURES.map((p) => POSTURE_LABEL[p as ObjectionPosture]).join(", ")}.
          Answers are added to an objection after it exists.
        </p>
      </div>
    </Card>
  );
}
