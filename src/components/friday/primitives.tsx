"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Line, Text } from "@react-three/drei";
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Line as ThreeLine,
  LineBasicMaterial,
  Object3D,
  Vector3,
  type Group,
  type InstancedMesh,
} from "three";
import "./effects/materials";

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
export function TechLabel({
  children,
  position,
  color = "#38e8ff",
  size = 0.075,
  opacity = 1,
  anchorX = "center",
}: {
  children: string;
  position: [number, number, number];
  color?: string;
  size?: number;
  opacity?: number;
  anchorX?: "center" | "left" | "right";
}) {
  return (
    <Billboard position={position}>
      <Text
        fontSize={size}
        color={color}
        anchorX={anchorX}
        anchorY="middle"
        letterSpacing={0.16}
        fillOpacity={opacity}
        outlineWidth={0}
      >
        {children.toUpperCase()}
      </Text>
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
 * Rendering-compat flag: true inside a WebGPU session where Line2/GLSL
 * materials are unavailable and hairlines must come from LineBasicMaterial.
 */
const HairlinesOnly = createContext(false);

export function RenderCompatProvider({ value, children }: { value: boolean; children: React.ReactNode }) {
  return <HairlinesOnly.Provider value={value}>{children}</HairlinesOnly.Provider>;
}

/** A technical hairline that renders on both WebGL2 (wide Line2) and WebGPU (1px GL lines). */
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
  const hairlinesOnly = useContext(HairlinesOnly);

  const primitive = useMemo(() => {
    if (!hairlinesOnly) return null;
    const geometry = new BufferGeometry().setFromPoints(points.map((p) => new Vector3(...p)));
    const material = new LineBasicMaterial({
      color: new Color(color),
      transparent: opacity < 1,
      opacity,
      toneMapped: false,
      depthWrite: false,
    });
    return new ThreeLine(geometry, material);
    // points identity changes when the caller recomputes data
  }, [hairlinesOnly, points, color, opacity]);

  useEffect(() => {
    if (!primitive) return;
    return () => {
      primitive.geometry.dispose();
      (primitive.material as LineBasicMaterial).dispose();
    };
  }, [primitive]);

  if (hairlinesOnly && primitive) return <primitive object={primitive} />;
  return <Line points={points} color={color} transparent opacity={opacity} lineWidth={lineWidth} />;
}
