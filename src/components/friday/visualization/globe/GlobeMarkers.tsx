"use client";

import { useMemo, useRef, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Vector3, type Group } from "three";
import type { GeoPoint } from "@/lib/store";
import { TechLabel } from "../../primitives";
import { GLOBE_CENTER } from "./useGlobeInteraction";
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
  selected: boolean;
  dimmed: boolean;
  showLabel: boolean;
  reduced: boolean;
  onFocusMarker: (point: GeoPoint, index: number, worldPos: [number, number, number]) => void;
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
  selected,
  dimmed,
  showLabel,
  reduced,
  onFocusMarker,
}: MarkerNodeProps) {
  const group = useRef<Group>(null);
  const [hovered, setHovered] = useState(false);
  // Click-vs-drag gate (mirrors DrillDown's 6px threshold): ending a globe
  // drag on a marker must not yank the camera.
  const downAt = useRef<[number, number] | null>(null);
  const cam = useThree((s) => s.camera);
  const globeCenter = GLOBE_CENTER;

  const pos = useMemo(
    () => latLonToVector3(point.lat, point.lon, radius + 0.015),
    [point.lat, point.lon, radius],
  );
  const label = markerLabel(point, index);
  const status = statusOf(point);
  const tint = point.color ?? STATUS_COLORS[status];
  const core = Math.max(0.011, markerRadius(normalizeMetric(point.value ?? 0)));
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
    // Ignore backside hits — the raycaster hits through the opaque globe and
    // the far-side hitbox can protrude to the front; check world-space facing.
    const worldPos = new Vector3();
    e.object.getWorldPosition(worldPos);
    const toMarker = worldPos.clone().sub(globeCenter).normalize();
    const toCam = new Vector3().copy(cam.position).sub(globeCenter).normalize();
    if (toCam.dot(toMarker) < 0.15) return;
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
            shared DrillDown wrapper; single click also flies the globe to the
            node (onClick below).
            NOTE: this proxy must carry a real material. THREE.Mesh.raycast
            early-outs when material is undefined, so a material-less (even
            invisible) mesh is never hit — hover/click/focus silently die.
            opacity 0 + depthWrite false keeps it visually absent. */}
        <mesh
          userData={{ viz: { label, detail, globe: true } }}
          onPointerDown={(e) => {
            downAt.current = [e.nativeEvent.clientX, e.nativeEvent.clientY];
          }}
          onPointerOver={onOver}
          onPointerOut={onOut}
          onClick={(e) => {
            // A drag-end lands as a click on the same object — ignore it so
            // orbiting the planet never triggers a camera flight.
            if (downAt.current) {
              const dx = e.nativeEvent.clientX - downAt.current[0];
              const dy = e.nativeEvent.clientY - downAt.current[1];
              downAt.current = null;
              if (Math.hypot(dx, dy) > 6) return;
            }
            // Backside guard (same as hover)
            const worldPos = new Vector3();
            e.object.getWorldPosition(worldPos);
            const toMarker = worldPos.clone().sub(globeCenter).normalize();
            const toCam = new Vector3().copy(cam.position).sub(globeCenter).normalize();
            if (toCam.dot(toMarker) < 0.15) return;
            // Only the camera flies — stop the click here so the shared
            // DrillDown wrapper does not create an extra reticle/connector
            // on top of the marker.
            e.stopPropagation();
            onFocusMarker(point, index, [worldPos.x, worldPos.y, worldPos.z]);
          }}
          onDoubleClick={(e) => {
            // Swallow: a double-click is two focusing clicks, never a reset.
            e.stopPropagation();
          }}
        >
          <sphereGeometry args={[0.16, 10, 10]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh>
          <sphereGeometry args={[core, 10, 10]} />
          <meshBasicMaterial
            color={selected ? "#eafcff" : tint}
            transparent
            opacity={opacity}
            toneMapped={false}
          />
        </mesh>
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
  selectedLabel,
  reduced,
  onFocusMarker,
}: {
  points: GeoPoint[];
  radius: number;
  selectedLabel: string | null;
  reduced: boolean;
  onFocusMarker: (point: GeoPoint, index: number, worldPos: [number, number, number]) => void;
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
