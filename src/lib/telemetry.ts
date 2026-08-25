"use client";

import { useEffect, useState } from "react";

/**
 * Real numbers for the HUD. Static readouts make the interface read as a
 * poster; these are measured from the running page instead.
 *
 * A single rAF loop keeps counters, and consumers sample them at a few Hz —
 * sampling into React state every frame would cost more than the scene.
 */
export interface Telemetry {
  /** measured render loop rate */
  fps: number;
  /** longest frame in the last sample window, ms */
  frameMs: number;
  /** JS heap in use, MB (Chromium only — 0 elsewhere) */
  heapMB: number;
  /** heap in use as a fraction of the heap limit, 0..1 */
  heapRatio: number;
  /** downlink estimate in Mb/s where the browser exposes it */
  downlink: number;
  /** camera position, written by the scene's camera rig */
  camera: [number, number, number];
}

interface HeapMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}

const state: Telemetry = {
  fps: 0,
  frameMs: 0,
  heapMB: 0,
  heapRatio: 0,
  downlink: 0,
  camera: [0, 0, 6.8],
};

let frames = 0;
let worstFrame = 0;
let windowStart = 0;
let last = 0;
let running = false;

function loop(now: number) {
  if (last) worstFrame = Math.max(worstFrame, now - last);
  last = now;
  frames++;

  if (now - windowStart >= 500) {
    state.fps = (frames * 1000) / (now - windowStart);
    state.frameMs = worstFrame;
    frames = 0;
    worstFrame = 0;
    windowStart = now;

    const mem = (performance as Performance & { memory?: HeapMemory }).memory;
    if (mem) {
      state.heapMB = mem.usedJSHeapSize / 1048576;
      // against the *allocated* heap, not the hard limit — the limit is so
      // large that the ratio would read 1% forever and the gauge would look
      // broken rather than idle
      state.heapRatio = mem.usedJSHeapSize / Math.max(1, mem.totalJSHeapSize);
    }
    const conn = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
    state.downlink = conn?.downlink ?? 0;
  }
  requestAnimationFrame(loop);
}

function start() {
  if (running || typeof window === "undefined") return;
  running = true;
  windowStart = performance.now();
  requestAnimationFrame(loop);
}

/** Called from the scene's camera rig; a plain write, no React involved. */
export function reportCamera(x: number, y: number, z: number) {
  state.camera[0] = x;
  state.camera[1] = y;
  state.camera[2] = z;
}

export function readTelemetry(): Telemetry {
  return state;
}

/** Samples the counters into React state at `hz` (default 4). */
export function useTelemetry(hz = 4): Telemetry {
  const [snapshot, setSnapshot] = useState<Telemetry>(() => ({ ...state }));

  useEffect(() => {
    start();
    const id = setInterval(
      () => setSnapshot({ ...state, camera: [...state.camera] as [number, number, number] }),
      1000 / hz,
    );
    return () => clearInterval(id);
  }, [hz]);

  return snapshot;
}
