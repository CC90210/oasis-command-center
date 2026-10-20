/**
 * The type a public form sends for a file the visitor chose.
 *
 * Some browsers report no type at all for a real PDF or photo (a Windows PC
 * with no app registered for the extension, some Android pickers). Sent as
 * application/octet-stream, that file was refused by every field's list,
 * every time, and nothing the visitor could do changed it (independent review
 * of #714). The extension decides only for the inert types a form takes;
 * anything else stays octet-stream and is refused as before. The server's
 * per-field list is still the gate: the browser's type was never proof of
 * anything, so naming one from the extension trusts nothing new.
 */

const BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
};

export function chosenFileType(file: { name: string; type: string }): string {
  if (file.type) return file.type;
  const dot = file.name.lastIndexOf(".");
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  return BY_EXTENSION[ext] ?? "application/octet-stream";
}

/**
 * A file field's accepted types, as MIME types.
 *
 * The form builder's "Accepted file types" box is free text, so a field can
 * hold "pdf, jpg" or ".png" instead of MIME types. Matched literally, those
 * accepted nothing: every visitor's file was refused, forever, and the
 * browser's picker ignored them too (independent review of #714). An
 * extension this knows becomes its MIME type and "image" or "images" becomes
 * image/*. A MIME type is kept as written, lowercased. Anything else is
 * dropped, so a list of only unknown words reads as empty and the caller's
 * own default applies.
 */
export function normalizedAccept(rules: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of rules ?? []) {
    const rule = String(raw).trim().toLowerCase();
    if (!rule) continue;
    if (rule.includes("/")) {
      out.push(rule);
      continue;
    }
    const word = rule.replace(/^\*?\./, "");
    if (word === "image" || word === "images") out.push("image/*");
    else if (BY_EXTENSION[word]) out.push(BY_EXTENSION[word]);
  }
  return [...new Set(out)];
}
