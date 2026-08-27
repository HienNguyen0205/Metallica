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

/**
 * Charts sit forward of and above the core rather than through it. The core
 * withdraws under a visualization (see FridayCore), but panel-style charts
 * still need their own plane to keep the ring system out of the gridlines.
 */
const CHART_ANCHOR: [number, number, number] = [0, 0.45, 1.1];

/**
 * Thin reference plane the charts sit on — lines only, never a panel.
 * Carries the y-scale: gridlines with no numbers against them told you the
 * shape of the data but never its magnitude.
 */
function ChartFloor({ color, max }: { color: string; max: number }) {
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
        // baseline reads stronger than the intermediate gridlines
        <HairLine key={i} points={points} color={color} opacity={i === 0 ? 0.45 : i < 5 ? 0.12 : 0.3} lineWidth={1} />
      ))}
      {[0, 0.5, 1].map((f) => (
        <TechLabel
          key={f}
          position={[W / 2 + 0.14, -H / 2 + f * H, 0]}
          color={color}
          size={0.07}
          opacity={0.6}
          anchorX="left"
        >
          {String(Math.round(max * f))}
        </TechLabel>
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
  // One shared scale across series — per-series maxima made two lines of very
  // different magnitude look identical.
  const max = Math.max(...data.flatMap((s) => s.points), 1);

  return (
    // Lifted and pushed forward off the core plane, and barely yawed: the old
    // -0.35 turn foreshortened the left half into the middle of the frame.
    <group ref={ref} position={CHART_ANCHOR} rotation={[0, -0.16, 0]}>
      <ChartFloor color={color} max={max} />
      {data.map((s, si) => {
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
                {/* the value itself — previously reachable only by clicking.
                    Series alternate above/below so two lines that cross do not
                    stack their numbers on top of each other. */}
                <TechLabel position={[0, si % 2 === 0 ? 0.14 : -0.14, 0]} color="#e5f6ff" size={0.062} opacity={0.75}>
                  {String(s.points[i])}
                </TechLabel>
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
            <TechLabel position={[-W / 2 - 0.14, pts[0][1], si * -0.4]} color={si === 0 ? color : accent} size={0.075} anchorX="right" decode>
              {s.label}
            </TechLabel>
          </group>
        );
      })}
    </group>
  );
}

/**
 * §6 discrete magnitudes → instanced 3D bars along an arc.
 *
 * The arc used to sweep 2.6 units backwards, which buried the middle of the
 * series inside the core and left the ends heavily foreshortened. It is now a
 * shallow curve in front of the core, on a visible baseline, with values.
 */
const BAR_RADIUS = 2.75;
/** Depth of the curve. Enough to read as wrapped, not enough to hide bars. */
const BAR_DEPTH = 0.85;
const BAR_BASE = -0.75;
const BAR_MAX_H = 1.5;
const BAR_SPAN = Math.PI * 0.62;

function barAngle(i: number, count: number) {
  return -BAR_SPAN / 2 + (i / Math.max(1, count - 1)) * BAR_SPAN;
}
function barPosition(i: number, count: number): [number, number, number] {
  const a = barAngle(i, count);
  return [Math.sin(a) * BAR_RADIUS, 0, CHART_ANCHOR[2] - (1 - Math.cos(a)) * BAR_DEPTH];
}

export function BarChart3D({ series = DEFAULT_SERIES, color, accent }: ChartProps) {
  const ref = useMaterialize(0.8);
  const mesh = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const values = series[0]?.points ?? DEFAULT_SERIES[0].points;
  const grown = useRef(0);
  const max = Math.max(...values, 1);
  const peak = values.indexOf(Math.max(...values));

  useLayoutEffect(() => {
    grown.current = 0;
  }, [values]);

  useFrame((_, delta) => {
    if (!mesh.current) return;
    grown.current = Math.min(1, grown.current + delta * 1.6);
    for (let i = 0; i < values.length; i++) {
      const a = barAngle(i, values.length);
      const [x, , z] = barPosition(i, values.length);
      const h = (values[i] / max) * BAR_MAX_H * grown.current + 0.02;
      dummy.position.set(x, BAR_BASE + h / 2, z);
      dummy.rotation.set(0, -a, 0);
      dummy.scale.set(0.16, h, 0.16);
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
        {/* opacity 0.45 over a bright core turned the bars to fog */}
        <meshBasicMaterial color={color} transparent opacity={0.72} toneMapped={false} depthWrite={false} />
      </instancedMesh>

      {/* common baseline — without it, bars at different depths have no shared
          reference and the eye cannot compare their heights */}
      <HairLine
        points={values.map((_, i) => {
          const [x, , z] = barPosition(i, values.length);
          return [x, BAR_BASE, z] as [number, number, number];
        })}
        color={color}
        opacity={0.4}
        lineWidth={1.5}
      />

      {values.map((v, i) => {
        const [x, , z] = barPosition(i, values.length);
        const h = (v / max) * BAR_MAX_H;
        return (
          <group key={i}>
            <TechLabel
              position={[x, BAR_BASE + h + 0.16, z]}
              color={i === peak ? accent : "#e5f6ff"}
              size={0.075}
              opacity={i === peak ? 1 : 0.8}
            >
              {String(v)}
            </TechLabel>
            <TechLabel position={[x, BAR_BASE - 0.18, z]} color={color} size={0.05} opacity={0.5}>
              {String(i + 1).padStart(2, "0")}
            </TechLabel>
          </group>
        );
      })}
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
    // Was parked at y=-1.95, below a full-size core — which put it on top of
    // the bottom edge telemetry and left the middle of the frame empty. The
    // core withdraws now, so the sequence takes the centre.
    <group ref={ref} position={[0, -0.35, 1.1]}>
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
            <TechLabel position={[0, -0.24, 0]} color={i === data.length - 1 ? accent : color} size={0.075} opacity={0.85} decode>
              {e.label}
            </TechLabel>
          </group>
        );
      })}
    </group>
  );
}
