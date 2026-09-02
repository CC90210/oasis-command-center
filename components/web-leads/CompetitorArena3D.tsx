"use client";

import { useEffect, useRef, useState } from "react";
import type * as THREE_NS from "three";
import { CYAN, GOLD, hueFor } from "./battle-hud";

export type ArenaDimension = {
  key: string;
  label: string;
  theirs: number;
  leader: number;
  diff: number;
};

type Props = {
  dimensions: ArenaDimension[];
  prospectName: string;
  competitorName: string;
  reduced: boolean;
};

const clamp = (value: number) => Math.min(100, Math.max(0, value));
const damp = (amount: number, dt: number) => 1 - Math.pow(1 - amount, dt * 60);

/**
 * A second, purpose-built WebGL instrument for the Battle Card. The radar
 * answers "what shape is this site?"; this arena answers "where is the local
 * benchmark ahead?" Paired towers preserve the exact shared 0-100 baseline.
 * Colour identifies the party (cyan prospect, gold benchmark), never quality.
 *
 * Three.js stays behind a dynamic import. Reduced-motion and WebGL-less
 * devices retain the semantic comparison list immediately below this view.
 */
export function CompetitorArena3D({ dimensions, prospectName, competitorName, reduced }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState(false);
  const [selected, setSelected] = useState(0);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    const host = hostRef.current;
    if (!host || reduced || dimensions.length < 2) return;
    const probe = document.createElement("canvas");
    if (!(probe.getContext("webgl2") || probe.getContext("webgl"))) return;

    let dead = false;
    let teardown: (() => void) | undefined;
    (async () => {
      let THREE: typeof THREE_NS;
      try {
        THREE = await import("three");
      } catch {
        return;
      }
      if (dead || !hostRef.current) return;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      renderer.setClearColor(0x020617, 0);
      renderer.domElement.style.cssText = "display:block;width:100%;height:100%;cursor:grab;touch-action:none";
      renderer.domElement.setAttribute("aria-hidden", "true");
      host.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2(0x020617, 0.055);
      const camera = new THREE.PerspectiveCamera(39, 1, 0.1, 80);
      camera.position.set(0, 5.6, 11.8);

      const world = new THREE.Group();
      scene.add(world);
      const disposables: Array<{ dispose: () => void }> = [];
      const track = <T extends { dispose: () => void }>(item: T): T => {
        disposables.push(item);
        return item;
      };

      scene.add(new THREE.HemisphereLight(0x67e8f9, 0x020617, 1.35));
      const key = new THREE.PointLight(0x22d3ee, 38, 24, 1.7);
      key.position.set(-5, 7, 5);
      scene.add(key);
      const rim = new THREE.PointLight(0xfbbf24, 34, 22, 1.8);
      rim.position.set(5, 5, -4);
      scene.add(rim);

      const floorGeo = track(new THREE.CylinderGeometry(5.5, 5.85, 0.22, 64));
      const floorMat = track(new THREE.MeshPhysicalMaterial({
        color: 0x071426,
        metalness: 0.82,
        roughness: 0.26,
        clearcoat: 1,
        clearcoatRoughness: 0.2,
        transparent: true,
        opacity: 0.92,
      }));
      const floor = new THREE.Mesh(floorGeo, floorMat);
      floor.position.y = -0.15;
      world.add(floor);

      const gridMat = track(new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.17 }));
      for (let ring = 1; ring <= 5; ring++) {
        const points: THREE_NS.Vector3[] = [];
        for (let i = 0; i <= 96; i++) {
          const a = (i / 96) * Math.PI * 2;
          points.push(new THREE.Vector3(Math.cos(a) * ring, 0, Math.sin(a) * ring));
        }
        world.add(new THREE.Line(track(new THREE.BufferGeometry().setFromPoints(points)), gridMat));
      }

      const cyan = new THREE.Color(CYAN);
      const gold = new THREE.Color(GOLD);
      const prospectMat = track(new THREE.MeshPhysicalMaterial({
        color: cyan,
        emissive: cyan,
        emissiveIntensity: 0.42,
        metalness: 0.42,
        roughness: 0.18,
        transmission: 0.12,
        transparent: true,
        opacity: 0.9,
        clearcoat: 1,
      }));
      const leaderMat = track(new THREE.MeshPhysicalMaterial({
        color: gold,
        emissive: gold,
        emissiveIntensity: 0.34,
        metalness: 0.6,
        roughness: 0.2,
        transparent: true,
        opacity: 0.9,
        clearcoat: 1,
      }));

      const towers: Array<{
        group: THREE_NS.Group;
        hit: THREE_NS.Mesh;
        index: number;
        baseScale: number;
      }> = [];
      const radius = 3.55;
      dimensions.forEach((dimension, index) => {
        const angle = -Math.PI / 2 + (index / dimensions.length) * Math.PI * 2;
        const group = new THREE.Group();
        group.position.set(Math.cos(angle) * radius, 0, Math.sin(angle) * radius);
        group.rotation.y = -angle;
        const ownHeight = 0.24 + clamp(dimension.theirs) * 0.036;
        const rivalHeight = 0.24 + clamp(dimension.leader) * 0.036;

        const makeTower = (height: number, x: number, material: THREE_NS.Material) => {
          const geometry = track(new THREE.BoxGeometry(0.42, height, 0.42, 1, 7, 1));
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(x, height / 2, 0);
          mesh.castShadow = true;
          group.add(mesh);
          const capGeo = track(new THREE.OctahedronGeometry(0.16, 0));
          const cap = new THREE.Mesh(capGeo, material);
          cap.position.set(x, height + 0.12, 0);
          group.add(cap);
        };
        makeTower(ownHeight, -0.3, prospectMat);
        makeTower(rivalHeight, 0.3, leaderMat);

        const identity = new THREE.Color(hueFor(dimension.key).to);
        const ringGeo = track(new THREE.RingGeometry(0.48, 0.62, 32));
        const ringMat = track(new THREE.MeshBasicMaterial({
          color: identity,
          transparent: true,
          opacity: 0.5,
          side: THREE.DoubleSide,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }));
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.015;
        group.add(ring);

        const hitGeo = track(new THREE.BoxGeometry(1.25, 4.4, 1.25));
        const hitMat = track(new THREE.MeshBasicMaterial({ visible: false }));
        const hit = new THREE.Mesh(hitGeo, hitMat);
        hit.position.y = 2.1;
        hit.userData.index = index;
        group.add(hit);
        world.add(group);
        towers.push({ group, hit, index, baseScale: 1 });
      });

      const particlesGeo = track(new THREE.BufferGeometry());
      const particleCount = 260;
      const positions = new Float32Array(particleCount * 3);
      for (let i = 0; i < particleCount; i++) {
        const r = 4.7 + Math.random() * 5;
        const a = Math.random() * Math.PI * 2;
        positions[i * 3] = Math.cos(a) * r;
        positions[i * 3 + 1] = Math.random() * 5 - 0.5;
        positions[i * 3 + 2] = Math.sin(a) * r;
      }
      particlesGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const particlesMat = track(new THREE.PointsMaterial({
        color: 0x7dd3fc,
        size: 0.035,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      const particles = new THREE.Points(particlesGeo, particlesMat);
      scene.add(particles);

      let composer: { render: () => void; setSize: (w: number, h: number) => void; dispose?: () => void } | null = null;
      const passDisposers: Array<() => void> = [];
      try {
        const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }] = await Promise.all([
          import("three/examples/jsm/postprocessing/EffectComposer.js"),
          import("three/examples/jsm/postprocessing/RenderPass.js"),
          import("three/examples/jsm/postprocessing/UnrealBloomPass.js"),
        ]);
        if (dead) return;
        const pipeline = new EffectComposer(renderer);
        const renderPass = new RenderPass(scene, camera);
        const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.72, 0.5, 0.18);
        pipeline.addPass(renderPass);
        pipeline.addPass(bloom);
        for (const pass of [renderPass, bloom]) {
          const dispose = (pass as { dispose?: () => void }).dispose;
          if (dispose) passDisposers.push(() => dispose.call(pass));
        }
        composer = pipeline;
      } catch {
        composer = null;
      }

      const resize = () => {
        const width = host.clientWidth || 1;
        const height = host.clientHeight || 1;
        renderer.setSize(width, height, false);
        composer?.setSize(width, height);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(host);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const pick = (event: PointerEvent) => {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.set(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        );
        raycaster.setFromCamera(pointer, camera);
        return raycaster.intersectObjects(towers.map((tower) => tower.hit), false)[0]?.object.userData.index as number | undefined;
      };
      let downX = 0;
      let lastX = 0;
      let dragging = false;
      let rotation = 0;
      let velocity = 0;
      const onDown = (event: PointerEvent) => {
        downX = lastX = event.clientX;
        dragging = true;
        renderer.domElement.setPointerCapture(event.pointerId);
        renderer.domElement.style.cursor = "grabbing";
      };
      const onMove = (event: PointerEvent) => {
        if (!dragging) return;
        const dx = event.clientX - lastX;
        rotation += dx * 0.006;
        velocity = dx * 0.006;
        lastX = event.clientX;
      };
      const onUp = (event: PointerEvent) => {
        if (dragging && Math.abs(event.clientX - downX) < 7) {
          const index = pick(event);
          if (typeof index === "number") setSelected(index);
        }
        dragging = false;
        renderer.domElement.style.cursor = "grab";
      };
      renderer.domElement.addEventListener("pointerdown", onDown);
      renderer.domElement.addEventListener("pointermove", onMove);
      renderer.domElement.addEventListener("pointerup", onUp);
      renderer.domElement.addEventListener("pointercancel", onUp);

      let raf = 0;
      let running = true;
      let last = performance.now();
      const look = new THREE.Vector3(0, 1.1, 0);
      const tick = () => {
        if (!running) return;
        const now = performance.now();
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        if (!dragging) {
          rotation += velocity * dt * 60;
          velocity *= Math.pow(0.92, dt * 60);
          if (Math.abs(velocity) < 0.00005) rotation += dt * 0.055;
        }
        const targetAngle = -Math.PI / 2 + (selectedRef.current / dimensions.length) * Math.PI * 2;
        if (!dragging && Math.abs(velocity) < 0.002) {
          const desired = -targetAngle;
          let delta = (desired - rotation) % (Math.PI * 2);
          if (delta > Math.PI) delta -= Math.PI * 2;
          if (delta < -Math.PI) delta += Math.PI * 2;
          rotation += delta * damp(0.035, dt);
        }
        world.rotation.y = rotation;
        particles.rotation.y = -rotation * 0.18 + now * 0.000012;
        towers.forEach((tower) => {
          const target = tower.index === selectedRef.current ? 1.2 : 1;
          tower.baseScale += (target - tower.baseScale) * damp(0.12, dt);
          tower.group.scale.setScalar(tower.baseScale);
        });
        camera.lookAt(look);
        if (composer) composer.render();
        else renderer.render(scene, camera);
        raf = requestAnimationFrame(tick);
      };
      tick();
      setLive(true);

      teardown = () => {
        running = false;
        cancelAnimationFrame(raf);
        observer.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onDown);
        renderer.domElement.removeEventListener("pointermove", onMove);
        renderer.domElement.removeEventListener("pointerup", onUp);
        renderer.domElement.removeEventListener("pointercancel", onUp);
        passDisposers.forEach((dispose) => dispose());
        composer?.dispose?.();
        disposables.forEach((item) => item.dispose());
        renderer.dispose();
        renderer.domElement.remove();
      };
    })();

    return () => {
      dead = true;
      setLive(false);
      teardown?.();
    };
  }, [dimensions, reduced]);

  const current = dimensions[selected] || dimensions[0];
  if (reduced || dimensions.length < 2) return null;

  return (
    <div className="relative mb-6 overflow-hidden rounded-xl border border-accent/20 bg-[#020817] shadow-[inset_0_1px_0_rgba(125,211,252,.12),0_22px_70px_rgba(2,8,23,.55)]">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_35%,rgba(14,165,233,.15),transparent_42%),linear-gradient(rgba(56,189,248,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(56,189,248,.025)_1px,transparent_1px)] bg-[size:auto,28px_28px,28px_28px]" />
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-accent/15 px-4 py-3">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-[0.22em] text-accent [font-family:var(--battle-display)]">Competitive arena · live 3D</p>
          <p className="mt-1 text-xs text-fg-dim">Drag to orbit · tap a tower pair to inspect</p>
        </div>
        <div className="flex items-center gap-3 text-[10px] uppercase tracking-[0.12em] [font-family:var(--battle-data)]">
          <span className="flex items-center gap-1.5 text-fg-muted"><i className="h-1.5 w-5 rounded-full bg-cyan-400 shadow-[0_0_9px_#22d3ee]" />{prospectName}</span>
          <span className="flex items-center gap-1.5 text-fg-muted"><i className="h-1.5 w-5 rounded-full bg-amber-300 shadow-[0_0_9px_#fbbf24]" />{competitorName}</span>
        </div>
      </div>
      <div ref={hostRef} className="relative h-[340px] w-full sm:h-[410px]" aria-hidden />
      {!live && <div className="absolute inset-x-0 top-16 bottom-16 grid place-items-center text-xs text-fg-dim">Initializing spatial comparison…</div>}
      <div className="relative z-10 grid gap-3 border-t border-accent/15 bg-slate-950/72 px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-fg-muted [font-family:var(--battle-display)]">Focused vector</p>
          <p className="mt-1 text-sm font-semibold text-fg">{current.label}</p>
        </div>
        <p className="text-sm tabular-nums text-fg-muted [font-family:var(--battle-data)]">
          <span className="text-cyan-300">{current.theirs}</span>
          <span className="px-2 text-fg-dim">vs</span>
          <span className="text-amber-200">{current.leader}</span>
          <span className="ml-3 text-fg">{current.diff > 0 ? "+" : ""}{current.diff}</span>
        </p>
      </div>
      <div className="relative z-10 flex gap-1 overflow-x-auto border-t border-accent/10 px-3 py-2">
        {dimensions.map((dimension, index) => (
          <button
            key={dimension.key}
            type="button"
            onClick={() => setSelected(index)}
            aria-pressed={selected === index}
            className="shrink-0 rounded-md border px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-[0.1em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            style={{
              borderColor: selected === index ? hueFor(dimension.key).to : "rgba(51,65,85,.75)",
              color: selected === index ? hueFor(dimension.key).to : "rgb(148 163 184)",
              background: selected === index ? `${hueFor(dimension.key).to}14` : "rgba(15,23,42,.45)",
            }}
          >
            {dimension.label}
          </button>
        ))}
      </div>
    </div>
  );
}
