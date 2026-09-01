import { test, expect } from "@playwright/test";
import { nextFocus } from "@/components/friday/visualization/FridayVisualization";
import type { VizFocus } from "@/lib/store";

/**
 * §5 `interaction: "drill_down"` — the decision behind clicking a hologram
 * element, checked here rather than through the canvas.
 *
 * It lived in the click handler and was covered by a UI test that clicked a
 * screen coordinate twice. That test could not work: the metric nodes bob every
 * frame and the camera drifts, so the second click lands somewhere slightly
 * different — and because a click that hits nothing also clears the focus, a
 * genuine release and a miss produce the same reading. One version of that test
 * failed once in nine runs on correct code; the version that fixed the flake
 * passed against a build with the release branch deleted. Neither could be both
 * stable and able to fail.
 *
 * Here the same logic is decided in microseconds with nothing moving.
 */
const AT: [number, number, number] = [1, 2, 3];
const CPU = { label: "CPU", detail: "73%" };
const RAM = { label: "RAM", detail: "61%" };

test("clicking with nothing focused focuses that element", () => {
  expect(nextFocus(null, CPU, AT)).toEqual({ ...CPU, position: AT });
});

test("clicking the focused element releases it", () => {
  const focused: VizFocus = { ...CPU, position: [9, 9, 9] };
  expect(
    nextFocus(focused, CPU, AT),
    "a second click on the same element must clear the focus, not re-lock it",
  ).toBeNull();
});

test("clicking a different element moves the focus rather than releasing", () => {
  const focused: VizFocus = { ...CPU, position: [9, 9, 9] };
  expect(nextFocus(focused, RAM, AT)).toEqual({ ...RAM, position: AT });
});

test("release is decided by label, not by where the click landed", () => {
  // The position always differs between two clicks on the same node — it bobs.
  // Comparing anything but the label would make the toggle unreleasable.
  const focused: VizFocus = { ...CPU, position: [0, 0, 0] };
  expect(nextFocus(focused, CPU, [0.01, -0.4, 2])).toBeNull();
});

test("re-focusing carries the new position, so the reticle follows the node", () => {
  const focused: VizFocus = { ...RAM, position: [0, 0, 0] };
  expect(nextFocus(focused, CPU, AT)?.position).toEqual(AT);
});
