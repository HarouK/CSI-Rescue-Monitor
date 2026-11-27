# Connecting the app to your ESP32 gateway

1. Make the gateway (or the base-station ESP32) serve a WebSocket at `ws://<ip>:<port>/csi` and push the JSON in `PROTOCOL.md`.
   Arduino example libraries: `ESPAsyncWebServer` / `WebSockets`. The firmware side is yours to implement; none is included.
2. Put the phone on the gateway's Wi-Fi network (the AP's IP is often 192.168.4.1).
3. App > **Connection** > **Hardware Mode**. Enter IP/name, port, path. Press **Connect**.
   - Allowed addresses: private IPv4 (192.168.x.x, 10.x.x.x, 172.16-31.x.x), `localhost`, single-word names, `*.local`, `*.lan`. Internet names are refused.
   - Status: Connecting, Connected · waiting for data, Receiving, Stale (no data), Reconnecting (attempt n, retry in s).
   - Reconnect uses 1 s, 2 s, 4 s ... capped at 15 s. **Disconnect** stops it. The address is remembered and reused on next launch after a Connect.
4. Android may block Wi-Fi without internet: if data never arrives, check the phone did not auto-switch to mobile data ("Connect anyway" / disable "Switch to mobile data").
5. Test without hardware: `node tools/gateway-simulator.js` (no npm install; see docs/GATEWAY_SIMULATOR.md), then connect to your PC's LAN IP. The simulator is a labelled test tool, not firmware.
