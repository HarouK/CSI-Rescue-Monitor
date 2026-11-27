# Changed and added files
Changed: `app/build.gradle` (minSdk 26, androidx.core), `AndroidManifest.xml` (permissions, network security config, FileProvider, resize), `MainActivity.java` (rewritten: asset loader, request blocking, error screen, back, lifecycle, renderer-crash recovery), `assets/www/index.html` (original markup kept; bound to live data; new Connection tab, status banner, DEMO/HARDWARE badge, responsive phone bottom nav, labels reworded to "estimate"), `README.md`.
Added: `assets/www/assets/csi-{protocol,transport,store,demo,viewmodel,app}.js`, `NativeBridge.java`, `res/xml/*`, `res/layout/activity_main.xml`, `tools/mock-gateway.js`, `tests/*`, `docs/*`.
Wording changes for honesty: "Occupied zones" -> "Flagged zones"; "Classifier output" -> "Estimator output"; "Est. node runtime" -> "Lowest battery" (only battery % is a real field); zone confidence moved from SVG labels to a text line (the runtime can't render interpolated SVG text).

## Round 2 (analytics, alerts, connection)
- Analytics: per-node data and "Last measurement received" timestamps; chart status line (Live/Paused with last sample time); chart frozen, never scrolled or filled, when data stops; state-specific empty messages; "What is CSI variance?" and "How to read the estimator output" explanations.
- Alerts & log: Info/Warning/Critical severity; categories Detection estimate / Mesh / Gateway / System; gateway connection loss, stale data and malformed data raised as Gateway alerts; severity + category filters; CSV now has severity, category and source columns.
- Connection: Test connection (separate short-lived socket, does not disturb the live link), Retry now, last successful connection, message count and last message time, friendly failure reasons and "what to check" hints, recent connection events, settings and draft persisted in localStorage (`csi.settings.v1`).
- Protocol: event `sev` field and `Gateway` category (backward compatible: `sev` defaults to Info).
- Files touched: `index.html`, `csi-protocol.js`, `csi-store.js`, `csi-viewmodel.js`, `csi-demo.js`, `csi-app.js`, `tools/mock-gateway.js`, `tests/*`, `docs/*`. Java/Gradle files unchanged.

## Round 3 (Android milestone; no build possible in sandbox)
- `MainActivity.java`: missing bundled asset -> 404 (no real request); WebView version check (>= 88) with message; null-safe lifecycle/back.
- `NativeBridge.java`: notification tap opens the app; share intent `ClipData`; stale exports cleaned.
- Added `docs/BUILD_ANDROID.md`, `.gitignore`, `.github/workflows/android.yml` (optional cloud build, unrun). Gradle wrapper files (`gradlew`, `gradlew.bat`, `gradle/wrapper/*`) are included, pointing at Gradle 8.7; the wrapper jar was generated in the sandbox, so if Studio complains, let it regenerate it.
- Protocol unchanged.

## Round 4 (Observatory redesign)
- New landing screen "Observatory": perspective room scene (floor grid, wave domes, link pulses, node markers, zone-level presence markers, occupancy pill), floating Vital Signs and Wi-Fi Signal panels, bottom monitoring bar (Human Presence / Vital Sign / Signal), Orbit/Top/Front camera, compact header with status, mode, occupancy and settings; tabs renamed Observatory, Analytics, Alerts, Logs, Connection.
- New file `assets/csi-observatory.js` (canvas renderer, read-only on the store); `index.html` markup/CSS and `csi-viewmodel.js` extended; `docs/OBSERVATORY.md`.
- No changes to the transport, protocol, store logic, Java or Gradle files. Three.js was NOT used (could not be bundled offline here); see OBSERVATORY.md.
- Tests: 9 new browser checks for the Observatory (see TEST_REPORT).

## Round 5 (gateway communication foundation; simulator)
- New: `tools/gateway-simulator.js` (dependency-free WebSocket gateway simulator, CLI + local control panel), `tests/simulator.test.js`, `docs/GATEWAY_SIMULATOR.md`.
- Protocol (backward compatible): `hello.simulated`, `hello.gateway_kind`; `ts` must be a number >= 0 if present; empty `node_frame` rejected; duplicate/out-of-order frames ignored (restart tolerated). See PROTOCOL.md audit table.
- App: "SOFTWARE SIMULATOR" badge/scene label/Connection row/export wording when `simulated:true`; `stats.dupOld` counter.
- Modified: `csi-protocol.js`, `csi-store.js`, `csi-viewmodel.js`, `tools/` (new file only; `mock-gateway.js` unchanged), `tests/unit.test.js` (fixture now increments `seq`; 3 new tests), `tests/e2e.js` (8 new simulator checks; layout now includes 1366 and 1920 px), docs. Java/Gradle/assets other than JS untouched; Observatory unchanged.
