"use client";

/** The engagement page's one way to call its API: POST an action, read the JSON answer. */
export type ActionResult = { ok: boolean; error?: string; detail?: string; problems?: string[]; field?: string; path?: string; [k: string]: unknown };

const ERROR_WORDS: Record<string, string> = {
  changed_elsewhere_refresh: "Someone else changed this engagement. Reload to see the latest, then try again.",
  not_ready: "Not ready yet. Fix the items listed.",
  owner_only: "Only the workspace owner can do this.",
  stage_not_settable_by_hand: "That stage is set by the work itself, not by hand.",
  profile_frozen: "This profile version is frozen. Reopen it to edit.",
  move_not_allowed: "That move is not allowed from the current stage.",
  only_before_delivery: "This can only be done before the audit is delivered.",
  nothing_submitted: "Nothing has been submitted yet.",
  not_submittable_at_this_stage: "The audit can be submitted once the discovery profile is in review.",
};

export function describeError(r: ActionResult): string {
  const base = (r.error && ERROR_WORDS[r.error]) || r.error || "Something went wrong.";
  const extra = r.detail ? ` (${r.field || r.path ? `${r.field || r.path}: ` : ""}${r.detail})` : "";
  return `${base}${extra}`;
}

export async function postAction(engagementId: string, action: string, body: Record<string, unknown> = {}): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/ai-audit/${encodeURIComponent(engagementId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as ActionResult;
    return json;
  } catch {
    return { ok: false, error: "network_error" };
  }
}

export async function postJson(url: string, body: Record<string, unknown>): Promise<ActionResult> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as ActionResult;
  } catch {
    return { ok: false, error: "network_error" };
  }
}
