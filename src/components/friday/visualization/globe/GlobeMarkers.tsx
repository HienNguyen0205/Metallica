"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Billboard } from "@react-three/drei";
import { DoubleSide, type Group } from "three";
import type { GeoPoint } from "@/lib/store";
import { TechLabel } from "../../primitives";
import {
  STATUS_COLORS,
  latLonToVector3,
  markerDetail,
  markerKey,
  markerLabel,
  markerRadius,
  normalizeMetric,
  statusOf,
} from "./geo";

interface MarkerNodeProps {
  point: GeoPoint;
  index: number;
  radius: number;
  accent: string;
  selected: boolean;
  dimmed: boolean;
  showLabel: boolean;
  reduced: boolean;
  onFocusMarker: (point: GeoPoint) => void;
}

/**
 * One city/node marker: glowing core + halo + label, pinned to the curved
 * surface through the canonical lat/lon mapping. Size encodes value
 * (log-normalized), color encodes status — never raw linear scale (§15-16).
 */
function MarkerNode({
  point,
  index,
  radius,
  accent,
  selected,
  dimmed,
  showLabel,
  reduced,
  onFocusMarker,
}: MarkerNodeProps) {
  const group = useRef<Group>(null);
  const [hovered, setHovered] = useState(false);

  const pos = useMemo(
    () => latLonToVector3(point.lat, point.lon, radius + 0.015),
    [point.lat, point.lon, radius],
  );
  const label = markerLabel(point, index);
  const status = statusOf(point);
  const tint = point.color ?? STATUS_COLORS[status];
  const core = Math.max(0.02, markerRadius(normalizeMetric(point.value ?? 0)));
  const alert = status === "warning" || status === "critical";
  const detail = useMemo(() => markerDetail(point), [point]);
  const opacity = dimmed ? 0.25 : 1;

  useFrame(({ clock }) => {
    if (!group.current || reduced) return;
    const pulse = alert ? 1 + Math.sin(clock.elapsedTime * (status === "critical" ? 5 : 3)) * 0.14 : 1;
    const emphasis = selected || hovered ? 1.3 : 1;
    group.current.scale.setScalar(pulse * emphasis);
  });

  const onOver = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    setHovered(true);
    document.body.style.cursor = "pointer";
  };
  const onOut = () => {
    setHovered(false);
    document.body.style.cursor = "auto";
  };

  return (
    <group position={pos}>
      <group ref={group}>
        {/* Raycast target + drill-down tag. Click-to-inspect is served by the
            shared DrillDown wrapper; double-click flies the globe to the node. */}
        <mesh
          visible={false}
          userData={{ viz: { label, detail } }}
          onPointerOver={onOver}
          onPointerOut={onOut}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onFocusMarker(point);
          }}
        >
          <sphereGeometry args={[Math.max(0.17, core * 2.4), 10, 10]} />
        </mesh>
        <mesh>
          <sphereGeometry args={[core, 12, 12]} />
          <meshBasicMaterial
            color={selected ? "#eafcff" : tint}
            transparent
            opacity={opacity}
            toneMapped={false}
          />
        </mesh>
        <Billboard>
          <mesh>
            <ringGeometry args={[core * 1.9, core * 2.1, 32]} />
            <meshBasicMaterial
              color={selected || hovered ? accent : tint}
              transparent
              opacity={(selected || hovered ? 0.9 : 0.45) * opacity}
              side={DoubleSide}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </Billboard>
        {(showLabel || hovered || selected) && (
          <TechLabel
            position={[0, core + 0.16, 0]}
            color={selected ? "#eafcff" : tint}
            size={0.07}
            opacity={opacity}
            decode
          >
            {label}
          </TechLabel>
        )}
      </group>
    </group>
  );
}

export function GlobeMarkers({
  points,
  radius,
  accent,
  selectedLabel,
  reduced,
  onFocusMarker,
}: {
  points: GeoPoint[];
  radius: number;
  accent: string;
  selectedLabel: string | null;
  reduced: boolean;
  onFocusMarker: (point: GeoPoint) => void;
}) {
  // Dense scenes label only on demand — hover/selection still surface names
  // through the shared drill-down hover tag (§17).
  const showLabels = points.length <= 8;
  return (
    <group>
      {points.map((p, i) => {
        const label = markerLabel(p, i);
        return (
          <MarkerNode
            key={markerKey(p, i)}
            point={p}
            index={i}
            radius={radius}
            accent={accent}
            selected={selectedLabel === label}
            dimmed={selectedLabel !== null && selectedLabel !== label}
            showLabel={showLabels}
            reduced={reduced}
            onFocusMarker={onFocusMarker}
          />
        );
      })}
    </group>
  );
}
