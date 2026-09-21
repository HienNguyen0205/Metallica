/**
 * Location sharing for get_client_location and the globe's YOU marker.
 *
 * Asked for only from the LOC button (a user gesture), never on load. A
 * permission the operator already granted is picked up silently on the next
 * visit — the browser would not prompt again anyway. Coarsened to ~1 km
 * before it is stored, and it lives in memory only.
 */
import { useFridayStore } from "@/lib/store";

const round2 = (v: number) => Math.round(v * 100) / 100;

export function shareLocation(): void {
  const { setLocation } = useFridayStore.getState();
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    setLocation(null, "unavailable");
    return;
  }
  setLocation(null, "pending");
  navigator.geolocation.getCurrentPosition(
    (pos) => setLocation({ lat: round2(pos.coords.latitude), lon: round2(pos.coords.longitude) }, "on"),
    (err) => setLocation(null, err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
    // Coarse on purpose: city-level is all any tool needs, and it is fast.
    { enableHighAccuracy: false, maximumAge: 10 * 60_000, timeout: 10_000 },
  );
}

export function stopSharing(): void {
  useFridayStore.getState().setLocation(null, "off");
}

/** Resume a permission granted on an earlier visit, without prompting. */
export async function resumeIfGranted(): Promise<void> {
  try {
    const status = await navigator.permissions?.query({ name: "geolocation" });
    if (status?.state === "granted" && useFridayStore.getState().locationStatus === "off") shareLocation();
  } catch {
    // Permissions API missing — the button still works.
  }
}
