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

/** A high-risk call that blocks until POST /confirm answers it. */
export const CONFIRM_FLOW: StubEvent[] = [
  { event: "state", data: { state: "thinking" }, after: 60 },
  {
    event: "confirm",
    data: { id: "test-decision", tool: "write_note", risk: "high", input: { name: "log", body: "hi" } },
    after: 150,
  },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface StubHandle {
  server: Server;
  /** Decisions received on POST /confirm, in order. */
  decisions: { id: string; approved: boolean }[];
  close: () => Promise<void>;
}

/** Must match NEXT_PUBLIC_FRIDAY_API in playwright.config.ts. */
export const STUB_PORT = 8123;

export async function startStubOrchestrator(
  script: StubEvent[],
  port = STUB_PORT,
): Promise<StubHandle> {
  const decisions: { id: string; approved: boolean }[] = [];
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
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors).end();
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

    if (req.url !== "/query") {
      res.writeHead(404, cors).end();
      return;
    }

    await readBody(req);
    res.writeHead(200, { ...cors, "content-type": "text/event-stream", "cache-control": "no-cache" });

    for (const frame of script) {
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
  throw new Error(`stub orchestrator could not bind :${port} — is a real backend running?`);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}
