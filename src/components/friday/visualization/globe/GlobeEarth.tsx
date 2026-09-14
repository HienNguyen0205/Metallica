"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Vector2,
  Vector3,
} from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import {
  abs,
  float,
  mix,
  mx_noise_float,
  normalView,
  normalWorld,
  positionLocal,
  positionViewDirection,
  smoothstep,
  texture,
  uniform,
  vec3,
} from "three/tsl";
import { useEarthTextures, type EarthTextureSet } from "./earthTextures";
import { buildGraticule } from "./geo";

/** How long the loaded imagery dissolves in over the procedural base. */
const FADE_MS = 600;

/**
 * Earth seen from space, rendered through FRIDAY's holographic system.
 *
 * Textured primary (Blue Marble day/night + water roughness + topology bump,
 * see public/assets/globe/ASSETS.md) that dissolves in over a procedural
 * fallback surface — no hard pop when the imagery finishes loading, and the
 * procedural surface stays permanently if an asset fails (§71). A faint lat/lon
 * graticule + wireframe read as technical aids under a fresnel atmosphere, kept
 * low so the photoreal surface stays the hero (§25/§50).
 *
 * All materials are TSL node materials, so the WebGPU backend and the WebGL2
 * fallback render the same scene from the same source (§38).
 */

/**
 * MaterialX Perlin noise is zero-mean gradient noise (≈ −0.7…+0.7), NOT
 * 0…1 — every threshold below assumes a remapped field, so remap here once
 * instead of scattering magic offsets at each call site.
 */
function noise01(node: ReturnType<typeof mx_noise_float>) {
  return node.mul(0.5).add(0.5);
}

function useDisposable<T extends { dispose: () => void }>(material: T): T {
  useEffect(() => () => material.dispose(), [material]);
  return material;
}

/**
 * Procedural fallback surface — renders while the imagery set loads and
 * underneath it during the crossfade (also the back-side-marker occluder while
 * the imagery is still transparent), and stays permanently if any asset fails
 * (§71). Deliberately simple: the textured surface is the primary visual.
 */
function ProceduralEarthSurface({ radius, segments }: { radius: number; segments: number }) {
  const material = useMemo(() => {
    const mat = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0 });
    const p = positionLocal.div(radius);
    const n1 = noise01(mx_noise_float(p.mul(3.1).add(vec3(3.1, 7.7, 1.3))));
    const n2 = noise01(mx_noise_float(p.mul(6.3).add(vec3(9.2, 1.7, 5.5))));
    const n3 = noise01(mx_noise_float(p.mul(12.7).add(vec3(5.3, 2.9, 8.1))));
    const ridge = float(1).sub(abs(mx_noise_float(p.mul(7.2).add(vec3(1.1, 4.4, 6.6)))));
    const cont = n1.mul(0.5).add(n2.mul(0.28)).add(n3.mul(0.12)).add(ridge.mul(0.1));
    const detail = noise01(mx_noise_float(p.mul(9.0).add(vec3(1.2, 5.9, 3.3))));

    const land = smoothstep(0.52, 0.565, cont);
    const coast = smoothstep(0.5, 0.525, cont).sub(smoothstep(0.525, 0.575, cont));
    const shelf = smoothstep(0.38, 0.52, cont);
    const ocean = mix(vec3(0.012, 0.05, 0.14), vec3(0.02, 0.17, 0.3), shelf);

    const lat = abs(p.y);
    const arid = smoothstep(0.3, 0.42, lat).sub(smoothstep(0.52, 0.64, lat));
    const green = mix(vec3(0.03, 0.14, 0.04), vec3(0.09, 0.27, 0.06), detail);
    const dry = mix(vec3(0.3, 0.24, 0.1), vec3(0.45, 0.34, 0.17), detail);
    const elev = smoothstep(0.58, 0.85, cont);
    const landCol = mix(mix(green, dry, arid), vec3(0.28, 0.19, 0.11), elev);
    const beachy = mix(landCol, vec3(0.5, 0.43, 0.26), coast.mul(0.85));

    const ice = smoothstep(0.86, 0.93, lat.add(detail.mul(0.05)));
    mat.colorNode = mix(mix(ocean, beachy, land), vec3(0.72, 0.8, 0.84), ice.mul(0.9));
    mat.roughnessNode = mix(float(0.95), float(0.32), float(1).sub(land));
    const cities = smoothstep(0.76, 0.9, noise01(mx_noise_float(p.mul(30.0)))).mul(land).mul(
      float(1).sub(ice),
    );
    mat.emissiveNode = vec3(1.0, 0.62, 0.3).mul(cities).mul(0.45);
    return mat;
  }, [radius]);
  useDisposable(material);

  return (
    <mesh material={material}>
      <sphereGeometry args={[radius, segments, segments]} />
    </mesh>
  );
}

/**
 * Real Earth imagery surface (gap analysis P0): Blue Marble albedo, water-mask
 * roughness (wet ocean glints, land matte), topology bump, and a sun-driven
 * night-light blend on the dark side.
 *
 * Crossfade: while `!revealed` the material is transparent and dissolves in via
 * the `fade` opacity uniform over the procedural base (which supplies depth so
 * back-side markers stay hidden meanwhile). On completion the parent flips
 * `revealed`, this rebuilds opaque (writing depth, occluding markers on its own)
 * and the base is dropped. `sunDir` is a shared world-space direction the
 * caller advances for the slow terminator cycle.
 *
 * The two uniforms live in refs and are mutated through `.current` in the frame
 * loop — the React Compiler forbids mutating a value returned from `useMemo`
 * after render, but refs are explicitly mutable.
 */
function TexturedEarthSurface({
  radius,
  segments,
  textures,
  sunDir,
  reduced,
  revealed,
  onRevealed,
}: {
  radius: number;
  segments: number;
  textures: EarthTextureSet;
  sunDir: Vector3;
  reduced: boolean;
  revealed: boolean;
  onRevealed: () => void;
}) {
  const done = useRef(false);
  const start = useRef(0);

  const surf = useMemo(() => {
    // Uniforms are created inside the memo and mutated only through methods on
    // their `.value` in the frame loop (`copy` / `Vector2.set`) — the React
    // Compiler rejects assigning to properties of hook-returned values after
    // render, but method calls on the underlying THREE vectors are fine (the
    // same pattern `EarthAtmosphere` uses with `uColor.value.set`).
    const sunU = uniform(sunDir.clone());
    const fadeU = uniform(new Vector2(reduced ? 1 : 0, 0));
    const mat = new MeshStandardNodeMaterial({
      roughness: 0.85,
      metalness: 0.0,
      transparent: !revealed,
      depthWrite: revealed,
    });
    mat.colorNode = texture(textures.day);
    // Dedicated planetary sun: soft terminator, city lights only past it.
    const dayAmount = smoothstep(float(-0.08), float(0.25), normalWorld.dot(sunU));
    mat.emissiveNode = texture(textures.night).mul(float(1).sub(dayAmount)).mul(1.15);
    mat.roughnessNode = textures.water
      ? mix(float(0.9), float(0.32), texture(textures.water).r)
      : float(0.8);
    if (!revealed) mat.opacityNode = fadeU.x;
    if (textures.topology) {
      mat.bumpMap = textures.topology;
      mat.bumpScale = 0.5;
    }
    return { mat, sunU, fadeU };
  }, [textures, revealed, reduced, sunDir]);
  useDisposable(surf.mat);

  useEffect(() => {
    start.current = performance.now();
  }, []);

  useFrame(() => {
    surf.sunU.value.copy(sunDir);
    if (revealed || done.current) return;
    const p = reduced ? 1 : Math.min(1, (performance.now() - start.current) / FADE_MS);
    surf.fadeU.value.set(p, 0);
    if (p >= 1) {
      done.current = true;
      onRevealed();
    }
  });

  // 1.0006 keeps the dissolving overlay just outside the base sphere so the two
  // don't z-fight; at rest it collapses back to 1 (the base is gone).
  return (
    <mesh material={surf.mat} scale={revealed ? 1 : 1.0006}>
      <sphereGeometry args={[radius, segments, segments]} />
    </mesh>
  );
}

/** Faint lat/lon grid — a technical aid that reinforces "globe" without tinting. */
function EarthGraticule({ radius, color }: { radius: number; color: string }) {
  const geometry = useMemo(() => {
    const pairs = buildGraticule(radius, 12, 6, 48);
    const arr = new Float32Array(pairs.length * 3);
    for (let i = 0; i < pairs.length; i++) {
      const p = pairs[i]!;
      arr[i * 3] = p[0];
      arr[i * 3 + 1] = p[1];
      arr[i * 3 + 2] = p[2];
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(arr, 3));
    return g;
  }, [radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);

  return (
    <lineSegments geometry={geometry} frustumCulled={false}>
      <lineBasicMaterial color={color} transparent opacity={0.06} depthWrite={false} toneMapped={false} />
    </lineSegments>
  );
}

function EarthWireframe({ radius, color }: { radius: number; color: string }) {
  return (
    <mesh scale={1.002}>
      <sphereGeometry args={[radius, 36, 24]} />
      <meshBasicMaterial color={color} wireframe transparent opacity={0.035} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

function EarthAtmosphere({ radius, color }: { radius: number; color: string }) {
  const material = useMemo(() => {
    // Initial tint is frame-zero only — live state colors arrive via the
    // effect below so a state transition never recompiles the shader.
    const uColor = uniform(new Color("#38e8ff"));
    const mat = new MeshBasicNodeMaterial({
      side: BackSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    mat.colorNode = uColor;
    const facing = normalView.dot(positionViewDirection).clamp(0, 1);
    // Kept closest to the silhouette — the surface is the hero now (§25).
    mat.opacityNode = float(1).sub(facing).pow(3.5).mul(0.5);
    return { mat, uColor };
  }, []);
  useDisposable(material.mat);

  useEffect(() => {
    material.uColor.value.set(color);
  }, [material, color]);

  return (
    <mesh material={material.mat} scale={1.035}>
      <sphereGeometry args={[radius, 64, 64]} />
    </mesh>
  );
}

export function GlobeEarth({
  radius,
  segments,
  color,
  detail,
  reduced,
  sunDir,
}: {
  radius: number;
  segments: number;
  color: string;
  /** Relief/specular detail maps — off on the low tier. */
  detail: boolean;
  /** Reduced motion — skips the dissolve, freezes the terminator. */
  reduced: boolean;
  /** Live world-space sun direction, advanced by the parent's frame loop. */
  sunDir: Vector3;
}) {
  // Anisotropy comes from the live renderer so near-limb albedo stays crisp on
  // hardware above the old hard-coded 4. The API differs per backend
  // (WebGPURenderer: getMaxAnisotropy(); WebGLRenderer:
  // capabilities.getMaxAnisotropy()); default to 1 — never above any device's
  // sampler limit, since WebGPU does NOT clamp maxAnisotropy and over-requesting
  // throws at sampler creation.
  const maxAnisotropy = useThree((s) => {
    const gl = s.gl as unknown as {
      getMaxAnisotropy?: () => number;
      capabilities?: { getMaxAnisotropy?: () => number };
    };
    try {
      return gl.getMaxAnisotropy?.() ?? gl.capabilities?.getMaxAnisotropy?.() ?? 1;
    } catch {
      return 1;
    }
  });
  const textures = useEarthTextures(detail, maxAnisotropy);

  // The procedural base stays under the imagery until the dissolve completes,
  // then the (now-opaque) textured surface owns the frame. A *new* imagery set
  // (quality-tier change) restarts the dissolve: `revealed` flips back to false
  // and `epoch` bumps to remount the overlay with fresh fade refs. Both are
  // render-time derived state (React's "adjust state when a prop changes"),
  // never a setState-in-effect.
  const [revealed, setRevealed] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [lastTextures, setLastTextures] = useState(textures);
  if (lastTextures !== textures) {
    setLastTextures(textures);
    setRevealed(false);
    setEpoch((e) => e + 1);
  }
  const onRevealed = useCallback(() => setRevealed(true), []);

  return (
    <group>
      {(!textures || !revealed) && <ProceduralEarthSurface radius={radius} segments={segments} />}
      {textures && (
        <TexturedEarthSurface
          key={epoch}
          radius={radius}
          segments={segments}
          textures={textures}
          sunDir={sunDir}
          reduced={reduced}
          revealed={revealed}
          onRevealed={onRevealed}
        />
      )}
      <EarthGraticule radius={radius + 0.004} color={color} />
      <EarthWireframe radius={radius} color={color} />
      <EarthAtmosphere radius={radius} color={color} />
    </group>
  );
}
