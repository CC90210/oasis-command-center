"use client";

/**
 * SilhouetteFallback — pure SVG outline of the assembled humanoid, used
 * during the dynamic-import chunk load (and as the SSR placeholder so the
 * client hydrates without a layout shift). ~2KB inline, never blocks LCP.
 * Coordinate space matches the WebGL camera framing: the silhouette occupies
 * roughly the same screen-space rectangle the live R3F figure will fill.
 */
export function SilhouetteFallback({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={className}
      style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
    >
      <svg
        viewBox="0 0 540 1435"
        xmlns="http://www.w3.org/2000/svg"
        style={{ height: "100%", width: "100%", maxWidth: "100%", maxHeight: "100%" }}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <linearGradient id="silhouette-grad" x1="50%" y1="0%" x2="50%" y2="100%">
            <stop offset="0%" stopColor="#86efac" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#5eead4" stopOpacity="0.18" />
          </linearGradient>
        </defs>
        {/* Humanoid outline approximating the final-pose silhouette */}
        <g fill="none" stroke="url(#silhouette-grad)" strokeWidth="3" strokeLinejoin="round">
          {/* Head */}
          <ellipse cx="270" cy="170" rx="78" ry="92" />
          {/* Neck */}
          <path d="M 240 250 L 240 295 L 300 295 L 300 250" />
          {/* Torso */}
          <path d="M 170 310 Q 170 290 200 290 L 340 290 Q 370 290 370 310 L 360 720 Q 360 740 340 740 L 200 740 Q 180 740 180 720 Z" />
          {/* Pelvis */}
          <path d="M 195 745 L 345 745 L 350 880 L 190 880 Z" />
          {/* Arms */}
          <path d="M 170 310 L 130 350 L 110 700 L 95 870" />
          <path d="M 370 310 L 410 350 L 430 700 L 445 870" />
          {/* Legs */}
          <path d="M 220 880 L 215 1280 L 245 1370" />
          <path d="M 320 880 L 325 1280 L 295 1370" />
          {/* Podium */}
          <ellipse cx="270" cy="1395" rx="150" ry="22" />
        </g>
        {/* Chest core indicator */}
        <circle cx="270" cy="540" r="14" fill="#86efac" opacity="0.55">
          <animate attributeName="opacity" values="0.35;0.75;0.35" dur="3s" repeatCount="indefinite" />
        </circle>
      </svg>
    </div>
  );
}
