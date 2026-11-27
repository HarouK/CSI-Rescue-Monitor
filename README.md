# CSI Rescue Monitor (Android)
Offline WebView app: the "Full console" design from your HTML, with a real data layer. **Demo Mode** (simulated, always labelled DEMO) or **Hardware Mode** (local ESP32 gateway over WebSocket).

## Build
1. Android Studio (Koala+), JDK 17. File > Open this folder, let Gradle sync (needs internet once for dependencies).
2. Build > Build APK(s) > `app/build/outputs/apk/debug/app-debug.apk`; copy to the phone and install.
3. Command line: `gradle assembleDebug` with `ANDROID_HOME` set.
(This project has not been compiled yet. Report any Gradle error and it will be fixed.)

## Use
Connection tab: choose mode; in Hardware Mode set IP / port / path and Connect. See `docs/ESP32_GATEWAY_SETUP.md`.

## Layout
`app/src/main/assets/www/` web UI: `index.html` + `assets/csi-*.js` (protocol, transport, store, demo, viewmodel, app). The communication layer (`csi-transport.js`, `csi-protocol.js`) has no UI code.

## Docs and tests
`docs/PROTOCOL.md`, `ESP32_GATEWAY_SETUP.md`, `TEST_REPORT.md`, `CHANGES.md`, `LIMITATIONS.md`.
`node --test tests/unit.test.js`; `node tests/e2e.js` (needs `npm i playwright ws`); `node tools/mock-gateway.js` (test gateway).

## Gateway simulator (no hardware needed)
`node tools\gateway-simulator.js` starts a clearly labelled SOFTWARE SIMULATOR gateway on `ws://127.0.0.1:81/csi` with a control panel at http://127.0.0.1:8090. No npm packages needed. See `docs/GATEWAY_SIMULATOR.md` (architecture, PowerShell commands, failure scenarios) and `docs/PROTOCOL.md` (message reference and audit).
