/* CSI Rescue Monitor - DEMO data generator.
 * Emits already-parsed protocol-v1 messages (same shapes a gateway's frames parse to), so Demo Mode
 * exercises the same store/alert/view pipeline as Hardware Mode (but skips the wire parser). Everything produced here is SIMULATED; the UI labels it DEMO.
 * Hardware mode never reads from this module. */
(function (root) {
  'use strict';
  function mulberry(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; var t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

  var NODES = [
    { id: 'N1', zone: 'Zone A · concrete slab', material: 'concrete', occ: false, conf: 0.93, rssi: -61, batt: 84, rate: 98, amp: 0.021, br: 0.8, mo: 0.03 },
    { id: 'N2', zone: 'Zone B · wood panel', material: 'wood', occ: true, conf: 0.87, rssi: -54, batt: 71, rate: 100, amp: 0.184, br: 9.6, mo: 0.11 },
    { id: 'N3', zone: 'Zone C · metal sheet', material: 'metal', occ: false, conf: 0.64, rssi: -73, batt: 58, rate: 94, amp: 0.047, br: 1.9, mo: 0.05 },
    { id: 'N4', zone: 'Zone D · mixed rubble', material: 'concrete + wood', occ: true, conf: 0.71, rssi: -67, batt: 77, rate: 97, amp: 0.126, br: 6.2, mo: 0.08 }
  ];
  var SAMPLE_METRICS = [
    { obstruction: 'Wood', accuracy: 0.942, fp: 0.041, fn: 0.075 },
    { obstruction: 'Concrete', accuracy: 0.896, fp: 0.068, fn: 0.139 },
    { obstruction: 'Metal', accuracy: 0.713, fp: 0.125, fn: 0.45 },
    { obstruction: 'Concrete + wood (rubble mix)', accuracy: 0.827, fp: 0.094, fn: 0.228 }
  ];

  function createDemo(opts) {
    var emit = opts.emit, intervalMs = opts.intervalMs || 1000;
    var setI = opts.setInterval || setInterval.bind(root), clearI = opts.clearInterval || clearInterval.bind(root);
    var rnd = mulberry(opts.seed || 7), t0 = 0, seq = {}, timer = null, cut = false, started = false;
    NODES.forEach(function (n) { seq[n.id] = 0; });

    function hello() {
      emit({ type: 'hello', gatewayId: 'DEMO-SIMULATOR', fw: 'demo', threshold: 0.1, staleMs: 5000, nodes: NODES.map(function (n) { return { id: n.id, zone: n.zone, material: n.material }; }) });
      emit({ type: 'status', power: { source: 'Router on power bank (simulated)', runtimeMin: 660 }, nodes: [] });
      emit({ type: 'trial_metrics', rows: SAMPLE_METRICS.map(function (r) { return { name: r.obstruction, acc: r.accuracy, fp: r.fp, fn: r.fn }; }) });
      emit({ type: 'mesh', pdr: undefined, latencyMs: 86, rangeM: 18, setupS: 260 });
      emit({ type: 'event', cat: 'Gateway', sev: 'Info', text: 'DEMO: simulated base station, no hardware connected', node: null });
      emit({ type: 'event', cat: 'Mesh', sev: 'Info', text: 'DEMO: simulated nodes N1 to N4 joined the mesh', node: null });
    }

    function frame() {
      var t = (opts.now ? opts.now() : Date.now()) / 1000 - t0;
      NODES.forEach(function (n, i) {
        var lossP = n.id === 'N4' && cut ? 0.07 : 0.024;
        seq[n.id] += 1;
        if (rnd() < lossP) return; // simulated packet loss (visible as a sequence gap)
        var wob = n.occ ? 1 + 0.15 * Math.sin(t * 0.55 + i) : 1;
        var amp = Math.max(0.001, n.amp * wob + (rnd() - 0.5) * (n.occ ? 0.03 : 0.012));
        emit({
          type: 'node_frame', node: n.id, seq: seq[n.id], deviceTs: null,
          rssi: Math.round(n.rssi + (rnd() - 0.5) * 3), ampVar: amp, pktRate: Math.round(n.rate - rnd() * 3),
          battPct: n.batt, breathDb: n.br * wob, motion: n.mo,
          route: n.id === 'N4' && cut ? { hops: 2, via: 'N3' } : { hops: 1, via: null },
          est: { present: n.occ, conf: Math.max(0.05, Math.min(0.99, n.conf + (rnd() - 0.5) * 0.04)), algo: 'demo-threshold', validated: false }
        });
      });
    }

    return {
      start: function () {
        if (timer) return;
        t0 = (opts.now ? opts.now() : Date.now()) / 1000 - 0;
        if (!started) { started = true; hello(); }
        frame();
        timer = setI(frame, intervalMs);
      },
      stop: function () { if (timer) { clearI(timer); timer = null; } },
      setCut: function (c) {
        c = !!c;
        if (c === cut) return;
        cut = c;
        if (started) emit({ type: 'event', cat: 'Mesh', sev: cut ? 'Warning' : 'Info', text: cut ? 'DEMO: direct path N4 to base lost, rerouting via N3' : 'DEMO: direct path N4 to base restored', node: null });
      },
      isRunning: function () { return !!timer; }
    };
  }

  var api = { createDemo: createDemo };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CSI = root.CSI || {}; root.CSI.createDemo = createDemo; }
})(typeof window !== 'undefined' ? window : globalThis);
