import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

// OASIS AI Agent Command Center — premium dark theme with OASIS BLUE accent.
// Brand pivot 2026-04-30: gold #e8c547 -> OASIS blue #3b82f6 (with deeper
// #2563eb for muted variants). Status semantics unchanged.
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
          DEFAULT: "#06070a",
          // `deep` was referenced by ~85 components (dropdowns, menus, modals,
          // recessed inputs) but never defined — so `bg-bg-deep` resolved to no
          // background and every overlay rendered transparent (options bled
          // through). Defining it here fixes all of them at once. (Ezra 2026-06-24)
          deep: "#0a0c10",
          panel: "#0e1014",
          raised: "#15181e",
          elev: "#1c2028",
          border: "#22262e",
          hover: "#1a1d24",
        },
        fg: {
          DEFAULT: "#faf9f5",
          muted: "#9ca0a8",
          dim: "#5b6068",
          faint: "#3a3d44",
        },
        accent: {
          DEFAULT: "#3b82f6",        // OASIS blue
          muted: "#2563eb",          // deeper blue
          soft: "rgba(59, 130, 246, 0.12)",
          glow: "rgba(59, 130, 246, 0.35)",
        },
        status: {
          hot: "#ef4444",
          warm: "#f59e0b",
          engaged: "#10b981",
          info: "#60a5fa",
          cold: "#6b7280",
          dormant: "#4b5563",
          lost: "#1f2937",
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
        "fade-in": "fadeIn 0.4s ease-out",
        "slide-up": "slideUp 0.5s ease-out",
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
      boxShadow: {
        glow: "0 0 24px rgba(59, 130, 246, 0.22)",
        card: "0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.6)",
        elev: "0 8px 24px rgba(0, 0, 0, 0.5)",
        ironman: "0 0 0 1px rgba(59,130,246,0.25), 0 16px 40px -12px rgba(59,130,246,0.25)",
      },
    },
  },
  plugins: [typography],
};

export default config;
