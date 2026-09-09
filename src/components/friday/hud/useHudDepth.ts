"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import { useTelemetry } from "@/lib/telemetry";
import { STATE_CAMERA } from "@/lib/stateLook";

function subscribeReducedMotion(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * §12 — the 2D chrome is a projection in the same space, not a sticker on
 * glass: it parallaxes against camera drift and recedes slightly as the rig
 * pushes toward the core.
 *
 * Passive readouts only. Camera drift never stops, so applying this to the
 * rails left their buttons permanently in motion — unclickable to automation
 * and fiddly for a real cursor.
 *
 * Opacity range is deliberately shallow (0.96–1.0). The HUD text sits at
 * ~5.3:1 contrast and a heavier fade would drop it under WCAG AA.
 */
export function useHudDepth(strength = 14): CSSProperties {
  const t = useTelemetry();
  // Subscribed, not read per render: matchMedia never changes except on the
  // OS setting flipping, and calling it every 4 Hz tick was pure overhead.
  const reduced = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);

  return useMemo(() => {
    const near = STATE_CAMERA.thinking.distance;
    const far = STATE_CAMERA.visualizing.distance;
    const depth = Math.min(1, Math.max(0, (t.camera[2] - near) / (far - near)));

    // prefers-reduced-motion: static chrome, no 4Hz parallax animation.
    if (reduced) return { opacity: 1 };

    return {
      transform: `translate3d(${(-t.camera[0] * strength).toFixed(2)}px, ${(
        -t.camera[1] * strength
      ).toFixed(2)}px, 0)`,
      opacity: 0.96 + depth * 0.04,
      // smooths the 4Hz telemetry sampling into continuous motion
      transition: "transform 280ms linear, opacity 280ms linear",
      willChange: "transform",
    };
  }, [t.camera, reduced, strength]);
}
