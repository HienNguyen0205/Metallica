"use client";

import { useEffect, useRef, useState } from "react";
import type { ThreeEvent } from "@react-three/fiber";

/**
 * Click-vs-drag slop, in CSS pixels. The camera orbits under every viz, and a
 * drag that ends over a pick target lands as a click on it — past this much
 * travel it was a drag, not a pick.
 */
export const CLICK_SLOP_PX = 6;

/** No recorded press (keyboard, synthetic click) is accepted as a click. */
export function isClick(down: readonly [number, number] | null, x: number, y: number): boolean {
  return !down || Math.hypot(x - down[0], y - down[1]) <= CLICK_SLOP_PX;
}

/** Record the press; `accept` answers whether the matching click was a pick. */
export function useClickGate() {
  const downAt = useRef<[number, number] | null>(null);
  return {
    record(e: ThreeEvent<PointerEvent>) {
      downAt.current = [e.nativeEvent.clientX, e.nativeEvent.clientY];
    },
    accept(e: ThreeEvent<MouseEvent>) {
      const ok = isClick(downAt.current, e.nativeEvent.clientX, e.nativeEvent.clientY);
      downAt.current = null;
      return ok;
    },
  };
}

/**
 * Pointer cursor while `active`, derived from state rather than set in the
 * pointer handlers: a target unmounted mid-hover (new spec, ESC clearing the
 * scene) never gets its pointerout, and the cursor used to stay a hand.
 */
export function useHoverCursor(active: boolean) {
  useEffect(() => {
    if (!active) return;
    document.body.style.cursor = "pointer";
    return () => {
      document.body.style.cursor = "auto";
    };
  }, [active]);
}

/** Hover state + drag-gated click for one invisible pick mesh: `<mesh {...bind}>`. */
export function usePick(onSelect: () => void) {
  const [hovered, setHovered] = useState(false);
  const gate = useClickGate();
  useHoverCursor(hovered);
  return {
    hovered,
    bind: {
      onPointerOver(e: ThreeEvent<PointerEvent>) {
        e.stopPropagation();
        setHovered(true);
      },
      onPointerOut() {
        setHovered(false);
      },
      onPointerDown(e: ThreeEvent<PointerEvent>) {
        e.stopPropagation();
        gate.record(e);
      },
      onClick(e: ThreeEvent<MouseEvent>) {
        e.stopPropagation();
        if (gate.accept(e)) onSelect();
      },
    },
  };
}
