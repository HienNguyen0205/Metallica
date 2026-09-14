// Reproducible globe texture conversion: JPEG/PNG -> WebP. The committed
// assets are the WebP output; the source JPEG/PNG are NOT kept in the repo
// (they add ~1.5 MB of clone weight for zero runtime use). To regenerate,
// drop the four originals from the upstream source recorded in
// public/assets/globe/ASSETS.md into that folder, then:
//
//   node scripts/globe-webp.mjs [outDir]   # outDir defaults to public/assets/globe
//
// Color imagery (day/night) uses lossy WebP (perceptually indistinguishable,
// large win). The data maps (topology/bump, water/roughness mask) use LOSSLESS
// WebP: they feed lighting/shading directly, and lossy ringing there reads as
// terrain-shading noise and coastline roughness speckle.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const IN = "public/assets/globe";
const outDir = process.argv[2] || IN;

const JOBS = [
  { from: "earth-day.jpg", quality: { quality: 82 } },
  { from: "earth-night.jpg", quality: { quality: 82 } },
  { from: "earth-topology.png", quality: { lossless: true } },
  { from: "earth-water.png", quality: { lossless: true } },
];

fs.mkdirSync(outDir, { recursive: true });
const kb = (n) => Math.round(n / 1024) + "KB";

const missing = JOBS.map(({ from }) => from).filter((from) => !fs.existsSync(path.join(IN, from)));
if (missing.length) {
  console.error(
    `Missing source(s) in ${IN}: ${missing.join(", ")}.\n` +
      "The JPEG/PNG originals are not committed — fetch them from the upstream\n" +
      "URL in public/assets/globe/ASSETS.md, drop them in, then re-run.",
  );
  process.exit(1);
}

for (const { from, quality } of JOBS) {
  const src = path.join(IN, from);
  const to = path.join(outDir, from.replace(/\.\w+$/, "") + ".webp");
  const r = await sharp(src).webp(quality).toFile(to);
  console.log(`${from} ${kb(fs.statSync(src).size)} -> ${path.basename(to)} ${kb(r.size)}`);
}
