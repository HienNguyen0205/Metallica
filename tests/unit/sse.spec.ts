import { test, expect } from "@playwright/test";
import { parseSseStream, type RawSseFrame } from "@/lib/api/sse";

/**
 * The SSE parser, driven the way the network drives it.
 *
 * Deliberately not through a synchronous "split this whole string" helper: the
 * part that actually breaks is the buffering across chunk boundaries, and a
 * helper that hands the parser one complete text never exercises it. Every case
 * below therefore feeds a real `ReadableStream` whose chunks are cut where a
 * socket would plausibly cut them.
 */
function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

async function collect(
  chunks: string[],
  signal?: AbortSignal,
): Promise<RawSseFrame[]> {
  const out: RawSseFrame[] = [];
  for await (const frame of parseSseStream(streamOf(chunks), signal)) out.push(frame);
  return out;
}

test("a frame split across chunks is reassembled, not dropped", async () => {
  // the cut lands inside the JSON payload, mid-token
  const frames = await collect([
    'event: state\ndata: {"sta',
    'te": "thinking"}\n\n',
  ]);

  expect(frames).toHaveLength(1);
  expect(frames[0].event).toBe("state");
  expect(JSON.parse(frames[0].data)).toEqual({ state: "thinking" });
});

test("a chunk carrying several frames yields all of them, in order", async () => {
  const frames = await collect([
    'event: state\ndata: {"state":"thinking"}\n\n' +
      'event: tool\ndata: {"tool":"get_system_metrics"}\n\n' +
      "event: done\ndata: {}\n\n",
  ]);

  expect(frames.map((f) => f.event)).toEqual(["state", "tool", "done"]);
});

test("the blank line between frames may itself be split across chunks", async () => {
  // "\n\n" is the frame separator, so a cut between its two bytes is the one
  // boundary a naive `chunk.split("\n\n")` silently loses.
  const frames = await collect(['event: answer\ndata: {"text":"hi"}\n', '\nevent: done\ndata: {}\n\n']);

  expect(frames.map((f) => f.event)).toEqual(["answer", "done"]);
});

test("CRLF line endings parse the same as LF", async () => {
  const frames = await collect(['event: state\r\ndata: {"state":"idle"}\r\n\r\n']);

  expect(frames).toHaveLength(1);
  expect(frames[0].event).toBe("state");
  expect(JSON.parse(frames[0].data)).toEqual({ state: "idle" });
});

test("multiple data lines join with a newline, per spec", async () => {
  const frames = await collect(["event: answer\ndata: first\ndata: second\n\n"]);

  expect(frames[0].data).toBe("first\nsecond");
});

test("comment lines are skipped without ending the frame", async () => {
  // Heartbeat comments are how a proxy is kept from timing the stream out;
  // treating one as a frame would push a junk event at the store.
  const frames = await collect([": keep-alive\nevent: state\ndata: {}\n\n"]);

  expect(frames).toHaveLength(1);
  expect(frames[0].event).toBe("state");
});

test("a trailing frame with no terminating blank line is still delivered", async () => {
  // A backend that ends the response right after the last frame is within its
  // rights; dropping that frame would lose the `done` that ends a turn.
  const frames = await collect(["event: done\ndata: {}"]);

  expect(frames.map((f) => f.event)).toEqual(["done"]);
});

test("one optional space after the colon is trimmed, further spaces are data", async () => {
  const frames = await collect(["event: answer\ndata:  padded\n\n"]);

  expect(frames[0].data).toBe(" padded");
});

test("an already-aborted signal yields nothing", async () => {
  const frames = await collect(['event: state\ndata: {"state":"thinking"}\n\n'], AbortSignal.abort());

  expect(frames).toEqual([]);
});
