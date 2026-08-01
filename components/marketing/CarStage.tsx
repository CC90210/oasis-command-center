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
  hotspotAnchor,
  wheelTrack,
  ARCH,
  CAMERA_FOV,
  DIVE_OFFSET,
  FOCUS_DIR,
  FOCUS_FRAME_HEIGHT,
  LAUNCH,
  LOFT_RINGS,
  MOUNT,
  type Station,
} from "@/lib/marketing/car-geometry";
import { HOTSPOTS } from "@/lib/marketing/hotspots";
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
  /**
   * Screen positions of the spatial callouts, recomputed every frame and
   * handed back so the overlay can be plain DOM.
   *
   * This is what drei's <Html> does internally — project a world point
   * through the camera and drive a CSS transform. Doing it directly avoids
   * migrating a working raw-three scene onto react-three-fiber (which drei
   * requires) for the sake of one component.
   */
  onHotspots?: (
    pts: { id: string; x: number; y: number; visible: boolean }[],
  ) => void;
  /** Which hotspot the camera should push in on, or null to sit back. */
  focus?: string | null;
  /** Flips true to run the ignition and drive-away sequence. */
  launch?: boolean;
  /** Fires when the car has left frame, so the caller can navigate. */
  onLaunchComplete?: () => void;
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

export function CarStage({
  bodyId,
  engineId,
  engineColor,
  onReady,
  onHotspots,
  focus,
  launch,
  onLaunchComplete,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const hotspotsRef = useRef(onHotspots);
  hotspotsRef.current = onHotspots;
  // Read inside the loop so changing focus never tears down the scene.
  const focusRef = useRef<string | null>(focus ?? null);
  focusRef.current = focus ?? null;
  const launchRef = useRef(false);
  launchRef.current = !!launch;
  const launchDoneRef = useRef(onLaunchComplete);
  launchDoneRef.current = onLaunchComplete;
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
        // Cleared with the body it belongs to. Left dangling it would point
        // at a disposed mesh from the previous harness and the loop would
        // keep driving geometry that is no longer in the scene.
        aeroFlap = null;
        wheelSpinners = [];

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

        // WINDOWS. The greenhouse was one uninterrupted glass loft, which
        // reads as a tinted bubble rather than as a car — a car has a
        // windscreen, side glass and a rear screen, separated by pillars,
        // and the pillars are most of what makes it legible as a cabin.
        // Drawn as bright trim following the cabin surface rather than as
        // cut geometry: a real cutout needs CSG, and the DLO graphic is
        // what the eye actually reads at this distance.
        const dloMat = new THREE.MeshStandardMaterial({
          color: 0x1a2029,
          metalness: 0.9,
          roughness: 0.3,
          envMapIntensity: 2.0,
        });
        perBuildMats.push(dloMat);

        // Beltline: the lower edge of the side glass, running the cabin.
        for (const side of [-1, 1]) {
          const belt = surfaceRun(
            spec.cabin.filter((s) => s.h > 0.06),
            (s) => s.y - s.h * 0.72,
            0.016,
            MOUNT.gap,
            side,
            dloMat,
          );
          carGroup.add(belt);
          parts.push(belt);
        }

        // Pillars. A-pillar at the windscreen, B-pillar behind the door,
        // C-pillar at the rear screen — positioned as fractions along the
        // greenhouse so they land correctly on every body.
        //
        // Each one is swept UP the cross-section rather than drawn as a
        // straight box. The greenhouse narrows toward the roof, so a
        // vertical box pinned at the glass's widest point has its whole
        // upper half outside the glass — which rendered as three dark bars
        // standing proud of the roof instead of as pillars in it.
        for (const frac of [0.14, 0.52, 0.88]) {
          const i = Math.min(
            spec.cabin.length - 1,
            Math.max(0, Math.round(frac * (spec.cabin.length - 1))),
          );
          const st = spec.cabin[i];
          if (st.h <= 0.06) continue;
          const lo = st.y - st.h * 0.7;
          const hi = st.y + st.h * 0.72;
          for (const side of [-1, 1]) {
            const pts: ThreeNS.Vector3[] = [];
            for (let s = 0; s <= 6; s++) {
              const y = lo + ((hi - lo) * s) / 6;
              const [, py, pz] = flankPoint(st, y, side, 0.018);
              pts.push(new THREE.Vector3(st.x, py, pz));
            }
            const pillar = new THREE.Mesh(
              new THREE.TubeGeometry(
                new THREE.CatmullRomCurve3(pts),
                12,
                0.019,
                6,
                false,
              ),
              dloMat,
            );
            carGroup.add(pillar);
            parts.push(pillar);
          }
        }

        // Widest half-width in the body, so the wheels sit in the arches
        // rather than inside the bodywork. The first pass hard-coded 1.02
        // and subtracted half the tyre width, which buried every wheel
        // inside a body that is itself ~1.05 wide — four tyres completely
        // hidden inside the car.
        // Track width is derived from the body AT THE AXLE, not from the
        // car's widest point anywhere along its length. The old code used
        // the global max, so the tyre's outer face sat proud of the widest
        // panel — and because the flank is much narrower at wheel-centre
        // height than at its widest, the tyre cut clean through the
        // bodywork. Every wheel now sits under an arch that is itself
        // derived from the local surface.
        // Fenders use `paint`, not a material of their own. A fender IS
        // bodywork, and `paint` is the material the engine dive fades to
        // 16% — a separate opaque one left the arches sitting solid black
        // around a ghosted body for the whole x-ray, which reads as four
        // detached rings rather than as panels dissolving.
        const accentMat = new THREE.MeshStandardMaterial({
          color: spec.accent,
          metalness: 0.98,
          roughness: 0.22,
          envMapIntensity: 2.4,
        });
        perBuildMats.push(accentMat);

        for (const axle of spec.axles) {
          // Shared with the geometry test, which asserts the tyre clears
          // the bodywork and the fender covers the tyre.
          const { flankAtHub, hubZ, archRadius } = wheelTrack(spec, axle);

          for (const side of [-1, 1]) {
            const tyre = new THREE.Mesh(
              new THREE.CylinderGeometry(axle.radius, axle.radius, axle.width, 32),
              rubber,
            );
            tyre.rotation.x = Math.PI / 2;
            tyre.position.set(axle.x, axle.radius, side * hubZ);
            carGroup.add(tyre);
            parts.push(tyre);
            wheelSpinners.push(tyre);

            // FENDER. A half-torus arcing over the top of the wheel,
            // radius = tyre + clearance, sitting in the tyre's own plane.
            // This is the part that was missing entirely: it gives the
            // wheel somewhere to live and hides the tyre/body junction.
            const arch = new THREE.Mesh(
              new THREE.TorusGeometry(archRadius, ARCH.lip, 10, 28, Math.PI),
              paint,
            );
            arch.position.set(axle.x, axle.radius, side * (hubZ + 0.01));
            carGroup.add(arch);
            parts.push(arch);

            // Inner liner: a dark band bridging arch to body, so you can't
            // see daylight between the fender and the flank.
            const liner = new THREE.Mesh(
              new THREE.CylinderGeometry(
                archRadius,
                archRadius,
                Math.max(0.04, hubZ - flankAtHub + axle.width / 2),
                24,
                1,
                true,
                0,
                Math.PI,
              ),
              rubber,
            );
            liner.rotation.x = Math.PI / 2;
            liner.rotation.y = Math.PI / 2;
            liner.position.set(
              axle.x,
              axle.radius,
              side * ((hubZ + flankAtHub - axle.width / 2) / 2 + axle.width / 4),
            );
            carGroup.add(liner);
            parts.push(liner);

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

        if (f.activeAero) {
          // Two-element spoiler standing off the deck on end plates. Reads
          // as engineered rather than bolted on, which is the whole point
          // of the "precision engineering" body.
          const st = nearestStation(spec.body, rearX + 0.3);
          const deck = st.y + st.h;
          const halfW = surfaceHalfWidth(st, deck - st.h * 0.15);
          for (const [i, [lift, chord, tilt]] of (
            [
              [0.16, 0.3, -0.06],
              [0.34, 0.22, -0.22],
            ] as const
          ).entries()) {
            const el = new THREE.Mesh(
              new THREE.BoxGeometry(chord, 0.028, halfW * 1.72),
              i === 1 ? accentMat : paint,
            );
            el.position.set(rearX + 0.3, deck + lift, 0);
            el.rotation.z = tilt;
            carGroup.add(el);
            parts.push(el);
            // ACTIVE aero: the upper element is the one that moves. It
            // sits near-flat at rest and pitches up under load, which is
            // the whole reason the word "active" is on it — a wing that
            // never changes angle is just a wing.
            if (i === 1) aeroFlap = { mesh: el, base: tilt };
          }
          for (const side of [-1, 1]) {
            const plate = new THREE.Mesh(
              new THREE.BoxGeometry(0.34, 0.4, 0.02),
              accentMat,
            );
            plate.position.set(rearX + 0.3, deck + 0.24, side * halfW * 0.86);
            carGroup.add(plate);
            parts.push(plate);
          }
        }

        if (f.gtTrim) {
          // Brightwork down the shoulder. Same swept-tube treatment as the
          // neon, in titanium rather than light — a GT wears metal, not neon.
          for (const side of [-1, 1]) {
            const trim = surfaceRun(
              spec.body,
              (s) => runHeight(s, 0.86),
              0.014,
              MOUNT.gap,
              side,
              accentMat,
            );
            carGroup.add(trim);
            parts.push(trim);
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
      /**
       * Charge packets that travel ALONG a conduit rather than sitting on
       * it. Each carries the curve it rides and its offset around it, so
       * the loop advances `t` and reads a position off the curve — energy
       * moving through the engine instead of parts that merely glow.
       */
      let flowParts: {
        mesh: ThreeNS.Object3D;
        curve: ThreeNS.CatmullRomCurve3;
        offset: number;
        speed: number;
      }[] = [];
      // `axis` is the part's OWN spin axis. Rotating everything on z was
      // fine while the only spinning parts were rings already lying in the
      // xy-plane, but a pulley or a turbo has been rotated onto another
      // axis to sit correctly — driving z on those tumbles them end over
      // end instead of spinning them.
      let spinParts: {
        mesh: ThreeNS.Object3D;
        rate: number;
        axis?: "x" | "y" | "z";
      }[] = [];
      // Pulse rate scales with cylinder count, so a V12 idles faster than
      // a four and the electric pack barely breathes at all.
      let pulseRate = 1;
      /** The moving element of an active-aero wing, if this body has one. */
      let aeroFlap: { mesh: ThreeNS.Object3D; base: number } | null = null;
      /**
       * Launch sequence progress, in frames. 0 = idle, >0 = running,
       * -1 = finished and latched so it cannot fire twice.
       */
      let launchFrame = 0;
      let wheelSpin = 0;
      /** Wheel meshes, turned during the launch. */
      let wheelSpinners: ThreeNS.Object3D[] = [];
      let hotRef: ThreeNS.MeshStandardMaterial | null = null;

      function buildEngine(engineId: string, carSpec: (typeof CAR_SPECS)[string]) {
        releaseParts(engineParts, engineMats, carGroup);
        engineParts = [];
        engineMats = [];
        pulseParts = [];
        flowParts = [];
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
          // LOCAL: an industrial heatsink stack, not a plasma core. Runs on
          // your own hardware, so it should look like hardware — finned
          // aluminium, two fans, braided power conduits. Deliberately the
          // least exotic option in the picker, because that is the honest
          // difference between a local model and a hosted one.
          const pack = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.16, 1.15), blockMat);
          pack.position.set(bx, by - 0.12, bz);
          add(pack);

          // Heatsink fins.
          for (let i = 0; i < 11; i++) {
            const fin = new THREE.Mesh(
              new THREE.BoxGeometry(0.02, 0.17, 1.0),
              blockMat,
            );
            fin.position.set(bx - 0.36 + i * 0.072, by + 0.02, bz);
            add(fin);
          }

          // Two cooling fans, counter-rotating, with a lit hub each.
          for (const [i, fz] of [-0.3, 0.3].entries()) {
            const shroud = new THREE.Mesh(
              new THREE.TorusGeometry(0.2, 0.022, 8, 24),
              blockMat,
            );
            shroud.position.set(bx, by + 0.14, bz + fz);
            shroud.rotation.x = Math.PI / 2;
            add(shroud);

            const hub = new THREE.Mesh(
              new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16),
              hotMat,
            );
            hub.position.set(bx, by + 0.14, bz + fz);
            add(hub);
            pulseParts.push(hub);

            // Blades live in a group centred on the hub and the GROUP
            // spins. Spinning each blade on its own axis would rotate it
            // in place like a propeller pinned to a wall — the blades have
            // to orbit the hub, which means the rotation belongs to their
            // parent, not to them.
            const rotor = new THREE.Group();
            rotor.position.set(bx, by + 0.14, bz + fz);
            for (let b = 0; b < 7; b++) {
              const blade = new THREE.Mesh(
                new THREE.BoxGeometry(0.15, 0.008, 0.05),
                blockMat,
              );
              const a = (b / 7) * Math.PI * 2;
              blade.position.set(Math.cos(a) * 0.1, 0, Math.sin(a) * 0.1);
              blade.rotation.y = -a;
              blade.rotation.z = 0.4;
              rotor.add(blade);
            }
            add(rotor);
            // Fans spin opposite ways, which is what makes it read as a
            // working machine rather than a decal. The rotor lies flat, so
            // its axis is y.
            spinParts.push({ mesh: rotor, rate: i === 0 ? 0.09 : -0.09, axis: "y" });
          }

          // Braided power conduits running out to the rear.
          for (const cz of [-0.42, 0, 0.42]) {
            const conduit = new THREE.Mesh(
              new THREE.CylinderGeometry(0.028, 0.028, 0.62, 10),
              blockMat,
            );
            conduit.position.set(bx - 0.45, by - 0.1, bz + cz);
            conduit.rotation.z = Math.PI / 2;
            add(conduit);
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

          // Cylinder positions are collected as they are built so the
          // plumbing can be routed to them. Everything downstream — plug
          // leads, intake runners, exhaust headers — has to land on the
          // actual barrel, not on a guessed coordinate, or a V12 gets an
          // inline-four's wiring.
          const cylTops: ThreeNS.Vector3[] = [];

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
              cylTops.push(cap.position.clone());
            }
          }

          // ── Plumbing and wiring ──────────────────────────────────
          // An engine is mostly what is bolted to the block. Bare barrels
          // read as a machined part; barrels plus a loom, an intake and
          // headers read as an engine. All of it is routed from cylTops,
          // so it rebuilds correctly for an inline four, a flat six or a
          // sixty-degree V12 without a special case for each.

          const wireMat = new THREE.MeshStandardMaterial({
            color: 0x141922,
            metalness: 0.1,
            roughness: 0.75,
            envMapIntensity: 0.5,
          });
          const pipeMat = new THREE.MeshStandardMaterial({
            color: 0x8d949c,
            metalness: 1,
            roughness: 0.32,
            envMapIntensity: 2.6,
          });
          engineMats.push(wireMat, pipeMat);

          /**
           * A part that spins on its OWN axis, wrapped in a group that
           * orients it.
           *
           * Spinning an oriented mesh directly does not work: a torus or a
           * cylinder has already had a Euler rotation applied to point it
           * the right way, and adding more rotation on any single axis
           * compounds with that instead of turning the part about its own
           * centre — the wheel tumbles end over end. Orienting the PARENT
           * and spinning the untransformed child on z removes the question
           * entirely.
           */
          const spinner = (
            geo: ThreeNS.BufferGeometry,
            mat: ThreeNS.Material,
            pos: [number, number, number],
            orient: [number, number, number],
            rate: number,
            // The GEOMETRY's own axis, untransformed: a torus is built
            // around z, a cylinder around y. Getting this wrong is the
            // difference between a wheel turning and a wheel wobbling.
            selfAxis: "x" | "y" | "z",
          ) => {
            const holder = new THREE.Group();
            holder.position.set(...pos);
            holder.rotation.set(...orient);
            const mesh = new THREE.Mesh(geo, mat);
            holder.add(mesh);
            spinParts.push({ mesh, rate, axis: selfAxis });
            return holder;
          };

          const tube = (
            pts: ThreeNS.Vector3[],
            r: number,
            mat: ThreeNS.Material,
          ) =>
            new THREE.Mesh(
              new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, r, 6, false),
              mat,
            );

          // ECU, at the back of the block. Every plug lead starts here.
          const ecuX = bx - (eng.cylinders >= 8 ? 0.4 : 0.3);
          const ecu = new THREE.Mesh(
            new THREE.BoxGeometry(0.13, 0.09, 0.22),
            blockMat,
          );
          ecu.position.set(ecuX, by + 0.12, bz - 0.2);
          add(ecu);

          // Ignition loom: one lead per cylinder, fanning out of the ECU
          // and arcing over to each cam cover. This is the "wiring" the
          // bay was missing entirely.
          //
          // Each lead also carries a charge packet that RUNS DOWN IT, so
          // the loom reads as live rather than as decorative cable. The
          // packets are offset around the firing order, which is what
          // makes a V12 look busier than an inline four without changing
          // anything but the cylinder count.
          for (const [i, top] of cylTops.entries()) {
            const lift = 0.1 + (i % 3) * 0.022;
            const path = [
              new THREE.Vector3(ecuX, by + 0.14, bz - 0.2),
              new THREE.Vector3(
                (ecuX + top.x) / 2,
                by + 0.16 + lift,
                (bz - 0.2 + top.z) / 2,
              ),
              new THREE.Vector3(top.x, top.y + 0.05, top.z),
            ];
            const curve = new THREE.CatmullRomCurve3(path);
            add(tube(path, 0.011, wireMat));

            const packet = new THREE.Mesh(
              new THREE.SphereGeometry(0.018, 8, 6),
              hotMat,
            );
            curve.getPointAt(0, packet.position);
            add(packet);
            flowParts.push({
              mesh: packet,
              curve,
              offset: i / cylTops.length,
              speed: 0.55,
            });
          }

          // Intake plenum with a runner to every cylinder.
          const plenumY = by + 0.26;
          const plenum = new THREE.Mesh(
            new THREE.CylinderGeometry(0.06, 0.06, eng.cylinders >= 8 ? 0.66 : 0.46, 14),
            pipeMat,
          );
          plenum.rotation.z = Math.PI / 2;
          plenum.position.set(bx, plenumY, bz + 0.18);
          add(plenum);

          for (const top of cylTops) {
            add(
              tube(
                [
                  new THREE.Vector3(top.x, plenumY, bz + 0.18),
                  new THREE.Vector3(top.x, plenumY - 0.06, (bz + 0.18 + top.z) / 2),
                  new THREE.Vector3(top.x, top.y + 0.03, top.z),
                ],
                0.017,
                pipeMat,
              ),
            );
          }

          // Exhaust headers: one primary per cylinder, all merging into a
          // collector behind the block.
          // `by` is the DECK — the top of the bodywork the bay is mounted
          // on. Anything routed below it is inside the car and invisible,
          // which is how the rear light bar, the engine core and the neon
          // strips each got lost earlier in this build. The headers dip
          // only as far as the deck and the collector sits above it.
          const collector = new THREE.Vector3(bx - 0.34, by + 0.03, bz - 0.28);
          for (const top of cylTops) {
            add(
              tube(
                [
                  new THREE.Vector3(top.x, top.y - 0.1, top.z),
                  new THREE.Vector3(top.x, by + 0.02, top.z - 0.12),
                  new THREE.Vector3((top.x + collector.x) / 2, by + 0.02, collector.z + 0.06),
                  collector,
                ],
                0.015,
                pipeMat,
              ),
            );
          }
          const collectorCan = new THREE.Mesh(
            new THREE.CylinderGeometry(0.05, 0.05, 0.16, 12),
            pipeMat,
          );
          collectorCan.rotation.z = Math.PI / 2;
          collectorCan.position.copy(collector);
          add(collectorCan);

          // Turbo, where the engine is specified with one. Snail housing,
          // compressor can, and the charge pipe back to the plenum.
          if (/turbo/i.test(eng.spec)) {
            // Above the deck, like everything else in the bay — the first
            // placement sank it into the bodywork where nobody would ever
            // see it, which is the whole reason it exists.
            const turboY = by + 0.1;
            add(
              spinner(
                new THREE.TorusGeometry(0.075, 0.038, 10, 20),
                pipeMat,
                [bx - 0.5, turboY, bz - 0.26],
                [0, Math.PI / 2, 0],
                0.14,
                "z", // torus is built around z
              ),
            );

            const compressor = new THREE.Mesh(
              new THREE.CylinderGeometry(0.05, 0.05, 0.07, 14),
              blockMat,
            );
            compressor.position.set(bx - 0.5, turboY, bz - 0.18);
            compressor.rotation.x = Math.PI / 2;
            add(compressor);

            add(
              tube(
                [
                  new THREE.Vector3(bx - 0.5, turboY, bz - 0.14),
                  new THREE.Vector3(bx - 0.3, by + 0.24, bz + 0.06),
                  new THREE.Vector3(bx, plenumY, bz + 0.18),
                ],
                0.026,
                pipeMat,
              ),
            );
          }

          // Accessory drive at the front of the block: crank pulley, an
          // idler, and the belt around them. Spins with the engine.
          const pulleyX = bx + (eng.cylinders >= 8 ? 0.46 : 0.34);
          for (const [py2, pr] of [
            [by + 0.04, 0.06],
            [by + 0.18, 0.038],
          ] as const) {
            // A cylinder's own axis is y; the group lays it across the car
            // and the mesh spins about that y inside it.
            add(
              spinner(
                new THREE.CylinderGeometry(pr, pr, 0.03, 16),
                pipeMat,
                [pulleyX, py2, bz],
                [0, 0, Math.PI / 2],
                0.1,
                "y", // cylinder is built around y
              ),
            );
          }
          const belt = new THREE.Mesh(
            new THREE.TorusGeometry(0.1, 0.008, 6, 24),
            wireMat,
          );
          belt.position.set(pulleyX, by + 0.11, bz);
          belt.rotation.y = Math.PI / 2;
          add(belt);
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
      // Scratch vector for the per-frame hotspot projection. Allocated once
      // — a fresh Vector3 per pin per frame is 240/sec of garbage for
      // something that never needs to outlive the loop body.
      const projected = new THREE.Vector3();
      /** Last published pin positions, for change detection. */
      let lastPins: { id: string; x: number; y: number; visible: boolean }[] = [];
      /** Previous focus, so releasing it can hand the camera back. */
      let lastFocus: string | null = null;

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
          for (const s of spinParts) {
            s.mesh.rotation[s.axis ?? "z"] += s.rate * pulseRate;
          }
          // Active aero deploys while the engine is under load — during a
          // dive or a hotspot focus — and settles back at rest.
          if (aeroFlap) {
            const deployed = diveFrames > 0 || !!focusRef.current;
            const want = aeroFlap.base + (deployed ? -0.5 : 0);
            aeroFlap.mesh.rotation.z +=
              (want - aeroFlap.mesh.rotation.z) * 0.08;
          }

          // Charge packets travelling the loom. Wrapped to 0..1 so each
          // one runs ECU -> cylinder, repeatedly, at the engine's own rate.
          for (const f of flowParts) {
            const u = (t * f.speed * pulseRate + f.offset) % 1;
            f.curve.getPointAt(u, f.mesh.position);
            // Fade in and out at the ends so packets appear to enter and
            // leave the lead rather than teleporting back to its start.
            const fade = Math.sin(u * Math.PI);
            f.mesh.scale.setScalar(0.5 + fade * 0.9);
          }
          if (hotRef) hotRef.emissiveIntensity = HOT_EMISSIVE + beat * 0.9;
        }

        // X-ray the bodywork while diving. The engine is genuinely inside
        // the car, so without this the camera flies in and shows you a
        // closed panel. Eased both ways so panels dissolve and re-form
        // rather than blinking.
        const wantOpacity = diveFrames > 0 ? 0.16 : 1;
        paint.opacity += (wantOpacity - paint.opacity) * (reduced ? 1 : 0.08);
        glass.opacity = GLASS_OPACITY * paint.opacity;

        // ── Hotspot focus ────────────────────────────────────────────
        // Selecting a callout pushes the camera in on that subsystem.
        // Overrides the body framing but never the engine dive, which is
        // already a deliberate camera move and would otherwise be fought
        // for its whole duration.
        // ── IGNITE & DEPLOY ──────────────────────────────────────────
        // Three stages off one frame counter rather than three timers:
        // a timer that fires while the tab is backgrounded desynchronises
        // from the render loop and the car arrives somewhere the camera
        // is not. Driving everything from the frame count keeps the
        // sequence and the picture on the same clock by construction.
        if (launchRef.current && launchFrame === 0) launchFrame = 1;
        if (launchFrame > 0 && reduced) {
          // Reduced motion gets the destination, not the cinematic. A
          // camera flight, spinning wheels and a car accelerating out of
          // frame is precisely the class of motion this preference exists
          // to suppress — and every other animation in this stage already
          // honours it, so the launch skipping it was inconsistent as well
          // as unkind. Held one frame so the button's state is seen.
          launchFrame = -1;
          launchDoneRef.current?.();
        } else if (launchFrame > 0) {
          launchFrame++;
          const [ex, ey, ez] = engineAnchor(spec);

          if (launchFrame < LAUNCH.ignite) {
            // Stage 1 — ignition. The bay flares, the accent lines come
            // up, and the wheels start turning before anything moves.
            const k = launchFrame / LAUNCH.ignite;
            if (hotRef) hotRef.emissiveIntensity = HOT_EMISSIVE + k * 9;
            engineLight.intensity = 3.2 + k * 5;
            targetPos.set(ex + 3.4, ey + 1.1, ez + 4.2);
            targetAt.set(ex, ey, ez);
            wheelSpin += k * 0.5;
          } else if (launchFrame < LAUNCH.track) {
            // Stage 2 — drop to a low, wide tracking shot behind the car.
            const k =
              (launchFrame - LAUNCH.ignite) / (LAUNCH.track - LAUNCH.ignite);
            targetPos.set(-9 - k * 3, 0.75, 3.2);
            targetAt.set(0, 0.6, 0);
            wheelSpin += 0.5 + k * 0.8;
          } else {
            // Stage 3 — away. The car accelerates out of the studio; the
            // camera holds, so it leaves frame rather than being followed.
            const k =
              (launchFrame - LAUNCH.track) / (LAUNCH.away - LAUNCH.track);
            carGroup.position.x = k * k * 46;
            carGroup.position.y = k * k * 1.2;
            wheelSpin += 1.3;
            engineLight.intensity = 6.4 * (1 - k);
            if (launchFrame >= LAUNCH.away) {
              launchFrame = -1; // latched: fire once, never re-enter
              launchDoneRef.current?.();
            }
          }

          // Wheels turn for the whole sequence.
          for (const w of wheelSpinners) w.rotation.z = -wheelSpin;
        }

        const wantFocus = focusRef.current;
        // Releasing focus has to hand the camera BACK. Without this the
        // target vectors keep whatever the last callout set, so closing a
        // card left the car parked off to one side of the panel forever —
        // there was no code path that ever restored the body framing.
        if (wantFocus !== lastFocus) {
          if (!wantFocus && diveFrames === 0) frameBody(sel.current.bodyId);
          lastFocus = wantFocus;
        }
        // The launch owns the camera outright while it runs. Without this
        // the focus block below would recompute targetPos every frame and
        // drag the camera back onto a hotspot mid-drive-away.
        if (wantFocus && diveFrames === 0 && launchFrame === 0) {
          const spot = HOTSPOTS.find((h) => h.id === wantFocus);
          if (spot) {
            const [ax, ay, az] = hotspotAnchor(spec, spot.anchor);
            // Approach from the same side the viewer has rotated the car
            // to, so focusing never swings the camera around behind the
            // body and leaves them looking at the far flank.
            const face = Math.cos(carGroup.rotation.y);
            const dir = face >= 0 ? 1 : -1;
            // Distance derived from the framing we want, not guessed. A
            // hand-picked offset framed 1.1 units at this lens — narrower
            // than the car is tall — so the body overflowed the panel and
            // the push-in read as a crash zoom.
            const dist =
              (spot.frame ?? FOCUS_FRAME_HEIGHT) /
              (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));
            const d = spot.dir ?? FOCUS_DIR;
            const dl = Math.hypot(d[0], d[1], d[2]) || 1;
            targetPos.set(
              ax + (d[0] / dl) * dist * dir,
              ay + (d[1] / dl) * dist,
              az + (d[2] / dl) * dist,
            );
            // Floor the camera above the top of the tyres. Several shots
            // are deliberately low, and a low shot that keeps descending
            // as the framing tightens ends up inside a wheel — geometry
            // the lens then renders from the inside out.
            const wheelTop = Math.max(...spec.axles.map((a) => a.radius)) + 0.12;
            if (targetPos.y < wheelTop) targetPos.y = wheelTop;
            // Aim a little below the anchor. Looking dead-on at a point
            // near the roofline pushes the wheels out of the bottom of the
            // frame, and a car cropped at the tyres reads as a mistake
            // rather than as a close-up. Scaled with the shot: a tight
            // engine detail must not drop its subject out of frame.
            targetAt.set(ax, ay - 0.11 * (spot.frame ?? FOCUS_FRAME_HEIGHT), az);
          }
        }

        if (reduced) {
          camPos.copy(targetPos);
          camAt.copy(targetAt);
        } else {
          // Critically damped rather than a fixed lerp: the further the
          // camera is from its mark the faster it closes, so a long move
          // between framings does not crawl and a short one does not snap.
          // gsap/react-spring would do the same job, at the cost of a
          // dependency and of owning a tween that the drag handler then
          // has to interrupt mid-flight.
          const reach = camPos.distanceTo(targetPos);
          const ease = Math.min(0.12, 0.035 + reach * 0.012);
          camPos.lerp(targetPos, ease);
          camAt.lerp(targetAt, ease * 1.3);
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
        // Drag is suspended during the launch — the car is leaving, and
        // letting someone spin it mid-departure looks like a bug.
        if (launchFrame === 0) carGroup.rotation.y = dragged ? spin : 0;
        if (!reduced) {
          const sweep = Math.sin(t * 0.35);
          rim.position.set(-5 + sweep * 2.6, 2.4, -4 + sweep * 1.1);
        }

        camera.position.copy(camPos);
        camera.lookAt(camAt);
        renderer.render(scene, camera);

        // ── Spatial callouts ─────────────────────────────────────────
        // Project each anchor through the camera into CSS pixels. The
        // anchors live in carGroup's local space, so applying the group's
        // world matrix is what makes a pin ride the body as it turns
        // instead of hovering at a fixed point in the frame.
        if (hotspotsRef.current) {
          const rect = renderer.domElement.getBoundingClientRect();
          const out: { id: string; x: number; y: number; visible: boolean }[] = [];
          for (const h of HOTSPOTS) {
            projected
              .set(...hotspotAnchor(spec, h.anchor))
              .applyMatrix4(carGroup.matrixWorld);
            // Occlusion test, before projection. Only the platform pin sits
            // off the centreline — the others are on it and can never be on
            // a "far" flank — so this asks one question: has the car been
            // turned far enough that this pin is now on the opposite side
            // of the body from the camera? If so it would punch through the
            // bodywork and hover over the near flank.
            const behindBody =
              h.anchor === "chassis" && projected.z * camPos.z < 0;
            projected.project(camera);
            const px = (projected.x * 0.5 + 0.5) * rect.width;
            const py = (-projected.y * 0.5 + 0.5) * rect.height;
            // Cull off-panel as well as behind-camera. z<1 alone only
            // rejects points behind the lens, so on a close-up the pins
            // for other subsystems projected to coordinates outside the
            // canvas and rendered as loose dots floating over the page.
            const onPanel =
              px > 8 && px < rect.width - 8 && py > 8 && py < rect.height - 8;
            out.push({
              id: h.id,
              x: px,
              y: py,
              visible: projected.z < 1 && onPanel && !behindBody && diveFrames === 0,
            });
          }

          // Only publish when something actually moved. This callback is a
          // React setState, and handing it a fresh array every frame
          // re-renders the whole builder — selectors, callouts and all — 60
          // times a second. The car is static at rest (there is no idle
          // sway any more), so at rest that is 60 identical renders per
          // second for nothing. Half a pixel is below the threshold of
          // anyone noticing a pin lag a frame behind the body.
          let moved = out.length !== lastPins.length;
          if (!moved) {
            for (let i = 0; i < out.length; i++) {
              const a = out[i];
              const b = lastPins[i];
              if (
                a.visible !== b.visible ||
                Math.abs(a.x - b.x) > 0.5 ||
                Math.abs(a.y - b.y) > 0.5
              ) {
                moved = true;
                break;
              }
            }
          }
          if (moved) {
            lastPins = out;
            hotspotsRef.current(out);
          }
        }

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
