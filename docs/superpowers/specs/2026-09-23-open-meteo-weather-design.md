# Open-Meteo weather — design

Status: **awaiting review** · Date: 2026-09-23 · Builds on
`2026-09-23-route-options-design.md` (route times and traffic sections)

## 1. Problem

FRIDAY has no weather source. Weather questions go to `search_web`, whose
description has to warn that the numbers "may lag" — a search index is not a
forecast. Directions know when the operator will pass each stretch of road
(departure time + per-maneuver durations) but not whether it will be raining
there, which matters most on the default travel mode, the motorbike.

Open-Meteo answers both: a keyless JSON forecast by coordinate, many
coordinates per request, hourly to 16 days.

## 2. Decisions already made

- **In scope:** a `get_weather` agent tool; weather along a route, for both
  the agent (`get_directions`) and the map (`POST /geo/route` → map overlay
  and directions panel).
- **Out of scope this round:** air quality, multi-city globe, historical data,
  15-minute forecasts, proactive alerts, flood/marine APIs.
- **One route path:** route weather rides on the existing `POST /geo/route`
  response, so the map (user-driven or opened by an agent `map` viz) and
  `get_directions` read the same computation. Rejected: a separate
  `/weather/route` endpoint the map would call second (two requests that can
  disagree about the route).
- **Viz follows the question:** `get_weather` takes a `span`, and the preview
  picks the viz — `now` gauges, `today` 24 h line, `week` 7-day bars.
- **Weather never breaks a route.** Any weather failure yields a route with
  `weather.status = "unavailable"`, never a failed route.
- **Licence:** the free endpoint is non-commercial only (~10K calls/day) and
  the data is CC BY 4.0, so the UI credits "Open-Meteo" wherever weather is
  shown. A commercial deployment sets `OPEN_METEO_API_KEY`.

## 3. Open-Meteo client — `backend/friday/weather/openmeteo.py`

Same shape as `geo/tomtom.py`: `urllib` + `asyncio.to_thread`, no HTTP
dependency, module-level LRU with per-entry expiry.

```python
async def forecast(
    points: list[tuple[float, float]],
    *,
    current: list[str] = (),
    hourly: list[str] = (),
    daily: list[str] = (),
    forecast_days: int = 1,
) -> list[dict[str, Any]]:   # one Open-Meteo location object per point, same order
```

- One request for all points: `latitude=a,b,c&longitude=x,y,z`
  (Open-Meteo returns a list when given several; a single point is wrapped).
- `timezone=auto`, so times come back in each point's local time with
  `utc_offset_seconds`; `wind_speed_unit=kmh`.
- Points are rounded to 2 decimals (~1 km) before they leave — privacy, and
  the cache key. Duplicate rounded points are sent once and fanned back out.
- Cache: `tomtom._Lru(256)` reused (not copied), key = rounded points + field lists + `forecast_days`,
  **TTL 15 minutes** (Open-Meteo's models update hourly at best). A clock hook
  `_now` like `tomtom._now` for tests.
- Base URL: `https://api.open-meteo.com/v1/forecast`; with
  `OPEN_METEO_API_KEY` set, `https://customer-api.open-meteo.com/v1/forecast`
  plus `apikey=`. Test hook `FRIDAY_OPEN_METEO_URL`, like `FRIDAY_TOMTOM_URL`.
- Timeout 4 s. Every failure — HTTP error (Open-Meteo sends
  `{"error": true, "reason": …}`), 429, timeout, bad JSON — raises
  `WeatherUnavailable(reason)`.

### 3.1 Weather codes — `backend/friday/weather/codes.py`

`describe(code: int) -> str`: WMO weather code → short Vietnamese text
(`0` "trời quang", `1–3` "ít mây" / "nhiều mây" / "u ám", `45/48` "sương mù",
`51–57` "mưa phùn", `61/63/65` "mưa nhẹ" / "mưa vừa" / "mưa to",
`80/81/82` "mưa rào nhẹ" / "mưa rào" / "mưa rào lớn", `95` "dông",
`96/99` "dông kèm mưa đá", snow codes "tuyết"). Unknown → "không rõ".

## 4. `get_weather` tool — `backend/friday/weather/tools.py`

| | |
|---|---|
| Input | `place`: place name or `"my_location"` (default `"my_location"`); `span`: `"now" \| "today" \| "week"` (default `"now"`) |
| Place | resolved with `geo/tools.py`'s `_operator` / `_first` / `NO_LOCATION` — the same path `get_directions` uses (TomTom fuzzy search, operator position as bias) |
| Risk / caps | `risk="low"`, `capabilities=("geo.read",)`, `timeout_s=15` |
| Errors | error dict, like every tool: no location shared, no place match, TomTom quota/outage (same messages as `get_directions`), `"weather service unavailable: <reason>"`, unknown `span` |

Output (only the block the span needs, plus `place`):

```python
{
  "place": {"label": "Hà Nội", "lat": 21.03, "lon": 105.85},
  "span": "today",
  # span == "now"
  "current": {"time": "14:15", "temp_c": 33.1, "feels_like_c": 38.0,
              "humidity": 62, "wind_kmh": 11.2, "uv": 7.4,
              "precip_mm": 0.0, "weather": "nhiều mây"},
  # span == "today": the next 24 hours from the current hour
  "hourly": [{"time": "14:00", "temp_c": 33.1, "rain_prob": 20,
              "precip_mm": 0.0, "weather": "nhiều mây"}, ...],
  # span == "week": 7 days starting today
  "daily": [{"date": "2026-09-23", "max_c": 34.0, "min_c": 26.1,
             "rain_prob": 70, "precip_mm": 12.4, "weather": "mưa rào"}, ...],
}
```

Open-Meteo fields: current `temperature_2m, apparent_temperature,
relative_humidity_2m, wind_speed_10m, uv_index, precipitation, weather_code`;
hourly `temperature_2m, precipitation_probability, precipitation,
weather_code` (`forecast_days=2`, sliced to 24 h from now); daily
`temperature_2m_max, temperature_2m_min, precipitation_probability_max,
precipitation_sum, weather_code` (`forecast_days=7`).

### 4.1 Preview

| span | viz | data |
|---|---|---|
| `now` | `radial_gauge` | metrics: Nhiệt độ (°C), Độ ẩm (%), Gió (km/h), UV |
| `today` | `line_3d` | series: `NHIỆT ĐỘ` (24 points), `% MƯA` (24 points) |
| `week` | `bar_3d` | series: `CAO`, `THẤP`, `% MƯA` (7 points each) |

Title: `"<PLACE> · BÂY GIỜ" / "· 24 GIỜ" / "· 7 NGÀY"`, uppercased, ≤ 40 chars.

Known ceilings of the renderer (`normalization.ts`), accepted:
gauge values clamp to 0–100 (wind above 100 km/h pins the gauge; UV reads as
a short arc), and series values below 0 clamp to 0 (sub-zero highland nights).

### 4.2 Prompt changes

- `get_weather` description: "Current conditions and forecast for a place or
  the operator's location. span: now (right now), today (next 24 hours),
  week (7 days). Prefer this over search_web for any weather question."
- `search_web` description: drop "weather" from its examples and the
  fast-moving-numbers sentence.
- `agent.py`: "local weather" moves from the `get_client_location` hint to
  "for weather, call `get_weather` (it finds their location itself)".

## 5. Weather along a route — `backend/friday/weather/route_weather.py`

```python
async def attach_weather(routes: list[dict]) -> list[dict]
```

Takes normalized TomTom routes (`tomtom._normalize` shape) and returns
**copies**, each with a `weather` key. It never mutates its input — those
dicts live in TomTom's route cache.

### 5.1 Sampling

For each route:

1. Cumulative time at each maneuver = running sum of `maneuver.duration_s`
   (TomTom's per-step times, traffic included), anchored at the route's
   `departure_time`.
2. Walk the maneuvers and take a sample at the first maneuver at or past each
   **10-minute** mark; always sample the start (maneuver 0) and the end (last
   coordinate at `arrival_time`). **At most 12 samples**; a longer route
   widens the interval to `duration / 11`.
3. A sample is `{index: begin_shape_index, lat, lon, eta: datetime}`.

A route with no `departure_time` (should not happen with TomTom) gets
`weather.status = "unavailable"`.

### 5.2 Forecast lookup

- One `openmeteo.forecast` call for **all samples of all routes** (the
  alternatives included), hourly `precipitation_probability, precipitation,
  weather_code`, `forecast_days` = enough days to cover the latest ETA
  (≤ 16).
- Each sample reads the hour that contains its ETA (compared in UTC).
- Latest ETA more than 16 days out, or earliest ETA more than 1 hour in the
  past → `weather.status = "out_of_range"`, no call made.

### 5.3 Classification and sections

Per sample, first match wins:

| category | rule |
|---|---|
| `thunderstorm` | `weather_code` 95–99 |
| `heavy_rain` | `precipitation ≥ 4` mm/h |
| `rain` | `precipitation ≥ 0.3` mm/h **or** `precipitation_probability ≥ 60` |
| — | otherwise dry |

A sample stands for the stretch from its `index` to the next sample's
`index` (the last sample: to the final coordinate). Consecutive samples with the same non-dry category merge into one
section:

```python
"weather": {
  "status": "ok" | "unavailable" | "out_of_range",
  "sections": [{
    "start": 120, "end": 310,              # indices into route.coordinates
    "category": "rain" | "heavy_rain" | "thunderstorm",
    "probability": 80,                     # max over merged samples
    "precip_mm": 1.2,                      # max over merged samples
    "from_time": "17:40", "to_time": "17:55",   # local HH:MM, route time zone
  }],
}
```

`sections` is `[]` for a dry route and absent unless `status == "ok"`.

### 5.4 Failure

`WeatherUnavailable` or any timeout → every route gets
`{"status": "unavailable"}`. Logged once, never raised.

## 6. Wiring

### 6.1 `POST /geo/route`

After `tomtom.route(...)`: `return {"routes": await attach_weather(result["routes"])}`.
Status codes and errors unchanged — weather adds no new failure mode. Adds
~0.3 s on a cold weather cache.

### 6.2 `get_directions`

Calls `attach_weather` on `result["routes"]` and reads the best route. Output
gains:

```python
"weather_status": "ok" | "unavailable" | "out_of_range",
"rain": [{"from": "17:40", "to": "17:55", "category": "rain",
          "probability": 80, "near": "Rẽ phải vào Cầu Giấy"}],
```

`near` is the instruction of the maneuver whose `begin_shape_index` is the
last one ≤ the section's `start` — a street name for free, no reverse
geocoding. `rain` is `[]` when dry.

Description adds: "Also reports rain along the way at the time the operator
will pass (rain); mention it when present, especially for motorbike."

The preview is unchanged: the map fetches `/geo/route` itself and gets the
same weather.

## 7. Frontend

### 7.1 `mapApi.ts`

```ts
export interface WeatherSection {
  start: number;
  end: number;
  category: "rain" | "heavy_rain" | "thunderstorm";
  probability: number;
  precip_mm: number;
  from_time: string;
  to_time: string;
}
export interface RouteWeather {
  status: "ok" | "unavailable" | "out_of_range";
  sections?: WeatherSection[];
}
// Route gains:
weather?: RouteWeather;

export function weatherSegments(route: Route): GeoJSON.FeatureCollection<
  GeoJSON.LineString, { category: WeatherSection["category"] }>;
```

`weatherSegments` mirrors `trafficSegments` (slice `coordinates`, skip
sections under 2 points, `[]` without `weather.sections`).

### 7.2 `MapLayer.tsx`

Source `friday-route-weather-src`, layer `friday-route-weather` for the
selected route only, above the traffic overlay: dashed line
(`line-dasharray [1, 1.5]`), `line-offset` 5 px so congestion stays visible,
colour `rain #38bdf8`, `heavy_rain #2563eb`, `thunderstorm #a855f7`.
Removed with the other route layers.

### 7.3 `DirectionsPanel.tsx`

Under the "Khởi hành → Đến" line, for the selected route:

```
Mưa 17:40–17:55 (80%) · dông 18:10–18:20
Thời tiết: Open-Meteo
```

- One line, sections joined with " · ", each `<label> <from>–<to>
  (<probability>%)`; labels `mưa`, `mưa to`, `dông`.
- Dry route with `status "ok"`: `Không mưa trên đường` + credit.
- `unavailable` / `out_of_range` / no `weather`: nothing (no credit either).

## 8. Testing

No test touches the real network.

**Backend**
- `test_openmeteo.py`: multi-point query string; single-point response
  wrapped to a list; rounding + dedup fan-out; 15-minute expiry (clock
  injected); API-key host switch; HTTP error body, 429, timeout →
  `WeatherUnavailable`.
- `test_weather_codes.py`: known codes, unknown → "không rõ".
- `test_weather_tool.py`: each span's output and preview type/series;
  `my_location` without a shared location; no place match; weather outage
  → error dict.
- `test_route_weather.py`: sampling at 10-min marks, start and end always
  present, 12-sample cap; ETA hour lookup across a UTC-offset boundary;
  classification thresholds; merging; out-of-range (> 16 days, past);
  outage → `unavailable`; **input routes not mutated**.
- `integration/test_geo_route.py`: response carries `weather`; weather outage still 200.
- `test_geo_tools.py`: `get_directions` `rain` with `near`, dry `[]`,
  `weather_status` passthrough.
- `evals/cases.py`: "thời tiết hôm nay thế nào" → `get_weather`, never
  `search_web`.

**Frontend**
- `mapApi.spec.ts`: `weatherSegments` slices, skips short sections, empty
  without weather.
- `map.spec.ts`: stub route with weather sections → panel line with times and
  credit, `friday-route-weather` layer exists; `status "unavailable"` → no
  line.

**Done when** `npm run verify` is green (it runs the backend suite too).

## 9. Out of scope

- Air quality, globe of several cities, historical weather, 15-minute
  forecasts, flood and marine data.
- Weather-driven route choice (rerouting around rain).
- Proactive rain alerts before a saved commute.
- Weather effects on the hologram.
