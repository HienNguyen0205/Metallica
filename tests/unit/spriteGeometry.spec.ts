import { test, expect } from "@playwright/test";
import { Sprite } from "three";

/**
 * Guards the reason `CoreParticles` disposes its material but not its geometry.
 *
 * `Sprite` keeps one module-level `BufferGeometry` and hands the same instance
 * to every sprite ever constructed. `dispose()` does not clear that module
 * slot, so freeing it once destroys the quad for every particle field on the
 * page permanently — which is what surfaced on WebGPU as `Buffer used in submit
 * while destroyed` when the particle-flow visualization was opened and closed.
 *
 * If three ever gives sprites their own geometry this test fails, and the
 * cleanup in `CoreParticles` should then start disposing it.
 */
test("sprites share one geometry, so a particle field must never dispose it", () => {
  const a = new Sprite();
  const b = new Sprite();

  expect(a.geometry).toBe(b.geometry);
});
