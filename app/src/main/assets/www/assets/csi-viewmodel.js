/* CSI Rescue Monitor - view model. Pure function: (store view + UI state) -> values the template binds to.
 * Keeps the original design's colours/labels; every number comes from the store with a stated source. */
(function (root) {
  'use strict';
  var CSI = (typeof module !== 'undefined' && module.exports) ? null : (root.CSI = root.CSI || {});
  var ZONE_SLOTS = [
    { id: 'N1', key: 'A', p2: [120, 172], p3: [273, 353], grid: [4, 9] },
    { id: 'N2', key: 'B', p2: [120, 88], p3: [270, 300], grid: [4, 2] },
    { id: 'N3', key: 'C', p2: [280, 86], p3: [547, 283], grid: [19, 2] },
    { id: 'N4', key: 'D', p2: [280, 170], p3: [545, 318], grid: [19, 9] }
  ];
  var OCC = '#ffb454', CLR = '#7cb8ff', BAD = '#ff8a8a', MUT = '#93a8bb', TXT = '#e6eef6';
  var SEV_COLOR = { Critical: BAD, Warning: OCC, Info: CLR };
  var CAT_COLOR = { Detect: OCC, Mesh: CLR, Gateway: '#c4d2df', System: MUT };
  var CAT_LABEL = { Detect: 'Detection est.', Mesh: 'Mesh', Gateway: 'Gateway', System: 'System' };
  var CAT_LONG = { Detect: 'Detection estimate', Mesh: 'Mesh', Gateway: 'Gateway', System: 'System' };
  var EXPLAIN_VAR = 'CSI (Channel State Information) describes how the Wi-Fi signal between two ESP32 nodes changes across its subcarriers. Amplitude variance measures how much that signal fluctuates over a short time window. A person moving or breathing near the signal path adds fluctuation and can raise the value above the empty-room baseline, but walls, metal, interference and moving objects change it too. Units are arbitrary and depend on the firmware. The dashed line is the threshold announced by the gateway; crossing it is a hint, not proof that someone is there.';
  var EXPLAIN_EST = 'Raw values are measured by the node (RSSI, amplitude variance, packet rate). Processed values are computed from raw ones (breathing-band power, motion index). The Estimate is the gateway algorithm\'s guess: "present" plus a confidence (how sure the algorithm is of that guess, 0 to 100%). It is marked unvalidated unless the gateway says otherwise, and the app never shows a confirmed detection. Confirm any alert with a manual check.';
  var EXAMPLE = '{"v":1,"type":"node_frame","node":"N2","seq":1042,\n "raw":{"rssi":-54,"amp_var":0.184,"pkt_rate":100},\n "processed":{"breath_band_db":9.6,"motion_idx":0.11},\n "estimate":{"present":true,"confidence":0.87,\n  "algorithm":"your-algorithm","validated":false}}';

  function friendly(e) { var u = (typeof module !== 'undefined' && module.exports) ? require('./csi-store.js').friendlyError : (CSI.storeUtil && CSI.storeUtil.friendlyError); return u ? u(e) + ' (' + e + ')' : e; }
  function p2(n) { return n < 10 ? '0' + n : '' + n; }
  function hms(t) { if (!t) return '—'; var d = new Date(t); return p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds()); }
  function dateText(t) { var d = new Date(t); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' + d.getDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] + ' ' + d.getFullYear(); }
  function pct(x, d) { return x === null || x === undefined ? '—' : (x * 100).toFixed(d === undefined ? 1 : d) + '%'; }
  function jet(v) {
    var c = function (x) { return Math.max(0, Math.min(1, x)); };
    return 'rgb(' + Math.round(c(1.5 - Math.abs(4 * v - 3)) * 255) + ',' + Math.round(c(1.5 - Math.abs(4 * v - 2)) * 255) + ',' + Math.round(c(1.5 - Math.abs(4 * v - 1)) * 255) + ')';
  }
  function bars(rssi) { return rssi === null ? 0 : rssi > -60 ? 4 : rssi > -66 ? 3 : rssi > -72 ? 2 : 1; }

  function build(v, ui, act, accent, store) {
    var now = v.now, demo = v.mode === 'demo', out = {};
    var nodes = v.nodes, byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    // always show N1..N4 slots even before data (as "no data")
    var defs = ZONE_SLOTS.map(function (z) { return Object.assign({ slot: z }, byId[z.id] || { id: z.id, status: 'nodata', est: null, rssi: null, zoneShort: z.id === 'N1' ? 'Zone A' : z.id === 'N2' ? 'Zone B' : z.id === 'N3' ? 'Zone C' : 'Zone D', material: null, route: null }); });
    var extra = nodes.filter(function (n) { return !ZONE_SLOTS.some(function (z) { return z.id === n.id; }); }).slice(0, 4);
    var list = defs.concat(extra.map(function (n) { return Object.assign({ slot: null }, n); }));
    var link = v.link;
    var flaggedNodes = defs.filter(function (d) { return d.status === 'online' && d.est && d.est.present; });
    var sd = list.filter(function (d) { return d.id === ui.sel; })[0] || defs[1];

    // ---- header ----
    out.accent = accent; out.isDemo = demo; out.isHw = !demo;
    out.modeLabel = demo ? 'DEMO DATA' : 'HARDWARE'; out.modeColor = demo ? OCC : accent;
    out.dateText = dateText(now);
    var L = linkText(link, v, now, accent);
    out.linkText = L.text; out.linkColor = L.color;
    out.hasPower = !!(v.power && v.power.source); out.powerText = v.power ? (v.power.source + (v.power.runtimeMin != null ? ' · ' + Math.round(v.power.runtimeMin / 60) + ' h' : '')) : '';
    var B = banner(link, v, now);
    out.showBanner = !!B; out.bannerText = B ? B.text : ''; out.bannerDetail = B ? B.detail : ''; out.bannerColor = B ? B.color : OCC;

    var titles = { dash: 'Dashboard', ana: 'Analytics', log: 'Alerts & log', conn: 'Connection' };
    out.navs = [['dash', 'Dashboard'], ['ana', 'Analytics'], ['log', 'Alerts & log'], ['conn', 'Connection']].map(function (t) {
      var on = ui.tab === t[0];
      return { label: t[1], bg: on ? '#16322c' : 'transparent', fg: on ? accent : '#c4d2df', border: on ? accent : 'transparent', pressed: on ? 'true' : 'false', pick: function () { act.set({ tab: t[0] }); } };
    });
    out.pageTitle = titles[ui.tab];
    out.isDash = ui.tab === 'dash'; out.isAna = ui.tab === 'ana'; out.isLog = ui.tab === 'log'; out.isConn = ui.tab === 'conn';

    // ---- dashboard ----
    var online = nodes.filter(function (n) { return n.status === 'online'; }).length;
    out.liveNote = demo ? 'Simulated · ' + nodes.length + ' nodes' :
      (link.state === 'receiving' ? 'Updated ' + hms(v.stats.lastMsgAt) + ' · ' + online + '/' + nodes.length + ' nodes' : (v.stats.lastMsgAt ? 'No live data · last ' + hms(v.stats.lastMsgAt) : 'No data yet'));
    out.occCount = flaggedNodes.length;
    out.occNames = flaggedNodes.length ? flaggedNodes.map(function (d) { return d.zoneShort; }).join(', ') : (demo || nodes.length ? 'None flagged' : 'No data');
    out.meshNodes = list.map(function (d) {
      var n = bars(d.rssi), st = statusInfo(d.status, accent);
      return {
        name: 'Node ' + d.id.replace(/^N/, '').padStart(2, '0'), dot: st.color, status: st.text + (d.ageMs != null && d.status !== 'online' ? ' · ' + Math.round(d.ageMs / 1000) + ' s ago' : ''),
        aria: d.id + ' ' + st.text + (d.rssi !== null ? ', signal ' + n + ' of 4' : '') + '. Open in analytics.',
        bars: [1, 2, 3, 4].map(function (i) { return { h: (4 + i * 3.5) + 'px', bg: i <= n && d.status !== 'offline' ? accent : '#2a3a4a' }; }),
        pick: function () { act.set({ sel: d.id, tab: 'ana' }); }
      };
    });
    // heat map: strength from the node's own estimate; unknown/stale nodes contribute only baseline
    var HC = 24, HR = 12, heat = [];
    for (var r = 0; r < HR; r++) for (var c = 0; c < HC; c++) {
      var val = 0.04 + ((r * 7 + c * 13) % 5) * 0.006;
      defs.forEach(function (d) {
        var dx = c - d.slot.grid[0], dy = r - d.slot.grid[1];
        var s = d.status === 'online' && d.est ? (d.est.present ? (d.est.conf === null ? 0.5 : d.est.conf) : 0.1) : 0;
        val += s * Math.exp(-(dx * dx + dy * dy) / (2 * 2.6 * 2.6));
      });
      heat.push({ bg: jet(Math.max(0, Math.min(1, val))) });
    }
    out.heat = heat;
    defs.forEach(function (d) {
      var on = d.status === 'online' && d.est && d.est.present, k = d.slot.key;
      var cf = d.est && d.est.conf !== null ? ' ' + Math.round(d.est.conf * 100) + '%' : '';
      out['z' + k + 'On'] = on ? '1' : '0'; out['z' + k + 'Glow'] = on ? '0.9' : '0';
      out['z' + k + 'Label3'] = d.zoneShort + cf; out['z' + k + 'Label2'] = d.zoneShort;
    });
    out.zoneSummary = flaggedNodes.length ? 'Estimates: ' + flaggedNodes.map(function (d) { return d.zoneShort + ' ' + (d.est.conf !== null ? Math.round(d.est.conf * 100) + '%' : '?'); }).join(' · ') + ' (unvalidated)' : (nodes.length ? 'No zone currently flagged.' : 'No node data received.');
    var confs = flaggedNodes.filter(function (d) { return d.est.conf !== null; }).map(function (d) { return d.est.conf; });
    var withBatt = nodes.filter(function (n) { return n.battPct !== null; });
    var low = withBatt.sort(function (a, b) { return a.battPct - b.battPct; })[0];
    out.tiles = [
      { label: 'Detection events', value: String(v.det.events), sub: 'estimate alerts today' },
      { label: 'Peak simultaneous', value: String(v.det.peak), sub: 'zones' },
      { label: 'Average confidence', value: confs.length ? Math.round(confs.reduce(function (a, b) { return a + b; }, 0) / confs.length * 100) + '%' : '—', sub: 'flagged zones (estimates)' },
      { label: 'Lowest battery', value: low ? low.battPct + '%' : '—', sub: low ? 'node ' + low.id : 'not reported' }
    ];
    out.reportNote = ui.report || '';
    out.makeReport = function () { act.report(); };
    out.footerNote = 'Signs-of-life indication only. Presence values are unvalidated estimates computed from Wi-Fi CSI; they are not confirmed detections and do not identify individuals or confirm survival. This tool supplements, not replaces, conventional search-and-rescue equipment. ' +
      (demo ? 'All values shown are SIMULATED demo data.' : 'Values are those received from the configured gateway, shown with their receive time.');

    // ---- analytics ----
    var pdr = v.mesh.pdr != null ? { value: v.mesh.pdr, source: 'reported by gateway' } : v.pdr;
    var pdrColor = pdr && pdr.value < 0.95 ? OCC : accent;
    out.kpis = [
      { label: 'Nodes online', value: online + ' / ' + nodes.length, color: nodes.length && online === nodes.length ? accent : (nodes.length ? OCC : MUT), sub: demo ? 'Simulated nodes' : 'Heard within ' + Math.round(v.staleMs / 1000) + ' s' },
      { label: 'Zones flagged', value: String(flaggedNodes.length), color: flaggedNodes.length ? OCC : MUT, sub: out.occNames },
      { label: 'Packet delivery', value: pdr ? pct(pdr.value) : '—', color: pdr ? pdrColor : MUT, sub: pdr ? pdr.source : 'needs frame seq numbers' },
      { label: 'End-to-end latency', value: v.mesh.latencyMs != null ? Math.round(v.mesh.latencyMs) + ' ms' : '—', color: v.mesh.latencyMs != null && v.mesh.latencyMs > 150 ? OCC : (v.mesh.latencyMs != null ? accent : MUT), sub: v.mesh.latencyMs != null ? 'reported by gateway' : 'not reported by gateway' }
    ];
    out.selId = sd.id; out.selZone = sd.zone || sd.zoneShort;
    out.nodePicks = list.map(function (d) {
      var on = sd.id === d.id;
      return { label: d.id, bg: on ? accent : 'transparent', fg: on ? '#0a1017' : TXT, border: on ? accent : '#33475a', pressed: on ? 'true' : 'false', pick: function () { act.set({ sel: d.id }); } };
    });
    // chart: raw amplitude variance, last 60 s. The window is anchored to the newest sample while data
    // is arriving and FROZEN at the last sample when it stops, so the chart only moves when data does.
    var W = 60000, thr = v.threshold;
    var hist = (v.ds.history[sd.id] || []).filter(function (p) { return p.v !== null; });
    var latest = hist.length ? hist[hist.length - 1] : null;
    var fresh = latest && (now - latest.t) <= v.staleMs;
    var endT = latest ? (fresh ? now : latest.t) : now;
    var ser = hist.filter(function (p) { return p.t >= endT - W && p.t <= endT; });
    var vmax = Math.max(thr ? thr * 3 : 0, ser.reduce(function (m, p) { return Math.max(m, p.v); }, 0) * 1.1, 0.05);
    var many = ser.length >= 2;
    out.chartPoints = many ? ser.map(function (p) { return ((p.t - (endT - W)) / W * 548).toFixed(1) + ',' + (150 - Math.min(1, p.v / vmax) * 130).toFixed(1); }).join(' ') : '0,150 548,150';
    out.chartOp = many ? '1' : '0.25';
    out.thrOp = thr && many ? '1' : '0'; out.thrY = thr ? (150 - Math.min(1, thr / vmax) * 130).toFixed(1) : '150'; out.thrY2 = thr ? (150 - Math.min(1, thr / vmax) * 130 - 5).toFixed(1) : '150';
    var linkOk = demo || link.state === 'receiving';
    out.chartEmpty = !many;
    var ls = link.state;
    out.chartEmptyText = !latest ? (demo ? 'No simulated samples for ' + sd.id + ' yet.' :
      ls === 'idle' ? 'Not connected, so no data from ' + sd.id + '. Open the Connection tab to connect to the gateway.' :
      ls === 'connecting' ? 'Connecting to the gateway… no data from ' + sd.id + ' yet.' :
      ls === 'reconnecting' ? 'Gateway connection lost. No data has been received from ' + sd.id + '.' :
      'Waiting for the first measurement from ' + sd.id + '.') : 'Collecting samples from ' + sd.id + ' (' + ser.length + ' so far)…';
    var ageS = latest ? Math.round((now - latest.t) / 1000) : null;
    if (!latest) { out.chartStatus = 'No measurements received for ' + sd.id; out.chartStatusColor = MUT; }
    else if (fresh) { out.chartStatus = 'Live · latest sample ' + hms(latest.t) + ' (' + ageS + ' s ago)' + (demo ? ' · simulated' : ''); out.chartStatusColor = accent; }
    else { out.chartStatus = 'Paused · last sample ' + hms(latest.t) + ' (' + ageS + ' s ago). Chart resumes when new data arrives.'; out.chartStatusColor = OCC; }
    out.chartNote = many ? 'Raw CSI amplitude variance (arbitrary units) from node ' + sd.id + ', scale 0 to ' + vmax.toFixed(2) + '. The right edge is the latest sample.' + (thr ? ' Dashed line: threshold announced by the gateway.' : ' No detection threshold was announced by the gateway.') : 'The chart draws only received' + (demo ? ' (simulated)' : '') + ' samples; nothing is interpolated or filled in.';
    out.exChart = !!ui.exChart; out.exEst = !!ui.exEst;
    out.explainChartLabel = ui.exChart ? 'Hide explanation' : 'What is CSI variance?'; out.explainEstLabel = ui.exEst ? 'Hide explanation' : 'What do these values mean?';
    out.toggleExChart = function () { act.set({ exChart: !ui.exChart }); }; out.toggleExEst = function () { act.set({ exEst: !ui.exEst }); };
    out.explainVar = EXPLAIN_VAR; out.explainEst = EXPLAIN_EST;
    var st = statusInfo(sd.status, accent), est = sd.est;
    out.selStatus = sd.status === 'nodata' ? 'NO DATA' : sd.status !== 'online' ? 'STALE' : !est ? 'NO ESTIMATE' : est.present ? 'PRESENCE ESTIMATED' : 'NO PRESENCE ESTIMATED';
    out.selColor = sd.status !== 'online' || !est ? MUT : est.present ? OCC : CLR;
    out.selConf = est && est.conf !== null ? Math.round(est.conf * 100) + '%' : '—';
    out.selMat = sd.material || 'unknown material';
    out.selTier = 'Estimate (unvalidated)' + (est && est.algo ? ' · ' + est.algo : '');
    out.feats = [
      { k: 'Amplitude variance · raw', v: sd.ampVar != null ? sd.ampVar.toFixed(3) : '—' },
      { k: 'RSSI · raw', v: sd.rssi != null ? sd.rssi + ' dBm' : '—' },
      { k: 'CSI sample rate · raw', v: sd.pktRate != null ? sd.pktRate + ' pkt/s' : '—' },
      { k: 'Breathing-band power (0.2–0.5 Hz) · processed', v: sd.breathDb != null ? sd.breathDb.toFixed(1) + ' dB' : '—' },
      { k: 'Motion index · processed', v: sd.motion != null ? sd.motion.toFixed(2) : '—' },
      { k: 'Last measurement received (' + st.text.toLowerCase() + ')', v: sd.lastSeen !== null && sd.lastSeen !== undefined ? hms(sd.lastSeen) + ' · ' + Math.round((now - sd.lastSeen) / 1000) + ' s ago' : '—' }
    ];
    var rows = v.metrics || [];
    out.rows = rows.length ? rows.map(function (r) { return { name: r.name, acc: pct(r.acc), fp: pct(r.fp), fn: pct(r.fn), bg: (sd.material && r.name.toLowerCase().indexOf(String(sd.material).toLowerCase().split(' ')[0]) === 0) ? '#16222e' : 'transparent' }; })
      : [{ name: 'No trial data', acc: '—', fp: '—', fn: '—', bg: 'transparent' }];
    out.perfNote = demo ? 'Sample values for layout only' : (rows.length ? 'Reported by gateway' : 'Not available');
    out.perfFoot = demo ? 'Demo table: sample numbers, not measurements. The highlighted row matches the obstruction behind the selected node.' :
      'This table is not computed by the app. It fills only if the gateway sends a trial_metrics message from controlled through-wall trials.';
    // mesh graphic: node ring = status colour; N4 link shows direct vs relay
    var n4 = defs[3], n3 = defs[2], relay = n4.route && n4.route.hops > 1 && n4.status === 'online';
    defs.forEach(function (d, i) { out['c' + (i + 1)] = statusInfo(d.status, accent).color === accent ? (d.est && d.est.present && d.status === 'online' ? OCC : CLR) : statusInfo(d.status, accent).color; });
    ['1', '2', '3'].forEach(function (i) { var s = defs[+i - 1].status; out['lineStroke' + i] = s === 'online' ? '#4a6076' : s === 'nodata' ? '#2a3a4a' : BAD; out['lineDash' + i] = s === 'online' ? '0' : '4 6'; });
    out.directStroke = n4.status === 'nodata' ? '#2a3a4a' : (relay || n4.status !== 'online') ? BAD : '#4a6076';
    out.directDash = (relay || n4.status !== 'online') ? '4 6' : '0';
    out.relayStroke = relay ? accent : '#33475a'; out.relayDash = relay ? '0' : '3 6';
    out.pathNote = relay ? 'The direct link from N4 to the base station is down. N4 now reports ' + n4.route.hops + ' hops' + (n4.route.via ? ' via ' + n4.route.via : '') + '. Data is still arriving.' :
      (nodes.length ? 'Paths are drawn from each node\'s reported route. The dotted N4 to N3 link is the standby relay path (not measured).' : 'No node data yet, so no path information.');
    out.toggleCut = function () { act.cut(!v.demoCut); };
    out.cutLabel = v.demoCut ? 'Restore N4 ↔ base link' : 'Simulate N4 ↔ base link cut';
    out.cutBg = v.demoCut ? 'transparent' : accent; out.cutFg = v.demoCut ? TXT : '#0a1017'; out.cutBorder = v.demoCut ? '#33475a' : accent;
    var anyRelay = nodes.some(function (n) { return n.status === 'online' && n.route && n.route.hops > 1; });
    out.meshRows = [
      { k: 'Packet delivery ratio', v: pdr ? pct(pdr.value) : '—', color: pdr && pdr.value < 0.95 ? OCC : TXT },
      { k: 'End-to-end latency', v: v.mesh.latencyMs != null ? Math.round(v.mesh.latencyMs) + ' ms' : '—', color: v.mesh.latencyMs > 150 ? OCC : TXT },
      { k: 'Communication range', v: v.mesh.rangeM != null ? v.mesh.rangeM + ' m' : '—', color: TXT }
    ].concat(defs.map(function (d) {
      return { k: d.id + ' path to base', v: d.status === 'nodata' ? '—' : d.route ? (d.route.hops === 1 ? 'Direct (1 hop)' : 'via ' + (d.route.via || '?') + ' (' + d.route.hops + ' hops)') : 'not reported', color: d.route && d.route.hops > 1 ? OCC : TXT };
    })).concat([
      { k: 'Message delivery on path loss', v: !nodes.length ? '—' : anyRelay ? 'Delivered via relay' : 'Not triggered', color: anyRelay ? accent : TXT },
      { k: 'Setup time', v: v.mesh.setupS != null ? Math.floor(v.mesh.setupS / 60) + ' min ' + Math.round(v.mesh.setupS % 60) + ' s' : '—', color: TXT }
    ]);

    // ---- alerts & log ----
    out.alerts = v.alerts.map(function (a) {
      return { tag: a.sev.toUpperCase(), color: SEV_COLOR[a.sev] || OCC, cat: CAT_LONG[a.cat] || a.cat, title: a.title, detail: a.detail,
        time: hms(a.since) + (a.active ? '' : ' · cleared ' + hms(a.clearedAt)), op: (a.acked || !a.active) ? '0.55' : '1',
        ackLabel: !a.active ? 'Cleared' : a.acked ? 'Acknowledged' : 'Acknowledge', toggle: function () { if (a.active) act.ack(a.id); } };
    });
    out.alertCount = v.alerts.filter(function (a) { return a.active && !a.acked; }).length;
    out.noAlerts = v.alerts.length === 0;
    out.noAlertsText = demo ? 'No alerts yet.' : 'No alerts. Alerts are raised by app rules on received data.';
    var sevF = ui.sevFilter || 'All';
    out.logs = v.log.filter(function (l) { return (ui.filter === 'All' || l.cat === ui.filter) && (sevF === 'All' || (l.sev || 'Info') === sevF); }).slice(0, 120).map(function (l) {
      var sv = l.sev || 'Info';
      return { time: hms(l.t), cat: CAT_LABEL[l.cat] || l.cat, text: l.text, color: CAT_COLOR[l.cat] || MUT, sev: sv.toUpperCase(), sevColor: SEV_COLOR[sv] || CLR };
    });
    out.noLogs = out.logs.length === 0;
    out.filters = ['All', 'Detect', 'Mesh', 'Gateway', 'System'].map(function (f) {
      var on = ui.filter === f;
      return { label: f === 'Detect' ? 'Detection' : f, bg: on ? accent : 'transparent', fg: on ? '#0a1017' : TXT, border: on ? accent : '#33475a', pressed: on ? 'true' : 'false', pick: function () { act.set({ filter: f }); } };
    });
    out.sevFilters = ['All', 'Info', 'Warning', 'Critical'].map(function (f) {
      var on = sevF === f;
      return { label: f, bg: on ? accent : 'transparent', fg: on ? '#0a1017' : TXT, border: on ? accent : '#33475a', pressed: on ? 'true' : 'false', pick: function () { act.set({ sevFilter: f }); } };
    });
    out.exportLog = function () { act.exportLog(); };
    out.exportNote = ui.exportNote || '';

    // ---- connection tab ----
    out.modeBtns = [['demo', 'Demo Mode'], ['hardware', 'Hardware Mode']].map(function (m) {
      var on = v.mode === m[0];
      return { label: m[1], bg: on ? accent : 'transparent', fg: on ? '#0a1017' : TXT, border: on ? accent : '#33475a', pressed: on ? 'true' : 'false', pick: function () { act.mode(m[0]); } };
    });
    out.modeHelp = demo ? 'Demo Mode shows simulated values so the dashboard can be tested without hardware. Nothing here is a sensor measurement.' :
      'Hardware Mode shows only data received from your local gateway. If the connection drops, the last received values stay on screen, marked stale. The app never falls back to simulated data.';
    var draft = ui.draft;
    out.hostVal = draft.host; out.portVal = draft.port; out.pathVal = draft.path;
    out.onHost = function (e) { act.draft({ host: e.target.value }); }; out.onPort = function (e) { act.draft({ port: e.target.value }); }; out.onPath = function (e) { act.draft({ path: e.target.value }); };
    var ve = ui.errors || {};
    out.hostErr = ve.host || ''; out.portErr = ve.port || ''; out.pathErr = ve.path || '';
    out.hasHostErr = !!ve.host; out.hasPortErr = !!ve.port; out.hasPathErr = !!ve.path;
    var active = link.state === 'connecting' || link.state === 'waiting' || link.state === 'receiving' || link.state === 'stale' || link.state === 'reconnecting';
    out.connectLabel = active ? 'Reconnect' : 'Connect';
    out.doConnect = function () { act.connect(); };
    out.doTest = function () { act.test(); }; out.doRetry = function () { act.retry(); };
    var T = v.test;
    out.hasTest = !!T; out.testBusy = !!(T && T.state === 'testing'); out.testLabel = out.testBusy ? 'Testing…' : 'Test connection';
    out.testTitle = T ? T.title : ''; out.testDetail = T ? T.detail : ''; out.testTime = T ? 'Tested at ' + hms(T.at) : '';
    out.testColor = !T ? MUT : T.state === 'ok' ? accent : T.state === 'fail' ? BAD : T.state === 'warn' ? OCC : CLR;
    out.canRetry = link.state === 'reconnecting'; out.retryOp = '1';
    out.doDisconnect = function () { act.disconnect(); };
    out.discOp = active ? '1' : '0.45';
    var s = v.stats;
    var ago = function (t) { return Math.round((now - t) / 1000) + ' s ago'; };
    out.linkRows = [
      { k: 'Status', v: L.text, color: L.color },
      { k: 'Gateway URL', v: link.url || '—', color: TXT },
      { k: 'Last successful connection', v: v.lastConnectedAt ? dateText(v.lastConnectedAt) + ' ' + hms(v.lastConnectedAt) : 'never', color: TXT },
      { k: 'Messages received (all frames)', v: String(s.frames), color: TXT },
      { k: 'Last message received', v: s.lastFrameAt ? hms(s.lastFrameAt) + ' (' + ago(s.lastFrameAt) + ')' : 'never', color: TXT },
      { k: 'Valid messages', v: String(s.rx) + (s.lastMsgAt ? ' · last ' + hms(s.lastMsgAt) : ''), color: TXT },
      { k: 'Malformed messages', v: String(s.malformed), color: s.malformed ? OCC : TXT },
      { k: 'Unknown-type messages', v: String(s.unknown), color: TXT },
      { k: 'Reconnect attempt', v: link.attempt ? String(link.attempt) : '0', color: TXT },
      { k: 'Next retry', v: link.state === 'reconnecting' && link.nextRetryAt ? 'in ' + Math.max(0, Math.round((link.nextRetryAt - now) / 1000)) + ' s' : '—', color: link.state === 'reconnecting' ? OCC : TXT },
      { k: 'Last error', v: link.error ? friendly(link.error) : (s.lastError || 'none'), color: (link.error || s.lastError) ? BAD : TXT },
      { k: 'Gateway', v: v.ds.hello ? (v.ds.hello.gatewayId || 'unnamed') + (v.ds.hello.fw ? ' · fw ' + v.ds.hello.fw : '') : 'no hello received', color: TXT },
      { k: 'Stale after', v: Math.round(v.staleMs / 1000) + ' s without data', color: TXT }
    ];
    var needHints = link.state === 'reconnecting' || (link.state === 'idle' && !!link.error) || (T && (T.state === 'fail' || T.state === 'warn'));
    out.showHints = !!needHints;
    out.hints = ['The phone is on the gateway\'s Wi-Fi network (not mobile data).', 'IP address and port match the gateway (the default AP address is often 192.168.4.1).', 'The gateway firmware is running and serves a WebSocket at the path (default /csi).', 'The gateway sends protocol v1 JSON frames (see docs/PROTOCOL.md).', 'Use "Test connection" to check the address without touching the live link.'].map(function (t) { return { t: t }; });
    out.connEvents = v.log.filter(function (l) { return l.cat === 'Gateway'; }).slice(0, 8).map(function (l) { var sv = l.sev || 'Info'; return { time: hms(l.t), sev: sv.toUpperCase(), sevColor: SEV_COLOR[sv], text: l.text }; });
    out.noConnEvents = out.connEvents.length === 0;
    out.example = EXAMPLE;
    return out;
  }

  function statusInfo(st, accent) {
    return st === 'online' ? { text: 'Online', color: accent } : st === 'stale' ? { text: 'Stale', color: OCC } : st === 'offline' ? { text: 'Offline', color: BAD } : { text: 'No data', color: '#4a6076' };
  }
  function linkText(link, v, now, accent) {
    switch (link.state) {
      case 'demo': return { text: 'Demo mode · simulated', color: OCC };
      case 'idle': return { text: 'Not connected', color: MUT };
      case 'connecting': return { text: 'Connecting…', color: OCC };
      case 'waiting': return { text: 'Connected · waiting for data', color: OCC };
      case 'receiving': return { text: 'Receiving · ' + hms(v.stats.lastMsgAt), color: accent };
      case 'stale': return { text: 'Stale · no data for ' + Math.round((now - v.stats.lastMsgAt) / 1000) + ' s', color: BAD };
      case 'reconnecting': return { text: 'Reconnecting · attempt ' + link.attempt, color: BAD };
    }
    return { text: link.state, color: MUT };
  }
  function banner(link, v, now) {
    var last = v.stats.lastMsgAt ? ' Last data received ' + hms(v.stats.lastMsgAt) + '.' : '';
    switch (link.state) {
      case 'stale': return { text: 'DATA STALE', color: BAD, detail: 'No valid data for ' + Math.round((now - v.stats.lastMsgAt) / 1000) + ' s. Values below are the last received, not live.' };
      case 'reconnecting': return { text: 'LINK LOST · RECONNECTING', color: BAD, detail: (link.error || 'Connection lost') + '. Attempt ' + link.attempt + ', retry in ' + Math.max(0, Math.round((link.nextRetryAt - now) / 1000)) + ' s.' + (v.stats.lastMsgAt ? ' Values below are the last received, not live.' : '') + last };
      case 'connecting': return { text: 'CONNECTING', color: OCC, detail: 'Opening ' + link.url + (v.stats.lastMsgAt ? '. Values below are the last received, not live.' : '') };
      case 'waiting': return { text: 'WAITING FOR DATA', color: OCC, detail: 'Connected to ' + link.url + ' but no valid message has arrived yet.' };
      case 'idle': return { text: 'NOT CONNECTED', color: MUT, detail: 'Hardware Mode shows no data until a gateway is connected. Open Connection to set the gateway address.' + (v.stats.lastMsgAt ? ' Values below are the last received, not live.' : '') };
    }
    return null;
  }

  var api = { build: build, hms: hms, ZONE_SLOTS: ZONE_SLOTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else CSI.ViewModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
