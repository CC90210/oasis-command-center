"use client";

import { useCallback, useEffect, useState } from "react";
import { BODIES, ENGINES, PLATFORM } from "@/lib/marketing/harness";
import { HOTSPOTS } from "@/lib/marketing/hotspots";
import { CarStage } from "@/components/marketing/CarStage";

type Pin = { id: string; x: number; y: number; visible: boolean };

/**
 * The car analogy, made touchable.
 *
 * Pick a BODY (the agent) and an ENGINE (the model) and watch the same car
 * carry both. The teaching point is the part that never changes: the
 * chassis underneath is the harness we build, and it is the only reason
 * swapping either of the other two is a menu choice rather than a rebuild.
 *
 * Deliberately a 2D technical cutaway rather than a 3D model. A real 3D
 * car means a WebGL runtime and an asset pipeline for a decorative object;
 * a blueprint reads as engineering, matches the rest of the site, weighs
 * nothing, and — unlike a mediocre 3D model — cannot look cheap.
 *
 * The shell is one SVG path per body on a shared viewBox with the
 * wheelbase aligned, so switching morphs the outline in place rather than
 * cutting to a different picture.
 *
 * Server-rendered with the first body and engine already selected, so the
 * section is a complete, readable explanation with no JavaScript at all.
 */

export function HarnessBuilder() {
  const [bodyId, setBodyId] = useState(BODIES[0].id);
  const [engineId, setEngineId] = useState(ENGINES[0].id);
  // Flips once WebGL has painted a frame, retiring the SVG fallback.
  const [stageReady, setStageReady] = useState(false);
  // Screen positions of the spatial callouts, pushed up from the render
  // loop every frame.
  const [pins, setPins] = useState<Pin[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  const activeSpot = HOTSPOTS.find((h) => h.id === focus) ?? null;

  // setPins is called on every animation frame, so it must be referentially
  // stable — an inline arrow would hand CarStage a new function 60x/sec.
  const handlePins = useCallback((next: Pin[]) => setPins(next), []);

  // Escape closes the callout. Without it a keyboard user who opened a card
  // can move focus off it but has no way to dismiss it.
  useEffect(() => {
    if (!focus) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFocus(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focus]);

  const body = BODIES.find((b) => b.id === bodyId) ?? BODIES[0];
  const engine = ENGINES.find((e) => e.id === engineId) ?? ENGINES[0];

  return (
    <div className="border border-ops-line bg-ops-panel/60">
      {/* ── The car ─────────────────────────────────────────────────── */}
      <div className="relative border-b border-ops-line px-4 pt-8 sm:px-8">
        {/*
          Two layers. The SVG blueprint below is what renders on the server,
          without JavaScript, and on a machine with no WebGL, a complete,
          labelled diagram in its own right. The 3D stage mounts on top of
          it once three.js has loaded, so there is never an empty box and
          never a spinner.
        */}
        {/* Taller on phones. At 16/9 the stage came out 316x178 on a 390px
            screen, which is a letterbox rather than a showpiece. Portrait
            devices have height to spare and width they do not. */}
        <div className="relative mx-auto aspect-[5/4] w-full max-w-3xl sm:aspect-[16/9] lg:aspect-[2/1]">
          <svg
            viewBox="0 0 420 150"
            className={`absolute inset-0 h-full w-full transition-opacity duration-700 ${
              stageReady ? "opacity-0" : "opacity-70"
            }`}
            role="img"
            aria-label={`The ${body.name} harness running the ${engine.name} engine on the OASIS platform`}
          >
          {/* Ground line */}
          <line
            x1="10"
            y1="139"
            x2="410"
            y2="139"
            stroke="currentColor"
            className="text-ops-edge"
            strokeWidth="1"
          />

          {/* Chassis rail, the constant. Drawn under the shell and in the
              brand cyan, because it is the thing being sold. */}
          <path
            d="M 56 122 L 380 122"
            stroke="#00D4FF"
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.9"
          />
          <path
            d="M 76 122 L 76 112 M 200 122 L 200 108 M 330 122 L 330 112"
            stroke="#00D4FF"
            strokeWidth="1.5"
            opacity="0.45"
          />

          {/* Body shell */}
          <path
            d={body.path}
            fill="none"
            stroke="currentColor"
            className="m-car-shell text-fg"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeDasharray={body.blueprint ? "7 6" : undefined}
            opacity={body.blueprint ? 0.65 : 1}
          />

          {/* Glasshouse, so the shell reads as a vehicle rather than a blob */}
          <path
            d="M 132 56 L 150 34 L 244 34 L 262 56 Z"
            fill="#00D4FF"
            opacity="0.07"
            className="m-car-shell"
          />

          {/* Engine bay, front right */}
          <g className="m-car-engine">
            <rect
              x="306"
              y="82"
              width="66"
              height="34"
              rx="4"
              fill={engine.glow}
              opacity="0.16"
            />
            <rect
              x="306"
              y="82"
              width="66"
              height="34"
              rx="4"
              fill="none"
              stroke={engine.glow}
              strokeWidth="1.5"
            />
            {/* Four cylinders. A readable "engine" at a glance. */}
            {[0, 1, 2, 3].map((i) => (
              <rect
                key={i}
                x={314 + i * 15}
                y={90}
                width="8"
                height="18"
                rx="1.5"
                fill={engine.glow}
                opacity="0.85"
              />
            ))}
          </g>

          {/* Wheels */}
          {[110, 322].map((cx) => (
            <g key={cx}>
              <circle
                cx={cx}
                cy="122"
                r="17"
                fill="#050608"
                stroke="currentColor"
                className="text-ops-edge"
                strokeWidth="2"
              />
              <circle cx={cx} cy="122" r="6" fill="#00D4FF" opacity="0.55" />
            </g>
            ))}
          </svg>

          <CarStage
            bodyId={body.id}
            engineId={engine.id}
            engineColor={engine.glow}
            onReady={() => setStageReady(true)}
            onHotspots={handlePins}
            focus={focus}
          />

          {/* Spatial callouts. Positioned from the projected 3D anchors, so
              each pin rides its part of the car as the body turns. Hidden
              until WebGL has painted — over the SVG fallback they would sit
              at coordinates that mean nothing. */}
          {stageReady &&
            pins.map((p) => {
              const spot = HOTSPOTS.find((h) => h.id === p.id);
              if (!spot || !p.visible) return null;
              const open = focus === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setFocus(open ? null : p.id)}
                  onMouseEnter={() => setFocus(p.id)}
                  aria-expanded={open}
                  aria-label={`${spot.kicker}: ${spot.title}`}
                  className="group absolute z-20 -translate-x-1/2 -translate-y-1/2 focus-visible:outline-none"
                  style={{ left: p.x, top: p.y }}
                >
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-full border font-data text-[10px] tabular-nums backdrop-blur-sm transition-all duration-200 group-focus-visible:ring-2 group-focus-visible:ring-signal ${
                      open
                        ? "border-signal bg-signal/25 text-fg"
                        : "border-signal/50 bg-ops-void/60 text-signal group-hover:border-signal group-hover:bg-signal/20"
                    }`}
                  >
                    {spot.pin}
                  </span>
                  {!open && (
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-0 animate-ping rounded-full border border-signal/40 [animation-duration:2.6s] motion-reduce:hidden"
                    />
                  )}
                </button>
              );
            })}

          {/* Detail card. One at a time; anchored to the panel rather than
              to the pin so it never runs off the edge of the viewport on a
              phone. */}
          {stageReady && activeSpot && (
            <div className="pointer-events-none absolute inset-x-3 bottom-3 z-30 sm:inset-x-auto sm:left-4 sm:max-w-xs">
              <div className="pointer-events-auto border border-signal/25 bg-ops-void/80 p-5 shadow-[0_8px_40px_-12px_rgba(0,0,0,0.9)] backdrop-blur-md">
                <div className="flex items-start justify-between gap-4">
                  <span className="font-data text-[10px] uppercase tracking-[0.22em] text-signal">
                    {activeSpot.kicker}
                  </span>
                  <button
                    type="button"
                    onClick={() => setFocus(null)}
                    className="-m-1 p-1 font-data text-[11px] text-fg-faint transition-colors hover:text-fg"
                    aria-label="Close callout"
                  >
                    ESC
                  </button>
                </div>
                <h4 className="mt-2 font-display text-[15px] font-bold tracking-tight text-fg">
                  {activeSpot.title}
                </h4>
                <p className="mt-2 text-[13.5px] leading-relaxed text-fg-dim">
                  {activeSpot.body}
                </p>
                <ul className="mt-3 space-y-1.5">
                  {activeSpot.points.map((pt) => (
                    <li
                      key={pt}
                      className="flex items-baseline gap-2 text-[12.5px] text-fg-muted"
                    >
                      <span
                        aria-hidden="true"
                        className="h-px w-2.5 shrink-0 translate-y-[-4px] bg-signal"
                      />
                      {pt}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>

        {/* Callouts */}
        <div className="mx-auto mb-6 mt-2 flex max-w-2xl flex-wrap justify-center gap-x-6 gap-y-3 text-center sm:gap-x-8">
          <Callout label="Harness" value={body.name} tone="fg" />
          <Callout label="Engine" value={`${engine.name} · ${engine.vendor}`} tone="engine" color={engine.glow} />
          <Callout label="Platform" value="OASIS" tone="signal" />
        </div>

        {/* Names the change as well as showing it, so nobody has to squint
            to work out what just happened in the bay. */}
        <p className="mb-6 text-center font-data text-[11px] uppercase tracking-[0.2em] text-fg-dim">
          {engine.spec}
          <span className="mx-2 text-fg-faint">/</span>
          Drag the car to turn it
        </p>
      </div>

      {/* ── Selectors ───────────────────────────────────────────────── */}
      <div className="grid gap-px bg-ops-line md:grid-cols-2">
        <Picker
          legend="Harness, the agent"
          hint="Bravo, Atlas, Maven, or one built for you. The bodywork."
          options={BODIES.map((b) => ({ id: b.id, label: b.name, sub: b.seat }))}
          value={bodyId}
          onChange={setBodyId}
          detail={body.brief}
        />
        <Picker
          legend="Engine, the model"
          hint="Swappable. Today's best model is not next quarter's."
          options={ENGINES.map((e) => ({ id: e.id, label: e.name, sub: e.vendor }))}
          value={engineId}
          onChange={setEngineId}
          detail={engine.trait}
          accent={engine.glow}
        />
      </div>

      {/* ── The constant ────────────────────────────────────────────── */}
      <div className="border-t border-ops-line bg-ops-void/60 p-6 sm:p-8">
        <h3 className="font-display text-base font-bold tracking-tight text-fg">
          The platform. What doesn&rsquo;t change when you swap either one
        </h3>
        <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2.5">
          {PLATFORM.map((c) => (
            <li key={c} className="flex items-baseline gap-2 text-[14px] text-fg-muted">
              <span aria-hidden="true" className="h-px w-3 shrink-0 translate-y-[-4px] bg-signal" />
              {c}
            </li>
          ))}
        </ul>
        <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-fg-dim">
          Buy a chatbot and you have bought an engine bolted to the road. The
          platform is the part that takes months, and it is the part that means
          a better model next year is a swap rather than a rebuild.
        </p>
      </div>
    </div>
  );
}

function Callout({
  label,
  value,
  tone,
  color,
}: {
  label: string;
  value: string;
  tone: "fg" | "signal" | "engine";
  color?: string;
}) {
  return (
    <div>
      <div className="font-data text-[10px] uppercase tracking-[0.22em] text-fg-dim">
        {label}
      </div>
      <div
        className={`mt-1 text-[15px] font-semibold ${
          tone === "signal" ? "text-signal" : tone === "fg" ? "text-fg" : ""
        }`}
        style={tone === "engine" ? { color } : undefined}
      >
        {value}
      </div>
    </div>
  );
}

function Picker({
  legend,
  hint,
  options,
  value,
  onChange,
  detail,
  accent,
}: {
  legend: string;
  hint: string;
  options: { id: string; label: string; sub: string }[];
  value: string;
  onChange: (id: string) => void;
  detail: string;
  accent?: string;
}) {
  const groupId = `harness-${legend.replace(/[^a-z]/gi, "").toLowerCase()}`;
  return (
    // A <legend> is positioned ON the fieldset's top border by the UA, which
    // is why the label was sitting across the panel edge. Since the panel
    // draws its own border via the grid gap, the semantics are kept with
    // role="group" + aria-labelledby and the label becomes normal flow.
    <div role="group" aria-labelledby={groupId} className="bg-ops-void p-6 pt-7 sm:p-7 sm:pt-8">
      <p
        id={groupId}
        className="font-data text-[10px] uppercase tracking-[0.22em] text-signal"
      >
        {legend}
      </p>
      <p className="mt-2.5 text-[13px] text-fg-dim">{hint}</p>

      <div className="mt-5 flex flex-wrap gap-2">
        {options.map((o) => {
          const active = o.id === value;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onChange(o.id)}
              aria-pressed={active}
              className={`rounded-md border px-3.5 py-2 text-left transition-colors ${
                active
                  ? "border-transparent bg-ops-raised text-fg"
                  : "border-ops-edge text-fg-muted hover:border-fg-faint hover:text-fg"
              }`}
              style={active && accent ? { boxShadow: `inset 0 0 0 1px ${accent}` } : undefined}
            >
              <span className="block text-[14px] font-semibold">{o.label}</span>
              <span className="mt-0.5 block text-[12px] text-fg-dim">{o.sub}</span>
            </button>
          );
        })}
      </div>

      {/* Fixed height so switching options never resizes the panel and
          nudges the car above it. */}
      <p className="mt-5 min-h-[4.5rem] text-[14px] leading-relaxed text-fg-muted">
        {detail}
      </p>
    </div>
  );
}
