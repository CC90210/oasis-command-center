/**
 * components/forms/HoneypotField.tsx - the honeypot box (lib/forms/honeypot.ts).
 *
 * Off-screen rather than display:none, because scripts that fill every box skip
 * display:none; out of the tab order and hidden from screen readers; a name
 * browser autofill does not know. Render it as the LAST child of the form, so
 * every field id above it keeps its value.
 */
import type { Ref } from "react";

export function HoneypotField({ inputRef }: { inputRef: Ref<HTMLInputElement> }) {
  return (
    <div
      aria-hidden="true"
      style={{ position: "absolute", left: "-10000px", top: "auto", width: "1px", height: "1px", overflow: "hidden" }}
    >
      <label>
        Leave this field empty
        <input ref={inputRef} type="text" name="hp_website" tabIndex={-1} autoComplete="off" />
      </label>
    </div>
  );
}
