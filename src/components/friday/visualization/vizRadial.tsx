"use client";

import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Billboard, Text } from "@react-three/drei";
import { DoubleSide, type Group } from "three";
import type { MetricDatum } from "@/lib/store";
import { ArcSegments, Connector, TechLabel, TickDial, useMaterialize } from "../primitives";
import WaveformRing from "../core/WaveformRing";

export interface VizProps {
  metrics?: MetricDatum[];
  color: string;
  accent: string;
}

const ORBIT_RADIUS = 2.95;

/** One metric as a segmented gauge node orbiting the core, wired back to it. */
function MetricNode({
  index,
  count,
  metric,
  color,
}: {
  index: number;
  count: number;
  metric: MetricDatum;
  color: string;
}) {
  // Offset by half a step: on 90° boundaries two nodes land dead centre —
  // one buried behind the core, one pasted over it. Half-stepping keeps every
  // node clear of the core silhouette and pulls the outermost ones inward,
  // away from the edge HUD.
  const angle = ((index + 0.5) / count) * Math.PI * 2 - Math.PI / 2;
  const x = Math.cos(angle) * ORBIT_RADIUS;
  const z = Math.sin(angle) * ORBIT_RADIUS * 0.55;
  const y = Math.sin(index * 1.7) * 0.35;

  const groupRef = useMaterialize(0.7, true, index * 0.18);
  const bobRef = useRef<Group>(null);
  const pct = Math.max(0, Math.min(1, metric.value / 100));

  useFrame(() => {
    if (!bobRef.current) return;
    bobRef.current.position.y = Math.sin(performance.now() * 0.001 + index) * 0.05;
  });

  return (
    <group>
      <Connector to={[x, y, z]} color={color} opacity={0.18} />
      <group position={[x, y, z]}>
        <group ref={groupRef}>
          <group ref={bobRef}>
            <Billboard>
              {/* drill-down hit area — invisible but raycastable */}
              <mesh
                visible={false}
                userData={{
                  viz: {
                    label: metric.label.toUpperCase(),
                    detail: `${Math.round(metric.value)}${metric.unit ?? ""}`,
                  },
                }}
              >
                <circleGeometry args={[0.58, 20]} />
              </mesh>
              {/* track */}
              <mesh>
                <ringGeometry args={[0.34, 0.36, 64]} />
                <meshBasicMaterial color={color} transparent opacity={0.14} side={DoubleSide} depthWrite={false} />
              </mesh>
              {/* segmented fill */}
              <ArcSegments
                radius={0.35}
                count={40}
                thickness={0.026}
                gap={0.35}
                color={color}
                opacity={0.9}
                fraction={pct}
                start={Math.PI / 2}
                span={-Math.PI * 2}
              />
              <TickDial radius={0.46} count={36} color={color} opacity={0.25} length={0.032} />
              <Text fontSize={0.15} color="#e5f6ff" anchorX="center" anchorY="middle">
                {`${Math.round(metric.value)}${metric.unit ?? ""}`}
              </Text>
              <Text
                fontSize={0.06}
                color={color}
                anchorX="center"
                anchorY="middle"
                position={[0, -0.58, 0]}
                letterSpacing={0.18}
              >
                {metric.label.toUpperCase()}
              </Text>
            </Billboard>
          </group>
        </group>
      </group>
    </group>
  );
}

/** §6 percentage / multiple metrics → orbiting radial gauges. */
export function RadialGauge({ metrics = [], color }: VizProps) {
  return (
    <group>
      {metrics.map((m, i) => (
        <MetricNode key={m.label} index={i} count={metrics.length} metric={m} color={color} />
      ))}
    </group>
  );
}

/** §6 status → one dominant health ring wrapped around the core. */
export function HealthCore({ metrics = [], color, accent }: VizProps) {
  const ref = useMaterialize(0.9);
  const health = metrics.find((m) => /health|score|overall/i.test(m.label)) ?? metrics[0];
  const pct = health ? Math.max(0, Math.min(1, health.value / 100)) : 0;
  const spin = useRef<Group>(null);

  useFrame((_, delta) => {
    if (spin.current) spin.current.rotation.z -= delta * 0.08;
  });

  return (
    <group ref={ref}>
      <group ref={spin} rotation={[0, 0, 0]}>
        <ArcSegments radius={2.45} count={90} thickness={0.05} gap={0.3} color={color} opacity={0.75} fraction={pct} start={Math.PI / 2} span={-Math.PI * 2} />
        <ArcSegments radius={2.6} count={90} thickness={0.018} gap={0.3} color={accent} opacity={0.25} />
      </group>
      {health && (
        <>
          <TechLabel position={[0, 2.85, 0]} color={color} size={0.1} decode>
            {`${health.label} ${Math.round(health.value)}${health.unit ?? ""}`}
          </TechLabel>
          <TechLabel position={[0, 2.68, 0]} color="#e5f6ff" size={0.05} opacity={0.45} decode>
            INTEGRITY NOMINAL
          </TechLabel>
        </>
      )}
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
    <group ref={ref} rotation={[Math.PI / 2.15, 0, 0]}>
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
    </group>
  );
}

/** §6 audio → reactive waveform, large and front-facing. */
export function Waveform({ color, accent }: VizProps) {
  const ref = useMaterialize(0.5);
  return (
    <group ref={ref} rotation={[Math.PI / 2.15, 0, 0]}>
      <WaveformRing radius={2.5} bars={128} color={color} activity={1} />
      <mesh>
        <ringGeometry args={[2.46, 2.47, 128]} />
        <meshBasicMaterial color={accent} transparent opacity={0.25} side={DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}
