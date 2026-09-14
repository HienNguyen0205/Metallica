# Globe assets — provenance record (§70 of the globe guide)

Real Earth imagery set (gap analysis P0), committed to the repo so the globe
renders offline. Stored as **WebP** (~1.4 MB total, down from ~2.9 MB in the
original JPEG/PNG) — the loader reads them through the browser's image
decoder (`THREE.TextureLoader`), which supports WebP on every target backend.

| Asset (committed) | Derived from | License | Resolution | Encoding | Purpose |
|---|---|---|---|---|---|
| `earth-day.webp` | `earth-day.jpg` (NASA Blue Marble NG via three-globe) | Public domain (NASA); MIT (three-globe packager) | 2048×1024 | lossy q82 (687 KB) | Day-side albedo |
| `earth-night.webp` | `earth-night.jpg` (NASA city lights) | Public domain (NASA); MIT (three-globe packager) | 2048×1024 | lossy q82 (308 KB) | Night-side city lights |
| `earth-topology.webp` | `earth-topology.png` | MIT (three-globe packager) | 1024×512 | **lossless** (284 KB) | Bump relief |
| `earth-water.webp` | `earth-water.png` | MIT (three-globe packager) | 1024×512 | **lossless** (160 KB) | Roughness: ocean glints, land matte |

## Why lossy for photos, lossless for the maps

`day`/`night` are color imagery viewed directly — lossy WebP at q82 is
perceptually indistinguishable and halves their weight. `topology` (bump) and
`water` (roughness mask) are **data maps** fed straight into the shading math;
lossy ringing there reads as terrain-shading noise and coastline roughness
speckle, so they stay lossless (still smaller than the PNGs).

## Regenerating

The source JPEG/PNG are **not** kept in the repo (clone weight for zero
runtime use). Fetch the four originals from upstream, drop them into this
folder, then run the recorded conversion:

```
node scripts/globe-webp.mjs   # reads .jpg/.png here, writes .webp here
```

Upstream (do not hotlink at runtime — vendored + transcoded above):

- `https://unpkg.com/three-globe@2.41.12/example/img/`

## Sampling

Textures load once into a module-level cache (GLOBE → BAR → GLOBE remounts
reuse the GPU upload). `texture.anisotropy` is set from the live renderer's
`getMaxAnisotropy()`, capped at 8 — sharper near the limb without exceeding
each GPU's real ceiling.

## Fallback

If any asset fails to load, `GlobeEarth.tsx` renders the procedural TSL
fallback surface instead — the globe never breaks on asset failure (§71).
The low quality tier skips `earth-topology` / `earth-water` (fewer samplers)
but keeps day/night imagery.

## Removed

- Cloud layer (procedural + `earth-clouds.png`) removed per operator request —
  the surface stays unobstructed.
