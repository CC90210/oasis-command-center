"use client";

/**
 * SlashCommandTemplateMenu — plan §3. Typing `/` in the composer opens this
 * popover; picking a template interpolates `{{var}}` placeholders from the
 * thread's known contact/deal fields and inserts the result into the draft.
 * Kept generic/tenant-neutral on purpose — no lender names, no promises,
 * just structural starters an operator edits before sending.
 */

export type SlashTemplate = { id: string; label: string; body: string };

export const DEFAULT_SMS_TEMPLATES: SlashTemplate[] = [
  {
    id: "followup",
    label: "Following up",
    body: "Hi {{first_name}}, just following up — do you have a few minutes to talk today?",
  },
  {
    id: "docs",
    label: "Docs request",
    body: "Hi {{first_name}}, to keep things moving I just need your last 3 months of bank statements. You can reply here with them.",
  },
  {
    id: "offer_ready",
    label: "Offer ready",
    body: "Hi {{first_name}}, good news — {{merchant_company}}'s offer is ready. Give me a call when you get a chance.",
  },
  {
    id: "missed_call",
    label: "Missed you",
    body: "Hi {{first_name}}, I tried calling — when's a good time to connect?",
  },
];

export const DEFAULT_EMAIL_TEMPLATES: SlashTemplate[] = [
  {
    id: "docs_email",
    label: "Docs request (email)",
    body: "Hi {{first_name}},\n\nTo keep {{merchant_company}}'s file moving, could you send over your last 3 months of business bank statements?\n\nThanks,",
  },
  {
    id: "checkin_email",
    label: "Check-in (email)",
    body: "Hi {{first_name}},\n\nWanted to check in on where things stand. Let me know if you have any questions.\n\nBest,",
  },
];

/** Replace every `{{var}}` with the matching value; unresolved vars are left
 *  as-is (visible, not silently dropped) so the operator notices and fixes
 *  them before sending. */
export function interpolateTemplate(body: string, vars: Record<string, string | undefined>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const v = vars[key];
    return v && v.trim() ? v : match;
  });
}

export function SlashCommandTemplateMenu({
  query,
  templates,
  onPick,
  onClose,
}: {
  query: string;
  templates: SlashTemplate[];
  onPick: (t: SlashTemplate) => void;
  onClose: () => void;
}) {
  const q = query.trim().toLowerCase();
  const filtered = q
    ? templates.filter((t) => t.label.toLowerCase().includes(q) || t.id.includes(q))
    : templates;

  return (
    <div className="absolute bottom-full left-0 mb-1.5 w-72 max-h-64 overflow-y-auto rounded-lg border border-bg-border bg-bg-elev shadow-elev z-20">
      <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-fg-dim border-b border-bg-border/60 flex items-center justify-between">
        <span>Templates</span>
        <button type="button" onClick={onClose} className="text-fg-dim hover:text-fg">
          Esc
        </button>
      </div>
      {filtered.length === 0 ? (
        <div className="px-3 py-3 text-[12px] text-fg-dim italic">No templates match &ldquo;{query}&rdquo;.</div>
      ) : (
        <ul>
          {filtered.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="w-full text-left px-3 py-2 hover:bg-bg-deep/60 transition-colors"
              >
                <div className="text-[12.5px] font-medium text-fg">{t.label}</div>
                <div className="text-[11px] text-fg-dim truncate">{t.body}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
