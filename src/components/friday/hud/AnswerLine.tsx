"use client";

import { useFridayStore } from "@/lib/store";

/** §10 — the spoken answer, minimal and floating. Never a chat bubble. */
export function AnswerLine() {
  const answer = useFridayStore((s) => s.answer);

  /**
   * The container is always mounted, empty or not. A live region has to exist
   * before its content changes for the change to be announced — mounting the
   * region and the text together is the one arrangement screen readers reliably
   * miss, and the answer is spoken aloud only when the question arrived by
   * voice, so a typed turn otherwise reaches a screen reader user not at all.
   */
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none absolute inset-x-0 bottom-32 flex justify-center px-8"
    >
      {/* keyed so a new answer replays the rise-in */}
      {answer && (
        <p
          key={answer}
          className="answer-rise max-w-sm text-center font-mono text-[13px] font-light leading-relaxed tracking-[0.06em] text-cyan-50/85"
        >
          {answer}
        </p>
      )}
    </div>
  );
}
