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

/** Rendered height of one line, in texture pixels. High enough to stay crisp at dpr 2. */
const FONT_PX = 64;
const PAD = FONT_PX * 0.6;
const FONT = `600 ${FONT_PX}px ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace`;

export interface LabelTexture {
  material: MeshBasicNodeMaterial;
  /** width / height of the drawn area, so the quad can match the text's shape */
  aspect: number;
  dispose: () => void;
}

/**
 * The material is built here rather than in the component because the React
 * Compiler forbids assigning to a property of anything a hook returned, and
 * `material.map` has to be set after the texture exists.
 */
export function createLabelTexture(text: string, color: string, opacity: number): LabelTexture {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;

  ctx.font = FONT;
  ctx.letterSpacing = `${FONT_PX * 0.16}px`;
  const width = Math.max(1, Math.ceil(ctx.measureText(text).width));

  canvas.width = width + PAD * 2;
  canvas.height = FONT_PX + PAD * 2;

  // the context resets when the canvas is resized
  ctx.font = FONT;
  ctx.letterSpacing = `${FONT_PX * 0.16}px`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  ctx.strokeStyle = "#02050a";
  ctx.lineWidth = FONT_PX * 0.18;
  ctx.lineJoin = "round";
  ctx.strokeText(text, PAD, canvas.height / 2);

  ctx.fillStyle = color;
  ctx.fillText(text, PAD, canvas.height / 2);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // no mipmaps: labels are billboarded and roughly screen-sized, and generating
  // them per text change would cost more than it saves
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;

  const material = new MeshBasicNodeMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthWrite: false,
    toneMapped: false,
    side: DoubleSide,
  });

  return {
    material,
    aspect: canvas.width / canvas.height,
    dispose: () => {
      texture.dispose();
      material.dispose();
    },
  };
}
