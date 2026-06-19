"use client";

/**
 * ComboboxField — pick-from-list OR type-your-own input for the public form
 * `combobox` field (Industry: a merchant whose industry isn't in the preset
 * list could not submit with the old dropdown-only control).
 *
 * Storage semantics preserved from the old <select>: picking a preset stores
 * that option's VALUE (the lowercase slug match-fitness reads), so restricted-
 * industry gating keeps working unchanged. Typing a custom value stores the raw
 * text (treated downstream like "other" — it just won't trip a lender's
 * restricted-industry list). On blur, an exact label/value match snaps back to
 * the preset so a hand-typed "Restaurant" still stores the canonical slug.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";

type Opt = { value: string; label: string };

const BASE =
  "w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors placeholder-fg-dim";

export function ComboboxField({
  inputId,
  value,
  options,
  placeholder,
  onChange,
}: {
  inputId: string;
  value: unknown;
  options: Opt[];
  placeholder?: string;
  onChange: (v: string) => void;
}) {
  const stored = typeof value === "string" ? value : "";
  const matching = options.find((o) => o.value === stored);
  const [text, setText] = useState(matching ? matching.label : stored);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Resync the visible text when the stored value changes externally (e.g. a
  // prefill or going back a step).
  useEffect(() => {
    const m = options.find((o) => o.value === stored);
    setText(m ? m.label : stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const q = text.trim().toLowerCase();
  const filtered = q
    ? options.filter(
        (o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q),
      )
    : options;
  const isCustom =
    q.length > 0 &&
    !options.some((o) => o.label.toLowerCase() === q || o.value.toLowerCase() === q);

  return (
    <div ref={wrapRef} className="relative">
      <div className="relative">
        <input
          id={inputId}
          value={text}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            const m = options.find(
              (o) =>
                o.label.toLowerCase() === text.trim().toLowerCase() ||
                o.value.toLowerCase() === text.trim().toLowerCase(),
            );
            if (m) {
              setText(m.label);
              onChange(m.value);
            }
          }}
          placeholder={placeholder || "Select or type your industry…"}
          className={`${BASE} pr-9`}
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-dim" />
      </div>

      {open && filtered.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-bg-border bg-bg-elev shadow-lg">
          {filtered.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                // onMouseDown (not onClick) so it fires before the input's blur.
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(o.label);
                  onChange(o.value);
                  setOpen(false);
                }}
                className="block w-full px-3 py-2 text-left text-sm text-fg hover:bg-accent/10"
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {isCustom && (
        <p className="mt-1 text-[11px] text-fg-dim">
          Not in the list? “{text.trim()}” will be saved as your industry.
        </p>
      )}
    </div>
  );
}
