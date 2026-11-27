# Gateway architecture and the software simulator

## Architecture
```
ESP32-S3 sensing nodes --(radio link: not decided yet)--> GATEWAY --(Wi-Fi, WebSocket ws://host:81/csi, protocol v1)--> CSI Rescue Monitor
```
The app only knows the **WebSocket + JSON protocol** (`docs/PROTOCOL.md`). It does not care what is behind the socket, so the gateway can be:
- an ESP32 (access point or station) running a WebSocket server,
- a laptop program (the simulator in `tools/` is one),
- a Raspberry Pi program that collects node data (serial, ESP-NOW, UDP, MQTT...) and republishes it.
No wireless mesh is chosen. Because one ESP32-S3 radio may not do CSI capture and ESP-WIFI-MESH at once, putting a laptop/Pi gateway between nodes and the app, or using ESP-NOW/serial from nodes to the gateway, stays possible without touching the app. Only the gateway changes.

Inside the app: `csi-transport.js` (socket, timeouts, backoff) -> `csi-protocol.js` (validation) -> `csi-store.js` (separate Demo and Hardware datasets, alerts, logs) -> `csi-viewmodel.js` -> UI and the Observatory scene. Demo data never enters the Hardware dataset.

## The simulator (`tools/gateway-simulator.js`)
A **test tool**. All values are **simulated**; it sends `simulated:true` in `hello`, and the app shows an amber **SOFTWARE SIMULATOR** badge, a scene label "simulated values, not physical measurements", and marks exports. It needs only Node.js 18+ (no `npm install`; it contains its own tiny WebSocket server).

### Start (Windows PowerShell)
```powershell
cd path\to\csi-monitor-android
node --version                      # needs v18 or newer; install from nodejs.org if missing
node tools\gateway-simulator.js     # WebSocket on port 81, control panel on http://127.0.0.1:8090
```
If port 81 is busy: `node tools\gateway-simulator.js --ws-port 8081 --ui-port 8091` and use that port in the app.
Allow Node through Windows Firewall (private network) if a phone must connect.

### Connect the browser dashboard
```powershell
cd path\to\csi-monitor-android\app\src\main\assets\www
python -m http.server 8000          # in a second PowerShell window
```
Open `http://localhost:8000/index.html` > Connection > Hardware Mode > IP `127.0.0.1`, port `81`, path `/csi` > Save > Test connection > Connect. (The app's default is `192.168.4.1:81/csi`, the usual ESP32 access-point address. For the simulator on the same PC use `127.0.0.1`.)
For the Android phone: use the PC's Wi-Fi IPv4 address (`ipconfig`), same Wi-Fi network.

### Controls
Control panel (PC browser): http://127.0.0.1:8090 has buttons for everything below. Or type in the simulator terminal:
| Goal | Command |
|---|---|
| Start / stop simulator (stop = socket open but silent) | `start`, `stop` |
| Start all four nodes | `startnodes` |
| Node goes silent (app must notice by timeout) | `stopnode N3` |
| Gateway announces a node offline / restore it | `disconnect N3`, `restore N3` (or `restore all`) |
| Signal strength, CSI variance, motion | `rssi N2 -75`, `variance N2 0.3`, `motion N2 0.5` |
| Presence estimate (simulated) | `present N1 1 0.9`, `present N1 0` |
| Relay path | `route N4 2 N3` |
| Gateway interruption / restore | `interrupt`, `restoregateway` |
| Malformed messages | `malformed all` or one of `json text empty version notype nonode badnode badnumber range badts nomeasure badconf` |
| Unknown message type / duplicate frame | `unknown`, `duplicate N2` |
| Packet loss / heartbeat | `dropframes 0.3`, `heartbeat off` |
| Back to defaults | `reset` |

### Interpreting what the app shows
| App shows | Meaning |
|---|---|
| Header "Receiving", badge SOFTWARE SIMULATOR | socket open, valid data arriving from a simulator |
| LINK LOST / Reconnecting | the gateway socket closed or cannot be reached (`interrupt`); the app retries with backoff and reconnects by itself |
| DATA STALE | socket open but no valid message for the stale time; last values are kept and labelled |
| One node "Stale" then "Disconnected" | that node stopped sending (`stopnode`), or the gateway said it is offline (`disconnect`) |
| "N malformed frame(s) ignored" | invalid messages were rejected; valid readings were not overwritten |
| Persons (est.) N/A, Heart rate N/A | the gateway does not provide validated values; the app never calculates them |

### Simulated vs physically measured
Everything from the simulator is generated: RSSI, variance, motion, presence estimates, confidence, battery. Nothing is a physical CSI measurement. Passing simulator tests proves the app handles the protocol, not that ESP32 firmware or radio hardware works.

## Future ESP32 firmware requirements (not implemented)
1. WebSocket server (or a laptop/Pi bridge) at `ws://IP:81/csi`; send `hello` on connect, then `node_frame` per node (about 1 Hz) and `status` every 1-2 s.
2. Increment `seq` per node; do not reuse or send older `seq` after newer ones (except a node restart).
3. Report only what is measured: `raw.rssi`, `raw.amp_var` (computed from CSI), `raw.pkt_rate`. Any estimate must carry `validated:false` until validated; never send `vitals.validated:true` without a validated algorithm; never send `simulated:true`.
4. Keep frames under 64 KB and numbers in the documented ranges; the app rejects the whole frame otherwise.
5. Use `status.nodes[].online:false` when a node is known to be gone.
6. Decide the node-to-gateway radio strategy (single-radio CSI vs mesh conflict) before writing firmware; the app is indifferent to it.
Compatibility with real ESP32 firmware has **not** been verified.
