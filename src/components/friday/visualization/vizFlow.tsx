"use client";

import { useEffect } from "react";
import { Color } from "three";
import type { MetricDatum } from "@/lib/store";
import { HairLine, TechLabel, useMaterialize } from "../primitives";

export interface FlowChartProps {
  metrics?: MetricDatum[];
  color: string;
  accent: string;
}

const DEFAULT_FUNNEL: MetricDatum[] = [
  { label: "VISIT", value: 100 },
  { label: "SIGNUP", value: 62 },
  { label: "ACTIVATE", value: 44 },
  { label: "PAY", value: 27 },
];

const STAGE_H = 0.32;
const STAGE_GAP = 0.14;
const FUNNEL_MAX = 6;

export function Funnel3D({ metrics = DEFAULT_FUNNEL, color, accent }: FlowChartProps) {
  const ref = useMaterialize(0.8);
  const data = (metrics.length ? metrics : DEFAULT_FUNNEL).slice(0, FUNNEL_MAX);
  const max = Math.max(...data.map((m) => m.value), 1);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && metrics.length > FUNNEL_MAX) {
      console.warn(`[friday] funnel_3d renders ${FUNNEL_MAX} stages; ignoring ${metrics.length - FUNNEL_MAX}`);
    }
  }, [metrics.length]);

  const top = ((data.length - 1) * (STAGE_H + STAGE_GAP)) / 2;
  const cold = new Color(color);
  const hot = new Color(accent);

  return (
    <group ref={ref} position={[0, 0.45, 1.1]}>
      {data.map((m, i) => {
        const w = 0.6 + 3.2 * (m.value / max);
        const y = top - i * (STAGE_H + STAGE_GAP);
        const pct = i === 0 ? 100 : Math.round((m.value / data[0].value) * 100);
        const t = max > 0 ? m.value / max : 0;
        const fill = `#${cold.clone().lerp(hot, t).getHexString()}`;
        return (
          <group key={m.label} position={[0, y, 0]}>
            <mesh
              visible={false}
              userData={{ viz: { label: m.label.toUpperCase(), detail: `${m.value} · ${pct}% OF TOP` } }}
            >
              <boxGeometry args={[w + 0.3, STAGE_H + 0.1, 0.4]} />
            </mesh>
            <mesh>
              <boxGeometry args={[w, STAGE_H, 0.16]} />
              <meshBasicMaterial color={fill} transparent opacity={0.72} toneMapped={false} depthWrite={false} />
            </mesh>
            <TechLabel position={[-w / 2 - 0.2, 0, 0]} color={color} size={0.075} anchorX="right" decode>
              {m.label}
            </TechLabel>
            <TechLabel position={[w / 2 + 0.2, 0, 0]} color="#e5f6ff" size={0.075} opacity={0.85} anchorX="left">
              {String(m.value)}
            </TechLabel>
            <TechLabel position={[0, -STAGE_H / 2 - 0.1, 0]} color={color} size={0.055} opacity={0.6}>
              {i === 0 ? "100% · TOP" : `${pct}% OF PREV`}
            </TechLabel>
            {i < data.length - 1 && (
              <HairLine points={[[-w / 2 + 0.3, -STAGE_H / 2 - 0.02, 0], [w / 2 - 0.3, -STAGE_H / 2 - 0.02, 0]]} color={color} opacity={0.25} lineWidth={1} />
            )}
          </group>
        );
      })}
    </group>
  );
}
