"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, DoubleSide, Object3D, type InstancedMesh } from "three";
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
/** Full bar width for a lone series; grouped bars split it evenly. */
export const BAR_WIDTH = 0.16;
/** Max series drawn per category — more would shrink bars past legibility. */
export const BAR_GROUP_MAX = 4;
/** Lateral pitch between grouped bars, in world units along the arc tangent. */
const BAR_GROUP_PITCH = 0.22;

function barAngle(i: number, count: number) {
  return -BAR_SPAN / 2 + (i / Math.max(1, count - 1)) * BAR_SPAN;
}
function barPosition(i: number, count: number): [number, number, number] {
  const a = barAngle(i, count);
  return [Math.sin(a) * BAR_RADIUS, 0, CHART_ANCHOR[2] - (1 - Math.cos(a)) * BAR_DEPTH];
}

/** Bar width for a group of `seriesCount` — single series keeps full width. */
export function barGroupWidth(seriesCount: number): number {
  return BAR_WIDTH / Math.max(1, seriesCount);
}

/**
 * Position of one bar inside a grouped category: the category center pushed
 * along the arc tangent so siblings sit side by side. Single series returns
 * the center untouched (pixel-identical to the ungrouped layout).
 */
export function barGroupPosition(
  i: number,
  count: number,
  seriesIndex: number,
  seriesCount: number,
): [number, number, number] {
  const a = barAngle(i, count);
  const [x, , z] = barPosition(i, count);
  if (seriesCount < 2) return [x, 0, z];
  // tangent of the arc at a: d/da (sin a · R, Z0 − (1 − cos a) · D)
  const tx = Math.cos(a) * BAR_RADIUS;
  const tz = -Math.sin(a) * BAR_DEPTH;
  const len = Math.hypot(tx, tz) || 1;
  const off = (seriesIndex - (seriesCount - 1) / 2) * BAR_GROUP_PITCH;
  return [x + (tx / len) * off, 0, z + (tz / len) * off];
}

export function BarChart3D({ series = DEFAULT_SERIES, color, accent }: ChartProps) {
  const ref = useMaterialize(0.8);
  const meshes = useRef<(InstancedMesh | null)[]>([]);
  const dummy = useMemo(() => new Object3D(), []);
  // Grouped: one instanced mesh per series (mirrors HeatmapRow), so drill-down
  // reuses vizBar unchanged — each mesh carries its own series label + values.
  const data = series.length ? series.slice(0, BAR_GROUP_MAX) : DEFAULT_SERIES;
  const count = Math.max(...data.map((s) => s.points.length));
  const grown = useRef(0);
  // One shared scale across series — per-series maxima made two bars of very
  // different magnitude look identical (same trap line_3d documents).
  const max = Math.max(...data.flatMap((s) => s.points), 1);
  const peaks = data.map((s) => s.points.indexOf(Math.max(...s.points)));
  const width = barGroupWidth(data.length);

  useLayoutEffect(() => {
    grown.current = 0;
  }, [series]);

  /**
   * Capped at BAR_GROUP_MAX: beyond four the bars shrink past legibility and
   * the group spills into the neighbouring category slot.
   *
   * What it must not be is silent: dropping a series with no trace is how a
   * backend change becomes a rendering mystery. Dev-only, in the same idiom
   * as the state machine's illegal-transition warning.
   */
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && series.length > BAR_GROUP_MAX) {
      const ignored = series.slice(BAR_GROUP_MAX).map((s) => s.label).join(", ");
      console.warn(`[friday] bar_3d renders ${BAR_GROUP_MAX} series; ignoring ${series.length - BAR_GROUP_MAX} (${ignored})`);
    }
  }, [series]);

  useFrame((_, delta) => {
    // Stops once the bars have finished growing. Without this the loop kept
    // rewriting matrices that no longer change and re-flagging
    // `instanceMatrix` every frame — a GPU upload per frame, forever, for
    // geometry standing still. `useLayoutEffect` above rewinds it when the
    // data changes, so the animation still replays.
    if (grown.current >= 1) return;
    grown.current = Math.min(1, grown.current + delta * 1.6);
    data.forEach((s, si) => {
      const mesh = meshes.current[si];
      if (!mesh) return;
      for (let i = 0; i < count; i++) {
        const v = s.points[i] ?? 0;
        const a = barAngle(i, count);
        const [x, , z] = barGroupPosition(i, count, si, data.length);
        const h = (v / max) * BAR_MAX_H * grown.current + 0.02;
        dummy.position.set(x, BAR_BASE + h / 2, z);
        dummy.rotation.set(0, -a, 0);
        dummy.scale.set(width, h, 0.16);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    });
  });

  // Legend anchor: under the first category, clear of bars (which rise from
  // the baseline) and of the index labels. Only for real groups — a lone
  // series needs no legend and must render exactly as before.
  const [legendX, , legendZ] = barPosition(0, count);

  return (
    <group ref={ref}>
      {data.map((s, si) => (
        <instancedMesh
          key={s.label}
          ref={(m) => {
            meshes.current[si] = m;
          }}
          args={[undefined, undefined, count]}
          userData={{ vizBar: { label: s.label.toUpperCase(), values: s.points } }}
        >
          <boxGeometry args={[1, 1, 1]} />
          {/* opacity 0.45 over a bright core turned the bars to fog */}
          <meshBasicMaterial
            color={si === 0 ? color : accent}
            transparent
            opacity={0.72}
            toneMapped={false}
            depthWrite={false}
          />
        </instancedMesh>
      ))}

      {/* common baseline — without it, bars at different depths have no shared
          reference and the eye cannot compare their heights */}
      <HairLine
        points={Array.from({ length: count }, (_, i) => {
          const [x, , z] = barPosition(i, count);
          return [x, BAR_BASE, z] as [number, number, number];
        })}
        color={color}
        opacity={0.4}
        lineWidth={1.5}
      />

      {data.map((s, si) =>
        Array.from({ length: count }, (_, i) => {
          const v = s.points[i] ?? 0;
          const [x, , z] = barGroupPosition(i, count, si, data.length);
          const h = (v / max) * BAR_MAX_H;
          return (
            <group key={`${s.label}-${i}`}>
              <TechLabel
                position={[x, BAR_BASE + h + 0.16, z]}
                color={i === peaks[si] ? (si === 0 ? accent : color) : "#e5f6ff"}
                size={0.075}
                opacity={i === peaks[si] ? 1 : 0.8}
              >
                {String(v)}
              </TechLabel>
              {si === 0 && (
                <TechLabel position={[x, BAR_BASE - 0.18, z]} color={color} size={0.05} opacity={0.5}>
                  {String(i + 1).padStart(2, "0")}
                </TechLabel>
              )}
            </group>
          );
        }),
      )}
      {data.length > 1 &&
        data.map((s, si) => (
          <TechLabel
            key={`legend-${s.label}`}
            position={[legendX, BAR_BASE - 0.42 - si * 0.16, legendZ]}
            color={si === 0 ? color : accent}
            size={0.06}
            opacity={0.8}
            anchorX="left"
          >
            {s.label}
          </TechLabel>
        ))}
    </group>
  );
}

/** §6 density → 3D heatmap grid. One instanced row each so drill-down reuses vizBar. */
export function Heatmap3D({ series = DEFAULT_SERIES, color, accent }: ChartProps) {
  const ref = useMaterialize(0.8);
  const data = series.length ? series : DEFAULT_SERIES;
  const cols = Math.max(...data.map((s) => s.points.length));
  const max = Math.max(...data.flatMap((s) => s.points), 1);
  const dummies = useMemo(() => new Object3D(), []);

  return (
    <group ref={ref} position={[0, 0.45, 1.1]}>
      {data.map((row, r) => (
        <HeatmapRow
          key={row.label}
          row={row}
          rowIndex={r}
          cols={cols}
          max={max}
          color={color}
          accent={accent}
          dummies={dummies}
        />
      ))}
      {data.map((row, r) => (
        <TechLabel
          key={`label-${row.label}`}
          position={[-2.6, 0.9 - r * 0.62, 0]}
          color={color}
          size={0.07}
          opacity={0.7}
          anchorX="left"
        >
          {row.label}
        </TechLabel>
      ))}
    </group>
  );
}

function HeatmapRow({
  row,
  rowIndex,
  cols,
  max,
  color,
  accent,
  dummies,
}: {
  row: SeriesDatum;
  rowIndex: number;
  cols: number;
  max: number;
  color: string;
  accent: string;
  dummies: Object3D;
}) {
  const mesh = useRef<InstancedMesh>(null);
  const y = 0.9 - rowIndex * 0.62;
  const tmpColor = useMemo(() => new Color(), []);

  useLayoutEffect(() => {
    if (!mesh.current) return;
    const cold = new Color(color);
    const hot = new Color(accent);
    for (let c = 0; c < cols; c++) {
      const v = row.points[c] ?? 0;
      const t = max > 0 ? v / max : 0;
      const s = 0.12 + t * 0.4;
      dummies.position.set(-2 + c * 0.58, y, 0);
      dummies.scale.set(s / 0.5, s / 0.5, 1);
      dummies.updateMatrix();
      mesh.current.setMatrixAt(c, dummies.matrix);
      // Value → color (not size only): cold → hot so hotspots read as heat.
      tmpColor.copy(cold).lerp(hot, t);
      mesh.current.setColorAt(c, tmpColor);
    }
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  }, [row, cols, max, y, dummies, color, accent, tmpColor]);

  const peak = row.points.indexOf(Math.max(...row.points));
  void rowIndex;
  return (
    <group>
      <instancedMesh
        ref={mesh}
        args={[undefined, undefined, cols]}
        userData={{ vizBar: { label: row.label.toUpperCase(), values: row.points } }}
      >
        <planeGeometry args={[0.5, 0.5]} />
        <meshBasicMaterial
          color="#ffffff"
          transparent
          opacity={0.85}
          toneMapped={false}
          depthWrite={false}
          side={DoubleSide}
        />
      </instancedMesh>
      {peak >= 0 && (
        <TechLabel position={[-2 + peak * 0.58, y + 0.34, 0]} color="#e5f6ff" size={0.06} opacity={0.85}>
          {String(row.points[peak])}
        </TechLabel>
      )}
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
