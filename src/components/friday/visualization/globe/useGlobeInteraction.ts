"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { Group } from "three";
import { useFridayStore } from "@/lib/store";

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

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 1.6;
const MAX_TILT = 0.5;
const IDLE_RESUME_MS = 4000;

function wrapDelta(angle: number): number {
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

export interface GlobeFocusTarget {
  lat: number;
  lon: number;
}

export interface GlobeInteraction {
  /** Inner group — yaw/pitch rotation. Sits inside the entrance wrapper. */
  spinRef: React.RefObject<Group | null>;
  /** Outer group — zoom scale. */
  zoomRef: React.RefObject<Group | null>;
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
 * Drag/zoom/focus controller for the globe.
 *
 * Owns the spin group's rotation directly in refs — no React state per frame
 * (§36). Camera ownership stays with `CameraRig`; this controller only turns
 * the planet and scales the globe group, so the two never fight (§60).
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
  const zoomRef = useRef<Group | null>(null);

  const yaw = useRef(0);
  const pitch = useRef(0.12);
  const velYaw = useRef(0);
  const velPitch = useRef(0);
  const zoom = useRef(1);
  const zoomTarget = useRef(1);
  const dragging = useRef(false);
  const lastPointer = useRef<[number, number]>([0, 0]);
  const pinch = useRef(new Map<number, [number, number]>());
  const pinchDist = useRef(0);
  const lastInteract = useRef(0);
  const focusAnim = useRef<{ yaw: number; pitch: number } | null>(null);
  const autoPaused = useRef(false);
  const reduced = useRef(false);

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
      // Local marker position at rest yaw/pitch, from the canonical mapping.
      const phi = ((90 - target.lat) * Math.PI) / 180;
      const theta = ((target.lon + 180) * Math.PI) / 180;
      const x = -Math.sin(phi) * Math.cos(theta);
      const z = Math.sin(phi) * Math.sin(theta);
      const targetYaw = yaw.current + wrapDelta(Math.atan2(-x, z) - yaw.current);
      const targetPitch = Math.max(
        -MAX_TILT,
        Math.min(MAX_TILT, (target.lat * Math.PI) / 180),
      );
      touch();
      if (reduced.current) {
        yaw.current = targetYaw;
        pitch.current = targetPitch;
        return;
      }
      focusAnim.current = { yaw: targetYaw, pitch: targetPitch };
    },
    [touch],
  );

  const reset = useCallback(() => {
    touch();
    zoomTarget.current = 1;
    if (reduced.current) {
      yaw.current = 0;
      pitch.current = 0.12;
      velYaw.current = 0;
      velPitch.current = 0;
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
          zoomTarget.current = Math.min(MAX_ZOOM, zoomTarget.current * 1.12);
          break;
        case "-":
        case "_":
          touch();
          zoomTarget.current = Math.max(MIN_ZOOM, zoomTarget.current / 1.12);
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

  useFrame((_, rawDelta) => {
    const spin = spinRef.current;
    const zoomGroup = zoomRef.current;
    const delta = Math.min(rawDelta, 0.05);
    const state = useFridayStore.getState().state;

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

    const z = zoom.current + (zoomTarget.current - zoom.current) * Math.min(1, delta * 6);
    zoom.current = z;

    if (spin) spin.rotation.set(pitch.current, yaw.current, 0);
    if (zoomGroup) zoomGroup.scale.setScalar(z);
  });

  const handlers = useMemo<GlobeInteraction["handlers"]>(
    () => ({
      onPointerDown: (e) => {
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
          const dist = Math.hypot(a[0] - b[0], a[1] - b[1]);
          if (pinchDist.current > 0 && dist > 0) {
            zoomTarget.current = Math.max(
              MIN_ZOOM,
              Math.min(MAX_ZOOM, zoomTarget.current * (dist / pinchDist.current)),
            );
          }
          pinchDist.current = dist;
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
        zoomTarget.current = Math.max(
          MIN_ZOOM,
          Math.min(MAX_ZOOM, zoomTarget.current * (1 + e.nativeEvent.deltaY * 0.001)),
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

  return { spinRef, zoomRef, handlers, focusOn, reset };
}
