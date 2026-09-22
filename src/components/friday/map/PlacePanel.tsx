"use client";

import { useEffect, useState } from "react";
import { useFridayStore } from "@/lib/store";
import { reverseGeocode, type Endpoint, type Place } from "./mapApi";

export interface MenuState {
  x: number;
  y: number;
  lat: number;
  lon: number;
}

export function myLocationEndpoint(): Endpoint | null {
  const loc = useFridayStore.getState().location;
  return loc ? { lat: loc.lat, lon: loc.lon, label: "Vị trí của bạn" } : null;
}

const coords = (lat: number, lon: number) => `${lat.toFixed(6)}, ${lon.toFixed(6)}`;

export function PlacePanel({
  place,
  onClose,
  onDirectionsTo,
  onDirectionsFrom,
}: {
  place: Place;
  onClose: () => void;
  onDirectionsTo: (e: Endpoint) => void;
  onDirectionsFrom: (e: Endpoint) => void;
}) {
  const [address, setAddress] = useState(place.address);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setAddress(place.address);
    setCopied(false);
    if (place.address) return;
    const ctrl = new AbortController();
    reverseGeocode(place.lat, place.lon, ctrl.signal)
      .then((hit) => hit && setAddress(hit.address))
      .catch(() => {});
    return () => ctrl.abort();
  }, [place]);

  const here: Endpoint = { lat: place.lat, lon: place.lon, label: place.label };
  const copy = () => {
    void navigator.clipboard?.writeText(coords(place.lat, place.lon)).then(() => setCopied(true));
  };

  return (
    <section
      data-testid="place-card"
      aria-label={place.label}
      className="friday-map-panel absolute bottom-24 left-4 z-10 w-[380px] max-w-[calc(100vw-2rem)] p-4 md:bottom-auto md:top-32"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-cyan-50">{place.label}</h2>
          {place.category && <div className="text-xs uppercase tracking-wider text-cyan-300/80">{place.category}</div>}
        </div>
        <button type="button" aria-label="Đóng" className="text-slate-400 hover:text-cyan-100" onClick={onClose}>
          ✕
        </button>
      </div>
      {address && <p className="mt-2 text-sm text-slate-300">{address}</p>}
      <p className="mt-1 font-mono text-xs text-slate-400">{coords(place.lat, place.lon)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" className="rounded-full bg-cyan-400 px-3 py-1.5 text-sm font-medium text-slate-950" onClick={() => onDirectionsTo(here)}>
          ↱ Chỉ đường
        </button>
        <button type="button" className="friday-map-chip" onClick={() => onDirectionsFrom(here)}>
          Từ đây
        </button>
        <button type="button" className="friday-map-chip" onClick={copy}>
          {copied ? "Đã sao chép" : "Sao chép tọa độ"}
        </button>
      </div>
    </section>
  );
}

export function ContextMenu({
  menu,
  onClose,
  onFrom,
  onTo,
  onWhatsHere,
}: {
  menu: MenuState;
  onClose: () => void;
  onFrom: (e: Endpoint) => void;
  onTo: (e: Endpoint) => void;
  onWhatsHere: (lat: number, lon: number) => void;
}) {
  const point: Endpoint = { lat: menu.lat, lon: menu.lon, label: coords(menu.lat, menu.lon) };
  const item = "block w-full px-4 py-2 text-left text-sm hover:bg-cyan-400/10";
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div
      role="menu"
      aria-label="Tùy chọn vị trí"
      className="friday-map-panel absolute z-20 w-56 py-1"
      style={{ left: menu.x, top: menu.y }}
    >
      <button type="button" role="menuitem" className={item} onClick={run(() => onFrom(point))}>
        Chỉ đường từ đây
      </button>
      <button type="button" role="menuitem" className={item} onClick={run(() => onTo(point))}>
        Chỉ đường đến đây
      </button>
      <button type="button" role="menuitem" className={item} onClick={run(() => onWhatsHere(menu.lat, menu.lon))}>
        Đây là đâu?
      </button>
      <button
        type="button"
        role="menuitem"
        className={item}
        onClick={run(() => void navigator.clipboard?.writeText(coords(menu.lat, menu.lon)))}
      >
        Sao chép tọa độ
      </button>
    </div>
  );
}
