/**
 * Location sharing for get_client_location and the globe's YOU marker.
 *
 * Asked for only from the LOC button (a user gesture), never on load. A
 * permission the operator already granted is picked up silently on the next
 * visit — the browser would not prompt again anyway. Kept at full precision
 * before it is stored, and it lives in memory only.
 */
import { useFridayStore } from "@/lib/store";

/** When the current fix was taken; drives refreshIfStale. */
let fixedAt = 0;

export function shareLocation(): void {
  const { setLocation } = useFridayStore.getState();
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    setLocation(null, "unavailable");
    return;
  }
  setLocation(null, "pending");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      fixedAt = Date.now();
      setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }, "on");
    },
    (err) => setLocation(null, err.code === err.PERMISSION_DENIED ? "denied" : "unavailable"),
    // As precise as the device can: GPS/Wi-Fi fix, never a cached one, and
    // the longer timeout a high-accuracy fix can need.
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
  );
}

/** Re-fix a shared location older than `maxAgeMs` — called when the tab comes
 *  back into view, never on a timer (no continuous tracking). */
export function refreshIfStale(maxAgeMs: number): void {
  if (useFridayStore.getState().locationStatus === "on" && Date.now() - fixedAt > maxAgeMs) shareLocation();
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
