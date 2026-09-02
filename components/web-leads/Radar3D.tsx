"use client";

/**
 * Radar3D — the seven-dimension radar as a REAL 3D hologram (WebGL, three.js).
 *
 * ═══ WHY WEBGL NOW, WHEN THE CARD ONCE REJECTED CHART LIBRARIES ═════════════
 *
 * The card's original docblock rejected recharts (and, by extension, WebGL)
 * on a ~90KB weight test. Adon overrode that for this one chart, twice, in
 * plain words (2026-09-01): "I'm saying 3D imaging... you need to take a big
 * leap." The operator mandate wins; what survives of the old rule is the
 * COST DISCIPLINE around it:
 *
 *   - three.js is loaded with a dynamic `import("three")` INSIDE an effect,
 *     so it is code-split and fetched only when this component actually
 *     mounts: desktop, WebGL available, reduced-motion off. A rep on a phone
 *     or with motion disabled never downloads a byte of it.
 *   - The 2D SVG hologram in BattleCard.tsx remains fully intact and is the
 *     AUTOMATIC fallback (and the accessible carrier -- this canvas is
 *     aria-hidden; the caller renders an sr-only summary and the dimension
 *     list stays the keyboard path). If WebGL init or the import fails, the
 *     card looks exactly like round 3, never blank.
 *
 * ═══ WHAT IT DRAWS (round 5: detail; round 7: interaction) ══════════════════
 *
 * A circular holo-platform (polar grid ringed by a tick dial), seven ENERGY
 * BEAMS rising from it -- bright core, holographic sheath (hand-rolled
 * fresnel + scanline shader), a lit ring at the foot; height = the score,
 * colour = the fixed identity hue from battle-hud.ts -- a fresnel-shaded
 * cyan score surface tented over the beam tops, the benchmark competitor as
 * a GOLD dashed wireframe with vertex markers, a slow radar sweep, and a
 * particle drift. Bloom (UnrealBloomPass) when the postprocessing modules
 * load; direct render when they do not. Projected DOM labels ride the beam
 * tops. Round 7, grounded in the FUI research (Jayse Hansen's HUD rules:
 * amplify the operator, never distract; ground the fantasy in real
 * instrumentation) and the standard three.js interaction vocabulary (damped
 * inertia for weight, eased camera flights for focus):
 *
 *   - BOOT ASSEMBLY: the hologram builds itself once on mount -- platform
 *     fades up, beams rise staggered to their measured heights, surface and
 *     benchmark resolve last, labels arrive with them. ~1.4s, plays once,
 *     never replays (the draw-once discipline every chart here follows).
 *   - TAP TO FOCUS: tapping a beam (or its label, or a row in the list, or
 *     a designation-plate chip) FLIES the stage to it -- the world turns the
 *     shortest way to face that beam, the camera eases in, and a targeting
 *     reticle in the dimension's own hue assembles at its foot. Double-click
 *     resets to the home orbit. Hover only brightens; selection is a tap,
 *     so casual pointer travel never yanks the camera around.
 *   - INERTIA: a released drag keeps spinning and decays to rest -- the
 *     stage has weight. Idle drift resumes once the spin settles.
 *
 * ═══ THE RULES ══════════════════════════════════════════════════════════════
 *
 * 1. Colour is identity, never verdict (battle-hud.ts). Beam HEIGHT is the
 *    score -- the same length encoding every Meter uses; hue never varies
 *    with the value. The reticle wears the selected dimension's identity
 *    hue, chosen by the rep's tap, never by the number.
 * 2. This component simply does not mount under prefers-reduced-motion; the
 *    caller gates it. No "paused 3D" middle state to get wrong. The boot
 *    sequence therefore never needs a reduced variant: reduced-motion users
 *    get the SVG stack, already settled.
 * 3. No text in the GL scene. The projected labels are DOM, aria-hidden,
 *    and a pointer convenience; the accessible dimension list beside the
 *    chart is still the legend and the keyboard path.
 * 4. Everything disposed on unmount: geometries, materials (shader materials
 *    included), textures, composer targets and passes, renderer. A rep pages
 *    through many leads in a shift; leaking a GL context per lead kills the
 *    tab by lunch.
 * 5. Ambient motion (sweep, dial, idle drift, particles, sheath scanlines)
 *    lives ONLY on decorative layers. The beam CORES, the score surface and
 *    the benchmark wireframe encode measurements: they move rigidly with the
 *    stage -- or with the boot, once -- never by themselves.
 */

import { useEffect, useRef } from "react";
import type * as THREE_NS from "three";
import { hueFor, GOLD, CYAN } from "./battle-hud";
import { sfx } from "./battle-sfx";
import type { DimensionProfile } from "@/lib/web-leads/audit";

type Props = {
  dimensions: DimensionProfile[];
  leader: { key: string; leader: number }[] | null;
  selected: string | null;
  onSelect: (key: string) => void;
  /** Reports whether the 3D path is live, so the caller can keep or drop the
   *  SVG fallback. Called at most once per mount with `true`, and with
   *  `false` on any init failure. */
  onStatus: (ok: boolean) => void;
  className?: string;
};

const PLATFORM_R = 3;
const PILLAR_MAX_H = 2.4;
/** Pointer travel (px) below which a press-and-release is a TAP (select +
 *  focus) rather than a drag. */
const TAP_SLOP = 6;

/** The shortest way around: the equivalent of `to` nearest `from`, so a
 *  focus flight never takes the long way past five other beams. */
const nearestTurn = (from: number, to: number): number => {
  const TAU = Math.PI * 2;
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return from + d;
};

const phase = (t: number, a: number, b: number) => Math.min(1, Math.max(0, (t - a) / (b - a)));
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);
/** Frame-rate-normalized damping: the per-frame blend that equals `k` at
 *  60fps. A bare `x += (t - x) * k` runs twice as fast on a 120Hz display
 *  and half as fast under load -- a focus flight should take the same
 *  fraction of a second on every machine a rep owns. */
const damp = (k: number, dt: number) => 1 - Math.pow(1 - k, dt * 60);

/** The holographic sheath: fresnel rim (bright where the surface grazes the
 *  view) times a slow upward scanline crawl. Hand-rolled, ~20 lines of GLSL,
 *  after the pattern the vanilla-holographic-material library popularised --
 *  a dependency would ship colour opinions into a surface whose palette is
 *  doctrine. */
const SHEATH_VERT = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    vY = position.y;
    gl_Position = projectionMatrix * mv;
  }
`;
const SHEATH_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.0);
    float scan = 0.72 + 0.28 * sin(vY * 34.0 - uTime * 2.6);
    gl_FragColor = vec4(uColor, uOpacity * (0.2 + 0.8 * fres) * scan);
  }
`;
/** The score surface's shader: fresnel only, NO time term -- the surface is
 *  a measurement, and its shading may respond to the rep's own viewpoint but
 *  never animate by itself (rule 5). */
const SURFACE_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vY;
  void main() {
    float fres = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 1.6);
    gl_FragColor = vec4(uColor, uOpacity * (0.35 + 0.65 * fres));
  }
`;

export function Radar3D({ dimensions, leader, selected, onSelect, onStatus, className = "" }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  // The scene reads `selected` every frame from a ref so selection changes
  // never rebuild the scene.
  const selectedRef = useRef<string | null>(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    let cleanup: (() => void) | null = null;
    // Held at EFFECT scope and released in the outer teardown, which runs on
    // every unmount path -- including an unmount mid-way through the async
    // init, where `cleanup` is still null and the in-flight branch just
    // returns. A disarm living only inside `cleanup` misses exactly that
    // path and re-creates the stuck-silent state it exists to fix. (Codex
    // review P2 follow-up, 2026-09-01.)
    let disarmSfx: () => void = () => {};
    // The selection AS OF MOUNT, captured synchronously BEFORE the async
    // init. The change detector diffs against this, so a selection made
    // while the scene was still loading (rep clicks the list during the
    // first second) is seen as a change on the first frame and gets its
    // flight -- while the mount-default selection (always non-null: the
    // caller resolves it to the worst area) does not, because the boot
    // should show the whole stage. (Codex review P2, 2026-09-01 -- their
    // suggested init-from-current would fly the camera on EVERY mount;
    // this captures the intent without that.)
    const mountSel = selectedRef.current;

    (async () => {
      // WebGL probe before the heavy import: a machine that cannot run the
      // scene should not download the library that draws it.
      const probe = document.createElement("canvas");
      const gl = probe.getContext("webgl2") || probe.getContext("webgl");
      if (!gl) { statusRef.current(false); return; }

      let THREE: typeof THREE_NS;
      try {
        THREE = await import("three");
      } catch {
        statusRef.current(false);
        return;
      }
      if (dead || !hostRef.current) return;

      const n = dimensions.length;
      if (n < 3) { statusRef.current(false); return; }

      // ── renderer / scene / camera ────────────────────────────────────
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setClearColor(0x000000, 0);
      host.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";
      renderer.domElement.style.cursor = "grab";
      renderer.domElement.setAttribute("aria-hidden", "true");
      // If the rep already opted into sound on a previous card, the context
      // still may not exist until a gesture: arm the one-time unlock. The
      // disarm is released by the OUTER teardown -- an armed flag left
      // behind by an unmounted stage would mute every later one. (Codex
      // review P2, 2026-09-01.)
      disarmSfx = sfx.armUnlock(host);

      // A GPU reset or context-pressure event after a successful init would
      // otherwise leave a frozen-blank canvas over a hidden fallback: report
      // failure so the caller flips back to the SVG. preventDefault stops the
      // browser's own restore dance -- we are not restoring, we are falling
      // back. (Codex review, 2026-09-01.)
      const onContextLost = (e: Event) => {
        e.preventDefault();
        statusRef.current(false);
      };
      renderer.domElement.addEventListener("webglcontextlost", onContextLost);

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
      const HOME_POS = new THREE.Vector3(0, 4.6, 8.2);
      const HOME_LOOK = new THREE.Vector3(0, 0.7, 0);
      const FOCUS_POS = new THREE.Vector3(0, 3.3, 6.7);
      camera.position.copy(HOME_POS);
      camera.lookAt(HOME_LOOK);

      const world = new THREE.Group();
      scene.add(world);

      const disposables: { dispose: () => void }[] = [];
      const track = <T extends { dispose: () => void }>(x: T): T => { disposables.push(x); return x; };

      // ── REAL BLOOM, when the modules arrive ──────────────────────────
      // UnrealBloomPass cannot composite onto a transparent canvas, so the
      // bloomed path renders on opaque BLACK and lets CSS do the composite:
      // `mix-blend-mode: screen` adds light to the panel and adds nothing
      // for black -- which is precisely what a hologram projector does. If
      // any of the three imports fails, `composer` stays null and the scene
      // renders direct and transparent, exactly as round 4 shipped. Failure
      // here degrades the treatment, never the chart.
      let composer: { render: () => void; setSize: (w: number, h: number) => void; dispose?: () => void } | null = null;
      // composer.dispose() releases only the composer's own render targets
      // and copy pass, NOT the passes added to it -- and UnrealBloomPass owns
      // a pyramid of blur targets and materials of its own. Each pass that
      // can dispose is collected here and torn down in cleanup, or paging
      // through leads accumulates GPU memory until the tab dies. (Codex
      // review, 2026-09-01.)
      const passDisposers: (() => void)[] = [];
      try {
        const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
          import("three/examples/jsm/postprocessing/EffectComposer.js"),
          import("three/examples/jsm/postprocessing/RenderPass.js"),
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        ]);
        if (dead) { renderer.dispose(); return; }
        const comp = new EffectComposer(renderer);
        const renderPass = new RenderPass(scene, camera);
        comp.addPass(renderPass);
        // Strength stays restrained: bloom is the glow the additive sprites
        // were faking, not a light show. Threshold keeps the dim grid crisp.
        const bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.55, 0.16);
        comp.addPass(bloomPass);
        for (const pass of [renderPass, bloomPass]) {
          const d = (pass as { dispose?: () => void }).dispose;
          if (typeof d === "function") passDisposers.push(() => d.call(pass));
        }
        renderer.setClearColor(0x000000, 1);
        renderer.domElement.style.mixBlendMode = "screen";
        composer = comp;
      } catch {
        composer = null;
      }

      // Materials whose opacity the boot sequence scales in: kept with their
      // resting value so the per-frame write is `base * bootPhase`, never a
      // compounding multiply.
      const bootFades: { mat: { opacity: number }; base: number; from: number; to: number }[] = [];

      // ── the holo platform: rings + spokes + tick dial ────────────────
      const gridMat = track(new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22 }));
      bootFades.push({ mat: gridMat, base: 0.22, from: 0, to: 0.3 });
      for (const frac of [0.25, 0.5, 0.75, 1]) {
        const pts: THREE_NS.Vector3[] = [];
        for (let s = 0; s <= 64; s++) {
          const a = (s / 64) * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.cos(a) * PLATFORM_R * frac, 0, Math.sin(a) * PLATFORM_R * frac));
        }
        const geo = track(new THREE.BufferGeometry().setFromPoints(pts));
        world.add(new THREE.Line(geo, gridMat));
      }
      {
        const pts: THREE_NS.Vector3[] = [];
        for (let i = 0; i < n; i++) {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          pts.push(new THREE.Vector3(0, 0, 0), new THREE.Vector3(Math.cos(a) * PLATFORM_R, 0, Math.sin(a) * PLATFORM_R));
        }
        const geo = track(new THREE.BufferGeometry().setFromPoints(pts));
        world.add(new THREE.LineSegments(geo, gridMat));
      }
      // A faint disc under everything, so the platform reads as a surface.
      {
        const geo = track(new THREE.CircleGeometry(PLATFORM_R * 1.04, 64));
        const mat = track(new THREE.MeshBasicMaterial({ color: 0x0ea5e9, transparent: true, opacity: 0.05, side: THREE.DoubleSide }));
        bootFades.push({ mat, base: 0.05, from: 0, to: 0.3 });
        const disc = new THREE.Mesh(geo, mat);
        disc.rotation.x = -Math.PI / 2;
        disc.position.y = -0.01;
        world.add(disc);
      }
      // The instrument dial around the platform edge: 72 radial ticks, every
      // sixth one long. Decorative chrome on its own slow counter-rotation --
      // it carries no data, so it may move by itself (rule 5).
      const tickRing = new THREE.Group();
      {
        const pts: THREE_NS.Vector3[] = [];
        for (let i = 0; i < 72; i++) {
          const a = (i / 72) * Math.PI * 2;
          const inner = PLATFORM_R * 1.06;
          const outer = PLATFORM_R * (i % 6 === 0 ? 1.16 : 1.1);
          pts.push(new THREE.Vector3(Math.cos(a) * inner, 0, Math.sin(a) * inner), new THREE.Vector3(Math.cos(a) * outer, 0, Math.sin(a) * outer));
        }
        const geo = track(new THREE.BufferGeometry().setFromPoints(pts));
        const mat = track(new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.3 }));
        bootFades.push({ mat, base: 0.3, from: 0.05, to: 0.35 });
        tickRing.add(new THREE.LineSegments(geo, mat));
        world.add(tickRing);
      }

      // ── the radar sweep: a fading wedge brushing the platform ────────
      // Vertex colours fade the tail to black; additive blending makes black
      // invisible, so no per-vertex alpha is needed. Purely decorative.
      const sweep = new THREE.Group();
      {
        const SEGS = 28;
        const ARC = 0.9;
        const verts: number[] = [];
        const cols: number[] = [];
        const lead = new THREE.Color(CYAN);
        for (let i = 0; i < SEGS; i++) {
          const a0 = -(i / SEGS) * ARC;
          const a1 = -((i + 1) / SEGS) * ARC;
          const f0 = Math.pow(1 - i / SEGS, 2) * 0.4;
          const f1 = Math.pow(1 - (i + 1) / SEGS, 2) * 0.4;
          verts.push(0, 0, 0, Math.cos(a0) * PLATFORM_R, 0, Math.sin(a0) * PLATFORM_R, Math.cos(a1) * PLATFORM_R, 0, Math.sin(a1) * PLATFORM_R);
          cols.push(0, 0, 0, lead.r * f0, lead.g * f0, lead.b * f0, lead.r * f1, lead.g * f1, lead.b * f1);
        }
        const geo = track(new THREE.BufferGeometry());
        geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
        const mat = track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        bootFades.push({ mat, base: 1, from: 0.1, to: 0.4 });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.y = 0.005;
        sweep.add(mesh);
        world.add(sweep);
      }

      // ── glow sprite texture (one canvas, shared) ─────────────────────
      const glowCanvas = document.createElement("canvas");
      glowCanvas.width = glowCanvas.height = 64;
      const gctx = glowCanvas.getContext("2d")!;
      const grad = gctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,0.9)");
      grad.addColorStop(0.35, "rgba(255,255,255,0.35)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      gctx.fillStyle = grad;
      gctx.fillRect(0, 0, 64, 64);
      const glowTex = track(new THREE.CanvasTexture(glowCanvas));

      // A soft pool of light lying ON the platform under the beams. Flat
      // geometry (not a sprite -- sprites face the camera and would read as
      // fog), additive, constant.
      {
        const geo = track(new THREE.PlaneGeometry(PLATFORM_R * 1.9, PLATFORM_R * 1.9));
        const mat = track(new THREE.MeshBasicMaterial({ map: glowTex, color: 0x0e7490, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false }));
        bootFades.push({ mat, base: 0.28, from: 0, to: 0.3 });
        const pool = new THREE.Mesh(geo, mat);
        pool.rotation.x = -Math.PI / 2;
        pool.position.y = 0.002;
        world.add(pool);
      }

      // ── the seven energy beams ───────────────────────────────────────
      const pillarGroup = new THREE.Group();
      world.add(pillarGroup);
      const topPoints: THREE_NS.Vector3[] = [];
      const sheathMats: THREE_NS.ShaderMaterial[] = [];
      const pillars: {
        key: string;
        azimuth: number;
        x: number;
        z: number;
        mat: THREE_NS.MeshBasicMaterial;
        sheathMat: THREE_NS.ShaderMaterial;
        ringMat: THREE_NS.MeshBasicMaterial;
        mesh: THREE_NS.Mesh;
        sheath: THREE_NS.Mesh;
        glow: THREE_NS.Sprite;
        glowMat: THREE_NS.SpriteMaterial;
        anchor: THREE_NS.Object3D;
        baseH: number;
        bootFrom: number;
        bootTo: number;
        /** Damped emphasis mixes (round 9): eased toward 1 while selected /
         *  hovered, so no visual property ever snaps between states. */
        selMix: number;
        hotMix: number;
      }[] = [];

      dimensions.forEach((d, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const x = Math.cos(a) * PLATFORM_R;
        const z = Math.sin(a) * PLATFORM_R;
        const h = Math.max(0.06, (Math.min(100, Math.max(0, d.score)) / 100) * PILLAR_MAX_H);
        const hue = new THREE.Color(hueFor(d.key).to);

        // The bright core: the measurement itself.
        const geo = track(new THREE.CylinderGeometry(0.045, 0.045, h, 10));
        const mat = track(new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.95 }));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, h / 2, z);
        mesh.userData.dimKey = d.key;
        pillarGroup.add(mesh);

        // The sheath: the holographic dressing around the core -- fresnel rim
        // and a slow scanline crawl (decorative; the core it wraps is rigid).
        const sheathGeo = track(new THREE.CylinderGeometry(0.11, 0.13, h, 12, 1, true));
        const sheathMat = track(new THREE.ShaderMaterial({
          vertexShader: SHEATH_VERT,
          fragmentShader: SHEATH_FRAG,
          uniforms: { uColor: { value: hue }, uTime: { value: 0 }, uOpacity: { value: 0.55 } },
          transparent: true,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        }));
        sheathMats.push(sheathMat);
        const sheath = new THREE.Mesh(sheathGeo, sheathMat);
        sheath.position.set(x, h / 2, z);
        pillarGroup.add(sheath);

        // The landing ring at the beam's foot, in the same identity hue.
        const ringGeo = track(new THREE.RingGeometry(0.16, 0.23, 32));
        const ringMat = track(new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(x, 0.004, z);
        pillarGroup.add(ring);

        // A wide, transparent hit cylinder so a fingertip can land on a thin
        // beam. The raycaster sees it; the eye never does.
        const hitGeo = track(new THREE.CylinderGeometry(0.42, 0.42, PILLAR_MAX_H + 0.4, 6));
        const hitMat = track(new THREE.MeshBasicMaterial({ visible: false }));
        const hit = new THREE.Mesh(hitGeo, hitMat);
        hit.position.set(x, (PILLAR_MAX_H + 0.4) / 2 - 0.2, z);
        hit.userData.dimKey = d.key;
        pillarGroup.add(hit);

        const glowMat = track(new THREE.SpriteMaterial({ map: glowTex, color: hue, transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending }));
        const glow = new THREE.Sprite(glowMat);
        glow.position.set(x, h, z);
        glow.scale.setScalar(0.55);
        pillarGroup.add(glow);

        // The projected label's anchor: rides the world's rotation just
        // above the beam top, so the DOM chip can follow it through the
        // camera every frame.
        const anchor = new THREE.Object3D();
        anchor.position.set(x, h + 0.3, z);
        world.add(anchor);

        topPoints.push(new THREE.Vector3(x, h, z));
        pillars.push({
          key: d.key, azimuth: a, x, z, mesh, mat, sheath, sheathMat, ringMat, glow, glowMat, anchor, baseH: h,
          // Staggered rise: each beam starts a beat after its neighbour.
          bootFrom: 0.18 + i * 0.05,
          bootTo: 0.5 + i * 0.05,
          selMix: 0,
          hotMix: 0,
        });
      });

      // ── the score surface: a fresnel tent over the beam tops ─────────
      const surfaceUniforms = { uColor: { value: new THREE.Color(0x22d3ee) }, uOpacity: { value: 0 } };
      {
        const centroidY = topPoints.reduce((s, p) => s + p.y, 0) / n;
        const verts: number[] = [0, centroidY, 0];
        topPoints.forEach((p) => verts.push(p.x, p.y, p.z));
        const idx: number[] = [];
        for (let i = 1; i <= n; i++) idx.push(0, i, (i % n) + 1);
        const geo = track(new THREE.BufferGeometry());
        geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
        geo.setIndex(idx);
        geo.computeVertexNormals();
        const mat = track(new THREE.ShaderMaterial({
          vertexShader: SHEATH_VERT,
          fragmentShader: SURFACE_FRAG,
          uniforms: surfaceUniforms,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        }));
        world.add(new THREE.Mesh(geo, mat));

        const edgeGeo = track(new THREE.BufferGeometry().setFromPoints([...topPoints, topPoints[0]]));
        const edgeMat = track(new THREE.LineBasicMaterial({ color: new THREE.Color(CYAN), transparent: true, opacity: 0.95 }));
        bootFades.push({ mat: edgeMat, base: 0.95, from: 0.6, to: 0.95 });
        world.add(new THREE.Line(edgeGeo, edgeMat));
      }

      // ── the benchmark competitor: gold dashed wireframe + vertices ───
      if (leader && leader.length) {
        const byKey = new Map(leader.map((l) => [l.key, l.leader]));
        const goldCol = new THREE.Color(GOLD);
        const pts = dimensions.map((d, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          const h = (Math.min(100, Math.max(0, byKey.get(d.key) ?? 0)) / 100) * PILLAR_MAX_H;
          return new THREE.Vector3(Math.cos(a) * PLATFORM_R, h, Math.sin(a) * PLATFORM_R);
        });
        const geo = track(new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]));
        const mat = track(new THREE.LineDashedMaterial({ color: goldCol, transparent: true, opacity: 0.9, dashSize: 0.16, gapSize: 0.12 }));
        bootFades.push({ mat, base: 0.9, from: 0.65, to: 0.98 });
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        world.add(line);
        // A small gold marker at each benchmark height, so the wireframe's
        // corners survive the dash pattern and read as measurements.
        const markGeo = track(new THREE.OctahedronGeometry(0.045));
        const markMat = track(new THREE.MeshBasicMaterial({ color: goldCol, transparent: true, opacity: 0.9 }));
        bootFades.push({ mat: markMat, base: 0.9, from: 0.65, to: 0.98 });
        for (const p of pts) {
          const m = new THREE.Mesh(markGeo, markMat);
          m.position.copy(p);
          world.add(m);
        }
      }

      // ── the targeting reticle: assembles at the selected beam's foot ─
      // A dashed ring and four brackets in the SELECTED dimension's identity
      // hue -- the one colour decision here follows the rep's tap, never the
      // value. Slow self-rotation: decorative chrome (rule 5).
      const reticle = new THREE.Group();
      const reticleRingMat = track(new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, dashSize: 0.06, gapSize: 0.05 }));
      const reticleBracketMat = track(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }));
      {
        const pts: THREE_NS.Vector3[] = [];
        for (let s = 0; s <= 48; s++) {
          const a = (s / 48) * Math.PI * 2;
          pts.push(new THREE.Vector3(Math.cos(a) * 0.34, 0, Math.sin(a) * 0.34));
        }
        const geo = track(new THREE.BufferGeometry().setFromPoints(pts));
        const ring = new THREE.Line(geo, reticleRingMat);
        ring.computeLineDistances();
        reticle.add(ring);
        // Four L-brackets at the compass points, just outside the ring.
        const b: THREE_NS.Vector3[] = [];
        const R = 0.46, L = 0.12;
        for (const [cx, cz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const px = cx * R, pz = cz * R;
          b.push(new THREE.Vector3(px - cz * L, 0, pz - cx * L), new THREE.Vector3(px, 0, pz));
          b.push(new THREE.Vector3(px, 0, pz), new THREE.Vector3(px + cz * L, 0, pz + cx * L));
        }
        const bGeo = track(new THREE.BufferGeometry().setFromPoints(b));
        reticle.add(new THREE.LineSegments(bGeo, reticleBracketMat));
      }
      reticle.position.y = 0.012;
      reticle.visible = false;
      world.add(reticle);

      // ── ambient particle drift ───────────────────────────────────────
      const particleGroup = new THREE.Group();
      {
        const count = 180;
        const pos = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const r = 4.5 + Math.random() * 4;
          const theta = Math.random() * Math.PI * 2;
          const y = (Math.random() - 0.2) * 4;
          pos[i * 3] = Math.cos(theta) * r;
          pos[i * 3 + 1] = y;
          pos[i * 3 + 2] = Math.sin(theta) * r;
        }
        const geo = track(new THREE.BufferGeometry());
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
        const mat = track(new THREE.PointsMaterial({ color: 0x67e8f9, size: 0.035, transparent: true, opacity: 0.5, depthWrite: false }));
        bootFades.push({ mat, base: 0.5, from: 0, to: 0.5 });
        particleGroup.add(new THREE.Points(geo, mat));
        scene.add(particleGroup);
      }

      // ── the projected labels: DOM chips riding the beam tops ─────────
      // Real DOM so the type is crisp at any DPI and wears the card's own
      // faces; aria-hidden because the dimension list beside the chart is
      // the accessible path (rule 3). Clicking a chip selects and focuses,
      // same as tapping its beam.
      const labelLayer = document.createElement("div");
      labelLayer.setAttribute("aria-hidden", "true");
      labelLayer.style.cssText = "position:absolute;inset:0;overflow:hidden;pointer-events:none;";
      host.appendChild(labelLayer);
      const labels = dimensions.map((d) => {
        const hue = hueFor(d.key).to;
        const el = document.createElement("button");
        el.type = "button";
        el.tabIndex = -1;
        el.style.cssText =
          "position:absolute;left:0;top:0;pointer-events:auto;cursor:pointer;background:none;border:0;padding:2px 4px;" +
          "display:flex;flex-direction:column;align-items:center;gap:1px;white-space:nowrap;transform:translate(-50%,-100%);" +
          // Opacity may transition (depth fades read smoother); transform
          // may NOT -- it is written per frame and a transition would fight
          // the projection.
          "transition:opacity 140ms linear;";
        const name = document.createElement("span");
        name.textContent = d.label;
        name.style.cssText = `font-family:var(--battle-display);font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${hue};text-shadow:0 0 8px ${hue}66;`;
        const score = document.createElement("span");
        score.textContent = String(d.score);
        score.style.cssText = "font-family:var(--battle-data);font-size:11px;color:rgba(226,232,240,0.92);";
        el.appendChild(name);
        el.appendChild(score);
        el.addEventListener("pointerdown", (e) => { e.stopPropagation(); focusKey = d.key; selectRef.current(d.key); sfx.play("tick"); });
        labelLayer.appendChild(el);
        return { key: d.key, el, name };
      });
      const projected = new THREE.Vector3();

      // ── sizing ───────────────────────────────────────────────────────
      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
        composer?.setSize(w, h);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(host);

      // ── interaction: tap to focus, drag to orbit (with weight) ───────
      const raycaster = new THREE.Raycaster();
      const pointerNdc = new THREE.Vector2();
      let pointerDown = false;
      let dragging = false;
      let moved = 0;
      let lastX = 0, lastY = 0;
      let tiltX = -0.12;
      let rotY = 0;
      let rotVel = 0;
      let focusKey: string | null = null;
      // Selection as of the last frame: a CHANGE (from the list, the plate,
      // a label or a tap) is what engages a focus flight. Hover never
      // selects any more -- a camera that chases casual pointer travel is a
      // chart that will not hold still mid-sentence. Seeded from the
      // PRE-INIT capture so a click that landed during the async load still
      // reads as a change on the first frame.
      let lastSelSeen = mountSel;

      const pick = (e: PointerEvent): string | null => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointerNdc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointerNdc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerNdc, camera);
        const hitList = raycaster.intersectObjects(pillarGroup.children, false);
        for (const h of hitList) {
          const key = (h.object.userData as { dimKey?: string }).dimKey;
          if (key) return key;
        }
        return null;
      };

      let hoverKey: string | null = null;
      const onDown = (e: PointerEvent) => {
        pointerDown = true;
        dragging = false;
        moved = 0;
        lastX = e.clientX; lastY = e.clientY;
        renderer.domElement.setPointerCapture(e.pointerId);
      };
      const onMove = (e: PointerEvent) => {
        if (pointerDown) {
          const dx = e.clientX - lastX;
          const dy = e.clientY - lastY;
          moved += Math.abs(dx) + Math.abs(dy);
          if (moved > TAP_SLOP) {
            if (!dragging) {
              dragging = true;
              focusKey = null;
              renderer.domElement.style.cursor = "grabbing";
            }
            rotY += dx * 0.005;
            rotVel = dx * 0.005;
            tiltX = Math.max(-0.5, Math.min(0.25, tiltX + dy * 0.003));
          }
          lastX = e.clientX; lastY = e.clientY;
          return;
        }
        hoverKey = pick(e);
        renderer.domElement.style.cursor = hoverKey ? "pointer" : "grab";
      };
      const onUp = (e: PointerEvent) => {
        if (pointerDown && !dragging) {
          const key = pick(e);
          if (key) {
            const prevFocus = focusKey;
            focusKey = key;
            selectRef.current(key);
            sfx.play("tick");
            // A re-tap of the already-selected beam after a camera reset:
            // the selection detector below won't fire (nothing changed), so
            // the flight's sound happens here.
            if (prevFocus !== key && selectedRef.current === key) sfx.play("engage");
          }
        }
        pointerDown = false;
        dragging = false;
        renderer.domElement.style.cursor = "grab";
      };
      // Double-click anywhere on the stage: back to the home orbit. The
      // selection (and the detail panel it drives) stays where the rep put
      // it -- only the CAMERA resets.
      const onDblClick = () => {
        if (focusKey) sfx.play("disengage");
        focusKey = null;
      };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointermove", onMove);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("pointerleave", onUp);
      renderer.domElement.addEventListener("dblclick", onDblClick);

      // ── the loop ─────────────────────────────────────────────────────
      let raf = 0;
      let decorT = 0;
      let running = true;
      let lockT = 1;
      let lastReticleKey: string | null = null;
      const bootStart = performance.now();
      const camPos = HOME_POS.clone();
      const camLook = HOME_LOOK.clone();
      const wantPos = HOME_POS.clone();
      const wantLook = HOME_LOOK.clone();

      let lastNow = performance.now();
      const tick = () => {
        if (!running) return;
        const now = performance.now();
        // Clamped so a tab resume does not integrate an hour of "elapsed"
        // spin in one frame.
        const dt = Math.min(0.05, (now - lastNow) / 1000);
        lastNow = now;
        const bootT = Math.min(1, (now - bootStart) / 1400);
        decorT += dt * 0.096;

        // A selection that arrived from OUTSIDE the canvas (the list, the
        // plate) engages the same focus flight a tap does.
        const selNow = selectedRef.current;
        if (selNow !== lastSelSeen) {
          lastSelSeen = selNow;
          if (selNow) {
            focusKey = selNow;
            sfx.play("engage");
          }
        }

        // ── rotation: focus flight beats inertia beats idle drift ──────
        const focusPillar = focusKey ? pillars.find((p) => p.key === focusKey) : undefined;
        if (focusPillar && !dragging) {
          // Turn the shortest way so the chosen beam faces the camera. A
          // three.js Y-rotation by R moves azimuth `a` to `a - R`, and the
          // camera-facing azimuth is +PI/2, so R = a - PI/2. The inverted
          // form (PI/2 - a) happens to coincide for the first pillar (both
          // are PI mod 2PI at a = -PI/2), which is exactly why an eyeball
          // test on the default selection missed it. (Codex review P1,
          // 2026-09-01.)
          const targetR = nearestTurn(rotY, focusPillar.azimuth - Math.PI / 2);
          rotY += (targetR - rotY) * damp(0.07, dt);
          tiltX += (-0.18 - tiltX) * damp(0.05, dt);
          rotVel = 0;
          wantPos.copy(FOCUS_POS);
          wantLook.set(0, focusPillar.baseH * 0.55 + 0.25, 1.1);
        } else {
          if (!dragging) {
            rotY += rotVel * dt * 60;
            rotVel *= Math.pow(0.94, dt * 60);
            if (Math.abs(rotVel) < 0.00004) {
              rotVel = 0;
              rotY += dt * 0.096;
            }
          }
          wantPos.copy(HOME_POS);
          wantLook.copy(HOME_LOOK);
        }
        camPos.lerp(wantPos, damp(0.06, dt));
        camLook.lerp(wantLook, damp(0.08, dt));
        camera.position.copy(camPos);
        camera.lookAt(camLook);

        world.rotation.y = rotY;
        world.rotation.x = tiltX;
        particleGroup.rotation.y = -rotY * 0.35;
        // Decorative layers on their own clocks (rule 5): the sweep brushes
        // the platform, the tick dial counter-rotates, both slowly.
        sweep.rotation.y = decorT * 14;
        tickRing.rotation.y = -decorT * 2.5;

        // ── boot fades on the platform, surface and benchmark ──────────
        for (const f of bootFades) f.mat.opacity = f.base * easeOut(phase(bootT, f.from, f.to));
        surfaceUniforms.uOpacity.value = 0.3 * easeOut(phase(bootT, 0.6, 0.95));

        // ── the beams: boot rise x DAMPED selection/hover mixes ────────
        // Round 9: no state may SNAP. Each beam carries two smoothed mixes
        // (selected, hovered) eased toward their targets with frame-rate-
        // normalized damping, and every visual property blends through
        // them -- a selection glides into emphasis over ~180ms instead of
        // teleporting between two looks on a frame boundary.
        const sel = selectedRef.current;
        for (const p of pillars) {
          const rise = easeOut(phase(bootT, p.bootFrom, p.bootTo));
          const active = p.key === sel;
          const hot = p.key === hoverKey && !active;
          p.selMix += ((active ? 1 : 0) - p.selMix) * damp(0.16, dt);
          p.hotMix += ((hot ? 1 : 0) - p.hotMix) * damp(0.22, dt);
          const s = p.selMix;
          const h = p.hotMix;
          p.mesh.scale.y = Math.max(rise, 0.001);
          p.mesh.position.y = (p.baseH * rise) / 2;
          p.sheath.scale.y = Math.max(rise, 0.001);
          p.sheath.position.y = (p.baseH * rise) / 2;
          p.glow.position.y = p.baseH * rise;
          p.anchor.position.y = p.baseH * rise + 0.3;
          p.mat.opacity = (0.85 + 0.15 * s + 0.07 * h) * rise;
          p.sheathMat.uniforms.uTime.value = decorT * 2.6;
          p.sheathMat.uniforms.uOpacity.value = (0.55 + 0.4 * s + 0.15 * h) * rise;
          p.ringMat.opacity = (0.4 + 0.3 * s) * rise;
          p.glowMat.opacity = (0.7 + 0.3 * s + 0.15 * h) * rise;
          p.glow.scale.setScalar((0.55 + 0.3 * s) * Math.max(rise, 0.001));
          p.mesh.scale.x = p.mesh.scale.z = 1 + 0.6 * s;
          p.sheath.scale.x = p.sheath.scale.z = 1 + 0.35 * s;
        }

        // ── the reticle rides the selected beam, with a lock-on burst ──
        const selPillar = sel ? pillars.find((p) => p.key === sel) : undefined;
        if (selPillar && bootT > 0.85) {
          if (lastReticleKey !== selPillar.key) {
            lastReticleKey = selPillar.key;
            lockT = 0;
          }
          lockT = Math.min(1, lockT + dt * 3.6);
          const burst = 1 - easeOut(lockT);
          reticle.visible = true;
          reticle.position.x = selPillar.x;
          reticle.position.z = selPillar.z;
          // The ring snaps wide and settles onto the beam, spinning faster
          // while it locks -- the acquisition gesture every targeting HUD
          // uses, and it answers the rep's own tap (rule 5).
          reticle.scale.setScalar(1 + burst * 0.55);
          reticle.rotation.y = decorT * 3 + burst * 2;
          const hue = hueFor(selPillar.key).to;
          reticleRingMat.color.set(hue);
          reticleBracketMat.color.set(hue);
        } else {
          reticle.visible = false;
          lastReticleKey = null;
        }

        // ── the labels chase their anchors through the camera ──────────
        const rect = { w: renderer.domElement.clientWidth, h: renderer.domElement.clientHeight };
        const labelBoot = phase(bootT, 0.7, 1);
        for (let i = 0; i < labels.length; i++) {
          const l = labels[i];
          pillars[i].anchor.getWorldPosition(projected);
          // Depth cue from camera DISTANCE, not NDC z -- perspective z is
          // nonlinear and bunched against 1, so a threshold there is brittle.
          const dist = camera.position.distanceTo(projected);
          const depth = Math.min(1, Math.max(0, (dist - 7.2) / 5.2));
          projected.project(camera);
          const off = projected.z > 1;
          const active = l.key === sel;
          const opacity = (off ? 0 : 1 - depth * 0.62) * labelBoot;
          l.el.style.transform = `translate(-50%,-100%) translate(${((projected.x * 0.5 + 0.5) * rect.w).toFixed(1)}px, ${((-projected.y * 0.5 + 0.5) * rect.h).toFixed(1)}px) scale(${(active ? 1.08 : 1 - depth * 0.18).toFixed(3)})`;
          l.el.style.opacity = opacity.toFixed(3);
          l.el.style.zIndex = String(1000 - Math.round(depth * 900));
          l.name.style.textShadow = active ? `0 0 12px ${hueFor(l.key).to}` : `0 0 8px ${hueFor(l.key).to}66`;
        }

        if (composer) composer.render();
        else renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);

      // Pause the loop when the stage can't be seen -- for TWO reasons that
      // compose: the tab is hidden, OR the host itself is out of view
      // (scrolled away, or sitting inside a COLLAPSED section, which round
      // 9's always-mounted drawers made possible -- inert and zero height
      // do not pause an effect's rAF loop; this does). A rep leaves the
      // card open all shift; an invisible canvas must cost nothing. (Codex
      // review P2, 2026-09-02.)
      let tabVisible = document.visibilityState === "visible";
      let hostVisible = true;
      const updateRunning = () => {
        const should = tabVisible && hostVisible;
        if (should && !running) {
          running = true;
          lastNow = performance.now();
          raf = requestAnimationFrame(tick);
        } else if (!should && running) {
          running = false;
          cancelAnimationFrame(raf);
        }
      };
      const onVis = () => {
        tabVisible = document.visibilityState === "visible";
        updateRunning();
      };
      document.addEventListener("visibilitychange", onVis);
      const io = new IntersectionObserver((entries) => {
        hostVisible = entries.some((e) => e.isIntersecting);
        updateRunning();
      });
      io.observe(host);

      statusRef.current(true);

      cleanup = () => {
        running = false;
        cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVis);
        io.disconnect();
        ro.disconnect();
        renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerup", onUp);
        renderer.domElement.removeEventListener("pointerleave", onUp);
        renderer.domElement.removeEventListener("dblclick", onDblClick);
        for (const d of disposables) d.dispose();
        for (const disposePass of passDisposers) disposePass();
        composer?.dispose?.();
        renderer.dispose();
        if (labelLayer.parentNode === host) host.removeChild(labelLayer);
        if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      };
    })();

    return () => {
      dead = true;
      disarmSfx();
      if (cleanup) cleanup();
    };
    // Rebuild only when the DATA changes (a new lead). Selection flows
    // through refs; rebuilding a GL scene per click would stutter the orbit.
  }, [dimensions, leader]);

  return <div ref={hostRef} className={`relative ${className}`} aria-hidden />;
}

export default Radar3D;
