/**
 * Location sharing for get_client_location and the globe's YOU marker.
 *
 * Asked for at load (InputBar) and again from the LOC button. A permission
 * the operator already granted is picked up without a prompt. Kept at full
 * precision before it is stored, and it lives in memory only.
 */
import { useFridayStore } from "@/lib/store";

/** When the current fix was taken; drives refreshIfStale. */
let fixedAt = 0;

export function shareLocation(): void {
  acquire(false);
}

/** Re-fix a shared location older than `maxAgeMs` — called when the tab comes
 *  back into view, never on a timer (no continuous tracking). */
export function refreshIfStale(maxAgeMs: number): void {
  if (useFridayStore.getState().locationStatus === "on" && Date.now() - fixedAt > maxAgeMs) acquire(true);
}

/**
 * `refresh` keeps the current fix usable while a new one is taken and after
 * a failed attempt: a high-accuracy fix indoors can time out, and that must
 * not throw away a good location and turn sharing off. Only a revoked
 * permission ends sharing on a refresh.
 */
function acquire(refresh: boolean): void {
  const store = useFridayStore.getState;
  if (typeof navigator === "undefined" || !navigator.geolocation) {
    if (!refresh) store().setLocation(null, "unavailable");
    return;
  }
  if (!refresh) store().setLocation(null, "pending");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // Turned off while this fix was in flight: it must not switch back on.
      const status = store().locationStatus;
      if (status !== "pending" && status !== "on") return;
      fixedAt = Date.now();
      store().setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: pos.coords.accuracy }, "on");
    },
    (err) => {
      const status = store().locationStatus;
      if (status === "off") return;
      if (err.code === err.PERMISSION_DENIED) store().setLocation(null, "denied");
      else if (!(refresh && status === "on")) store().setLocation(null, "unavailable");
    },
    // As precise as the device can: GPS/Wi-Fi fix, never a cached one, and
    // the longer timeout a high-accuracy fix can need.
    { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
  );
}

export function stopSharing(): void {
  useFridayStore.getState().setLocation(null, "off");
}
