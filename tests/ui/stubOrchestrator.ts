import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";

/**
 * A stand-in for the Python orchestrator, on the port the built frontend is
 * compiled to call.
 *
 * The flow test used to run with nothing on :8000, so `agentStream.ts` fell
 * through to its offline rules planner and the test only ever exercised the
 * fallback — the real SSE path, the part that ships, went unchecked.
 *
 * Frames are written with real gaps between them on purpose. Delivered as one
 * chunk, every store update lands in a single tick, React batches them, and the
 * intermediate states never reach the DOM to be observed.
 */

export interface StubEvent {
  event: string;
  data: Record<string, unknown>;
  /** ms to wait before writing this frame */
  after?: number;
}

/** The sequence the real backend emits for a query that runs one low-risk tool. */
export const TOOL_FLOW: StubEvent[] = [
  { event: "state", data: { state: "thinking" }, after: 60 },
  { event: "state", data: { state: "tool_execution" }, after: 180 },
  { event: "tool", data: { tool: "get_system_metrics", risk: "low" }, after: 20 },
  { event: "state", data: { state: "processing" }, after: 180 },
  { event: "state", data: { state: "visualizing" }, after: 180 },
  {
    event: "viz",
    data: {
      type: "radial_gauge",
      title: "SYSTEM LOAD",
      animation: "materialize",
      interaction: "drill_down",
      data: {
        metrics: [
          { label: "CPU", value: 73, unit: "%" },
          { label: "RAM", value: 61, unit: "%" },
        ],
      },
    },
    after: 20,
  },
  { event: "state", data: { state: "speaking" }, after: 200 },
  { event: "answer", data: { text: "CPU is at 73 percent, memory at 61." }, after: 20 },
  { event: "done", data: {}, after: 20 },
];

/**
 * §18 — the visualization arrives in pieces as tools return, then the planner's
 * spec replaces it. Note there is no `visualizing` state before a preview:
 * FRIDAY is still running tools, and `visualizing -> tool_execution` is not an
 * edge the store allows, so announcing it would strand the HUD.
 */
export const STREAMING_FLOW: StubEvent[] = [
  { event: "state", data: { state: "thinking" }, after: 60 },
  { event: "state", data: { state: "tool_execution" }, after: 150 },
  { event: "tool", data: { tool: "get_system_metrics", risk: "low" }, after: 20 },
  {
    event: "viz",
    data: {
      type: "radial_gauge",
      title: "SYSTEM LOAD",
      animation: "materialize",
      interaction: "none",
      data: { metrics: [{ label: "CPU", value: 10, unit: "%" }] },
    },
    after: 150,
  },
  // The backend emits this before every tool. Repeating the current state is a
  // no-op in the store; the point is that no `visualizing` sneaks in between.
  { event: "state", data: { state: "tool_execution" }, after: 250 },
  { event: "tool", data: { tool: "get_process_list", risk: "low" }, after: 20 },
  {
    event: "viz",
    data: {
      type: "bar_3d",
      title: "TOP PROCESSES",
      animation: "materialize",
      interaction: "none",
      data: { series: [{ label: "MEM", points: [10.9, 5.8, 2.7] }] },
    },
    after: 250,
  },
  { event: "state", data: { state: "processing" }, after: 200 },
  { event: "state", data: { state: "visualizing" }, after: 150 },
  {
    event: "viz",
    data: {
      type: "radial_gauge",
      title: "SYSTEM METRICS",
      animation: "materialize",
      interaction: "drill_down",
      data: {
        metrics: [
          { label: "CPU", value: 10, unit: "%" },
          { label: "RAM", value: 78, unit: "%" },
          { label: "DISK", value: 97, unit: "%" },
        ],
      },
    },
    after: 20,
  },
  { event: "state", data: { state: "speaking" }, after: 200 },
  { event: "answer", data: { text: "CPU 10 percent, memory 78, disk 97." }, after: 20 },
  { event: "done", data: {}, after: 20 },
];

/**
 * Task 12 — a fact FRIDAY chose to remember mid-turn, sourced from a page it
 * searched rather than the operator's own words. `provenance: "tool"` is the
 * only signal the HUD has to mark that distinctly from a memory the operator
 * stated directly.
 */
export const MEMORY_FLOW: StubEvent[] = [
  { event: "state", data: { state: "thinking" }, after: 60 },
  {
    event: "memory",
    data: { id: 1, fact: "the office closes at 9pm on fridays", provenance: "tool" },
    after: 150,
  },
  { event: "state", data: { state: "speaking" }, after: 150 },
  { event: "answer", data: { text: "Noted." }, after: 20 },
  { event: "done", data: {}, after: 20 },
];

/** A high-risk call that blocks until POST /confirm answers it. */
export const CONFIRM_FLOW: StubEvent[] = [
  { event: "state", data: { state: "thinking" }, after: 60 },
  {
    event: "confirm",
    data: { id: "test-decision", tool: "write_note", risk: "high", input: { name: "log", body: "hi" } },
    after: 150,
  },
];

/**
 * Two series for one bar_3d spec — the grouped-bars layout. Short values so
 * the tallest bar (P95 = 44) is the obvious click target, and drill_down so
 * the test can prove the second series is pickable, not just painted.
 */
export const GROUPED_BAR_FLOW: StubEvent[] = [
  { event: "state", data: { state: "thinking" }, after: 60 },
  { event: "state", data: { state: "visualizing" }, after: 180 },
  {
    event: "viz",
    data: {
      type: "bar_3d",
      title: "REQUESTS VS P95",
      animation: "materialize",
      interaction: "drill_down",
      data: {
        series: [
          { label: "REQ", points: [34, 58, 22] },
          { label: "P95", points: [12, 44, 39] },
        ],
      },
    },
    after: 20,
  },
  { event: "state", data: { state: "speaking" }, after: 200 },
  { event: "answer", data: { text: "Traffic concentrated on two services." }, after: 20 },
  { event: "done", data: {}, after: 20 },
];

/**
 * P0.2 — the tool flow as the gated FRIDAY_EVENTS_V2 backend mode emits it:
 * every frame wrapped in the v1 envelope (sequence strictly +1 from 1, run
 * "run_stub", nothing after `done`), plus the run model's `step` frames — one
 * `running` right after the `tool` frame, one `completed` (with summary)
 * before `done`. Derived from TOOL_FLOW so the two cannot drift.
 */
function v2ToolFlow(sessionId: string | null): StubEvent[] {
  let sequence = 0;
  const envelope = (event: string, payload: Record<string, unknown>): Record<string, unknown> => ({
    version: 1,
    run_id: "run_stub",
    session_id: sessionId,
    turn_id: "turn_1",
    sequence: ++sequence,
    timestamp: "2026-09-10T02:00:00Z",
    event,
    payload,
  });
  const frames: StubEvent[] = [];
  for (const flat of TOOL_FLOW) {
    frames.push({ ...flat, data: envelope(flat.event, flat.data) });
    if (flat.event === "tool") {
      frames.push({
        event: "step",
        data: envelope("step", {
          step_id: "s1",
          turn_id: "turn_1",
          kind: "tool",
          status: "running",
          tool: "get_system_metrics",
        }),
        after: 20,
      });
    }
    if (flat.event === "answer") {
      frames.push({
        event: "step",
        data: envelope("step", {
          step_id: "s1",
          turn_id: "turn_1",
          kind: "tool",
          status: "completed",
          // the step keeps its tool across transitions, as the BE's AgentStep does
          tool: "get_system_metrics",
          summary: "cpu 73 percent, memory 61 percent",
        }),
        after: 20,
      });
    }
  }
  return frames;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StubHandle {
  server: Server;
  /** Decisions received on POST /confirm, in order. */
  decisions: { id: string; approved: boolean }[];
  /** Query strings received on POST /query, in order. */
  queries: string[];
  /** Texts received on POST /tts, in order. */
  ttsRequests: string[];
  /** Rows `GET /memory` serves; `DELETE /memory/{id}` removes from this. */
  memories: { id: number; fact: string; provenance: "user" | "tool" }[];
  /** Ids received on DELETE /memory/{id}, in order. */
  forgotten: number[];
  close: () => Promise<void>;
}

/** 0.5 s of 440 Hz sine, int16-LE mono 24 kHz — deterministic TTS audio. */
const TTS_RATE = 24000;
function ttsSineFrames(): Buffer[] {
  const total = Math.floor(TTS_RATE * 0.5);
  const pcm = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i++) {
    pcm.writeInt16LE(Math.floor(Math.sin((i / TTS_RATE) * Math.PI * 2 * 440) * 12000), i * 2);
  }
  const header = Buffer.from(JSON.stringify({ sampleRate: TTS_RATE, channels: 1, totalSamples: total }));
  const out: Buffer[] = [frame(header)];
  for (let at = 0; at < pcm.length; at += 6000) out.push(frame(pcm.subarray(at, at + 6000)));
  return out;
}

function frame(payload: Buffer): Buffer {
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length, 0);
  return Buffer.concat([prefix, payload]);
}

/** Must match NEXT_PUBLIC_FRIDAY_API in playwright.config.ts. */
export const STUB_PORT = 8123;

/** What `GET /memory` serves unless a test overrides it. */
export const STUB_MEMORIES: { id: number; fact: string; provenance: "user" | "tool" }[] = [
  { id: 1, fact: "deploys are safe on tuesdays at 2am utc", provenance: "user" },
  { id: 2, fact: "the office closes at 9pm on fridays", provenance: "tool" },
];

export async function startStubOrchestrator(
  script: StubEvent[],
  port = STUB_PORT,
  seedMemories: { id: number; fact: string; provenance: "user" | "tool" }[] = STUB_MEMORIES,
): Promise<StubHandle> {
  const decisions: { id: string; approved: boolean }[] = [];
  const queries: string[] = [];
  const ttsRequests: string[] = [];
  const memories = seedMemories.map((m) => ({ ...m }));
  const forgotten: number[] = [];
  // Tests may end while an SSE response is still open (an approval prompt that
  // is never answered). Those sockets have to be destroyed explicitly or the
  // port is still held when the next test binds it — which shows up as the
  // frontend silently taking its offline fallback instead of failing loudly.
  const sockets = new Set<Socket>();
  /** Resolved when a decision arrives, so CONFIRM_FLOW can continue after it. */
  let onDecision: (() => void) | null = null;

  const server = createServer(async (req, res) => {
    // The page is served from a different origin, same as in production.
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "content-type",
      // DELETE is here for `DELETE /memory/{id}`. A cross-origin DELETE is not
      // a simple request, so the browser preflights it and drops the call
      // outright if the method is missing from this list — which is what the
      // real backend must also send for the forget control to work at all.
      "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
      return;
    }

    /**
     * §8 of the memory design. Shape mirrors what the results doc recorded off
     * the real backend: `{ memories, from_cache }` for the list, `{ ok: true }`
     * for a delete.
     */
    if (req.url === "/memory" && req.method === "GET") {
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ memories, from_cache: false }));
      return;
    }

    const forgetMatch = req.url?.match(/^\/memory\/(\d+)$/);
    if (forgetMatch && req.method === "DELETE") {
      const id = Number(forgetMatch[1]);
      forgotten.push(id);
      const at = memories.findIndex((m) => m.id === id);
      if (at !== -1) memories.splice(at, 1);
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/confirm") {
      const body = await readBody(req);
      decisions.push(JSON.parse(body));
      onDecision?.();
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/tts" && req.method === "POST") {
      const ttsBody = await readBody(req);
      try {
        ttsRequests.push(String(JSON.parse(ttsBody).text ?? ""));
      } catch {
        // unparsable TTS body is still answered — the bytes are what matter
      }
      res.writeHead(200, { ...cors, "content-type": "application/octet-stream" });
      for (const chunk of ttsSineFrames()) {
        res.write(chunk);
        await sleep(10);
      }
      res.end();
      return;
    }

    if (req.url !== "/query") {
      res.writeHead(404, cors).end();
      return;
    }

    const queryBody = await readBody(req);
    let v2SessionId: string | null = null;
    let isV2 = false;
    try {
      const parsed = JSON.parse(queryBody) as { query?: unknown; session_id?: unknown };
      const query = String(parsed.query ?? "");
      queries.push(query);
      // P0.2 — a "v2:"-prefixed query switches this response to enveloped
      // FRIDAY_EVENTS_V2 frames (with step events); every other query keeps
      // the flat path byte-identical.
      isV2 = query.startsWith("v2:");
      v2SessionId = typeof parsed.session_id === "string" ? parsed.session_id : null;
    } catch {
      // a body we cannot parse is not worth failing the stub over
    }
    res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" });

    const flow = isV2 ? v2ToolFlow(v2SessionId) : script;
    for (const frame of flow) {
      await sleep(frame.after ?? 50);
      res.write(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`);

      if (frame.event === "confirm") {
        // Mirror the backend: the stream stalls here until a decision lands.
        await new Promise<void>((resolve) => {
          onDecision = resolve;
        });
        const approved = decisions.at(-1)?.approved;
        res.write(
          `event: state\ndata: ${JSON.stringify({ state: approved ? "processing" : "speaking" })}\n\n`,
        );
        res.write(
          `event: answer\ndata: ${JSON.stringify({
            text: approved ? "Note written." : "Understood, I won't write it.",
          })}\n\n`,
        );
        res.write(`event: done\ndata: {}\n\n`);
      }
    }
    res.end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await listenWithRetry(server, port);

  return {
    server,
    decisions,
    queries,
    ttsRequests,
    memories,
    forgotten,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** The previous test's port may not be free yet; a short retry beats a flake. */
async function listenWithRetry(server: Server, port: number, attempts = 20): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => reject(err);
        server.once("error", onError);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw err;
      await sleep(150);
    }
  }
  throw new Error(
    `stub orchestrator could not bind :${port} — is another stub already holding :${port}? (real backend lives on :8000)`,
  );
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
