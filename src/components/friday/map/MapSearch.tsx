"use client";

import { useEffect, useId, useState } from "react";
import { shareLocation } from "@/lib/geolocation";
import { useFridayStore } from "@/lib/store";
import { resolvePlace, suggestPlaces, type Place, type Suggestion } from "./mapApi";

const MY_LOCATION_LABEL = "Vị trí của bạn";
/** Suggest is 10K/month: wait for a real word and a pause before asking. */
const MIN_CHARS = 3;
const DEBOUNCE_MS = 400;

type Option = { kind: "me"; place: Place | null } | { kind: "hit"; s: Suggestion };

/** Google-Maps-style search box: debounced TomTom suggestions (via the orchestrator) as an ARIA combobox. */
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
  const [results, setResults] = useState<Suggestion[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const location = useFridayStore((s) => s.location);

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setText(value ?? ""), [value]);

  useEffect(() => {
    const q = text.trim();
    if (!open || q.length < MIN_CHARS) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      setNotice(null);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      suggestPlaces(q, getNear(), ctrl.signal)
        .then((r) => {
          if (r.ok) {
            setResults(r.suggestions);
            setNotice(null);
          } else {
            setResults([]);
            setNotice(r.reason === "quota" ? "Tìm kiếm tạm hết hạn mức" : "Tìm kiếm chưa được cấu hình");
          }
          setActive(-1);
        })
        .catch(() => {}); // aborted or offline: keep the last list
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // getNear is read at search time on purpose; it is not a trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, open]);

  const me: Place | null = location ? { label: MY_LOCATION_LABEL, address: "", lat: location.lat, lon: location.lon } : null;
  const options: Option[] = [
    ...(offerMyLocation ? [{ kind: "me", place: me } as const] : []),
    ...results.map((s) => ({ kind: "hit", s }) as const),
  ];

  const pick = (o: Option) => {
    setOpen(false);
    if (o.kind === "me") {
      if (!o.place) {
        shareLocation(); // user gesture; re-pick once the fix lands
        return;
      }
      setText(o.place.label);
      onPick(o.place);
      return;
    }
    setText(o.s.title);
    resolvePlace(o.s)
      .then((p) => (p ? onPick(p) : setNotice("Không lấy được vị trí địa điểm này")))
      .catch(() => setNotice("Không lấy được vị trí địa điểm này"));
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
      const o = options[active] ?? options[0];
      if (o) {
        e.preventDefault();
        pick(o);
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
          {options.map((o, i) => {
            const title = o.kind === "me" ? (o.place ? MY_LOCATION_LABEL : `${MY_LOCATION_LABEL} (bật chia sẻ vị trí)`) : o.s.title;
            const subtitle = o.kind === "hit" ? o.s.subtitle : "";
            return (
              <li
                key={o.kind === "me" ? "me" : o.s.ref}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={`cursor-pointer px-4 py-2 text-sm ${i === active ? "bg-cyan-400/15" : "hover:bg-cyan-400/10"}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(o)}
              >
                <div className="text-cyan-50">{title}</div>
                {subtitle && <div className="truncate text-xs text-slate-400">{subtitle}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {open && notice && (
        <p role="status" className="friday-map-panel absolute left-0 right-0 top-full mt-1 px-4 py-2 text-xs text-amber-200">
          {notice}
        </p>
      )}
    </div>
  );
}
