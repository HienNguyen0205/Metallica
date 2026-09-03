"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { DoubleSide, Matrix4, Vector3, type Group, type InstancedMesh, type Object3D } from "three";
import {
  useFridayStore,
  type VisualizationSpec,
  type VisualizationType,
  type VizData,
  type VizFocus,
} from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { resolveVisualizationLayout } from "@/lib/visualization/layoutResolver";
import { Connector, Reticle, TechLabel } from "../primitives";
import { HealthCore, RadialGauge, Radar, Waveform } from "./vizRadial";
import { BarChart3D, Heatmap3D, LineChart3D, Timeline3D } from "./vizCharts";
import { Globe3D, Network3D, ParticleFlow } from "./vizSpatial";

interface RendererProps {
  data: VizData;
  color: string;
  accent: string;
}

/**
 * §16 — the whole mapping from semantic type to hologram lives here.
 * Pages and the agent flow only ever emit a spec.
 */
const REGISTRY: Record<VisualizationType, ComponentType<RendererProps>> = {
  radial_gauge: ({ data, ...rest }) => <RadialGauge metrics={data.metrics} {...rest} />,
  health_core: ({ data, ...rest }) => <HealthCore metrics={data.metrics} {...rest} />,
  radar: ({ data, ...rest }) => <Radar metrics={data.metrics} {...rest} />,
  waveform: ({ ...rest }) => <Waveform {...rest} />,
  line_3d: ({ data, ...rest }) => <LineChart3D series={data.series} {...rest} />,
  bar_3d: ({ data, ...rest }) => <BarChart3D series={data.series} {...rest} />,
  heatmap_3d: ({ data, ...rest }) => <Heatmap3D series={data.series} {...rest} />,
  timeline: ({ data, ...rest }) => <Timeline3D events={data.events} {...rest} />,
  network: ({ data, ...rest }) => <Network3D nodes={data.nodes} links={data.links} {...rest} />,
  globe: ({ data, ...rest }) => <Globe3D points={data.points} {...rest} />,
  particle_flow: ({ ...rest }) => <ParticleFlow {...rest} />,
};

export interface VizTag {
  label: string;
  detail: string;
}

/**
 * The drill-down decision: clicking the element already in focus releases it,
 * clicking anything else focuses that.
 *
 * Lifted out of the click handler so it can be checked without a moving scene.
 * Proving this through the canvas means clicking a screen coordinate at a node
 * that bobs every frame, under a camera that drifts and swings — and a click
 * that misses clears the focus too, so a release and a miss-then-hit are
 * indistinguishable from the outside. Two attempts at an end-to-end test for
 * it were each either flaky or unable to fail; see tests/ui/drilldown.spec.ts.
 */
export function nextFocus(
  current: VizFocus | null,
  tag: VizTag,
  position: [number, number, number],
): VizFocus | null {
  return current?.label === tag.label ? null : { ...tag, position };
}

function findVizTag(obj: Object3D): VizTag | null {
  let o: Object3D | null = obj;
  while (o) {
    if (o.userData?.viz) return o.userData.viz as VizTag;
    o = o.parent;
  }
  return null;
}

/**
 * §5 interaction:"drill_down" — click an element to inspect it, click again to release.
 *
 * The focus position is recorded in **world** space. It used to be converted to
 * this group's local space and the marker rendered as a child, which is only
 * equivalent while the group sits at the origin at scale 1 — true for a lone
 * visualization and false for every node of a multi-viz scene, where the marker
 * landed at the wrong place. World coordinates let one marker at the scene root
 * serve both, which is also what let the three copies of this render path
 * collapse into one.
 */
function DrillDown({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);
  const [hover, setHover] = useState<{ tag: VizTag; position: [number, number, number] } | null>(
    null,
  );

  const resolveTag = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    let tag = findVizTag(e.object);
    const world = new Vector3();
    const bar = e.object.userData?.vizBar as { label: string; values: number[] } | undefined;

    if (!tag && bar && typeof e.instanceId === "number") {
      tag = {
        label: `${bar.label}-${String(e.instanceId + 1).padStart(2, "0")}`,
        detail: String(bar.values[e.instanceId]),
      };
      const mesh = e.object as InstancedMesh;
      const m = new Matrix4();
      mesh.getMatrixAt(e.instanceId, m);
      world.setFromMatrixPosition(m).applyMatrix4(mesh.matrixWorld);
    }
    if (!tag) return null;
    if (world.lengthSq() === 0) e.object.getWorldPosition(world);
    return { tag, position: [world.x, world.y, world.z] as [number, number, number] };
  };

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!enabled) return;
    const hit = resolveTag(e);
    if (!hit) return;
    setHover(null);
    setFocus(nextFocus(focus, hit.tag, hit.position));
  };

  const onPointerOver = (e: ThreeEvent<PointerEvent>) => {
    if (!enabled) return;
    const hit = resolveTag(e);
    if (hit) {
      setHover(hit);
      document.body.style.cursor = "pointer";
    }
  };
  const onPointerOut = () => {
    setHover(null);
    document.body.style.cursor = "auto";
  };

  return (
    <group
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onPointerMissed={() => enabled && setFocus(null)}
    >
      {children}
      {hover && (
        <group position={hover.position}>
          <TechLabel position={[0, 0.38, 0]} color="#e5f6ff" size={0.07} opacity={0.95}>
            {hover.tag.label}
          </TechLabel>
        </group>
      )}
    </group>
  );
}

/** Inspection reticle that locks onto the drilled-in element. */
function FocusMarker() {
  const focus = useFridayStore((s) => s.focus);
  const state = useFridayStore((s) => s.state);
  const look = STATE_LOOK[state];
  const ref = useRef<Group>(null);

  useFrame(({ clock }) => {
    if (!ref.current) return;
    const t = clock.elapsedTime;
    ref.current.scale.setScalar(1 + Math.sin(t * 3.2) * 0.14);
  });

  if (!focus) return null;

  return (
    <>
      <Connector to={focus.position} color={look.color} opacity={0.35} />
      <group position={focus.position}>
        <group ref={ref}>
          <mesh>
            <ringGeometry args={[0.27, 0.295, 48]} />
            <meshBasicMaterial
              color={look.color}
              transparent
              opacity={0.75}
              side={DoubleSide}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        </group>
        <Reticle position={[0, 0, 0]} color={look.color} size={0.2} opacity={0.9} />
        <TechLabel position={[0, 0.52, 0]} color={look.color} size={0.085} decode>
          {focus.label}
        </TechLabel>
        <TechLabel position={[0, -0.44, 0]} color="#e5f6ff" size={0.055} opacity={0.8}>
          {focus.detail}
        </TechLabel>
      </group>
    </>
  );
}

function VizNode({
  spec,
  lifecycle,
  count,
  index,
  viewportWidth,
  color,
  accent,
}: {
  spec: VisualizationSpec;
  lifecycle: "materializing" | "active" | "updating" | "settling";
  count: number;
  index: number;
  viewportWidth: number;
  color: string;
  accent: string;
}) {
  // `spec.type` arrives off the wire, so an unknown one renders nothing rather
  // than throwing inside the canvas.
  const Renderer = REGISTRY[spec.type];
  if (!Renderer) return null;

  const layout = resolveVisualizationLayout(spec, { count, index, viewportWidth, hasCore: true });

  return (
    <group position={layout.position} scale={layout.scale}>
      <DrillDown enabled={spec.interaction !== "none"}>
        <Entrance lifecycle={lifecycle} index={index}>
          <Pulse enabled={spec.animation === "pulse"}>
            <Renderer data={spec.data ?? {}} color={color} accent={accent} />
          </Pulse>
        </Entrance>
        {spec.title && (
          <TechLabel position={[0, 2.35, 0]} color={color} size={0.11} opacity={0.9} decode>
            {spec.title}
          </TechLabel>
        )}
      </DrillDown>
    </group>
  );
}

/** Entrance wired to the store lifecycle: scale + rise, then settle to active. */
function Entrance({
  lifecycle,
  index,
  children,
}: {
  lifecycle: string;
  index: number;
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
      useFridayStore.getState().settleVisualization(index);
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
   * another keeps the count at 1, and a focus reticle left pointing at the
   * previous hologram's node is stale.
   */
  const vizKey = entries.map((e) => `${e.spec.type}:${e.spec.title ?? ""}`).join("|");
  useEffect(() => {
    setFocus(null);
  }, [vizKey, setFocus]);

  if (entries.length === 0) return null;

  // §13/§14 — multiple visualizations coexist with deterministic spatial layout
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : 1440;

  return (
    <group>
      {entries.map((entry, i) => (
        <VizNode
          key={`${entry.spec.type}-${entry.spec.title ?? i}-${i}`}
          spec={entry.spec}
          lifecycle={entry.lifecycle}
          count={entries.length}
          index={i}
          viewportWidth={viewportWidth}
          color={entry.spec.theme?.color ?? look.color}
          accent={entry.spec.theme?.accent ?? look.accent}
        />
      ))}
      <FocusMarker />
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
