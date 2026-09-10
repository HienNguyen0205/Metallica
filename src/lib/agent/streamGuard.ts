import type { EnvelopeMeta } from "@/lib/agent/events";

export type GuardVerdict = "accept" | "legacy" | "duplicate" | "stale" | "gap" | "wrong-run";

/**
 * P0.1 stream integrity — per-turn envelope tracker.
 * One instance per runQuery turn; never shared across turns.
 * Legacy (flat, meta null) frames bypass ordering: today's backend emits those.
 */
export class StreamGuard {
  private pinnedRunId: string | null = null;
  private lastSequence: number | null = null;
  private lastKey: string | null = null;
  private gaps = 0;

  observe(meta: EnvelopeMeta | null, key?: string): GuardVerdict {
    if (!meta) return "legacy";
    if (meta.runId && this.pinnedRunId && meta.runId !== this.pinnedRunId) {
      return "wrong-run";
    }
    if (meta.runId && !this.pinnedRunId) this.pinnedRunId = meta.runId;
    if (meta.sequence === null) {
      if (key !== undefined && key === this.lastKey) return "duplicate";
      this.lastKey = key ?? null;
      return "accept";
    }
    this.lastKey = null;
    if (this.lastSequence !== null) {
      if (meta.sequence === this.lastSequence) return "duplicate";
      if (meta.sequence < this.lastSequence) return "stale";
      if (meta.sequence > this.lastSequence + 1) {
        this.gaps += 1;
        this.lastSequence = meta.sequence;
        return "gap";
      }
    }
    this.lastSequence = meta.sequence;
    return "accept";
  }

  get gapCount(): number {
    return this.gaps;
  }

  get lastSeenSequence(): number | null {
    return this.lastSequence;
  }
}
