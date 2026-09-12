"use client";

import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group } from "three";
import type { GeoPoint, GlobeRoute } from "@/lib/store";
import { HairLine } from "../../primitives";
import {
  STATUS_COLORS,
  arcPointAt,
  buildArcPoints,
  latLonToVector3,
  markerLabel,
  normalizeMetric,
  particleCountFor,
  resolveGlobeRoute,
  type Vec3,
} from "./geo";

const ROUTE_MAX = 24;

interface ResolvedRoute {
  route: GlobeRoute;
  samples: Vec3[];
  fromLabel: string;
  toLabel: string;
}

/** Traffic → thickness, deliberately narrow so busy routes never dominate (§19). */
function routeWidth(value: number | undefined): number {
  return 1 + normalizeMetric(value ?? 0) * 1.5;
}

function RouteParticles({
  samples,
  count,
  color,
  opacity,
  speed,
  reduced,
}: {
  samples: Vec3[];
  count: number;
  color: string;
  opacity: number;
  speed: number;
  reduced: boolean;
}) {
  const refs = useRef<Array<Group | null>>([]);
  const offsets = useMemo(() => Array.from({ length: count }, (_, i) => i / Math.max(1, count)), [count]);

  useFrame(({ clock }) => {
    if (reduced) {
      for (let i = 0; i < count; i++) {
        const g = refs.current[i];
        if (g) g.position.set(...arcPointAt(samples, offsets[i] ?? 0));
      }
      return;
    }
    const t = clock.elapsedTime * speed;
    for (let i = 0; i < count; i++) {
      const g = refs.current[i];
      if (!g) continue;
      const p = arcPointAt(samples, t + (offsets[i] ?? 0));
      g.position.set(p[0], p[1], p[2]);
    }
  });

  return (
    <group>
      {offsets.map((_, i) => (
        <group
          key={i}
          ref={(g) => {
            refs.current[i] = g;
          }}
        >
          <mesh>
            <sphereGeometry args={[0.028, 8, 8]} />
            <meshBasicMaterial color={color} transparent opacity={opacity} toneMapped={false} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

/**
 * Curved data arcs between markers, with direction-carrying particles.
 * One shared `HairLine` per arc + a handful of instanced-light dots —
 * never one React component per particle (§37).
 */
export function GlobeRoutes({
  points,
  routes,
  radius,
  color,
  selectedLabel,
  particleScale,
  particleSpeed,
  reduced,
}: {
  points: GeoPoint[];
  routes: GlobeRoute[];
  radius: number;
  color: string;
  selectedLabel: string | null;
  particleScale: number;
  particleSpeed: number;
  reduced: boolean;
}) {
  const resolved = useMemo<ResolvedRoute[]>(() => {
    const out: ResolvedRoute[] = [];
    for (const route of routes.slice(0, ROUTE_MAX)) {
      const hit = resolveGlobeRoute(points, route);
      if (!hit) continue;
      const a = points[hit.a];
      const b = points[hit.b];
      if (!a || !b) continue;
      out.push({
        route,
        samples: buildArcPoints(
          latLonToVector3(a.lat, a.lon, radius + 0.01),
          latLonToVector3(b.lat, b.lon, radius + 0.01),
          radius + 0.01,
          40,
        ),
        fromLabel: markerLabel(a, hit.a),
        toLabel: markerLabel(b, hit.b),
      });
    }
    return out;
  }, [points, routes, radius]);

  return (
    <group>
      {resolved.map(({ route, samples, fromLabel, toLabel }) => {
        const status = route.status ?? "healthy";
        const tint = status === "healthy" ? color : STATUS_COLORS[status];
        const touchesSelection =
          selectedLabel === null || selectedLabel === fromLabel || selectedLabel === toLabel;
        const opacity = touchesSelection ? 0.75 : 0.15;
        const count = Math.max(
          0,
          Math.min(3, Math.round(particleCountFor(route.value) * particleScale)),
        );
        return (
          <group key={route.id}>
            <HairLine points={samples} color={tint} opacity={opacity} lineWidth={routeWidth(route.value)} />
            {count > 0 && (
              <RouteParticles
                samples={samples}
                count={count}
                color={tint}
                opacity={touchesSelection ? 1 : 0.2}
                speed={0.14 * particleSpeed * (touchesSelection ? 1.4 : 1)}
                reduced={reduced}
              />
            )}
          </group>
        );
      })}
    </group>
  );
}
