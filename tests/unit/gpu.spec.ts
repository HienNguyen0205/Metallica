import { test, expect } from "@playwright/test";
import {
  isFallbackAdapterCached,
  isSoftwareRenderer,
  isSoftwareRendererName,
  setFallbackAdapterCached,
} from "@/lib/gpu";

test("classifies SwiftShader and llvmpipe as software", () => {
  expect(isSoftwareRendererName("SwiftShader")).toBe(true);
  expect(isSoftwareRendererName("llvmpipe (LLVM 15.0.4, 256 bits)")).toBe(true);
  expect(isSoftwareRendererName("software webgl")).toBe(true);
});

test("classifies ANGLE Google Vulkan (SwiftShader on CI) as software", () => {
  expect(isSoftwareRendererName("ANGLE (Google, Vulkan SwiftShader (NVIDIA GeForce)?)")).toBe(true);
  expect(isSoftwareRendererName("ANGLE (Google, Vulkan)")).toBe(true);
});

test("classifies 'Basic Render' as software (gpu.ts behaviour, shared with UI tests)", () => {
  expect(isSoftwareRendererName("Basic Render")).toBe(true);
});

test("keeps real GPUs out of the software bucket", () => {
  expect(isSoftwareRendererName("NVIDIA GeForce RTX 4090/PCIe/SSE2")).toBe(false);
  expect(isSoftwareRendererName("Apple M2 Pro")).toBe(false);
  expect(isSoftwareRendererName("AMD Radeon Pro W6800")).toBe(false);
  expect(isSoftwareRendererName("")).toBe(false);
});

test("WebGPU backend trusts the cached adapter flag (GL probe is meaningless there)", () => {
  setFallbackAdapterCached(false);
  expect(isFallbackAdapterCached()).toBe(false);
  expect(isSoftwareRenderer({ backend: { isWebGPUBackend: true } })).toBe(false);
  setFallbackAdapterCached(true);
  expect(isFallbackAdapterCached()).toBe(true);
  expect(isSoftwareRenderer({ backend: { isWebGPUBackend: true } })).toBe(true);
  setFallbackAdapterCached(false);
});

test("WebGL2 backend still uses the renderer-string probe", () => {
  const swiftShader = {
    getContext: () => ({
      getExtension: () => ({ UNMASKED_RENDERER_WEBGL: 0x1f01 }),
      getParameter: () => "SwiftShader",
    }),
  };
  expect(isSoftwareRenderer(swiftShader)).toBe(true);
  expect(isSoftwareRenderer({})).toBe(false);
});
