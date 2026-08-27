import { AdditiveBlending, Color, DoubleSide, InstancedBufferAttribute, Sprite } from "three";
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, PointsNodeMaterial } from "three/webgpu";
import {
  float,
  fract,
  instancedBufferAttribute,
  mx_noise_float,
  normalLocal,
  normalView,
  positionLocal,
  positionView,
  positionViewDirection,
  smoothstep,
  time,
  uniform,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { buildParticleField } from "../core/particleField";

/**
 * All three materials are TSL node materials rather than GLSL `ShaderMaterial`s.
 *
 * That is the whole point of the WebGPU-first move: TSL compiles to WGSL on the
 * WebGPU backend and to GLSL on the WebGL2 fallback, so one implementation
 * serves both. The previous split — GLSL here, a hand-written node twin over in
 * CoreParticlesGPU, and `compat ?` branches at every call site — meant the
 * WebGPU path shared almost no code with the path the tests actually exercised.
 * That is precisely why it shipped broken.
 *
 * `time` is not a uniform here: TSL exposes elapsed time as a built-in node, so
 * nothing has to pump `uTime` from a frame loop any more.
 */

/*
 * Each factory returns setter functions rather than the raw uniform objects.
 * Callers write these every frame, and the React Compiler's immutability rule
 * rejects assigning to a property of anything a hook returned — a uniform write
 * is not React state, but the rule cannot tell. Keeping the assignment inside
 * this module sidesteps that honestly, and gives call sites a smaller surface.
 */

/**
 * Materials are built once and then re-tinted by mutating `uColor`, because the
 * state colour changes on every FRIDAY transition and rebuilding a node
 * material recompiles its shader. Callers push the live colour in from their
 * frame loop, so this initial value is only ever on screen for frame zero.
 */
const INITIAL_COLOR = "#38e8ff";

/**
 * §14 — hologram surface: fresnel edge glow + travelling scanlines + noise
 * flicker. Thin, transparent, emissive; never a solid shaded object.
 */
export function createHologramMaterial({
  opacity = 0.85,
  fresnelPower = 2.2,
  scanDensity = 22,
  flickerAmount = 0.06,
  wireframe = false,
}: {
  opacity?: number;
  fresnelPower?: number;
  scanDensity?: number;
  flickerAmount?: number;
  wireframe?: boolean;
}) {
  const uColor = uniform(new Color(INITIAL_COLOR));
  // scan speed rides along with the state look, so it is a uniform too
  const uScanSpeed = uniform(0.6);
  const elapsed = time;

  const facing = normalView.dot(positionViewDirection).clamp(0, 1);
  const fresnel = float(1).sub(facing).pow(fresnelPower);
  const scan = uv().y.mul(scanDensity).sub(elapsed.mul(uScanSpeed)).sin().mul(0.5).add(0.5);
  // pseudo-random value stepping ~20x/second — the flicker of a bad projector
  const hash = fract(elapsed.mul(20).floor().mul(41.3).sin().mul(43758.5453));
  const flicker = float(1 - flickerAmount).add(hash.mul(flickerAmount));

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    wireframe,
  });
  material.colorNode = uColor;
  material.opacityNode = fresnel.mul(0.85).add(scan.mul(0.15)).clamp(0, 1).mul(opacity).mul(flicker);

  return {
    material,
    apply(color: string, scan: number) {
      uColor.value.set(color);
      uScanSpeed.value = scan;
    },
  };
}

/**
 * §3 — background dotted grid with a radial fade and an outward ripple.
 * One plane, one draw call, instead of thousands of dot meshes.
 */
export function createHoloGridMaterial({
  opacity = 0.5,
  spacing = 34,
}: {
  opacity?: number;
  spacing?: number;
}) {
  const uColor = uniform(new Color(INITIAL_COLOR));
  const elapsed = time;

  const cell = fract(uv().mul(spacing)).sub(vec2(0.5, 0.5));
  const dot = smoothstep(0.14, 0, cell.length());
  const r = uv().sub(vec2(0.5, 0.5)).length();
  const fade = float(1).sub(smoothstep(0.1, 0.5, r));
  const ripple = elapsed.mul(0.6).sub(r.mul(26)).sin().mul(0.3).add(0.7);

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
  });
  material.colorNode = uColor;
  material.opacityNode = dot.mul(fade).mul(ripple).mul(opacity);

  return {
    material,
    apply(color: string) {
      uColor.value.set(color);
    },
  };
}

/**
 * §20 — the particle field, as an instanced sprite driven entirely by node
 * maths. This is the pattern three documents for sized points on the node
 * renderer: WebGPU rasterises only 1px point primitives, so `PointsNodeMaterial`
 * expects a `Sprite` whose positions come from instanced attributes.
 *
 * `sizeNode` + `sizeAttenuation` reproduce the old vertex shader's
 * `aSize * pixelRatio * (34 / depth)` — including the device-pixel-ratio scale —
 * so this no longer needs a `uPixelRatio` uniform fed from the frame loop.
 *
 * uMode 0 = orbit around the core, 1 = outward flow.
 */
export function createParticleField({
  count,
  mode = "orbit",
  innerRadius = 1.1,
  span = 2.6,
}: {
  count: number;
  mode?: "orbit" | "flow";
  innerRadius?: number;
  span?: number;
}) {
  const field = buildParticleField(count, innerRadius, span);
  // instancedBufferAttribute is typed Node<unknown> even though it yields a
  // float node here; the cast keeps the TSL chain below properly typed.
  const attr = (data: Float32Array) =>
    float(instancedBufferAttribute(new InstancedBufferAttribute(data, 1)) as never);

  const aRadius = attr(field.aRadius);
  const aAngle = attr(field.aAngle);
  const aSpeed = attr(field.aSpeed);
  const aTilt = attr(field.aTilt);
  const aY = attr(field.aY);
  const aSize = attr(field.aSize);

  const uColor = uniform(new Color(INITIAL_COLOR));
  const uIntensity = uniform(1);
  const elapsed = time;

  // flow mode marches particles outward and fades them at both ends of the run
  const travel = aRadius.add(elapsed.mul(aSpeed).mul(0.55).mul(uIntensity)).mod(span);
  const flowing = mode === "flow";
  const radius = flowing ? float(0.7).add(travel) : aRadius;
  const fadeEnds = flowing
    ? smoothstep(0, 0.6, travel).mul(float(1).sub(smoothstep(span - 0.9, span, travel)))
    : float(1);

  const angle = aAngle.add(elapsed.mul(aSpeed).mul(uIntensity).mul(flowing ? 0.15 : 1));
  const flat = vec3(angle.cos().mul(radius), float(0), angle.sin().mul(radius));
  // tilt the orbital plane about X
  const ct = aTilt.cos();
  const st = aTilt.sin();
  const y = flat.y.mul(ct).sub(flat.z.mul(st)).add(aY).add(elapsed.mul(0.6).add(aAngle.mul(3)).sin().mul(0.05));

  const material = new PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    toneMapped: false,
  });
  material.positionNode = vec3(flat.x, y, flat.y.mul(st).add(flat.z.mul(ct)));
  // Capped: an uncapped 1/z blows near particles up into bokeh discs, which
  // reads as falling snow rather than instrumentation.
  material.sizeNode = aSize.mul(0.026).clamp(0.004, 0.05);
  material.sizeAttenuation = true;
  material.colorNode = uColor;

  // hard core + thin halo — a mote with an edge, not a soft blob
  const d = uv().sub(vec2(0.5, 0.5)).length();
  const core = float(1).sub(smoothstep(0, 0.22, d));
  const halo = float(1).sub(smoothstep(0.18, 0.5, d)).mul(0.35);
  // depth grading — far motes recede rather than sitting at one brightness,
  // which is what gives the field readable volume
  const depth = positionView.z.negate();
  const far = float(1).sub(smoothstep(7, 13.5, depth));
  // the brightest motes stay crisp; the dim dust stays soft
  const crisp = smoothstep(0.7, 1.6, aSize);
  const alpha = float(0.16).add(uIntensity.mul(0.3)).clamp(0, 0.85).mul(fadeEnds).mul(float(0.25).add(far.mul(0.75)));
  material.opacityNode = core.add(halo).clamp(0, 1).mul(alpha).mul(float(0.7).add(crisp.mul(0.6)));

  const sprite = new Sprite(material);
  sprite.count = count;
  // positions are computed on the GPU, so the CPU-side bounds are meaningless
  sprite.frustumCulled = false;

  return {
    sprite,
    apply(color: string, intensity: number) {
      uColor.value.set(color);
      uIntensity.value = intensity;
    },
  };
}

/**
 * §2 layer 1 — the energy core's living surface.
 *
 * Replaces drei's `MeshDistortMaterial`, which injects GLSL through
 * `onBeforeCompile` and therefore cannot exist on a node renderer. Same idea:
 * push each vertex along its normal by a noise field that drifts over time.
 */
export function createCoreMaterial() {
  const uColor = uniform(new Color(INITIAL_COLOR));
  const uGlow = uniform(1);
  const uDistort = uniform(0.35);
  const uSpeed = uniform(1.4);

  const material = new MeshStandardNodeMaterial({ roughness: 0.2, metalness: 0.4 });
  const noise = mx_noise_float(vec3(positionLocal.mul(2.4).add(time.mul(uSpeed))));
  material.positionNode = positionLocal.add(normalLocal.mul(noise.mul(uDistort).mul(0.25)));
  material.colorNode = uColor;
  material.emissiveNode = uColor.mul(uGlow);

  return {
    material,
    apply(color: string, glow: number, distort: number, speed: number) {
      uColor.value.set(color);
      uGlow.value = glow;
      uDistort.value = distort;
      uSpeed.value = speed;
    },
  };
}
