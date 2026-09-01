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
 * ═══ WHAT IT DRAWS (round 5: "nicer and more detailed") ═════════════════════
 *
 * A circular holo-platform (polar grid ringed by a tick dial), seven ENERGY
 * BEAMS rising from it -- bright core, translucent sheath, a lit ring at the
 * foot (height = that dimension's score, colour = its fixed identity hue from
 * battle-hud.ts) -- a translucent cyan score surface tented over the beam
 * tops, the benchmark competitor as a GOLD dashed wireframe with vertex
 * markers at its own heights, a slow RADAR SWEEP brushing the platform, and
 * a particle drift around the whole thing. When the postprocessing modules
 * load, the scene renders through REAL BLOOM (UnrealBloomPass) and the
 * canvas composites onto the panel with `mix-blend-mode: screen`, so light
 * blooms and black contributes nothing; if that import fails the scene
 * renders exactly as round 4 did, direct and transparent. The group idles in
 * rotation, the pointer drags to orbit, and hovering or tapping a beam
 * selects that dimension -- the same selection the list and detail panel
 * share.
 *
 * Each beam also carries a PROJECTED LABEL: a DOM chip (dimension name in
 * the display face, score in the data face, wearing the identity hue) that
 * tracks its beam top through the camera every frame. This revises round 4's
 * "no text in the scene" rule by honouring what it protected: the text is
 * never IN the GL scene (it is real DOM -- crisp at any DPI, real fonts),
 * it is aria-hidden, and the dimension list beside the chart remains the
 * accessible and keyboard path. The graph now explains itself on sight
 * (Adon, round 5: "really outlining the graph of what type of bad it is").
 *
 * ═══ THE RULES ══════════════════════════════════════════════════════════════
 *
 * 1. Colour is identity, never verdict (battle-hud.ts). Beam HEIGHT is the
 *    score -- the same length encoding every Meter uses; hue never varies
 *    with the value. Bloom blooms every hue identically.
 * 2. This component simply does not mount under prefers-reduced-motion; the
 *    caller gates it. No "paused 3D" middle state to get wrong.
 * 3. No text in the GL scene. The projected labels are DOM, aria-hidden,
 *    and a pointer convenience; the accessible dimension list beside the
 *    chart is still the legend and the keyboard path.
 * 4. Everything disposed on unmount: geometries, materials, textures,
 *    composer targets, renderer. A rep pages through many leads in a shift;
 *    leaking a GL context per lead kills the tab by lunch.
 * 5. Ambient motion (sweep, ticks, idle orbit, particles) lives ONLY on
 *    decorative layers that carry no data. The beams and surfaces encode
 *    scores and rotate rigidly with the stage, never by themselves.
 */

import { useEffect, useRef } from "react";
import type * as THREE_NS from "three";
import { hueFor, GOLD, CYAN } from "./battle-hud";
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
      camera.position.set(0, 4.6, 8.2);
      camera.lookAt(0, 0.7, 0);

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
      try {
        const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
          import("three/examples/jsm/postprocessing/EffectComposer.js"),
          import("three/examples/jsm/postprocessing/RenderPass.js"),
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        ]);
        if (dead) { renderer.dispose(); return; }
        const comp = new EffectComposer(renderer);
        comp.addPass(new RenderPass(scene, camera));
        // Strength stays restrained: bloom is the glow the additive sprites
        // were faking, not a light show. Threshold keeps the dim grid crisp.
        comp.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.75, 0.55, 0.16));
        renderer.setClearColor(0x000000, 1);
        renderer.domElement.style.mixBlendMode = "screen";
        composer = comp;
      } catch {
        composer = null;
      }

      // ── the holo platform: rings + spokes + tick dial ────────────────
      const gridMat = track(new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.22 }));
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
        const mat = track(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
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
        const pool = new THREE.Mesh(geo, mat);
        pool.rotation.x = -Math.PI / 2;
        pool.position.y = 0.002;
        world.add(pool);
      }

      // ── the seven energy beams ───────────────────────────────────────
      const pillarGroup = new THREE.Group();
      world.add(pillarGroup);
      const topPoints: THREE_NS.Vector3[] = [];
      const pillars: {
        key: string;
        mat: THREE_NS.MeshBasicMaterial;
        sheathMat: THREE_NS.MeshBasicMaterial;
        ringMat: THREE_NS.MeshBasicMaterial;
        mesh: THREE_NS.Mesh;
        sheath: THREE_NS.Mesh;
        glow: THREE_NS.Sprite;
        glowMat: THREE_NS.SpriteMaterial;
        anchor: THREE_NS.Object3D;
        baseH: number;
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

        // The sheath: a wider, faint, additive shell that makes the core
        // read as a volumetric beam instead of a stick. Same height -- it IS
        // the same measurement, dressed.
        const sheathGeo = track(new THREE.CylinderGeometry(0.11, 0.13, h, 12, 1, true));
        const sheathMat = track(new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
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
        pillars.push({ key: d.key, mesh, mat, sheath, sheathMat, ringMat, glow, glowMat, anchor, baseH: h });
      });

      // ── the score surface: a translucent tent over the beam tops ─────
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
        const mat = track(new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthWrite: false }));
        world.add(new THREE.Mesh(geo, mat));

        const edgeGeo = track(new THREE.BufferGeometry().setFromPoints([...topPoints, topPoints[0]]));
        const edgeMat = track(new THREE.LineBasicMaterial({ color: new THREE.Color(CYAN), transparent: true, opacity: 0.95 }));
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
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        world.add(line);
        // A small gold marker at each benchmark height, so the wireframe's
        // corners survive the dash pattern and read as measurements.
        const markGeo = track(new THREE.OctahedronGeometry(0.045));
        const markMat = track(new THREE.MeshBasicMaterial({ color: goldCol, transparent: true, opacity: 0.9 }));
        for (const p of pts) {
          const m = new THREE.Mesh(markGeo, markMat);
          m.position.copy(p);
          world.add(m);
        }
      }

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
        particleGroup.add(new THREE.Points(geo, mat));
        scene.add(particleGroup);
      }

      // ── the projected labels: DOM chips riding the beam tops ─────────
      // Real DOM so the type is crisp at any DPI and wears the card's own
      // faces; aria-hidden because the dimension list beside the chart is
      // the accessible path (rule 3). Clicking a chip selects, same as
      // clicking its beam.
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
          "display:flex;flex-direction:column;align-items:center;gap:1px;white-space:nowrap;transform:translate(-50%,-100%);";
        const name = document.createElement("span");
        name.textContent = d.label;
        name.style.cssText = `font-family:var(--battle-display);font-size:10px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${hue};text-shadow:0 0 8px ${hue}66;`;
        const score = document.createElement("span");
        score.textContent = String(d.score);
        score.style.cssText = "font-family:var(--battle-data);font-size:11px;color:rgba(226,232,240,0.92);";
        el.appendChild(name);
        el.appendChild(score);
        el.addEventListener("pointerdown", (e) => { e.stopPropagation(); selectRef.current(d.key); });
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

      // ── interaction: drag to orbit, hover/tap to select ──────────────
      const raycaster = new THREE.Raycaster();
      const pointerNdc = new THREE.Vector2();
      let dragging = false;
      let lastX = 0, lastY = 0;
      let tiltX = -0.12;
      let userSpin = 0;

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

      const onDown = (e: PointerEvent) => {
        dragging = true;
        lastX = e.clientX; lastY = e.clientY;
        renderer.domElement.style.cursor = "grabbing";
        renderer.domElement.setPointerCapture(e.pointerId);
        const key = pick(e);
        if (key) selectRef.current(key);
      };
      const onMove = (e: PointerEvent) => {
        if (dragging) {
          userSpin += (e.clientX - lastX) * 0.005;
          tiltX = Math.max(-0.5, Math.min(0.25, tiltX + (e.clientY - lastY) * 0.003));
          lastX = e.clientX; lastY = e.clientY;
          return;
        }
        const key = pick(e);
        renderer.domElement.style.cursor = key ? "pointer" : "grab";
        if (key) selectRef.current(key);
      };
      const onUp = () => { dragging = false; renderer.domElement.style.cursor = "grab"; };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointermove", onMove);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("pointerleave", onUp);

      // ── the loop ─────────────────────────────────────────────────────
      let raf = 0;
      let idle = 0;
      let running = true;
      const tick = () => {
        if (!running) return;
        idle += 0.0016;
        world.rotation.y = idle + userSpin;
        world.rotation.x = tiltX;
        particleGroup.rotation.y = -(idle + userSpin) * 0.35;
        // Decorative layers on their own clocks (rule 5): the sweep brushes
        // the platform, the tick dial counter-rotates, both slowly.
        sweep.rotation.y = idle * 14;
        tickRing.rotation.y = -idle * 2.5;
        // The selected beam breathes brighter; everything else rests. Read
        // from the ref so selection never rebuilds the scene.
        const sel = selectedRef.current;
        for (const p of pillars) {
          const active = p.key === sel;
          p.mat.opacity = active ? 1 : 0.85;
          p.sheathMat.opacity = active ? 0.3 : 0.16;
          p.ringMat.opacity = active ? 0.7 : 0.4;
          p.glowMat.opacity = active ? 1 : 0.7;
          p.glow.scale.setScalar(active ? 0.85 : 0.55);
          p.mesh.scale.x = p.mesh.scale.z = active ? 1.6 : 1;
          p.sheath.scale.x = p.sheath.scale.z = active ? 1.35 : 1;
        }
        // The labels chase their anchors through the camera. Depth fades a
        // chip on the far side of the stage so the near side reads first.
        const rect = { w: renderer.domElement.clientWidth, h: renderer.domElement.clientHeight };
        for (let i = 0; i < labels.length; i++) {
          const l = labels[i];
          pillars[i].anchor.getWorldPosition(projected);
          // Depth cue from camera DISTANCE, not NDC z -- perspective z is
          // nonlinear and bunched against 1, so a threshold there is brittle.
          const dist = camera.position.distanceTo(projected);
          const depth = Math.min(1, Math.max(0, (dist - 7.2) / 5.2));
          projected.project(camera);
          const off = projected.z > 1;
          const opacity = off ? 0 : 1 - depth * 0.62;
          const active = l.key === sel;
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

      // Pause the loop when the tab is hidden -- a rep leaves the card open
      // all shift; a hidden canvas must cost nothing.
      const onVis = () => {
        running = document.visibilityState === "visible";
        if (running) raf = requestAnimationFrame(tick);
        else cancelAnimationFrame(raf);
      };
      document.addEventListener("visibilitychange", onVis);

      statusRef.current(true);

      cleanup = () => {
        running = false;
        cancelAnimationFrame(raf);
        document.removeEventListener("visibilitychange", onVis);
        ro.disconnect();
        renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerup", onUp);
        renderer.domElement.removeEventListener("pointerleave", onUp);
        for (const d of disposables) d.dispose();
        composer?.dispose?.();
        renderer.dispose();
        if (labelLayer.parentNode === host) host.removeChild(labelLayer);
        if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      };
    })();

    return () => {
      dead = true;
      if (cleanup) cleanup();
    };
    // Rebuild only when the DATA changes (a new lead). Selection flows
    // through refs; rebuilding a GL scene per click would stutter the orbit.
  }, [dimensions, leader]);

  return <div ref={hostRef} className={`relative ${className}`} aria-hidden />;
}

export default Radar3D;
