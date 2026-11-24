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
