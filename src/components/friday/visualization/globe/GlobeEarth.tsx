"use client";

import { useEffect, useMemo } from "react";
import { AdditiveBlending, BackSide, Color, Vector3 } from "three";
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
import { SUN_DIRECTION } from "./geo";

/**
 * Earth seen from space, rendered through FRIDAY's holographic system.
 *
 * Textured primary (Blue Marble day/night + water roughness + topology bump,
 * see public/assets/globe/ASSETS.md) with a procedural fallback surface while
 * loading or when assets fail. Fresnel atmosphere kept faint so the surface
 * stays the hero; legacy wireframe kept as a faint secondary layer (§50).
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
 * stays permanently if any asset fails (§71). Deliberately simple: the
 * textured surface below is the primary visual.
 */
function ProceduralEarthSurface({ radius, segments }: { radius: number; segments: number }) {
  const material = useMemo(() => {
    const mat = new MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0.0 });
    // Unit-sphere coordinate so the continents stick to the surface while the
    // interaction rig turns the mesh (positionLocal is pre-transform).
    const p = positionLocal.div(radius);
    // Continent field: 3-octave fbm plus a ridged ridge term that carves
    // jagged, archipelago-like coastlines instead of soft blobs.
    const n1 = noise01(mx_noise_float(p.mul(3.1).add(vec3(3.1, 7.7, 1.3))));
    const n2 = noise01(mx_noise_float(p.mul(6.3).add(vec3(9.2, 1.7, 5.5))));
    const n3 = noise01(mx_noise_float(p.mul(12.7).add(vec3(5.3, 2.9, 8.1))));
    const ridge = float(1).sub(abs(mx_noise_float(p.mul(7.2).add(vec3(1.1, 4.4, 6.6)))));
    const cont = n1.mul(0.5).add(n2.mul(0.28)).add(n3.mul(0.12)).add(ridge.mul(0.1));
    const detail = noise01(mx_noise_float(p.mul(9.0).add(vec3(1.2, 5.9, 3.3))));

    // Crisp shoreline: a narrow band reads as a coast, a wide one as a smear.
    const land = smoothstep(0.52, 0.565, cont);
    // Thin sandy rim hugging the waterline.
    const coast = smoothstep(0.5, 0.525, cont).sub(smoothstep(0.525, 0.575, cont));
    // Shallow shelf lightens the ocean near land.
    const shelf = smoothstep(0.38, 0.52, cont);
    const ocean = mix(vec3(0.012, 0.05, 0.14), vec3(0.02, 0.17, 0.3), shelf);

    // Climate zones by latitude (|p.y| = sin(lat)): green tropics/temperate,
    // arid bands either side of the equator, brown highlands by elevation.
    const lat = abs(p.y);
    const arid = smoothstep(0.3, 0.42, lat).sub(smoothstep(0.52, 0.64, lat));
    const green = mix(vec3(0.03, 0.14, 0.04), vec3(0.09, 0.27, 0.06), detail);
    const dry = mix(vec3(0.3, 0.24, 0.1), vec3(0.45, 0.34, 0.17), detail);
    const elev = smoothstep(0.58, 0.85, cont);
    const landCol = mix(mix(green, dry, arid), vec3(0.28, 0.19, 0.11), elev);
    const beachy = mix(landCol, vec3(0.5, 0.43, 0.26), coast.mul(0.85));

    // Polar caps with a noise-wobbled edge rather than a straight band.
    const ice = smoothstep(0.86, 0.93, lat.add(detail.mul(0.05)));
    mat.colorNode = mix(mix(ocean, beachy, land), vec3(0.72, 0.8, 0.84), ice.mul(0.9));
    // Wet ocean catches a sun glint; land stays matte.
    mat.roughnessNode = mix(float(0.95), float(0.32), float(1).sub(land));
    // Night-side city speckle: an emissive term the day-side diffuse washes
    // out, so it reads only where the sun does not reach (§11).
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
 * Real Earth imagery surface (gap analysis P0): Blue Marble albedo, water
 * mask driven roughness (wet ocean glints, land stays matte), topology bump,
 * and a sun-direction-driven night-light blend on the dark side.
 */
function TexturedEarthSurface({
  radius,
  segments,
  textures,
}: {
  radius: number;
  segments: number;
  textures: EarthTextureSet;
}) {
  const material = useMemo(() => {
    const mat = new MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0.0 });
    mat.colorNode = texture(textures.day);
    // Dedicated planetary sun: soft terminator, city lights only past it.
    const sunDirection = uniform(new Vector3(SUN_DIRECTION[0], SUN_DIRECTION[1], SUN_DIRECTION[2]));
    const dayAmount = smoothstep(float(-0.08), float(0.25), normalWorld.dot(sunDirection));
    mat.emissiveNode = texture(textures.night).mul(float(1).sub(dayAmount)).mul(1.15);
    mat.roughnessNode = textures.water
      ? mix(float(0.9), float(0.32), texture(textures.water).r)
      : float(0.8);
    if (textures.topology) {
      mat.bumpMap = textures.topology;
      mat.bumpScale = 0.5;
    }
    return mat;
  }, [textures]);
  useDisposable(material);

  return (
    <mesh material={material}>
      <sphereGeometry args={[radius, segments, segments]} />
    </mesh>
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
}: {
  radius: number;
  segments: number;
  color: string;
  /** Relief/specular detail maps — off on the low tier. */
  detail: boolean;
}) {
  // Real imagery when available, procedural while loading or on asset
  // failure — the globe always renders something believable.
  const textures = useEarthTextures(detail);
  return (
    <group>
      {textures ? (
        <TexturedEarthSurface radius={radius} segments={segments} textures={textures} />
      ) : (
        <ProceduralEarthSurface radius={radius} segments={segments} />
      )}
      <EarthWireframe radius={radius} color={color} />
      <EarthAtmosphere radius={radius} color={color} />
    </group>
  );
}
