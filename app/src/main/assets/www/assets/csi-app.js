/* CSI Rescue Monitor - app glue: creates the store, connects it to the Android bridge (if present),
 * handles visibility (WebView pause/resume), export and back-button behaviour. */
(function (root) {
  'use strict';
  var CSI = root.CSI;
  var bridge = root.AndroidBridge || null;

  function notify(title, text) {
    try { if (bridge && bridge.notify) bridge.notify(String(title), String(text)); } catch (e) { /* ignore */ }
  }

  var store = new CSI.Store({ demoFactory: CSI.createDemo, notifier: notify });

  // Save/share a text file: native share sheet on Android, browser download otherwise.
  function share(name, mime, content) {
    try {
      if (bridge && bridge.shareFile) return !!bridge.shareFile(name, mime, content);
      var blob = new Blob([content], { type: mime }), a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }
  function stamp() { var d = new Date(); function p(n) { return n < 10 ? '0' + n : String(n); } return String(d.getFullYear()) + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }
  function tag() { return store.settings.mode === 'demo' ? 'DEMO' : 'HW'; }

  var app = {
    store: store, native: !!bridge,
    exportLog: function () { return share('csi-log-' + tag() + '-' + stamp() + '.csv', 'text/csv', store.exportLogCsv()); },
    exportReport: function () { return share('csi-report-' + tag() + '-' + stamp() + '.json', 'application/json', store.exportReport()); },
    // Android back button: UI first (non-dashboard tab -> dashboard); returns true when handled.
    onBack: function () { return !!(root.CSI_ui && root.CSI_ui.back && root.CSI_ui.back()); }
  };
  CSI.app = app;
  root.CSI_onBack = app.onBack;

  document.addEventListener('visibilitychange', function () { store.setVisible(document.visibilityState === 'visible'); });
  root.addEventListener('pagehide', function () { store.stop(); });
  root.addEventListener('online', function () { store.setVisible(true); });
  store.start();
})(window);
