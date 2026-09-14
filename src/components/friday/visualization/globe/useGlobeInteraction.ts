"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Vector3 } from "three";
import type { Group } from "three";
import { useFridayStore } from "@/lib/store";
import { reportCamera } from "@/lib/telemetry";
import { computeGlobeFocusAngles } from "./geo";

/** Rotation speed (rad/s) per FRIDAY state — motion carries meaning (§42). */
const STATE_SPIN: Record<string, number> = {
  idle: 0.05,
  listening: 0.03,
  thinking: 0.12,
  searching: 0.15,
  processing: 0.12,
  tool_execution: 0.12,
  visualizing: 0.06,
  speaking: 0.04,
  warning: 0.05,
  error: 0.02,
};

const MIN_DIST = 4.4;
const MAX_DIST = 9.5;
const HOME_DIST = 7.2;
const FOCUS_DIST = 4.9;
const MAX_TILT = 0.85;
const IDLE_RESUME_MS = 4000;

/** Scene position of the globe group — the camera orbits this point. */
export const GLOBE_CENTER = new Vector3(0, 0.2, -0.6);

const tmpDir = new Vector3();

// Single camera owner across mounted globes: last mount wins, cleared on
// unmount so a remaining globe can claim. Non-owners still spin their own
// group but never rewrite the shared camera.
let globeCameraOwner: symbol | null = null;

export interface GlobeFocusTarget {
  lat: number;
  lon: number;
}

export interface GlobeInteraction {
  /** Inner group — yaw/pitch rotation. Sits inside the entrance wrapper. */
  spinRef: React.RefObject<Group | null>;
  handlers: {
    onPointerDown: (e: ThreeEvent<PointerEvent>) => void;
    onPointerMove: (e: ThreeEvent<PointerEvent>) => void;
    onPointerUp: (e: ThreeEvent<PointerEvent>) => void;
    onWheel: (e: ThreeEvent<WheelEvent>) => void;
    onDoubleClick: (e: ThreeEvent<MouseEvent>) => void;
  };
  focusOn: (target: GlobeFocusTarget) => void;
  reset: () => void;
}

/**
 * Drag/orbit/dolly/focus controller for the globe.
 *
 * Owns the spin group's rotation and the camera's orbit distance directly in
 * refs — no React state per frame (§36). Zoom moves the camera (dolly),
 * never the planet's scale, so it reads as flying toward Earth (§13). While
 * a globe is mounted it holds camera ownership and the cinematic CameraRig
 * yields (§16).
 */
export function useGlobeInteraction({
  autoRotate = true,
  getFocusTarget,
}: {
  autoRotate?: boolean;
  /** Resolves the currently selected marker for the `F` key. */
  getFocusTarget?: () => GlobeFocusTarget | null;
} = {}): GlobeInteraction {
  const spinRef = useRef<Group | null>(null);
  const instanceId = useMemo(() => Symbol("globe"), []);

  // Claim camera ownership on mount (last mount wins); release on unmount.
  useEffect(() => {
    globeCameraOwner = instanceId;
    return () => {
      if (globeCameraOwner === instanceId) globeCameraOwner = null;
    };
  }, [instanceId]);

  const yaw = useRef(0);
  const pitch = useRef(0.12);
  const velYaw = useRef(0);
  const velPitch = useRef(0);
  // Camera orbit distance from the globe center — zoom dollies the camera.
  const dist = useRef(HOME_DIST);
  const distTarget = useRef(HOME_DIST);
  const dragging = useRef(false);
  const lastPointer = useRef<[number, number]>([0, 0]);
  const pinch = useRef(new Map<number, [number, number]>());
  const pinchDist = useRef(0);
  const lastInteract = useRef(0);
  const focusAnim = useRef<{ yaw: number; pitch: number } | null>(null);
  const autoPaused = useRef(false);
  const reduced = useRef(false);
  const didInitDist = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => {
      reduced.current = mq.matches;
    };
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);

  const touch = useCallback(() => {
    lastInteract.current = performance.now();
    focusAnim.current = null;
  }, []);

  const focusOn = useCallback(
    (target: GlobeFocusTarget) => {
      // Yaw aligns longitude, pitch aligns latitude (clamped — high-latitude
      // nodes never fully center, by design). Shared pure helper in geo.ts.
      const { yaw: targetYaw, pitch: targetPitch } = computeGlobeFocusAngles(
        target.lat,
        target.lon,
        yaw.current,
        MAX_TILT,
      );
      touch();
      // Fly the camera in as well as turning the planet — focus should feel
      // like approaching the node (§14).
      distTarget.current = FOCUS_DIST;
      if (reduced.current) {
        yaw.current = targetYaw;
        pitch.current = targetPitch;
        dist.current = FOCUS_DIST;
        return;
      }
      focusAnim.current = { yaw: targetYaw, pitch: targetPitch };
    },
    [touch],
  );

  const reset = useCallback(() => {
    touch();
    distTarget.current = HOME_DIST;
    if (reduced.current) {
      yaw.current = 0;
      pitch.current = 0.12;
      velYaw.current = 0;
      velPitch.current = 0;
      dist.current = HOME_DIST;
      return;
    }
    focusAnim.current = { yaw: 0, pitch: 0.12 };
  }, [touch]);

  // Keyboard alternatives (§41) — ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const step = 0.18;
      switch (e.key) {
        case "ArrowLeft":
          touch();
          velYaw.current -= step;
          break;
        case "ArrowRight":
          touch();
          velYaw.current += step;
          break;
        case "ArrowUp":
          touch();
          pitch.current = Math.max(-MAX_TILT, Math.min(MAX_TILT, pitch.current + 0.12));
          break;
        case "ArrowDown":
          touch();
          pitch.current = Math.max(-MAX_TILT, Math.min(MAX_TILT, pitch.current - 0.12));
          break;
        case "+":
        case "=":
          touch();
          distTarget.current = Math.max(MIN_DIST, distTarget.current / 1.12);
          break;
        case "-":
        case "_":
          touch();
          distTarget.current = Math.min(MAX_DIST, distTarget.current * 1.12);
          break;
        case "r":
        case "R":
          reset();
          break;
        case "f":
        case "F": {
          const target = getFocusTarget?.();
          if (target) focusOn(target);
          break;
        }
        case " ":
          e.preventDefault();
          autoPaused.current = !autoPaused.current;
          touch();
          break;
        case "Escape":
          focusAnim.current = null;
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusOn, getFocusTarget, reset, touch]);

  useFrame(({ camera }, rawDelta) => {
    const spin = spinRef.current;
    const delta = Math.min(rawDelta, 0.05);
    const state = useFridayStore.getState().state;

    // Claim ownership lazily if the previous owner unmounted.
    if (globeCameraOwner === null) globeCameraOwner = instanceId;
    const ownsCamera = globeCameraOwner === instanceId;

    if (focusAnim.current) {
      // easeInOutCubic toward the focus orientation (§25).
      const k = reduced.current ? 1 : Math.min(1, delta * 3.2);
      const ease = k < 1 ? (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2) : 1;
      yaw.current += (focusAnim.current.yaw - yaw.current) * ease;
      pitch.current += (focusAnim.current.pitch - pitch.current) * ease;
      velYaw.current = 0;
      velPitch.current = 0;
      if (Math.abs(focusAnim.current.yaw - yaw.current) < 0.002) focusAnim.current = null;
    } else if (!dragging.current) {
      const idleMs = performance.now() - lastInteract.current;
      const canAuto =
        autoRotate && !autoPaused.current && !reduced.current && idleMs > IDLE_RESUME_MS;
      if (canAuto) yaw.current += (STATE_SPIN[state] ?? 0.05) * delta;
      // Inertia with frame-rate independent friction (§22).
      const friction = reduced.current ? 0 : Math.exp(-delta * 3.5);
      yaw.current += velYaw.current * delta;
      pitch.current = Math.max(
        -MAX_TILT,
        Math.min(MAX_TILT, pitch.current + velPitch.current * delta),
      );
      velYaw.current *= friction;
      velPitch.current *= friction;
      if (Math.abs(velYaw.current) < 0.0005) velYaw.current = 0;
      if (Math.abs(velPitch.current) < 0.0005) velPitch.current = 0;
    }

    if (spin) spin.rotation.set(pitch.current, yaw.current, 0);

    // Only the owning globe drives the shared camera; the others still spin
    // their own group. Init from the live camera distance to avoid a snap
    // when the rig hands over (Scene starts at z=6.8, HOME is 7.2).
    if (!ownsCamera) return;
    if (!didInitDist.current) {
      didInitDist.current = true;
      const live = camera.position.distanceTo(GLOBE_CENTER);
      if (Number.isFinite(live)) {
        const clamped = Math.max(MIN_DIST, Math.min(MAX_DIST, live));
        dist.current = clamped;
        if (distTarget.current === HOME_DIST) distTarget.current = clamped;
      }
    }
    // Camera-based zoom: dolly along the current view direction toward the
    // globe center — the camera flies, the planet never rescales (§13).
    dist.current += (distTarget.current - dist.current) * Math.min(1, delta * 5);
    tmpDir.copy(camera.position).sub(GLOBE_CENTER);
    if (tmpDir.lengthSq() < 1e-6) tmpDir.set(0, 0, 1);
    tmpDir.normalize();
    camera.position.copy(GLOBE_CENTER).addScaledVector(tmpDir, dist.current);
    camera.lookAt(GLOBE_CENTER);
    reportCamera(camera.position.x, camera.position.y, camera.position.z);
  });

  const handlers = useMemo<GlobeInteraction["handlers"]>(
    () => ({
      onPointerDown: (e) => {
        // Let marker clicks handle their own focus — don't steal the pointer
        // or start a drag when the ray hits a marker's hitbox.
        const isMarker = !!(e.object as unknown as { userData?: { viz?: unknown } })?.userData?.viz;
        if (isMarker) return;
        (e.target as Element).setPointerCapture?.(e.pointerId);
        pinch.current.set(e.pointerId, [e.nativeEvent.clientX, e.nativeEvent.clientY]);
        if (pinch.current.size === 2) {
          const [a, b] = [...pinch.current.values()];
          pinchDist.current = Math.hypot(a[0] - b[0], a[1] - b[1]);
          dragging.current = false;
          return;
        }
        dragging.current = true;
        focusAnim.current = null;
        lastPointer.current = [e.nativeEvent.clientX, e.nativeEvent.clientY];
        velYaw.current = 0;
        velPitch.current = 0;
        touch();
      },
      onPointerMove: (e) => {
        const prev = pinch.current.get(e.pointerId);
        if (prev) pinch.current.set(e.pointerId, [e.nativeEvent.clientX, e.nativeEvent.clientY]);
        if (pinch.current.size === 2) {
          const [a, b] = [...pinch.current.values()];
          const pinchNow = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (pinchDist.current > 0 && pinchNow > 0) {
            // Spread fingers → fly closer (distance shrinks).
            distTarget.current = Math.max(
              MIN_DIST,
              Math.min(MAX_DIST, distTarget.current * (pinchDist.current / pinchNow)),
            );
          }
          pinchDist.current = pinchNow;
          touch();
          return;
        }
        if (!dragging.current) return;
        const dx = e.nativeEvent.clientX - lastPointer.current[0];
        const dy = e.nativeEvent.clientY - lastPointer.current[1];
        lastPointer.current = [e.nativeEvent.clientX, e.nativeEvent.clientY];
        yaw.current += dx * 0.005;
        pitch.current = Math.max(-MAX_TILT, Math.min(MAX_TILT, pitch.current + dy * 0.003));
        if (!reduced.current) {
          velYaw.current = dx * 0.005 * 60 * 0.16;
          velPitch.current = dy * 0.003 * 60 * 0.16;
        }
        touch();
      },
      onPointerUp: (e) => {
        pinch.current.delete(e.pointerId);
        if (pinch.current.size < 2) pinchDist.current = 0;
        if (pinch.current.size === 0) dragging.current = false;
        touch();
      },
      onWheel: (e) => {
        // Wheel up (negative deltaY) flies the camera in.
        distTarget.current = Math.max(
          MIN_DIST,
          Math.min(MAX_DIST, distTarget.current * (1 + e.nativeEvent.deltaY * 0.001)),
        );
        touch();
      },
      onDoubleClick: () => {
        touch();
        reset();
      },
    }),
    [touch, reset],
  );

  return { spinRef, handlers, focusOn, reset };
}
