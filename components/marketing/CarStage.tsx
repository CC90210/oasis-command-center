"use client";

import { useEffect, useRef } from "react";
import { CAR_SPECS, BODY_SHOTS, type Station } from "@/lib/marketing/car-geometry";
import { ENGINES } from "@/lib/marketing/harness";
// Types only — erased at compile time, so this does NOT pull three.js into
// the bundle. The runtime copy arrives via the dynamic import below.
import type * as ThreeNS from "three";

/**
 * The 3D stage for the harness builder.
 *
 * Loads three.js dynamically, so ~150KB of WebGL runtime is fetched only
 * when this section actually scrolls into view — it is well below the
 * fold, and the homepage's first paint must not wait on it. Until then,
 * and forever on a machine without WebGL, the SVG blueprint underneath
 * stays visible.
 *
 * WHAT MAKES IT LOOK LIKE A CAR RATHER THAN A BOX
 *
 * The body is lofted from cross-sections (see lib/marketing/car-geometry.ts)
 * with superellipse corners, so it has real automotive surfacing: square
 * sills, round roof, tapered nose, wide hips. Two lofts — body and
 * greenhouse — plus wheels.
 *
 * Lighting does the rest and is where the drama comes from: a cool key,
 * a hard cyan rim raking the shoulder line from behind, and a fill light
 * COLOURED BY THE SELECTED ENGINE, throwing that model's colour up through
 * the car from underneath. Changing the engine visibly changes the light
 * in the room, which is the tie between the two selectors the flat version
 * never had.
 *
 * CAMERA. Each body has its own framing, and selecting one flies there
 * with eased interpolation rather than cutting. Changing the engine pushes
 * the camera in toward that car's engine bay, holds, then pulls back to
 * the body's framing — a cinematic beat that also tells you where the
 * engine physically is (note the mid-engine coupe's bay is behind the
 * cabin, not under a hood).
 *
 * Reduced motion: no idle rotation, no flight — the camera jumps straight
 * to each framing.
 */

type Props = {
  bodyId: string;
  engineId: string;
  /** Hex for the engine's fill light. */
  engineColor: string;
  /** Fires once the first frame is on screen, so the caller can retire the
   *  SVG fallback. Without it both drawings render at once and the flat
   *  outline sits on top of the render. */
  onReady?: () => void;
};

/** One closed cross-section outline as 3D points. */
function sectionPoints(s: Station, segments: number) {
  const pts: [number, number, number][] = [];
  const n = 2 / s.squareness;
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t);
    const si = Math.sin(t);
    // Superellipse: |cos|^n keeps the corners square-ish without the
    // discontinuity a rounded-rect extrusion would give at the seams.
    const z = s.w * Math.sign(c) * Math.pow(Math.abs(c), n);
    const y = s.y + s.h * Math.sign(si) * Math.pow(Math.abs(si), n);
    pts.push([s.x, y, z]);
  }
  return pts;
}

export function CarStage({ bodyId, engineId, engineColor, onReady }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  // Latest selection, readable from inside the animation loop without
  // tearing it down and rebuilding on every click.
  const sel = useRef({ bodyId, engineId, engineColor, dirtyBody: true, dirtyEngine: false });

  useEffect(() => {
    sel.current.dirtyBody = sel.current.bodyId !== bodyId;
    sel.current.dirtyEngine = sel.current.engineId !== engineId;
    sel.current.bodyId = bodyId;
    sel.current.engineId = engineId;
    sel.current.engineColor = engineColor;
  }, [bodyId, engineId, engineColor]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    let disposed = false;
    let cleanup: (() => void) | undefined;

    (async () => {
      // WebGL check before paying for the import.
      try {
        const probe = document.createElement("canvas");
        if (!probe.getContext("webgl2") && !probe.getContext("webgl")) return;
      } catch {
        return;
      }

      const THREE = await import("three");
      if (disposed) return;

      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      mount.appendChild(renderer.domElement);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      renderer.domElement.style.display = "block";

      // ── Lighting ──────────────────────────────────────────────────
      // Hemisphere gives the body a sky/ground gradient, which is most of
      // what makes a curved panel read as metal rather than as flat fill.
      // Exposure budget. The first pass stacked a hemisphere, an ambient,
      // a key and two rims at showroom intensities and blew the whole car
      // out to a white blob. A dark car on a dark stage needs LESS light
      // than instinct says — the shape comes from a couple of hard
      // highlights tracing the edges, not from filling the surface.
      scene.add(new THREE.HemisphereLight(0x9fd4e8, 0x05070a, 0.55));
      scene.add(new THREE.AmbientLight(0x223040, 0.35));

      const key = new THREE.DirectionalLight(0xffffff, 1.5);
      key.position.set(4.5, 6.5, 4.5);
      scene.add(key);

      // Hard cyan rim raking the shoulder line from behind — the single
      // light doing the most work in the shot.
      const rim = new THREE.DirectionalLight(0x00d4ff, 2.2);
      rim.position.set(-5, 2.4, -4);
      scene.add(rim);

      // Second rim from the opposite quarter so the far side of the body
      // separates from the background instead of dissolving into it.
      const rim2 = new THREE.DirectionalLight(0x7fd8ff, 0.8);
      rim2.position.set(2, 1.2, -5);
      scene.add(rim2);

      // Coloured by the selected engine — the visual link between the two
      // pickers. Sits low so it washes up the sills and under the arches.
      // Short range on purpose: it should pool around the bay, not light
      // the whole car.
      const engineLight = new THREE.PointLight(new THREE.Color(engineColor), 3.2, 3.4, 2);
      engineLight.position.set(0, 0.25, 0);
      scene.add(engineLight);

      // ── Car ───────────────────────────────────────────────────────
      const carGroup = new THREE.Group();
      scene.add(carGroup);

      // Contact shadow. Without something under it the car reads as
      // floating in a void; a soft dark ellipse on the ground plane is
      // what tells the eye where the ground is.
      const shadowMat = new THREE.MeshBasicMaterial({
        color: 0x000000,
        transparent: true,
        opacity: 0.55,
      });
      const shadow = new THREE.Mesh(new THREE.CircleGeometry(2.6, 48), shadowMat);
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.002;
      shadow.scale.set(1, 0.42, 1);
      scene.add(shadow);

      // Dark metallic, but light enough to hold a highlight. At the near-
      // black it started on, every lit face crushed to the background and
      // only the wireframe was visible — a wireframe toy, not a car.
      // DoubleSide is load-bearing, not a shortcut. The loft stitches each
      // ring to the next in a fixed order, so triangle winding flips
      // wherever a section's radius crosses its neighbour's. With the
      // default FrontSide those triangles are culled and you look straight
      // through the car at its own inside — the body rendered as a ghost.
      const paint = new THREE.MeshStandardMaterial({
        color: 0x1c242f,
        metalness: 0.86,
        roughness: 0.32,
        side: THREE.DoubleSide,
        // Transparent from the start so the x-ray during an engine dive is
        // an opacity tween rather than a material swap mid-render. The
        // engine lives INSIDE the bodywork, which is correct and also means
        // it is invisible until the panels get out of the way.
        transparent: true,
        opacity: 1,
      });
      // Roughness this low turns the greenhouse into a mirror and it
      // catches the rim light as one flat blown-out panel.
      const glass = new THREE.MeshStandardMaterial({
        color: 0x0a1620,
        metalness: 0.45,
        roughness: 0.22,
        transparent: true,
        opacity: 0.34,
      });
      const rubber = new THREE.MeshStandardMaterial({
        color: 0x07090c,
        metalness: 0.1,
        roughness: 0.85,
      });
      // A hint of blueprint through the paint. Any higher and it stops
      // being a finished surface with engineering showing through, and
      // starts being a mesh preview.
      const wireMat = new THREE.LineBasicMaterial({
        color: 0x00d4ff,
        transparent: true,
        opacity: 0.09,
      });

      // Hoisted out of buildCar deliberately. Created in the wheel loop it
      // allocated four fresh GPU materials on EVERY body swap and disposed
      // none of them — a leak that grows for as long as someone plays with
      // the picker. Materials here are shared and disposed once.
      const hubMat = new THREE.MeshStandardMaterial({
        color: 0x00d4ff,
        emissive: 0x00d4ff,
        emissiveIntensity: 1.4,
        metalness: 0.4,
        roughness: 0.3,
      });

      /** Loft consecutive cross-sections into a closed surface. */
      function loft(stations: Station[], segments = 40) {
        const rings = stations.map((s) => sectionPoints(s, segments));
        const pos: number[] = [];
        for (let i = 0; i < rings.length - 1; i++) {
          for (let j = 0; j < segments; j++) {
            const k = (j + 1) % segments;
            const a = rings[i][j], b = rings[i][k];
            const c = rings[i + 1][k], d = rings[i + 1][j];
            pos.push(...a, ...b, ...c);
            pos.push(...a, ...c, ...d);
          }
        }
        // Cap both ends so the body reads solid from the front and rear.
        for (const [ring, flip] of [[rings[0], true], [rings[rings.length - 1], false]] as const) {
          const cx = ring.reduce((t, p) => t + p[0], 0) / ring.length;
          const cy = ring.reduce((t, p) => t + p[1], 0) / ring.length;
          for (let j = 0; j < segments; j++) {
            const k = (j + 1) % segments;
            const a = ring[j], b = ring[k];
            if (flip) pos.push(cx, cy, 0, ...b, ...a);
            else pos.push(cx, cy, 0, ...a, ...b);
          }
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.computeVertexNormals();
        return g;
      }

      let parts: ThreeNS.Object3D[] = [];
      // Materials whose colour depends on the current selection, so they
      // genuinely cannot be shared across builds. Tracked explicitly and
      // disposed on the next rebuild — the same leak the hub material had.
      let perBuildMats: ThreeNS.Material[] = [];

      function buildCar(id: string) {
        for (const p of parts) {
          carGroup.remove(p);
          p.traverse((o: ThreeNS.Object3D) => {
            const m = o as ThreeNS.Mesh;
            if (m.geometry) m.geometry.dispose();
          });
        }
        parts = [];
        perBuildMats.forEach((m) => m.dispose());
        perBuildMats = [];

        const spec = CAR_SPECS[id] ?? CAR_SPECS.bravo;

        const bodyGeo = loft(spec.body);
        const bodyMesh = new THREE.Mesh(bodyGeo, paint);
        carGroup.add(bodyMesh);
        parts.push(bodyMesh);

        // Hairline wireframe over the paint: the blueprint showing through
        // the finished surface. Subtle — 24% opacity — so it reads as
        // engineering rather than as a wireframe toy.
        const wire = new THREE.LineSegments(new THREE.WireframeGeometry(bodyGeo), wireMat);
        carGroup.add(wire);
        parts.push(wire);

        const cabinMesh = new THREE.Mesh(loft(spec.cabin, 32), glass);
        carGroup.add(cabinMesh);
        parts.push(cabinMesh);

        // Widest half-width in the body, so the wheels sit in the arches
        // rather than inside the bodywork. The first pass hard-coded 1.02
        // and subtracted half the tyre width, which buried every wheel
        // inside a body that is itself ~1.05 wide — four tyres completely
        // hidden inside the car.
        const maxHalfWidth = Math.max(...spec.body.map((s) => s.w));

        for (const axle of spec.axles) {
          for (const side of [-1, 1]) {
            const tyre = new THREE.Mesh(
              new THREE.CylinderGeometry(axle.radius, axle.radius, axle.width, 32),
              rubber,
            );
            tyre.rotation.x = Math.PI / 2;
            // Sit the tyre's outer face just proud of the widest panel.
            tyre.position.set(axle.x, axle.radius, side * (maxHalfWidth - axle.width * 0.35));
            carGroup.add(tyre);
            parts.push(tyre);

            const rimMat = new THREE.MeshStandardMaterial({
              color: spec.wheel.tint,
              emissive: spec.wheel.tint,
              emissiveIntensity: 0.9,
              metalness: 0.5,
              roughness: 0.3,
            });
            perBuildMats.push(rimMat);

            const hub = new THREE.Mesh(
              new THREE.TorusGeometry(axle.radius * 0.52, 0.035 * spec.wheel.rimDepth, 8, 28),
              rimMat,
            );
            hub.position.copy(tyre.position);
            hub.position.z += side * (axle.width / 2 + 0.005);
            carGroup.add(hub);
            parts.push(hub);

            // Spokes. Different counts per body are the cheapest way to
            // make two cars distinguishable at the corners, which is where
            // people actually look to tell models apart.
            for (let s = 0; s < spec.wheel.spokes; s++) {
              const spoke = new THREE.Mesh(
                new THREE.BoxGeometry(axle.radius * 0.92, 0.045, 0.03),
                rimMat,
              );
              spoke.position.copy(hub.position);
              spoke.rotation.z = (s / spec.wheel.spokes) * Math.PI * 2;
              carGroup.add(spoke);
              parts.push(spoke);
            }
          }
        }

        // ── Body-specific hardware ──────────────────────────────────
        const f = spec.features;
        const rearX = spec.body[0].x;

        if (f.wing) {
          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 1.9), paint);
          blade.position.set(rearX + 0.18, 1.16, 0);
          blade.rotation.z = -0.09;
          carGroup.add(blade);
          parts.push(blade);
          for (const side of [-1, 1]) {
            const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.4, 0.07), paint);
            strut.position.set(rearX + 0.18, 0.95, side * 0.7);
            carGroup.add(strut);
            parts.push(strut);
          }
        }

        if (f.rails) {
          for (const side of [-1, 1]) {
            const rail = new THREE.Mesh(new THREE.BoxGeometry(2.1, 0.055, 0.075), paint);
            rail.position.set(-0.35, 1.5, side * 0.6);
            carGroup.add(rail);
            parts.push(rail);
          }
        }

        if (f.skirts) {
          for (const side of [-1, 1]) {
            const skirt = new THREE.Mesh(new THREE.BoxGeometry(3.0, 0.12, 0.09), paint);
            skirt.position.set(0, 0.2, side * (maxHalfWidth - 0.03));
            carGroup.add(skirt);
            parts.push(skirt);
          }
        }

        if (f.exposedFrame) {
          // A roll hoop, so the unbuilt slot reads as a chassis waiting for
          // bodywork rather than as a plainer car.
          const hoop = new THREE.Mesh(
            new THREE.TorusGeometry(0.62, 0.045, 8, 24, Math.PI),
            hubMat,
          );
          hoop.position.set(-0.7, 1.05, 0);
          hoop.rotation.y = Math.PI / 2;
          carGroup.add(hoop);
          parts.push(hoop);
        }

        return spec;
      }

      /**
       * The engine, as actual hardware in the bay.
       *
       * Recolouring a light was not a visible change, and CC was right to
       * say so. Cylinder count, bank angle, block size and exhaust count
       * all come from the selected engine, so a V12 is unmistakably not an
       * inline four, and the electric pack has no cylinders and no pipes
       * at all.
       */
      let engineParts: ThreeNS.Object3D[] = [];
      let engineMats: ThreeNS.Material[] = [];

      function buildEngine(engineId: string, carSpec: (typeof CAR_SPECS)[string]) {
        for (const p of engineParts) {
          carGroup.remove(p);
          p.traverse((o: ThreeNS.Object3D) => {
            const m = o as ThreeNS.Mesh;
            if (m.geometry) m.geometry.dispose();
          });
        }
        engineParts = [];
        engineMats.forEach((m) => m.dispose());
        engineMats = [];

        const eng = ENGINES.find((e) => e.id === engineId) ?? ENGINES[0];
        const [bx, by, bz] = carSpec.engineBay;
        const col = new THREE.Color(eng.glow);

        const blockMat = new THREE.MeshStandardMaterial({
          color: 0x14181f,
          metalness: 0.9,
          roughness: 0.35,
        });
        const hotMat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: 2.2,
          metalness: 0.3,
          roughness: 0.4,
        });
        engineMats.push(blockMat, hotMat);

        const add = (m: ThreeNS.Object3D) => {
          carGroup.add(m);
          engineParts.push(m);
        };

        if (eng.layout === "electric") {
          // A flat pack instead of a block. The absence of cylinders is
          // the message.
          const pack = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.16, 1.15), blockMat);
          pack.position.set(bx, by - 0.12, bz);
          add(pack);
          for (let i = 0; i < 4; i++) {
            const cell = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 1.0), hotMat);
            cell.position.set(bx - 0.33 + i * 0.22, by - 0.02, bz);
            add(cell);
          }
        } else {
          const block = new THREE.Mesh(
            new THREE.BoxGeometry(eng.cylinders >= 8 ? 0.85 : 0.6, 0.3, 0.5),
            blockMat,
          );
          block.position.set(bx, by - 0.06, bz);
          add(block);

          // Cylinders, arranged by bank angle: 0 is a single inline row,
          // 180 lays two rows flat, anything between is a V.
          const perBank = eng.bank === 0 ? eng.cylinders : eng.cylinders / 2;
          const banks = eng.bank === 0 ? [0] : [-1, 1];
          const half = THREE.MathUtils.degToRad(eng.bank) / 2;

          for (const b of banks) {
            for (let i = 0; i < perBank; i++) {
              const cyl = new THREE.Mesh(
                new THREE.CylinderGeometry(0.055, 0.055, 0.26, 12),
                hotMat,
              );
              const spread = perBank > 1 ? (i / (perBank - 1) - 0.5) : 0;
              cyl.position.set(
                bx + spread * (eng.cylinders >= 8 ? 0.62 : 0.44),
                // Sits inside the bay, not proud of the deck. It was
                // poking through the bonnet at +0.14.
                by + 0.04,
                bz + b * Math.sin(half) * 0.24,
              );
              cyl.rotation.x = b * half;
              add(cyl);
            }
          }
        }

        // Exhaust tips at the rear valance.
        const tailX = carSpec.body[0].x - 0.04;
        for (let i = 0; i < eng.exhausts; i++) {
          const offset = eng.exhausts === 1 ? 0 : (i / (eng.exhausts - 1) - 0.5) * 0.72;
          const pipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.055, 0.06, 0.16, 14),
            hotMat,
          );
          pipe.rotation.z = Math.PI / 2;
          // Tucked into the rear valance rather than hanging below it.
          pipe.position.set(tailX, 0.44, offset);
          add(pipe);
        }
      }

      let spec = buildCar(sel.current.bodyId);
      buildEngine(sel.current.engineId, spec);

      // ── Camera choreography ───────────────────────────────────────
      const camPos = new THREE.Vector3();
      const camAt = new THREE.Vector3();
      const targetPos = new THREE.Vector3();
      const targetAt = new THREE.Vector3();

      function frameBody(id: string) {
        const shot = BODY_SHOTS[id] ?? BODY_SHOTS.bravo;
        targetPos.set(...shot.pos);
        targetAt.set(...shot.at);
      }
      frameBody(sel.current.bodyId);
      camPos.copy(targetPos);
      camAt.copy(targetAt);

      /** Frames left of an engine-bay push-in before returning to the body shot. */
      let diveFrames = 0;

      // Re-bound after the await: TypeScript drops the outer null-narrowing
      // across the async boundary, and `mount!` at four call sites is worse
      // than one honest local.
      const el: HTMLDivElement = mount;

      function resize() {
        const w = el.clientWidth || 1;
        const h = el.clientHeight || 1;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
      resize();
      const ro = new ResizeObserver(resize);
      ro.observe(mount);

      // Only burn frames while the stage is actually on screen.
      let visible = true;
      const io = new IntersectionObserver(
        (entries) => entries.forEach((e) => (visible = e.isIntersecting)),
        { threshold: 0.05 },
      );
      io.observe(mount);

      // ── Drag to orbit ─────────────────────────────────────────────
      // Pointer Events, so one code path covers mouse, trackpad, pen and
      // touch. `touch-action: none` on the canvas is what stops a finger
      // drag scrolling the page instead of turning the car; without it the
      // whole interaction is unusable on a phone.
      let spin = 0;          // user-applied rotation, radians
      let spinVel = 0;       // carries the throw after release
      let dragging = false;
      let lastX = 0;
      let dragged = false;   // true once a drag has happened, killing idle sway

      const canvasEl = renderer.domElement;
      canvasEl.style.touchAction = "none";
      canvasEl.style.cursor = "grab";

      const onDown = (e: PointerEvent) => {
        dragging = true;
        dragged = true;
        lastX = e.clientX;
        spinVel = 0;
        canvasEl.style.cursor = "grabbing";
        canvasEl.setPointerCapture(e.pointerId);
      };
      const onMove = (e: PointerEvent) => {
        if (!dragging) return;
        const dx = e.clientX - lastX;
        lastX = e.clientX;
        spin += dx * 0.008;
        spinVel = dx * 0.008;
      };
      const onUp = (e: PointerEvent) => {
        dragging = false;
        canvasEl.style.cursor = "grab";
        try {
          canvasEl.releasePointerCapture(e.pointerId);
        } catch {
          /* pointer already released */
        }
      };
      canvasEl.addEventListener("pointerdown", onDown);
      canvasEl.addEventListener("pointermove", onMove);
      canvasEl.addEventListener("pointerup", onUp);
      canvasEl.addEventListener("pointercancel", onUp);

      let raf = 0;
      let t = 0;
      // Declared before tick rather than after it. It worked either way —
      // the closure only runs once tick() is called — but reading a
      // variable declared twenty lines below its use is a trap for the
      // next person.
      let announced = false;
      const tick = () => {
        raf = requestAnimationFrame(tick);
        if (!visible) return;

        if (sel.current.dirtyBody) {
          sel.current.dirtyBody = false;
          spec = buildCar(sel.current.bodyId);
          // The engine has to be rebuilt too: the bay moved with the body,
          // and on the mid-engine coupe it moved to the other end of the car.
          buildEngine(sel.current.engineId, spec);
          frameBody(sel.current.bodyId);
          diveFrames = 0;
        }

        if (sel.current.dirtyEngine) {
          sel.current.dirtyEngine = false;
          engineLight.color.set(sel.current.engineColor);
          buildEngine(sel.current.engineId, spec);
          // Push in on the bay, hold, then the easing below pulls back.
          diveFrames = reduced ? 0 : 96;
        }

        engineLight.position.set(spec.engineBay[0], spec.engineBay[1], spec.engineBay[2]);

        if (diveFrames > 0) {
          diveFrames--;
          const [ex, ey, ez] = spec.engineBay;
          // Close enough to read individual cylinders. The previous framing
          // hung back at showroom distance and the whole point of the dive,
          // seeing the hardware change, was lost at that range.
          targetPos.set(ex + 0.95, ey + 0.62, ez + 1.35);
          targetAt.set(ex, ey + 0.05, ez);
          if (diveFrames === 0) frameBody(sel.current.bodyId);
        }

        // X-ray the bodywork while diving. The engine is genuinely inside
        // the car, so without this the camera flies in and shows you a
        // closed panel. Eased both ways so panels dissolve and re-form
        // rather than blinking.
        const wantOpacity = diveFrames > 0 ? 0.16 : 1;
        paint.opacity += (wantOpacity - paint.opacity) * (reduced ? 1 : 0.08);
        glass.opacity = 0.34 * paint.opacity;

        if (reduced) {
          camPos.copy(targetPos);
          camAt.copy(targetAt);
        } else {
          camPos.lerp(targetPos, 0.045);
          camAt.lerp(targetAt, 0.06);
          t += 0.006;
        }

        // Idle sway until the visitor takes hold, then it is theirs. Coming
        // back to swaying under someone's finger would feel like the car
        // fighting them.
        if (!dragging) {
          spin += spinVel;
          spinVel *= 0.94; // inertia, so a flick coasts to a stop
        }
        carGroup.rotation.y = dragged ? spin : Math.sin(t) * 0.16;

        camera.position.copy(camPos);
        camera.lookAt(camAt);
        renderer.render(scene, camera);

        if (!announced) {
          announced = true;
          readyRef.current?.();
        }
      };
      tick();

      cleanup = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        io.disconnect();
        canvasEl.removeEventListener("pointerdown", onDown);
        canvasEl.removeEventListener("pointermove", onMove);
        canvasEl.removeEventListener("pointerup", onUp);
        canvasEl.removeEventListener("pointercancel", onUp);
        engineParts.forEach((p) =>
          p.traverse((o: ThreeNS.Object3D) => {
            const m = o as ThreeNS.Mesh;
            if (m.geometry) m.geometry.dispose();
          }),
        );
        [...engineMats, ...perBuildMats].forEach((m) => m.dispose());
        scene.traverse((o: ThreeNS.Object3D) => {
          const m = o as ThreeNS.Mesh;
          if (m.geometry) m.geometry.dispose();
        });
        // Every material created in this effect, not just the obvious four.
        [paint, glass, rubber, wireMat, hubMat, shadowMat].forEach((m) => m.dispose());
        renderer.dispose();
        if (renderer.domElement.parentNode === mount) {
          mount.removeChild(renderer.domElement);
        }
      };
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
    // Built once. Selection changes flow through the `sel` ref so a click
    // never tears down the WebGL context.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div ref={mountRef} className="absolute inset-0 cursor-grab" aria-hidden="true" />;
}
