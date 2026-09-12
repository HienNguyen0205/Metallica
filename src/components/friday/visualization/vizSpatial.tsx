"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, type Group } from "three";
import type { NodeDatum } from "@/lib/store";
import { HairLine, TechLabel, useMaterialize } from "../primitives";

export interface SpatialProps {
  nodes?: NodeDatum[];
  links?: [number, number][];
  color: string;
  accent: string;
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

/** §6 relationships → network graph orbiting the core. */
export function Network3D({ nodes = DEFAULT_NODES, links, color, accent }: SpatialProps) {
  const ref = useMaterialize(0.9);
  const spin = useRef<Group>(null);
  const data = nodes.length ? nodes : DEFAULT_NODES;

  const positions = useMemo(
    () => data.map((_, i) => spherePosition(i, data.length, 2.7)),
    [data],
  );
  const edges = useMemo(
    () => links ?? data.map((_, i) => [i, (i + 2) % data.length] as [number, number]),
    [links, data],
  );

  useFrame((_, delta) => {
    if (spin.current) spin.current.rotation.y += delta * 0.12;
  });

  return (
    <group ref={ref}>
      <group ref={spin}>
        {edges.map(([a, b], i) => (
          <HairLine
            key={i}
            points={[positions[a] ?? [0, 0, 0], positions[b] ?? [0, 0, 0]]}
            color={color}
            opacity={0.45}
            lineWidth={1.5}
          />
        ))}
        {positions.map((p, i) => (
          <group key={data[i].id} position={p}>
            <mesh
              visible={false}
              userData={{
                viz: {
                  label: (data[i].label ?? data[i].id).toUpperCase(),
                  detail: "NODE ONLINE",
                },
              }}
            >
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
    </group>
  );
}


