"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { DoubleSide, type Group } from "three";
import type { GeoPoint, NodeDatum } from "@/lib/store";
import { HairLine, TechLabel, useMaterialize } from "../primitives";
import CoreParticles from "../core/CoreParticles";

export interface SpatialProps {
  nodes?: NodeDatum[];
  links?: [number, number][];
  points?: GeoPoint[];
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
  const y = 1 - (i / Math.max(1, total - 1)) * 2;
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
            opacity={0.22}
            lineWidth={1}
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
            <TechLabel position={[0, -0.26, 0]} color={color} size={0.055} opacity={0.7}>
              {data[i].label ?? data[i].id}
            </TechLabel>
          </group>
        ))}
      </group>
    </group>
  );
}

const DEFAULT_GEO: GeoPoint[] = [
  { lat: 21.03, lon: 105.85, label: "HAN" },
  { lat: 1.35, lon: 103.82, label: "SIN" },
  { lat: 37.77, lon: -122.42, label: "SFO" },
  { lat: 50.11, lon: 8.68, label: "FRA" },
];

/** §6 location → holographic globe with surface markers. */
export function Globe3D({ points = DEFAULT_GEO, color, accent }: SpatialProps) {
  const ref = useMaterialize(1);
  const spin = useRef<Group>(null);
  const data = points.length ? points : DEFAULT_GEO;
  const R = 1.9;

  useFrame((_, delta) => {
    if (spin.current) spin.current.rotation.y += delta * 0.16;
  });

  const markers = useMemo(
    () =>
      data.map((p) => {
        const phi = (90 - p.lat) * (Math.PI / 180);
        const theta = (p.lon + 180) * (Math.PI / 180);
        return {
          label: p.label ?? "",
          pos: [
            -R * Math.sin(phi) * Math.cos(theta),
            R * Math.cos(phi),
            R * Math.sin(phi) * Math.sin(theta),
          ] as [number, number, number],
        };
      }),
    [data],
  );

  return (
    <group ref={ref} position={[0, 0, -0.6]}>
      <group ref={spin}>
        <mesh>
          <sphereGeometry args={[R, 32, 24]} />
          <meshBasicMaterial color={color} wireframe transparent opacity={0.16} toneMapped={false} />
        </mesh>
        {markers.map((m) => (
          <group key={m.label} position={m.pos}>
            <mesh
              visible={false}
              userData={{ viz: { label: m.label.toUpperCase() || "EDGE", detail: "EDGE REGION" } }}
            >
              <sphereGeometry args={[0.17, 10, 10]} />
            </mesh>
            <mesh>
              <sphereGeometry args={[0.05, 10, 10]} />
              <meshBasicMaterial color={accent} toneMapped={false} />
            </mesh>
            <TechLabel position={[0, 0.16, 0]} color={accent} size={0.055} opacity={0.85}>
              {m.label}
            </TechLabel>
          </group>
        ))}
      </group>
      {/* equatorial guide ring stays fixed while the globe turns */}
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <ringGeometry args={[R + 0.22, R + 0.235, 96]} />
        <meshBasicMaterial color={color} transparent opacity={0.3} side={DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** §6 traffic → particle flow streaming outward from the core. */
export function ParticleFlow({ color, accent }: SpatialProps) {
  return (
    <group>
      <CoreParticles count={1400} color={accent} intensity={2.2} mode="flow" innerRadius={0} span={3.4} />
      <mesh rotation={[Math.PI / 2.15, 0, 0]}>
        <ringGeometry args={[3.35, 3.37, 96]} />
        <meshBasicMaterial color={color} transparent opacity={0.25} side={DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  );
}
