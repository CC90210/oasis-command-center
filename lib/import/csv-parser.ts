/**
 * Generic CSV parser with per-entity column mapping.
 *
 * Replaces the leads-only leads-import-parser.ts. Works for any
 * EntityDefinition from lib/import/entities.ts. The parser is
 * intentionally tolerant of real-world board exports:
 *
 *   - Quoted fields with embedded commas, newlines, and doubled quotes
 *   - BOM at start of file (Excel UTF-8 export)
 *   - Mixed line endings (CR / LF / CRLF)
 *   - Leading "title" rows before the actual header
 *   - Trailing blank rows / total rows
 *   - Section labels in the first column (Monday-style group headers)
 *
 * Header matching is normalized (lowercase, alphanumeric only) against
 * the entity's `headerAliases` map. Operators can also OVERRIDE the
 * detected mapping in the UI before importing — the column mapper UI
 * lets you point any source header at any canonical field.
 */

import {
  type EntityDefinition,
  normalizeHeader,
} from "./entities";

export type ParsedRow = Record<string, string | null>;

export type ColMap = Array<string | null>;

export type ParseResult = {
  /** Source headers as-found, in order. */
  headers: string[];
  /** Raw data rows (string per cell). */
  rows: string[][];
  /** Best-guess mapping from source-column index → canonical field key. */
  colMap: ColMap;
  /** Mapped rows ready to send to /api/import/[entity]. */
  mapped: ParsedRow[];
  /** Index of the row we identified as the header (often > 0 for messy files). */
  headerRowIndex: number;
  /** Rows above the header we skipped (titles, blanks, section labels). */
  skippedPreambleRows: number;
  /** Rows below the header we skipped (blanks, totals, section labels). */
  skippedNoiseRows: number;
  /** Section labels we noticed — kept for the preview's group hints. */
  sectionLabels: string[];
  /** Set of canonical fields the parsed columns actually fill. */
  coveredFields: string[];
};

/**
 * Tokenize a single CSV line respecting double-quoted fields.
 *
 * Handles RFC-4180 semantics + the doubled-quote escape ("" → "). Multi-
 * line quoted cells are resolved BEFORE we get here by collapseQuotedNewlines.
 */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQ = true;
      } else if (ch === ",") {
        out.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Collapse newlines that fall INSIDE a quoted field. Without this each
 * embedded newline would prematurely terminate a row and the rest of the
 * file would parse offset by one column.
 */
function collapseQuotedNewlines(text: string): string {
  let out = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      // Doubled quote inside a quoted cell — keep both, don't toggle inQ
      if (inQ && text[i + 1] === '"') {
        out += '""';
        i++;
        continue;
      }
      inQ = !inQ;
      out += '"';
    } else if (inQ && (ch === "\n" || ch === "\r")) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Heuristic to pick the header row when the file has Monday-style
 * preamble. We score each row by how many cells map to known canonical
 * fields. The row with the highest score (and > 0) wins. Ties go to
 * the earliest row.
 */
function findHeaderRow(rows: string[][], entity: EntityDefinition): number {
  let bestIdx = 0;
  let bestScore = 0;
  // Look at the first 20 rows max — anything deeper than that is not a header.
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const row = rows[i];
    if (row.length < 2) continue;
    let score = 0;
    for (const cell of row) {
      if (entity.headerAliases[normalizeHeader(cell)]) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestScore > 0 ? bestIdx : 0;
}

/**
 * Identify which canonical field each source column maps to, OR null
 * when the source header doesn't match any alias.
 */
function buildColMap(headers: string[], entity: EntityDefinition): ColMap {
  return headers.map((h) => entity.headerAliases[normalizeHeader(h)] ?? null);
}

/**
 * A row is "noise" (blank, total, section-label) when:
 *   - Every cell is empty, OR
 *   - It has exactly one non-empty cell + every recognized canonical
 *     column is empty (Monday-style section header e.g. "Hot Leads")
 */
function isNoiseRow(row: string[], colMap: ColMap): { noise: boolean; sectionLabel: string | null } {
  const nonEmpty = row.filter((c) => c && c.trim() !== "");
  if (nonEmpty.length === 0) return { noise: true, sectionLabel: null };
  if (nonEmpty.length === 1) {
    // Section label IF none of the recognized columns are filled
    const anyCanonicalFilled = row.some((c, i) => colMap[i] !== null && c && c.trim() !== "");
    if (!anyCanonicalFilled) {
      return { noise: true, sectionLabel: nonEmpty[0] };
    }
  }
  return { noise: false, sectionLabel: null };
}

/** Top-level: parse CSV text against an entity definition. */
export function parseImportCsv(
  rawText: string,
  entity: EntityDefinition,
): ParseResult {
  // Strip BOM
  let text = rawText;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  text = collapseQuotedNewlines(text);
  const lines = text.split(/\r\n|\r|\n/);
  const allRows = lines.map(parseCsvLine).filter((r) => r.length > 0);

  if (allRows.length === 0) {
    return {
      headers: [],
      rows: [],
      colMap: [],
      mapped: [],
      headerRowIndex: 0,
      skippedPreambleRows: 0,
      skippedNoiseRows: 0,
      sectionLabels: [],
      coveredFields: [],
    };
  }

  const headerRowIndex = findHeaderRow(allRows, entity);
  const headers = allRows[headerRowIndex];
  const colMap = buildColMap(headers, entity);
  const skippedPreambleRows = headerRowIndex;
  const dataRows = allRows.slice(headerRowIndex + 1);

  const sectionLabels: string[] = [];
  let skippedNoiseRows = 0;
  const cleanRows: string[][] = [];
  for (const row of dataRows) {
    const { noise, sectionLabel } = isNoiseRow(row, colMap);
    if (noise) {
      skippedNoiseRows += 1;
      if (sectionLabel) sectionLabels.push(sectionLabel);
      continue;
    }
    cleanRows.push(row);
  }

  const mapped: ParsedRow[] = cleanRows.map((row) => {
    const obj: ParsedRow = {};
    colMap.forEach((field, idx) => {
      if (!field) return;
      const raw = (row[idx] ?? "").trim();
      obj[field] = raw === "" ? null : raw;
    });
    return obj;
  });

  const coveredFields = Array.from(
    new Set(colMap.filter((c): c is string => c !== null)),
  );

  return {
    headers,
    rows: cleanRows,
    colMap,
    mapped,
    headerRowIndex,
    skippedPreambleRows,
    skippedNoiseRows,
    sectionLabels,
    coveredFields,
  };
}

/**
 * Apply an operator-overridden colMap (from the UI's column-mapper
 * panel) to existing parsed rows. Lets the user fix any header we
 * didn't auto-detect without re-uploading the file.
 */
export function remapWithOverride(
  parsed: ParseResult,
  overrideMap: ColMap,
): ParseResult {
  const newMapped = parsed.rows.map((row) => {
    const obj: ParsedRow = {};
    overrideMap.forEach((field, idx) => {
      if (!field) return;
      const raw = (row[idx] ?? "").trim();
      obj[field] = raw === "" ? null : raw;
    });
    return obj;
  });
  const coveredFields = Array.from(
    new Set(overrideMap.filter((c): c is string => c !== null)),
  );
  return { ...parsed, colMap: overrideMap, mapped: newMapped, coveredFields };
}
