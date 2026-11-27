/* CSI Rescue Monitor - data store. Owns mode (demo/hardware), per-mode datasets, link state,
 * derived alerts and logs. Demo and hardware datasets are kept completely separate:
 * hardware mode NEVER reads demo data, and a lost connection never falls back to demo values. */
(function (root) {
  'use strict';
  var CSI = (typeof module !== 'undefined' && module.exports) ? null : (root.CSI = root.CSI || {});
  var Protocol = CSI ? CSI.Protocol : require('./csi-protocol.js');
  var TransportMod = CSI ? { Transport: CSI.Transport } : require('./csi-transport.js');

  var SETTINGS_KEY = 'csi.settings.v1';
  var DEFAULT_CFG = { host: '192.168.4.1', port: '81', path: '/csi' };
  var ZONE_DEFAULT = { N1: 'Zone A', N2: 'Zone B', N3: 'Zone C', N4: 'Zone D' };
  var MAX_LOG = 500, MAX_HIST = 600, HIST_MS = 300000, PDR_MS = 300000;
  var RSSI_WARN = -70, HIGH_CONF = 0.8;

  function dayKey(t) { var d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

  function newDataset(source, now) {
    return {
      source: source, nodes: {}, order: [], history: {}, alerts: [], log: [],
      stats: { rx: 0, frames: 0, malformed: 0, unknown: 0, dupOld: 0, lastMsgAt: null, lastFrameAt: null, lastError: null, lastErrorAt: null, openedAt: null, connects: 0 },
      mesh: {}, power: null, hello: null, metrics: null, threshold: null, staleMs: 5000,
      det: { day: dayKey(now), events: 0, peak: 0 }
    };
  }

  // Plain-language version of transport errors, with what to check.
  function friendlyError(e) {
    e = String(e || '');
    if (/timed out/i.test(e)) return 'The gateway did not answer in time.';
    if (/refused|unreachable|Socket error/i.test(e)) return 'The gateway could not be reached (wrong address/port, not on the same Wi-Fi, or gateway not running).';
    if (/closed/i.test(e)) return 'The gateway closed the connection.';
    if (/Cannot open/i.test(e)) return 'The address could not be opened as a WebSocket.';
    return e || 'Connection problem.';
  }

  function Store(opts) {
    opts = opts || {};
    var self = this;
    this.now = opts.now || Date.now;
    this.storage = opts.storage !== undefined ? opts.storage : (typeof localStorage !== 'undefined' ? safeStorage() : null);
    this.notifier = opts.notifier || null;
    this.subs = [];
    this.pending = null;
    this.setT = opts.setTimeout || setTimeout.bind(root);
    this.clearT = opts.clearTimeout || clearTimeout.bind(root);
    this.ds = { demo: newDataset('demo', this.now()), hardware: newDataset('hardware', this.now()) };
    this.settings = { mode: 'demo', config: Object.assign({}, DEFAULT_CFG), autoConnect: false, lastConnectedAt: null };
    this.WSImpl = opts.WebSocket || null;
    this.test = null; this._testSock = null; this._testTimers = [];
    this._load();
    this.demoCut = false;
    this.link = { state: 'idle', attempt: 0, nextRetryAt: null, error: null, url: null };
    this.cfgErrors = {};
    this.transport = new TransportMod.Transport({
      WebSocket: opts.WebSocket, setTimeout: opts.setTransportTimeout, clearTimeout: opts.clearTransportTimeout,
      now: this.now, random: opts.random, connectTimeoutMs: opts.connectTimeoutMs,
      baseDelayMs: opts.baseDelayMs, maxDelayMs: opts.maxDelayMs,
      onState: function (s, i) { self._onLink(s, i); },
      onFrame: function (t) { self._onFrame(t); }
    });
    this.demo = opts.demoFactory ? opts.demoFactory({ emit: function (m) { self.ingest(m, 'demo'); }, onEvent: function (m) { self.ingest(m, 'demo'); } }) : null;
    this.timer = null; this.tickMs = opts.tickMs || 1000;
  }

  function safeStorage() { try { return localStorage; } catch (e) { return null; } }

  Store.prototype._load = function () {
    try {
      var raw = this.storage && this.storage.getItem(SETTINGS_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.mode === 'hardware' || s.mode === 'demo') this.settings.mode = s.mode;
      if (s.config && typeof s.config === 'object') this.settings.config = Object.assign({}, DEFAULT_CFG, {
        host: String(s.config.host || DEFAULT_CFG.host), port: String(s.config.port || DEFAULT_CFG.port), path: String(s.config.path || DEFAULT_CFG.path)
      });
      this.settings.autoConnect = s.autoConnect === true;
      if (typeof s.lastConnectedAt === 'number') this.settings.lastConnectedAt = s.lastConnectedAt;
    } catch (e) { /* ignore corrupt settings */ }
  };
  Store.prototype._save = function () { try { if (this.storage) this.storage.setItem(SETTINGS_KEY, JSON.stringify(this.settings)); } catch (e) { /* ignore */ } };

  // ---------- lifecycle ----------
  Store.prototype.start = function () {
    var self = this;
    if (this.timer) return;
    this.timer = this.setT(function loop() { self.tick(); self.timer = self.setT(loop, self.tickMs); }, this.tickMs);
    this._applyMode(true);
  };
  Store.prototype.stop = function () {
    if (this.timer) { this.clearT(this.timer); this.timer = null; }
    if (this.demo) this.demo.stop();
    this.transport.disconnect();
  };
  Store.prototype.tick = function () {
    var now = this.now(), ds = this.cur();
    this.evaluate(ds, now);
    this._notify();
  };
  // App moved to background / foreground (WebView paused/resumed)
  Store.prototype.setVisible = function (visible) {
    if (this.settings.mode === 'demo') { if (this.demo) { visible ? this.demo.start() : this.demo.stop(); } return; }
    if (visible && this.settings.autoConnect && this.transport.wanted && this.transport.state !== 'open' && this.transport.state !== 'connecting') this.transport.retryNow();
    this._notify();
  };

  Store.prototype.cur = function () { return this.ds[this.settings.mode]; };

  Store.prototype.setMode = function (mode) {
    if (mode !== 'demo' && mode !== 'hardware') return;
    if (mode === this.settings.mode) return;
    this.settings.mode = mode;
    this._save();
    this._applyMode(false);
    this._notify();
  };
  Store.prototype._applyMode = function (initial) {
    if (this.settings.mode === 'demo') {
      this.transport.disconnect();
      if (this.demo) { this.demo.setCut(this.demoCut); this.demo.start(); }
    } else {
      if (this.demo) this.demo.stop();
      var v = Protocol.validateGateway(this.settings.config);
      if (this.settings.autoConnect && v.ok) this.connect(this.settings.config);
    }
  };

  Store.prototype.setDemoCut = function (cut) {
    this.demoCut = !!cut;
    if (this.demo) this.demo.setCut(this.demoCut);
    this._notify();
  };

  // ---------- hardware link ----------
  Store.prototype.validate = function (cfg) { return Protocol.validateGateway(cfg); };

  Store.prototype.connect = function (cfg) {
    var v = Protocol.validateGateway(cfg || this.settings.config);
    this.cfgErrors = v.errors;
    if (!v.ok) { this._notify(); return { ok: false, errors: v.errors }; }
    this.settings.config = v.config; this.settings.autoConnect = true; this._save();
    if (this.settings.mode !== 'hardware') { this.settings.mode = 'hardware'; this._save(); if (this.demo) this.demo.stop(); }
    this._log(this.ds.hardware, 'Gateway', 'Connecting to ' + v.url, 'link', 'Info');
    this.transport.connect(v.url);
    this._notify();
    return { ok: true, url: v.url };
  };
  Store.prototype.disconnect = function () {
    this.settings.autoConnect = false; this._save();
    this.transport.disconnect();
    this._log(this.ds.hardware, 'Gateway', 'Disconnected by user', 'link', 'Info');
    this._notify();
  };
  Store.prototype.retryNow = function () { this.transport.retryNow(); };

  Store.prototype._onLink = function (state, info) {
    var ds = this.ds.hardware, now = this.now(), prev = this.link.state;
    this.link = { state: state, attempt: info.attempt, nextRetryAt: info.nextRetryAt, error: info.error, url: info.url };
    if (state === 'open') { ds.stats.openedAt = now; ds.stats.lastMsgAt = null; ds.stats.connects++; this.settings.lastConnectedAt = now; this._save(); this._log(ds, 'Gateway', 'Connected to ' + info.url + ' (waiting for data)', 'link', 'Info'); }
    else if (state === 'reconnecting') {
      this._log(ds, 'Gateway', 'Connection lost: ' + (info.error || 'unknown') + '. Reconnect attempt ' + info.attempt + ' in ' + Math.max(0, Math.round((info.nextRetryAt - now) / 1000)) + ' s', 'link', 'Warning');
    }
    if (this.settings.mode === 'hardware') this.evaluate(ds, now);
    if (prev !== state) this._notify();
  };

  Store.prototype._onFrame = function (text) {
    var ds = this.ds.hardware, r = Protocol.parse(text);
    ds.stats.frames++; ds.stats.lastFrameAt = this.now();
    if (!r.ok) {
      ds.stats.malformed++; ds.stats.lastError = r.error; ds.stats.lastErrorAt = this.now();
      if (ds.stats.malformed === 1 || ds.stats.malformed % 20 === 0) this._log(ds, 'Gateway', 'Malformed frame ignored (' + ds.stats.malformed + ' total): ' + r.error, 'link', 'Warning');
      this.evaluate(ds, this.now());
      this._notify();
      return;
    }
    this.ingest(r.msg, 'hardware');
  };

  // ---------- ingest ----------
  Store.prototype.ingest = function (msg, source) {
    var ds = this.ds[source], now = this.now();
    if (!ds) return;
    if (msg.type === 'unknown') { ds.stats.unknown++; return; }
    ds.stats.rx++; ds.stats.lastMsgAt = now;
    switch (msg.type) {
      case 'hello': this._hello(ds, msg, now); break;
      case 'node_frame': this._frame(ds, msg, now); break;
      case 'status': this._status(ds, msg, now); break;
      case 'mesh': ds.mesh = { pdr: msg.pdr, latencyMs: msg.latencyMs, rangeM: msg.rangeM, setupS: msg.setupS, at: now }; break;
      case 'event': this._log(ds, msg.cat, (msg.node ? msg.node + ': ' : '') + msg.text, 'gateway', msg.sev); break;
      case 'trial_metrics': ds.metrics = msg.rows; break;
    }
    this.evaluate(ds, now);
    if (source === this.settings.mode) this._notify();
  };

  Store.prototype._node = function (ds, id, now) {
    var n = ds.nodes[id];
    if (!n) {
      n = ds.nodes[id] = { id: id, firstSeen: now, lastSeen: null, seq: null, zone: null, material: null, forcedOffline: false, pdrWin: [], rssi: null, battPct: null, pktRate: null, ampVar: null, breathDb: null, motion: null, est: null, route: null, deviceTs: null };
      ds.order.push(id);
    }
    return n;
  };
  Store.prototype._hello = function (ds, m, now) {
    ds.hello = { gatewayId: m.gatewayId, fw: m.fw, simulated: m.simulated === true, kind: m.kind || null, at: now };
    if (m.threshold !== undefined) ds.threshold = m.threshold;
    if (m.staleMs !== undefined) ds.staleMs = m.staleMs;
    var self = this;
    m.nodes.forEach(function (n) { var r = self._node(ds, n.id, now); r.zone = n.zone; r.material = n.material; r.pos = n.pos || null; });
    this._log(ds, 'Gateway', (m.simulated ? 'SOFTWARE SIMULATOR hello' : 'Gateway hello') + (m.gatewayId ? ': ' + m.gatewayId : '') + (m.fw ? ' (fw ' + m.fw + ')' : '') + ', ' + m.nodes.length + ' node(s) declared', 'gateway', 'Info');
  };
  Store.prototype._status = function (ds, m, now) {
    if (m.power) ds.power = { source: m.power.source, runtimeMin: m.power.runtimeMin, at: now };
    var self = this;
    m.nodes.forEach(function (s) { self._node(ds, s.id, now).forcedOffline = !s.online; });
  };
  Store.prototype._frame = function (ds, m, now) {
    var n = this._node(ds, m.node, now);
    // Duplicate / out-of-order frame: an older or repeated seq must not overwrite newer values.
    // A run of 3 consecutive "old" frames is treated as a node restart (seq counter reset) and accepted.
    if (m.seq !== null && n.seq !== null && m.seq <= n.seq && n.seq - m.seq < 8 && (n.oldRun = (n.oldRun || 0) + 1) < 3) {
      ds.stats.dupOld = (ds.stats.dupOld || 0) + 1; ds.stats.rx--; return;
    }
    n.oldRun = 0;
    // PDR bookkeeping from sequence numbers
    var expected = 1;
    if (m.seq !== null && n.seq !== null && m.seq > n.seq && m.seq - n.seq < 1000) expected = m.seq - n.seq;
    if (m.seq !== null && n.seq !== null && m.seq <= n.seq) expected = 1; // restart/duplicate
    n.pdrWin.push([now, expected]);
    while (n.pdrWin.length && now - n.pdrWin[0][0] > PDR_MS) n.pdrWin.shift();
    n.seq = m.seq !== null ? m.seq : n.seq; n.hasSeq = n.hasSeq || m.seq !== null;
    n.lastSeen = now; n.forcedOffline = false; n.deviceTs = m.deviceTs;
    // each frame replaces all values (absent field = unknown)
    n.rssi = m.rssi === undefined ? null : m.rssi; n.ampVar = m.ampVar === undefined ? null : m.ampVar;
    n.pktRate = m.pktRate === undefined ? null : m.pktRate; n.battPct = m.battPct === undefined ? null : m.battPct;
    n.breathDb = m.breathDb === undefined ? null : m.breathDb; n.motion = m.motion === undefined ? null : m.motion;
    n.est = m.est; n.route = m.route; n.vitals = m.vitals || null;
    var h = ds.history[m.node] || (ds.history[m.node] = []);
    h.push({ t: now, v: n.ampVar });
    while (h.length > MAX_HIST || (h.length && now - h[0].t > HIST_MS)) h.shift();
  };

  // ---------- derived state ----------
  Store.prototype.nodeStatus = function (ds, n, now) {
    if (n.lastSeen === null) return 'nodata';
    if (n.forcedOffline) return 'offline';
    var age = now - n.lastSeen;
    return age <= ds.staleMs ? 'online' : age <= ds.staleMs * 3 ? 'stale' : 'offline';
  };
  function zoneShort(n) { return (n.zone ? n.zone.split(' · ')[0] : null) || ZONE_DEFAULT[n.id] || n.id; }

  var SEV_RANK = { Info: 1, Warning: 2, Critical: 3 };

  Store.prototype.evaluate = function (ds, now) {
    var active = {}, self = this, flagged = 0;
    if (dayKey(now) !== ds.det.day) ds.det = { day: dayKey(now), events: 0, peak: 0 };
    // When the gateway link itself is down/stale, node data is stale because of the link,
    // not because of the mesh: raise one gateway alert instead of one per node.
    var gwState = ds.source === 'hardware' && this.settings.mode === 'hardware' ? this.linkView(now).state : null;
    var gwDown = gwState === 'reconnecting' || gwState === 'connecting' || gwState === 'stale' || gwState === 'waiting';
    ds.order.forEach(function (id) {
      var n = ds.nodes[id], st = self.nodeStatus(ds, n, now), z = zoneShort(n);
      if (st === 'online' && n.est && n.est.present) {
        var hi = n.est.conf !== null && n.est.conf >= HIGH_CONF, c = n.est.conf === null ? 'unknown' : Math.round(n.est.conf * 100) + '%';
        active['sig:' + id] = { sev: hi ? 'Critical' : 'Warning', kind: 'signal', cat: 'Detect', title: (hi ? 'Possible signs of life · ' : 'Weak presence estimate · ') + z,
          detail: id + ' reports a presence ESTIMATE at ' + c + ' confidence (' + (n.est.algo || 'unnamed algorithm') + ', ' + (n.est.validated ? 'marked validated by gateway' : 'not validated') + '). This is not a confirmed detection. Verify with a manual check before acting.' };
        flagged++;
      }
      if (st === 'online' && n.rssi !== null && n.rssi < RSSI_WARN)
        active['rssi:' + id] = { sev: 'Warning', kind: 'rssi', cat: 'Mesh', title: 'Weak signal · ' + id, detail: 'Measured RSSI is ' + n.rssi + ' dBm, below the ' + RSSI_WARN + ' dBm advisory level. Consider moving ' + id + ' closer.' };
      if ((st === 'stale' || st === 'offline') && !gwDown)
        active['node:' + id] = { sev: st === 'offline' ? 'Critical' : 'Warning', kind: 'node', cat: 'Mesh', title: 'Node ' + (st === 'stale' ? 'data stale' : 'disconnected') + ' · ' + id, detail: 'No valid data from ' + id + ' for ' + Math.round((now - n.lastSeen) / 1000) + ' s while the gateway link is up, so this node has dropped off the mesh. Values shown for this node are the last received, not current.' };
      if (st === 'online' && n.route && n.route.hops > 1)
        active['link:' + id] = { sev: 'Warning', kind: 'link', cat: 'Mesh', title: 'Direct link lost · ' + id + ' to base', detail: id + ' reports ' + n.route.hops + ' hops' + (n.route.via ? ' via ' + n.route.via : '') + '. Data is still arriving through the relay path.' };
    });
    if (ds.source === 'hardware') {
      var lv = this.linkView(now);
      if (gwState === 'reconnecting' || (gwState === 'connecting' && lv.attempt > 0))
        active['gw:link'] = { sev: 'Critical', kind: 'gateway', cat: 'Gateway', title: 'Gateway connection lost', detail: friendlyError(lv.error) + ' Reconnect attempt ' + lv.attempt + (lv.nextRetryAt ? ', next try in ' + Math.max(0, Math.round((lv.nextRetryAt - now) / 1000)) + ' s' : '') + '. Monitoring is blind until the link returns; displayed values are the last received.' };
      if (gwState === 'stale')
        active['gw:stale'] = { sev: 'Warning', kind: 'gateway', cat: 'Gateway', title: 'Gateway data stale', detail: 'The gateway socket is open but no valid message has arrived for ' + Math.round((now - ds.stats.lastMsgAt) / 1000) + ' s. Displayed values are the last received.' };
      if (gwState && ds.stats.lastErrorAt !== null && now - ds.stats.lastErrorAt < 30000)
        active['gw:malformed'] = { sev: 'Info', kind: 'gateway', cat: 'Gateway', title: ds.stats.malformed + ' malformed frame(s) ignored', detail: 'Last problem: ' + ds.stats.lastError + '. Frames that fail validation are discarded and never shown as data.' };
    }
    var byId = {};
    ds.alerts.forEach(function (a) { byId[a.id] = a; });
    Object.keys(active).forEach(function (id) {
      var d = active[id], a = byId[id];
      if (!a) {
        a = { id: id, sev: d.sev, kind: d.kind, cat: d.cat, title: d.title, detail: d.detail, since: now, active: true, acked: false, clearedAt: null };
        ds.alerts.unshift(a); self._raised(ds, a);
      } else if (!a.active) {
        a.sev = d.sev; a.title = d.title; a.detail = d.detail; a.since = now; a.active = true; a.acked = false; a.clearedAt = null; self._raised(ds, a);
      } else {
        var upgraded = SEV_RANK[d.sev] > SEV_RANK[a.sev];
        a.sev = d.sev; a.title = d.title; a.detail = d.detail;
        if (upgraded) { a.acked = false; self._raised(ds, a, true); }
      }
    });
    ds.alerts.forEach(function (a) {
      if (a.active && !active[a.id]) { a.active = false; a.clearedAt = now; self._log(ds, a.cat, 'Alert cleared: ' + a.title, 'app', 'Info'); }
    });
    if (ds.alerts.length > 60) { var keep = ds.alerts.filter(function (a) { return a.active; }); var rest = ds.alerts.filter(function (a) { return !a.active; }).slice(0, Math.max(0, 60 - keep.length)); ds.alerts = ds.alerts.filter(function (a) { return keep.indexOf(a) >= 0 || rest.indexOf(a) >= 0; }); }
    if (flagged > ds.det.peak) ds.det.peak = flagged;
  };
  Store.prototype._raised = function (ds, a, upgrade) {
    this._log(ds, a.cat, (upgrade ? 'Alert upgraded: ' : 'Alert raised: ') + a.title, 'app', a.sev);
    if (a.kind === 'signal' && !upgrade) ds.det.events++;
    if (ds.source === 'hardware' && this.notifier && a.sev !== 'Info') { try { this.notifier(a.sev.toUpperCase() + ' · ' + a.title, a.detail); } catch (e) { /* ignore */ } }
  };
  Store.prototype.ack = function (id) {
    var a = this.cur().alerts.filter(function (x) { return x.id === id; })[0];
    if (a) { a.acked = !a.acked; this._notify(); }
  };
  Store.prototype._log = function (ds, cat, text, src, sev) {
    ds.log.unshift({ t: this.now(), cat: cat, text: text, src: src || 'app', sev: sev || 'Info' });
    if (ds.log.length > MAX_LOG) ds.log.length = MAX_LOG;
  };

  // ---------- views for UI ----------
  Store.prototype.pdr = function (ds, now) {
    var got = 0, exp = 0, any = false;
    ds.order.forEach(function (id) {
      var n = ds.nodes[id]; if (!n.hasSeq) return;
      n.pdrWin.forEach(function (p) { if (now - p[0] <= PDR_MS) { got++; exp += p[1]; any = true; } });
    });
    return any && exp > 0 ? { value: got / exp, source: 'computed from frame sequence numbers, last 5 min' } : null;
  };
  Store.prototype.series = function (id, windowMs) {
    var ds = this.cur(), now = this.now(), h = ds.history[id] || [];
    return h.filter(function (p) { return now - p.t <= windowMs && p.v !== null; });
  };
  Store.prototype.linkView = function (now) {
    var ds = this.ds.hardware, l = this.link;
    if (this.settings.mode === 'demo') return { state: 'demo' };
    var state = l.state;
    if (state === 'open') {
      if (ds.stats.lastMsgAt === null) state = 'waiting';
      else state = (now - ds.stats.lastMsgAt) > ds.staleMs ? 'stale' : 'receiving';
    }
    return { state: state, attempt: l.attempt, nextRetryAt: l.nextRetryAt, error: l.error, url: l.url };
  };
  Store.prototype.view = function () {
    var now = this.now(), ds = this.cur(), self = this;
    var nodes = ds.order.map(function (id) {
      var n = ds.nodes[id];
      return Object.assign({}, n, { status: self.nodeStatus(ds, n, now), ageMs: n.lastSeen !== null ? now - n.lastSeen : null, zoneShort: zoneShort(n) });
    });
    return {
      now: now, mode: this.settings.mode, config: this.settings.config, cfgErrors: this.cfgErrors,
      link: this.linkView(now), stats: this.ds.hardware.stats, ds: ds, nodes: nodes, alerts: ds.alerts, log: ds.log, det: ds.det,
      mesh: ds.mesh, pdr: this.pdr(ds, now), power: ds.power, metrics: ds.metrics, threshold: ds.threshold, staleMs: ds.staleMs,
      demoCut: this.demoCut, autoConnect: this.settings.autoConnect, test: this.test, lastConnectedAt: this.settings.lastConnectedAt
    };
  };

  // Persist the edited address even before Connect is pressed (validated again on Connect).
  Store.prototype.setDraft = function (cfg) {
    var c = this.settings.config;
    this.settings.config = { host: cfg.host !== undefined ? String(cfg.host) : c.host, port: cfg.port !== undefined ? String(cfg.port) : c.port, path: cfg.path !== undefined ? String(cfg.path) : c.path };
    this._save();
  };

  // One-shot reachability test on a separate socket. It never touches the live connection,
  // the datasets, counters or logs of Hardware Mode, and never ingests the frames it sees.
  Store.prototype.testConnection = function (cfg) {
    var self = this, v = Protocol.validateGateway(cfg || this.settings.config), WS = this.WSImpl || root.WebSocket;
    if (this.test && this.test.state === 'testing') return;
    this.cfgErrors = v.errors;
    if (!v.ok) { this.test = { state: 'fail', at: this.now(), title: 'Address not valid', detail: Object.keys(v.errors).map(function (k) { return v.errors[k]; }).join(' ') }; this._notify(); return; }
    var t0 = this.now(), openMs = null, valid = 0, invalid = 0, lastInvalid = null, firstType = null, done = false, sock = null;
    this.test = { state: 'testing', at: t0, url: v.url, title: 'Testing ' + v.url + ' …', detail: 'Opening a temporary connection. Your current connection is not affected.' };
    var finish = function (res) {
      if (done) return; done = true;
      self._testTimers.forEach(function (h) { self.clearT(h); }); self._testTimers = [];
      if (sock) { sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null; try { sock.close(); } catch (e) { /* ignore */ } sock = null; }
      res.at = self.now(); res.url = v.url; self.test = res; self._notify();
    };
    var fail = function (why) { finish({ state: 'fail', title: 'Gateway not reachable', detail: friendlyError(why) + ' Tested ' + v.url + '.' }); };
    try { if (!WS) throw new Error('WebSocket not supported'); sock = new WS(v.url); } catch (e) { fail('Cannot open socket'); return; }
    this._testTimers.push(this.setT(function () { fail('Connection timed out'); }, 6000));
    sock.onopen = function () {
      openMs = self.now() - t0;
      self.test = { state: 'testing', at: t0, url: v.url, title: 'Socket opened in ' + openMs + ' ms', detail: 'Waiting up to 4 s for a valid message …' }; self._notify();
      self._testTimers.push(self.setT(function () {
        if (valid) return;
        finish(invalid ? { state: 'warn', title: 'Connected, but data is not valid', detail: 'Socket opened in ' + openMs + ' ms. Received ' + invalid + ' frame(s) that failed protocol v1 validation (' + lastInvalid + '). Check the gateway message format.' }
          : { state: 'warn', title: 'Connected, but no data yet', detail: 'Socket opened in ' + openMs + ' ms, but no message arrived within 4 s. The address works; the gateway is not sending data (or only sends after a request).' });
      }, 4000));
    };
    sock.onmessage = function (ev) {
      var r = Protocol.parse(ev.data);
      if (r.ok && r.msg.type !== 'unknown') { valid++; firstType = firstType || r.msg.type; finish({ state: 'ok', title: 'Gateway reachable and sending valid data', detail: 'Socket opened in ' + openMs + ' ms; first valid message was "' + firstType + '". Press Connect to start monitoring. (Test data is not shown or stored.)' }); }
      else { invalid++; lastInvalid = r.ok ? 'unknown message type' : r.error; }
    };
    sock.onerror = function () { if (openMs === null) fail('Socket error'); };
    sock.onclose = function (ev) { if (!done) { if (openMs === null) fail('Socket error'); else if (!valid) finish({ state: 'warn', title: 'Gateway closed the connection', detail: 'Socket opened in ' + openMs + ' ms, then the gateway closed it' + (ev && ev.code ? ' (code ' + ev.code + ')' : '') + ' before sending valid data.' }); } };
    this._notify();
  };
  Store.prototype.clearTest = function () { this.test = null; this._notify(); };

  // ---------- subscriptions ----------
  Store.prototype.subscribe = function (fn) {
    this.subs.push(fn); var s = this;
    return function () { s.subs = s.subs.filter(function (f) { return f !== fn; }); };
  };
  Store.prototype._notify = function () {
    var self = this;
    if (this.pending) return;
    this.pending = this.setT(function () { self.pending = null; self.subs.slice().forEach(function (f) { try { f(); } catch (e) { if (typeof console !== 'undefined') console.error(e); } }); }, 120);
  };

  // ---------- exports ----------
  function csvCell(v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  Store.prototype.exportLogCsv = function () {
    var ds = this.cur(), src = this.settings.mode === 'demo' ? 'DEMO' : 'HARDWARE';
    var rows = ['received_at_iso,severity,category,origin,data_source,message'];
    ds.log.slice().reverse().forEach(function (l) { rows.push([new Date(l.t).toISOString(), l.sev || 'Info', l.cat, l.src, src, l.text].map(csvCell).join(',')); });
    return rows.join('\r\n') + '\r\n';
  };
  Store.prototype.exportReport = function () {
    var v = this.view(), mode = v.mode;
    return JSON.stringify({
      app: 'CSI Rescue Monitor', exportedAt: new Date(v.now).toISOString(),
      dataSource: mode === 'demo' ? 'DEMO: simulated values, not sensor measurements' : (this.ds.hardware.hello && this.ds.hardware.hello.simulated ? 'HARDWARE MODE via SOFTWARE SIMULATOR: values are simulated, not physical measurements' : 'HARDWARE: values received from gateway'),
      disclaimer: 'Presence values are unvalidated estimates, not confirmed detections.',
      gateway: mode === 'hardware' ? { config: v.config, link: v.link.state, lastMessageAt: v.stats.lastMsgAt ? new Date(v.stats.lastMsgAt).toISOString() : null, framesReceived: v.stats.rx, malformedFrames: v.stats.malformed } : null,
      nodes: v.nodes.map(function (n) { return { id: n.id, status: n.status, lastReceivedAt: n.lastSeen ? new Date(n.lastSeen).toISOString() : null, raw: { rssi_dbm: n.rssi, amp_var: n.ampVar, pkt_rate: n.pktRate }, processed: { breath_band_db: n.breathDb, motion_idx: n.motion }, estimate: n.est, battery_pct: n.battPct }; }),
      detectionEventsToday: v.det.events, alerts: v.alerts.map(function (a) { return { id: a.id, severity: a.sev, category: a.cat, title: a.title, since: new Date(a.since).toISOString(), active: a.active, acknowledged: a.acked }; }),
      log: v.log.slice(0, 200).map(function (l) { return { at: new Date(l.t).toISOString(), severity: l.sev || 'Info', cat: l.cat, origin: l.src, text: l.text }; })
    }, null, 2);
  };

  var api = { friendlyError: friendlyError, Store: Store, ZONE_DEFAULT: ZONE_DEFAULT, DEFAULT_CFG: DEFAULT_CFG, zoneShort: zoneShort };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else CSI.Store = Store, CSI.storeUtil = api;
})(typeof window !== 'undefined' ? window : globalThis);
