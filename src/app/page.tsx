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
import { LiveIndicator, ToolHud } from "@/components/friday/hud/ToolHud";

const Scene = dynamic(() => import("@/components/friday/Scene"), { ssr: false });

export default function Home() {
  return (
    <main className="scanlines relative h-screen w-screen overflow-hidden bg-background text-foreground">
      <Scene />
      <div className="scan-bar pointer-events-none absolute inset-0" />
      <div className="vignette pointer-events-none absolute inset-0" />

      <TopHud />
      <LiveIndicator />
      <EdgeTelemetry />
      <VizRail />
      <StateRail />
      <ToolHud />
      <AnswerLine />
      <InputBar />
      <ConfirmPrompt />
      <AudioCues />
    </main>
  );
}
