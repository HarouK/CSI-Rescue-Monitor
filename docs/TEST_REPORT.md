# Test report (what was actually run)

Environment: Linux container, headless Chromium (Playwright), Node 22. **No Android SDK, emulator or device was available, and no network, so the APK could not be built.**

## Performed and PASSED (automated)
`node --test tests/unit.test.js`: **31/31** (protocol validation incl. malformed inputs and `sev`/`Gateway` category, address validation, transport backoff/timeout/manual stop/stale-socket safety, store: hardware/demo separation, stale handling, malformed counting, severity of alerts, PDR, reconnect, test-connection isolation, persistence, CSV/report export).
`node tests/e2e.js` (Playwright headless Chromium + mock WebSocket gateway): **41/41**, run twice in a row after fixing a timing race in the test itself (the first run had 40/41; the failing check waited for the "Gateway data stale" alert before the 1 s evaluation tick created it. The app behaves correctly; the test now waits up to 3 s).
Covered: offline load with 0 external requests; tab navigation; N1-N4 selector shows each node's own values and timestamps; chart freezes when data stops and resumes on new data; state-specific empty-chart messages (not connected / connecting / reconnecting / waiting / collecting); variance and estimator explanations toggle; Info/Warning/Critical badges with category chips; severity and category log filters; CSV export downloaded and parsed with Python's `csv` module (valid, 6 columns, header + rows); Test Connection for OK, invalid address, refused, silent gateway and junk-data gateway, and that it does not disturb the live connection; last successful connection time, message counter, last-message time; gateway-loss feedback (reconnect attempt/timer, Retry now, "what to check" hints, recent connection events); gateway settings persisted across a simulated restart (new page); demo/hardware separation (no demo values in hardware mode); layout with no horizontal overflow across 4 tabs x 7 widths (320-1280) x 2 modes; portrait/landscape; zero JS errors.
Visual comparison: desktop dashboard headings sit at the same coordinates as the original; screenshots in `tests/screenshots/` (ORIGINAL-* vs NEW-*, plus demo/hardware at 412 and 1280 px). Screenshots were reviewed by eye for the new Analytics and Alerts screens.

## Performed, NOT conclusive
Java (`MainActivity`, `NativeBridge`): only scanned for syntax errors with `javac` (no Android classes available). Never compiled against the Android SDK or run. The Android share-sheet path for exports (`NativeBridge.shareFile`) is therefore untested; the browser download path is tested.

## NOT performed: need a physical Android device/emulator
Gradle build and APK; WebView offline startup and `WebViewAssetLoader` serving; `ws://` from the WebView to a LAN host (cleartext config); hardware Back button; real rotation/config changes; notifications and POST_NOTIFICATIONS prompt; share-sheet export; WebView renderer-crash recovery; app pause/resume; behaviour on Wi-Fi without internet.

## NOT performed: need ESP32 hardware
Everything about real data: the actual firmware message format, real CSI values, latency, packet loss, node battery, range, detection accuracy. **The detection estimates are unvalidated; the app does not implement a detection algorithm** (it displays whatever the gateway reports).

## Known failures
None in the tests that ran.


# Round 3: Android build and WebView milestone (status table)
**Honest summary: the APK was NOT built and nothing was run on Android in this round.** The sandbox cannot download Gradle or Google's Maven artifacts (actual error from `./gradlew assembleDebug`: `Downloading https://services.gradle.org/distributions/gradle-8.7-bin.zip ... java.io.IOException: Unable to tunnel through proxy. Proxy returns "HTTP/1.1 403 Forbidden (agent proxy: no rule or network setting allows this host)"`), and no Android SDK or emulator exists. "Browser" means headless desktop Chromium, which is **not** Android WebView.

| Test | Result | Where |
|---|---|---|
| Gradle compilation | NOT TESTED here (sandbox blocked). Earlier version: BUILD SUCCESSFUL reported by you in Android Studio; the Java edited this round has not been compiled | your PC needed |
| APK generation | NOT TESTED | your PC needed |
| WebView startup | REQUIRES PHYSICAL DEVICE (or working emulator) | |
| Offline startup | Browser: PASS (0 external requests, all assets local). Android: REQUIRES PHYSICAL DEVICE | browser automation |
| Dashboard navigation | Browser: PASS. Android: REQUIRES PHYSICAL DEVICE | browser automation |
| Analytics | Browser: PASS. Android: REQUIRES PHYSICAL DEVICE | browser automation |
| Alerts and logs | Browser: PASS. Android: REQUIRES PHYSICAL DEVICE | browser automation |
| CSV export | Browser download + CSV validity: PASS. Android file/FileProvider path: REQUIRES PHYSICAL DEVICE | browser automation |
| Android share sheet | REQUIRES PHYSICAL DEVICE | |
| Notifications | REQUIRES PHYSICAL DEVICE | |
| Back button | JS handler: PASS in browser. Hardware Back via `onBackPressed`: REQUIRES PHYSICAL DEVICE | |
| WebSocket connection | Mock gateway, browser: PASS. Android cleartext policy: REQUIRES PHYSICAL DEVICE | browser automation |
| Reconnection | Mock gateway, browser: PASS. Android: REQUIRES PHYSICAL DEVICE | browser automation |
| Mock gateway telemetry | Browser: PASS. Android: REQUIRES PHYSICAL DEVICE | browser automation |
| Actual ESP32 connection | REQUIRES ESP32 HARDWARE (protocol is a proposal; no firmware compatibility is claimed) | |

Static review done this round (by reading, not running): manifest, `MainActivity`, `NativeBridge`, Gradle files, resources, bundled JS/CSS. Versions are consistent (Gradle 8.7 supports AGP 8.5.2; compileSdk 34 matches the androidx libraries; Java 17). `javac` finds no syntax errors in the Java files (only missing Android classes). Bundled JS needs Chromium 88+; the Android code now checks this.

Fixes made from the review (untested on Android): missing bundled file now returns 404 instead of letting WebView make a real request to the asset host name; notification tap opens the app; share intent carries `ClipData` so the receiving app gets read access reliably; old exports are deleted from the cache; null-safe pause/resume/back; WebView-too-old message. Cleartext `ws://` remains permitted app-wide (Android cannot whitelist IP ranges); see `BUILD_ANDROID.md` for the controls and a tighter option.

Unit (31/31) and browser end-to-end (41/41) suites from round 2 were re-run after these edits only for unit tests (31/31); JS was not changed, so e2e was not repeated.

## Test on the phone (checklist for you)
Install the APK, then: app opens offline (airplane mode) with the design intact; four tabs; Back from Analytics returns to Dashboard, Back on Dashboard exits; rotate; Demo mode shows DEMO badge; Alerts > Export log (CSV) opens the share sheet and the file opens as a table; deny/allow notification prompt; Connection > mock gateway on a PC (LAN IP) > Test connection, Connect, kill gateway, watch reconnect; restart the app and confirm the address persists. Report any FAIL with a screenshot or `adb logcat -s CSIMonitor`.
