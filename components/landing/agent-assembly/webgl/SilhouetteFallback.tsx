"use client";

/**
 * SilhouetteFallback — the loading state for the WebGL figure chunk.
 *
 * V3 redesign (2026-06-07): the previous SVG humanoid outline flashed
 * as a literal "stick figure" during the dynamic-import window, which
 * read as a crude placeholder rather than as deliberate UI. Replaced
 * with an abstract "initializing core" indicator — a single pulsing
 * OASIS-green orb inside a triple-ring scanner, with a monospace
 * status line below. Communicates "system is booting" without
 * pre-committing to a humanoid silhouette.
 *
 * Pure SVG + CSS — no React state, no client JS, ~1KB.
 */
export function SilhouetteFallback() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "1.25rem",
      }}
    >
      <svg
        viewBox="0 0 240 240"
        xmlns="http://www.w3.org/2000/svg"
        style={{ width: "180px", maxWidth: "40%", height: "auto" }}
      >
        <defs>
          <radialGradient id="core-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#86efac" stopOpacity="0.95" />
            <stop offset="55%" stopColor="#86efac" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#86efac" stopOpacity="0" />
          </radialGradient>
          <linearGradient id="scan-stroke" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#86efac" stopOpacity="0.85" />
            <stop offset="100%" stopColor="#5eead4" stopOpacity="0.45" />
          </linearGradient>
        </defs>

        {/* Outer scanner ring — slow counter-rotation */}
        <g style={{ transformOrigin: "120px 120px", animation: "fb-spin-cw 8s linear infinite" }}>
          <circle
            cx="120" cy="120" r="98"
            fill="none" stroke="url(#scan-stroke)" strokeWidth="1.5"
            strokeDasharray="6 14" opacity="0.7"
          />
          <circle cx="120" cy="22" r="3.5" fill="#86efac" opacity="0.9" />
          <circle cx="120" cy="218" r="2.5" fill="#5eead4" opacity="0.7" />
        </g>

        {/* Mid scanner ring — dash pattern, opposite direction */}
        <g style={{ transformOrigin: "120px 120px", animation: "fb-spin-ccw 6s linear infinite" }}>
          <circle
            cx="120" cy="120" r="74"
            fill="none" stroke="#86efac" strokeOpacity="0.55" strokeWidth="1"
            strokeDasharray="2 8"
          />
          <line x1="120" y1="46" x2="120" y2="56" stroke="#86efac" strokeWidth="1.5" opacity="0.7" />
          <line x1="120" y1="184" x2="120" y2="194" stroke="#86efac" strokeWidth="1.5" opacity="0.7" />
          <line x1="46" y1="120" x2="56" y2="120" stroke="#86efac" strokeWidth="1.5" opacity="0.7" />
          <line x1="184" y1="120" x2="194" y2="120" stroke="#86efac" strokeWidth="1.5" opacity="0.7" />
        </g>

        {/* Inner ring — static, marks the core's reactor housing */}
        <circle
          cx="120" cy="120" r="48"
          fill="none" stroke="#86efac" strokeOpacity="0.35" strokeWidth="0.8"
        />

        {/* Glowing core — pulsing orb */}
        <circle cx="120" cy="120" r="40" fill="url(#core-glow)">
          <animate attributeName="r" values="36;44;36" dur="2.6s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.7;1;0.7" dur="2.6s" repeatCount="indefinite" />
        </circle>

        {/* Bright core nucleus */}
        <circle cx="120" cy="120" r="6" fill="#86efac">
          <animate attributeName="r" values="5;8;5" dur="1.8s" repeatCount="indefinite" />
        </circle>

        {/* Crosshair guides */}
        <line x1="120" y1="100" x2="120" y2="140" stroke="#86efac" strokeOpacity="0.18" strokeWidth="0.5" />
        <line x1="100" y1="120" x2="140" y2="120" stroke="#86efac" strokeOpacity="0.18" strokeWidth="0.5" />
      </svg>

      <div
        style={{
          fontFamily: "monospace",
          fontSize: "10px",
          letterSpacing: "0.32em",
          textTransform: "uppercase",
          color: "rgba(134, 239, 172, 0.78)",
        }}
      >
        Initializing Neural Core
      </div>

      {/* Keyframes — scoped via <style> so we don't pollute global CSS */}
      <style>{`
        @keyframes fb-spin-cw  { from { transform: rotate(0deg) }   to { transform: rotate(360deg) } }
        @keyframes fb-spin-ccw { from { transform: rotate(360deg) } to { transform: rotate(0deg) } }
      `}</style>
    </div>
  );
}
