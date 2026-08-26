/**
 * The orbital particle field, shared by the WebGL (GLSL) and WebGPU (TSL)
 * paths so both backends render an identical-looking cloud.
 */

/** Deterministic pseudo-random in [0,1) — stable across renders and SSR. */
export function noise(i: number, seed: number) {
  const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

export interface ParticleField {
  position: Float32Array;
  aRadius: Float32Array;
  aAngle: Float32Array;
  aSpeed: Float32Array;
  aTilt: Float32Array;
  aY: Float32Array;
  aSize: Float32Array;
}

export function buildParticleField(
  count: number,
  innerRadius: number,
  span: number,
): ParticleField {
  const position = new Float32Array(count * 3);
  const aRadius = new Float32Array(count);
  const aAngle = new Float32Array(count);
  const aSpeed = new Float32Array(count);
  const aTilt = new Float32Array(count);
  const aY = new Float32Array(count);
  const aSize = new Float32Array(count);

  for (let i = 0; i < count; i++) {
    aRadius[i] = innerRadius + noise(i, 1) * span;
    aAngle[i] = noise(i, 2) * Math.PI * 2;
    aSpeed[i] = 0.06 + noise(i, 3) * 0.22;
    aTilt[i] = (noise(i, 4) - 0.5) * 1.5;
    aY[i] = (noise(i, 5) - 0.5) * 1.1;
    // skewed: mostly fine dust, a few bright motes — a uniform spread
    // makes the field look like static rather than structured data
    aSize[i] = 0.4 + Math.pow(noise(i, 6), 2.4) * 1.7;
  }

  return { position, aRadius, aAngle, aSpeed, aTilt, aY, aSize };
}
