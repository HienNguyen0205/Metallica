"use client";

import { useEffect, useId, useState } from "react";
import { shareLocation } from "@/lib/geolocation";
import { useFridayStore } from "@/lib/store";
import { searchPlaces, type Place } from "./mapApi";

const MY_LOCATION_LABEL = "Vị trí của bạn";

/** Google-Maps-style search box: debounced MapTiler autocomplete as an ARIA combobox. */
export function MapSearch({
  label,
  placeholder,
  value,
  getNear,
  onPick,
  offerMyLocation = false,
  testId,
}: {
  label: string;
  placeholder: string;
  value?: string;
  getNear: () => { lat: number; lon: number } | null;
  onPick: (place: Place) => void;
  offerMyLocation?: boolean;
  testId?: string;
}) {
  const [text, setText] = useState(value ?? "");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const location = useFridayStore((s) => s.location);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setText(value ?? ""), [value]);

  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      searchPlaces(q, getNear(), ctrl.signal)
        .then((r) => {
          setResults(r);
          setActive(-1);
        })
        .catch(() => {}); // aborted or offline: keep the last list
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // getNear is read at search time on purpose; it is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open]);

  const mine: Place | null =
    offerMyLocation && location ? { label: MY_LOCATION_LABEL, address: "", lat: location.lat, lon: location.lon } : null;
  const options = offerMyLocation ? [mine ?? { label: `${MY_LOCATION_LABEL} (bật chia sẻ vị trí)`, address: "", lat: NaN, lon: NaN }, ...results] : results;

  const pick = (p: Place) => {
    setOpen(false);
    if (Number.isNaN(p.lat)) {
      shareLocation(); // user gesture; re-pick once the fix lands
      return;
    }
    setText(p.label);
    onPick(p);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      const p = options[active] ?? options[0];
      if (p) {
        e.preventDefault();
        pick(p);
      }
    } else if (e.key === "Escape") {
      // Close the list only; the map's own Esc must not fire as well.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="relative w-80 max-w-[70vw]" data-testid={testId}>
      <input
        role="combobox"
        aria-label={label}
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        className="friday-map-chip w-full !rounded-xl !px-4 !py-2.5 !text-sm outline-none placeholder:text-slate-400 focus:border-cyan-300"
        placeholder={placeholder}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
      />
      {open && options.length > 0 && (
        <ul id={listId} role="listbox" className="friday-map-panel absolute left-0 right-0 top-full mt-1 max-h-80 overflow-auto py-1">
          {options.map((p, i) => (
            <li
              key={`${p.label}-${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`cursor-pointer px-4 py-2 text-sm ${i === active ? "bg-cyan-400/15" : "hover:bg-cyan-400/10"}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(p)}
            >
              <div className="text-cyan-50">{p.label}</div>
              {p.address && p.address !== p.label && <div className="truncate text-xs text-slate-400">{p.address}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
