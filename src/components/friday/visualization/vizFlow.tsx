"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Color, DoubleSide, Vector3, type Group } from "three";
import type { MetricDatum, NodeDatum } from "@/lib/store";
import { HairLine, TechLabel, useMaterialize } from "../primitives";

export interface FlowChartProps {
  metrics?: MetricDatum[];
  color: string;
  accent: string;
}

const DEFAULT_FUNNEL: MetricDatum[] = [
  { label: "VISIT", value: 100 },
  { label: "SIGNUP", value: 62 },
  { label: "ACTIVATE", value: 44 },
  { label: "PAY", value: 27 },
];

const STAGE_H = 0.32;
const STAGE_GAP = 0.14;
const FUNNEL_MAX = 6;

export function Funnel3D({ metrics = DEFAULT_FUNNEL, color, accent }: FlowChartProps) {
  const ref = useMaterialize(0.8);
  const data = (metrics.length ? metrics : DEFAULT_FUNNEL).slice(0, FUNNEL_MAX);
  const max = Math.max(...data.map((m) => m.value), 1);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && metrics.length > FUNNEL_MAX) {
      console.warn(`[friday] funnel_3d renders ${FUNNEL_MAX} stages; ignoring ${metrics.length - FUNNEL_MAX}`);
    }
  }, [metrics.length]);

  const top = ((data.length - 1) * (STAGE_H + STAGE_GAP)) / 2;
  const cold = new Color(color);
  const hot = new Color(accent);

  return (
    <group ref={ref} position={[0, 0.45, 1.1]}>
      {data.map((m, i) => {
        const w = 0.6 + 3.2 * (m.value / max);
        const y = top - i * (STAGE_H + STAGE_GAP);
        const pct = data[0].value === 0 ? 0 : Math.round((m.value / data[0].value) * 100);
        const prevPct = i === 0 ? 100 : data[i - 1].value === 0 ? 0 : Math.round((m.value / data[i - 1].value) * 100);
        const t = max > 0 ? m.value / max : 0;
        const fill = `#${cold.clone().lerp(hot, t).getHexString()}`;
        return (
          <group key={`${m.label}-${i}`} position={[0, y, 0]}>
            <mesh
              visible={false}
              userData={{ viz: { label: m.label.toUpperCase(), detail: `${m.value} · ${pct}% OF TOP` } }}
            >
              <boxGeometry args={[w + 0.3, STAGE_H + 0.1, 0.4]} />
            </mesh>
            <mesh>
              <boxGeometry args={[w, STAGE_H, 0.16]} />
              <meshBasicMaterial color={fill} transparent opacity={0.72} toneMapped={false} depthWrite={false} />
            </mesh>
            <TechLabel position={[-w / 2 - 0.2, 0, 0]} color={color} size={0.075} anchorX="right" decode>
              {m.label}
            </TechLabel>
            <TechLabel position={[w / 2 + 0.2, 0, 0]} color="#e5f6ff" size={0.075} opacity={0.85} anchorX="left">
              {String(m.value)}
            </TechLabel>
            <TechLabel position={[0, -STAGE_H / 2 - 0.1, 0]} color={color} size={0.055} opacity={0.6}>
              {i === 0 ? "100% · TOP" : `${prevPct}% OF PREV`}
            </TechLabel>
            {i < data.length - 1 && (
              <HairLine points={[[-w / 2 + 0.3, -STAGE_H / 2 - 0.02, 0], [w / 2 - 0.3, -STAGE_H / 2 - 0.02, 0]]} color={color} opacity={0.25} lineWidth={1} />
            )}
          </group>
        );
      })}
    </group>
  );
}

export interface FlowSpatialProps {
  nodes?: NodeDatum[];
  links?: [number, number][];
  color: string;
  accent: string;
}

const DEFAULT_SANKEY: NodeDatum[] = [
  { id: "a", label: "ADS" },
  { id: "b", label: "SIGNUP" },
  { id: "c", label: "PAY" },
  { id: "d", label: "CHURN" },
];
const NODE_MAX = 12;
const LINK_MAX = 28;

/** BFS depth from source nodes; visited set breaks cycles deterministically. */
export function columnOf(nodes: NodeDatum[], links: [number, number][]): number[] {
  const depth = new Array(nodes.length).fill(0);
  const incoming = new Array(nodes.length).fill(0);
  for (const [a, b] of links) {
    if (a >= 0 && b >= 0 && a < nodes.length && b < nodes.length) incoming[b]++;
  }
  const queue: number[] = [];
  const seen = new Set<number>();
  nodes.forEach((_, i) => { if (incoming[i] === 0) { queue.push(i); seen.add(i); } });
  if (queue.length === 0 && nodes.length > 0) { queue.push(0); seen.add(0); }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const [a, b] of links) {
      if (a !== cur) continue;
      if (b < 0 || b >= nodes.length) continue;
      if (!seen.has(b)) {
        depth[b] = depth[cur] + 1;
        seen.add(b);
        queue.push(b);
      }
    }
  }
  return depth;
}

function FlowDot({ from, to, color, offset, speed }: { from: [number, number, number]; to: [number, number, number]; color: string; offset: number; speed: number }) {
  const ref = useRef<Group>(null);
  const a = useMemo(() => new Vector3(...from), [from]);
  const b = useMemo(() => new Vector3(...to), [to]);
  const reduced = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  useFrame(({ clock }) => {
    if (!ref.current || reduced) return;
    const t = (clock.elapsedTime * speed + offset) % 1;
    ref.current.position.lerpVectors(a, b, t);
  });
  return (
    <group ref={ref} position={reduced ? [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2] : from}>
      <mesh>
        <sphereGeometry args={[0.035, 8, 8]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

export function SankeyFlow({ nodes = DEFAULT_SANKEY, links = [[0, 1], [1, 2], [1, 3]] as [number, number][], color, accent }: FlowSpatialProps) {
  const ref = useMaterialize(0.9);
  const data = (nodes.length ? nodes : DEFAULT_SANKEY).slice(0, NODE_MAX);
  const edges = (links ?? []).slice(0, LINK_MAX);
  const depths = useMemo(() => columnOf(data, edges), [data, edges]);
  const maxDepth = Math.max(...depths, 0);

  const positions = useMemo(() => {
    const byCol = new Map<number, number[]>();
    data.forEach((_, i) => {
      const d = depths[i] ?? 0;
      if (!byCol.has(d)) byCol.set(d, []);
      byCol.get(d)!.push(i);
    });
    const pos = new Array<[number, number, number]>(data.length);
    for (const [d, members] of byCol) {
      const x = maxDepth === 0 ? 0 : (d / Math.max(1, maxDepth)) * 4.8 - 2.4;
      members.forEach((nodeIdx, k) => {
        const y = members.length === 1 ? 0.45 : 1.3 - (k / (members.length - 1)) * 1.7;
        pos[nodeIdx] = [x, y, 1.1];
      });
    }
    return pos;
  }, [data, depths, maxDepth]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && (nodes.length > NODE_MAX || (links?.length ?? 0) > LINK_MAX)) {
      console.warn(`[friday] sankey_flow caps ${NODE_MAX} nodes / ${LINK_MAX} links; truncating`);
    }
  }, [nodes.length, links?.length]);

  return (
    <group ref={ref}>
      {edges.map(([a, b], i) => (
        <group key={i}>
          <HairLine points={[positions[a] ?? [0, 0, 0], positions[b] ?? [0, 0, 0]]} color={color} opacity={0.28} lineWidth={1.5} />
          <FlowDot from={positions[a] ?? [0, 0, 0]} to={positions[b] ?? [0, 0, 0]} color={accent} offset={(i * 0.37) % 1} speed={0.22} />
        </group>
      ))}
      {positions.map((p, i) => (
        <group key={data[i].id} position={p}>
          <mesh visible={false} userData={{ viz: { label: (data[i].label ?? data[i].id).toUpperCase(), detail: "NODE ONLINE" } }}>
            <sphereGeometry args={[0.24, 10, 10]} />
          </mesh>
          <mesh>
            <octahedronGeometry args={[0.11, 0]} />
            <meshBasicMaterial color={i % 3 === 0 ? accent : color} transparent opacity={0.9} toneMapped={false} />
          </mesh>
          <mesh>
            <ringGeometry args={[0.17, 0.185, 24]} />
            <meshBasicMaterial color={color} transparent opacity={0.35} side={DoubleSide} depthWrite={false} />
          </mesh>
          <TechLabel position={[0, -0.3, 0]} color={color} size={0.075} opacity={0.9} decode>
            {data[i].label ?? data[i].id}
          </TechLabel>
        </group>
      ))}
    </group>
  );
}
