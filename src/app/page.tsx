"use client";

import dynamic from "next/dynamic";
import {
  AnswerLine,
  AudioCues,
  EdgeTelemetry,
  StateRail,
  TopHud,
  VizRail,
} from "@/components/friday/hud/Hud";
import InputBar from "@/components/friday/hud/InputBar";
import ConfirmPrompt from "@/components/friday/hud/ConfirmPrompt";
import { LiveIndicator, MemoryRail, ToolHud } from "@/components/friday/hud/ToolHud";

const Scene = dynamic(() => import("@/components/friday/Scene"), { ssr: false });

/**
 * `h-dvh`, not `h-screen`: `100vh` on mobile is the height with the browser
 * toolbar collapsed, so the scene overflowed by the toolbar's height while it
 * was still shown — a page that scrolls, which §3 forbids. The desktop
 * viewports the suite runs at have no collapsing toolbar to catch it.
 */
export default function Home() {
  return (
    <main className="scanlines relative h-dvh w-screen overflow-hidden bg-background text-foreground">
      <Scene />
      <div className="scan-bar pointer-events-none absolute inset-0" />
      <div className="vignette pointer-events-none absolute inset-0" />

      <TopHud />
      <LiveIndicator />
      <EdgeTelemetry />
      <VizRail />
      <StateRail />
      <ToolHud />
      <MemoryRail />
      <AnswerLine />
      <InputBar />
      <ConfirmPrompt />
      <AudioCues />
    </main>
  );
}
