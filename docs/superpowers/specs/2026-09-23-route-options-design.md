# Route options and traffic incidents — design

Status: **awaiting review** · Date: 2026-09-23 · Builds on
`2026-09-21-maplibre-map-design.md` (TomTom revision, merged in PR #45)

## 1. Problem

Directions always mean "leave now, any road". TomTom Routing can avoid tolls,
motorways, ferries and unpaved roads, plan for a departure or an arrival time,
and say which stretches of the route are congested — none of it is used. The
traffic layer shows flow only, not incidents (crashes, road works, closures).
The agent cannot answer "tránh cao tốc", "8h sáng mai đi mất bao lâu" or
"phải đi lúc mấy giờ để 8h có mặt".

## 2. Decisions already made

- **In scope:** traffic-incident layer; route options in the directions UI;
  the same options for the agent's `get_directions`.
- **Out of scope this round:** Reachable Range (isochrones), incident detail
  popups, traffic-incident tool for the agent.
- **Time:** "Đi ngay / Khởi hành lúc / Đến lúc" — both `depart_at` and
  `arrive_at`, mutually exclusive (TomTom forbids combining them).
- **One route path (approach A):** the options extend the existing route
  intent (`MapView.route`), `POST /geo/route` and `get_directions`, so what the
  agent says and what the map draws come from the same request. Rejected: a
  separate "advanced route" endpoint (two paths that can disagree).
- **Motorbikes avoid motorways by default.** Motorbikes are banned from
  Vietnamese expressways and TomTom's `motorcycle` mode may not encode that, so
  choosing motorbike turns "Tránh cao tốc" on (UI) / defaults
  `avoid: ["motorways"]` (tool). The user can turn it off.

## 3. Contract

Changed in all three places — `src/lib/visualization/types.ts`,
`backend/friday/schemas/visualization.py`,
`contracts/visualization/visualization.v1.json` — with the parity tests.

```ts
export type MapAvoid = "tolls" | "motorways" | "ferries" | "unpaved";

route?: {
  profile: MapProfile;
  waypoints: MapWaypoint[];        // 2–5, unchanged
  avoid?: MapAvoid[];              // vendor-neutral; backend maps to TomTom
  depart_at?: string;              // ISO 8601 with offset
  arrive_at?: string;              // ISO 8601 with offset; excludes depart_at
}
```

`sanitizeMapView` keeps only known `avoid` values (deduplicated), keeps a time
only if it parses with an offset, and drops `arrive_at` when both are present.

## 4. Backend

### 4.1 `POST /geo/route`

`RouteRequest` gains `avoid: list[MapAvoid] = []`, `depart_at: str | None`,
`arrive_at: str | None`. Validation → 422:

- both times given;
- a time without a UTC offset;
- a time more than 5 minutes in the past or more than 1 year ahead.

(The endpoint takes whatever `avoid` it is given; the motorbike default is a UI
and tool concern, not an API one.)

### 4.2 `tomtom.route(waypoints, profile, avoid=(), depart_at=None, arrive_at=None)`

- `avoid` → repeated `avoid=` params: `tolls → tollRoads`,
  `motorways → motorways`, `ferries → ferries`, `unpaved → unpavedRoads`.
- `departAt` / `arriveAt` passed through (RFC 3339 with offset); neither = now.
- Always `sectionType=traffic`.
- Each normalized route gains:

```python
"departure_time": "<ISO from summary.departureTime>",
"arrival_time": "<ISO from summary.arrivalTime>",
"traffic_sections": [{"start": startPointIndex, "end": endPointIndex,
                      "category": "jam" | "road_work" | "road_closure" | "other",
                      "delay_s": delayInSeconds, "magnitude": 0..4}],
```

- Cache key adds `avoid` (sorted) and the time. A route with **no time**
  ("now") is cached for **2 minutes** only — its traffic goes stale; timed
  routes keep the existing LRU behaviour.

### 4.3 `get_directions`

| | Added |
|---|---|
| Input | `avoid` (array of the four values), `depart_at` / `arrive_at` (ISO 8601, offset optional) |
| Defaults | profile `motor_scooter` and `avoid` omitted → `["motorways"]`; `avoid: []` means avoid nothing |
| Time zone | a time without an offset gets the operator's offset from `CLIENT.timezone`, else `+07:00` |
| Output | `departure_time`, `arrival_time` (local `HH:MM` and ISO), `jams` (number of traffic sections with category `jam`), existing `traffic_delay_min` |
| Preview | `map.route` carries `avoid` and the time, so the map redraws the same route |
| Errors | both times, time in the past, unparseable time → error dict saying which |

Description adds: "Use `arrive_at` when the user asks when to leave to arrive
on time; call `get_current_time` first if you need today's date."

## 5. Frontend

### 5.1 Traffic layer

The existing "Giao thông" toggle adds `traffic_incidents` next to
`traffic_flow` in `styleUrl` (`2/incidents_dark` for dark and satellite,
`2/incidents_light` for light). Icons only this round.

### 5.2 Directions panel

```
[🛵 Xe máy][🚗 Ô tô][🚲 Xe đạp][🚶 Đi bộ]
[Đi ngay ▾]  [ 24/09/2026 08:00 ]     ← datetime input only for Khởi hành lúc / Đến lúc
▸ Tùy chọn (1)                         ← ☐ Tránh trạm thu phí  ☑ Tránh cao tốc
                                          ☐ Tránh phà          ☐ Tránh đường đất
9 phút · 2,4 km · chậm 6 phút do kẹt xe
Khởi hành 07:52 → Đến 08:01
```

- Native `<select>` + `<input type="datetime-local">` (no date-picker
  dependency). `mapApi.toOffsetIso(local)` turns the input's naive value into
  ISO with the browser's offset.
- `DirectionsValue` gains `avoid: MapAvoid[]` and
  `time: { kind: "now" } | { kind: "depart" | "arrive"; at: string }`.
- Switching to motorbike adds `motorways` to `avoid`; switching away removes
  it. The checkbox stays user-editable.
- Any change to time or options refetches (backend cache absorbs toggling).
- "Khởi hành → Đến" line from `departure_time` / `arrival_time`; with "Đến
  lúc" the departure time is emphasised (it is the answer).
- **Congestion on the route:** the selected route's `traffic_sections` draw as
  an overlay line: magnitude 1 `#fbbf24`, 2 `#fb923c`, 3–4 `#f87171`;
  `road_closure` `#7f1d1d` dashed. Alternatives stay grey.
- An agent spec with `route.avoid` / a time opens the panel with those values.

## 6. Testing

No test touches the real network.

**Backend**
- `test_tomtom.py`: `avoid` mapping and repetition, only one of
  `departAt`/`arriveAt`, `sectionType=traffic` always sent;
  `traffic_sections`, `departure_time`, `arrival_time` normalized; "now"
  routes expire from the cache after 2 minutes (clock injected), timed routes
  do not.
- `test_geo_route.py`: 422 for both times, missing offset, past, > 1 year;
  options passed through.
- `test_geo_tools.py`: motorbike default `avoid`, explicit `[]` honoured,
  naive time gets `CLIENT.timezone` offset (and `+07:00` without one),
  outputs and preview carry the options.
- `test_contracts`: `MapAvoid` / new route fields parity.

**Frontend**
- `mapApi.spec.ts`: `toOffsetIso`; `styleUrl` with traffic adds incidents.
- `vizNormalize.spec.ts`: `sanitizeMapView` keeps valid options, drops unknown
  `avoid`, naive times, and `arrive_at` when both.
- `map.spec.ts`: "Đến lúc" sends `arrive_at`; motorbike turns "Tránh cao tốc"
  on and car turns it off; the congestion overlay layer exists when the stub
  route has traffic sections; the traffic toggle's style URL has
  `traffic_incidents`.

**Done when** `npm run verify` is green.

## 7. Out of scope

- Reachable Range, incident popups, a traffic-incident agent tool.
- Avoid areas, `alreadyUsedRoads`, tunnels, low-emission zones.
- Saving route preferences between sessions.
