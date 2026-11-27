# Gateway message format (PROPOSED, protocol v1)

**This is a proposed interface, not your firmware's real format.** No ESP32 firmware was provided, so nothing
here was observed from hardware. Either make the gateway emit this, or edit `assets/csi-protocol.js`
(the only file that knows the wire format) to match what your firmware sends.

## Transport
- WebSocket, plain `ws://HOST:PORT/PATH` (default path `/csi`), on the local Wi-Fi network. No cloud, no TLS.
- Gateway pushes; the app sends nothing. One JSON object per text frame (max 64 KB). Each message has `"v":1` and a `"type"`.
- Messages from the gateway only count as "data" after they pass validation. Anything else is counted as malformed and ignored.
- Timestamps: the app stamps every message with its own receive time (shown everywhere). Optional `ts` (milliseconds, any epoch, number >= 0) is stored but not used for display or staleness; a `ts` that is present but not a number >= 0 makes the frame malformed.
- Heartbeat: there is no separate heartbeat message. Any valid message (including `status`) counts as "the gateway is alive"; node frames keep each node alive. A gateway with no node traffic should send `status` every 1-2 s so the app can tell "gateway silent" (DATA STALE for the whole link) from "one node silent" (that node goes stale, then offline).

## `hello` (send once after connect)
```json
{"v":1,"type":"hello","gateway_id":"gw-01","fw":"0.3.1","threshold":0.10,"stale_ms":5000,
 "nodes":[{"id":"N1","zone":"Zone A · concrete slab","material":"concrete"}]}
```
Optional identification fields (added in round 5, backward compatible): `"simulated": true` marks the sender as a SOFTWARE SIMULATOR (the app shows an amber "SOFTWARE SIMULATOR" badge everywhere and exports say so; default `false`); `"gateway_kind"` is a free label such as `esp32`, `laptop`, `raspberry-pi`, `software-simulator` (shown on the Connection page, not used for logic). A real gateway must never send `simulated:true`, and a simulator must always send it. Optional `nodes[].pos: [x_m, y_m]` places a node in the Observatory room.
`threshold` = amplitude-variance detection threshold used by your algorithm (drawn on the chart; omit to hide the line).
`stale_ms` = how long without data before values are shown as stale (default 5000).

## `node_frame` (per node, e.g. 1 Hz)
```json
{"v":1,"type":"node_frame","node":"N2","seq":1042,"ts":1763900000000,"batt_pct":71,
 "route":{"hops":1,"via":null},
 "raw":{"rssi":-54,"amp_var":0.184,"pkt_rate":100},
 "processed":{"breath_band_db":9.6,"motion_idx":0.11},
 "estimate":{"present":true,"confidence":0.87,"algorithm":"your-algorithm","validated":false}}
```
| Field | Tier | Rules |
|---|---|---|
| `node` | id | `[A-Za-z0-9_-]{1,16}`, required. UI maps N1..N4 to Zones A..D (map and heatmap); other ids appear in lists only |
| `seq` | meta | integer, increments per frame; gaps are used to compute packet delivery |
| `raw.rssi` | **raw** | -127..0 dBm |
| `raw.amp_var` | **raw** | >= 0, CSI amplitude variance (drives the chart) |
| `raw.pkt_rate` | **raw** | 0..10000 packets/s |
| `processed.*` | **processed** | `breath_band_db`, `motion_idx` |
| `estimate.present` | **estimate** | boolean. Confidence is for this value (0..1) |
| `estimate.validated` | | `true` only if your algorithm has been validated; the UI still says "estimate" |
| `route.hops` / `via` | mesh | 1 = direct to base; >1 raises a "Direct link lost" alert |
Each frame replaces all values for that node; omitted fields are shown as "—" (unknown), never carried over.

The UI never shows "confirmed". Alerts say "Possible signs of life" (confidence >= 0.8, PRIORITY) or "Weak presence estimate" (REVIEW) and state that they are unvalidated.

## Optional messages
```json
{"v":1,"type":"status","power":{"source":"Router on power bank","runtime_min":660},"nodes":[{"id":"N3","online":false}]}
{"v":1,"type":"mesh","pdr":0.976,"latency_ms":86,"range_m":18,"setup_s":260}
{"v":1,"type":"event","cat":"Mesh","sev":"Warning","text":"Node N4 rerouted via N3","node":"N4"}
{"v":1,"type":"trial_metrics","rows":[{"obstruction":"Wood","accuracy":0.942,"fp":0.041,"fn":0.075}]}
```
`cat` is `Detect`, `Mesh`, `Gateway` or `System`. `sev` is optional: `Info` (default), `Warning` or `Critical`; anything else is rejected as malformed. Without `mesh.pdr`, packet delivery is computed from `seq` gaps (5-min window). Latency/range/setup/trial table show "—" unless sent. Unknown `type`s are ignored (counted).

## Derived alerts and severity (rules live in `csi-store.js` `evaluate`)
| Severity | Raised when | Category |
|---|---|---|
| Critical | estimate present with confidence >= 0.8 ("Possible signs of life"); node offline/no data > `stale_ms`; connection to the gateway lost | Detection estimate / Mesh / Gateway |
| Warning | weak presence estimate (< 0.8); RSSI < -70 dBm; node stale; relay / direct link lost; gateway connected but data stale | Detection estimate / Mesh / Gateway |
| Info | gateway hello/connect, malformed frames within 30 s, cleared conditions, gateway-sent events | Gateway / System / as sent |

Alerts clear automatically when the condition ends. Detection alerts are always worded as unvalidated estimates, never as confirmed detections. Only Warning/Critical alerts trigger an Android notification.

## CSV log export
Columns: `time_iso,time_local,severity,category,message,source` (CRLF line endings, RFC-4180 quoting). Source is `DEMO` or `HARDWARE`.


## Audit findings (round 5) and the smallest compatible fixes
Observed by reading `csi-protocol.js`, `csi-store.js`, `csi-viewmodel.js`, `docs/PROTOCOL.md` and by running tests; nothing was observed from hardware.
| # | Finding | Resolution |
|---|---|---|
| 1 | Duplicate or out-of-order `node_frame`s (same or lower `seq`) overwrote newer values | Frames whose `seq` is equal or up to 7 lower than the last accepted one are ignored (counted as `dupOld`). Three consecutive lower values are treated as a node restart and accepted. Frames without `seq` are unaffected. |
| 2 | `ts` of the wrong type was silently dropped | Now rejected as malformed (frame ignored, counted, logged). |
| 3 | A `node_frame` with no measurement at all marked the node online and erased its values | Now rejected: it needs at least one of `raw.*`, `processed.*`, `batt_pct`, `estimate` or `vitals`. |
| 4 | No way for a simulator to identify itself | `hello.simulated` / `hello.gateway_kind` added (optional). |
| 5 | This document did not list `vitals`, `estimate.count`, `estimate.position` or `hello.nodes[].pos`, which the parser already accepts | Documented below. |
| 6 | No heartbeat | Documented convention: `status` messages (no new message type). |
Unchanged and verified: a frame with any invalid field is rejected whole, so invalid values can never overwrite valid ones; unknown `type` is counted and ignored; unknown extra fields are ignored; frames over 64 KB are rejected.

## Fields the parser accepts that are shown only with care
- `vitals` `{heart_bpm, resp_rpm, validated}`: shown **only** when `validated` is `true`; otherwise the UI shows N/A. The app never derives vitals from RSSI or CSI variance. A real gateway must not set `validated:true` unless the algorithm has been validated.
- `estimate.count` (integer 0-64): shown as "Persons (est.)"; absent means N/A.
- `estimate.position` `[x_m, y_m]`: if absent the app draws zone-level markers only and never invents positions.

## Quick reference: required vs optional
| Message | Required | Optional |
|---|---|---|
| all | `v` = 1, `type` | `ts` |
| `hello` | none | `gateway_id`, `gateway_kind`, `simulated`, `fw`, `threshold`, `stale_ms`, `nodes[]` (`id` required; `zone`, `material`, `pos`) |
| `node_frame` | `node`, and at least one measurement | `seq`, `ts`, `batt_pct`, `route`, `raw.{rssi,amp_var,pkt_rate}`, `processed.{breath_band_db,motion_idx}`, `estimate.{present (required if estimate given),confidence,algorithm,validated,count,position}`, `vitals` |
| `status` | none | `power.{source,runtime_min}`, `nodes[].{id,online}` |
| `mesh` | none | `pdr`, `latency_ms`, `range_m`, `setup_s` |
| `event` | `cat`, `text` | `sev`, `node` |
| `trial_metrics` | `rows[]` (`obstruction` required) | `accuracy`, `fp`, `fn` |
Node id: `[A-Za-z0-9_-]{1,16}`. Timestamps: app receive time is authoritative; `ts` is informational.
