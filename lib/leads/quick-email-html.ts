/**
 * quick-email-html.ts — render a rep's quick email as branded OASIS HTML.
 *
 * WHY THIS WRAPS TEXT RATHER THAN COMPOSING ITS OWN.
 *
 * The rep edits the message in a plain textarea before sending, and that edit
 * has to be the thing the prospect receives. So this takes the FINAL body text
 * — after the rep's changes — and dresses it. It never authors copy of its own.
 * A renderer that composed separately would drift from the textarea the moment
 * a rep changed a word, and the prospect would get a message nobody had read.
 *
 * That also means text and HTML can never disagree: they are the same string,
 * rendered twice. Both parts go on the wire (multipart/alternative) because a
 * plain-text alternative is worth real deliverability, and some clients still
 * refuse HTML outright.
 *
 * NO SHARED BRAND SHELL. lib/email/brand-shell.ts belongs to the other business
 * that happens to run on this codebase, and its resolveBrandKey() maps anything
 * unrecognised onto that brand — so wiring OASIS through it would put another
 * company's legal name under an OASIS email the first time a key was missed.
 * OASIS's identity is spelled out here, in full, and never inferred.
 *
 * Pure. No React, no network, no "server-only", so the thing a stranger
 * actually receives is directly testable.
 */

/** The one place OASIS's outbound identity is written down. */
export const OASIS_EMAIL_BRAND = {
  name: "OASIS AI Solutions",
  /** CASL/CAN-SPAM identification line. A real address mail is received at. */
  postalAddress: "6993 Decarie Blvd, Montreal, QC H3W 0B5, Canada",
  logoUrl: "https://oasisai.work/oasis-logo.jpg",
  /** Matches the portal's accent so an email and the dashboard look related. */
  accent: "#2FB6A8",
  ink: "#12181f",
  muted: "#66707d",
  hairline: "#e6eaef",
  paper: "#ffffff",
  backdrop: "#f4f6f8",
} as const;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Only http(s) survives. A body is rep-editable text, so a `javascript:` or
 * `data:` URL pasted into it must never become a live anchor in a stranger's
 * inbox. Anything else is rendered as plain text instead of linked.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}

/** A bare URL sitting on its own line — the booking link's shape. */
const BARE_URL_LINE = /^https?:\/\/\S+$/i;
/** URLs appearing inside a sentence, linkified in place. */
const INLINE_URL = /(https?:\/\/[^\s<>"')]+)/g;

/**
 * Blocks, in the order the reader meets them. `cta` is a booking link that
 * earned a button because it stood alone on its own line.
 */
type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "cta"; href: string };

/**
 * Split the body into blocks on blank lines, promoting a lone URL to a button.
 *
 * Exported for tests: the promotion rule is the difference between a prospect
 * seeing "pick a time" as a button and seeing a naked 60-character URL, and it
 * is decided here rather than in the markup.
 */
export function toBlocks(body: string): Block[] {
  const chunks = body.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const blocks: Block[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;
    const lines = trimmed.split("\n");
    const last = lines[lines.length - 1].trim();
    if (BARE_URL_LINE.test(last)) {
      const href = safeHref(last);
      const lead = lines.slice(0, -1).join("\n").trim();
      if (href) {
        if (lead) blocks.push({ kind: "paragraph", text: lead });
        blocks.push({ kind: "cta", href });
        continue;
      }
    }
    blocks.push({ kind: "paragraph", text: trimmed });
  }
  return blocks;
}

/** Escape, linkify in place, and keep single newlines as line breaks. */
function paragraphHtml(text: string): string {
  const parts = text.split(INLINE_URL);
  const html = parts
    .map((part, i) => {
      // Odd indices are the captured URLs.
      if (i % 2 === 1) {
        const href = safeHref(part);
        if (!href) return escapeHtml(part);
        return (
          `<a href="${escapeHtml(href)}" style="color:${OASIS_EMAIL_BRAND.accent};` +
          `text-decoration:underline;">${escapeHtml(part)}</a>`
        );
      }
      return escapeHtml(part);
    })
    .join("")
    .replace(/\n/g, "<br />");
  return html;
}

export type QuickEmailHtmlOptions = {
  /** The rep's sign-off name. Rendered above the identification block. */
  signerName?: string | null;
  /** Shown under the sign-off so the prospect knows who they are replying to. */
  signerEmail?: string | null;
  /** Reply UNSUBSCRIBE is the opt-out; no link, matching the text footer. */
  preheader?: string | null;
};

/**
 * Render the final HTML.
 *
 * Table-based with inline styles on purpose. Outlook's Word engine drops most
 * modern layout, and a `<style>` block is stripped by several webmail clients,
 * so anything that must survive is inlined on the element it styles.
 */
export function renderQuickEmailHtml(body: string, opts: QuickEmailHtmlOptions = {}): string {
  const b = OASIS_EMAIL_BRAND;
  const blocks = toBlocks(body);

  const content = blocks
    .map((block) => {
      if (block.kind === "cta") {
        const href = escapeHtml(block.href);
        // A bulletproof-ish button: padded anchor inside a table cell, so a
        // client that drops the background still shows a legible link.
        return (
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0" ` +
          `style="margin:22px 0;"><tr><td style="border-radius:8px;background:${b.accent};">` +
          `<a href="${href}" style="display:inline-block;padding:13px 26px;font-family:` +
          `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;` +
          `font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">` +
          `Pick a time that suits you</a></td></tr></table>` +
          // The raw URL stays visible: a button whose target cannot be seen is
          // exactly the shape a phishing filter and a cautious owner distrust.
          `<div style="margin:-10px 0 20px;font-size:12px;line-height:1.5;color:${b.muted};">` +
          `<a href="${href}" style="color:${b.muted};text-decoration:underline;">${href}</a></div>`
        );
      }
      return (
        `<p style="margin:0 0 16px;font-size:15px;line-height:1.62;color:${b.ink};">` +
        `${paragraphHtml(block.text)}</p>`
      );
    })
    .join("");

  const signer = (opts.signerName || "").trim();
  const signerEmail = (opts.signerEmail || "").trim();
  const signature = signer
    ? `<p style="margin:26px 0 0;font-size:15px;line-height:1.62;color:${b.ink};">` +
      `${escapeHtml(signer)}<br />` +
      `<span style="color:${b.muted};font-size:13px;">${escapeHtml(b.name)}` +
      (signerEmail
        ? ` &middot; <a href="mailto:${escapeHtml(signerEmail)}" style="color:${b.muted};">` +
          `${escapeHtml(signerEmail)}</a>`
        : "") +
      `</span></p>`
    : "";

  // Hidden preheader controls the grey preview line next to the subject in a
  // list view. Left unset it shows the first words of the greeting, which is
  // the least informative sentence in the message.
  const preheader = (opts.preheader || "").trim();
  const preheaderHtml = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;` +
      `mso-hide:all;">${escapeHtml(preheader)}</div>`
    : "";

  return (
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" />` +
    `<meta name="viewport" content="width=device-width,initial-scale=1" />` +
    // Tells a dark-mode client we have handled both, so it tints rather than
    // force-inverting and turning the accent into something unreadable.
    `<meta name="color-scheme" content="light dark" />` +
    `<meta name="supported-color-schemes" content="light dark" />` +
    `<title>${escapeHtml(b.name)}</title></head>` +
    `<body style="margin:0;padding:0;background:${b.backdrop};">` +
    preheaderHtml +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="background:${b.backdrop};padding:28px 12px;"><tr><td align="center">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ` +
    `style="max-width:560px;width:100%;background:${b.paper};border-radius:12px;` +
    `border:1px solid ${b.hairline};font-family:-apple-system,BlinkMacSystemFont,` +
    `'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">` +
    // Header: mark plus wordmark. Small, because this is a person writing to a
    // person, not a newsletter.
    `<tr><td style="padding:24px 28px 4px;">` +
    `<img src="${escapeHtml(b.logoUrl)}" width="34" height="34" alt="${escapeHtml(b.name)}" ` +
    `style="display:inline-block;vertical-align:middle;border-radius:8px;border:0;" />` +
    `<span style="display:inline-block;vertical-align:middle;margin-left:10px;font-size:15px;` +
    `font-weight:600;letter-spacing:0.2px;color:${b.ink};">${escapeHtml(b.name)}</span>` +
    `</td></tr>` +
    `<tr><td style="padding:14px 28px 4px;">${content}${signature}</td></tr>` +
    // Identification block. CASL requires the sender be identifiable with a
    // real address and a working opt-out; reply UNSUBSCRIBE is the mechanism,
    // stated in the same words as the plain-text part.
    `<tr><td style="padding:20px 28px 24px;">` +
    `<div style="border-top:1px solid ${b.hairline};padding-top:14px;font-size:12px;` +
    `line-height:1.6;color:${b.muted};">` +
    `<div>${escapeHtml(b.name)}, ${escapeHtml(b.postalAddress)}</div>` +
    `<div style="margin-top:6px;">You received this email because we reached out about ` +
    `your business. To stop receiving emails, reply UNSUBSCRIBE.</div>` +
    `</div></td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}
