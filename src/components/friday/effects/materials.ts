import { shaderMaterial } from "@react-three/drei";
import { extend } from "@react-three/fiber";
import { Color, type Blending, type ColorRepresentation, type Side } from "three";

/**
 * §14 — hologram surface: fresnel edge glow + travelling scanlines + noise
 * flicker. Thin, transparent, emissive; never a solid shaded object.
 */
export const HologramMaterial = shaderMaterial(
  {
    uTime: 0,
    uColor: new Color("#38e8ff"),
    uOpacity: 0.85,
    uFresnelPower: 2.2,
    uScanSpeed: 0.6,
    uScanDensity: 22,
    uFlicker: 0.06,
  },
  /* glsl */ `
    varying vec3 vNormal;
    varying vec3 vViewDir;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vNormal = normalize(normalMatrix * normal);
      vViewDir = normalize(-mvPosition.xyz);
      gl_Position = projectionMatrix * mvPosition;
    }
  `,
  /* glsl */ `
    uniform float uTime;
    uniform vec3 uColor;
    uniform float uOpacity;
    uniform float uFresnelPower;
    uniform float uScanSpeed;
    uniform float uScanDensity;
    uniform float uFlicker;
    varying vec3 vNormal;
    varying vec3 vViewDir;
    varying vec2 vUv;

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
    }

    void main() {
      float fresnel = pow(1.0 - clamp(dot(vNormal, vViewDir), 0.0, 1.0), uFresnelPower);
      float scan = sin((vUv.y * uScanDensity) - uTime * uScanSpeed) * 0.5 + 0.5;
      float flicker = 1.0 - uFlicker + uFlicker * hash(vec2(floor(uTime * 20.0), 1.0));
      float alpha = clamp(fresnel * 0.85 + scan * 0.15, 0.0, 1.0) * uOpacity * flicker;
      gl_FragColor = vec4(uColor, alpha);
    }
  `,
);

/**
 * §3 — background dotted grid with a radial fade and an outward ripple.
 * One plane, one draw call, instead of thousands of dot meshes.
 */
export const HoloGridMaterial = shaderMaterial(
  { uTime: 0, uColor: new Color("#38e8ff"), uSpacing: 34, uOpacity: 0.5 },
  /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  /* glsl */ `
    uniform float uTime;
    uniform vec3 uColor;
    uniform float uSpacing;
    uniform float uOpacity;
    varying vec2 vUv;
    void main() {
      vec2 cell = fract(vUv * uSpacing) - 0.5;
      float dot_ = smoothstep(0.14, 0.0, length(cell));
      float r = length(vUv - 0.5);
      float fade = 1.0 - smoothstep(0.1, 0.5, r);
      float ripple = 0.7 + 0.3 * sin(uTime * 0.6 - r * 26.0);
      gl_FragColor = vec4(uColor, dot_ * fade * ripple * uOpacity);
    }
  `,
);

/**
 * §20 — GPU particle field. All motion happens in the vertex shader from
 * per-particle attributes, so thousands of particles cost one draw call and
 * zero React components.
 * uMode 0 = orbit around the core, 1 = outward flow.
 */
export const HoloParticleMaterial = shaderMaterial(
  {
    uTime: 0,
    uColor: new Color("#38e8ff"),
    uIntensity: 1,
    uPixelRatio: 1,
    uMode: 0,
    uSpan: 3.4,
  },
  /* glsl */ `
    attribute float aRadius;
    attribute float aAngle;
    attribute float aSpeed;
    attribute float aTilt;
    attribute float aY;
    attribute float aSize;
    uniform float uTime;
    uniform float uIntensity;
    uniform float uPixelRatio;
    uniform float uMode;
    uniform float uSpan;
    varying float vAlpha;

    void main() {
      float radius = aRadius;
      float fadeEnds = 1.0;
      if (uMode > 0.5) {
        float travel = mod(aRadius + uTime * aSpeed * 0.55 * uIntensity, uSpan);
        radius = 0.7 + travel;
        fadeEnds = smoothstep(0.0, 0.6, travel) * (1.0 - smoothstep(uSpan - 0.9, uSpan, travel));
      }
      float angle = aAngle + uTime * aSpeed * uIntensity * (uMode > 0.5 ? 0.15 : 1.0);
      vec3 p = vec3(cos(angle) * radius, 0.0, sin(angle) * radius);
      float ct = cos(aTilt);
      float st = sin(aTilt);
      p = vec3(p.x, p.y * ct - p.z * st, p.y * st + p.z * ct);
      p.y += aY + sin(uTime * 0.6 + aAngle * 3.0) * 0.05;

      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = aSize * uPixelRatio * (55.0 / max(-mv.z, 0.001));
      vAlpha = clamp(0.18 + uIntensity * 0.32, 0.0, 0.9) * fadeEnds;
    }
  `,
  /* glsl */ `
    uniform vec3 uColor;
    varying float vAlpha;
    void main() {
      float d = length(gl_PointCoord - 0.5);
      if (d > 0.5) discard;
      gl_FragColor = vec4(uColor, smoothstep(0.5, 0.0, d) * vAlpha);
    }
  `,
);

extend({ HologramMaterial, HoloGridMaterial, HoloParticleMaterial });

interface BaseMatProps {
  ref?: React.Ref<unknown>;
  uTime?: number;
  uColor?: ColorRepresentation;
  uOpacity?: number;
  transparent?: boolean;
  depthWrite?: boolean;
  depthTest?: boolean;
  side?: Side;
  blending?: Blending;
  wireframe?: boolean;
  toneMapped?: boolean;
}

declare module "@react-three/fiber" {
  interface ThreeElements {
    hologramMaterial: BaseMatProps & {
      uFresnelPower?: number;
      uScanSpeed?: number;
      uScanDensity?: number;
      uFlicker?: number;
    };
    holoGridMaterial: BaseMatProps & { uSpacing?: number };
    holoParticleMaterial: BaseMatProps & {
      uIntensity?: number;
      uPixelRatio?: number;
      uMode?: number;
      uSpan?: number;
    };
  }
}
