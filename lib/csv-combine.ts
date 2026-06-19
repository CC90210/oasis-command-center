/**
 * Combine several CSV files' text into one import batch (Adon 2026-06-19 — the
 * Import page only accepted one file at a time; operators routinely split an
 * export into several CSVs and want to select/drag them all at once).
 *
 * The first non-empty file's header is canonical; subsequent files whose first
 * line is the same header (case/whitespace-insensitive) have it stripped before
 * their rows are appended. Files whose header differs still get all rows appended
 * (best effort — the import preview's column-map lets the operator correct any
 * mismatch). Strips a leading UTF-8 BOM. Single file in → unchanged out.
 */
export function combineCsvTexts(texts: string[]): string {
  const nonEmpty = texts
    .map((t) => t.replace(/^﻿/, "").trim())
    .filter(Boolean);
  if (nonEmpty.length === 0) return "";
  if (nonEmpty.length === 1) return nonEmpty[0];
  const norm = (line: string) => line.trim().toLowerCase().replace(/\s+/g, "");
  const header = nonEmpty[0].split(/\r?\n/)[0] ?? "";
  const headerKey = norm(header);
  const out: string[] = [header];
  for (const t of nonEmpty) {
    const lines = t.split(/\r?\n/);
    const start = lines.length > 0 && norm(lines[0]) === headerKey ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      if (lines[i].trim()) out.push(lines[i]);
    }
  }
  return out.join("\n");
}
