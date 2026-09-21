"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Color, DoubleSide, Object3D, type Group, type InstancedMesh } from "three";
import { useFridayStore, type SeriesDatum, type TimelineEvent } from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { makeFocus, toggleFocus } from "@/lib/visualization/focus";
import { useFocusRelease } from "./useFocusRelease";
import { useClickGate, useHoverCursor, usePick } from "./usePick";
import { HairLine, TechLabel, useMaterialize } from "../primitives";

export interface ChartProps {
  series?: SeriesDatum[];
  events?: TimelineEvent[];
  color: string;
  accent: string;
  /** Preview specs (interaction:"none") render without picking. */
  interactive?: boolean;
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
function LinePoint({
  p,
  color,
  value,
  selected,
  dimmed,
  interactive,
  pinned,
  pinnedColor,
  pinnedY,
  onSelect,
}: {
  p: [number, number, number];
  color: string;
  value: number;
  selected: boolean;
  dimmed: boolean;
  interactive: boolean;
  /** Ends and the peak always show their value; others only on hover/select. */
  pinned: boolean;
  pinnedColor: string;
  pinnedY: number;
  onSelect: () => void;
}) {
  const { hovered, bind } = usePick(onSelect);
  const highlighted = selected || hovered;
  return (
    <group position={p}>
      {interactive && (
        <mesh
          visible={false}
          {...bind}
        >
          <sphereGeometry args={[0.09, 8, 8]} />
        </mesh>
      )}
      <mesh scale={highlighted ? 1.8 : 1}>
        <sphereGeometry args={[0.028, 8, 8]} />
        <meshBasicMaterial
          color={highlighted ? "#eafcff" : color}
          transparent
          opacity={dimmed ? 0.3 : 1}
          toneMapped={false}
        />
      </mesh>
      {/* One label per point: the highlight replaces the pinned one rather
          than stacking a second copy of the same number on top of it. */}
      {highlighted ? (
        <TechLabel position={[0, 0.14, 0]} color="#eafcff" size={0.07} opacity={1}>
          {String(value)}
        </TechLabel>
      ) : (
        pinned && (
          <TechLabel position={[0, pinnedY, 0]} color={pinnedColor} size={0.07} opacity={0.9}>
            {String(value)}
          </TechLabel>
        )
      )}
    </group>
  );
}

export function LineChart3D({ series = DEFAULT_SERIES, color, accent, interactive = true }: ChartProps) {
  const ref = useMaterialize(0.8);
  const data = series.length ? series : DEFAULT_SERIES;
  // One shared scale across series — per-series maxima made two lines of very
  // different magnitude look identical.
  const max = Math.max(...data.flatMap((s) => s.points), 1);

  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);
  const releaseOnMiss = useFocusRelease("line");
  const selectedKey = focus && focus.owner === "line" ? focus.key : null;

  const handleSelect = (si: number, i: number, s: SeriesDatum) => {
    const key = `${si}-${i}`;
    setFocus(
      toggleFocus(
        useFridayStore.getState().focus,
        makeFocus(
          "line",
          key,
          `${s.label.toUpperCase()} T${String(i).padStart(2, "0")}`,
          String(s.points[i] ?? 0),
        ),
      ),
    );
  };

  return (
    // Lifted and pushed forward off the core plane, and barely yawed: the old
    // -0.35 turn foreshortened the left half into the middle of the frame.
    <group
      ref={ref}
      position={CHART_ANCHOR}
      rotation={[0, -0.16, 0]}
      onPointerMissed={interactive ? releaseOnMiss : undefined}
    >
      <ChartFloor color={color} max={max} />
      {data.map((s, si) => {
        const pts: [number, number, number][] = s.points.map((p, i) => [
          -W / 2 + (i / Math.max(1, s.points.length - 1)) * W,
          -H / 2 + (p / max) * H,
          si * -0.4,
        ]);
        const peak = s.points.indexOf(Math.max(...s.points));
        const last = pts.length - 1;
        return (
          <group key={s.label}>
            <HairLine points={pts} color={si === 0 ? color : accent} opacity={0.9} lineWidth={2} />
            {pts.map((p, i) => (
              <LinePoint
                key={i}
                p={p}
                color={si === 0 ? color : accent}
                value={s.points[i] ?? 0}
                selected={selectedKey === `${si}-${i}`}
                dimmed={selectedKey !== null && selectedKey !== `${si}-${i}`}
                interactive={interactive}
                pinned={i === 0 || i === last || i === peak}
                pinnedColor={i === peak ? (si === 0 ? color : accent) : "#e5f6ff"}
                pinnedY={si % 2 === 0 ? 0.14 : -0.14}
                onSelect={() => handleSelect(si, i, s)}
              />
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
/** How far a selected bar rises above its resting height. */
const BAR_LIFT = 0.06;
/**
 * Module-scope scratch colors for the per-instance pass. Mutated only through
 * `.set`/`.copy`/`.multiplyScalar` (methods) so the React Compiler never sees a
 * post-render assignment to a hook value; reused across frames to avoid GC.
 */
const tmpColor = new Color();
const tmpBase = new Color();

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

export function BarChart3D({ series = DEFAULT_SERIES, color, accent, interactive = true }: ChartProps) {
  const ref = useMaterialize(0.8);
  const meshes = useRef<(InstancedMesh | null)[]>([]);
  const dummy = useMemo(() => new Object3D(), []);
  // Grouped: one instanced mesh per series. Each bar is a per-instance focus
  // target (instanceId), colored/lifted from the spine in the frame loop below.
  const data = series.length ? series.slice(0, BAR_GROUP_MAX) : DEFAULT_SERIES;
  const count = Math.max(...data.map((s) => s.points.length));
  const grown = useRef(0);
  // One shared scale across series — per-series maxima made two bars of very
  // different magnitude look identical (same trap line_3d documents).
  const max = Math.max(...data.flatMap((s) => s.points), 1);
  const peaks = data.map((s) => s.points.indexOf(Math.max(...s.points)));
  const width = barGroupWidth(data.length);

  // --- native focus (owner "bar", key "<series>-<category>") ---
  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);
  const releaseOnMiss = useFocusRelease("bar");
  const [hovered, setHovered] = useState<{ si: number; i: number } | null>(null);
  const gate = useClickGate();
  useHoverCursor(hovered !== null);
  const selected = useMemo(() => {
    if (!focus || focus.owner !== "bar") return null;
    const [si, i] = focus.key.split("-").map(Number);
    return Number.isFinite(si) && Number.isFinite(i) ? { si: si!, i: i! } : null;
  }, [focus]);
  // One color/lift pass must run after the grow ends or whenever the focus
  // changes — the frame loop otherwise idles and the matrices stay stale.
  const dirty = useRef(true);
  useEffect(() => {
    dirty.current = true;
  }, [selected, hovered, color, accent]);

  useLayoutEffect(() => {
    grown.current = 0;
    dirty.current = true;
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
    // Runs while growing, and one extra pass whenever `dirty` (a focus/hover
    // change, or the moment growth finishes) so colors + the selected lift are
    // written without re-uploading matrices every idle frame.
    const animating = grown.current < 1;
    if (!animating && !dirty.current) return;
    if (animating) grown.current = Math.min(1, grown.current + delta * 1.6);
    data.forEach((s, si) => {
      const mesh = meshes.current[si];
      if (!mesh) return;
      tmpBase.set(si === 0 ? color : accent);
      for (let i = 0; i < count; i++) {
        const v = s.points[i] ?? 0;
        const a = barAngle(i, count);
        const [x, , z] = barGroupPosition(i, count, si, data.length);
        const h = (v / max) * BAR_MAX_H * grown.current + 0.02;
        const isSel = selected?.si === si && selected?.i === i;
        const isHov = hovered?.si === si && hovered?.i === i;
        dummy.position.set(x, BAR_BASE + h / 2 + (isSel ? BAR_LIFT : 0), z);
        dummy.rotation.set(0, -a, 0);
        dummy.scale.set(width, h, 0.16);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        // The mesh material is white; instance color carries the whole hue so
        // dim/highlight never exceed 1 or fight the shared opacity.
        if (isSel || isHov) tmpColor.set(0.92, 0.99, 1);
        else if (selected) tmpColor.copy(tmpBase).multiplyScalar(0.3);
        else tmpColor.copy(tmpBase);
        mesh.setColorAt(i, tmpColor);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    if (!animating) dirty.current = false;
  });

  // Legend anchor: under the first category, clear of bars (which rise from
  // the baseline) and of the index labels. Only for real groups — a lone
  // series needs no legend and must render exactly as before.
  const [legendX, , legendZ] = barPosition(0, count);

  return (
    <group
      ref={ref}
      onPointerMissed={interactive ? releaseOnMiss : undefined}
    >
      {data.map((s, si) => (
        <instancedMesh
          key={s.label}
          ref={(m) => {
            meshes.current[si] = m;
          }}
          args={[undefined, undefined, count]}
          onPointerDown={(e: ThreeEvent<PointerEvent>) => {
            if (!interactive) return;
            e.stopPropagation();
            gate.record(e);
          }}
          onPointerMove={(e: ThreeEvent<PointerEvent>) => {
            if (!interactive) return;
            e.stopPropagation();
            if (e.instanceId === undefined) return;
            // Bail on same-instance moves: a fresh object per mousemove would
            // re-render the whole chart (and its labels) for no visual change.
            setHovered((h) => (h?.si === si && h?.i === e.instanceId ? h : { si, i: e.instanceId! }));
          }}
          onPointerOut={() => {
            if (!interactive) return;
            setHovered(null);
          }}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            if (!interactive) return;
            e.stopPropagation();
            if (!gate.accept(e)) return;
            const i = e.instanceId;
            if (i === undefined) return;
            setFocus(
              toggleFocus(
                useFridayStore.getState().focus,
                makeFocus(
                  "bar",
                  `${si}-${i}`,
                  `${s.label.toUpperCase()} · ${i + 1}`,
                  String(s.points[i] ?? 0),
                ),
              ),
            );
          }}
        >
          <boxGeometry args={[1, 1, 1]} />
          {/* white base — the per-instance color set in the frame loop carries
              the hue (base / dimmed / highlighted), so the shared 0.72 opacity
              never fights it and a lone series renders exactly as before. */}
          <meshBasicMaterial
            color="#ffffff"
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
          const isSel = selected?.si === si && selected?.i === i;
          const isHov = hovered?.si === si && hovered?.i === i;
          const lift = (isSel ? BAR_LIFT : 0) + 0.16;
          return (
            <group key={`${s.label}-${i}`}>
              <TechLabel
                position={[x, BAR_BASE + h + lift, z]}
                color={isSel || isHov ? "#eafcff" : i === peaks[si] ? (si === 0 ? accent : color) : "#e5f6ff"}
                size={isSel ? 0.09 : 0.075}
                opacity={isSel || isHov || i === peaks[si] ? 1 : 0.8}
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

const DEFAULT_EVENTS: TimelineEvent[] = [
  { label: "BOOT", at: 0 },
  { label: "SYNC", at: 0.28 },
  { label: "SCAN", at: 0.55 },
  { label: "ALERT", at: 0.78 },
  { label: "NOW", at: 1 },
];

/**
 * Mission-control time scrubber: one straight rail, filled bright from the
 * past up to NOW, events as diamonds ON the rail, HUD-elbow labels alternating
 * below/above it, and a glowing playhead riding the now-mark. The whole board
 * rides on a plane tilted a few degrees into the camera — depth without the
 * "bent stick" look a curved axis produced.
 */
export const TL_RAIL_SPAN = 4.6;

/** X position on the rail for `at` ∈ [0,1]; clamped and NaN-safe. */
export function railXFor(at: number): number {
  const u = Number.isFinite(at) ? Math.min(1, Math.max(0, at)) : 0.5;
  return (u - 0.5) * TL_RAIL_SPAN;
}

interface TimelineEventNodeProps {
  event: TimelineEvent;
  x: number;
  /** +1 = label above the rail, -1 = below (alternating keeps labels apart). */
  side: 1 | -1;
  color: string;
  selected: boolean;
  dimmed: boolean;
  interactive: boolean;
  onSelect: () => void;
}

/** One event: a diamond riding the rail + an HUD elbow leading to its label. */
function TimelineEventNode({
  event,
  x,
  side,
  color,
  selected,
  dimmed,
  interactive,
  onSelect,
}: TimelineEventNodeProps) {
  const { hovered, bind } = usePick(onSelect);
  const highlighted = selected || hovered;
  const base = highlighted ? "#eafcff" : color;
  // Elbows run horizontal toward the nearest end of the rail, so labels never
  // reach back over their neighbours.
  const outward = x >= 0 ? 1 : -1;
  const elbow: [number, number, number][] = [
    [x, 0, 0],
    [x, side * 0.13, 0],
    [x + outward * 0.14, side * 0.13, 0],
  ];

  return (
    <group position={[x, 0, 0]}>
      {interactive && (
        <mesh
          visible={false}
          position={[outward * 0.18, side * 0.16, 0.02]}
          {...bind}
        >
          <planeGeometry args={[0.62, 0.46]} />
        </mesh>
      )}

      <mesh rotation={[0, 0, Math.PI / 4]} scale={highlighted ? 1.5 : 1}>
        <boxGeometry args={[0.065, 0.065, 0.02]} />
        <meshBasicMaterial color={base} transparent opacity={dimmed ? 0.25 : 1} toneMapped={false} />
      </mesh>
      {highlighted && (
        <mesh rotation={[0, 0, Math.PI / 4]}>
          <boxGeometry args={[0.115, 0.115, 0.008]} />
          <meshBasicMaterial color={base} transparent opacity={0.35} toneMapped={false} depthWrite={false} />
        </mesh>
      )}

      <HairLine points={elbow} color={base} opacity={dimmed ? 0.15 : 0.55} lineWidth={1} />
      <TechLabel
        position={[outward * 0.18, side * 0.13, 0]}
        color={base}
        size={0.075}
        opacity={dimmed ? 0.3 : 0.95}
        anchorX={outward > 0 ? "left" : "right"}
        decode
      >
        {event.label}
      </TechLabel>
      {selected && (
        <TechLabel
          position={[outward * 0.18, side * 0.27, 0]}
          color="#eafcff"
          size={0.055}
          opacity={0.9}
          anchorX={outward > 0 ? "left" : "right"}
        >
          {`T+${Math.round(event.at * 100)}%`}
        </TechLabel>
      )}
    </group>
  );
}

/** The scan bar riding the now-mark: vertical blade + expanding rings + tag. */
function Playhead({ x, accent, reduced }: { x: number; accent: string; reduced: boolean }) {
  const rings = useRef<Group>(null);
  useFrame(({ clock }) => {
    if (reduced || !rings.current) return;
    const t = clock.elapsedTime * 0.7;
    rings.current.children.forEach((child, i) => {
      const ph = (t + i * 0.5) % 1;
      child.scale.setScalar(0.1 + ph * 0.34);
      const m = (child as Object3D & { material?: { opacity: number } }).material;
      if (m) m.opacity = 0.6 * (1 - ph);
    });
  });
  return (
    <group position={[x, 0, 0.01]}>
      <mesh>
        <boxGeometry args={[0.016, 0.46, 0.01]} />
        <meshBasicMaterial color={accent} transparent opacity={0.9} toneMapped={false} depthWrite={false} />
      </mesh>
      <mesh rotation={[0, 0, Math.PI / 4]}>
        <boxGeometry args={[0.05, 0.05, 0.014]} />
        <meshBasicMaterial color="#ffffff" transparent opacity={0.95} toneMapped={false} />
      </mesh>
      {/* Unit-radius rings; the frame loop scales them 0.1→0.44 world units. */}
      <group ref={rings}>
        {[0, 1].map((i) => (
          <mesh key={i} scale={reduced && i === 1 ? 0 : 0.1 + (i === 0 ? 0.16 : 0.02)}>
            <ringGeometry args={[1, 1.06, 48]} />
            <meshBasicMaterial
              color={accent}
              transparent
              opacity={reduced ? (i === 0 ? 0.35 : 0) : 0}
              side={DoubleSide}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
      <TechLabel position={[0, 0.36, 0]} color={accent} size={0.07} opacity={0.95} decode>
        NOW
      </TechLabel>
    </group>
  );
}

/**
 * Sparks drifting along the FILLED segment of the rail, toward the playhead —
 * time flowing into the present. Reduced motion → never mounted.
 */
function TimeFlow({ accent, nowT, speed }: { accent: string; nowT: number; speed: number }) {
  const refs = useRef<Array<Group | null>>([]);
  const offsets = useMemo(() => [0, 0.25, 0.5, 0.75], []);
  useFrame(({ clock }) => {
    for (let k = 0; k < offsets.length; k++) {
      const g = refs.current[k];
      if (!g) continue;
      const u = (clock.elapsedTime * speed * 0.05 + offsets[k]!) % 1;
      g.position.set(railXFor(u * nowT), 0, 0.015);
    }
  });
  return (
    <group>
      {offsets.map((o, k) => (
        <group
          key={o}
          ref={(g) => {
            refs.current[k] = g;
          }}
        >
          <mesh>
            <sphereGeometry args={[0.02, 6, 6]} />
            <meshBasicMaterial color={accent} transparent opacity={0.85} toneMapped={false} depthWrite={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function Timeline3D({ events = DEFAULT_EVENTS, color, accent, interactive = true }: ChartProps) {
  const ref = useMaterialize(0.7);
  const data = events.length ? events : DEFAULT_EVENTS;

  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);
  const state = useFridayStore((s) => s.state);
  const releaseOnMiss = useFocusRelease("timeline");
  const selectedId = focus && focus.owner === "timeline" ? focus.key : null;

  const reduced = useReducedMotion();

  const look = STATE_LOOK[state];
  // NOW = the furthest event in time (data may arrive unsorted).
  const nowT = Math.min(1, Math.max(0, ...data.map((e) => (Number.isFinite(e.at) ? e.at : 0))));
  const xNow = railXFor(nowT);
  const half = TL_RAIL_SPAN / 2;

  const handleSelect = (i: number, e: TimelineEvent) => {
    setFocus(
      toggleFocus(
        useFridayStore.getState().focus,
        makeFocus("timeline", `${i}`, e.label.toUpperCase(), `T+${Math.round(e.at * 100)}%`),
      ),
    );
  };

  return (
    // A board tilted a few degrees into the camera (same vocabulary as the
    // line chart's plane): straight rail, readable from any rig angle, and
    // the rotation gives the depth the curved version faked.
    <group
      ref={ref}
      position={[0, -0.1, 1.2]}
      rotation={[0.05, -0.12, 0]}
      onPointerMissed={interactive ? releaseOnMiss : undefined}
    >
      {/* base rail across the whole span, then the brighter "elapsed" fill up
          to NOW — the scrubber reads as time spent, not a decorative line */}
      <HairLine points={[[-half, 0, 0], [half, 0, 0]]} color={color} opacity={0.22} lineWidth={2} />
      <HairLine points={[[-half, 0, 0], [xNow, 0, 0]]} color={accent} opacity={0.85} lineWidth={3} />
      {/* faint dashes on the future stretch, past the playhead — none when NOW
          sits at the rail's end (they would all clamp to zero length there) */}
      {Array.from({ length: nowT < 0.98 ? 8 : 0 }, (_, i) => {
        const a = railXFor(nowT + ((i + 1) / 9) * (1 - nowT));
        const b = railXFor(nowT + ((i + 1) / 9) * (1 - nowT) + 0.02);
        return <HairLine key={i} points={[[a, 0, 0], [b, 0, 0]]} color={color} opacity={0.3} lineWidth={2} />;
      })}

      {!reduced && nowT > 0.02 && (
        <TimeFlow accent={accent} nowT={nowT} speed={look.particleIntensity ?? 1} />
      )}

      <Playhead x={xNow} accent={accent} reduced={reduced} />

      {data.map((e, i) => (
        <TimelineEventNode
          key={`${e.label}-${i}`}
          event={e}
          x={railXFor(e.at)}
          // Alternating sides, phase-shifted from the right end so the last
          // event never stacks its label onto the NOW tag.
          side={(data.length - 1 - i) % 2 === 0 ? -1 : 1}
          color={color}
          selected={selectedId === `${i}`}
          dimmed={selectedId !== null && selectedId !== `${i}`}
          interactive={interactive}
          onSelect={() => handleSelect(i, e)}
        />
      ))}
    </group>
  );
}
