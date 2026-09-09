"use client";

/**
 * Back-compat barrel: the HUD components used to live in this single file and
 * were split per component (TopHud, EdgeTelemetry, AnswerLine, VizRail,
 * FocusPanel, StateRail, AudioCues + useHudDepth/devRails). Import from the
 * module directly for new code; this path keeps existing imports working.
 */
export { AudioCues } from "./AudioCues";
export { TopHud } from "./TopHud";
export { EdgeTelemetry } from "./EdgeTelemetry";
export { AnswerLine } from "./AnswerLine";
export { VizRail } from "./VizRail";
export { FocusPanel } from "./FocusPanel";
export { StateRail } from "./StateRail";
export { useHudDepth } from "./useHudDepth";
export { devRailsEnabled } from "./devRails";
