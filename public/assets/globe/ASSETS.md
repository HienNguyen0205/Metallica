# Globe assets — provenance record (§70 of the globe guide)

Real Earth imagery set (gap analysis P0). All files below are committed to
the repo (~3.0 MB total) so the globe renders offline with no fetch
duplication across visualization switches (§46-47).

| Asset | Source | License | Resolution | Purpose |
|---|---|---|---|---|
| `earth-day.jpg` | three-globe example `earth-blue-marble.jpg` (NASA Blue Marble Next Generation) | Public domain (NASA); MIT (three-globe packager) | 2048×1024 | Day-side albedo |
| `earth-night.jpg` | three-globe example (NASA city lights) | Public domain (NASA); MIT (three-globe packager) | 2048×1024 | Night-side city lights |
| `earth-topology.png` | three-globe example | MIT (three-globe packager) | 1024×512 | Bump relief |
| `earth-water.png` | three-globe example (ocean mask) | MIT (three-globe packager) | 1024×512 | Roughness: ocean glints, land matte |

Upstream URLs (do not hotlink at runtime — vendored above):

- `https://unpkg.com/three-globe@2.41.12/example/img/`

## Fallback

If any asset fails to load, `GlobeEarth.tsx` renders the procedural TSL
fallback surface instead — the globe never breaks on asset failure (§71).
The low quality tier skips `earth-topology` / `earth-water` (fewer samplers)
but keeps day/night imagery.

## Removed

- Cloud layer (procedural + `earth-clouds.png`) removed per operator request —
  the surface stays unobstructed.
