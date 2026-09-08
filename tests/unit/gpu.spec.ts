import { test, expect } from "@playwright/test";
import { isSoftwareRendererName } from "@/lib/gpu";

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
