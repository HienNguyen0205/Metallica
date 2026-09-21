"use client";

import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { useFrame } from "@react-three/fiber";
import { type Group } from "three";
import {
  useFridayStore,
  type VisualizationSpec,
  type VisualizationType,
  type VizData,
  type VizLifecycle,
} from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { resolveVisualizationLayout, sceneEntries } from "@/lib/visualization/layoutResolver";
import { TechLabel } from "../primitives";
import { RadialGauge, Radar, Waveform } from "./vizRadial";
import { BarChart3D, LineChart3D, Timeline3D } from "./vizCharts";
import { SankeyFlow } from "./vizFlow";
import { Network3D } from "./vizSpatial";
import { Globe3D } from "./globe/GlobeVisualization";

interface RendererProps {
  data: VizData;
  color: string;
  accent: string;
  /**
   * §5 interaction — false only for preview specs (`interaction: "none"`).
   * Each visualization owns its focus now, so it is the renderer that decides
   * whether its elements are pickable; the old shared `DrillDown` wrapper is
   * gone and every pointer surface here is native.
   */
  interactive: boolean;
}

/**
 * §16 — the whole mapping from semantic type to hologram lives here.
 * Pages and the agent flow only ever emit a spec.
 */
const REGISTRY: Record<VisualizationType, ComponentType<RendererProps>> = {
  radial_gauge: ({ data, ...rest }) => <RadialGauge metrics={data.metrics} {...rest} />,
  radar: ({ data, ...rest }) => <Radar metrics={data.metrics} {...rest} />,
  waveform: ({ ...rest }) => <Waveform {...rest} />,
  line_3d: ({ data, ...rest }) => <LineChart3D series={data.series} {...rest} />,
  bar_3d: ({ data, ...rest }) => <BarChart3D series={data.series} {...rest} />,
  timeline: ({ data, ...rest }) => <Timeline3D events={data.events} {...rest} />,
  network: ({ data, ...rest }) => <Network3D nodes={data.nodes} links={data.links} {...rest} />,
  globe: ({ data, ...rest }) => <Globe3D points={data.points} routes={data.routes} {...rest} />,
  sankey_flow: ({ data, ...rest }) => <SankeyFlow nodes={data.nodes} links={data.links} {...rest} />,
  map: () => null, // drawn by the DOM map layer (spec §5)
};

function VizNode({
  id,
  spec,
  lifecycle,
  count,
  index,
  color,
  accent,
}: {
  id: number;
  spec: VisualizationSpec;
  lifecycle: VizLifecycle;
  count: number;
  index: number;
  color: string;
  accent: string;
}) {
  // `spec.type` arrives off the wire, so an unknown one renders nothing rather
  // than throwing inside the canvas.
  const Renderer = REGISTRY[spec.type];
  if (!Renderer) return null;

  const layout = resolveVisualizationLayout(spec, { count, index });

  return (
    <group position={layout.position} scale={layout.scale}>
      <Entrance lifecycle={lifecycle} id={id}>
        <Pulse enabled={spec.animation === "pulse"}>
          <Renderer
            data={spec.data ?? {}}
            color={color}
            accent={accent}
            interactive={spec.interaction !== "none"}
          />
        </Pulse>
      </Entrance>
      {spec.title && (
        <TechLabel position={[0, 2.35, 0]} color={color} size={0.11} opacity={0.9} decode>
          {spec.title}
        </TechLabel>
      )}
    </group>
  );
}

/** Entrance wired to the store lifecycle: scale + rise, then settle to active. */
function Entrance({
  lifecycle,
  id,
  children,
}: {
  lifecycle: VizLifecycle;
  id: number;
  children: ReactNode;
}) {
  const ref = useRef<Group>(null);
  const progress = useRef(lifecycle === "materializing" ? 0 : 1);
  const settled = useRef(lifecycle !== "materializing");

  useFrame((_, delta) => {
    const g = ref.current;
    if (!g) return;
    if (settled.current) {
      g.scale.setScalar(1);
      g.position.y = 0;
      return;
    }
    progress.current = Math.min(1, progress.current + delta * 2.2);
    const t = progress.current;
    const ease = 1 - Math.pow(1 - t, 3);
    g.scale.setScalar(0.6 + 0.4 * ease);
    g.position.y = (1 - ease) * 0.4;
    if (t >= 1) {
      settled.current = true;
      g.scale.setScalar(1);
      g.position.y = 0;
      useFridayStore.getState().settleVisualization(id);
    }
  });

  return <group ref={ref}>{children}</group>;
}

export default function FridayVisualization() {
  const entries = useFridayStore((s) => s.visualizations);
  const state = useFridayStore((s) => s.state);
  const setFocus = useFridayStore((s) => s.setFocus);
  const look = STATE_LOOK[state];

  /**
   * Keyed on what is on screen, not on how many: swapping one visualization for
   * another keeps the count at 1, and a focus left on the previous hologram's
   * element is stale — every owner would re-render it into their selection state.
   */
  const vizKey = entries.map((e) => `${e.spec.type}:${e.spec.title ?? ""}`).join("|");
  useEffect(() => {
    setFocus(null);
  }, [vizKey, setFocus]);

  const scene = sceneEntries(entries);
  if (scene.length === 0) return null;

  // §13/§14 — multiple visualizations coexist with deterministic spatial layout
  return (
    <group>
      {scene.map((entry, i) => (
        <VizNode
          key={entry.id}
          id={entry.id}
          spec={entry.spec}
          lifecycle={entry.lifecycle}
          count={scene.length}
          index={i}
          color={entry.spec.theme?.color ?? look.color}
          accent={entry.spec.theme?.accent ?? look.accent}
        />
      ))}
    </group>
  );
}

/** §7 — "pulse" spec animation: a slow breath applied to the whole viz. */
function Pulse({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const ref = useRef<Group>(null);
  useFrame(() => {
    if (!ref.current) return;
    ref.current.scale.setScalar(enabled ? 1 + Math.sin(performance.now() * 0.002) * 0.02 : 1);
  });
  return <group ref={ref}>{children}</group>;
}
