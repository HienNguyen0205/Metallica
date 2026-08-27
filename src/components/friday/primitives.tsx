"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import { DoubleSide, Object3D, type Group, type InstancedMesh } from "three";
import { createLabelTexture } from "./effects/textTexture";
import { Line2NodeMaterial } from "three/webgpu";
import { Line2 } from "three/addons/lines/webgpu/Line2.js";
import { LineGeometry } from "three/addons/lines/LineGeometry.js";

/**
 * §3 — dashed arc built from instanced quads. Matrices are written once on
 * mount; motion comes from rotating the parent, so per-frame cost is nil.
 */
export function ArcSegments({
  radius,
  count = 48,
  span = Math.PI * 2,
  start = 0,
  gap = 0.4,
  thickness = 0.018,
  color,
  opacity = 0.55,
  /** every nth segment is drawn longer, like a measuring dial */
  majorEvery = 0,
  majorScale = 2.4,
  fraction,
}: {
  radius: number;
  count?: number;
  span?: number;
  start?: number;
  gap?: number;
  thickness?: number;
  color: string;
  opacity?: number;
  majorEvery?: number;
  majorScale?: number;
  /** 0..1 — draws only the first portion of the arc, eased over time. */
  fraction?: number;
}) {
  const ref = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const shown = useRef(0);

  useFrame((_, delta) => {
    if (!ref.current || fraction === undefined) return;
    shown.current += (fraction * count - shown.current) * Math.min(1, delta * 4);
    // §9 — a gauge fills by revealing segments; no geometry is rebuilt
    ref.current.count = Math.max(0, Math.round(shown.current));
  });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const step = span / count;
    const len = step * radius * (1 - gap);
    for (let i = 0; i < count; i++) {
      const angle = start + i * step;
      const major = majorEvery > 0 && i % majorEvery === 0;
      dummy.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
      dummy.rotation.set(0, 0, angle + Math.PI / 2);
      dummy.scale.set(thickness * (major ? majorScale : 1), len, 1);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  }, [radius, count, span, start, gap, thickness, majorEvery, majorScale, dummy]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={DoubleSide} toneMapped={false} depthWrite={false} />
    </instancedMesh>
  );
}

/** A ring of radial ticks — the "engineered, not decorative" dial marks. */
export function TickDial({
  radius,
  count = 72,
  color,
  opacity = 0.45,
  length = 0.055,
}: {
  radius: number;
  count?: number;
  color: string;
  opacity?: number;
  length?: number;
}) {
  const ref = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);

  useLayoutEffect(() => {
    if (!ref.current) return;
    for (let i = 0; i < count; i++) {
      const angle = (i / count) * Math.PI * 2;
      const major = i % 6 === 0;
      dummy.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0);
      dummy.rotation.set(0, 0, angle + Math.PI / 2);
      dummy.scale.set(major ? 0.022 : 0.011, major ? length * 1.8 : length, 1);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
    }
    ref.current.instanceMatrix.needsUpdate = true;
  }, [radius, count, length, dummy]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, count]}>
      <planeGeometry args={[1, 1]} />
      <meshBasicMaterial color={color} transparent opacity={opacity} side={DoubleSide} toneMapped={false} depthWrite={false} />
    </instancedMesh>
  );
}

/** §3 — HUD reticle: a crosshair of four ticks with a gap in the middle. */
export function Reticle({
  position,
  color,
  size = 0.14,
  opacity = 0.5,
}: {
  position: [number, number, number];
  color: string;
  size?: number;
  opacity?: number;
}) {
  const arms: [number, number, number][][] = [
    [[-size * 2, 0, 0], [-size, 0, 0]],
    [[size, 0, 0], [size * 2, 0, 0]],
    [[0, -size * 2, 0], [0, -size, 0]],
    [[0, size, 0], [0, size * 2, 0]],
  ];
  return (
    <Billboard position={position}>
      {arms.map((points, i) => (
        <HairLine key={i} points={points} color={color} opacity={opacity} lineWidth={1} />
      ))}
      <mesh>
        <ringGeometry args={[size * 0.55, size * 0.62, 24]} />
        <meshBasicMaterial color={color} transparent opacity={opacity * 0.8} side={DoubleSide} toneMapped={false} />
      </mesh>
    </Billboard>
  );
}

/** Corner brackets framing the focal object, kept in the foreground plane. */
export function CornerBrackets({
  half = 2.5,
  arm = 0.36,
  z = 1.4,
  color,
  opacity = 0.4,
}: {
  half?: number;
  arm?: number;
  z?: number;
  color: string;
  opacity?: number;
}) {
  const corners = useMemo(
    () =>
      [
        [-1, 1],
        [1, 1],
        [-1, -1],
        [1, -1],
      ].map(([sx, sy]) => [
        [
          [sx * half, sy * (half - arm), z],
          [sx * half, sy * half, z],
          [sx * (half - arm), sy * half, z],
        ] as [number, number, number][],
      ]),
    [half, arm, z],
  );

  return (
    <>
      {corners.map(([points], i) => (
        <HairLine key={i} points={points} color={color} opacity={opacity} lineWidth={1.2} />
      ))}
    </>
  );
}

/** §5 — billboarded telemetry text. Always faces camera, always tiny. */
const GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/\\<>#*+=%";

/**
 * §9 — labels resolve out of noise rather than popping in. Runs once on
 * mount, not on every text change: live readouts update several times a
 * second and would scramble permanently.
 */
function useDecoded(text: string, enabled: boolean, durationMs = 420) {
  const [shown, setShown] = useState(enabled ? "" : text);
  // only the first text a label ever renders gets decoded
  const initial = useRef(text);

  useEffect(() => {
    if (!enabled || text !== initial.current) {
      setShown(text);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / durationMs);
      const settled = Math.floor(text.length * p);
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (i < settled || ch === " " || ch === "·") out += ch;
        else out += GLYPHS[(i * 31 + Math.floor(performance.now() / 45)) % GLYPHS.length];
      }
      setShown(p < 1 ? out : text);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, enabled, durationMs]);

  return shown;
}

export function TechLabel({
  children,
  position,
  color = "#38e8ff",
  size = 0.075,
  opacity = 1,
  anchorX = "center",
  decode = false,
}: {
  children: string;
  position: [number, number, number];
  color?: string;
  size?: number;
  opacity?: number;
  anchorX?: "center" | "left" | "right";
  /** resolve the text out of scrambled glyphs on first appearance */
  decode?: boolean;
}) {
  const text = useDecoded(children.toUpperCase(), decode);
  const label = useMemo(() => createLabelTexture(text, color, opacity), [text, color, opacity]);

  useEffect(() => label.dispose, [label]);

  // the texture carries padding around the glyphs, so the quad is scaled from
  // the drawn line height rather than from `size` directly
  const height = size * 2.2;
  const width = height * label.aspect;
  const shift = anchorX === "center" ? 0 : anchorX === "left" ? width / 2 : -width / 2;

  return (
    <Billboard position={position}>
      <mesh position={[shift, 0, 0]}>
        <planeGeometry args={[width, height]} />
        <primitive object={label.material} attach="material" />
      </mesh>
    </Billboard>
  );
}

/**
 * §9 — data does not pop in, it materializes: scale + spin settle over ~0.8s.
 * Returns a ref to attach to the group being revealed.
 */
export function useMaterialize(duration = 0.8, enabled = true, delay = 0) {
  const ref = useRef<Group>(null);
  const t = useRef(-delay);

  useLayoutEffect(() => {
    t.current = -delay;
    if (ref.current && enabled) ref.current.scale.setScalar(0.001);
  }, [enabled, delay]);

  useFrame((_, delta) => {
    if (!ref.current || !enabled || t.current >= 1) return;
    t.current = Math.min(1, t.current + delta / duration);
    const clamped = Math.max(0, t.current);
    const e = 1 - Math.pow(1 - clamped, 3);
    ref.current.scale.setScalar(Math.max(0.001, e));
    ref.current.rotation.y = (1 - e) * 0.7;
  });

  return ref;
}

/** Connector from the core out to a floating element. */
export function Connector({
  to,
  color,
  opacity = 0.22,
}: {
  to: [number, number, number];
  color: string;
  opacity?: number;
}) {
  return <HairLine points={[[0, 0, 0], to]} color={color} opacity={opacity} />;
}

/**
 * A technical hairline with real screen-space width.
 *
 * Not drei's `<Line>`: that builds a `LineMaterial`, which is a raw
 * `ShaderMaterial` and cannot compile on the node renderer. three ships a
 * WebGPU-side `Line2` backed by `Line2NodeMaterial` that does the same
 * screen-space widening, so the wide lines survive the move rather than
 * collapsing to 1px GL lines — which at dpr 2 read as barely-there scratches.
 */
export function HairLine({
  points,
  color,
  opacity = 1,
  lineWidth = 1,
}: {
  points: [number, number, number][];
  color: string;
  opacity?: number;
  lineWidth?: number;
}) {
  const line = useMemo(() => {
    const geometry = new LineGeometry();
    geometry.setPositions(points.flat());
    const material = new Line2NodeMaterial({
      color,
      linewidth: lineWidth,
      transparent: opacity < 1,
      opacity,
      toneMapped: false,
      depthWrite: false,
    });
    return new Line2(geometry, material);
    // points identity changes when the caller recomputes data
  }, [points, color, opacity, lineWidth]);

  useEffect(() => {
    return () => {
      line.geometry.dispose();
      line.material.dispose();
    };
  }, [line]);

  return <primitive object={line} />;
}
