import type { FridayStore } from "@/lib/store";
import { planVisualization, summarize } from "@/lib/vizPlanner";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type FlowStore = Pick<FridayStore, "transition" | "setAnswer" | "setVisualization">;

/**
 * §9/§17 — the response flow. Stands in for the real agent/tool pipeline;
 * swap the wait() calls for stream events and this stays identical.
 *
 * thinking → searching → tool_execution → processing → visualizing → speaking → idle
 */
export async function runQuery(store: FlowStore, query: string) {
  const { transition, setAnswer, setVisualization } = store;

  setAnswer(null);
  setVisualization(null);

  transition("thinking");
  await wait(800);

  transition("searching");
  await wait(700);

  transition("tool_execution");
  await wait(700);

  transition("processing");
  await wait(500);

  // visualization materializes BEFORE the answer text (§9 step 3–5)
  const spec = planVisualization(query);
  transition("visualizing");
  setVisualization(spec);
  await wait(1500);

  transition("speaking");
  setAnswer(summarize(spec));
  await wait(3600);

  transition("idle");
  setAnswer(null);
  setVisualization(null);
}
