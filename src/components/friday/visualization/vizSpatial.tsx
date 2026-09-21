"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, type Group } from "three";
import { useFridayStore, type NodeDatum } from "@/lib/store";
import { makeFocus, toggleFocus } from "@/lib/visualization/focus";
import { useFocusRelease } from "./useFocusRelease";
import { usePick } from "./usePick";
import { HairLine, TechLabel, useMaterialize } from "../primitives";

export interface SpatialProps {
  nodes?: NodeDatum[];
  links?: [number, number][];
  color: string;
  accent: string;
  /** Preview specs (interaction:"none") render without picking. */
  interactive?: boolean;
}

const DEFAULT_NODES: NodeDatum[] = [
  { id: "gw", label: "GATEWAY" },
  { id: "api", label: "API" },
  { id: "db", label: "DB" },
  { id: "cache", label: "CACHE" },
  { id: "queue", label: "QUEUE" },
  { id: "cdn", label: "CDN" },
  { id: "auth", label: "AUTH" },
];

/** Golden-angle distribution — even spread on a sphere with no layout pass. */
function spherePosition(i: number, total: number, radius: number): [number, number, number] {
  // half-step offset keeps node 0 off the pole, where perspective stacked it
  // onto its nearest neighbour (GATEWAY sat on top of API)
  const y = 1 - ((i + 0.5) / total) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = i * 2.399963;
  return [Math.cos(theta) * r * radius, y * radius * 0.75, Math.sin(theta) * r * radius];
}

interface NetworkNodeProps {
  node: NodeDatum;
  index: number;
  position: [number, number, number];
  color: string;
  accent: string;
  degree: number;
  selected: boolean;
  dimmed: boolean;
  interactive: boolean;
  onSelect: (node: NodeDatum, degree: number) => void;
}

/**
 * One network node. Native focus language: the selected/hovered node brightens
 * and its ring spins faster; when any node is selected the rest dim. Hit events
 * stopPropagation keeps the wrapper from ever seeing them, with a 6px gate so
 * orbit-drags ending on a node never select it.
 */
function NetworkNode({
  node,
  index,
  position,
  color,
  accent,
  degree,
  selected,
  dimmed,
  interactive,
  onSelect,
}: NetworkNodeProps) {
  const { hovered, bind } = usePick(() => onSelect(node, degree));
  const ringRef = useRef<Group>(null);
  const highlighted = selected || hovered;

  useFrame((_, delta) => {
    if (!ringRef.current) return;
    ringRef.current.rotation.z += delta * (highlighted ? 1.2 : 0.2);
  });

  const base = index % 3 === 0 ? accent : color;
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
          {`${degree} LINK${degree === 1 ? "" : "S"}`}
        </TechLabel>
      )}
    </group>
  );
}

/** §6 relationships → network graph orbiting the core. */
export function Network3D({ nodes = DEFAULT_NODES, links, color, accent, interactive = true }: SpatialProps) {
  const ref = useMaterialize(0.9);
  const spin = useRef<Group>(null);
  const data = nodes.length ? nodes : DEFAULT_NODES;

  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);
  const releaseOnMiss = useFocusRelease("network");

  const positions = useMemo(
    () => data.map((_, i) => spherePosition(i, data.length, 2.7)),
    [data],
  );
  const edges = useMemo(
    () => links ?? data.map((_, i) => [i, (i + 2) % data.length] as [number, number]),
    [links, data],
  );
  const degrees = useMemo(() => {
    const d = new Array<number>(data.length).fill(0);
    for (const [a, b] of edges) {
      if (a >= 0 && b >= 0 && a < d.length && b < d.length) {
        d[a]++;
        d[b]++;
      }
    }
    return d;
  }, [data, edges]);

  const selectedId = focus && focus.owner === "network" ? focus.key : null;
  const anySelected = !!selectedId;

  const handleSelect = (node: NodeDatum, degree: number) => {
    if (!interactive) return;
    setFocus(
      toggleFocus(
        useFridayStore.getState().focus,
        makeFocus(
          "network",
          node.id,
          (node.label ?? node.id).toUpperCase(),
          `${degree} LINK${degree === 1 ? "" : "S"}`,
        ),
      ),
    );
  };

  useFrame((_, delta) => {
    if (spin.current) spin.current.rotation.y += delta * 0.12;
  });

  return (
    <group
      ref={ref}
      onPointerMissed={releaseOnMiss}
    >
      <group ref={spin}>
        {edges.map(([a, b], i) => {
          const touches =
            selectedId !== null &&
            (data[a]?.id === selectedId || data[b]?.id === selectedId);
          return (
            <HairLine
              key={i}
              points={[positions[a] ?? [0, 0, 0], positions[b] ?? [0, 0, 0]]}
              color={touches ? accent : color}
              opacity={selectedId === null ? 0.45 : touches ? 0.9 : 0.12}
              lineWidth={touches ? 2 : 1.5}
            />
          );
        })}
        {positions.map((p, i) => (
          <NetworkNode
            key={data[i].id}
            node={data[i]}
            index={i}
            position={p}
            color={color}
            accent={accent}
            degree={degrees[i] ?? 0}
            selected={selectedId === data[i].id}
            dimmed={anySelected && selectedId !== data[i].id}
            interactive={interactive}
            onSelect={handleSelect}
          />
        ))}
      </group>
    </group>
  );
}


