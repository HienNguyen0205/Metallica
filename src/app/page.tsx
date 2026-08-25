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

const Scene = dynamic(() => import("@/components/friday/Scene"), { ssr: false });

export default function Home() {
  return (
    <main className="scanlines relative h-screen w-screen overflow-hidden bg-background text-foreground">
      <Scene />
      <div className="scan-bar pointer-events-none absolute inset-0" />
      <div className="vignette pointer-events-none absolute inset-0" />

      <TopHud />
      <EdgeTelemetry />
      <VizRail />
      <StateRail />
      <AnswerLine />
      <InputBar />
      <AudioCues />
    </main>
  );
}
