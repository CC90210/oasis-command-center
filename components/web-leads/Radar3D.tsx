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
 * ═══ WHAT IT DRAWS ══════════════════════════════════════════════════════════
 *
 * A circular holo-platform (polar grid), seven LIGHT PILLARS rising from it
 * (height = that dimension's score, colour = its fixed identity hue from
 * battle-hud.ts), a translucent cyan score surface tented over the pillar
 * tops, the benchmark competitor as a GOLD dashed wireframe at its own
 * heights, and a slow particle drift around the whole thing. The group idles
 * in rotation (Adon: the card should feel alive), the pointer drags to
 * orbit, and hovering or tapping a pillar selects that dimension -- the same
 * selection state the list and detail panel already share.
 *
 * ═══ THE RULES ══════════════════════════════════════════════════════════════
 *
 * 1. Colour is identity, never verdict (battle-hud.ts). Pillar HEIGHT is the
 *    score -- the same length encoding every Meter uses; hue never varies
 *    with the value.
 * 2. This component simply does not mount under prefers-reduced-motion; the
 *    caller gates it. No "paused 3D" middle state to get wrong.
 * 3. No text in the scene. Labels live in the accessible dimension list
 *    beside the chart, which shares the pillar hues -- the list IS the
 *    legend.
 * 4. Everything disposed on unmount: geometries, materials, textures,
 *    renderer. A rep pages through many leads in a shift; leaking a GL
 *    context per lead kills the tab by lunch.
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

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 60);
      camera.position.set(0, 4.6, 8.2);
      camera.lookAt(0, 0.7, 0);

      const world = new THREE.Group();
      scene.add(world);

      const disposables: { dispose: () => void }[] = [];
      const track = <T extends { dispose: () => void }>(x: T): T => { disposables.push(x); return x; };

      // ── the holo platform: rings + spokes ────────────────────────────
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

      // ── the seven light pillars ──────────────────────────────────────
      const pillarGroup = new THREE.Group();
      world.add(pillarGroup);
      const topPoints: THREE_NS.Vector3[] = [];
      const pillars: { key: string; mesh: THREE_NS.Mesh; mat: THREE_NS.MeshBasicMaterial; glow: THREE_NS.Sprite; glowMat: THREE_NS.SpriteMaterial; baseH: number }[] = [];

      dimensions.forEach((d, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
        const x = Math.cos(a) * PLATFORM_R;
        const z = Math.sin(a) * PLATFORM_R;
        const h = Math.max(0.06, (Math.min(100, Math.max(0, d.score)) / 100) * PILLAR_MAX_H);
        const hue = new THREE.Color(hueFor(d.key).to);

        const geo = track(new THREE.CylinderGeometry(0.05, 0.05, h, 10));
        const mat = track(new THREE.MeshBasicMaterial({ color: hue, transparent: true, opacity: 0.85 }));
        const mesh = new THREE.Mesh(geo, mat);
        mesh.position.set(x, h / 2, z);
        mesh.userData.dimKey = d.key;
        pillarGroup.add(mesh);

        // A wide, transparent hit cylinder so a fingertip can land on a thin
        // pillar. The raycaster sees it; the eye never does.
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

        topPoints.push(new THREE.Vector3(x, h, z));
        pillars.push({ key: d.key, mesh, mat, glow, glowMat, baseH: h });
      });

      // ── the score surface: a translucent tent over the pillar tops ───
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

      // ── the benchmark competitor: gold dashed wireframe ──────────────
      if (leader && leader.length) {
        const byKey = new Map(leader.map((l) => [l.key, l.leader]));
        const pts = dimensions.map((d, i) => {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          const h = (Math.min(100, Math.max(0, byKey.get(d.key) ?? 0)) / 100) * PILLAR_MAX_H;
          return new THREE.Vector3(Math.cos(a) * PLATFORM_R, h, Math.sin(a) * PLATFORM_R);
        });
        const geo = track(new THREE.BufferGeometry().setFromPoints([...pts, pts[0]]));
        const mat = track(new THREE.LineDashedMaterial({ color: new THREE.Color(GOLD), transparent: true, opacity: 0.9, dashSize: 0.16, gapSize: 0.12 }));
        const line = new THREE.Line(geo, mat);
        line.computeLineDistances();
        world.add(line);
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

      // ── sizing ───────────────────────────────────────────────────────
      const resize = () => {
        const w = host.clientWidth || 1;
        const h = host.clientHeight || 1;
        renderer.setSize(w, h, false);
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
        // The selected pillar breathes brighter; everything else rests. Read
        // from the ref so selection never rebuilds the scene.
        const sel = selectedRef.current;
        for (const p of pillars) {
          const active = p.key === sel;
          p.mat.opacity = active ? 1 : 0.8;
          p.glowMat.opacity = active ? 1 : 0.7;
          p.glow.scale.setScalar(active ? 0.85 : 0.55);
          p.mesh.scale.x = p.mesh.scale.z = active ? 1.6 : 1;
        }
        renderer.render(scene, camera);
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
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerup", onUp);
        renderer.domElement.removeEventListener("pointerleave", onUp);
        for (const d of disposables) d.dispose();
        renderer.dispose();
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

  return <div ref={hostRef} className={className} aria-hidden />;
}

export default Radar3D;
