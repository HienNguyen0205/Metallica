import type { GeoPoint } from "@/lib/visualization/types";

/**
 * The operator's shared location as a globe marker. Appended last: routes can
 * reference points by index, and prepending would rewire every one of them.
 * A spec that already marks "you" (get_client_location's preview) is left
 * alone rather than drawn twice.
 */
export function withOperator(points: GeoPoint[], location: { lat: number; lon: number } | null): GeoPoint[] {
  if (!location || points.some((p) => p.id === "you")) return points;
  return [...points, { id: "you", label: "YOU", lat: location.lat, lon: location.lon, color: "#eafcff" }];
}
