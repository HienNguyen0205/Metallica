import { CanvasTexture, DoubleSide, LinearFilter, SRGBColorSpace } from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";

/**
 * Builds a label texture on a 2D canvas.
 *
 * drei's `<Text>` cannot come along to the node renderer: troika derives its
 * material by splicing strings into GLSL, which a `NodeMaterial` never runs, so
 * every label rendered as an opaque white quad. Canvas text is the lazy
 * replacement and costs nothing here — these labels are short, uppercase and
 * billboarded, and at their on-screen size a bitmap is indistinguishable from
 * an SDF glyph.
 *
 * The dark stroke is the old `outlineWidth`: every label sits over bloom,
 * particles and grid, and without a thin cut of the background behind the
 * glyphs thin type dissolves into whatever glows behind it.
 */

/**
 * A label is allocated once and then **redrawn in place**.
 *
 * The first version rebuilt canvas, texture and material whenever the text
 * changed. Telemetry labels change at 4 Hz, so that freed and reallocated GPU
 * resources four times a second, for as long as the page was open — which on
 * WebGPU surfaces as `Buffer used in submit while destroyed`: the texture is
 * released while the frame that referenced it is still queued. Redrawing into
 * the same canvas allocates nothing after mount.
 *
 * The font is monospace, so a label's width is exactly its character count.
 * Sizing the canvas from that count keeps the quad's aspect fixed for as long
 * as the count holds, which for a readout like `MEMORY · 42MB · 88%` is
 * effectively always.
 */

/** Rendered height of one line, in texture pixels. High enough to stay crisp at dpr 2. */
const FONT_PX = 64;
const PAD = FONT_PX * 0.6;
const FONT = `600 ${FONT_PX}px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace`;

export interface LabelTexture {
  material: MeshBasicNodeMaterial;
  /** width / height of the drawn area, so the quad can match the text's shape */
  aspect: number;
  /** Redraws the glyphs in place. Allocates nothing. */
  draw: (text: string, color: string, opacity: number) => void;
  dispose: () => void;
}

/**
 * The material is built here rather than in the component because the React
 * Compiler forbids assigning to a property of anything a hook returned, and
 * both `material.map` and the redraw need to happen outside render.
 *
 * `capacity` is a character count, not a string: two labels of the same length
 * share a canvas size, so a readout whose value changes but whose width does
 * not never reallocates.
 */
export function createLabelTexture(capacity: number): LabelTexture {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  const measure = () => {
    ctx.font = FONT;
    ctx.letterSpacing = `${FONT_PX * 0.16}px`;
  };

  measure();
  // monospace: one glyph advance times the capacity is the exact width
  const width = Math.max(1, Math.ceil(ctx.measureText("M".repeat(capacity)).width));
  canvas.width = width + PAD * 2;
  canvas.height = FONT_PX + PAD * 2;

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // no mipmaps: labels are billboarded and roughly screen-sized, and generating
  // them per redraw would cost more than it saves
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const material = new MeshBasicNodeMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
  });

  return {
    material,
    aspect: canvas.width / canvas.height,

    draw(text, color, opacity) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // the context keeps its state across clears, but not across resizes
      measure();
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";

      // The dark stroke is the old `outlineWidth`: every label sits over bloom,
      // particles and rings, and without a thin cut of the background behind
      // the glyphs thin type dissolves into whatever glows behind it.
      ctx.strokeStyle = "#02050a";
      ctx.lineWidth = FONT_PX * 0.18;
      ctx.lineJoin = "round";
      ctx.strokeText(text, PAD, canvas.height / 2);

      ctx.fillStyle = color;
      ctx.fillText(text, PAD, canvas.height / 2);

      texture.needsUpdate = true;
      material.opacity = opacity;
    },

    dispose: () => {
      texture.dispose();
      material.dispose();
    },
  };
}
