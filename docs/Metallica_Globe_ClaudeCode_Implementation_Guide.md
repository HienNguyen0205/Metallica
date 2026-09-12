# Metallica — Claude Code Implementation Guide
## Upgrade `GLOBE` Visualization into a Realistic, Interactive, Modern 3D Earth

> **Target:** Upgrade the current Metallica `GLOBE` visualization from a cyan wireframe sphere with location markers into a high-fidelity, realistic Earth that feels physically dimensional, supports rich multi-axis interaction, and still belongs to the existing FRIDAY holographic visual system.
>
> **Primary constraint:** Do **not** turn Metallica into a Google Earth / GIS clone. The result must preserve Metallica's black-space + cyan/teal + holographic + cinematic identity while substantially improving realism, interaction, and data semantics.

---

# 1. Mission

Claude Code must modify the existing Metallica codebase so that the `GLOBE` visualization becomes:

- A realistic spherical Earth rather than primarily a wireframe globe.
- Visually dimensional under lighting.
- Rotatable on X/Y axes with pointer/touch gestures.
- Zoomable with wheel/pinch.
- Draggable with inertia and damping.
- Capable of controlled auto-rotation when idle.
- Capable of camera focus on a selected city/location.
- Capable of displaying city/data markers that remain correctly attached to the curved globe.
- Capable of rendering animated 3D arcs between locations.
- Capable of visually encoding live/simulated metrics through marker size, intensity, color, arc width, and particle flow.
- Capable of showing clouds and atmospheric rim lighting.
- Capable of showing a day/night transition.
- Capable of showing optional city lights on the night side.
- Capable of preserving the existing Metallica visual identity.
- Capable of degrading gracefully on lower-performance devices.

The implementation must remain compatible with the project's current rendering architecture, especially the existing WebGPU/WebGL2 strategy and the current visualization registry/spec-driven system.

---

# 2. Non-Goals

Do NOT:

1. Replace the entire Metallica scene architecture.
2. Introduce a completely independent GIS engine unless the current implementation makes the requested experience impossible.
3. Turn the screen into a conventional dashboard with cards and panels.
4. Add arbitrary gradients/colors that conflict with Metallica's palette.
5. Remove the small FRIDAY core shown in visualization mode.
6. Remove the current spatial HUD language.
7. Add excessive neon effects.
8. Create separate WebGPU and WebGL2 scene implementations unless absolutely required.
9. Hard-code a specific dataset as the only supported globe content.
10. Break existing visualization types or contracts.
11. Add a heavy dependency when Three.js/R3F + existing utilities can solve the problem.

---

# 3. Existing Design Language to Preserve

The current Metallica UI has these defining characteristics:

- Pure/deep black background.
- Cyan/teal holographic geometry.
- Mostly monospace typography.
- Small uppercase technical labels.
- Thin line work.
- Wireframe accents.
- Sparse spatial composition.
- Large negative space.
- Minimal chrome.
- Small FRIDAY core as identity beacon.
- Visualization owns the center stage.
- Bottom-center `ASK FRIDAY`.
- Left/right technical rails.
- Subtle glow rather than massive bloom.
- State-aware visual behavior.

The new globe must look like:

> **A realistic Earth rendered through FRIDAY's holographic operating system.**

It must NOT look like:

> A normal 3D website Earth dropped into a sci-fi dashboard.

---

# 4. Important Visual Direction

Current globe:

```text
             cyan wire sphere
                  +
          location markers
```

Target globe:

```text
                    Atmosphere
                 ┌──────────────┐
              ╭────────────────────╮
            ╱                        ╲
           │   realistic Earth       │
           │                          │
           │  land / ocean / cloud   │
           │                          │
            ╲                        ╱
              ╰────────────────────╯
                    Atmosphere
```

with optional holographic overlays:

```text
Earth surface
   +
country borders
   +
city markers
   +
data arcs
   +
particle traffic
   +
subtle wireframe
   +
holographic HUD
```

The realistic Earth is the primary visual. The wireframe is secondary.

---

# 5. Start by Inspecting the Existing Code

Before editing anything, Claude Code must inspect and understand:

- Existing Globe renderer/component.
- Visualization registry.
- `VisualizationSpec` types/contracts.
- Current globe data shape.
- Current lat/lon conversion logic.
- Current camera rig.
- Current visualization lifecycle.
- Current mini-core presentation.
- Current post-processing stack.
- Current renderer backend abstraction.
- Current WebGPU/WebGL2 behavior.
- Current responsive/reduced-motion behavior.
- Current testing infrastructure.

Likely areas to inspect:

```text
src/
  components/
    friday/
    visualization/
  lib/
    vizPlanner.*
    store.*
    rendererBackend.*
    agentStream.*
  contracts/
  ...
```

Do not assume filenames. Search the repository.

Useful searches:

```bash
rg -n "globe|GLOBAL EDGE MAP|GLOBE" src backend
rg -n "VisualizationSpec|visualization registry|registry" src
rg -n "WebGPU|WebGL2|TSL|NodeMaterial" src
rg -n "lat|lon|latitude|longitude" src
```

Also inspect package versions before deciding which Three.js APIs are safe.

---

# 6. Required Implementation Sequence

Do not implement everything in one pass.

Use this order:

## Phase A — Establish a safe baseline

1. Locate current globe implementation.
2. Add/confirm a focused Globe component boundary.
3. Preserve current globe behavior in git history or a fallback path.
4. Confirm current `GLOBE` spec still renders.
5. Confirm existing tests pass.

## Phase B — Realistic Earth

1. Add Earth surface texture.
2. Add normal/bump detail.
3. Add roughness/specular behavior.
4. Add atmospheric rim.
5. Add cloud layer.
6. Add optional night lights.
7. Tune lighting.

## Phase C — Geographic semantics

1. Add country boundaries.
2. Add city/node markers.
3. Add selected-state marker.
4. Add hover state.
5. Add marker labels.

## Phase D — Interaction

1. Drag/orbit.
2. X/Y rotation.
3. Wheel zoom.
4. Touch/pinch.
5. Inertia.
6. Damping.
7. Auto-rotation.
8. Double-click or explicit focus.
9. Focus camera transition.

## Phase E — Data visualization

1. Curved arcs.
2. Animated particles.
3. Arc thickness/brightness mapping.
4. Marker status.
5. Metric tooltips.
6. Selected route emphasis.

## Phase F — Production hardening

1. Adaptive quality.
2. Resource disposal.
3. Device capability detection.
4. Reduced motion behavior.
5. Accessibility summary.
6. Unit/interaction tests.
7. Visual regression baseline.
8. Performance telemetry.

---

# 7. Earth Surface

## 7.1 Recommended geometry

Use a sphere with adequate segments.

Suggested starting point:

```ts
new THREE.SphereGeometry(2, 128, 128)
```

Do not immediately use 256/512 segments.

The visual detail should come primarily from textures/shaders, not geometry density.

Expose it as a quality parameter:

```ts
const GEO_SEGMENTS = {
  high: 128,
  medium: 96,
  low: 64,
};
```

## 7.2 Texture stack

Prefer a texture set with:

- Albedo / color
- Normal or bump
- Roughness
- Optional specular/ocean mask
- Optional night-light mask
- Optional cloud map
- Optional cloud alpha/mask

Conceptual layers:

```text
Earth Surface
 ├── base color
 ├── normal
 ├── roughness
 ├── ocean/specular
 └── night lights
```

## 7.3 Do not commit large binary assets blindly

Before adding textures:

- Check repository size policy.
- Check whether Git LFS is used.
- Prefer optimized WebP/KTX2/appropriate compressed formats if the project already supports them.
- Avoid embedding huge 4K/8K textures if a 2K texture gives nearly identical visual quality at the target viewport.
- Provide a low-resolution fallback.

Suggested quality:

```text
high    → 2048 or compressed equivalent
medium  → 1024
low     → 512
```

If KTX2/Basis compression is already supported by the stack, prefer it.

---

# 8. Realistic Lighting

The Earth should look lit by an actual sun direction.

Use a directional light or a shader-driven sun direction.

Concept:

```ts
sunDirection = normalize(...)
```

The surface should produce:

- Day side.
- Terminator.
- Soft night side.
- Atmospheric rim.

Avoid flat lighting.

The current wireframe globe has little physical depth. The new sphere must clearly show:

```text
light side
      →
terminator
      →
dark side
```

---

# 9. Atmosphere

Add an outer sphere slightly larger than Earth:

```text
Earth radius       2.00
Cloud radius       2.025
Atmosphere radius  2.06
```

Use Fresnel-style edge intensity.

Concept:

```glsl
float fresnel = pow(
  1.0 - dot(normal, viewDir),
  3.0
);
```

Use a subtle cyan/blue atmospheric glow.

Important:

- Atmosphere must not wash out the Earth surface.
- Keep it strongest around the silhouette.
- Keep the center of the disc relatively clean.

Visual target:

```text
      dark Earth
   ╭───────────────╮
  /                 \
 |                   |
  \                 /
   ╰───────────────╯
      soft cyan rim
```

Do not make the entire sphere bright cyan.

---

# 10. Clouds

Create a second sphere just above the Earth:

```ts
cloudRadius = earthRadius + 0.02
```

Use a grayscale/cloud-alpha texture.

The cloud sphere should:

- rotate independently;
- move slightly faster than Earth;
- have low opacity;
- not obscure city markers;
- remain subtle.

Suggested:

```text
Earth rotation = very slow
Cloud rotation = slightly faster
```

Do not create a giant obvious cloud sphere.

The intended impression is:

> “Atmospheric motion”

not:

> “white shell around a planet”.

---

# 11. Night Lights

Add optional city lights to the dark side.

Use a night-light texture/mask.

Shader concept:

```glsl
float day = max(dot(normal, sunDirection), 0.0);
float night = 1.0 - day;

float cityGlow = nightLightMask * smoothstep(
  0.15,
  0.75,
  night
);
```

Blend the night lights only where appropriate.

Desired effect:

```text
DAY SIDE
   realistic land/ocean

NIGHT SIDE
   subtle city light clusters
```

Do NOT make every pixel glow.

---

# 12. Country Borders

Country boundaries should be optional and subtle.

Preferred architecture:

```text
GeoJSON
   ↓
lat/lon
   ↓
3D points
   ↓
line geometry
```

Do not use hundreds of individual `<Line>` components if a consolidated geometry can do the job.

Recommended hierarchy:

```text
normal border:
  low opacity

hover country:
  slightly brighter

selected country:
  bright cyan

selected city:
  strongest focus
```

Country boundaries should never dominate the Earth texture.

---

# 13. Latitude/Longitude Conversion

Create one canonical utility.

Suggested API:

```ts
export function latLonToVector3(
  latitude: number,
  longitude: number,
  radius: number
): THREE.Vector3
```

Use one mapping convention everywhere.

Example:

```ts
function latLonToVector3(
  lat: number,
  lon: number,
  radius: number
) {
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;

  return new THREE.Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
     radius * Math.cos(phi),
     radius * Math.sin(phi) * Math.sin(theta)
  );
}
```

Important:

- Document the longitude convention.
- Document where 0° longitude points in world space.
- Ensure marker placement, arc generation, camera focus, and country borders all use the same convention.

Add unit tests for:

```text
North Pole
South Pole
Equator
Prime Meridian
International Date Line
Known city coordinates
```

---

# 14. City / Data Markers

Replace simple static dots with a reusable marker system.

Marker properties:

```ts
interface GlobeMarker {
  id: string;
  label: string;
  lat: number;
  lon: number;

  value?: number;

  status?: "healthy" | "warning" | "critical" | "offline";

  color?: string;

  metadata?: Record<string, unknown>;
}
```

Marker rendering:

```text
small glowing core
+
subtle halo
+
optional orbit/ring
+
label
```

Do not create excessive rings around every city.

Only:

```text
normal
hover
selected
```

should differ.

---

# 15. Marker Size Semantics

Marker radius can represent:

```text
request volume
traffic
throughput
node importance
```

Example:

```ts
const radius = THREE.MathUtils.lerp(
  0.018,
  0.055,
  normalizedValue
);
```

Do not linearly map huge values without normalization.

Use a stable scale such as:

```ts
normalized = clamp(
  (Math.log(value + 1) - min) / range,
  0,
  1
);
```

This prevents one giant city from dwarfing all others.

---

# 16. Marker Status Semantics

Use the existing Metallica palette.

Recommended:

```text
healthy   → cyan/teal
warning   → amber
critical  → red
offline   → dim gray/cyan
selected  → brightest cyan/white
```

Do not introduce unrelated colors.

---

# 17. Marker Labels

Labels should:

- face the camera;
- remain readable;
- avoid massive text;
- fade when far away;
- avoid overlap as much as possible.

Possible implementation:

- existing text system if compatible;
- otherwise `troika-three-text` if already available or acceptable.

Do not add a heavy UI library just for labels.

At high density:

```text
zoomed out:
  labels hidden or selective

zoomed in:
  labels appear
```

---

# 18. 3D Arcs Between Cities

This is one of the highest-value improvements.

Given:

```text
start = city A
end   = city B
```

Create a curved path that follows the sphere.

Do not use a straight line through the planet.

Use a quadratic or cubic curve with elevated midpoint.

Concept:

```text
A ●
    ╲
     ╲____
          ╲
           ● B
```

A useful method:

```ts
const start = latLonToVector3(...);
const end = latLonToVector3(...);

const mid = start.clone().add(end).normalize()
  .multiplyScalar(radius * arcHeight);

const curve = new THREE.QuadraticBezierCurve3(
  start,
  mid,
  end
);
```

Tune `arcHeight` according to angular distance.

---

# 19. Arc Semantics

Map data to visual channels.

For example:

```text
traffic volume → arc thickness
latency         → color/intensity
direction       → particle movement
health          → color
active route    → glow
```

Example:

```text
healthy:
  thin cyan line

high traffic:
  slightly thicker line

warning:
  amber

critical:
  red + pulse
```

Do not use thickness differences that are visually extreme.

---

# 20. Animated Data Particles

Add small particles moving along arcs.

Concept:

```text
SFO ---------------- FRA
       ●──────→
```

The particle should communicate direction.

The number/frequency of particles can represent traffic.

But cap particle count.

Example:

```ts
particleCount = clamp(
  Math.round(traffic / scale),
  1,
  12
);
```

For many routes, prefer instancing or a single points/particle system.

Do not create one React component per particle.

---

# 21. Globe Interaction — Core Requirements

The globe must support:

### Mouse
- left drag → rotate
- wheel → zoom
- hover → marker highlight
- click → marker select
- double-click → focus selected location
- optional right/middle drag only if it does not conflict with app behavior

### Touch
- one finger drag → rotate
- pinch → zoom
- double tap → focus

### Keyboard
Recommended:

```text
ArrowLeft      rotate
ArrowRight     rotate
ArrowUp        rotate vertical
ArrowDown      rotate vertical
+              zoom in
-              zoom out
R              reset view
F              focus selected marker
Space          pause/resume auto rotate
```

Respect existing app keyboard shortcuts and do not introduce conflicts.

---

# 22. Interaction Feel

Rotation must not feel rigid.

Use:

- damping;
- inertia;
- max vertical tilt;
- sensible rotation speed;
- friction.

Pseudo:

```ts
velocity *= 0.92;
rotation += velocity;
```

Clamp vertical rotation so the camera cannot enter disorienting flips.

Avoid allowing unlimited upside-down behavior unless there is a deliberate reason.

---

# 23. Auto Rotation

When the globe is idle:

```text
slow rotation
```

When user interacts:

```text
pause auto rotation
```

After inactivity:

```text
resume slowly
```

Suggested behavior:

```text
pointer down
  → autoRotate = false

pointer up
  → keep false

after 3–5 seconds without interaction
  → resume low-speed auto rotation
```

Auto rotation must not fight user input.

---

# 24. Zoom

Do not allow the user to zoom through the Earth or too far away.

Suggested:

```text
minZoom  = close enough to inspect city markers
maxZoom  = full globe composition
```

Use smooth interpolation rather than immediate jumps.

Potential camera distance:

```text
min distance ≈ 2.7
max distance ≈ 7.0
```

Adjust according to current scene camera/frustum.

---

# 25. Focus on Location

When user clicks a marker:

1. Identify marker.
2. Save previous camera state.
3. Compute desired camera orientation.
4. Animate camera transition.
5. Rotate globe or camera so selected point faces viewer.
6. Increase selected marker intensity.
7. Dim unrelated markers/routes.
8. Update focus telemetry.
9. Show concise metadata.

Do not abruptly snap camera orientation.

Use a smooth transition:

```text
easeInOutCubic
```

or equivalent.

---

# 26. Focus Mode

When selected:

```text
                 SFO
                  ●
                  ↑
             selected

            realistic Earth
```

Dim everything else:

```text
other markers: 0.25 opacity
other arcs:    0.15 opacity
Earth:         0.85
selected:      1.0
```

The rest of Metallica's HUD should reduce visual weight.

---

# 27. Hover Tooltip

Do not use a conventional HTML card.

Use a small holographic callout:

```text
SFO

LATENCY     31 ms
TRAFFIC     12.4K/s
STATUS      HEALTHY
```

Design:

- black/transparent background;
- thin cyan edge;
- monospace;
- subtle blur;
- no giant panel.

Keep it small.

---

# 28. Camera Composition

The current Metallica globe screen uses central composition.

Preserve that.

When not focused:

```text
globe = central hero
```

When focused:

```text
globe shifts slightly to make room
for contextual metadata if required
```

Do not allow the globe to fill the entire viewport so that it collides with:

- title
- state rail
- telemetry
- bottom input

Keep sufficient breathing room.

---

# 29. Maintain the Mini FRIDAY Core

The current visualization screens use a small FRIDAY core in the lower-left.

Keep it.

But treat it as a low-priority identity beacon:

```text
normal = 35–45%
active = 70–100%
```

The Earth should be the primary visual.

The core must not compete with it.

---

# 30. Preserve Current HUD Integration

The new globe should still work with:

- `TopHud`
- `StateRail`
- `EdgeTelemetry`
- `AnswerLine`
- `SpatialHud`
- `InputBar`

Do not create a separate full-screen globe UI.

The globe should live inside the current scene architecture.

---

# 31. Visualization Contract Compatibility

Do not break the current `VisualizationSpec`.

Prefer extending data, not replacing the contract.

Example:

```ts
interface GlobeVisualizationSpec {
  type: "globe";

  data: {
    center?: {
      lat: number;
      lon: number;
    };

    markers?: GlobeMarker[];

    routes?: GlobeRoute[];

    metrics?: Record<string, number>;
  };

  interaction?: {
    autoRotate?: boolean;
    allowZoom?: boolean;
    allowRotate?: boolean;
    initialFocus?: string;
  };
}
```

If the project uses discriminated unions, follow the existing style.

Do not introduce a second competing schema.

---

# 32. Data Structures

Recommended:

```ts
interface GlobeMarker {
  id: string;
  label: string;
  lat: number;
  lon: number;

  value?: number;

  status?: "healthy" | "warning" | "critical" | "offline";

  color?: string;

  metadata?: {
    region?: string;
    latencyMs?: number;
    requestsPerSecond?: number;
    uptime?: number;
    [key: string]: unknown;
  };
}
```

```ts
interface GlobeRoute {
  id: string;
  from: string;
  to: string;

  value?: number;
  latencyMs?: number;

  status?: "healthy" | "warning" | "critical";

  direction?: "forward" | "reverse" | "bidirectional";
}
```

Routes should reference marker IDs rather than duplicating coordinates.

---

# 33. Performance Requirements

Performance is mandatory.

Target:

```text
high-end:
  60 FPS preferred

mid-range:
  45+ FPS preferred

low-end:
  30 FPS acceptable
```

Never optimize only for one GPU.

Track:

```text
frame time
aFPS
draw calls
triangles
textures
GPU memory where observable
```

Correct typo/implementation naming in actual code; the metric intended here is FPS.

---

# 34. Adaptive Quality

Implement:

```text
HIGH
MEDIUM
LOW
```

with automatic adjustment.

Example:

```text
high:
  128 sphere segments
  2K texture
  clouds
  atmosphere
  borders
  full markers
  arcs
  particles
  bloom

medium:
  96 segments
  1K texture
  clouds
  atmosphere
  selective borders
  reduced particles

low:
  64 segments
  512 texture
  no clouds or simplified clouds
  atmosphere simplified
  reduced particles
  no expensive post-processing
```

Use hysteresis so quality does not oscillate rapidly.

---

# 35. Resource Management

This is extremely important.

On unmount or spec replacement:

Dispose:

```text
geometry
material
texture
render targets
buffer attributes
temporary meshes
```

If dynamic geometry is rebuilt, reuse buffers where practical.

After repeated visualization changes:

```text
GLOBE → BAR → GLOBE → RADAR → GLOBE
```

memory must remain stable.

Add a regression test or telemetry check if the project supports it.

---

# 36. Avoid React Re-rendering Per Frame

Animation should happen in the Three.js/R3F render loop.

Do NOT do this:

```ts
setState(rotation)
```

every animation frame.

Prefer:

```ts
useFrame((state, delta) => {
  globe.rotation.y += ...;
});
```

Store interaction state in refs or a dedicated lightweight controller.

React state should contain semantic state:

```text
selectedMarkerId
focusTarget
interactionMode
qualityLevel
```

not raw frame-by-frame transforms.

---

# 37. Instancing

For many city markers:

Use:

```text
InstancedMesh
```

instead of hundreds of independent mesh components.

For particle routes:

Use:

- InstancedMesh;
- Points;
- BufferGeometry;
- shader-driven particles;

depending on the existing renderer abstraction.

Do not create hundreds/thousands of independent React children for traffic particles.

---

# 38. WebGPU / WebGL2 Compatibility

Metallica currently aims to share rendering behavior between WebGPU and WebGL2.

The globe implementation must respect that.

Preferred strategy:

```text
shared scene graph
+
TSL / compatible materials
+
same semantic layers
```

Avoid writing:

```text
WebGPU globe
WebGL2 globe
```

as two unrelated implementations.

If some effect cannot be represented identically:

```text
WebGPU:
  full implementation

WebGL2:
  perceptually equivalent fallback
```

The user must still perceive the same product.

---

# 39. Mobile / Reduced Motion

On mobile:

- lower geometry;
- lower texture resolution;
- reduce cloud complexity;
- reduce particles;
- simplify borders;
- reduce post-processing;
- make controls forgiving.

For:

```css
@media (prefers-reduced-motion: reduce)
```

use:

- no continuous auto rotation;
- no aggressive camera transitions;
- minimal particle movement;
- reduced pulsing.

The globe must remain fully understandable.

---

# 40. Accessibility

A 3D globe must have a DOM-accessible summary.

Example:

```text
Global Edge Map.
4 locations.
San Francisco healthy, 31 ms latency.
Frankfurt healthy, 48 ms latency.
Tokyo warning, 121 ms latency.
Sydney healthy, 37 ms latency.
```

Create a semantic function:

```ts
toAccessibleSummary(globeSpec)
```

Keep it synchronized with the visual spec.

Screen readers should not need to interpret WebGL.

---

# 41. Input / Interaction Accessibility

Provide keyboard alternatives.

At minimum:

```text
Arrow keys → rotation
+ / -       → zoom
Enter       → select focused marker
Escape      → clear focus
R           → reset
```

Visible focus should exist for keyboard-accessible markers.

---

# 42. State-driven Globe Behavior

Integrate with existing FRIDAY states.

Suggested behavior:

## IDLE

```text
slow auto rotation
low particle flow
minimal atmosphere motion
```

## LISTENING

```text
rotation slows
selected region gently pulses
```

## THINKING

```text
slight acceleration
subtle orbital particles
```

## SEARCHING

```text
data arcs activate
marker scans
```

## PROCESSING

```text
traffic particles increase
selected routes intensify
```

## VISUALIZING

```text
globe materializes
camera settles
markers appear progressively
```

## SPEAKING

```text
answer active
globe movement becomes calmer
```

## WARNING

```text
warning markers pulse amber
```

## ERROR

```text
reduce visual noise
highlight affected region
```

The animation should communicate state, not just decorate.

---

# 43. Globe Entrance Animation

When entering the globe visualization:

Do not instantly pop Earth into existence.

Suggested sequence:

```text
0ms
mini core active

150ms
thin spherical guide ring

300ms
Earth surface fades in

500ms
atmosphere appears

700ms
clouds appear

900ms
markers appear

1100ms
routes animate in

1300ms
normal interaction enabled
```

Tune timing to feel fast, not theatrical.

---

# 44. Globe Exit Animation

When replacing the globe with another visualization:

```text
routes fade
markers fade
clouds reduce
Earth dims
camera restores
```

Avoid hard unmount cuts unless required for performance.

---

# 45. Texture Asset Recommendations

When choosing textures, prioritize:

1. Correct geographic appearance.
2. Appropriate licensing.
3. Reasonable resolution.
4. Compression.
5. Fast loading.
6. Good color under dark cinematic lighting.

Prefer asset sources with explicit licensing.

Do NOT scrape copyrighted commercial imagery.

Do not assume “found on Google Images” is safe.

Record asset provenance in project docs.

Example:

```text
public/assets/globe/
  earth-color.webp
  earth-normal.webp
  earth-roughness.webp
  earth-night.webp
  earth-clouds.webp
  countries.geojson
```

Add a short `ASSETS.md` with source/license information.

---

# 46. Loading / Async Asset Behavior

The globe must not block the entire app while textures load.

Show:

```text
GLOBE
INITIALIZING...
```

with the existing FRIDAY style.

Recommended progression:

```text
wireframe placeholder
        ↓
base Earth
        ↓
normal/roughness
        ↓
clouds
        ↓
night lights
        ↓
markers
        ↓
routes
```

If any optional asset fails:

The globe should still render.

For example:

```text
cloud texture fails
→ Earth stays usable
```

Do not break the entire visualization.

---

# 47. Caching

Texture and geo assets should be cached.

If the application already has a preloading/cache utility, use it.

Otherwise make a small controlled asset loader.

Do not duplicate fetches when changing:

```text
GLOBE
→ another visualization
→ GLOBE
```

---

# 48. Avoid Over-Realism

The goal is:

```text
realistic enough to feel like Earth
+
stylized enough to feel like Metallica
```

Avoid:

- photorealistic cloud noise that looks like Google Earth;
- huge blue oceans;
- saturated green land;
- realistic atmospheric haze that destroys the cyan identity;
- too many geographic labels;
- daytime lighting so bright that the black interface disappears.

The palette should remain:

```text
black
deep blue
cyan
teal
soft white
small amber/red semantic accents
```

---

# 49. Recommended Visual Layer Order

From back to front:

```text
1. space/particle background
2. atmospheric halo
3. Earth surface
4. night lights
5. clouds
6. country borders
7. geographic grid / subtle wireframe
8. routes
9. route particles
10. markers
11. selected marker halo
12. labels
13. spatial HUD
14. AnswerLine
15. global HUD
```

This order may need adjustment depending on depth, transparency, and renderer behavior.

---

# 50. Wireframe Layer

Do NOT remove the current wireframe concept.

Reduce its visual intensity.

Suggested:

```text
wireframe opacity ≈ 0.08–0.18
```

depending on background and quality level.

The wireframe should reveal the Metallica identity without overpowering the realistic surface.

---

# 51. Geographic Grid

Optional:

- latitude lines;
- longitude lines;
- equator;
- tropics.

Keep them subtle.

Recommended:

```text
equator        brighter
major lines    low opacity
minor lines    very low opacity
```

Do not render every degree.

---

# 52. Day/Night Terminator

The terminator should be a major visual cue.

Suggested shader behavior:

```text
day:
  warm natural light

terminator:
  soft transition

night:
  dark Earth + city lights
```

Do not use a hard boundary.

Use smoothstep.

---

# 53. Lighting Direction

Allow a stable sun vector.

For a demo:

```ts
const sunDirection = new THREE.Vector3(
  -0.8,
  0.3,
  1.0
).normalize();
```

For live mode, this can later be driven by actual time.

Do not add real astronomy calculations unless required.

---

# 54. Optional Real-Time Sun Position

Future enhancement, not required for first implementation:

```text
current time
   ↓
sun position
   ↓
real day/night terminator
```

Keep it modular.

---

# 55. Data Modes

Support at least:

## Demo Mode

```text
fixed sample markers
fixed sample routes
simulated values
```

Show:

```text
SOURCE · SIMULATED
```

## Live Mode

```text
actual API/telemetry
```

Show:

```text
SOURCE · LIVE
```

Do not allow simulated data to look indistinguishable from live data.

---

# 56. Suggested Demo Dataset

Use a small meaningful sample:

```text
SFO
FRA
SIN
TYO
SYD
LON
```

Example metrics:

```text
SFO
latency 31 ms
traffic 12400/s

FRA
latency 48 ms
traffic 9800/s

SIN
latency 72 ms
traffic 15400/s

TYO
latency 91 ms
traffic 11100/s

SYD
latency 37 ms
traffic 6200/s
```

Do not hard-code this into the renderer.

Put it in the data layer/demo fixture.

---

# 57. Route Examples

Example:

```text
SFO → FRA
SFO → TYO
SIN → SYD
FRA → SIN
```

Use flow particles.

Map:

```text
traffic → particle frequency
latency → color intensity
status → marker halo
```

---

# 58. Interaction Design

### Hover marker

```text
marker brightens
label appears
small telemetry callout
```

### Click marker

```text
selected
camera focus
other data dims
answer updates
```

### Hover route

```text
route brightens
particle speed becomes visible
route tooltip appears
```

### Click route

```text
route selected
endpoint markers highlighted
```

---

# 59. Camera Reset

Provide a reset interaction.

Use:

```text
R
```

and optionally a small invisible/secondary reset control.

Animation:

```text
current camera
      ↓
 ease
      ↓
default globe view
```

---

# 60. Avoid User-Input Fight

Do not combine:

- OrbitControls auto-rotation
- custom camera animation
- focus animation
- FRIDAY state camera rig

without a clear ownership model.

Define:

```text
camera owner:
  user interaction
  OR
  focus animation
  OR
  state choreography
```

at any given moment.

Suggested:

```ts
type CameraMode =
  | "idle"
  | "user"
  | "focus"
  | "transition";
```

---

# 61. Recommended Interaction State

```ts
interface GlobeInteractionState {
  isDragging: boolean;
  isZooming: boolean;

  hoveredMarkerId: string | null;
  selectedMarkerId: string | null;
  selectedRouteId: string | null;

  autoRotate: boolean;

  cameraMode: "idle" | "user" | "focus" | "transition";

  quality: "high" | "medium" | "low";
}
```

Do not put everything into global Zustand state if local component state/ref is sufficient.

Global state should hold semantic state only.

---

# 62. Testing Plan

## Unit tests

Test:

```text
latLonToVector3
normalizeMetric
createArc
marker lookup
route lookup
focus target calculation
```

## Interaction tests

Test:

```text
drag rotates
wheel zooms
click selects marker
double click focuses
reset returns
escape clears
keyboard controls work
```

## Visual tests

Capture:

```text
idle globe
focused globe
night side
multiple routes
warning marker
dense markers
low quality
reduced motion
```

## Regression tests

Switch repeatedly:

```text
globe
bar
line
globe
radar
globe
```

and verify no resource explosion.

---

# 63. Performance Test Scenario

Run:

```text
20 markers
10 routes
200 route particles
country boundaries
clouds
atmosphere
bloom
```

Then stress:

```text
50 markers
25 routes
500 particles
```

Check:

```text
FPS
frame time
draw calls
memory
```

Do not ship if the globe is beautiful but unusable.

---

# 64. Visual Acceptance Criteria

The new globe is considered successful only if:

### Realism

- Earth visibly has land/ocean variation.
- Lighting creates a believable day/night separation.
- Atmosphere reads as depth.
- Clouds visibly sit above the surface.
- The Earth does not look like a flat cyan sphere.

### Metallica identity

- Black space remains dominant.
- Cyan/teal remains dominant.
- Wireframe remains as a subtle secondary layer.
- Existing HUD remains coherent.
- Mini core remains recognizable.

### Interaction

- Rotation feels smooth.
- Zoom is natural.
- Touch works.
- Inertia exists but is controlled.
- Auto rotation yields to user input.
- Focus transitions are smooth.

### Data

- Markers remain attached to Earth.
- Arcs follow Earth curvature.
- Particles indicate direction.
- Selected data is visually clear.

### Performance

- No obvious frame-rate collapse on expected desktop hardware.
- No obvious memory growth after repeated visualization switching.
- Lower-quality mode works.

---

# 65. Final Visual Target

The target composition for `GLOBAL EDGE MAP` should be approximately:

```text
┌────────────────────────────────────────────────────────────┐
│ METALLICA                                  VISUALIZING     │
│ FRIDAY · HOLOGRAPHIC INTERFACE                     08:02  │
│                                                            │
│                         GLOBAL EDGE MAP                    │
│                                                            │
│                   ╭────────────────╮                       │
│                ╭──╯                ╰──╮                    │
│              ╱      realistic Earth     ╲                 │
│             │                           │                 │
│             │   ● TYO         ╭────● FRA                 │
│             │      ╲          ╱                          │
│             │       ╲        ╱                           │
│             │        ● SIN                              │
│              ╲                                      ╱      │
│                ╰──────────────────────────────────╯       │
│                                                            │
│                 "Global traffic is healthy."               │
│                                                            │
│        [mini FRIDAY core]                    telemetry     │
│                                                            │
│                         ASK FRIDAY                         │
└────────────────────────────────────────────────────────────┘
```

Do not reproduce the ASCII layout literally. It represents hierarchy only.

---

# 66. Suggested Component Architecture

Prefer something close to:

```text
GlobeVisualization/
  GlobeVisualization.tsx
  GlobeScene.tsx

  Earth/
    EarthSurface.tsx
    EarthClouds.tsx
    EarthAtmosphere.tsx
    EarthNightLights.tsx
    EarthWireframe.tsx
    CountryBorders.tsx

  Data/
    GlobeMarkers.tsx
    GlobeMarker.tsx
    GlobeRoutes.tsx
    GlobeRouteParticles.tsx
    GlobeLabels.tsx

  interaction/
    useGlobeInteraction.ts
    useGlobeFocus.ts
    useGlobeCamera.ts
    globeInteraction.types.ts

  geo/
    latLonToVector3.ts
    greatCircle.ts
    geojsonToSphere.ts

  quality/
    globeQuality.ts

  accessibility/
    globeA11y.ts
```

Adapt this to the project's current conventions rather than blindly creating this exact tree.

---

# 67. Recommended Separation of Responsibilities

## Renderer

Responsible for:

- meshes;
- materials;
- shaders;
- geometry;
- animation.

## Data layer

Responsible for:

- markers;
- routes;
- metrics;
- normalization.

## Interaction layer

Responsible for:

- drag;
- zoom;
- hover;
- focus;
- selection.

## Camera layer

Responsible for:

- target orientation;
- transitions;
- reset;
- constraints.

## Contract layer

Responsible for:

- `VisualizationSpec`;
- runtime validation.

Do not mix these responsibilities.

---

# 68. Claude Code Working Rules

Before changing code:

```text
1. Inspect.
2. Explain the current implementation to yourself.
3. Find the smallest safe integration point.
4. Reuse existing abstractions.
5. Implement in small commits.
6. Run tests after each phase.
```

Do not rewrite unrelated components.

Do not reformat entire files without reason.

Do not change unrelated package versions.

Do not upgrade Three.js merely to solve a problem until the current version has been evaluated.

---

# 69. Dependency Rules

Before adding any dependency:

Ask:

```text
Can Three.js/R3F already solve this?
Can existing project utilities solve this?
Can a small helper solve this?
```

Only add a dependency when:

- it meaningfully reduces complexity;
- it is actively maintained;
- it fits the project's license constraints;
- it does not duplicate current functionality.

---

# 70. Asset Rules

For every new texture/geodata asset:

Record:

```text
name
source
license
resolution
format
purpose
```

Example:

```md
| Asset | Source | License | Resolution | Purpose |
|---|---|---|---|---|
| earth-color.webp | ... | ... | 2048 | Earth surface |
| earth-night.webp | ... | ... | 2048 | City lights |
| earth-clouds.webp | ... | ... | 1024 | Cloud layer |
```

---

# 71. Error Handling

If an asset fails:

```text
surface texture fails
→ fallback procedural/placeholder surface

cloud texture fails
→ disable clouds

night texture fails
→ disable city lights

GeoJSON fails
→ hide country borders

route data fails
→ render Earth and markers
```

The globe must degrade progressively.

---

# 72. Empty State

If there are no markers:

Do not show an empty map with unexplained space.

Show:

```text
GLOBAL EDGE MAP
NO ACTIVE NODES
```

while still displaying Earth.

If there are markers but no routes:

```text
4 ACTIVE NODES
NO ACTIVE ROUTES
```

This is better than a visually empty network layer.

---

# 73. Loading State

Use the Metallica visual language:

```text
GLOBAL EDGE MAP
INITIALIZING SURFACE
```

and perhaps a subtle:

```text
●
```

Do not use a generic spinner.

---

# 74. Selected State Example

When SFO is selected:

```text
              SFO
              ●
             ╱
        ────╱────
      realistic globe

SFO
LATENCY 31ms
TRAFFIC 12.4K/s
STATUS HEALTHY
```

The selected route should brighten.

Other routes and markers should fade.

---

# 75. Explainability

The globe should optionally answer:

```text
Why is this node highlighted?
```

Example:

```text
SFO
High request volume
12.4K requests/s
```

or:

```text
TYO
Latency above threshold
91ms
```

This should be generated from the data, not hard-coded UI copy.

---

# 76. “Why this visualization?”

Do not expose hidden chain-of-thought.

Instead provide observable reasons:

```text
VIEW · GLOBAL EDGE MAP

Selected because:
• query requested geographic distribution
• 4 active regions detected
• route telemetry available
```

This is a product-level explainability feature.

---

# 77. Deliverables

Claude Code must produce:

1. Updated globe renderer.
2. Realistic Earth surface.
3. Atmosphere.
4. Clouds.
5. Night lights if supported by assets/performance.
6. Country boundaries where feasible.
7. Interactive markers.
8. Interactive arcs.
9. Animated route particles.
10. Rotation/zoom/focus interaction.
11. Auto rotation.
12. Adaptive quality.
13. Accessibility summary.
14. Tests.
15. Asset documentation.
16. Brief implementation notes in the repo.

---

# 78. Expected Git Commit Structure

Prefer:

```text
feat(globe): add realistic earth surface
feat(globe): add atmosphere and clouds
feat(globe): add geographic markers and borders
feat(globe): add interactive camera controls
feat(globe): add data arcs and particles
feat(globe): add focus mode and semantic tooltips
perf(globe): add adaptive quality and instancing
test(globe): add geo and interaction coverage
docs(globe): document assets and rendering model
```

Do not make one enormous commit.

---

# 79. Final Validation Checklist

## Visual

- [ ] Earth looks like an actual planet.
- [ ] Day side has natural lighting.
- [ ] Night side is believable.
- [ ] Atmosphere is subtle.
- [ ] Clouds are subtle.
- [ ] Wireframe remains secondary.
- [ ] Cyan Metallica identity remains.
- [ ] Globe does not visually overpower the rest of the page.

## Interaction

- [ ] X rotation works.
- [ ] Y rotation works.
- [ ] Drag feels smooth.
- [ ] Inertia works.
- [ ] Wheel zoom works.
- [ ] Pinch works.
- [ ] Auto rotation works.
- [ ] User interaction pauses auto rotation.
- [ ] Focus animation works.
- [ ] Reset works.
- [ ] Hover works.
- [ ] Marker selection works.
- [ ] Route selection works.

## Data

- [ ] Markers attach correctly.
- [ ] Labels remain stable.
- [ ] Routes follow sphere curvature.
- [ ] Particle direction is understandable.
- [ ] Visual channels communicate data.
- [ ] Demo/live state is explicit.

## Performance

- [ ] No unnecessary per-frame React state updates.
- [ ] Marker instancing works where appropriate.
- [ ] Particle count is capped.
- [ ] Text count is controlled.
- [ ] Textures are reasonable in size.
- [ ] WebGL2 fallback works.
- [ ] Adaptive quality works.
- [ ] Repeated mount/unmount does not leak resources.

## Accessibility

- [ ] Reduced motion works.
- [ ] Keyboard rotation works.
- [ ] Keyboard zoom works.
- [ ] Escape clears focus.
- [ ] Earth has a semantic DOM summary.
- [ ] Marker information is accessible without WebGL interpretation.

## Regression

- [ ] Existing visualization registry still works.
- [ ] Existing visualization types still work.
- [ ] State machine still works.
- [ ] HUD still works.
- [ ] Answer line still works.
- [ ] Mini core still works.
- [ ] Tests pass.

---

# 80. Definition of Done

The task is complete only when all of these are true:

> The Metallica globe no longer reads primarily as a cyan wireframe sphere.

Instead, at first glance, it should read as:

> **A realistic, dimensional planet.**

At second glance:

> **A holographic operational map.**

At third glance:

> **An AI-generated data visualization that communicates real meaning.**

And during interaction:

> **A spatial object that feels physically manipulable rather than a static chart.**

The final experience should preserve the current Metallica identity while moving the GLOBE visualization from:

```text
wireframe demo
```

to:

```text
realistic Earth
+
spatial interaction
+
semantic data
+
FRIDAY holographic presentation
```

Do not optimize for “more effects”.

Optimize for:

```text
realism
+
clarity
+
interaction
+
semantic meaning
+
performance
```

That is the target.
