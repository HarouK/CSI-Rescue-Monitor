package ph.research.csimonitor;

import android.Manifest;
import android.app.Activity;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import androidx.webkit.WebViewAssetLoader;
import java.io.ByteArrayInputStream;

/** Hosts the bundled web UI. All UI assets load from the APK (no internet); only ws:// sockets to the
 *  user-configured local gateway leave the device. Non-local web requests are blocked. */
public class MainActivity extends Activity {
    private static final String TAG = "CSIMonitor";
    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "http://" + HOST + "/assets/www/index.html";

    private WebView web;
    private FrameLayout root;
    private View errorView;
    private WebViewAssetLoader loader;
    private static final int MIN_WEBVIEW = 88;
    private boolean pageFailed;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        setContentView(R.layout.activity_main);
        root = findViewById(R.id.root);
        errorView = findViewById(R.id.errorView);
        findViewById(R.id.retry).setOnClickListener(v -> reload());
        loader = new WebViewAssetLoader.Builder()
                .setHttpAllowed(true)
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();
        int wv = webViewMajorVersion();
        createWebView();
        if (wv > 0 && wv < MIN_WEBVIEW) {
            // The bundled UI needs a reasonably current Chromium (optional chaining, aspect-ratio). Say so instead of showing a broken page.
            showError("Android System WebView " + wv + " is too old (needs " + MIN_WEBVIEW + " or newer). Update \"Android System WebView\" in Google Play, then tap Retry.");
        } else {
            web.loadUrl(START_URL);
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }
    }

    private void createWebView() {
        web = new WebView(this);
        web.setBackgroundColor(0xFF0A1017);
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // saves mode + gateway address
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setTextZoom(100);                    // keep the layout 1:1 with the design
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);
        web.addJavascriptInterface(new NativeBridge(this), "AndroidBridge");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.d(TAG, m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) {
                    WebResourceResponse res = loader.shouldInterceptRequest(u);
                    // A missing bundled file must be a 404, never a real network request to the (public) asset host name.
                    return res != null ? res : new WebResourceResponse("text/plain", "utf-8", 404, "Not found", null, new ByteArrayInputStream(new byte[0]));
                }
                // Block every other web request: the UI must never depend on (or reach) the internet.
                return new WebResourceResponse("text/plain", "utf-8", 403, "Blocked", null, new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                return !HOST.equals(r.getUrl().getHost()); // never navigate away from the bundled app
            }
            @Override public void onPageStarted(WebView v, String url, Bitmap f) { pageFailed = false; }
            @Override public void onPageFinished(WebView v, String url) {
                if (!pageFailed) errorView.setVisibility(View.GONE);
            }
            @Override public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) showError(String.valueOf(e.getDescription()));
            }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                Log.e(TAG, "WebView renderer gone (crashed=" + d.didCrash() + "), rebuilding");
                root.removeView(web);
                web.destroy();
                createWebView();
                web.loadUrl(START_URL);
                return true;
            }
        });
    }

    private void showError(String detail) {
        pageFailed = true;
        ((TextView) findViewById(R.id.errorDetail)).setText(detail);
        errorView.setVisibility(View.VISIBLE);
    }

    private void reload() {
        int wv = webViewMajorVersion();
        if (wv > 0 && wv < MIN_WEBVIEW) return; // still too old; keep the message
        errorView.setVisibility(View.GONE);
        web.loadUrl(START_URL);
    }

    /** Major Chromium version of the installed WebView, or -1 if unknown. */
    private int webViewMajorVersion() {
        try {
            android.content.pm.PackageInfo pi = WebView.getCurrentWebViewPackage();
            if (pi == null || pi.versionName == null) return -1;
            return Integer.parseInt(pi.versionName.split("\\.")[0]);
        } catch (Exception e) { return -1; }
    }

    private void setJsVisible(boolean visible) {
        if (web != null) web.evaluateJavascript(
                "(function(){try{CSI.app.store.setVisible(" + visible + ")}catch(e){}})()", null);
    }

    @Override protected void onPause() { super.onPause(); setJsVisible(false); if (web != null) web.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) web.onResume(); setJsVisible(true); }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        // Let the UI handle Back first (non-dashboard tab -> dashboard); otherwise leave the app.
        if (web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("(function(){try{return window.CSI_onBack()===true}catch(e){return false}})()", value -> {
            if (!"true".equals(value)) MainActivity.super.onBackPressed();
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            root.removeView(web);
            web.removeJavascriptInterface("AndroidBridge");
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
