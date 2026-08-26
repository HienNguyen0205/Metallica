"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, Color, InstancedBufferAttribute, Sprite } from "three";
import { PointsNodeMaterial } from "three/webgpu";
import {
  float,
  instancedBufferAttribute,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  positionView,
} from "three/tsl";
import { buildParticleField } from "./particleField";

interface GpuUniforms {
  uTime: { value: number };
  uIntensity: { value: number };
  uColor: { value: Color };
}

/**
 * §20 WebGPU path. The orbital motion is a pure function of time and the
 * per-particle attributes, so this needs no compute pass or storage buffer —
 * the same maths the GLSL vertex shader does, expressed in TSL.
 *
 * WebGPU only rasterises 1px point primitives, so sized particles have to be
 * an instanced Sprite rather than THREE.Points.
 */
export default function CoreParticlesGPU({
  count = 900,
  color,
  intensity = 1,
  innerRadius = 1.1,
  span = 2.6,
}: {
  count?: number;
  color: string;
  intensity?: number;
  innerRadius?: number;
  span?: number;
}) {
  const smoothed = useRef(intensity);

  const spriteRef = useRef<Sprite | null>(null);

  const sprite = useMemo(() => {
    const field = buildParticleField(count, innerRadius, span);
    // instancedBufferAttribute is typed Node<unknown> even though it yields a
    // float node here; the cast keeps the TSL chain below properly typed.
    const instanced = (data: Float32Array) =>
      float(instancedBufferAttribute(new InstancedBufferAttribute(data, 1)) as never);

    const aRadius = instanced(field.aRadius);
    const aAngle = instanced(field.aAngle);
    const aSpeed = instanced(field.aSpeed);
    const aTilt = instanced(field.aTilt);
    const aY = instanced(field.aY);
    const aSize = instanced(field.aSize);

    const uTime = uniform(0);
    const uIntensity = uniform(intensity);
    const uColor = uniform(new Color(color));

    // orbit, then tilt the orbital plane about X — mirrors the GLSL path
    const angle = aAngle.add(uTime.mul(aSpeed).mul(uIntensity));
    const flat = vec3(angle.cos().mul(aRadius), float(0), angle.sin().mul(aRadius));
    const ct = aTilt.cos();
    const st = aTilt.sin();
    const orbit = vec3(
      flat.x,
      flat.y.mul(ct).sub(flat.z.mul(st)),
      flat.y.mul(st).add(flat.z.mul(ct)),
    );

    const material = new PointsNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    material.positionNode = vec3(orbit.x, orbit.y.add(aY), orbit.z);
    material.scaleNode = aSize.mul(0.021);
    material.colorNode = uColor;

    // hard core + thin halo, matching the GLSL fragment shape
    const d = float(uv().sub(vec2(0.5, 0.5)).length());
    const core = float(1).sub(smoothstep(float(0), float(0.22), d));
    const halo = float(1).sub(smoothstep(float(0.18), float(0.5), d)).mul(0.35);
    // depth grading — far motes recede rather than sitting at one brightness
    const depth = float(positionView.z.negate());
    const far = float(1).sub(smoothstep(float(7), float(13.5), depth));
    material.opacityNode = core.add(halo).clamp(0, 1).mul(far).mul(0.55);

    const sprite = new Sprite(material);
    sprite.count = count;
    // positions are computed on the GPU, so the CPU-side bounds are wrong
    sprite.frustumCulled = false;
    // uniforms ride on the object so the frame loop reaches them through a
    // ref rather than through a hook return value
    sprite.userData.uniforms = { uTime, uIntensity, uColor } satisfies GpuUniforms;

    return sprite;
  }, [count, innerRadius, span, color, intensity]);

  useEffect(() => {
    return () => {
      sprite.material.dispose();
      sprite.geometry.dispose();
    };
  }, [sprite]);

  useFrame((_, delta) => {
    const u = spriteRef.current?.userData.uniforms as GpuUniforms | undefined;
    if (!u) return;
    u.uTime.value += delta;
    // ease intensity so state changes feel like the field spinning up
    smoothed.current += (intensity - smoothed.current) * Math.min(1, delta * 2.5);
    u.uIntensity.value = smoothed.current;
    u.uColor.value.set(color);
  });

  return <primitive ref={spriteRef} object={sprite} />;
}
