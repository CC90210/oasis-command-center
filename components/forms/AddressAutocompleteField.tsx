"use client";

/**
 * AddressAutocompleteField — predictive address typeahead for the public form's
 * "address" field type. Debounced query to /api/forms/address-autocomplete
 * (server-side provider proxy: Google Places / Mapbox / Photon), a dropdown of
 * suggestions, keyboard navigation, and on-select fills the input with the
 * formatted address STRING (so the stored value is identical to a text field —
 * downstream PDF/lead-record paths are unaffected).
 *
 * Graceful degradation: if the API errors or returns nothing, the field behaves
 * as a normal text input the merchant can fill manually.
 */

import { useEffect, useRef, useState } from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputId?: string;
};

const BASE_INPUT =
  "w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors placeholder-fg-dim";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

export function AddressAutocompleteField({ value, onChange, placeholder, inputId }: Props) {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (blurRef.current) clearTimeout(blurRef.current);
      abortRef.current?.abort();
    };
  }, []);

  const runSearch = (q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Abort any in-flight request the instant a new keystroke arrives (not
    // 300ms later inside the callback) — so deleting back below MIN_CHARS, or
    // typing on, can't let a stale response repopulate the dropdown. (Codex +
    // review 2026-06-17.)
    abortRef.current?.abort();
    if (q.trim().length < MIN_CHARS) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const ac = new AbortController();
      abortRef.current = ac;
      setLoading(true);
      try {
        const res = await fetch(
          `/api/forms/address-autocomplete?q=${encodeURIComponent(q.trim())}`,
          { signal: ac.signal },
        );
        const data = (await res.json()) as { ok?: boolean; suggestions?: string[] };
        // A late resolve from a superseded request must not paint stale data.
        if (ac.signal.aborted) return;
        if (data.ok && Array.isArray(data.suggestions) && data.suggestions.length > 0) {
          setSuggestions(data.suggestions);
          setActiveIndex(-1);
          setOpen(true);
        } else {
          setSuggestions([]);
          setOpen(false);
        }
      } catch {
        // Aborted or network error — leave the field usable as plain text.
      } finally {
        setLoading(false);
      }
    }, DEBOUNCE_MS);
  };

  const handleInput = (v: string) => {
    onChange(v);
    runSearch(v);
  };

  const select = (s: string) => {
    onChange(s);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(suggestions.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      // Always consume Enter while the dropdown is open so it can't bubble to
      // the form's submit and prematurely submit the step. Pick the highlighted
      // suggestion if there is one; otherwise just hold focus. (review 2026-06-17 [high].)
      e.preventDefault();
      if (activeIndex >= 0 && activeIndex < suggestions.length) {
        select(suggestions[activeIndex]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <input
        id={inputId}
        type="text"
        autoComplete="off"
        value={typeof value === "string" ? value : ""}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onBlur={() => {
          // Delay close so a mousedown on a suggestion registers first.
          blurRef.current = setTimeout(() => setOpen(false), 150);
        }}
        placeholder={placeholder || "Start typing your address…"}
        className={BASE_INPUT}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${inputId ?? "addr"}-listbox`}
        aria-autocomplete="list"
      />
      {loading && (
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[11px] text-fg-dim">
          …
        </span>
      )}
      {open && suggestions.length > 0 && (
        <ul
          id={`${inputId ?? "addr"}-listbox`}
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border border-bg-border bg-bg-elev shadow-lg"
          role="listbox"
        >
          {suggestions.map((s, i) => (
            <li key={`${s}-${i}`} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                // onPointerDown (not onClick) so selection fires before the
                // input's blur close — and covers mouse + touch + pen, where a
                // plain onMouseDown misses taps on mobile. (review 2026-06-17.)
                onPointerDown={(e) => {
                  e.preventDefault();
                  select(s);
                }}
                className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                  i === activeIndex
                    ? "bg-accent/15 text-fg"
                    : "text-fg-muted hover:bg-bg-hover hover:text-fg"
                }`}
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
