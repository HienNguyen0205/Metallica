/**
 * TTS playback worklet — deliberately trivial ring-buffer passthrough.
 *
 * All non-trivial logic (backpressure, drain, teardown) lives in
 * `src/lib/ttsPlayer.ts`, which is unit-tested with a faked port. This file
 * exists only because an AudioWorkletNode needs a registered processor name.
 * Protocol: in `{ type: "feed", samples: Float32Array }` / `{ type: "stop" }`,
 * out `{ type: "consumed", count }` / `{ type: "ready" }`.
 */
class TtsPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.port.onmessage = (e) => {
      if (e.data.type === "feed") this.queue.push({ samples: e.data.samples, i: 0 });
      if (e.data.type === "stop") this.queue.length = 0;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let consumed = 0;
    for (let i = 0; i < out.length; i++) {
      let head = this.queue[0];
      while (head && head.i >= head.samples.length) {
        this.queue.shift();
        head = this.queue[0];
      }
      if (!head) {
        out[i] = 0;
        continue;
      }
      out[i] = head.samples[head.i++];
      consumed++;
    }
    if (consumed > 0) this.port.postMessage({ type: "consumed", count: consumed });
    if (this.queue.length < 4) this.port.postMessage({ type: "ready" });
    return true;
  }
}

registerProcessor("tts-player", TtsPlayerProcessor);
