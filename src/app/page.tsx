import {
  AnswerLine,
  AudioCues,
  EdgeTelemetry,
  FocusPanel,
  StateRail,
  TopHud,
  VizRail,
} from "@/components/friday/hud/Hud";
import InputBar from "@/components/friday/hud/InputBar";
import ConfirmPrompt from "@/components/friday/hud/ConfirmPrompt";
import { LiveIndicator, ToolHud } from "@/components/friday/hud/ToolHud";
import SceneIsland from "@/components/friday/SceneIsland";

/**
 * Always dynamically rendered: src/proxy.ts mints a per-request CSP nonce for
 * Next's inline hydration scripts, and a nonce cannot be injected into a page
 * generated at build time. (A live hologram has no use for a static
 * prerender anyway.)
 */
export const dynamic = "force-dynamic";

/**
 * `h-dvh`, not `h-screen`: `100vh` on mobile is the height with the browser
 * toolbar collapsed, so the scene overflowed by the toolbar's height while it
 * was still shown — a page that scrolls, which §3 forbids. The desktop
 * viewports the suite runs at have no collapsing toolbar to catch it.
 */
export default function Home() {
  return (
    <main className="scanlines relative h-dvh w-screen overflow-hidden bg-background text-foreground">
      <SceneIsland />
      <div className="scan-bar pointer-events-none absolute inset-0" />
      <div className="vignette pointer-events-none absolute inset-0" />

      <TopHud />
      <LiveIndicator />
      <EdgeTelemetry />
      <VizRail />
      <StateRail />
      <ToolHud />
      <AnswerLine />
      <FocusPanel />
      <InputBar />
      <ConfirmPrompt />
      <AudioCues />
    </main>
  );
}
