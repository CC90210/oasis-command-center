"use client";

import { useEffect, useRef } from "react";
import {
  CAR_SPECS,
  BODY_SHOTS,
  engineAnchor,
  flankPoint,
  nearestStation,
  resampleStations,
  runHeight,
  surfaceHalfWidth,
  CAMERA_FOV,
  DIVE_OFFSET,
  LOFT_RINGS,
  MOUNT,
  type Station,
} from "@/lib/marketing/car-geometry";
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

/**
 * Detach objects from their parent and free every GPU resource they own.
 *
 * Extracted because this exact traversal appeared FOUR times — in both
 * rebuild paths and twice in teardown — and duplicated cleanup is precisely
 * where the wheel-hub material leak hid last time. One helper means a newly
 * added kind of part can only be forgotten in one place instead of four.
 */
function releaseParts(
  objs: ThreeNS.Object3D[],
  mats: ThreeNS.Material[],
  parent?: ThreeNS.Object3D,
) {
  for (const o of objs) {
    parent?.remove(o);
    o.traverse((child: ThreeNS.Object3D) => {
      const mesh = child as ThreeNS.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
  }
  for (const m of mats) m.dispose();
}

/** One closed cross-section outline as 3D points. */
/**
 * Resting emissive of the glowing engine hardware. Named because the
 * animation loop drives it — a duplicated literal here means changing the
 * material does nothing, since the loop overwrites it on the next frame.
 */
const HOT_EMISSIVE = 2.2;

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
      // near at 1.0 rather than 0.1: the subject never comes closer than a
      // couple of units even during the engine dive, and a 10x tighter near
      // plane buys depth precision that the neon-on-bodywork contact needs.
      const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.25, 200);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      // Filmic response curve. Without tone mapping, everything above 1.0
      // clips flat and a dark car with bright neon renders as black shapes
      // with blown-out stripes — no roll-off in either direction, which is
      // most of why it read as "computer graphics" rather than "photograph".
      // AgX rather than ACES. ACES desaturates saturated colour toward
      // white as it rolls off, which turned the brand cyan into a pale
      // white-blue exactly where the neon is brightest — the one colour on
      // the page that must not drift. AgX holds hue into the highlight.
      renderer.toneMapping = THREE.AgXToneMapping;
      // 1.15 was tuned while an AmbientLight was still lifting the shadow
      // side. With that gone the body fell to near-black silhouette — the
      // env map alone carries the fill now, and it needs the headroom.
      renderer.toneMappingExposure = 1.75;

      // ── Studio environment ────────────────────────────────────────
      // The biggest single miss in the previous build: there was no
      // environment map at all. Car paint is almost entirely REFLECTION —
      // a dark metallic surface with nothing to reflect has no information
      // in it, which is exactly why the body read as a flat silhouette no
      // matter how the lights were tuned.
      //
      // Built procedurally, so it stays asset-free: a dark room with large
      // emissive softbox panels overhead and long cyan strip lights down
      // both flanks, rendered through PMREMGenerator into a prefiltered
      // cube map. Those strips are what will rake along the shoulder line
      // and read as automotive.
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();

      const envScene = new THREE.Scene();
      envScene.background = new THREE.Color(0x05070b);
      const envMats: ThreeNS.Material[] = [];
      const panel = (
        w: number,
        h: number,
        d: number,
        color: number,
        intensity: number,
        pos: [number, number, number],
        rot: [number, number, number],
      ) => {
        // toneMapped:false so the bake keeps values above 1.0. Tone mapping
        // the light sources themselves would compress them to grey cards
        // before they ever reach the cube map, and the reflections would
        // come back dull no matter how high the intensity was set.
        const m = new THREE.MeshBasicMaterial({ color, toneMapped: false });
        m.color.multiplyScalar(intensity);
        envMats.push(m);
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
        mesh.position.set(...pos);
        mesh.rotation.set(...rot);
        envScene.add(mesh);
      };

      // Overhead softboxes — the broad highlight down the centre of the roof.
      // Intensities carry more now that AmbientLight and HemisphereLight
      // are gone: the environment is the fill, not a supplement to it.
      panel(9, 0.1, 3.2, 0xffffff, 7.0, [0, 6, 0], [0, 0, 0]);
      panel(6, 0.1, 2.0, 0xdff2ff, 3.6, [0, 5.4, -4], [0.5, 0, 0]);
      // Flank strip lights — the long specular streaks along the body sides.
      panel(0.16, 0.16, 14, 0x00d4ff, 6.0, [-5.5, 2.6, 0], [0, 0, 0]);
      panel(0.16, 0.16, 14, 0x00d4ff, 6.0, [5.5, 2.6, 0], [0, 0, 0]);
      panel(0.14, 0.14, 12, 0x7fe6ff, 3.0, [-3.2, 4.6, 0], [0, 0, 0]);
      panel(0.14, 0.14, 12, 0x7fe6ff, 3.0, [3.2, 4.6, 0], [0, 0, 0]);
      // A cool floor bounce, so the sills and underbody are not dead black.
      panel(16, 0.1, 16, 0x0a1a24, 1.9, [0, -1.2, 0], [0, 0, 0]);

      const envRT = pmrem.fromScene(envScene, 0.04);
      scene.environment = envRT.texture;
      envScene.traverse((o: ThreeNS.Object3D) => {
        const m = o as ThreeNS.Mesh;
        if (m.geometry) m.geometry.dispose();
      });
      envMats.forEach((m) => m.dispose());
      pmrem.dispose();
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
      // No HemisphereLight either. Like AmbientLight it feeds only the
      // indirect DIFFUSE term and contributes zero specular, so on a
      // metallic surface it cannot produce a highlight — it just raises the
      // floor and flattens the panel it was supposed to be shaping. The
      // comment that used to live here claimed the opposite.
      // No AmbientLight. It was here to lift the shadow side, which is what
      // scene.environment now does — and does directionally, from the
      // softboxes and floor bounce. A flat ambient term added on top only
      // washes out the contrast that makes the panels read as curved.

      // Directionals are now accents on top of the environment, not the
      // main source. At their old intensities they buried the env map's
      // contribution and put a hard round hotspot where the reference has
      // a long soft streak — a DirectionalLight cannot produce a streak.
      const key = new THREE.DirectionalLight(0xffffff, 0.55);
      key.position.set(4.5, 6.5, 4.5);
      scene.add(key);

      // Hard cyan rim raking the shoulder line from behind — the single
      // light doing the most work in the shot.
      const rim = new THREE.DirectionalLight(0x00d4ff, 0.7);
      rim.position.set(-5, 2.4, -4);
      scene.add(rim);

      // Second rim from the opposite quarter so the far side of the body
      // separates from the background instead of dissolving into it.
      const rim2 = new THREE.DirectionalLight(0x7fd8ff, 0.25);
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
      shadow.position.set(0, 0.002, 0);
      // Elliptical is right for a shadow — a car is longer than it is wide —
      // but it must be centred on the origin and scaled along the car's own
      // length axis, which after the -90° X rotation is local X.
      shadow.scale.set(1, 0.45, 1);
      scene.add(shadow);

      // Wet floor. The reference sits the car on a dark reflective surface,
      // and the pooled light under it is doing as much work as the car. A
      // true planar reflection means rendering the scene twice; an additive
      // radial pool costs one transparent quad and reads the same at this
      // camera distance.
      // Radial falloff painted into a texture rather than a flat disc.
      // A uniform circle has a hard rim, and a hard rim on the ground reads
      // as a grey plate the car is parked on — which is precisely how it
      // looked once tone mapping lifted the midtones. A gradient has no
      // edge to notice.
      const floorCanvas = document.createElement("canvas");
      floorCanvas.width = floorCanvas.height = 256;
      const fctx = floorCanvas.getContext("2d")!;
      const grad = fctx.createRadialGradient(128, 128, 8, 128, 128, 128);
      grad.addColorStop(0, "rgba(0,212,255,0.55)");
      grad.addColorStop(0.35, "rgba(0,150,200,0.22)");
      grad.addColorStop(1, "rgba(0,0,0,0)");
      fctx.fillStyle = grad;
      fctx.fillRect(0, 0, 256, 256);
      const floorTex = new THREE.CanvasTexture(floorCanvas);

      const floorMat = new THREE.MeshBasicMaterial({
        map: floorTex,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      // Circular and centred on the origin, so the pool stays symmetrical
      // under the car from any camera angle. The previous ellipse (scaled
      // 0.55 on one axis) read as a tilted, off-centre platform because its
      // long axis never lined up with wherever the camera happened to be.
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(7.6, 7.6), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, 0.001, 0);
      scene.add(floor);

      // Dark metallic, but light enough to hold a highlight. At the near-
      // black it started on, every lit face crushed to the background and
      // only the wireframe was visible — a wireframe toy, not a car.
      // DoubleSide is load-bearing, not a shortcut. The loft stitches each
      // ring to the next in a fixed order, so triangle winding flips
      // wherever a section's radius crosses its neighbour's. With the
      // default FrontSide those triangles are culled and you look straight
      // through the car at its own inside — the body rendered as a ghost.
      // Automotive paint: a dark base with a separate clear lacquer on top.
      // MeshStandardMaterial cannot express that — it has one roughness for
      // the whole surface, so it renders either as dull plastic or as a
      // mirror, never as a deep coat over a matte carbon base. Clearcoat is
      // a second, much smoother specular lobe layered over the base, which
      // is what produces the tight highlight running along a car's shoulder
      // while the body itself stays dark.
      const paint = new THREE.MeshPhysicalMaterial({
        // True carbon black. It was lifted to a grey-blue only to stop the
        // body reading as a silhouette back when there was nothing lighting
        // it — that was compensating for the missing environment, and with
        // the environment doing its job the compensation makes it look like
        // primer instead of paint. Dark base, bright reflections.
        color: 0x05070a,
        metalness: 0.5,
        roughness: 0.38,
        // clearcoatRoughness is the money value: this is the tight second
        // specular lobe that reads as lacquer over pigment. Stay in
        // 0.03-0.08; above that it stops being wet.
        clearcoat: 1,
        clearcoatRoughness: 0.045,
        envMapIntensity: 1.35,
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
      // Resting opacity of the greenhouse. Named, because the animation loop
      // scales it against the paint's x-ray fade every frame — and when that
      // multiplier was a hardcoded 0.34, raising this value to 0.42 for the
      // new physical material did precisely nothing: the loop overwrote it on
      // the first frame and every frame after.
      const GLASS_OPACITY = 0.42;

      const glass = new THREE.MeshPhysicalMaterial({
        color: 0x060d14,
        metalness: 0.2,
        roughness: 0.08,
        clearcoat: 1,
        clearcoatRoughness: 0.03,
        envMapIntensity: 2.2,
        transparent: true,
        opacity: GLASS_OPACITY,
      });
      // Tyres must NOT take the environment. Rubber is the one part of a car
      // with almost no specular return, and letting it reflect the strip
      // lights is a classic tell that everything shares one material setup.
      const rubber = new THREE.MeshStandardMaterial({
        color: 0x0a0c0f,
        metalness: 0,
        roughness: 0.95,
        envMapIntensity: 0.15,
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
      /**
       * Loft a body from cross-sections.
       *
       * THIS WAS THE BIGGEST DEFECT IN THE STAGE and it was invisible in
       * every screenshot until someone named it. The old version pushed raw
       * triangle positions with NO INDEX BUFFER. On non-indexed geometry
       * `computeVertexNormals()` can only write one face normal to all three
       * of a triangle's vertices, because those vertices are not shared with
       * any neighbour — so the entire car was FLAT SHADED. Every panel was a
       * visible facet, and no amount of lighting, tone mapping or material
       * work survives that: a faceted surface reflects in facets.
       *
       * Now: stations are spline-resampled to RINGS sections, vertices are
       * shared between adjacent quads, and the geometry carries a real index
       * buffer, so `computeVertexNormals()` averages across neighbours and
       * the surface shades as the continuous curve it always was.
       */
      function loft(stations: Station[], segments = 48, RINGS = LOFT_RINGS) {
        // Shared with the geometry test, so what it verifies clearance
        // against is the same surface that renders.
        const rings = resampleStations(stations, RINGS);

        const cols = segments + 1; // last column duplicates the first
        const pos: number[] = [];
        const uv: number[] = [];

        const ringPoint = (s: Station, j: number): [number, number, number] => {
          const n = 2 / s.squareness;
          const t = (j / segments) * Math.PI * 2;
          const c = Math.cos(t);
          const si = Math.sin(t);
          return [
            s.x,
            s.y + s.h * Math.sign(si) * Math.pow(Math.abs(si), n),
            s.w * Math.sign(c) * Math.pow(Math.abs(c), n),
          ];
        };

        for (let i = 0; i < RINGS; i++) {
          for (let j = 0; j < cols; j++) {
            pos.push(...ringPoint(rings[i], j));
            // A real UV set, so any texture assigned later samples across
            // the surface instead of collapsing to a single texel.
            uv.push(i / (RINGS - 1), j / segments);
          }
        }

        const idx: number[] = [];
        for (let i = 0; i < RINGS - 1; i++) {
          for (let j = 0; j < segments; j++) {
            const a = i * cols + j;
            const b = i * cols + j + 1;
            const c = (i + 1) * cols + j + 1;
            const d = (i + 1) * cols + j;
            idx.push(a, b, c, a, c, d);
          }
        }

        // Caps get their OWN copies of the end rings rather than sharing the
        // body's vertices. Sharing would average the cap normal into the
        // body normal and round off the tail, losing the crisp edge that
        // makes the back of the car read as a cut-off rather than a nose.
        for (const [ringIdx, flip] of [
          [0, true],
          [RINGS - 1, false],
        ] as const) {
          const s = rings[ringIdx];
          const base = pos.length / 3;
          const cy = s.y;
          pos.push(s.x, cy, 0);
          uv.push(0.5, 0.5);
          for (let j = 0; j < cols; j++) {
            pos.push(...ringPoint(s, j));
            uv.push(0.5 + 0.5 * Math.cos((j / segments) * Math.PI * 2), 0.5 + 0.5 * Math.sin((j / segments) * Math.PI * 2));
          }
          for (let j = 0; j < segments; j++) {
            const a = base + 1 + j;
            const b = base + 1 + j + 1;
            if (flip) idx.push(base, b, a);
            else idx.push(base, a, b);
          }
        }

        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
        g.setIndex(idx);
        g.computeVertexNormals();

        // Weld the t=0 / t=2pi seam. The duplicate column exists so UVs can
        // run 0..1 without wrapping, but it leaves two vertices at the same
        // point with different averaged normals — a visible hairline down
        // the centre of the bonnet. Average them and write both.
        const nrm = g.getAttribute("normal") as ThreeNS.BufferAttribute;
        for (let i = 0; i < RINGS; i++) {
          const a = i * cols;
          const b = i * cols + segments;
          const nx = (nrm.getX(a) + nrm.getX(b)) / 2;
          const ny = (nrm.getY(a) + nrm.getY(b)) / 2;
          const nz = (nrm.getZ(a) + nrm.getZ(b)) / 2;
          const len = Math.hypot(nx, ny, nz) || 1;
          nrm.setXYZ(a, nx / len, ny / len, nz / len);
          nrm.setXYZ(b, nx / len, ny / len, nz / len);
        }
        nrm.needsUpdate = true;

        return g;
      }

      /**
       * Sweep a tube along the body surface.
       *
       * Every part that RUNS ALONG the car — neon contour strips, roof
       * rails, side skirts — is this same operation: walk the stations,
       * find the skin at a per-station height, step out along its normal,
       * spline the result. A straight box cannot do it, because a roofline
       * and a sill are both curves: a box meets the surface at one station
       * and lifts off it everywhere else.
       *
       * This existed twice, once for the neon and once for rails/skirts,
       * which is two chances to fix a placement bug in only one of them.
       */
      function surfaceRun(
        stations: Station[],
        heightOf: (s: Station) => number,
        radius: number,
        gap: number,
        side: number,
        material: ThreeNS.Material,
        radialSegments = 8,
      ) {
        const pts = stations.map((s) => {
          const [px, py, pz] = flankPoint(s, heightOf(s), side, radius + gap);
          return new THREE.Vector3(px, py, pz);
        });
        return new THREE.Mesh(
          new THREE.TubeGeometry(
            new THREE.CatmullRomCurve3(pts),
            60,
            radius,
            radialSegments,
            false,
          ),
          material,
        );
      }

      let parts: ThreeNS.Object3D[] = [];
      // Materials whose colour depends on the current selection, so they
      // genuinely cannot be shared across builds. Tracked explicitly and
      // disposed on the next rebuild — the same leak the hub material had.
      let perBuildMats: ThreeNS.Material[] = [];

      function buildCar(id: string) {
        releaseParts(parts, perBuildMats, carGroup);
        parts = [];
        perBuildMats = [];

        const spec = CAR_SPECS[id] ?? CAR_SPECS.bravo;

        const bodyGeo = loft(spec.body);
        const bodyMesh = new THREE.Mesh(bodyGeo, paint);
        carGroup.add(bodyMesh);
        parts.push(bodyMesh);

        // No wireframe overlay. It was here as "blueprint showing through
        // the paint", but a triangle mesh drawn over a surface is what 3D
        // software looks like mid-edit, and it read as an unfinished model
        // no matter how far the opacity came down. The engineering story is
        // carried by the exposed engine bay, which is real hardware.

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

            // WHEELS.
            //
            // These used to be 18 emissive blades per face plus two emissive
            // rings, all at emissiveIntensity 2.6. Two things went wrong at
            // once. Emissive ignores lighting, so the whole face rendered at
            // full brightness and clipped to flat white under tone mapping —
            // the wheels became the brightest object in the frame, brighter
            // than the studio lights, and read as spirograph discs rather
            // than as wheels. And at 72-120 blades of 0.022 x 0.014 units
            // they were sub-pixel at any hero distance, so all that geometry
            // bought was aliasing shimmer, which reads as cheap.
            //
            // A real wheel is dark machined metal that is INTERESTING
            // BECAUSE IT REFLECTS. Now that there is an environment to
            // reflect, the rim can do what an actual rim does: pick up the
            // softboxes along its polished edges and stay dark elsewhere.
            // One thin lit accent ring keeps the brand cue.
            const rimMetal = new THREE.MeshStandardMaterial({
              color: 0x23282f,
              metalness: 0.95,
              roughness: 0.24,
              envMapIntensity: 2.2,
            });
            const rimAccent = new THREE.MeshStandardMaterial({
              color: spec.wheel.tint,
              emissive: spec.wheel.tint,
              emissiveIntensity: 1.1,
              metalness: 0.6,
              roughness: 0.3,
            });
            const discMat = new THREE.MeshStandardMaterial({
              color: 0x14181d,
              metalness: 0.8,
              roughness: 0.55,
              envMapIntensity: 0.8,
            });
            perBuildMats.push(rimMetal, rimAccent, discMat);

            const face = tyre.position.clone();
            face.z += side * (axle.width / 2 + 0.01);

            // Brake disc, set back behind the spokes. Gives the wheel a
            // dark cavity so the spokes have something to read against
            // instead of showing the background through the gaps.
            const disc = new THREE.Mesh(
              new THREE.CylinderGeometry(
                axle.radius * 0.58,
                axle.radius * 0.58,
                0.03,
                28,
              ),
              discMat,
            );
            disc.position.copy(face);
            disc.position.z -= side * 0.05;
            disc.rotation.x = Math.PI / 2;
            carGroup.add(disc);
            parts.push(disc);

            // Outer rim lip, polished. This is the part that catches the
            // strip lights and draws the wheel's circle.
            const lip = new THREE.Mesh(
              new THREE.TorusGeometry(
                axle.radius * 0.82,
                0.03 * spec.wheel.rimDepth,
                10,
                44,
              ),
              rimMetal,
            );
            lip.position.copy(face);
            carGroup.add(lip);
            parts.push(lip);

            // One lit ring, inboard of the lip. The only emissive part of
            // the wheel, at an intensity that sits under the strip lights
            // rather than over them.
            const accent = new THREE.Mesh(
              new THREE.TorusGeometry(axle.radius * 0.66, 0.012, 8, 40),
              rimAccent,
            );
            accent.position.copy(face);
            carGroup.add(accent);
            parts.push(accent);

            // Spokes: the real count from the harness spec, not tripled.
            // Bigger, fewer, and metal — so they catch a highlight along
            // one edge and fall dark on the other, which is what makes a
            // spoke look machined instead of drawn.
            for (let s = 0; s < spec.wheel.spokes; s++) {
              const spoke = new THREE.Mesh(
                new THREE.BoxGeometry(axle.radius * 0.62, 0.085, 0.05),
                rimMetal,
              );
              const a = (s / spec.wheel.spokes) * Math.PI * 2;
              spoke.position.copy(face);
              spoke.position.x += Math.cos(a) * axle.radius * 0.42;
              spoke.position.y += Math.sin(a) * axle.radius * 0.42;
              spoke.rotation.z = a + 0.26; // slight sweep, like a real face
              carGroup.add(spoke);
              parts.push(spoke);
            }

            // Centre cap.
            const cap = new THREE.Mesh(
              new THREE.CylinderGeometry(
                axle.radius * 0.14,
                axle.radius * 0.14,
                0.04,
                20,
              ),
              rimAccent,
            );
            cap.position.copy(face);
            cap.rotation.x = Math.PI / 2;
            carGroup.add(cap);
            parts.push(cap);
          }
        }

        // ── Neon contour strips ─────────────────────────────────────
        // The signature of the reference image: light tracing the body's
        // own lines rather than sitting on top of it. Both runs are
        // generated FROM the station data, so they follow whichever
        // silhouette is selected instead of being drawn per body.
        const stripMat = new THREE.MeshBasicMaterial({ color: 0x00d4ff });
        perBuildMats.push(stripMat);

        for (const heightFrac of [
          MOUNT.shoulderFrac, // shoulder line, high on the flank
          MOUNT.sillFrac, // sill line, low along the rocker
        ]) {
          for (const side of [-1, 1]) {
            const strip = surfaceRun(
              spec.body,
              (s) => runHeight(s, heightFrac),
              MOUNT.stripRadius,
              MOUNT.stripGap,
              side,
              stripMat,
              6,
            );
            carGroup.add(strip);
            parts.push(strip);
          }
        }

        // Rear light bar, straight from the reference.
        //
        // Sits PROUD of the tail cap, not inside it. The first version put
        // it at tail.y + 0.12, which on every one of the four harnesses was
        // still below the top of the rear section — so it rendered, cost
        // its draw call, and was never once visible from outside the car.
        const tailStation = spec.body[0];
        const barY = tailStation.y + tailStation.h * 0.45;
        // Width comes from the surface at the bar's OWN height. It used to
        // be tailStation.w * 1.35 — 135% of the section's widest point — so
        // the bar poked out past both rear corners on every harness.
        const bar = new THREE.Mesh(
          new THREE.BoxGeometry(0.05, 0.055, surfaceHalfWidth(tailStation, barY) * 1.72),
          stripMat,
        );
        bar.position.set(tailStation.x - 0.03, barY, 0);
        carGroup.add(bar);
        parts.push(bar);

        // ── Body-specific hardware ──────────────────────────────────
        const f = spec.features;
        const rearX = spec.body[0].x;

        if (f.wing) {
          // The wing sits above the tail, and its struts have to land ON the
          // deck rather than at a guessed height — the deck height differs
          // per body, so a fixed 0.95 either floated or sank depending on
          // which harness was selected.
          const tailSt = nearestStation(spec.body, rearX + 0.18);
          const deckY = tailSt.y + tailSt.h;
          const strutZ = surfaceHalfWidth(tailSt, deckY - tailSt.h * 0.12) * 0.72;
          const wingY = deckY + 0.46;

          const blade = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.05, 1.9), paint);
          blade.position.set(rearX + 0.18, wingY, 0);
          blade.rotation.z = -0.09;
          carGroup.add(blade);
          parts.push(blade);
          for (const side of [-1, 1]) {
            const strutH = wingY - deckY;
            const strut = new THREE.Mesh(new THREE.BoxGeometry(0.08, strutH, 0.07), paint);
            strut.position.set(rearX + 0.18, deckY + strutH / 2, side * strutZ);
            carGroup.add(strut);
            parts.push(strut);
          }
        }

        // Rails and skirts mount ON the surface, so they are derived from it
        // rather than from hardcoded world coordinates. Both had the same
        // bug the neon strips did: the rails sat at a fixed z=0.6 where
        // bravo's roof surface is at 0.655, burying them 5.5cm into the
        // roof, and the skirts used maxHalfWidth — the widest point of the
        // whole body — at a height where the section is far narrower, so
        // they floated outboard in mid-air.
        if (f.rails) {
          // Skip the degenerate end sections where the greenhouse tapers to
          // nothing; a rail there would spear out past the glass.
          const run = spec.cabin.filter((s) => s.h > 0.1);
          for (const side of [-1, 1]) {
            const rail = surfaceRun(
              run,
              (s) => s.y + s.h * MOUNT.railHeightFrac,
              MOUNT.railThickness / 2,
              MOUNT.gap,
              side,
              paint,
            );
            carGroup.add(rail);
            parts.push(rail);
          }
        }

        if (f.skirts) {
          // Between the axles only — a skirt is a sill part, it does not
          // continue around the nose and tail.
          const run = spec.body.filter((s) => Math.abs(s.x) < 1.7);
          for (const side of [-1, 1]) {
            const skirt = surfaceRun(
              run,
              (s) => s.y + s.h * MOUNT.skirtHeightFrac,
              MOUNT.skirtThickness / 2,
              MOUNT.gap,
              side,
              paint,
            );
            carGroup.add(skirt);
            parts.push(skirt);
          }
        }

        if (f.exposedFrame) {
          // A roll hoop, so the unbuilt slot reads as a chassis waiting for
          // bodywork rather than as a plainer car.
          const hoopSt = nearestStation(spec.body, -0.7);
          const hoop = new THREE.Mesh(
            new THREE.TorusGeometry(hoopSt.w * 0.86, 0.045, 8, 24, Math.PI),
            hubMat,
          );
          // Springs from the deck, not from a fixed height that happened to
          // suit one body's proportions.
          hoop.position.set(-0.7, hoopSt.y + hoopSt.h * 0.72, 0);
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
      // Live bits the animation loop drives: the reactor breathes, the
      // containment rings counter-rotate. Rebuilt with the engine.
      let pulseParts: ThreeNS.Object3D[] = [];
      let spinParts: { mesh: ThreeNS.Object3D; rate: number }[] = [];
      // Pulse rate scales with cylinder count, so a V12 idles faster than
      // a four and the electric pack barely breathes at all.
      let pulseRate = 1;
      let hotRef: ThreeNS.MeshStandardMaterial | null = null;

      function buildEngine(engineId: string, carSpec: (typeof CAR_SPECS)[string]) {
        releaseParts(engineParts, engineMats, carGroup);
        engineParts = [];
        engineMats = [];
        pulseParts = [];
        spinParts = [];

        const eng = ENGINES.find((e) => e.id === engineId) ?? ENGINES[0];
        const col = new THREE.Color(eng.glow);
        // EXPOSED bay, per CC: mounted proud of the deck so it can be seen.
        // engineAnchor is shared with the fill light and the camera dive so
        // all three point at the same place.
        const [bx, by, bz] = engineAnchor(carSpec);

        const blockMat = new THREE.MeshStandardMaterial({
          color: 0x2a3038,
          metalness: 0.95,
          roughness: 0.28,
          envMapIntensity: 1.4,
        });
        const hotMat = new THREE.MeshStandardMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: HOT_EMISSIVE,
          metalness: 0.3,
          roughness: 0.4,
        });
        engineMats.push(blockMat, hotMat);
        hotRef = hotMat;
        pulseRate = eng.layout === "electric" ? 0.6 : 1 + eng.cylinders * 0.16;

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
              // Cylinder BARRELS are hardware, not light. Rendering every
              // part with the emissive material turned the bay into a
              // cluster of glowing lumps that read as debris rather than as
              // an engine. Metal housings, glowing internals: that contrast
              // is what makes machinery legible.
              const cyl = new THREE.Mesh(
                new THREE.CylinderGeometry(0.055, 0.055, 0.26, 12),
                blockMat,
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

              // A glowing cam cover on top of each barrel — the only lit
              // part, so the eye reads a row of cylinders rather than a pile.
              const cap = new THREE.Mesh(
                new THREE.CylinderGeometry(0.032, 0.032, 0.03, 10),
                hotMat,
              );
              cap.position.copy(cyl.position);
              cap.position.y += 0.14;
              cap.rotation.copy(cyl.rotation);
              add(cap);
            }
          }
        }

        // ── Core reactor ────────────────────────────────────────────
        // The centrepiece. Its size, ring count and pulse rate all come
        // from the engine, so a twelve-cylinder core is visibly a bigger,
        // faster-breathing machine than a four. Tracked on `pulseParts` so
        // the animation loop can drive it per frame.
        const coreScale = 0.55 + eng.cylinders * 0.022;
        const core = new THREE.Mesh(
          new THREE.IcosahedronGeometry(0.14 * coreScale, 1),
          hotMat,
        );
        core.position.set(bx, by + 0.02, bz);
        add(core);
        pulseParts.push(core);

        // Containment rings around the core. More cylinders, more rings.
        const ringCount = eng.layout === "electric" ? 1 : Math.max(2, Math.round(eng.cylinders / 3));
        for (let i = 0; i < ringCount; i++) {
          const ring = new THREE.Mesh(
            new THREE.TorusGeometry(0.2 * coreScale + i * 0.05, 0.012, 8, 30),
            hotMat,
          );
          ring.position.copy(core.position);
          ring.rotation.x = Math.PI / 2;
          ring.rotation.z = i * 0.5;
          add(ring);
          spinParts.push({ mesh: ring, rate: (i % 2 ? -1 : 1) * (0.004 + i * 0.002) });
        }

        // Manifold pipes running from the core out toward the tail. These
        // are the "energy conduits": count follows the cylinder count, so
        // the plumbing genuinely thickens with the engine.
        const conduits = eng.layout === "electric" ? 2 : Math.min(6, eng.cylinders);
        for (let i = 0; i < conduits; i++) {
          const a = (i / conduits) * Math.PI * 2;
          const path = new THREE.CatmullRomCurve3([
            new THREE.Vector3(bx, by + 0.02, bz),
            new THREE.Vector3(
              bx - 0.22,
              by + 0.06 + Math.sin(a) * 0.1,
              bz + Math.cos(a) * 0.16,
            ),
            new THREE.Vector3(
              bx - 0.5,
              by - 0.02 + Math.sin(a) * 0.06,
              bz + Math.cos(a) * 0.22,
            ),
          ]);
          const conduit = new THREE.Mesh(
            new THREE.TubeGeometry(path, 18, 0.018, 6, false),
            hotMat,
          );
          add(conduit);
        }

        // Cooling coils: a helix wrapped around the bay.
        const coilPts: ThreeNS.Vector3[] = [];
        for (let i = 0; i <= 40; i++) {
          const a = (i / 40) * Math.PI * 6;
          coilPts.push(
            new THREE.Vector3(
              bx + 0.34 - (i / 40) * 0.6,
              by + 0.06 + Math.sin(a) * 0.09,
              bz + Math.cos(a) * 0.14,
            ),
          );
        }
        const coil = new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(coilPts), 60, 0.009, 5, false),
          blockMat,
        );
        add(coil);

        // Exhaust tips in the rear valance. Small and shallow: at 0.055
        // radius and 0.16 long they read as a stack of orange blocks bolted
        // to the tail rather than as pipe ends set into it.
        const tail = carSpec.body[0];
        for (let i = 0; i < eng.exhausts; i++) {
          const offset =
            eng.exhausts === 1 ? 0 : (i / (eng.exhausts - 1) - 0.5) * tail.w * 0.85;
          const pipe = new THREE.Mesh(
            new THREE.CylinderGeometry(0.032, 0.036, 0.075, 14),
            hotMat,
          );
          pipe.rotation.z = Math.PI / 2;
          pipe.position.set(tail.x + 0.015, tail.y - tail.h * 0.45, offset);
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

        engineLight.position.set(...engineAnchor(spec));

        if (diveFrames > 0) {
          diveFrames--;
          const [ex, ey, ez] = engineAnchor(spec);
          // Close enough to read individual cylinders. The previous framing
          // hung back at showroom distance and the whole point of the dive,
          // seeing the hardware change, was lost at that range.
          // Scaled with the lens so the bay frames identically — see
          // DIVE_OFFSET, which the geometry test holds to that invariant.
          targetPos.set(
            ex + DIVE_OFFSET[0],
            ey + DIVE_OFFSET[1],
            ez + DIVE_OFFSET[2],
          );
          targetAt.set(ex, ey + 0.05, ez);
          if (diveFrames === 0) frameBody(sel.current.bodyId);
        }

        // The engine runs. Reactor breathes, containment rings counter-
        // rotate, emissive intensity throbs — all at a rate set by the
        // selected engine, so a V12 is visibly busier than a four and the
        // battery pack is nearly still. This is what makes the swap read as
        // a different MACHINE rather than a different colour.
        if (!reduced) {
          const beat = Math.sin(t * pulseRate * 2.4);
          for (const p of pulseParts) {
            const s = 1 + beat * 0.09;
            p.scale.setScalar(s);
          }
          for (const s of spinParts) s.mesh.rotation.z += s.rate * pulseRate;
          if (hotRef) hotRef.emissiveIntensity = HOT_EMISSIVE + beat * 0.9;
        }

        // X-ray the bodywork while diving. The engine is genuinely inside
        // the car, so without this the camera flies in and shows you a
        // closed panel. Eased both ways so panels dissolve and re-form
        // rather than blinking.
        const wantOpacity = diveFrames > 0 ? 0.16 : 1;
        paint.opacity += (wantOpacity - paint.opacity) * (reduced ? 1 : 0.08);
        glass.opacity = GLASS_OPACITY * paint.opacity;

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
        // The car used to sway +/-9 degrees forever to look alive. That
        // turns every flaw in the surface toward the viewer in turn, and a
        // car that rocks on its own springs at rest is not a thing anyone
        // has seen. Sweep the RIM LIGHT instead: the highlight travels down
        // the flank, which reads as alive for the same reason and hides
        // geometry rather than parading it. Costs nothing, no rebuild.
        carGroup.rotation.y = dragged ? spin : 0;
        if (!reduced) {
          const sweep = Math.sin(t * 0.35);
          rim.position.set(-5 + sweep * 2.6, 2.4, -4 + sweep * 1.1);
        }

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
        envRT.dispose();
        ro.disconnect();
        io.disconnect();
        canvasEl.removeEventListener("pointerdown", onDown);
        canvasEl.removeEventListener("pointermove", onMove);
        canvasEl.removeEventListener("pointerup", onUp);
        canvasEl.removeEventListener("pointercancel", onUp);
        // Per-selection parts first, then everything still hanging off the
        // scene (car body, wheels, shadow).
        releaseParts([...parts, ...engineParts], [...perBuildMats, ...engineMats], carGroup);
        releaseParts([scene], []);
        // Every material created in this effect, not just the obvious four.
        floorTex.dispose();
        [paint, glass, rubber, hubMat, shadowMat, floorMat].forEach((m) =>
          m.dispose(),
        );
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
