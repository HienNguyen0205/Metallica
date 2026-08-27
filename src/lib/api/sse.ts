/**
 * SSE parser for POST /query.
 * Must NOT assume 1 network chunk = 1 SSE event.
 * Handles: chunk splits mid-event, multiple frames per chunk,
 * CRLF/LF, comments, multi-line data, blank-line termination.
 */

export interface RawSseFrame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

/**
 * Parses a readable byte stream into SSE frames.
 * - Normalizes CRLF -> LF
 * - Buffers partial frames across chunks
 * - Joins multiple `data:` lines with \n per spec
 * - Supports `event:`, `data:`, `id:`, `retry:` and `:comment`
 * - Respects AbortSignal for cancellation
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<RawSseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Ensure reader is released on abort / completion
  const abortHandler = () => {
    try {
      reader.cancel();
    } catch {
      // ignore
    }
  };
  if (signal) {
    if (signal.aborted) {
      try {
        reader.cancel();
      } catch {}
      return;
    }
    signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF -> LF so split logic is simple
      buffer = buffer.replace(/\r\n/g, "\n");

      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const frameText = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        sep = buffer.indexOf("\n\n");

        const parsed = parseFrame(frameText);
        if (parsed) yield parsed;
      }
    }

    // Flush any remaining decoder bytes
    buffer += decoder.decode(undefined as unknown as Uint8Array, { stream: false });
    buffer = buffer.replace(/\r\n/g, "\n");
    if (buffer.trim().length > 0) {
      const parsed = parseFrame(buffer.trim());
      if (parsed) yield parsed;
    }
  } finally {
    if (signal) signal.removeEventListener("abort", abortHandler);
    try {
      reader.releaseLock();
    } catch {}
  }
}

function parseFrame(frameText: string): RawSseFrame | null {
  if (!frameText.trim()) return null;
  let event = "message";
  const dataLines: string[] = [];
  let id: string | undefined;
  let retry: number | undefined;

  for (const rawLine of frameText.split("\n")) {
    if (rawLine.length === 0) continue;
    if (rawLine.startsWith(":")) continue; // comment

    const colon = rawLine.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = rawLine;
      value = "";
    } else {
      field = rawLine.slice(0, colon);
      // Per spec: one optional space after colon is trimmed
      value = rawLine.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }

    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        dataLines.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const n = Number(value);
        if (!Number.isNaN(n)) retry = n;
        break;
      }
      default:
        break;
    }
  }

  // If no data lines, no dispatch per spec (but we still have event)
  // We keep event but data empty string => caller can skip if needed
  if (dataLines.length === 0 && event === "message") return null;

  return {
    event,
    data: dataLines.join("\n"),
    ...(id !== undefined ? { id } : {}),
    ...(retry !== undefined ? { retry } : {}),
  };
}

/**
 * Synchronous helper for tests: split a complete SSE text into frames.
 * Not streaming — just for unit verification.
 */
export function parseSseText(text: string): RawSseFrame[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const frames: RawSseFrame[] = [];
  const parts = normalized.split("\n\n");
  for (const part of parts) {
    if (!part.trim()) continue;
    const f = parseFrame(part);
    if (f) frames.push(f);
  }
  return frames;
}
