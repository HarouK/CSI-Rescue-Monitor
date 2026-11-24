# Gateway message format (PROPOSED, protocol v1)

**This is a proposed interface, not your firmware's real format.** No ESP32 firmware was provided, so nothing
here was observed from hardware. Either make the gateway emit this, or edit `assets/csi-protocol.js`
(the only file that knows the wire format) to match what your firmware sends.

## Transport
- WebSocket, plain `ws://HOST:PORT/PATH` (default path `/csi`), on the local Wi-Fi network. No cloud, no TLS.
- Gateway pushes; the app sends nothing. One JSON object per text frame (max 64 KB). Each message has `"v":1` and a `"type"`.
- Messages from the gateway only count as "data" after they pass validation. Anything else is counted as malformed and ignored.
- Timestamps: the app stamps every message with its own receive time (shown everywhere). Optional `ts` from the gateway is stored but not used for display.

## `hello` (send once after connect)
```json
{"v":1,"type":"hello","gateway_id":"gw-01","fw":"0.3.1","threshold":0.10,"stale_ms":5000,
 "nodes":[{"id":"N1","zone":"Zone A · concrete slab","material":"concrete"}]}
```
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
