"use client";

import { useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, Object3D, type InstancedMesh } from "three";
import type { SeriesDatum, TimelineEvent } from "@/lib/store";
import { HairLine, TechLabel, useMaterialize } from "../primitives";

export interface ChartProps {
  series?: SeriesDatum[];
  events?: TimelineEvent[];
  color: string;
  accent: string;
}

const W = 4.4;
const H = 1.5;

/** Thin reference plane the charts sit on — lines only, never a panel. */
function ChartFloor({ color }: { color: string }) {
  const lines = useMemo(() => {
    const out: [number, number, number][][] = [];
    for (let i = 0; i <= 4; i++) {
      const y = -H / 2 + (i / 4) * H;
      out.push([
        [-W / 2, y, 0],
        [W / 2, y, 0],
      ]);
    }
    for (let i = 0; i <= 8; i++) {
      const x = -W / 2 + (i / 8) * W;
      out.push([
        [x, -H / 2, 0],
        [x, -H / 2 + 0.08, 0],
      ]);
    }
    return out;
  }, []);

  return (
    <>
      {lines.map((points, i) => (
        <HairLine key={i} points={points} color={color} opacity={i < 5 ? 0.1 : 0.3} lineWidth={1} />
      ))}
    </>
  );
}

const DEFAULT_SERIES: SeriesDatum[] = [
  { label: "LOAD", points: [22, 38, 31, 55, 47, 68, 62, 79, 73] },
];

/** §6 time series → 3D line graph, layered in depth per series. */
export function LineChart3D({ series = DEFAULT_SERIES, color, accent }: ChartProps) {
  const ref = useMaterialize(0.8);
  const data = series.length ? series : DEFAULT_SERIES;

  return (
    <group ref={ref} position={[0, 0, 0]} rotation={[0, -0.35, 0]}>
      <ChartFloor color={color} />
      {data.map((s, si) => {
        const max = Math.max(...s.points, 1);
        const pts: [number, number, number][] = s.points.map((p, i) => [
          -W / 2 + (i / Math.max(1, s.points.length - 1)) * W,
          -H / 2 + (p / max) * H,
          si * -0.4,
        ]);
        return (
          <group key={s.label}>
            <HairLine points={pts} color={si === 0 ? color : accent} opacity={0.9} lineWidth={2} />
            {pts.map((p, i) => (
              <group key={i} position={p}>
                <mesh>
                  <sphereGeometry args={[0.028, 8, 8]} />
                  <meshBasicMaterial color={si === 0 ? color : accent} toneMapped={false} />
                </mesh>
                <mesh
                  visible={false}
                  userData={{
                    viz: {
                      label: `${s.label} T${String(i).padStart(2, "0")}`,
                      detail: `${s.points[i]}`,
                    },
                  }}
                >
                  <sphereGeometry args={[0.09, 8, 8]} />
                </mesh>
              </group>
            ))}
            <TechLabel position={[-W / 2 - 0.1, pts[0][1], si * -0.4]} color={si === 0 ? color : accent} size={0.06} anchorX="right">
              {s.label}
            </TechLabel>
          </group>
        );
      })}
    </group>
  );
}

/** §6 discrete magnitudes → instanced 3D bars along an arc. */
export function BarChart3D({ series = DEFAULT_SERIES, color }: ChartProps) {
  const ref = useMaterialize(0.8);
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const values = series[0]?.points ?? DEFAULT_SERIES[0].points;
  const grown = useRef(0);

  useLayoutEffect(() => {
    grown.current = 0;
  }, [values]);

  useFrame((_, delta) => {
    if (!mesh.current) return;
    grown.current = Math.min(1, grown.current + delta * 1.6);
    const max = Math.max(...values, 1);
    const span = Math.PI * 0.9;
    for (let i = 0; i < values.length; i++) {
      const a = -span / 2 + (i / Math.max(1, values.length - 1)) * span;
      const h = (values[i] / max) * 1.5 * grown.current + 0.02;
      dummy.position.set(Math.sin(a) * 2.6, -0.9 + h / 2, Math.cos(a) * 2.6 - 2.6);
      dummy.rotation.set(0, -a, 0);
      dummy.scale.set(0.12, h, 0.12);
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group ref={ref}>
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, values.length]}
        userData={{ vizBar: { label: (series[0]?.label ?? "SEG").toUpperCase(), values } }}
      >
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={color} transparent opacity={0.45} toneMapped={false} depthWrite={false} />
      </instancedMesh>
    </group>
  );
}

const DEFAULT_EVENTS: TimelineEvent[] = [
  { label: "BOOT", at: 0 },
  { label: "SYNC", at: 0.28 },
  { label: "SCAN", at: 0.55 },
  { label: "ALERT", at: 0.78 },
  { label: "NOW", at: 1 },
];

/** §6 sequence → horizontal timeline axis with event ticks. */
export function Timeline3D({ events = DEFAULT_EVENTS, color, accent }: ChartProps) {
  const ref = useMaterialize(0.7);
  const data = events.length ? events : DEFAULT_EVENTS;

  return (
    <group ref={ref} position={[0, -1.95, 0.6]}>
      <HairLine
        points={[
          [-W / 2, 0, 0],
          [W / 2, 0, 0],
        ]}
        color={color}
        opacity={0.45}
        lineWidth={1.5}
      />
      {data.map((e, i) => {
        const x = -W / 2 + e.at * W;
        return (
          <group key={`${e.label}-${i}`} position={[x, 0, 0]}>
            <mesh
              visible={false}
              userData={{ viz: { label: e.label.toUpperCase(), detail: `T+${Math.round(e.at * 100)}%` } }}
            >
              <planeGeometry args={[0.42, 0.4]} />
            </mesh>
            <mesh>
              <planeGeometry args={[0.012, 0.18]} />
              <meshBasicMaterial color={i === data.length - 1 ? accent : color} transparent opacity={0.8} side={DoubleSide} toneMapped={false} />
            </mesh>
            <TechLabel position={[0, -0.2, 0]} color={i === data.length - 1 ? accent : color} size={0.055} opacity={0.7}>
              {e.label}
            </TechLabel>
          </group>
        );
      })}
    </group>
  );
}
