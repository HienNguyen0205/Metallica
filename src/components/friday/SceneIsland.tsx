"use client";

import dynamic from "next/dynamic";

/**
 * Client island for the 3D scene. `next/dynamic` with `ssr: false` is not
 * allowed in a Server Component, so the no-SSR boundary lives here while
 * `page.tsx` stays a server-rendered shell around it.
 */
const Scene = dynamic(() => import("@/components/friday/Scene"), { ssr: false });

export default function SceneIsland() {
  return <Scene />;
}
