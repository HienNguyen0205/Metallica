import { OrchestratorRefused } from "@/lib/api/fridayClient";
import type { SupportedLang } from "@/lib/audioBus";

const API = process.env.NEXT_PUBLIC_FRIDAY_API ?? "http://localhost:8000";
const MAX_FRAME = 4 * 1024 * 1024;

export interface TtsHeader {
  sampleRate: number;
  channels: 1;
  totalSamples: number | null;
}

export interface TtsStream {
  header: TtsHeader;
  chunks: AsyncGenerator<Uint8Array, void, void>;
}

export type TtsErrorKind = "unreachable" | "refused" | "malformed";

export class TtsError extends Error {
  readonly kind: TtsErrorKind;
  constructor(kind: TtsErrorKind, message: string) {
    super(message);
    this.name = "TtsError";
    this.kind = kind;
  }
}

function tabSessionId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    let id = window.sessionStorage.getItem("friday.session");
    if (!id) {
      id = crypto.randomUUID();
      window.sessionStorage.setItem("friday.session", id);
    }
    return id;
  } catch {
    return undefined;
  }
}

interface FrameReaderState {
  pending: Uint8Array;
}

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return (
    signal?.aborted === true ||
    (typeof err === "object" && err !== null && (err as { name?: unknown }).name === "AbortError")
  );
}

async function readExactly(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  n: number,
  state: FrameReaderState,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const out = new Uint8Array(n);
  let got = 0;
  if (state.pending.length > 0) {
    const take = Math.min(state.pending.length, n);
    out.set(state.pending.subarray(0, take), 0);
    got = take;
    state.pending = state.pending.slice(take);
  }
  while (got < n) {
    if (signal?.aborted) return null;
    let read: ReadableStreamReadResult<Uint8Array>;
    try {
      read = await reader.read();
    } catch (err) {
      if (isAbort(err, signal)) return null;
      throw err;
    }
    if (read.done) return null;
    const value = read.value;
    if (!value || value.length === 0) continue;
    const need = n - got;
    if (value.length <= need) {
      out.set(value, got);
      got += value.length;
    } else {
      out.set(value.subarray(0, need), got);
      got += need;
      state.pending = value.slice(need);
    }
  }
  return out;
}

export async function streamTts(
  text: string,
  lang: SupportedLang,
  opts?: { signal?: AbortSignal },
): Promise<TtsStream> {
  const { signal } = opts ?? {};
  let res: Response;
  try {
    res = await fetch(`${API}/tts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, lang, session_id: tabSessionId() }),
      signal,
    });
  } catch (err) {
    if (isAbort(err, signal)) throw new DOMException("aborted", "AbortError");
    throw new TtsError("unreachable", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 403 || res.status === 429) {
    const retry = Number(res.headers.get("retry-after"));
    throw new OrchestratorRefused(res.status, Number.isFinite(retry) && retry > 0 ? retry : null);
  }
  if (!res.ok || !res.body) throw new TtsError("unreachable", `tts ${res.status}`);
  const reader = res.body.getReader();
  const state: FrameReaderState = { pending: new Uint8Array(0) };

  async function* chunks(): AsyncGenerator<Uint8Array, void, void> {
    for (;;) {
      let prefix: Uint8Array | null;
      try {
        prefix = await readExactly(reader, 4, state, signal);
      } catch (err) {
        if (isAbort(err, signal)) return;
        throw err;
      }
      if (!prefix) return;
      const len = prefix[0]! | (prefix[1]! << 8) | (prefix[2]! << 16) | (prefix[3]! << 24);
      if (len === 0 || len > MAX_FRAME) throw new TtsError("malformed", `bad frame length ${len}`);
      let body: Uint8Array | null;
      try {
        body = await readExactly(reader, len, state, signal);
      } catch (err) {
        if (isAbort(err, signal)) return;
        throw err;
      }
      if (!body) {
        if (signal?.aborted) return;
        throw new TtsError("malformed", "truncated frame");
      }
      yield body;
    }
  }

  const gen = chunks();
  let first: IteratorResult<Uint8Array, void>;
  try {
    first = await gen.next();
  } catch (err) {
    if (isAbort(err, signal)) throw new DOMException("aborted", "AbortError");
    throw err;
  }
  if (first.done) throw new TtsError("malformed", "empty tts stream");
  let header: TtsHeader;
  try {
    const raw = JSON.parse(new TextDecoder().decode(first.value)) as Record<string, unknown>;
    const sampleRate = Number(raw["sampleRate"]);
    const totalRaw = raw["totalSamples"];
    const total = totalRaw === undefined ? null : Number(totalRaw);
    if (!Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
      throw new Error("rate");
    }
    if (raw["channels"] !== 1) throw new Error("channels");
    header = {
      sampleRate,
      channels: 1,
      totalSamples:
        total !== null && Number.isFinite(total) && (total as number) >= 0
          ? (total as number)
          : null,
    };
  } catch (err) {
    if (err instanceof TtsError) throw err;
    throw new TtsError("malformed", "bad tts header");
  }
  return { header, chunks: gen };
}
