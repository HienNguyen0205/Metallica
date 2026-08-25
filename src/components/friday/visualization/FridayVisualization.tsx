"use client";

import { useEffect, useRef, type ComponentType, type ReactNode } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { DoubleSide, Matrix4, Vector3, type Group, type InstancedMesh, type Object3D } from "three";
import {
  useFridayStore,
  type VisualizationSpec,
  type VisualizationType,
  type VizData,
} from "@/lib/store";
import { STATE_LOOK } from "@/lib/stateLook";
import { Connector, Reticle, TechLabel } from "../primitives";
import { HealthCore, RadialGauge, Radar, Waveform } from "./vizRadial";
import { BarChart3D, LineChart3D, Timeline3D } from "./vizCharts";
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
  timeline: ({ data, ...rest }) => <Timeline3D events={data.events} {...rest} />,
  network: ({ data, ...rest }) => <Network3D nodes={data.nodes} links={data.links} {...rest} />,
  globe: ({ data, ...rest }) => <Globe3D points={data.points} {...rest} />,
  particle_flow: ({ ...rest }) => <ParticleFlow {...rest} />,
};

interface VizTag {
  label: string;
  detail: string;
}

function findVizTag(obj: Object3D): VizTag | null {
  let o: Object3D | null = obj;
  while (o) {
    if (o.userData?.viz) return o.userData.viz as VizTag;
    o = o.parent;
  }
  return null;
}

/** §5 interaction:"drill_down" — click an element to inspect it, click again to release. */
function DrillDown({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const ref = useRef<Group>(null);
  const focus = useFridayStore((s) => s.focus);
  const setFocus = useFridayStore((s) => s.setFocus);

  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!enabled || !ref.current) return;
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
    if (!tag) return;

    if (focus?.label === tag.label) {
      setFocus(null);
      return;
    }

    if (world.lengthSq() === 0) e.object.getWorldPosition(world);
    const local = ref.current.worldToLocal(world.clone());
    setFocus({ ...tag, position: [local.x, local.y, local.z] });
  };

  const onPointerOver = (e: ThreeEvent<PointerEvent>) => {
    if (enabled && findVizTag(e.object)) document.body.style.cursor = "pointer";
  };
  const onPointerOut = () => {
    document.body.style.cursor = "auto";
  };

  return (
    <group
      ref={ref}
      onClick={onClick}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
      onPointerMissed={() => enabled && setFocus(null)}
    >
      {children}
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
        <TechLabel position={[0, 0.52, 0]} color={look.color} size={0.085}>
          {focus.label}
        </TechLabel>
        <TechLabel position={[0, -0.44, 0]} color="#e5f6ff" size={0.055} opacity={0.8}>
          {focus.detail}
        </TechLabel>
      </group>
    </>
  );
}

export default function FridayVisualization({ spec }: { spec?: VisualizationSpec | null }) {
  const stored = useFridayStore((s) => s.visualization);
  const state = useFridayStore((s) => s.state);
  const setFocus = useFridayStore((s) => s.setFocus);
  const active = spec ?? stored;
  const look = STATE_LOOK[state];

  useEffect(() => {
    setFocus(null);
  }, [active, setFocus]);

  if (!active) return null;

  const Renderer = REGISTRY[active.type];
  if (!Renderer) return null;

  const color = active.theme?.color ?? look.color;
  const accent = active.theme?.accent ?? look.accent;

  return (
    <group position={active.position ?? [0, 0, 0]} scale={active.scale ?? 1}>
      <DrillDown enabled={active.interaction !== "none"}>
        <Pulse enabled={active.animation === "pulse"}>
          <Renderer data={active.data ?? {}} color={color} accent={accent} />
        </Pulse>
        {active.title && (
          <TechLabel position={[0, 2.35, 0]} color={color} size={0.11} opacity={0.9}>
            {active.title}
          </TechLabel>
        )}
        <FocusMarker />
      </DrillDown>
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
