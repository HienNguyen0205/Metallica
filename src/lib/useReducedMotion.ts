"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function get(): boolean {
  return window.matchMedia(QUERY).matches;
}

/**
 * Live `prefers-reduced-motion`. Subscribed rather than read once: a one-shot
 * read (useMemo / per render) missed the OS setting flipping mid-session.
 * The server snapshot is `false`, so SSR and first paint agree.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, get, () => false);
}
