// MapLibre 6 finds its worker at `./maplibre-gl-worker.mjs` next to its own
// module (import.meta.url). Under `next dev` that module is a Turbopack chunk
// in /_next/static/chunks, where no worker is served: the request 404s, the
// map never loads a style, and every map hands back to the globe. So the map
// points setWorkerUrl at public/maplibre/, filled here with the worker and the
// shared chunk it imports. Copied before dev and build, never committed, so it
// always matches the installed maplibre-gl.
import { copyFileSync, mkdirSync } from "node:fs";

const from = "node_modules/maplibre-gl/dist";
const to = "public/maplibre";
mkdirSync(to, { recursive: true });
for (const file of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) copyFileSync(`${from}/${file}`, `${to}/${file}`);
