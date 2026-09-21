"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, Vector3, type Group } from "three";
import { useFridayStore, type NodeDatum } from "@/lib/store";
import { makeFocus, releaseFocus, toggleFocus } from "@/lib/visualization/focus";
import { useFocusRelease } from "./useFocusRelease";
import { usePick } from "./usePick";
import { HairLine, TechLabel, useMaterialize } from "../primitives";

export interface FlowSpatialProps {
  nodes?: NodeDatum[];
  links?: [number, number][];
  color: string;
  accent: string;
  /** Preview specs (interaction:"none") render without picking. */
  interactive?: boolean;
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

/** One sankey stage node: native hover/select on the focus spine. */
function SankeyNode({
  node,
  index,
  position,
  color,
  accent,
  detail,
  selected,
  dimmed,
  interactive,
  onSelect,
}: {
  node: NodeDatum;
  index: number;
  position: [number, number, number];
  color: string;
  accent: string;
  detail: string;
  selected: boolean;
  dimmed: boolean;
  interactive: boolean;
  onSelect: (node: NodeDatum, detail: string) => void;
}) {
  const { hovered, bind } = usePick(() => onSelect(node, detail));
  const ringRef = useRef<Group>(null);
  const highlighted = selected || hovered;
  const base = index % 3 === 0 ? accent : color;

  useFrame((_, delta) => {
    if (!ringRef.current) return;
    ringRef.current.rotation.z += delta * (highlighted ? 1.2 : 0.2);
  });

  return (
    <group position={position}>
      {interactive && (
        <mesh
          visible={false}
          {...bind}
        >
          <sphereGeometry args={[0.24, 10, 10]} />
        </mesh>
      )}
      <mesh>
        <octahedronGeometry args={[0.11, 0]} />
        <meshBasicMaterial
          color={highlighted ? "#eafcff" : base}
          transparent
          opacity={dimmed ? 0.2 : 0.9}
          toneMapped={false}
        />
      </mesh>
      <group ref={ringRef} scale={selected ? 1.35 : 1}>
        <mesh>
          <ringGeometry args={[0.17, 0.185, 24]} />
          <meshBasicMaterial
            color={highlighted ? "#eafcff" : color}
            transparent
            opacity={dimmed ? 0.08 : highlighted ? 0.8 : 0.35}
            side={DoubleSide}
            depthWrite={false}
          />
        </mesh>
      </group>
      <TechLabel position={[0, -0.3, 0]} color={color} size={0.075} opacity={dimmed ? 0.25 : 0.9} decode>
        {node.label ?? node.id}
      </TechLabel>
      {selected && (
        <TechLabel position={[0, -0.46, 0]} color="#eafcff" size={0.06} opacity={0.9}>
          {detail}
        </TechLabel>
      )}
    </group>
  );
}

export function SankeyFlow({
  nodes = DEFAULT_SANKEY,
  links = [[0, 1], [1, 2], [1, 3]] as [number, number][],
  color,
  accent,
  interactive = true,
}: FlowSpatialProps) {
  const ref = useMaterialize(0.9);
  const data = (nodes.length ? nodes : DEFAULT_SANKEY).slice(0, NODE_MAX);
  const edges = (links ?? []).slice(0, LINK_MAX);
  const depths = useMemo(() => columnOf(data, edges), [data, edges]);
  const maxDepth = Math.max(...depths, 0);

  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);
  useFocusRelease("sankey");
  const selectedId = focus && focus.owner === "sankey" ? focus.key : null;
  const anySelected = selectedId !== null;

  const handleSelect = (node: NodeDatum, detail: string) => {
    setFocus(
      toggleFocus(
        useFridayStore.getState().focus,
        makeFocus("sankey", node.id, (node.label ?? node.id).toUpperCase(), detail),
      ),
    );
  };

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

  // Data-driven detail instead of the static "NODE ONLINE": flow in/out counts.
  const flowDetail = useMemo(() => {
    const inD = new Array<number>(data.length).fill(0);
    const outD = new Array<number>(data.length).fill(0);
    for (const [a, b] of edges) {
      if (a >= 0 && b >= 0 && a < inD.length && b < inD.length) {
        outD[a]++;
        inD[b]++;
      }
    }
    return data.map((_, i) => `${inD[i]} IN · ${outD[i]} OUT`);
  }, [data, edges]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && (nodes.length > NODE_MAX || (links?.length ?? 0) > LINK_MAX)) {
      console.warn(`[friday] sankey_flow caps ${NODE_MAX} nodes / ${LINK_MAX} links; truncating`);
    }
  }, [nodes.length, links?.length]);

  return (
    <group
      ref={ref}
      onPointerMissed={
        interactive
          ? () => {
              const s = useFridayStore.getState();
              s.setFocus(releaseFocus(s.focus, "sankey"));
            }
          : undefined
      }
    >
      {edges.map(([a, b], i) => {
        const touches =
          selectedId !== null && (data[a]?.id === selectedId || data[b]?.id === selectedId);
        return (
          <group key={i}>
            <HairLine
              points={[positions[a] ?? [0, 0, 0], positions[b] ?? [0, 0, 0]]}
              color={touches ? "#eafcff" : color}
              opacity={anySelected ? (touches ? 0.85 : 0.08) : 0.28}
              lineWidth={touches ? 2 : 1.5}
            />
            <FlowDot
              from={positions[a] ?? [0, 0, 0]}
              to={positions[b] ?? [0, 0, 0]}
              color={touches ? accent : anySelected ? "#0e3540" : accent}
              offset={(i * 0.37) % 1}
              speed={0.22}
            />
          </group>
        );
      })}
      {positions.map((p, i) => (
        <SankeyNode
          key={data[i].id}
          node={data[i]}
          index={i}
          position={p}
          color={color}
          accent={accent}
          detail={flowDetail[i] ?? ""}
          selected={selectedId === data[i].id}
          dimmed={anySelected && selectedId !== data[i].id}
          interactive={interactive}
          onSelect={handleSelect}
        />
      ))}
    </group>
  );
}
