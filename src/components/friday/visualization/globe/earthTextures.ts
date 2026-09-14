"use client";

import { useEffect, useState } from "react";
import { SRGBColorSpace, TextureLoader, type Texture } from "three";

export interface EarthTextureSet {
  day: Texture;
  night: Texture;
  /** Relief detail — absent on the low tier. */
  topology?: Texture;
  /** Ocean mask — absent on the low tier. */
  water?: Texture;
}

const FILES = {
  day: "/assets/globe/earth-day.webp",
  night: "/assets/globe/earth-night.webp",
  topology: "/assets/globe/earth-topology.webp",
  water: "/assets/globe/earth-water.webp",
} as const;

// Module-level cache: GLOBE → BAR → GLOBE remounts reuse GPU uploads instead
// of refetching. Shared textures are never disposed by individual mounts —
// max 4 entries, memory-stable by construction.
const textureCache = new Map<string, Texture>();
const inflight = new Map<string, Promise<Texture>>();

function loadUncached(url: string, srgb: boolean, anisotropy: number): Promise<Texture> {
  return new Promise((resolve, reject) => {
    new TextureLoader().load(
      url,
      (texture) => {
        if (srgb) texture.colorSpace = SRGBColorSpace;
        texture.anisotropy = anisotropy;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

function cachedLoad(key: string, url: string, srgb: boolean, anisotropy: number): Promise<Texture> {
  const hit = textureCache.get(key);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = loadUncached(url, srgb, anisotropy).then(
    (t) => {
      textureCache.set(key, t);
      inflight.delete(key);
      return t;
    },
    (e) => {
      inflight.delete(key);
      throw e;
    },
  );
  inflight.set(key, p);
  return p;
}

/**
 * Real Earth imagery set (see public/assets/globe/ASSETS.md).
 *
 * Loads once per process (module cache) without suspending the scene: while
 * the textures are in flight the caller renders the procedural fallback,
 * then swaps to the textured surface. Layers degrade independently — a
 * missing topology/water still renders day/night; only a missing day falls
 * back to fully procedural (§71 of the globe guide).
 */
export function useEarthTextures(detail: boolean, maxAnisotropy = 4): EarthTextureSet | null {
  const [set, setSet] = useState<EarthTextureSet | null>(null);
  // Cap at 8: the perceptual gain from 16x near the limb is negligible while
  // it multiplies texture sampling memory, and every GPU here supports ≥8.
  const anisotropy = Math.min(8, Math.max(1, Math.floor(maxAnisotropy) || 1));

  useEffect(() => {
    let live = true;
    // Day/night always load — they carry the realism. Topology and water
    // are relief/specular detail, skipped on the low tier (fewer samplers,
    // less ALU).
    const want: Array<[keyof EarthTextureSet, boolean]> = [
      ["day", true],
      ["night", true],
      ...(detail
        ? [["topology", false], ["water", false]] as Array<[keyof EarthTextureSet, boolean]>
        : []),
    ];
    // Shared cache makes remounts cheap: cached entries resolve
    // synchronously through the settled path below — no fetch, no flash.
    Promise.allSettled(want.map(([key, srgb]) => cachedLoad(key, FILES[key], srgb, anisotropy))).then(
      (results) => {
        if (!live) return;
        const byKey = new Map<string, Texture>();
        want.forEach(([key], i) => {
          const r = results[i];
          if (r && r.status === "fulfilled") byKey.set(key, r.value);
        });
        // Day is required — without albedo there is no textured surface.
        const day = byKey.get("day");
        if (!day) {
          // Stay procedural — logged once, not per frame.
          if (process.env.NODE_ENV !== "production") {
            console.warn("[friday] globe textures failed to load; using procedural surface");
          }
          return;
        }
        const next: EarthTextureSet = { day, night: byKey.get("night") ?? day };
        const topo = byKey.get("topology");
        const water = byKey.get("water");
        if (topo) next.topology = topo;
        if (water) next.water = water;
        setSet(next);
      },
    );
    return () => {
      live = false;
      // Shared cache owns the GPU uploads — mounts must not dispose them.
      // Clearing local state is unnecessary (unmount discards it); on
      // `detail` change the next effect sets the tier-appropriate set.
    };
  }, [detail, anisotropy]);

  return set;
}
