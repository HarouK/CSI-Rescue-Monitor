# Observatory view (RuView-inspired redesign)

Inspired by the layout and mood of the RuView Observatory screenshot (dark scene, floating panels, bottom mode bar). All code, drawing and wording are our own; nothing is copied from RuView.

## Rendering choice
A small perspective renderer on a plain **2D canvas** (`assets/csi-observatory.js`), not Three.js/WebGL. Reasons: Three.js is not available offline in the build environment, so it could not be bundled and tested; a canvas renderer needs no external files, behaves the same in every Android WebView, and uses little GPU. It adapts quality to frame time, pauses when the page is hidden, honours `prefers-reduced-motion`, and if the canvas is unavailable the page shows a text summary instead (tested). Swapping in Three.js later only means replacing this one file; it reads `CSI.app.store.view()` and never writes data.

## What each element means (data source)
| Element | Source | Notes |
|---|---|---|
| Nodes N1-N4, status colour, RSSI label | store nodes (Hardware: gateway frames; Demo: simulator) | stale/offline nodes are drawn amber/grey |
| Blue domes | nodes currently receiving; strength follows RSSI | visual propagation cue, not a measured field |
| Pulses along links | one pulse per frame actually received from that node | none when no data |
| Floor glow | per-node CSI variance spread around the node | NOT a position map |
| Presence markers | nodes whose estimate says "present" | **Hardware: zone-level glowing column, no silhouette, no person position.** **Demo: illustrative silhouette labelled DEMO** |
| Vital Signs panel | heart/respiration: only validated values if the gateway sends them, else **N/A**; breathing-band power shown as raw processed dB | never converted into BPM/RPM |
| Wi-Fi Signal panel | selected node's RSSI, CSI variance, motion; variance sparkline; presence status | persons (est.): Demo = flagged zones (labelled simulated); Hardware = N/A unless the gateway reports a count |
| Occupancy pill | count of zones flagged by estimates | worded "estimate, not confirmed" |

## Controls (all functional, tested)
- **Human Presence / Vital Sign Monitoring / Signal Monitoring** switch the overlay drawn in the scene (presence markers, breathing-band rings, signal strength/variance emphasis).
- **Orbit / Top / Front** camera presets; drag to orbit.
- **N1-N4** picks the node shown in the right panel.
- Header: connection status, mode badge, occupancy badge, settings button (opens Connection). Tabs: Observatory, Analytics, Alerts, Logs, Connection (bottom bar on phones).

## Data pipeline
Unchanged: WebSocket transport, protocol v1, separate Demo/Hardware datasets, alerts, logs, reconnect and stale handling. Optional protocol addition (backward compatible): `hello.nodes[].pos = [x, y]` metres to place nodes in the room; without it, placeholder positions are used and the scene says so.

## Needs firmware/algorithm support (not available today)
Person positions or counts, heart rate, respiration rate, pose. Until the gateway sends validated values, the UI shows N/A, zone-level markers, or clearly labelled DEMO shapes.
