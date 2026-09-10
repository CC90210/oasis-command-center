"use client";

/**
 * AddressAutocompleteField — predictive address typeahead for the public form's
 * "address" field type. Debounced query to /api/forms/address-autocomplete
 * (server-side provider proxy: Google Places / Mapbox / Photon), a dropdown of
 * suggestions, keyboard navigation, and on-select fills the input with the
 * formatted address STRING (so the stored value is identical to a text field —
 * downstream PDF/lead-record paths are unaffected).
 *
 * ---------------------------------------------------------------------------
 * THE GUARANTEE THIS COMPONENT NOW MAKES (2026-09-10)
 *
 * A merchant must ALWAYS be able to submit a correct address, whatever the
 * geocoding provider does. Before this rewrite there were three ways to reach a
 * dead end, all of them live in production and all of them blocking real
 * funding applications:
 *
 *   1. NO EXIT. A suggestion carrying no ZIP could be selected from our own
 *      dropdown and then refused by our own capture gate ("Include the ZIP
 *      code"). Re-opening the dropdown offered the identical entry again. The
 *      field is a free-text input, so a merchant who KNEW to append ", IL 60102"
 *      could escape — but nothing on screen ever told them that, and the gate
 *      only speaks after they have already been rejected.
 *
 *   2. THE SELECT→CONTINUE RACE. Google's autocomplete label has no postal code
 *      ("911 Magnolia Dr, Algonquin, IL, USA"); the ZIP arrives only from a
 *      SECOND Place Details round trip. `loading` was local state, so the form
 *      had no idea a resolution was in flight. Selecting a suggestion and
 *      clicking Continue inside that window was rejected for a missing ZIP that
 *      was already on its way. PR #426 named this defect in its title and did
 *      not actually close it — the signal never reached the validator.
 *
 *   3. A FAILED DETAILS CALL STUCK THE MERCHANT. One 429 or one timeout on the
 *      Place Details hop left the ZIP-less label in the box, which the gate then
 *      refused, which returned them to (1).
 *
 * The fixes, in order of what a merchant hits first:
 *   - `onResolvingChange` tells the form a ZIP is in flight, so Continue WAITS
 *     instead of rejecting. Closes (2).
 *   - The Place Details call retries once before giving up. Reduces (3).
 *   - `AddressCompletion` — an always-available structured City / State / ZIP
 *     row, revealed the moment the typed line cannot satisfy the gate. It is
 *     composed back into the SAME single string, so nothing downstream changes.
 *     This is the actual guarantee: it does not depend on any provider being up,
 *     correct, or configured, and it closes (1) and (3) outright.
 *
 * Graceful degradation: if the API errors or returns nothing, the field behaves
 * as a normal text input, now with the completion row to finish it off.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { normalizeAddressSuggestions, type AddressSuggestion } from "@/lib/forms/address-suggestions";
import {
  isAcceptableCaptureAddress,
  splitUsAddress,
  composeUsAddress,
  US_STATE_CODES,
} from "@/lib/address/us-address";

type Props = {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  inputId?: string;
  /** Override the input styling so the field matches its host surface (the
   *  public form vs the dashboard record editor). Defaults to the form styling. */
  className?: string;
  /** The business address holds its state in a separate dropdown; pass it so
   *  the completion row does not ask for a state the merchant already gave. */
  fallbackState?: string;
  /** True once the form's validator has rejected this field — forces the
   *  completion row open so the merchant is shown HOW to fix it, not just told. */
  invalid?: boolean;
  /** Raised while a selected suggestion's full address (its ZIP) is still being
   *  fetched. The form must not validate or submit this field until it clears. */
  onResolvingChange?: (resolving: boolean) => void;
};

const BASE_INPUT =
  "w-full rounded-md border border-bg-border bg-bg-elev px-3 py-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors placeholder-fg-dim";
const SMALL_INPUT =
  "w-full rounded-md border border-bg-border bg-bg-elev px-2 py-1.5 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-accent/40 focus:border-accent transition-colors placeholder-fg-dim";

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;

export function AddressAutocompleteField({
  value,
  onChange,
  placeholder,
  inputId,
  className,
  fallbackState,
  invalid,
  onResolvingChange,
}: Props) {
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  // Sticky: once the merchant has been shown the completion row, it stays put.
  // Toggling it off the instant the gate passes would make it flicker away
  // mid-keystroke, which is worse than a row that simply stays available.
  const [completionOpen, setCompletionOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blurRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** Bumped on every selection so an older, still-in-flight Place Details
   *  lookup can neither paint a stale address nor release the form's hold. */
  const selectGen = useRef(0);

  const text = typeof value === "string" ? value : "";
  const gate = useMemo(
    () => (text.trim() ? isAcceptableCaptureAddress(text, fallbackState) : { ok: false, message: "" }),
    [text, fallbackState],
  );

  // Force the row open as soon as the form has rejected the field, so the
  // merchant is handed the boxes that fix it rather than only an error message.
  useEffect(() => {
    if (invalid) setCompletionOpen(true);
  }, [invalid]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (blurRef.current) clearTimeout(blurRef.current);
      abortRef.current?.abort();
      // Never strand the parent's "resolving" flag on unmount — a stuck flag
      // would disable Continue permanently. Fail OPEN on teardown.
      onResolvingChange?.(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        const data = (await res.json()) as { ok?: boolean; suggestions?: unknown };
        // A late resolve from a superseded request must not paint stale data.
        if (ac.signal.aborted) return;
        const next = data.ok ? normalizeAddressSuggestions(data.suggestions) : [];
        if (next.length > 0) {
          setSuggestions(next);
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

  /**
   * ANY MANUAL EDIT SUPERSEDES AN IN-FLIGHT SELECTION.
   *
   * A merchant who picks a Google suggestion and then corrects the address by
   * hand — in the main box OR in the City/State/ZIP completion row — still has
   * that Place Details lookup running. It considers itself current, lands a
   * moment later, and overwrites what they deliberately typed, which is then
   * what gets submitted. Bumping the generation makes the old lookup discard
   * itself, and releasing the hold stops the form waiting on an answer we have
   * already decided not to use.
   *
   * Every path that writes a value the merchant typed must go through here.
   * (Codex P1 ×2, 2026-09-10.)
   */
  const supersedePendingResolution = () => {
    selectGen.current++;
    onResolvingChange?.(false);
    // The superseded lookup's `finally` deliberately skips setLoading(false) —
    // it no longer owns the spinner. If nobody clears it here the field shows a
    // permanent "…" that never goes away, on a request whose answer we have
    // already discarded. (Codex P2, 2026-09-10.)
    setLoading(false);
  };

  const handleInput = (v: string) => {
    supersedePendingResolution();
    onChange(v);
    runSearch(v);
  };

  /** One Place Details attempt. Returns "" when it could not resolve. */
  const fetchResolved = async (placeId: string): Promise<string> => {
    const res = await fetch(`/api/forms/address-autocomplete?place_id=${encodeURIComponent(placeId)}`);
    const data = (await res.json()) as { ok?: boolean; address?: unknown };
    return data.ok && typeof data.address === "string" ? data.address.trim() : "";
  };

  const select = async (s: AddressSuggestion) => {
    /**
     * Every selection gets a generation. A merchant who picks one suggestion,
     * types again and picks another before the first Place Details call returns
     * has TWO lookups in flight for one field. Without this counter the first
     * to finish would call onResolvingChange(false) — telling the form the field
     * had settled while the other was still running — and either response could
     * then paint over the newer selection. Only the newest generation may paint
     * a value or release the form's hold. (Codex P1, 2026-09-10.)
     */
    const gen = ++selectGen.current;

    // Google autocomplete labels frequently omit postal codes. Paint the choice
    // immediately, then replace it with the complete Place Details address.
    onChange(s.value);
    setSuggestions([]);
    setOpen(false);
    setActiveIndex(-1);

    // A provider that returns no place_id (Photon) has already given us its
    // best string. If that string cannot pass the gate, open the completion row
    // rather than leaving the merchant to guess what is wrong.
    if (!s.placeId) {
      // This selection needs no resolution, so release any hold a superseded
      // lookup is still holding — otherwise Continue waits on a request whose
      // answer we have already decided to discard.
      onResolvingChange?.(false);
      if (!isAcceptableCaptureAddress(s.value, fallbackState).ok) setCompletionOpen(true);
      return;
    }

    setLoading(true);
    // Hold the form: the ZIP is genuinely in flight and validating now would
    // reject an address that is about to be correct.
    onResolvingChange?.(true);
    try {
      let resolved = "";
      try {
        resolved = await fetchResolved(s.placeId);
      } catch {
        resolved = "";
      }
      if (!resolved && gen === selectGen.current) {
        // One retry. The common failures here are a transient 429 from the
        // shared global rate-limit bucket and a cold-start timeout, both of
        // which clear immediately. Giving up on the first miss is what left
        // merchants holding a ZIP-less label. Skipped once superseded — there
        // is no point retrying a lookup whose answer we will discard.
        try {
          resolved = await fetchResolved(s.placeId);
        } catch {
          resolved = "";
        }
      }
      // Superseded by a newer selection: never paint, never touch the hold.
      if (gen !== selectGen.current) return;
      if (resolved) {
        onChange(resolved);
        if (!isAcceptableCaptureAddress(resolved, fallbackState).ok) setCompletionOpen(true);
      } else {
        // Keep the editable label and hand the merchant the boxes that finish
        // it. Never a dead end.
        setCompletionOpen(true);
      }
    } finally {
      // Only the newest selection owns the spinner and the form's hold.
      if (gen === selectGen.current) {
        setLoading(false);
        onResolvingChange?.(false);
      }
    }
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
        void select(suggestions[activeIndex]);
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
        value={text}
        onChange={(e) => handleInput(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (suggestions.length > 0) setOpen(true);
        }}
        onBlur={() => {
          // Delay close so a mousedown on a suggestion registers first.
          blurRef.current = setTimeout(() => setOpen(false), 150);
          // Offer the completion row only once they have finished typing and
          // the line still cannot pass — not on every keystroke of "1", "12".
          if (text.trim() && !isAcceptableCaptureAddress(text, fallbackState).ok) {
            setCompletionOpen(true);
          }
        }}
        placeholder={placeholder || "Start typing your address…"}
        className={className || BASE_INPUT}
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
            <li key={`${s.label}-${i}`} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                // onPointerDown (not onClick) so selection fires before the
                // input's blur close — and covers mouse + touch + pen, where a
                // plain onMouseDown misses taps on mobile. (review 2026-06-17.)
                onPointerDown={(e) => {
                  e.preventDefault();
                  void select(s);
                }}
                className={`block w-full px-3 py-2 text-left text-sm transition-colors ${
                  i === activeIndex
                    ? "bg-accent/15 text-fg"
                    : "text-fg-muted hover:bg-bg-hover hover:text-fg"
                }`}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {completionOpen && !gate.ok && (
        <AddressCompletion
          value={text}
          // Through the same supersession as the main input: a City/ZIP the
          // merchant types must not be overwritten by a Place Details response
          // for a suggestion they picked moments earlier.
          onChange={(v) => {
            supersedePendingResolution();
            onChange(v);
          }}
          fallbackState={fallbackState}
          inputId={inputId}
        />
      )}
    </div>
  );
}

/**
 * The escape hatch, and the only part of this feature that depends on nothing
 * external. Whatever the provider returned — a street with no building number,
 * an entry with no ZIP, or nothing at all — these boxes let the merchant finish
 * the address by hand.
 *
 * It edits the SAME single string the field already stores. Each box is seeded
 * from whatever `splitUsAddress` could already identify, and every edit
 * recomposes "line1, city, ST ZIP". Storing one string is load-bearing: the PDF
 * renderer, the lead record and the application upsert all read one address
 * value, and introducing per-part payload keys here would silently bypass all
 * three. (lib/address/us-address.ts is the single implementation of both the
 * split and the gate, so this row can never disagree with the server.)
 */
function AddressCompletion({
  value,
  onChange,
  fallbackState,
  inputId,
}: {
  value: string;
  onChange: (v: string) => void;
  fallbackState?: string;
  inputId?: string;
}) {
  // The business address takes its state from its own dropdown; asking twice
  // invites the merchant to enter two different states.
  const stateHandledElsewhere = /^[A-Za-z]{2}$/.test((fallbackState || "").trim());

  /**
   * THE DRAFT IS OWNED HERE, NOT RE-DERIVED FROM THE COMPOSED STRING.
   *
   * Deriving each box from `splitUsAddress(value)` on every render looks
   * tidier and is completely unusable, because the parser deliberately refuses
   * to guess: with no state and no ZIP to anchor it, a comma is more likely a
   * unit suffix ("123 Main St, Apt 4") than a city boundary, so the whole
   * string stays in line1. Typing the first letter of a city therefore composed
   * "7930 Snow View Drive, A", which parsed back with city:"" — and the letter
   * vanished from the box on the very next render. The ZIP box behaved the same
   * way until a fifth digit arrived. The escape hatch could not be typed into
   * at all. (Codex P1, 2026-09-10 — caught before this ever shipped.)
   *
   * So: seed once from whatever the parser CAN identify, then let the merchant
   * type freely and push the composition outward. `line1` stays anchored to the
   * address as it was when the row opened, so recomposing cannot eat it.
   */
  const seed = useMemo(() => splitUsAddress(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const baseLine1 = useRef(seed.line1 || value.trim());
  const [draft, setDraft] = useState({ city: seed.city, state: seed.state, zip: seed.zip });

  /**
   * Anchoring `line1` once is what makes the boxes typeable; anchoring it
   * FOREVER is a silent-corruption bug of its own. If the merchant goes back to
   * the main input and types a different street, or picks another suggestion,
   * a frozen `baseLine1` means their next City/ZIP keystroke recomposes the
   * address they just replaced — and submits it. Exactly the class of failure
   * this whole change exists to remove. (Codex P1, re-review 2026-09-10.)
   *
   * So: re-seed whenever `value` changes from OUTSIDE this row. `lastComposed`
   * distinguishes our own write (ignore — the draft is already right) from an
   * edit made anywhere else (re-anchor to it).
   */
  const lastComposed = useRef<string | null>(null);
  useEffect(() => {
    if (lastComposed.current === value) return;
    const s = splitUsAddress(value);
    baseLine1.current = s.line1 || value.trim();
    setDraft({ city: s.city, state: s.state, zip: s.zip });
  }, [value]);

  const patch = (next: Partial<{ city: string; state: string; zip: string }>) => {
    const merged = { ...draft, ...next };
    setDraft(merged);
    const composed = composeUsAddress({
      line1: baseLine1.current,
      city: merged.city,
      // For the business address the state lives in its own dropdown and the
      // picker here is hidden, so fold that value in — otherwise the composed
      // line carries no state and only the gate's own merge saves it.
      state: merged.state || (stateHandledElsewhere ? (fallbackState || "").trim().toUpperCase() : ""),
      zip: merged.zip,
    });
    lastComposed.current = composed;
    onChange(composed);
  };

  return (
    <div className="mt-2 rounded-md border border-bg-border bg-bg-elev/60 p-2.5 space-y-2">
      <p className="text-[11px] text-fg-muted">
        Finish the address below. We need the city, state and ZIP code so your
        application can be matched to a lender.
      </p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_auto_auto]">
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-fg-dim">City</span>
          <input
            id={inputId ? `${inputId}-city` : undefined}
            type="text"
            autoComplete="address-level2"
            value={draft.city}
            onChange={(e) => patch({ city: e.target.value })}
            placeholder="Algonquin"
            className={SMALL_INPUT}
          />
        </label>
        {!stateHandledElsewhere && (
          <label className="block">
            <span className="mb-1 block text-[10px] uppercase tracking-wide text-fg-dim">State</span>
            <select
              id={inputId ? `${inputId}-state` : undefined}
              value={draft.state}
              onChange={(e) => patch({ state: e.target.value })}
              className={SMALL_INPUT}
            >
              <option value="">--</option>
              {US_STATE_CODES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block">
          <span className="mb-1 block text-[10px] uppercase tracking-wide text-fg-dim">ZIP</span>
          <input
            id={inputId ? `${inputId}-zip` : undefined}
            type="text"
            inputMode="numeric"
            autoComplete="postal-code"
            value={draft.zip}
            // Digits and a single hyphen only, capped at ZIP+4 — a merchant
            // pasting "60102, USA" must not push junk into the stored line.
            onChange={(e) => patch({ zip: e.target.value.replace(/[^\d-]/g, "").slice(0, 10) })}
            placeholder="60102"
            className={SMALL_INPUT}
          />
        </label>
      </div>
    </div>
  );
}
