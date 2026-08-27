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
    <>
      {/* holographic dim — keeps scene visible */}
      <div className="pointer-events-none absolute inset-0 bg-[#02050a]/70 backdrop-blur-[2px]" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        data-testid="confirm-prompt"
        className="pointer-events-auto absolute left-1/2 top-1/2 w-[min(28rem,calc(100vw-4rem))] -translate-x-1/2 -translate-y-1/2 border border-amber-300/40 bg-[#080c14]/92 px-7 py-6 font-mono text-[10px] tracking-[0.22em] text-amber-100 backdrop-blur-md"
        style={{ boxShadow: "0 0 40px rgba(251,191,36,0.18), inset 0 0 30px rgba(251,191,36,0.06)" }}
      >
        {/* scanline overlay */}
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ background: "repeating-linear-gradient(to bottom, transparent 0px, transparent 2px, rgba(251,191,36,0.5) 2px, transparent 3px)" }} />
        <div className="relative flex flex-col items-center gap-2 text-amber-300/80">
          <span className="h-2 w-2 rounded-full bg-amber-300 shadow-[0_0_10px_3px_rgba(251,191,36,0.5)]" />
          <span id="confirm-title" className="tracking-[0.32em]">SECURITY PROTOCOL</span>
          <span className="text-[9px] tracking-[0.28em] text-amber-300/60">HOLOGRAPHIC CONFIRMATION REQUIRED</span>
        </div>

        <div className="relative mt-5 flex items-center justify-between border-y border-amber-300/15 py-3 text-amber-300/90">
          <span className="tracking-[0.24em]">{pending.tool.toUpperCase().replace(/_/g, " ")}</span>
          <span className="rounded-sm border border-amber-300/30 bg-amber-300/10 px-2 py-0.5 text-[9px] tracking-[0.24em] text-amber-400">{pending.risk.toUpperCase()} RISK</span>
        </div>

        <div className="relative mt-3 text-[11px] tracking-[0.16em] text-amber-50/90" data-testid="confirm-tool">
          {pending.tool}
        </div>

        <pre className="relative mt-3 max-h-44 overflow-auto whitespace-pre-wrap break-words border-l-2 border-amber-300/25 bg-amber-300/[0.04] py-2 pl-3 pr-2 text-[10px] leading-relaxed tracking-normal text-amber-200/70">
          {JSON.stringify(pending.input, null, 2)}
        </pre>

        <div className="relative mt-6 flex justify-center gap-8">
          <button
            onClick={() => answer(false)}
            disabled={sending}
            data-testid="confirm-deny"
            className="min-w-[7rem] border border-amber-200/25 px-5 py-2 tracking-[0.24em] text-amber-200/70 transition-colors hover:border-amber-200/50 hover:bg-amber-200/5 hover:text-amber-100 disabled:opacity-40"
          >
            DENY
          </button>
          <button
            onClick={() => answer(true)}
            disabled={sending}
            data-testid="confirm-approve"
            className="min-w-[7rem] border border-amber-300/50 bg-amber-300/10 px-5 py-2 tracking-[0.24em] text-amber-300 transition-colors hover:bg-amber-300/20 hover:text-amber-100 disabled:opacity-40"
            style={{ boxShadow: "0 0 14px rgba(251,191,36,0.25)" }}
          >
            APPROVE
          </button>
        </div>
        <div className="pointer-events-none absolute -bottom-0.5 left-1/2 h-px w-3/4 -translate-x-1/2 bg-gradient-to-r from-transparent via-amber-300/40 to-transparent" />
      </div>
    </>
  );
}
