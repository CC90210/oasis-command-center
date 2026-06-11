/**
 * lenders/match-fitness.ts — score each lender against a specific
 * application's profile so the operator's shop-out UI can rank lenders
 * from "best fit" to "longshot" instead of showing all 50 alphabetically.
 *
 * Phase 6.2 of the SunBiz CRM build (2026-05-15). The actual UI lives in
 * Phase 6.3's Application detail page; this file is the pure-data helper
 * both the dashboard and Solara's tool calls consume.
 *
 * Scoring philosophy:
 *   - Hard gates (zero score): lender's floor exceeds the lead's data.
 *     A lender requiring $50k/month rev shouldn't show for a $20k/month
 *     lead — the offer would always come back as decline.
 *   - Soft penalties: data missing on the lender or the lead. Operator
 *     can still pick the lender, but the score reflects uncertainty.
 *   - Product-match bonus: when the application asks for an MCA and the
 *     lender's product_types includes "mca", that's a strong signal.
 *
 * Returns a score in [0, 100] plus the reasons list so the operator
 * can see WHY a lender ranked where it did ("FICO 580 below 620 floor").
 */

export type LenderProfile = {
  id: string;
  name: string;
  product_types?: string | string[];
  min_monthly_revenue?: number;
  max_funded_amount?: number;
  min_time_in_business_months?: number;
  fico_floor?: number;
  sla_response_days?: number;
  notes?: string;
  // SOP §1 shop_list(deal) filter fields (2026-05-31). Hard constraints
  // the Lender List SOP encodes per-lender; the scorer treats violations
  // as high_risk warnings (same severity tier as FICO/revenue/TIB floors).
  tier?: "A" | "B" | "C" | "D" | "Micro";
  paper_grades?: string[];
  position_min?: number;
  position_max?: number;
  defaults_policy?: "none" | "satisfied_only" | "accepts";
  max_negative_days?: number;
  reverses_only?: boolean;
  /** Per-lender CC list — the SOP encodes routing like "submissions@<x>
   * with cc rummi@" for Maison. The shop-out send path merges this with
   * the operator's global cc list so the catalog routing flows end-to-end. */
  submission_cc_emails?: string[];
  /**
   * Adon MCA SOP §1/§4 (2026-06-11) — funder restricted lists.
   * `restricted_states`: ISO 2-letter state codes the lender won't fund in
   *   (e.g. ["NY", "CA"]). Matched against application.merchant_state.
   * `restricted_industries`: lowercase industry slugs the lender excludes
   *   (e.g. ["trucking", "gas_station", "cannabis"]). Matched against
   *   application.industry. Match is exact, lower-cased; if a lender's
   *   exclusion list uses different naming than the catalog the operator
   *   sees an info warning rather than a silent skip.
   */
  restricted_states?: string[];
  restricted_industries?: string[];
};

export type ApplicationProfile = {
  id: string;
  /** Merchant / business name — rendered in shop-out subject "New Deal ({{business_name}})"
   *  and the body's Business: line. Source: tenant_records.data.business_name. */
  business_name?: string;
  /** From the form_submissions or manual operator entry. */
  monthly_revenue?: number;
  time_in_business_months?: number;
  applicant_fico?: number;
  requested_amount?: number;
  /** Operator-set; matches lender product_types. */
  desired_product?: string;
  // SOP §1 fields the underwriter chain populates (2026-05-31). Optional
  // because legacy applications may not have been re-underwritten yet;
  // the scorer treats absence as "unknown" (info warning), not "fails".
  paper_grade?: string;
  position_count?: number;
  has_default?: boolean;
  default_satisfied?: boolean;
  negative_days?: number;
  deal_kind?: "fresh_capital" | "reverse_consolidation";
  /**
   * Adon MCA SOP §1/§4 — merchant identity for restricted-list matching.
   * `merchant_state`: ISO 2-letter (e.g. "FL", "NY"); upper-cased before
   *   compare. Absence = info warning when lender has restricted_states.
   * `industry`: lowercase slug (e.g. "trucking", "restaurant"); absence
   *   = info warning when lender has restricted_industries.
   */
  merchant_state?: string;
  industry?: string;
};

/**
 * Severity tiers for lender warnings — replaces the prior hard-block
 * model per the 2026-05-25 second SunBiz product meeting. The operator
 * can still send to a lender flagged 'high_risk', but they hit a
 * confirmation dialog and the override is logged to shop_out_warnings.
 */
export type WarningSeverity = "info" | "warning" | "high_risk";

export type LenderWarning = {
  severity: WarningSeverity;
  /** Stable machine-readable code; persists to shop_out_warnings.reason_code. */
  code: string;
  /** One-line human-readable detail; persists to shop_out_warnings.reason_detail. */
  detail: string;
};

export type MatchScore = {
  lender_id: string;
  score: number;
  /** Plain-English bullet points the UI surfaces in a tooltip. */
  reasons: string[];
  /**
   * Pre-2026-05-25 hard-block list. Kept for backward compatibility.
   * Subset of `warnings` where severity === 'high_risk'.
   */
  blockers: string[];
  /**
   * 2026-05-25 second-meeting expansion — severity-tiered warnings the
   * Shopping Out UI renders with appropriate styling and override flow.
   */
  warnings: LenderWarning[];
};

function normalizeProductTypes(v: LenderProfile["product_types"]): string[] {
  if (Array.isArray(v)) return v.map((s) => s.trim()).filter(Boolean);
  if (typeof v === "string" && v.trim()) {
    // Operators sometimes enter as comma-separated text via the JSONB
    // wide-row UI. Tolerate both shapes.
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * Score one lender against one application. Pure function — no DB
 * calls. Pass profiles in; get a score out. Caller batches over a
 * list of lenders for the shop-out UI.
 */
export function scoreLenderMatch(
  lender: LenderProfile,
  application: ApplicationProfile,
): MatchScore {
  const reasons: string[] = [];
  const warnings: LenderWarning[] = [];
  let score = 100;

  const flag = (severity: WarningSeverity, code: string, detail: string) => {
    warnings.push({ severity, code, detail });
  };

  // ── Revenue floor (high_risk) ──────────────────────────────────────
  if (lender.min_monthly_revenue !== undefined && application.monthly_revenue !== undefined) {
    if (application.monthly_revenue < lender.min_monthly_revenue) {
      flag(
        "high_risk",
        "below_min_revenue",
        `Monthly revenue $${application.monthly_revenue.toLocaleString()} below lender floor $${lender.min_monthly_revenue.toLocaleString()}`,
      );
    } else {
      reasons.push(
        `Revenue $${application.monthly_revenue.toLocaleString()} clears $${lender.min_monthly_revenue.toLocaleString()} floor`,
      );
    }
  } else if (lender.min_monthly_revenue !== undefined) {
    score -= 10;
    flag("info", "missing_revenue_data", "Lender requires revenue floor; application doesn't report monthly revenue");
  }

  // ── Time in business floor (high_risk) ─────────────────────────────
  if (
    lender.min_time_in_business_months !== undefined &&
    application.time_in_business_months !== undefined
  ) {
    if (application.time_in_business_months < lender.min_time_in_business_months) {
      flag(
        "high_risk",
        "below_tib_floor",
        `Time in business ${application.time_in_business_months}mo below lender floor ${lender.min_time_in_business_months}mo`,
      );
    } else {
      reasons.push(
        `${application.time_in_business_months}mo TIB clears ${lender.min_time_in_business_months}mo floor`,
      );
    }
  } else if (lender.min_time_in_business_months !== undefined) {
    score -= 5;
    flag("info", "missing_tib_data", "Lender requires TIB floor; application doesn't report TIB");
  }

  // ── FICO floor (high_risk) ─────────────────────────────────────────
  if (lender.fico_floor !== undefined && application.applicant_fico !== undefined) {
    if (application.applicant_fico < lender.fico_floor) {
      flag(
        "high_risk",
        "below_fico_floor",
        `FICO ${application.applicant_fico} below ${lender.fico_floor} floor`,
      );
    } else {
      reasons.push(`FICO ${application.applicant_fico} clears ${lender.fico_floor} floor`);
    }
  } else if (lender.fico_floor !== undefined) {
    score -= 5;
    flag("info", "missing_fico_data", "Lender requires FICO floor; application doesn't report FICO");
  }

  // ── Max funded amount (warning — counter-offer at cap likely) ──────
  if (
    lender.max_funded_amount !== undefined &&
    application.requested_amount !== undefined &&
    application.requested_amount > lender.max_funded_amount
  ) {
    flag(
      "warning",
      "exceeds_max_funded",
      `Requested $${application.requested_amount.toLocaleString()} exceeds lender max $${lender.max_funded_amount.toLocaleString()} — expect a counter-offer at the cap`,
    );
  }

  // ── Product mismatch (warning) ─────────────────────────────────────
  const lenderProducts = normalizeProductTypes(lender.product_types);
  if (application.desired_product && lenderProducts.length > 0) {
    if (lenderProducts.includes(application.desired_product)) {
      reasons.push(`Product match: lender offers ${application.desired_product}`);
    } else {
      score -= 15;
      flag(
        "warning",
        "product_mismatch",
        `Lender offers ${lenderProducts.join(", ")}; deal wants ${application.desired_product}`,
      );
    }
  }

  // ── Position range (high_risk) — SOP §1 ────────────────────────────
  if (lender.position_min !== undefined || lender.position_max !== undefined) {
    if (application.position_count !== undefined) {
      const min = lender.position_min ?? 1;
      const max =
        lender.position_max !== undefined && lender.position_max > 0
          ? lender.position_max
          : Number.POSITIVE_INFINITY;
      if (application.position_count < min || application.position_count > max) {
        const maxLabel = max === Number.POSITIVE_INFINITY ? "any" : String(max);
        flag(
          "high_risk",
          "position_out_of_range",
          `Deal sits at position ${application.position_count}; lender accepts ${min}-${maxLabel}`,
        );
      } else {
        const maxLabel = max === Number.POSITIVE_INFINITY ? "any" : String(max);
        reasons.push(`Position ${application.position_count} fits ${min}-${maxLabel} range`);
      }
    } else {
      score -= 5;
      flag(
        "info",
        "missing_position_data",
        "Lender has position-range constraint; deal doesn't report position_count",
      );
    }
  }

  // ── Paper grade (high_risk) — SOP §1 ───────────────────────────────
  if (lender.paper_grades && lender.paper_grades.length > 0) {
    if (application.paper_grade) {
      if (!lender.paper_grades.includes(application.paper_grade)) {
        flag(
          "high_risk",
          "paper_grade_mismatch",
          `Deal grades as ${application.paper_grade}; lender accepts ${lender.paper_grades.join("/")}`,
        );
      } else {
        reasons.push(`${application.paper_grade}-paper accepted by ${lender.paper_grades.join("/")} box`);
      }
    } else {
      score -= 5;
      flag(
        "info",
        "missing_paper_grade",
        "Lender has paper-grade box; deal hasn't been graded yet",
      );
    }
  }

  // ── Defaults policy (high_risk) — SOP §1 ───────────────────────────
  if (lender.defaults_policy && application.has_default !== undefined) {
    if (application.has_default) {
      if (lender.defaults_policy === "none") {
        flag(
          "high_risk",
          "default_blocked",
          "Deal has prior MCA default; lender does not accept any defaults",
        );
      } else if (lender.defaults_policy === "satisfied_only" && !application.default_satisfied) {
        flag(
          "high_risk",
          "unsatisfied_default",
          "Deal has unsatisfied prior default; lender accepts satisfied defaults only",
        );
      } else {
        reasons.push(
          lender.defaults_policy === "satisfied_only"
            ? "Default is satisfied; lender accepts satisfied defaults"
            : "Lender accepts defaults",
        );
      }
    }
  }

  // ── Max negative days (high_risk) — SOP §1 ─────────────────────────
  if (lender.max_negative_days !== undefined && application.negative_days !== undefined) {
    if (application.negative_days > lender.max_negative_days) {
      flag(
        "high_risk",
        "exceeds_max_negative_days",
        `Deal has ${application.negative_days} negative day(s); lender caps at ${lender.max_negative_days}`,
      );
    } else {
      reasons.push(`${application.negative_days} neg day(s) under ${lender.max_negative_days} cap`);
    }
  }

  // ── Reverses-only lender (high_risk on fresh capital) — SOP §7 #1 ──
  if (lender.reverses_only) {
    if (application.deal_kind === "reverse_consolidation") {
      reasons.push("Reverse-consolidation specialist; strong fit");
    } else {
      flag(
        "high_risk",
        "reverses_only_lender",
        "Lender funds reverse-consolidation only; this deal is fresh capital",
      );
    }
  }

  // ── Restricted states (high_risk) — Adon SOP §1/§4 ─────────────────
  if (lender.restricted_states && lender.restricted_states.length > 0) {
    if (application.merchant_state) {
      const merchantState = application.merchant_state.trim().toUpperCase();
      const restricted = lender.restricted_states.map((s) => s.trim().toUpperCase());
      if (restricted.includes(merchantState)) {
        flag(
          "high_risk",
          "restricted_state",
          `Merchant in ${merchantState}; lender does not fund this state`,
        );
      } else {
        reasons.push(`${merchantState} not in lender's restricted-states list`);
      }
    } else {
      score -= 3;
      flag(
        "info",
        "missing_merchant_state",
        "Lender has restricted-states list; deal doesn't report merchant_state",
      );
    }
  }

  // ── Restricted industries (high_risk) — Adon SOP §1/§4 ─────────────
  if (lender.restricted_industries && lender.restricted_industries.length > 0) {
    if (application.industry) {
      const industry = application.industry.trim().toLowerCase();
      const restricted = lender.restricted_industries.map((s) => s.trim().toLowerCase());
      if (restricted.includes(industry)) {
        flag(
          "high_risk",
          "restricted_industry",
          `Industry "${industry}" is on lender's restricted-industries list`,
        );
      } else {
        reasons.push(`Industry "${industry}" not restricted by lender`);
      }
    } else {
      score -= 3;
      flag(
        "info",
        "missing_industry",
        "Lender has restricted-industries list; deal doesn't report industry",
      );
    }
  }

  // ── SLA visibility (info) ──────────────────────────────────────────
  if (lender.sla_response_days !== undefined) {
    reasons.push(`SLA: ${lender.sla_response_days}d typical response`);
  }

  // Backward-compat: blockers = subset of warnings where severity='high_risk'.
  // Existing callers (POST /api/applications/[id]/shop-out) still read this
  // field; the 2026-05-25 UI prefers `warnings` for severity-tier rendering.
  const blockers = warnings.filter((w) => w.severity === "high_risk").map((w) => w.detail);

  if (blockers.length > 0) {
    return { lender_id: lender.id, score: 0, reasons, blockers, warnings };
  }

  return {
    lender_id: lender.id,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    blockers,
    warnings,
  };
}

/**
 * Batch wrapper — score every lender against an application + sort
 * by score descending. Operator UI consumes the sorted list directly.
 */
export function rankLenders(
  lenders: LenderProfile[],
  application: ApplicationProfile,
): MatchScore[] {
  return lenders
    .map((l) => scoreLenderMatch(l, application))
    .sort((a, b) => b.score - a.score);
}
