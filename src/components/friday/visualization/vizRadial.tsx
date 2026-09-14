"use client";

import { useRef, useState } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import { DoubleSide, type Group } from "three";
import { useFridayStore, type MetricDatum } from "@/lib/store";
import { ArcSegments, TechLabel, TickDial, useMaterialize } from "../primitives";
import WaveformRing from "../core/WaveformRing";

export interface VizProps {
  metrics?: MetricDatum[];
  color: string;
  accent: string;
}

/**
 * Gauges fan across the frame rather than orbiting on a squashed ellipse.
 *
 * The orbit put half the metrics behind the other half — with four metrics
 * they paired up and overlapped — and the 1.15-unit depth spread meant
 * perspective drew equal-weight gauges at visibly different sizes, which
 * reads as a ranking that is not in the data.
 */
const FAN_RADIUS = 3.4;
const FAN_SPAN = 2.2;
/** Past this many gauges a single row collides; alternate rows instead. */
const STAGGER_FROM = 6;

/**
 * Node scale from metric count: full size up to a rowful, then shrinking so
 * N gauges always fit instead of colliding — count-driven, never fixed slots.
 */
export function gaugeNodeScale(count: number): number {
  return count > STAGGER_FROM ? Math.max(0.45, STAGGER_FROM / count) : 1;
}

export interface GaugeVisual {
  /** scale multiplier applied on top of the count-driven node size. */
  emphasis: number;
  /** sibling fades when another gauge holds focus. */
  dimmed: boolean;
  /** hover or selection: brighten + enlarge. */
  highlighted: boolean;
}

/**
 * Pure style decision for one gauge node, kept out of the frame loop so it is
 * testable. Mirrors the globe-marker language: hover *or* selection enlarges +
 * highlights; only a *selection* dims the unselected siblings (a bare hover must
 * not fade the rest of the row).
 */
export function gaugeVisual({
  hovered = false,
  selected = false,
  anySelected = false,
}: {
  hovered?: boolean;
  selected?: boolean;
  anySelected?: boolean;
} = {}): GaugeVisual {
  const highlighted = selected || hovered;
  return { emphasis: highlighted ? 1.15 : 1, dimmed: anySelected && !selected, highlighted };
}

function fanPosition(index: number, count: number): [number, number, number] {  const t = count < 2 ? 0.5 : index / (count - 1);
  const a = (t - 0.5) * FAN_SPAN;
  const stagger = count >= STAGGER_FROM && index % 2 === 1 ? -0.62 : 0;
  return [
    Math.sin(a) * FAN_RADIUS,
    // shallow dome — outer gauges ride a little lower, so the row curves
    // around the core instead of cutting a flat line through it
    (Math.cos(a) - 1) * 0.9 + 0.35 + stagger,
    (Math.cos(a) - 1) * 0.5,
  ];
}

/** One metric as a segmented gauge node fanned across the frame. */
function MetricNode({
  index,
  count,
  metric,
  color,
  selected,
  anySelected,
}: {
  index: number;
  count: number;
  metric: MetricDatum;
  color: string;
  selected: boolean;
  anySelected: boolean;
}) {
  const [x, y, z] = fanPosition(index, count);
  // Dynamic density: past a rowful the nodes shrink instead of colliding —
  // the count comes from the data, never from a fixed slot plan.
  const s = gaugeNodeScale(count);
  const [hovered, setHovered] = useState(false);
  const vis = gaugeVisual({ hovered, selected, anySelected });

  const groupRef = useMaterialize(0.7, true, index * 0.18);
  const bobRef = useRef<Group>(null);
  const emphasis = useRef(1);
  const pct = Math.max(0, Math.min(1, metric.value / 100));

  useFrame((_, delta) => {
    const bob = bobRef.current;
    if (!bob) return;
    bob.position.y = Math.sin(performance.now() * 0.001 + index) * 0.05;
    emphasis.current += (vis.emphasis - emphasis.current) * Math.min(1, delta * 8);
    bob.scale.setScalar(emphasis.current);
  });

  const tint = vis.highlighted ? "#eafcff" : color;
  const opacity = vis.dimmed ? 0.28 : 1;

  return (
    <group>
      <group position={[x, y, z]} scale={s}>
        <group ref={groupRef}>
          <group ref={bobRef}>
            <Billboard>
              {/* drill-down hit area — invisible but raycastable; drives hover
                  (local) and focus (shared DrillDown → store). */}
              <mesh
                visible={false}
                userData={{
                  viz: {
                    label: metric.label.toUpperCase(),
                    detail: `${Math.round(metric.value)}${metric.unit ?? ""}`,
                    noHoverLabel: true,
                  },
                }}
                onPointerOver={() => {
                  setHovered(true);
                  document.body.style.cursor = "pointer";
                }}
                onPointerOut={() => {
                  setHovered(false);
                  document.body.style.cursor = "auto";
                }}
              >
                <circleGeometry args={[0.58, 20]} />
              </mesh>
              {/* track */}
              <mesh>
                <ringGeometry args={[0.34, 0.36, 64]} />
                <meshBasicMaterial color={color} transparent opacity={vis.dimmed ? 0.05 : 0.14} side={DoubleSide} depthWrite={false} />
              </mesh>
              {/* segmented fill */}
              <ArcSegments
                radius={0.35}
                count={40}
                thickness={0.026}
                gap={0.35}
                color={tint}
                opacity={vis.dimmed ? 0.3 : 0.9}
                fraction={pct}
                start={Math.PI / 2}
                span={-Math.PI * 2}
              />
              <TickDial radius={0.46} count={36} color={color} opacity={vis.dimmed ? 0.1 : 0.25} length={0.032} />
              <TechLabel position={[0, 0, 0]} size={vis.highlighted ? 0.18 : 0.15} color={tint}>
                {`${Math.round(metric.value)}${metric.unit ?? ""}`}
              </TechLabel>
              <TechLabel position={[0, -0.62, 0]} size={0.082} color={color} opacity={opacity}>
                {metric.label}
              </TechLabel>
            </Billboard>
          </group>
        </group>
      </group>
    </group>
  );
}

/** §6 percentage / multiple metrics → orbiting radial gauges. */
export function RadialGauge({ metrics = [], color }: VizProps) {
  // Focus is set by the shared DrillDown on click; match it back to these
  // metrics by label so the selected node highlights and its siblings dim.
  const focus = useFridayStore((s) => s.focus);
  const focusedLabel = focus?.label ?? null;
  const anySelected =
    !!focusedLabel && metrics.some((m) => m.label.toUpperCase() === focusedLabel);
  return (
    <group>
      {metrics.map((m, i) => (
        <MetricNode
          key={m.label}
          index={i}
          count={metrics.length}
          metric={m}
          color={color}
          selected={focusedLabel === m.label.toUpperCase()}
          anySelected={anySelected}
        />
      ))}
    </group>
  );
}

/** §6 search / scan → radar sweep with concentric rings and blips. */
export function Radar({ metrics = [], color, accent }: VizProps) {
  const sweep = useRef<Group>(null);
  const ref = useMaterialize(0.6);

  useFrame((_, delta) => {
    if (sweep.current) sweep.current.rotation.z -= delta * 1.5;
  });

  const blips = metrics.length
    ? metrics.map((m, i) => ({ a: (i / metrics.length) * Math.PI * 2, r: 0.6 + (m.value / 100) * 1.7 }))
    : [0.4, 1.9, 3.3, 5.1].map((a, i) => ({ a, r: 0.8 + i * 0.4 }));

  return (
    // Billboard, not tilted: a tilted disc is an ellipse from most angles
    // and a line edge-on — face-locked it is a true circle everywhere.
    <group ref={ref}>
      <Billboard>
      {[0.9, 1.5, 2.1, 2.6].map((r) => (
        <mesh key={r}>
          <ringGeometry args={[r, r + 0.004, 96]} />
          <meshBasicMaterial color={color} transparent opacity={0.18} side={DoubleSide} depthWrite={false} />
        </mesh>
      ))}
      <TickDial radius={2.72} count={72} color={color} opacity={0.2} length={0.06} />
      <group ref={sweep}>
        <mesh>
          <ringGeometry args={[0.05, 2.6, 64, 1, 0, Math.PI / 7]} />
          <meshBasicMaterial color={color} transparent opacity={0.16} side={DoubleSide} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
      {blips.map(({ a, r }, i) => (
        <group key={i} position={[Math.cos(a) * r, Math.sin(a) * r, 0.01]}>
          <mesh>
            <circleGeometry args={[0.035, 12]} />
            <meshBasicMaterial color={accent} transparent opacity={0.85} toneMapped={false} />
          </mesh>
          <mesh
            visible={false}
            userData={{
              viz: {
                label: `CONTACT ${String(i + 1).padStart(2, "0")}`,
                detail: `BRG ${Math.round(((a * 180) / Math.PI + 360) % 360)}°`,
              },
            }}
          >
            <circleGeometry args={[0.16, 12]} />
          </mesh>
        </group>
      ))}
      </Billboard>
    </group>
  );
}

/** §6 audio → reactive waveform, face-locked so it reads as a circle. */
export function Waveform({ color, accent }: VizProps) {
  const ref = useMaterialize(0.5);
  return (
    <group ref={ref}>
      <Billboard>
      <WaveformRing radius={2.5} bars={128} color={color} activity={1} />
      <mesh>
        <ringGeometry args={[2.46, 2.47, 128]} />
        <meshBasicMaterial color={accent} transparent opacity={0.25} side={DoubleSide} depthWrite={false} />
      </mesh>
      </Billboard>
    </group>
  );
}
