"use client";

/** The engagement page's one way to call its API: POST an action, read the JSON answer. */
export type ActionResult = { ok: boolean; error?: string; detail?: string; problems?: string[]; field?: string; path?: string; [k: string]: unknown };

const ERROR_WORDS: Record<string, string> = {
  changed_elsewhere_refresh: "Someone else changed this engagement. Reload to see the latest, then try again.",
  not_ready: "Not ready yet. Fix the items listed.",
  owner_only: "Only the workspace owner can do this.",
  nothing_running: "No draft of the profile is running.",
  extraction_running: "A draft of the profile is already running. Wait for it, or cancel it first.",
  no_transcript: "Add a transcript with lines in it first.",
  research_not_installed: "Research needs its tables first: database migration bravo__243 is not applied yet.",
  no_research: "Research has not finished yet, so there is nothing to draft from.",
  no_ai_engine: "The client did not agree to AI analysis, so no model writes any of it. The draft's own wording stays.",
  draft_exists: "There is a draft already. Press again and confirm to replace what it says.",
  no_audit_draft: "There is no audit draft yet. Draft the audit first.",
  not_editable: "The audit is with you for final approval or already sent. Take it back for edits first.",
  draft_invalid: "The draft could not be built. Nothing was saved, and the error was logged.",
  assumptions_invalid: "Those assumptions could not be read. Reload the page and try again.",
  assumption_unknown: "That is not one of the calculator's assumptions. Reload the page and try again.",
  assumption_range: "Each range needs a low and a high between 0 and 100%, the low no higher than the high.",
  no_lead: "This engagement has no lead to hold a call room for.",
  meet_not_installed: "Oasis Meet is not set up on this workspace yet.",
  meet_not_configured: "Oasis Meet's video service is not set up, so a call room would not connect. Hold the call elsewhere and paste its transcript afterwards.",
  meet_not_ready: "Meet has not finished that transcript yet.",
  no_guests: "No guest joined that room, so it is not the client's call.",
  ai_answer_needed: "Say what the client answered about AI analysis first.",
  ai_answer_unconfirmed: "The profile's answer about AI analysis was not saved by the workspace owner as what the client said. The owner attaches this call, saying what the client agreed to.",
  held: "Only the workspace owner can attach this call: something about it needs a person to check that it is the client's call for this audit.",
  attached_with_other_ai_answer: "That call is already attached, with the other answer about AI analysis. Nothing was changed. To change the answer, delete that transcript, then attach the call again.",
  meet_transcript_empty: "That call's transcript has no words to attach.",
  meet_transcript_too_large: "That call's transcript is over 500 KB, the most one transcript can hold. Nothing was cut or attached: paste the part of the call that matters instead.",
  meet_transcript_too_many_lines: "That call's transcript has more than 20,000 lines, the most one transcript can hold. Nothing was cut or attached: paste the part of the call that matters instead.",
  stage_not_settable_by_hand: "That stage is set by the work itself, not by hand.",
  profile_frozen: "This profile version is frozen. Reopen it to edit.",
  move_not_allowed: "That move is not allowed from the current stage.",
  only_before_delivery: "This can only be done before the audit is delivered.",
  not_revisable: "Only a delivered audit that is not paid yet can be revised.",
  already_paid: "The client has paid, so this audit can no longer be revised.",
  nothing_delivered: "There is no delivered audit to revise.",
  checkout_still_open: "A payment page could not be closed at Stripe, so nothing changed. Try again in a minute.",
  payment_received: "Stripe has confirmed a payment for this audit, so it cannot be revised. Look at the payment on the engagement first.",
  checkout_opening: "The client is opening a payment page right now, so nothing changed. Try again in two minutes.",
  checkout_complete: "The client finished checkout and the payment may still be clearing, so the audit cannot be revised now. Check the payment in Stripe.",
  draft_copy_failed: "The revision's drafts could not be made, so the audit is back as it was. Try again.",
  nothing_submitted: "Nothing has been submitted yet.",
  not_submittable_at_this_stage: "The audit can be submitted once you have authorized the discovery profile (Gate 1).",
  not_authorized: "The discovery profile is not authorized, or it changed since. Authorize it first.",
  not_ready_for_authorization: "Authorization comes after the call: move the engagement to Discovery Call Completed first.",
  no_profile: "Start the discovery profile first.",
  profile_empty: "Add at least one fact to the discovery profile first.",
  profile_not_draft: "This profile version is already frozen. Ask for authorization again to open a new draft from it.",
  no_ai_consent: "The client did not agree to AI analysis, so only \"No AI\" is possible.",
  stage_moved: "The engagement moved on. Reload to see where it stands.",
  stage_closed: "The profile is authorized, so this can no longer change. Move the engagement back to Transcript Awaiting Approval first.",
  no_recording_consent: "A transcript can only be added for a call the client agreed to record.",
  recording_declined: "The profile records that the client said no to the recording, so no transcript of the call can be used. Correct that answer on the profile first if it was recorded wrongly.",
  consent_ai_required: "Say whether the client agreed to AI analysis.",
  filename_required: "Choose the file to upload.",
  transcript_too_large: "That transcript is over 500 KB. Split it, or paste the part that matters.",
  transcript_empty: "The transcript is empty.",
  transcript_too_many_lines: "That transcript has too many lines. Split it into parts.",
  transcript_unsupported_type: "Use a .txt, .vtt or .srt file.",
  note_invalid: "That note could not be saved.",
  conflict: "Changed in another tab. Reload to see the latest.",
  not_started: "Start the call first.",
  delivery_unknown_check_sent: "The last send may have gone. Check the Sent folder first, then choose It was sent, or It was not sent.",
  nothing_uncertain: "There is no uncertain delivery to confirm.",
  link_gone: "That email's link was revoked, so it cannot be recorded as delivered. Send again instead.",
  delivery_in_progress: "The audit email is being sent right now. Wait a minute, then try again.",
  too_many_transcripts: "This engagement already has 20 transcripts. Delete one you no longer need first.",
  brief_stage_closed: "The client's information is authorized, so the pre-call brief is final. Research after Gate 1 takes over from here.",
  brief_too_soon: "The brief was built less than a minute ago. Wait a moment, then build it again.",
  brief_not_installed: "The pre-call brief is not set up on this server yet: its database migration (bravo__241) has not been applied. The rest of the audit works.",
  details_frozen: "The business's name and type were authorized at Gate 1, so they can no longer change here. The contact can still change. To change the business, move the engagement back to Transcript Awaiting Approval.",
  unknown_question: "That question is not in the discovery framework.",
  business_name_invalid: "The business name is missing or too long (200 characters at most). Fix it under Details, then ask again.",
  too_long: "That note is too long. Keep it under 4,000 characters.",
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
