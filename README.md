<h1 align="center">Skylight</h1>

<p align="center">
  <em>Project the aircraft passing overhead onto your ceiling, in real time - an X-ray through the roof.</em>
</p>

<p align="center">
  <img src="docs/skylight.png" alt="Skylight projected on a ceiling: aircraft, trails, SFO runways and the night sky" width="100%">
</p>

Skylight decodes ADS-B from a cheap RTL-SDR radio and renders the planes physically
flying over you onto a ceiling-pointed projector. A jet you'd hear overhead glides
across your ceiling at the same moment - labeled with its airline, type, and where it's
headed. Pure-black background so the projector's rectangle disappears and only the
aircraft (and stars) are lit.

It also draws the **real sky** behind the planes - sun, moon, bright stars and
constellations, and live **satellites including the ISS** - all at their true positions
for your location and time. Tune everything from your phone.

> Reference build is centered on **San Francisco International (SFO)**, but it works
> anywhere - set your location in the control panel and import your airport's runways
> by ICAO/IATA code (worldwide, via OurAirports) and you're flying.

## Features

- **Real-time overhead aircraft** from a local RTL-SDR (sub-second), or from a free web
  API with zero code changes - handy for trying it with no radio.
- **Type-aware glyphs** in a luminous, swept-wing style: widebodies tower over regional
  jets, **helicopters spin their rotors**, turboprops and GA aircraft spin their props.
- **Smooth motion** - interpolates the ~1 Hz fixes to 60 fps by rendering slightly in
  the past and tweening between real positions (no teleporting).
- **Comet trails**, altitude-graded color, and range rings + compass for orientation.
- **The airport** (runways) drawn at its true position, so you watch departures and
  arrivals line up with the runway.
- **Window to elsewhere** - each routed flight shows its destination **city, local time
  there, and miles-to-go**, plus a faint great-circle arc toward where it's headed.
- **Live sky layer** - sun, moon (with phase), bright stars + constellation lines,
  **naked-eye planets**, and **satellites / ISS** computed from TLEs. Scrub time
  forward/back from your phone, or jump straight to the next ISS pass.
- **Phone control panel** - every setting (rotation, theme, palette, filters, sky
  toggles, …) is live-tunable over your LAN and persists across reboots.
- **Optional sky camera** - point a PTZ camera (VISCA-over-IP + RTSP) at the sky and
  Skylight **automatically films the planes it's projecting**: ADS-B-driven pointing
  with latency-compensated lead prediction, a hybrid vision system that locks the plane
  to center, and a confidence-gated zoom ladder that punches in as the lock holds.
  Includes a **TV dashboard** (`/tv.html`) with the live feed + radar inset, and a full
  **debug UI** (`/tracker.html`) with jog pad, target table, and a star-capture
  calibration wizard.
- **Vision that knows a plane from a cloud** - the camera tracker fuses three signals:
  a classical blob detector (distant specks) + a large-object detector (big overhead
  planes), **track-before-detect** that picks the target by how it *moves* through the
  world like ADS-B predicts (clouds are world-static and lose), and an **optional
  neural airplane detector** (YOLOX-Nano ONNX, downloaded at setup) for a semantic
  "is it an airplane?" confirmation. It also **continuously self-calibrates** the mount
  from every locked pass, so the aim re-squares itself over time.
- **Appliance-ready** - boots straight to a full-screen kiosk on a Raspberry Pi 5
  (dual-output: projector + TV dashboard).

## Quick start (local, no radio)

Runs entirely on your computer against a free public ADS-B API.

```bash
pnpm install
DATA_SOURCE=api pnpm dev
```

- **Display:** http://localhost:5173/
- **Control panel:** http://localhost:5173/control.html (or from your phone: `http://<your-ip>:5173/control.html`)
- **Camera tracker debug UI:** http://localhost:5173/tracker.html - runs against a
  built-in **camera simulator**, so the whole pointing pipeline (target selection,
  prediction, zoom, calibration) works with zero hardware.
- **TV dashboard:** http://localhost:5173/tv.html

**Then set your location** from the control panel's **Location** section - search a
city/airport, tap **Current** to use the browser's location, or type `lat,lon`
directly. The default is SFO, so until you change it you'll see San Francisco traffic
(or nothing, if your radius is small). Your airport's runways can be drawn too:
type its ICAO/IATA code into **Location → Runways** and they're imported automatically.

### With a radio (locally)

```bash
scripts/install-rtlsdr-fedora.sh    # rtl-sdr-blog driver + blacklist DVB-T (Fedora; see script for Debian)
scripts/run-dump1090-local.sh       # decode + serve aircraft.json on :8080
DATA_SOURCE=radio pnpm dev
```


## Configuration

`Config` ([`shared/src/config.ts`](shared/src/config.ts)) is the single source of truth,
persisted to `server/data/config.json` and live-editable from the control panel. Key
fields:

| | |
|---|---|
| `centerLat` / `centerLon` | **Your location** - where you're looking up. Editable from the panel's **Location** section (type a city, airport code, or `lat,lon`). |
| `locationName` | Display name for the current location, shown in the control panel. |
| `locationProfiles` | Saved places (favorite airports). Switch between them from the panel's **Location** section - tap **Save current** to store the active spot, then a chip to jump back to it. |
| `radiusMiles` | How far out to show (default 3 - "what you could realistically see"). |
| `rotationDeg` / `mirrorX` | Calibration for the looking-up flip (tune against a real pass). |
| `theme` | `ambient` · `telemetry` · `focus`. |
| `showStars` / `showSun` / `showMoon` / `showSatellites` / `showPlanets` | Sky layer toggles. Planets (Venus, Jupiter, Mars, Saturn, Mercury) are drawn at their true positions, sized by brightness and labelled - so the display stays alive even with no traffic. |
| `skyTimeOffsetMin` | Scrub the sky clock for testing (0 = live). |
| `showDestArc` / `showRouteDetail` | "Window to elsewhere". |
| `tracker.*` | The whole camera subsystem - driver (`sim`/`visca`), camera IP, mount calibration, target selection criteria, prediction/pursuit tuning, zoom + vision behavior. All live-tunable from the tracker debug UI. |

**Using it somewhere other than SFO:** set your location from the control panel's
**Location** section (or edit `centerLat`/`centerLon`). Stars, sun, moon, and satellites
are computed for your coordinates automatically. The runway overlay is still SFO-specific
geometry - turn off **Airport runways** if you've moved, or replace it in
[`web/src/display/airports.ts`](web/src/display/airports.ts) with your local airport
(coordinates from [OurAirports](https://ourairports.com/data/)).

> Location search uses the free [Nominatim](https://nominatim.openstreetmap.org/)
> (OpenStreetMap) service. Set `GEOCODE_USER_AGENT` to identify your deployment if you
> use it heavily.

### Server environment

| Env | Default | Meaning |
|---|---|---|
| `DATA_SOURCE` | `radio` | `radio` (dump1090) or `api` (airplanes.live) |
| `AIRCRAFT_JSON_URL` | `http://localhost:8080/aircraft.json` | dump1090 feed |
| `SUPPLEMENT_API` | `1` | When on radio, merge the API too (keeps landing aircraft alive) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | HTTP + WebSocket |
| `ALLOWED_HOSTS` | *(empty)* | Extra Host/Origin allowlist entries, comma-separated. Wildcards: `*.example.com`. Loopback, RFC1918 LAN, IPv6 ULA / link-local, and `*.local` are allowed by default. |
| `ALLOW_PRIVATE_LAN` | `1` | Set `0` to lock the server to loopback + mDNS only (no LAN phone control) |
| `GEOCODE_USER_AGENT` | *(skylight default)* | User-Agent sent to Nominatim for location search |

### Exposing Skylight on a custom hostname

Skylight binds `0.0.0.0` so the phone control panel works on your home Wi-Fi.
To stop browsers on other origins from talking to the server (e.g. a tab on
`evil.com` opening a WebSocket to your Pi over DNS rebinding), every request
is rejected unless its `Host` header (and a WebSocket's `Origin` header)
matches the allowlist.

The defaults cover the documented topology - `localhost`, `127.0.0.1`,
`[::1]`, `*.local`, and private LAN ranges (`10/8`, `192.168/16`,
`172.16/12`, IPv6 ULA + link-local). If you publish Skylight on a public
hostname or a tunnel, add it:

```bash
ALLOWED_HOSTS=skylight.mydomain.com,*.trycloudflare.com pnpm dev
```

## Architecture

```
RTL-SDR ──USB──> dump1090-fa ──> aircraft.json (:8080)
                                      │ poll ~1 Hz  (+ API supplement)
                                      ▼
                         server/  (Node · Express · ws)  :3000
                         • normalize + enrich (airline/type tables + adsbdb routes)
                         • proxy satellite TLEs (Celestrak)
                         • persist config, broadcast over WebSocket
                         ├──────────────┬──────────────┬───────────────┐
                         ▼              ▼              ▼               ▼
                   Display (/)    Control (/control)  REST /api/*   tracker/  :3001
                   canvas renderer +  phone settings UI             • target selection + az/el
                   sky engine → projector (live, two-way)             lead prediction (ECEF)
                                                                    • velocity pursuit + zoom
                                                                    • vision: sky-masked blob
                                                                      detector, lag-compensated
                                                                    • VISCA-over-IP → PTZ camera
                                                                    • RTSP → H.264 passthrough
                                                                      (/video-ws) + MJPEG
                                                                    • TV dashboard + debug UI
```

- **`shared/`** - TypeScript types, config schema, and pure geo/projection/pointing math
  (ECEF az/el, mount model + calibration solver, alpha-beta trackers, FOV/zoom).
- **`server/`** - polls the radio (primary) and API (supplement), enriches aircraft,
  proxies TLEs, persists config, and pushes everything over a WebSocket.
- **`web/`** - Vite + React, four pages: the **display** (`<canvas>` renderer + celestial
  engine), the mobile **control panel**, the **TV dashboard**, and the **tracker debug UI**.
- **`tracker/`** - the camera brain: picks a target, predicts where it will be when the
  command actually bites (fix age + decode latency + motor latency), drives the PTZ with
  closed-loop velocity pursuit (sigma-delta speed dithering, soft limit guards,
  dead-reckoned pose), verifies the plane on-frame with a vision detector, and zooms in
  only while the lock holds. Runs against a **simulator** with zero hardware; replays
  recorded sessions deterministically for debugging.

**Stack:** TypeScript · React · Vite · Express · ws · pnpm workspaces ·
[astronomy-engine](https://github.com/cosinekitty/astronomy) ·
[satellite.js](https://github.com/shashwatak/satellite-js).

## Credits & data

- ADS-B decode: [dump1090-fa](https://github.com/flightaware/dump1090) · RTL-SDR Blog
  [drivers](https://github.com/rtlsdrblog/rtl-sdr-blog)
- Routes / aircraft enrichment: [adsbdb](https://www.adsbdb.com/) ·
  fallback feed: [airplanes.live](https://airplanes.live/)
- Satellite elements: [Celestrak](https://celestrak.org/) · airport data:
  [OurAirports](https://ourairports.com/)

## License

[MIT](LICENSE) - be excellent, point it at the sky.
