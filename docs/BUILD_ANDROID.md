# Build the debug APK

**Status: not built by the author.** The sandbox used to prepare this project cannot reach `services.gradle.org` or Google's Maven (proxy returned 403: "Unable to tunnel through proxy"), and has no Android SDK, so `./gradlew assembleDebug` could not run there. An earlier version of this project did sync and show BUILD SUCCESSFUL in your Android Studio; this version has not been built by anyone yet.

## Requirements
Android Studio (Koala or newer) with its bundled JDK 17+, Android SDK Platform 34 and Build-Tools 34 (Studio offers to install them), internet for the first Gradle sync only. After installation the app needs no internet.
Versions pinned: Gradle 8.7 (wrapper), Android Gradle Plugin 8.5.2, compileSdk/targetSdk 34, minSdk 26, Java 17, `androidx.webkit:webkit:1.11.0`, `androidx.core:core:1.13.1`. No other dependencies.

## Option A: Android Studio
1. File > Open the folder that contains `settings.gradle` (the inner `csi-monitor-android`).
2. Wait for Gradle sync. Accept SDK install prompts.
3. Menu (hamburger on small windows) > Build > Generate App Bundles or APKs > Generate APKs, or click "locate" in the notification.

## Option B: command line (Windows)
```
gradlew.bat assembleDebug
```
(macOS/Linux: `./gradlew assembleDebug`). Set `ANDROID_HOME` or create `local.properties` with `sdk.dir=C\:\\Users\\YOU\\AppData\\Local\\Android\\Sdk`.

## Output
`app\build\outputs\apk\debug\app-debug.apk` (debug-signed, installable for testing only).

## Option C: build in the cloud
`.github/workflows/android.yml` builds the APK on GitHub Actions and uploads it as an artifact (not yet run).

## Install on a phone
Enable Developer options > USB debugging, then `adb install -r app\build\outputs\apk\debug\app-debug.apk`, or copy the APK to the phone and open it (allow "install unknown apps").

## Connect to a gateway
Phone and gateway on the same Wi-Fi. Connection tab > enter the gateway's IP and port > Save > Test connection > Connect. Quick check without hardware: run `node tools/mock-gateway.js` on a PC on that Wi-Fi and use the PC's LAN IP (allow Node through the Windows firewall for private networks).

## Cleartext (ws://) and security
- ESP32 gateways serve plain `ws://`. Android blocks cleartext by default, so `res/xml/network_security_config.xml` permits it. Android's network security config cannot whitelist IP ranges, only host names, so this applies to all hosts for sockets.
- Compensating controls: the page is served from the APK; `MainActivity` returns 403 for every non-bundled web request and refuses navigation away; `csi-protocol.js` only accepts private/local gateway addresses (10.x, 172.16-31.x, 192.168.x, 169.254.x, 127.x, `.local`, single-label names); `INTERNET` is the only network permission used (plus `ACCESS_NETWORK_STATE`).
- Tighter option if the gateway IP is fixed (e.g. 192.168.4.1): replace `base-config` with `<base-config cleartextTrafficPermitted="false"/>` and add `<domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">192.168.4.1</domain></domain-config>`.
- Anyone on the gateway's Wi-Fi can read the unencrypted data; use a dedicated network.

## Permissions
`INTERNET` (sockets to the local gateway), `ACCESS_NETWORK_STATE`, `POST_NOTIFICATIONS` (Android 13+, asked at first launch; denying it only disables alert notifications). Exports use a FileProvider on the app cache; no storage permission.

## WebView requirement
Needs Android System WebView/Chrome 88+ (optional chaining, `aspect-ratio`). The app checks this at startup and shows an "update WebView" message instead of a broken page.
