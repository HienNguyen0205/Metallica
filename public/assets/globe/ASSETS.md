# Globe assets — provenance record (§70 of the globe guide)

The realistic Earth is **fully procedural**: continents, clouds, night-side
city speckle and the atmospheric rim are generated at render time by TSL
noise nodes (`src/components/friday/visualization/globe/GlobeEarth.tsx`).
There are deliberately **no binary texture assets** in this directory.

| Asset            | Source              | License | Resolution | Purpose              |
|------------------|---------------------|---------|------------|----------------------|
| (none — procedural) | TSL `mx_noise_float` fields in `GlobeEarth.tsx` | N/A (code, repo license) | N/A (resolution-independent) | Earth surface continents/detail |
| (none — procedural) | TSL noise shell in `GlobeEarth.tsx` | N/A | N/A | Cloud layer alpha |
| (none — procedural) | High-frequency TSL speckle × land mask | N/A | N/A | Night-side city lights |
| (none — procedural) | `latLonToVector3` + Markov-free GeoPoint data | N/A | N/A | Marker/arc placement |

## Why procedural instead of texture maps

1. **License safety** — no third-party Earth imagery to attribute or clear
   (§45.2, §45.7 of the guide).
2. **Palette control** — texture maps are photorealistic blue/green and fight
   the black-space + cyan/teal Metallica identity; the procedural surface is
   authored in-palette (§48).
3. **Zero async loading** — no `INITIALIZING SURFACE` waterfall, no LFS, no
   fetch duplication across GLOBE → BAR → GLOBE switches (§46-47).
4. **Both backends from one source** — TSL compiles to WGSL on WebGPU and
   GLSL on the WebGL2 fallback (§38).

## If real textures are ever wanted

Drop them here as `earth-color.webp` (≤2048), `earth-night.webp`,
`earth-clouds.webp` (≤1024), record source/license/resolution in the table
above, and gate every layer behind a load-failure fallback that keeps the
procedural surface (§71).
