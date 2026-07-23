"use client";

/**
 * Shopping Out — Jordan/Oasis 2026-05-23 (Phase 4).
 *
 * Multi-lender outreach UI on top of the existing shop-out engine:
 *   - POST /api/applications/[id]/shop-out  → fires the package
 *   - GET  /api/applications/[id]/lender-threads → reads what's been sent
 *   - GET  /api/manifest/sun/records/application → active apps to pick from
 *   - GET  /api/manifest/sun/records/lender      → lenders to pick from
 *
 * No backend changes for v1. UI flow:
 *   1. Pick application (search/filter active ones)
 *   2. Pick lenders (default = match-fitness ranked from dry-run plan)
 *   3. Confirm attachments + notes
 *   4. Preview email (one shared body)
 *   5. Send → application_lender_threads rows land at status='pending'
 *   6. Result panel shows existing threads for this application
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Card, Tag } from "@/components/Card";
import { ShoppingBag, Send, RefreshCcw, Loader2 } from "lucide-react";
import { fuzzyScore } from "@/lib/fuzzy-match";

type AppRow = {
  id: string;
  data: Record<string, unknown>;
  updated_at: string;
};

type LenderRow = {
  id: string;
  data: Record<string, unknown>;
};

type Thread = {
  id: string;
  lender_id: string;
  lender_name: string;
  status: string;
  subject: string | null;
  sent_at: string | null;
  last_response_at: string | null;
  last_response_summary: string | null;
  last_error: string | null;
  email_identity?: "sunbiz" | "funmate";
  created_at: string;
};

// 2026-05-25 second-meeting expansion — warnings carry severity tiers
// (info / warning / high_risk) instead of opaque blocker strings. The
// dialog before send asks the operator to confirm each high_risk lender
// + capture a short override note. Overrides persist to shop_out_warnings.
type WarningSeverity = "info" | "warning" | "high_risk";
type PlanWarning = {
  severity: WarningSeverity;
  code: string;
  detail: string;
};

type PlanRow = {
  lender_id: string;
  lender_name: string;
  recipient_email: string | null;
  match_score: number;
  /** Backward-compat — high_risk warnings flattened to strings. */
  blockers: string[];
  /** Severity-tiered warnings (2026-05-25 expansion). */
  warnings: PlanWarning[];
  rendered_subject: string;
  /**
   * 2026-05-25 — plain-English narrative explaining why this lender
   * ranked where it did. Populated by buildLenderNarrative() on the
   * server; rendered as small italic prose below the warning chips.
   */
  narrative: string;
};

type DocRow = {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  doc_type: string;
  storage_path: string;
};

// Application statuses that DON'T qualify for shopping out (terminal /
// post-funded states). Mirror of the keep-list from migration 064.
const SHOPPABLE_STATUSES = new Set<string>([
  "application_in",
  "shopping",
  "missing_info",
  "requested_docs",
  "docs_out",
  "login",
  "follow_ups",
]);

const STATUS_TONE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  sending: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  sent: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  responded: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  approved: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  declined: "bg-red-500/15 text-red-300 border-red-500/30",
  info_requested: "bg-orange-500/15 text-orange-300 border-orange-500/30",
  no_response: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  suppressed: "bg-slate-500/15 text-slate-300 border-slate-500/30",
  error: "bg-rose-500/15 text-rose-300 border-rose-500/30",
};

// Human-readable label for a thread in a needs-attention state. Operators
// (Matt, Jordan, Alex, Emily) are not engineers — a raw
// "script_failed (exit 1) --- stdout --- {...auth_failed...}" dump is noise.
// Map the known failure classes to a plain-English message + a clear next
// step; the raw text is preserved in the row's title= tooltip for debugging.
function friendlyThreadError(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (
    s.includes("auth_failed") ||
    s.includes("authentication failed") ||
    s.includes("gmail_app_password")
  )
    return "Email login needs reconnecting (mailbox password is being rotated). Retry shortly.";
  if (s.includes("draft_critic") || s.includes("critic"))
    return "Submission copy was flagged by the quality check. Retry — the fix is applied.";
  if (s.includes("cooldown")) return "Queued — sending shortly (rate-limit cooldown).";
  if (
    s.includes("suppress") ||
    s.includes("casl") ||
    s.includes("opted out") ||
    s.includes("unsubscrib")
  )
    return "Recipient opted out — this lender won't be emailed.";
  if (
    s.includes("missing_recipient") ||
    s.includes("no contact") ||
    s.includes("no submission") ||
    s.includes("uncontactable")
  )
    return "No submission email on file for this lender — add one on the Lenders page.";
  if (s.includes("claimed_by_other_sender")) return "Already being sent by another process.";
  if (s.includes("non_json") || s.includes("non-json"))
    return "The sender returned an unexpected response. Retry.";
  if (s.includes("timeout") || s.includes("timed out")) return "The send timed out. Retry.";
  return "Send failed. Retry — hover for details.";
}

export function ShoppingOutClient({
  tenantSlug,
  tenantId,
}: {
  tenantSlug: string;
  tenantId: string | null;
}) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // ?app= (not ?application=) — the catch-all tenant dispatcher opens
  // the LeadDetailDrawer on ?application= so we use a non-colliding
  // param here (Codex review 2026-05-24). On EXPLICIT row click below
  // we additionally push ?application= so the drawer pops in-context
  // with the operator's full deal profile (CC ask 2026-05-25).
  const presetAppId = params.get("app");

  /**
   * Selecting an application has two effects: it primes Step 2's
   * lender picker locally (setSelectedAppId), AND it pushes
   * ?application=<id> so the catch-all dispatcher mounts the
   * LeadDetailDrawer over the page. The drawer's close() clears
   * ?application= but leaves ?app= intact, so dismissing returns the
   * operator to Shopping Out with the app still primed.
   *
   * Deep-link entry (?app=<id> only, e.g. from the "Shop Out" button
   * on the Application drawer) intentionally does NOT auto-pop — that
   * flow expects to land on the lender picker, not re-open the drawer
   * the operator just came from.
   */
  function selectApplication(appId: string) {
    setSelectedAppId(appId);
    const next = new URLSearchParams(params?.toString() || "");
    next.set("app", appId);
    next.set("application", appId);
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const [apps, setApps] = useState<AppRow[] | null>(null);
  const [lenders, setLenders] = useState<LenderRow[] | null>(null);
  const [appSearch, setAppSearch] = useState("");
  const [selectedAppId, setSelectedAppId] = useState<string | null>(presetAppId);
  const [plan, setPlan] = useState<PlanRow[] | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [selectedLenderIds, setSelectedLenderIds] = useState<Set<string>>(new Set());
  const [lenderNetwork, setLenderNetwork] = useState<"sunbiz" | "funmate">("sunbiz");
  const [notes, setNotes] = useState("");
  // Per-deal CC: agent preset checkboxes (Jordan / Alex) + free-text
  // custom email. The shop-out POST forwards the resolved cc_emails to
  // the bridge tool, which passes them to send_gateway via --cc. SOP §3
  // intent is "the assigned agent stays on the thread"; Jordan and Alex
  // are the two reps the SunBiz team needs to CC routinely.
  const [ccJordan, setCcJordan] = useState(false);
  const [ccAlex, setCcAlex] = useState(false);
  const [ccCustom, setCcCustom] = useState("");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [selectedDocIds, setSelectedDocIds] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; message: string } | null>(null);

  // 2026-05-25 expansion — Proceed Anyway dialog. When the operator hits
  // Send and any selected lender has a high_risk warning, this state pops
  // a confirmation modal that captures a single override note covering all
  // high-risk lenders in the batch. The note + per-lender warning codes
  // get sent in the request body and persisted to shop_out_warnings.
  const [overrideNote, setOverrideNote] = useState("");
  const [pendingConfirmation, setPendingConfirmation] = useState(false);

  // Load active applications + lenders on mount.
  useEffect(() => {
    if (!tenantId) {
      // Preview mode — render the same 4-step scaffold a real Sun Biz
      // operator sees, with empty pickers. No fetches fire for a tenant
      // the operator doesn't own.
      setApps([]);
      setLenders([]);
      return;
    }
    (async () => {
      try {
        const [appsRes, lendersRes] = await Promise.all([
          fetch(`/api/manifest/${tenantSlug}/records/application?limit=500`, {
            credentials: "include",
          }),
          fetch(`/api/manifest/${tenantSlug}/records/lender?limit=500`, {
            credentials: "include",
          }),
        ]);
        const appsJson = await appsRes.json();
        const lendersJson = await lendersRes.json();
        setApps(((appsJson.records || appsJson.rows || []) as AppRow[]) || []);
        setLenders(((lendersJson.records || lendersJson.rows || []) as LenderRow[]) || []);
      } catch {
        setApps([]);
        setLenders([]);
      }
    })();
  }, [tenantSlug, tenantId]);

  // Filter to active applications + apply live, case-insensitive, typo-tolerant
  // search (Adon Batch 6.2). A misspelled/partial query ("remmington") still
  // surfaces the intended merchant ("Remington Builders"), ranked by closeness.
  const visibleApps = useMemo(() => {
    if (!apps) return [];
    const shoppable = apps.filter((a) =>
      SHOPPABLE_STATUSES.has(String(a.data.status || "")),
    );
    const needle = appSearch.trim();
    if (!needle) return shoppable;
    // Score each shoppable app by its best field match; keep reasonable matches,
    // sort closest-first. Business name is weighted strongest.
    const scored = shoppable
      .map((a) => {
        const fields = [
          a.data.business_name,
          a.data.dba,
          a.data.contact_name,
          a.data.email,
          a.data.phone,
        ]
          .filter((v): v is string => typeof v === "string" && v.length > 0);
        const best = fields.reduce(
          (min, f) => Math.min(min, fuzzyScore(needle, f)),
          Number.POSITIVE_INFINITY,
        );
        return { a, score: best };
      })
      .filter((s) => s.score <= 0.45)
      .sort((x, y) => x.score - y.score);
    return scored.map((s) => s.a);
  }, [apps, appSearch]);

  const selectedApp = useMemo(
    () => apps?.find((a) => a.id === selectedAppId) || null,
    [apps, selectedAppId],
  );

  // Refresh plan + threads + documents whenever the selected application
  // changes. Documents are fetched via the application's entity-aware
  // endpoint (resolves the parent lead_id server-side so the document
  // checklist always reflects what's actually on the lead).
  const refreshPlanAndThreads = useCallback(async () => {
    if (!selectedAppId || !lenders) return;
    setPlanLoading(true);
    try {
      // Filter inactive lenders — the Lenders directory's active toggle
      // is the authoritative on/off switch. Inactive lenders should
      // never appear in the shop-out plan (Codex review 2026-05-24).
      const allLenderIds = lenders
        .filter(
          (l) =>
            l.data.active !== false &&
            (l.data.lender_network === "funmate" ? "funmate" : "sunbiz") === lenderNetwork,
        )
        .map((l) => l.id);
      const planEndpoint =
        lenderNetwork === "funmate"
          ? `/api/applications/${selectedAppId}/shop-out/funmate`
          : `/api/applications/${selectedAppId}/shop-out`;
      const [planRes, threadsRes, docsRes] = await Promise.all([
        fetch(planEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            lender_ids: allLenderIds,
            cc_emails: [],
            attachments: [],
            dry_run: true,
          }),
        }),
        fetch(`/api/applications/${selectedAppId}/lender-threads`, {
          credentials: "include",
        }),
        fetch(`/api/leads/${selectedAppId}/documents?entity=application`, {
          credentials: "include",
        }),
      ]);
      const planJson = await planRes.json();
      const threadsJson = await threadsRes.json();
      const docsJson = await docsRes.json();
      if (docsJson.ok && Array.isArray(docsJson.documents)) {
        const loaded: DocRow[] = docsJson.documents
          .filter(
            (d: Record<string, unknown>) =>
              typeof d.storage_path === "string" && d.storage_path.length > 0,
          )
          .map((d: Record<string, unknown>) => ({
            id: String(d.id || ""),
            filename: String(d.filename || ""),
            mime_type: String(d.mime_type || "application/octet-stream"),
            size_bytes: typeof d.size_bytes === "number" ? d.size_bytes : 0,
            doc_type: String(d.doc_type || "unclassified"),
            storage_path: String(d.storage_path || ""),
          }));
        setDocs(loaded);
        // Default — every available doc selected. Operator can uncheck
        // any they don't want to forward.
        setSelectedDocIds(new Set(loaded.map((d) => d.id)));
      } else {
        setDocs([]);
        setSelectedDocIds(new Set());
      }
      if (planJson.ok && Array.isArray(planJson.plan)) {
        // Rank by match_score desc; preserve only entries with a real
        // recipient_email (no point pre-selecting a lender we can't reach).
        const ranked: PlanRow[] = planJson.plan
          .map((p: Record<string, unknown>) => ({
            lender_id: String(p.lender_id || ""),
            lender_name: String(p.lender_name || "(unknown)"),
            recipient_email: typeof p.recipient_email === "string" ? p.recipient_email : null,
            match_score: typeof p.match_score === "number" ? p.match_score : 0,
            blockers: Array.isArray(p.blockers)
              ? (p.blockers as string[]).filter((b) => typeof b === "string")
              : [],
            warnings: Array.isArray(p.warnings)
              ? (p.warnings as Array<Record<string, unknown>>)
                  .filter((w) =>
                    w && typeof w === "object" &&
                    (w.severity === "info" || w.severity === "warning" || w.severity === "high_risk") &&
                    typeof w.code === "string" && typeof w.detail === "string",
                  )
                  .map((w) => ({
                    severity: w.severity as WarningSeverity,
                    code: w.code as string,
                    detail: w.detail as string,
                  }))
              : [],
            rendered_subject: String(p.rendered_subject || ""),
            narrative: typeof p.narrative === "string" ? p.narrative : "",
          }))
          .sort((a: PlanRow, b: PlanRow) => b.match_score - a.match_score);
        setPlan(ranked);
        // Default selection: top 5 contactable lenders with zero blockers.
        const defaults = new Set<string>(
          ranked
            .filter((r) => r.recipient_email && r.blockers.length === 0)
            .slice(0, 5)
            .map((r) => r.lender_id),
        );
        setSelectedLenderIds(defaults);
      } else {
        setPlan([]);
        setSelectedLenderIds(new Set());
      }
      if (threadsJson.ok) {
        setThreads(threadsJson.threads || []);
      } else {
        setThreads([]);
      }
    } finally {
      setPlanLoading(false);
    }
  }, [selectedAppId, lenders, lenderNetwork]);

  useEffect(() => {
    if (selectedAppId && lenders) refreshPlanAndThreads();
  }, [selectedAppId, lenders, refreshPlanAndThreads]);

  // Thread-only refresh for the live poller below. Deliberately NOT
  // refreshPlanAndThreads — that re-runs the dry-run plan-scoring POST
  // (match fitness over the whole lender directory), which is far too
  // heavy to fire every 5s.
  const refreshThreads = useCallback(async () => {
    if (!selectedAppId) return;
    try {
      const r = await fetch(`/api/applications/${selectedAppId}/lender-threads`, {
        credentials: "include",
      });
      const j = await r.json();
      if (j.ok) setThreads(j.threads || []);
    } catch {
      // Network blip — keep the stale list; next tick retries.
    }
  }, [selectedAppId]);

  // Live status polling — Adon fires shop-outs in real time on merchant
  // calls; a stale pending/sent chip means he reads the merchant the
  // wrong status. Poll while any thread is still in flight (pending =
  // queued for the sender daemon, sent = awaiting lender reply), stop
  // once everything settles. Hidden tabs skip the fetch but keep the
  // timer so the list catches up as soon as the operator tabs back.
  const hasInFlightThreads = threads.some(
    (t) => t.status === "pending" || t.status === "sending" || t.status === "sent",
  );
  useEffect(() => {
    if (!selectedAppId || !hasInFlightThreads) return;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refreshThreads();
    }, 5000);
    return () => clearInterval(interval);
  }, [selectedAppId, hasInFlightThreads, refreshThreads]);

  // Retry one error-status thread. Optimistically marks the row as
  // "pending" the moment the POST returns so the operator sees immediate
  // feedback; the next refresh confirms the daemon picked it up.
  const retryThread = useCallback(
    async (threadId: string) => {
      if (!selectedAppId) return;
      setRetrying((prev) => new Set(prev).add(threadId));
      try {
        const r = await fetch(
          `/api/applications/${selectedAppId}/lender-threads/${threadId}/retry`,
          { method: "POST" },
        );
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) {
          setThreads((prev) =>
            prev.map((t) =>
              t.id === threadId
                ? { ...t, status: j.new_status || "pending", last_error: null }
                : t,
            ),
          );
        }
      } catch {
        // Fail-silent on network blip; the daemon picks up on next refresh.
      } finally {
        setRetrying((prev) => {
          const next = new Set(prev);
          next.delete(threadId);
          return next;
        });
      }
    },
    [selectedAppId],
  );

  // Retry EVERY recoverable thread (error + orphaned 'sending') on this
  // application in one click — the recovery path for "the whole shop-out came
  // back red." Fires the batch once server-side; refresh shows the result.
  const [retryingAll, setRetryingAll] = useState(false);
  const retryAll = useCallback(async () => {
    if (!selectedAppId) return;
    setRetryingAll(true);
    try {
      await fetch(`/api/applications/${selectedAppId}/lender-threads/retry-all`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email_identity: lenderNetwork }),
      }).then((r) => r.json().catch(() => ({})));
      await refreshThreads();
    } catch {
      // Network blip — next refresh / per-row retry still available.
    } finally {
      setRetryingAll(false);
    }
  }, [selectedAppId, lenderNetwork, refreshThreads]);

  const visibleThreads = useMemo(
    () =>
      threads.filter(
        (thread) => (thread.email_identity === "funmate" ? "funmate" : "sunbiz") === lenderNetwork,
      ),
    [threads, lenderNetwork],
  );

  // Threads in a needs-retry state (error or stuck sending). Drives the
  // "Retry all failed" button visibility + count.
  const failedThreadCount = useMemo(
    () => visibleThreads.filter((t) => t.status === "error" || t.status === "sending").length,
    [visibleThreads],
  );

  const toggleLender = (id: string) => {
    setSelectedLenderIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleDoc = (id: string) => {
    setSelectedDocIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // 2026-05-25 expansion — surface high-risk lenders in the selection so
  // the Send button can route through the confirmation modal when any
  // are present. Pure derived state; no fetch.
  const highRiskSelected = useMemo(() => {
    if (!plan) return [];
    return plan.filter(
      (p) => selectedLenderIds.has(p.lender_id) && p.warnings.some((w) => w.severity === "high_risk"),
    );
  }, [plan, selectedLenderIds]);

  const performSend = async () => {
    if (!selectedAppId || selectedLenderIds.size === 0) return;
    setSending(true);
    setSendResult(null);
    try {
      // Build the attachments payload from the operator's checked docs.
      // Shop-out route validates each storage_path starts with `<tenant_id>/`
      // before forwarding, so a manipulated path here will be rejected
      // server-side — but we only send the operator's own tenant's docs
      // anyway since /api/leads/[id]/documents is tenant-scoped.
      const attachments = docs
        .filter((d) => selectedDocIds.has(d.id))
        .map((d) => ({
          filename: d.filename,
          storage_path: d.storage_path,
          mime_type: d.mime_type,
          size_bytes: d.size_bytes,
        }));
      // Acknowledge the high-risk warnings for every selected lender that
      // has any. Single override_note covers the whole batch; server splits
      // it into one shop_out_warnings row per (lender, warning_code).
      const acknowledged = highRiskSelected.map((p) => ({
        lender_id: p.lender_id,
        warning_codes: p.warnings.filter((w) => w.severity === "high_risk").map((w) => w.code),
        override_note: overrideNote.trim(),
      }));
      const sendEndpoint =
        lenderNetwork === "funmate"
          ? `/api/applications/${selectedAppId}/shop-out/funmate`
          : `/api/applications/${selectedAppId}/shop-out`;
      const res = await fetch(sendEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          lender_ids: Array.from(selectedLenderIds),
          // Resolve per-deal CC selection. Two preset checkboxes (Jordan /
          // Alex) + a free-text custom field. The route validates each is
          // a valid-looking email; bad entries are filtered server-side.
          cc_emails: [
            ccJordan ? "jordan@sunbizfunding.com" : null,
            ccAlex ? "alex@sunbizfunding.com" : null,
            ccCustom.trim() && ccCustom.includes("@") ? ccCustom.trim() : null,
          ].filter((e): e is string => Boolean(e)),
          attachments,
          ...(lenderNetwork === "funmate"
            ? { notes: notes.trim() || undefined }
            : { body_template: notes.trim() || undefined }),
          acknowledged_warnings: acknowledged.length > 0 ? acknowledged : undefined,
        }),
      });
      const json = await res.json();
      if (json.ok) {
        if (lenderNetwork === "funmate") {
          setSendResult({
            ok: true,
            message: `FundMate sent ${json.sent || 0} lender package${json.sent === 1 ? "" : "s"}${json.failed ? ` · ${json.failed} failed` : ""}.`,
          });
          await refreshPlanAndThreads();
          return;
        }
        // Reflect the actual physical-send outcome the route auto-triggers,
        // not a generic "fires later" line. Falls back gracefully when the
        // bridge result is absent (queued-only).
        const ps = json.physical_send as
          | { status?: string; sent_count?: number; failed_count?: number }
          | undefined;
        const queuedMsg = `Queued ${json.queued} lender thread${json.queued === 1 ? "" : "s"}${
          json.blocked ? ` · ${json.blocked} blocked` : ""
        }.`;
        const sendMsg =
          ps && typeof ps.sent_count === "number"
            ? ` ${ps.sent_count} sent${
                ps.failed_count ? ` · ${ps.failed_count} need retry (use Retry below)` : ""
              }.`
            : " Sending now — watch the thread statuses below.";
        setSendResult({ ok: true, message: queuedMsg + sendMsg });
        await refreshPlanAndThreads();
      } else {
        setSendResult({ ok: false, message: json.error || "Send failed." });
      }
    } catch (err) {
      setSendResult({ ok: false, message: String((err as Error).message || err) });
    } finally {
      setSending(false);
      setPendingConfirmation(false);
      setOverrideNote("");
    }
  };

  // Entry point for the Send button. If any selected lender has a
  // high_risk warning, route through the confirmation dialog so the
  // operator captures an override note. Otherwise send immediately.
  const submit = async () => {
    if (!selectedAppId || selectedLenderIds.size === 0) return;
    if (highRiskSelected.length > 0) {
      setPendingConfirmation(true);
      return;
    }
    await performSend();
  };

  // Preview-mode bail removed 2026-05-25 — operator viewing a tenant
  // they don't own now sees the Step 1 application picker (empty),
  // matching the same chrome a real Sun Biz operator sees on day one.

  return (
    <div className="space-y-5">
      {/* Catch-all dispatcher renders the page title + subtitle. No
          inner PageHeader here — was duplicating 2026-05-24. */}

      {/* Step 1 — Pick application */}
      <Card>
        <div className="space-y-3">
          <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
            1 · Application
          </div>
          <input
            type="search"
            value={appSearch}
            onChange={(e) => setAppSearch(e.target.value)}
            placeholder="Search by business / contact / email…"
            className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim"
          />
          {apps === null ? (
            <div className="text-xs text-fg-dim italic py-4 text-center">Loading active applications…</div>
          ) : visibleApps.length === 0 ? (
            <div className="text-xs text-fg-dim italic py-4 text-center">
              No active applications match. Apps in funded / declined / dead don&apos;t qualify.
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto rounded-md border border-bg-border divide-y divide-bg-border">
              {visibleApps.slice(0, 50).map((a) => {
                const isSelected = a.id === selectedAppId;
                const biz = String(a.data.business_name || "(unnamed)");
                const status = String(a.data.status || "—");
                const contact = String(a.data.contact_name || "");
                const revenue = a.data.monthly_revenue;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => selectApplication(a.id)}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between gap-3 hover:bg-bg-elev/60 ${
                      isSelected ? "bg-accent/10" : ""
                    }`}
                  >
                    <div className="min-w-0">
                      <div className={`text-[13px] font-semibold truncate ${isSelected ? "text-accent" : "text-fg"}`}>
                        {biz}
                      </div>
                      <div className="text-[11px] text-fg-dim truncate">
                        {contact ? `${contact} · ` : ""}
                        {revenue != null ? `$${Number(revenue).toLocaleString()}/mo` : "revenue unknown"}
                      </div>
                    </div>
                    <span className="text-[10px] uppercase font-mono text-fg-muted shrink-0">
                      {status.replace(/_/g, " ")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      {/* Step 2 — Pick lenders (ranked) */}
      {selectedAppId && (
        <Card>
          <div className="space-y-3">
            <div className="inline-flex rounded-lg border border-bg-border bg-bg-deep p-1">
              {(["sunbiz", "funmate"] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setLenderNetwork(value);
                    setSelectedLenderIds(new Set());
                    setSendResult(null);
                  }}
                  className={`rounded-md px-4 py-2 text-[12px] font-semibold transition-colors ${
                    lenderNetwork === value ? "bg-accent text-bg-deep" : "text-fg-muted hover:text-fg"
                  }`}
                >
                  {value === "sunbiz" ? "SunBiz Lenders" : "FundMate Lenders"}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
                  2 · {lenderNetwork === "sunbiz" ? "SunBiz Lenders" : "FundMate Lenders"}
                </div>
                <div className="text-[11.5px] text-fg-muted mt-0.5">
                  {typeof selectedApp?.data.business_name === "string" && (
                    <>
                      Ranking against{" "}
                      <span className="font-semibold text-fg">
                        {selectedApp.data.business_name}
                      </span>
                      .
                    </>
                  )}{" "}
                  Top-5 contactable lenders pre-selected.
                </div>
              </div>
              <button
                type="button"
                onClick={refreshPlanAndThreads}
                disabled={planLoading}
                className="inline-flex items-center gap-1.5 text-[11px] px-2 py-1 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-50"
              >
                <RefreshCcw className={`w-3 h-3 ${planLoading ? "animate-spin" : ""}`} />
                Refresh
              </button>
            </div>

            {planLoading && plan === null ? (
              <div className="text-xs text-fg-dim italic py-4 text-center inline-flex items-center gap-2 justify-center w-full">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Scoring lenders…
              </div>
            ) : plan && plan.length > 0 ? (
              <div className="max-h-80 overflow-y-auto rounded-md border border-bg-border divide-y divide-bg-border">
                {plan.map((p) => {
                  const isSelected = selectedLenderIds.has(p.lender_id);
                  const missingEmail = !p.recipient_email;
                  // 2026-05-25 expansion — group warnings by severity for
                  // tiered rendering. Operator can still pick high_risk
                  // lenders (no hard block), but they hit a confirmation
                  // dialog at Send + the override gets logged.
                  const highRiskWarnings = p.warnings.filter((w) => w.severity === "high_risk");
                  const warningTier = p.warnings.filter((w) => w.severity === "warning");
                  const infoTier = p.warnings.filter((w) => w.severity === "info");
                  return (
                    <label
                      key={p.lender_id}
                      className={`flex items-start gap-3 px-3 py-2.5 cursor-pointer hover:bg-bg-elev/60 ${
                        isSelected ? "bg-accent/10" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleLender(p.lender_id)}
                        disabled={missingEmail}
                        className="mt-1 accent-accent"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[13px] font-semibold text-fg truncate">
                            {p.lender_name}
                          </span>
                          <span className="text-[10px] font-mono text-fg-dim">
                            score {p.match_score.toFixed(2)}
                          </span>
                          {highRiskWarnings.length > 0 && (
                            <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 border border-rose-500/30">
                              High risk
                            </span>
                          )}
                          {highRiskWarnings.length === 0 && warningTier.length > 0 && (
                            <span className="text-[10px] uppercase tracking-wider font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30">
                              Warning
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-fg-muted truncate">
                          {p.recipient_email || (
                            <span className="text-rose-300">no contact email — uncontactable</span>
                          )}
                        </div>
                        {highRiskWarnings.length > 0 && (
                          <div className="text-[10.5px] text-rose-300 mt-1 leading-snug">
                            &#9888; {highRiskWarnings.map((w) => w.detail).join(" · ")}
                          </div>
                        )}
                        {warningTier.length > 0 && (
                          <div className="text-[10.5px] text-amber-300 mt-1 leading-snug">
                            &bull; {warningTier.map((w) => w.detail).join(" · ")}
                          </div>
                        )}
                        {infoTier.length > 0 && (
                          <div className="text-[10.5px] text-fg-dim mt-1 leading-snug">
                            {infoTier.map((w) => w.detail).join(" · ")}
                          </div>
                        )}
                        {p.narrative && (
                          <p className="text-fg-muted text-[11px] italic leading-snug mt-1.5">
                            {p.narrative}
                          </p>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            ) : (
              <div className="text-xs text-fg-dim italic py-4 text-center">
                No {lenderNetwork === "sunbiz" ? "SunBiz" : "FundMate"} lenders in this directory. Add one on the Lenders page first.
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 3 — Attachments */}
      {selectedAppId && plan && plan.length > 0 && (
        <Card>
          <div className="space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
              3 · Attachments
            </div>
            {docs.length === 0 ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[12px] text-amber-100 leading-relaxed">
                No documents uploaded for this application yet. Open the
                application detail drawer and upload at least the bank
                statements before shopping out — lenders won&apos;t price the
                deal without them.
              </div>
            ) : (
              <div className="rounded-md border border-bg-border divide-y divide-bg-border">
                {docs.map((d) => {
                  const checked = selectedDocIds.has(d.id);
                  const sizeKb = Math.max(1, Math.round(d.size_bytes / 1024));
                  return (
                    <label
                      key={d.id}
                      className={`flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-bg-elev/60 ${
                        checked ? "bg-accent/10" : ""
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDoc(d.id)}
                        className="accent-accent"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] text-fg font-medium truncate">
                          {d.filename}
                        </div>
                        <div className="text-[10.5px] text-fg-dim font-mono">
                          {d.doc_type.replace(/_/g, " ")} · {sizeKb} KB
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="text-[10.5px] text-fg-dim">
              {selectedDocIds.size} of {docs.length} attached
            </div>
          </div>
        </Card>
      )}

      {/* Step 4 — Agent CC + Notes + Send */}
      {selectedAppId && plan && plan.length > 0 && (
        <Card>
          <div className="space-y-3">
            {/* Agent CC selector — Jordan / Alex / custom. Stays on the
                thread when the lender replies; SOP §3 "the assigned agent
                gets CC'd." Custom field handles anyone outside the two
                presets (e.g. CC'ing a syndicator or processor on a deal). */}
            <div className="space-y-2">
              <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
                4 · CC agent on every lender thread
              </div>
              <div className="flex flex-wrap items-center gap-2.5">
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-bg-border bg-bg-deep cursor-pointer hover:bg-bg-elev">
                  <input
                    type="checkbox"
                    checked={ccJordan}
                    onChange={(e) => setCcJordan(e.target.checked)}
                    className="accent-accent"
                  />
                  <span className="text-[12.5px] text-fg font-semibold">Jordan</span>
                  <span className="text-[10.5px] text-fg-dim font-mono">jordan@sunbizfunding.com</span>
                </label>
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-bg-border bg-bg-deep cursor-pointer hover:bg-bg-elev">
                  <input
                    type="checkbox"
                    checked={ccAlex}
                    onChange={(e) => setCcAlex(e.target.checked)}
                    className="accent-accent"
                  />
                  <span className="text-[12.5px] text-fg font-semibold">Alex</span>
                  <span className="text-[10.5px] text-fg-dim font-mono">alex@sunbizfunding.com</span>
                </label>
                <input
                  type="email"
                  value={ccCustom}
                  onChange={(e) => setCcCustom(e.target.value)}
                  placeholder="Custom CC email (optional)"
                  className="flex-1 min-w-[200px] text-[12.5px] px-2.5 py-1 rounded-md bg-bg-deep border border-bg-border text-fg"
                />
              </div>
              {(ccJordan || ccAlex || (ccCustom && ccCustom.includes("@"))) && (
                <div className="text-[10.5px] text-fg-dim">
                  CCs every lender thread on this shop-out only — saved per send, not stored on the deal.
                </div>
              )}
            </div>

            <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
              5 · Notes (optional — injected into email body)
            </div>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any context for the lenders — e.g. 'Owner is finalist for SBA but needs short-term bridge'…"
              rows={4}
              maxLength={2000}
              className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg resize-none"
            />
            <div className="flex items-center justify-between gap-3">
              <div className="text-[11px] text-fg-dim">
                {selectedLenderIds.size} lender{selectedLenderIds.size === 1 ? "" : "s"} ·{" "}
                {selectedDocIds.size} attachment{selectedDocIds.size === 1 ? "" : "s"}
              </div>
              <button
                type="button"
                onClick={submit}
                disabled={sending || selectedLenderIds.size === 0}
                className="inline-flex items-center gap-2 text-[12.5px] font-semibold px-4 py-2 rounded-md bg-accent text-bg-deep disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5" />
                )}
                Send to {selectedLenderIds.size || 0} lender{selectedLenderIds.size === 1 ? "" : "s"}
              </button>
            </div>
            {sendResult && (
              <div
                className={`rounded-md border p-2.5 text-[12px] ${
                  sendResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
                    : "border-rose-500/30 bg-rose-500/10 text-rose-100"
                }`}
              >
                {sendResult.message}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Step 4 — Threads for this app */}
      {selectedAppId && (
        <Card>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-[11px] uppercase tracking-wider text-fg-dim font-semibold">
                Existing lender threads
              </div>
              <div className="flex items-center gap-2">
                {failedThreadCount > 0 && (
                  <button
                    type="button"
                    onClick={retryAll}
                    disabled={retryingAll}
                    className="inline-flex items-center gap-1.5 text-[10.5px] font-semibold px-2 py-1 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-wait"
                    title="Reset every failed/stuck thread on this deal to pending and re-send them all."
                  >
                    {retryingAll ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <RefreshCcw className="w-3 h-3" />
                    )}
                    Retry all failed ({failedThreadCount})
                  </button>
                )}
                <Tag tone="info">
                  <ShoppingBag className="w-3 h-3 mr-1 inline" />
                  {visibleThreads.length}
                </Tag>
              </div>
            </div>
            {visibleThreads.length === 0 ? (
              <div className="text-xs text-fg-dim italic py-3 text-center">
                No threads yet. The first send creates one row per lender.
              </div>
            ) : (
              <div className="rounded-md border border-bg-border divide-y divide-bg-border">
                {visibleThreads.map((t) => {
                  const tone =
                    STATUS_TONE[t.status] || "bg-slate-500/15 text-slate-300 border-slate-500/30";
                  // For needs-attention states, show a plain-English message
                  // (raw kept in the tooltip). For happy-path states, show the
                  // lender's actual reply summary verbatim.
                  const errish =
                    t.status === "error" || t.status === "sending" || t.status === "suppressed";
                  const rawDetail = t.last_error || t.last_response_summary;
                  const detailMsg = errish
                    ? friendlyThreadError(rawDetail)
                    : t.last_response_summary;
                  const detailTone = errish
                    ? t.status === "suppressed"
                      ? "text-fg-muted"
                      : "text-rose-300"
                    : "text-fg-muted";
                  const canRetry = t.status === "error" || t.status === "sending";
                  return (
                    <div key={t.id} className="px-3 py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold text-fg truncate">
                          {t.lender_name}
                        </div>
                        <div className="text-[11px] text-fg-dim truncate">
                          {t.subject || "(no subject)"}
                        </div>
                        {detailMsg && (
                          <div
                            className={`text-[11.5px] mt-1 leading-snug ${detailTone}`}
                            title={rawDetail || undefined}
                          >
                            {errish ? "⚠ " : "↳ "}
                            {detailMsg}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0 space-y-1 flex flex-col items-end">
                        <span
                          className={`inline-block text-[10px] uppercase tracking-wider font-mono px-2 py-0.5 rounded border ${tone}`}
                        >
                          {t.status.replace(/_/g, " ")}
                        </span>
                        <div className="text-[10px] text-fg-dim font-mono">
                          {t.sent_at
                            ? new Date(t.sent_at).toLocaleDateString()
                            : new Date(t.created_at).toLocaleDateString()}
                        </div>
                        {canRetry && (
                          <button
                            type="button"
                            onClick={() => retryThread(t.id)}
                            disabled={retrying.has(t.id)}
                            className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50 disabled:cursor-wait"
                            title="Reset this thread to pending and re-send it now."
                          >
                            {retrying.has(t.id) ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <RefreshCcw className="w-3 h-3" />
                            )}
                            Retry
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Proceed Anyway confirmation modal — 2026-05-25 expansion. Shows
          when the operator hits Send with any high_risk lender selected.
          Captures a single override note that covers the entire batch;
          server splits it into one shop_out_warnings row per (lender,
          warning_code) so the audit trail is granular even when the
          operator's reason is global ("Re-shopping this deal after
          revenue update; old number was stale"). */}
      {pendingConfirmation && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-bg-deep border border-bg-border rounded-xl shadow-2xl w-full max-w-lg mx-4 p-5 space-y-4">
            <div className="flex items-start gap-3">
              <div className="rounded-md bg-rose-500/15 p-2 border border-rose-500/30 shrink-0">
                <span className="text-rose-300 text-lg leading-none">&#9888;</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-fg">
                  {highRiskSelected.length} lender{highRiskSelected.length === 1 ? "" : "s"} flagged High Risk
                </div>
                <div className="text-[12px] text-fg-muted mt-0.5">
                  These lenders are likely to decline based on the application profile.
                  You can still send — every override is logged to the audit trail.
                </div>
              </div>
            </div>

            <div className="max-h-40 overflow-y-auto rounded-md border border-bg-border bg-bg-elev/30 p-3 space-y-2">
              {highRiskSelected.map((p) => {
                const flags = p.warnings.filter((w) => w.severity === "high_risk");
                return (
                  <div key={p.lender_id} className="text-[12px]">
                    <div className="font-semibold text-fg">{p.lender_name}</div>
                    <div className="text-rose-300 leading-snug">
                      {flags.map((w) => w.detail).join(" · ")}
                    </div>
                  </div>
                );
              })}
            </div>

            <div>
              <label className="block text-[11px] uppercase tracking-wider text-fg-dim font-semibold mb-1.5">
                Override note (required)
              </label>
              <textarea
                value={overrideNote}
                onChange={(e) => setOverrideNote(e.target.value)}
                placeholder="Why are you sending despite the risk? e.g. operator has spoken to lender directly, revenue update incoming, etc."
                rows={3}
                className="w-full text-sm px-3 py-2 rounded-md bg-bg-deep border border-bg-border text-fg placeholder:text-fg-dim resize-none"
              />
              <div className="text-[10.5px] text-fg-dim mt-1">
                Logged to shop_out_warnings with your user_id + timestamp.
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setPendingConfirmation(false);
                  setOverrideNote("");
                }}
                disabled={sending}
                className="text-xs px-3 py-1.5 rounded-md border border-bg-border text-fg-muted hover:text-fg hover:bg-bg-elev disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={performSend}
                disabled={sending || overrideNote.trim().length < 5}
                className="text-xs px-3 py-1.5 rounded-md bg-rose-500/20 border border-rose-500/40 text-rose-200 hover:bg-rose-500/30 disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                Proceed Anyway
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
