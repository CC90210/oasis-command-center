import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

// OASIS OS — dark, neutral, Cook-style canvas. OASIS blue is the accent and is
// reserved for primary actions, focus and links.
//
// EVERY DASHBOARD COLOUR IS A CSS VARIABLE (2026-09-28). Values live in
// app/globals.css :root as space-separated RGB channels, and each token here is
// `rgb(var(--c-x) / <alpha-value>)`, so opacity modifiers (`bg-bg-elev/40`,
// `border-accent/30`) keep working on every class that used them.
//
// NEVER RENAME A TOKEN. ~300 files use these class names, and the public light
// form (`.form-light` in globals.css) remaps them BY NAME — a rename silently
// drops a prospect-facing form back to the dark palette. Re-value in
// globals.css; tests/theme-tokens.test.ts holds both halves of that contract.
//
// `ops` and `signal` below are the public marketing site's own scales and are
// deliberately literal: a dashboard re-theme must never restyle the site.
const v = (name: string) => `rgb(var(--c-${name}) / <alpha-value>)`;

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./content/**/*.{md,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          // The floating content canvas.
          DEFAULT: v("bg"),
          // `deep` was referenced by ~85 components (dropdowns, menus, modals,
          // recessed inputs) but never defined — so `bg-bg-deep` resolved to no
          // background and every overlay rendered transparent (options bled
          // through). Defining it here fixes all of them at once. (Ezra 2026-06-24)
          deep: v("bg-deep"),
          panel: v("bg-panel"),
          raised: v("bg-raised"),
          elev: v("bg-elev"),
          border: v("bg-border"),
          // One step up from `border`, for hover and focus separation. Defined
          // before use per design constitution rule 26: a class that resolves to
          // nothing fails silently, which is how `bg-bg-deep` once rendered ~85
          // overlays transparent (see the note above).
          "border-strong": v("bg-border-strong"),
          hover: v("bg-hover"),
          // The window ground the rail sits on (pure black, as in Cook).
          rail: v("bg-rail"),
        },
        fg: {
          DEFAULT: v("fg"),
          muted: v("fg-muted"),
          dim: v("fg-dim"),
          // Decorative only (rules, disabled glyphs). Below AA as text.
          faint: v("fg-faint"),
        },
        accent: {
          DEFAULT: v("accent"),        // OASIS blue
          muted: v("accent-muted"),    // deeper blue
          // Fixed alphas, as before: these two were never modifier targets.
          soft: "rgb(var(--c-accent) / 0.12)",
          glow: "rgb(var(--c-accent) / 0.35)",
        },
        status: {
          hot: v("status-hot"),
          warm: v("status-warm"),
          engaged: v("status-engaged"),
          info: v("status-info"),
          cold: v("status-cold"),
          dormant: v("status-dormant"),
          lost: v("status-lost"),
        },
        // Unread / needs-you counters: Cook's red pills. Darker than
        // status.hot so white 11px text on it clears WCAG AA (4.5:1);
        // status.hot is a text colour on dark and stays as it is.
        unread: v("unread"),
        // Every OS divider and border: white at 7%, so it reads the same on
        // the rail, the canvas and a panel. Alpha is baked into the variable,
        // so this token takes no opacity modifier.
        hairline: "rgb(var(--c-hairline))",
        // Neutral selected row (no blue fill), and the quieter hover under it.
        active: {
          DEFAULT: "rgb(var(--c-active))",
          hover: "rgb(var(--c-active-hover))",
        },

        // ── Public marketing site only (app/(marketing)/**) ──────────────
        // Deliberately a separate namespace from the dashboard's `bg`/
        // `accent` scales. The dashboard is a tool used for hours at a
        // time and is tuned for legibility at density; the marketing site
        // is a first impression and runs darker and higher-contrast. Two
        // scales means neither has to compromise for the other, and a
        // marketing restyle can never regress operator UI.
        ops: {
          void: "#050608",   // page
          panel: "#0b0d11",  // recessed blocks
          raised: "#12151b", // cards, roster rows
          line: "#1a1e26",   // hairline rules + grid
          edge: "#272c36",   // hover borders
        },
        // The OASIS logo cyan. Distinct from dashboard blue #3b82f6 on
        // purpose. Used sparingly — active roster row, primary CTA,
        // section rules. Roster STATE uses the existing `status.*` scale
        // above; signal is identity, not semantics.
        signal: {
          DEFAULT: "#00D4FF",
          dim: "#0891b2",
          glow: "rgba(0, 212, 255, 0.30)",
          wash: "rgba(0, 212, 255, 0.06)",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "Inter",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "JetBrains Mono",
          "Consolas",
          "monospace",
        ],
        serif: ["Iowan Old Style", "Palatino Linotype", "Georgia", "serif"],
        // Marketing faces. The CSS vars are defined by next/font in
        // app/(marketing)/layout.tsx and only exist inside that subtree,
        // so these utilities are inert on dashboard routes — the
        // dashboard keeps its system-font stack and its zero-webfont
        // first paint.
        display: ["var(--font-display)", "Space Grotesk", "system-ui", "sans-serif"],
        body: ["var(--font-body)", "Inter Tight", "system-ui", "sans-serif"],
        data: ["var(--font-data)", "JetBrains Mono", "ui-monospace", "monospace"],
      },
      animation: {
        "pulse-slow": "pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite",
        // One-shot entrances, inside the 120-160ms motion budget.
        "fade-in": "fadeIn 0.16s ease-out",
        "slide-up": "slideUp 0.16s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      // Elevation only. Oasis design constitution rules 14 and 15: a border
      // separates things on the same plane, a shadow lifts something above it.
      // Light has a direction, so every shadow here carries a y-offset; a
      // shadow with 0 0 offsets is a glow, and a coloured glow is the single
      // most recognisable "AI-generated UI" tell. Tinted neutral to match the
      // OS palette, which has no blue cast.
      boxShadow: {
        // Active-state emphasis. Tight and directional, not a bloom. Was
        // accent-tinted; a coloured shadow is the glow rule 14 forbids, so it
        // is now the same neutral as every other shadow. Name kept: ~10
        // components use `shadow-glow`.
        glow: "0 1px 3px rgba(0, 0, 0, 0.45)",
        card: "0 1px 2px rgba(0, 0, 0, 0.50), 0 2px 6px rgba(0, 0, 0, 0.35)",
        elev: "0 4px 10px rgba(0, 0, 0, 0.45), 0 16px 32px rgba(0, 0, 0, 0.38)",
        // Replaces `ironman`, a 40px saturated-blue halo wired into Card and
        // Stat and therefore visible on nearly every screen of the dashboard.
        raised: "0 2px 4px rgba(0, 0, 0, 0.45), 0 8px 24px rgba(0, 0, 0, 0.35)",
      },
    },
  },
  plugins: [typography],
};

export default config;
