"use client";

/**
 * Number fields for the AI audit editors. A number is typed as text and the
 * text is kept while CC types, so "1299." keeps its point and "0." can become
 * "0.5"; the parsed number goes up on every keystroke. When the number changes
 * from outside (another row removed, the draft reloaded) the field shows it.
 *
 * Why: the first editors rendered String(number) on every keystroke, so the
 * decimal point vanished as it was typed. "1299.5" typed key by key became
 * 12995, a $12,995 line on a proposal (review of PR #732, confirmed in a
 * browser).
 */
import { useState } from "react";

/** "1,299.50" / "$12" / " 7 " → the number; "", ".", "-" or anything else → null. */
export function parseTypedNumber(s: string): number | null {
  const raw = s.replace(/[$,\s]/g, "");
  if (!raw || raw === "." || raw === "-" || raw === "-.") return null;
  if (!/^-?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

type Props = {
  /** The number the draft holds, or null for none. */
  value: number | null;
  onChange: (n: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** What the draft holds while the field is empty (0 for a required figure); the field may still be cleared to retype. */
  emptyValue?: number | null;
  /** Shown value for a stored number, e.g. cents as dollars. */
  format?: (n: number) => string;
  /** Typed number to stored number, e.g. dollars to cents. Return null to refuse. */
  toValue?: (n: number) => number | null;
  "aria-label"?: string;
};

export function NumberInput({ value, onChange, disabled, placeholder, className, emptyValue = null, format = String, toValue = (n) => n, ...rest }: Props) {
  const [text, setText] = useState(value === null ? "" : format(value));
  const typed = parseTypedNumber(text);
  const typedValue = typed === null ? null : toValue(typed);
  const matches = typedValue === value || (text.trim() === "" && value === emptyValue);
  const shown = matches ? text : value === null ? "" : format(value);
  return (
    <input
      className={className ?? "input"}
      inputMode="decimal"
      disabled={disabled}
      placeholder={placeholder}
      aria-label={rest["aria-label"]}
      value={shown}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseTypedNumber(e.target.value);
        onChange(n === null ? emptyValue : toValue(n));
      }}
    />
  );
}
