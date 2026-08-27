"use client";

import { useState } from "react";
import { useFridayStore } from "@/lib/store";
import { decide } from "@/lib/agentStream";

/**
 * §11 — operator approval for a high-risk tool call.
 *
 * The orchestrator is blocked on this: it will not run the tool until /confirm
 * answers, and treats a 120s silence as a refusal. So the prompt states what
 * will run and with what arguments — approving something described only as
 * "a tool" is not consent.
 */
export default function ConfirmPrompt() {
  const pending = useFridayStore((s) => s.pendingConfirm);
  const setPending = useFridayStore((s) => s.setPendingConfirm);
  const [sending, setSending] = useState(false);

  if (!pending) return null;

  const answer = async (approved: boolean) => {
    setSending(true);
    await decide(pending.id, approved);
    setPending(null);
    setSending(false);
  };

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      data-testid="confirm-prompt"
      className="pointer-events-auto absolute left-1/2 top-1/2 w-[min(26rem,calc(100vw-4rem))] -translate-x-1/2 -translate-y-1/2 border border-amber-300/40 bg-[#02050a]/92 px-6 py-5 font-mono text-[10px] tracking-[0.22em] text-amber-100 backdrop-blur-sm"
    >
      <div className="flex items-center justify-between text-amber-300/90">
        <span id="confirm-title">OPERATOR APPROVAL</span>
        <span className="text-amber-400">{pending.risk.toUpperCase()} RISK</span>
      </div>

      <div className="mt-4 text-[13px] tracking-[0.16em] text-amber-50" data-testid="confirm-tool">
        {pending.tool}
      </div>

      {/* the exact arguments, so approval is informed rather than reflexive */}
      <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words border-l border-amber-300/25 pl-3 text-[10px] leading-relaxed tracking-normal text-amber-200/70">
        {JSON.stringify(pending.input, null, 2)}
      </pre>

      <div className="mt-5 flex justify-end gap-6">
        <button
          onClick={() => answer(false)}
          disabled={sending}
          data-testid="confirm-deny"
          className="tracking-[0.24em] text-amber-200/60 transition-colors hover:text-amber-100 disabled:opacity-40"
        >
          DENY
        </button>
        <button
          onClick={() => answer(true)}
          disabled={sending}
          data-testid="confirm-approve"
          className="tracking-[0.24em] text-amber-300 transition-colors hover:text-amber-100 disabled:opacity-40"
        >
          APPROVE
        </button>
      </div>
    </div>
  );
}
