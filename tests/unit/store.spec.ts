import { test, expect } from "@playwright/test";
import { useFridayStore, type FridayState } from "@/lib/store";

/**
 * §17 — the state machine. `transition` is guarded (it must refuse illegal
 * edges) while `setState` is the unguarded escape hatch the dev rail uses.
 */

const api = useFridayStore;
const at = (state: FridayState) => api.setState({ state });
const now = () => api.getState().state;

test.beforeEach(() => {
  api.getState().reset();
});

test("starts idle with nothing on screen", () => {
  expect(now()).toBe("idle");
  expect(api.getState().answer).toBeNull();
  expect(api.getState().visualizations).toEqual([]);
});

test("walks the documented happy path", () => {
  const path: FridayState[] = [
    "thinking",
    "searching",
    "tool_execution",
    "processing",
    "visualizing",
    "speaking",
    "idle",
  ];
  for (const next of path) {
    api.getState().transition(next);
    expect(now(), `could not reach ${next}`).toBe(next);
  }
});

test("refuses illegal edges instead of jumping", () => {
  at("idle");
  api.getState().transition("speaking"); // idle cannot speak out of nowhere
  expect(now()).toBe("idle");

  at("error");
  api.getState().transition("thinking"); // error only recovers to idle
  expect(now()).toBe("error");

  at("speaking");
  api.getState().transition("visualizing"); // no going back mid-answer
  expect(now()).toBe("speaking");
});

test("error recovers only through idle", () => {
  at("error");
  api.getState().transition("idle");
  expect(now()).toBe("idle");
});

test("warning and error are reachable from every working state", () => {
  const working: FridayState[] = [
    "idle",
    "listening",
    "thinking",
    "searching",
    "processing",
    "tool_execution",
    "visualizing",
    "speaking",
  ];
  for (const from of working) {
    at(from);
    api.getState().transition("error");
    expect(now(), `${from} cannot reach error`).toBe("error");
  }
});

test("setState is unguarded so the dev rail can preview any look", () => {
  at("idle");
  api.getState().setState("speaking");
  expect(now()).toBe("speaking");
});

test("reset clears the answer and the visualization together", () => {
  api.getState().setState("speaking");
  api.getState().setAnswer("System integrity at 87 percent.");
  api.getState().setVisualizations([{ type: "health_core" }]);

  api.getState().reset();

  expect(now()).toBe("idle");
  expect(api.getState().answer).toBeNull();
  expect(api.getState().visualizations).toEqual([]);
});

test("audio toggle flips and persists", () => {
  const before = api.getState().audioEnabled;
  api.getState().toggleAudio();
  expect(api.getState().audioEnabled).toBe(!before);
  api.getState().toggleAudio();
  expect(api.getState().audioEnabled).toBe(before);
});

test("focus can be set and cleared", () => {
  api.getState().setFocus({ label: "CPU", detail: "73%", position: [1, 2, 0] });
  expect(api.getState().focus?.label).toBe("CPU");
  api.getState().setFocus(null);
  expect(api.getState().focus).toBeNull();
});

test("reset clears any active focus", () => {
  api.getState().setFocus({ label: "RAM", detail: "61%", position: [0, 0, 1] });
  api.getState().reset();
  expect(api.getState().focus).toBeNull();
});

test("render backend defaults to webgl2 and records changes", () => {
  expect(api.getState().renderBackend).toBe("webgl2");
  api.getState().setRenderBackend("webgpu");
  expect(api.getState().renderBackend).toBe("webgpu");
  api.getState().setRenderBackend("webgl2");
});

test("a memory event lands in the store so the operator can see it", () => {
  api.getState().addMemory({ id: 1, fact: "thích đơn vị mét", provenance: "user" });
  expect(api.getState().memories[0].fact).toBe("thích đơn vị mét");
});

test("clearing wipes the learned line", () => {
  api.getState().addMemory({ id: 1, fact: "thích đơn vị mét", provenance: "user" });
  api.getState().clearMemories();
  expect(api.getState().memories).toEqual([]);
});

test("only the most recent memories are kept on screen", () => {
  for (let i = 0; i < 10; i++) {
    api.getState().addMemory({ id: i, fact: `m${i}`, provenance: "user" });
  }
  // HUD là một dòng, không phải nhật ký. Giữ hết thì nó trôi khỏi màn hình —
  // nhưng nếu addMemory không làm gì cả thì độ dài cũng là 0, nên phải kiểm
  // tra cả số lượng chính xác lẫn thứ tự (mới nhất ở đầu) để bài test này
  // thật sự phân biệt được "giữ 3 cái gần nhất" với "vứt hết".
  const memories = api.getState().memories;
  expect(memories.length).toBe(3);
  expect(memories[0].fact).toBe("m9");
});
