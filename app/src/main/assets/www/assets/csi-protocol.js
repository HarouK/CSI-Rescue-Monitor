/* CSI Rescue Monitor - message protocol (v1): parsing + validation.
 * Pure functions, no UI, no network. Works in browser and Node (for tests).
 * THIS IS A PROPOSED INTERFACE, NOT THE ESP32 FIRMWARE'S ACTUAL FORMAT.
 * See docs/PROTOCOL.md. Adapt the gateway (or this file) to match real firmware. */
(function (root) {
  'use strict';
  var VERSION = 1;
  var NODE_ID = /^[A-Za-z0-9_-]{1,16}$/;
  var MAX_FRAME = 65536;
  var CATS = ['Detect', 'Mesh', 'Gateway', 'System'];
  var SEVS = ['Info', 'Warning', 'Critical'];

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function bad(msg) { return { ok: false, error: msg }; }
  function str(x, max) { return typeof x === 'string' ? x.slice(0, max) : null; }

  // optional numeric field in range; returns undefined (absent), null->error via thrown string
  function optNum(o, key, lo, hi, label) {
    var v = o[key];
    if (v === undefined || v === null) return undefined;
    if (!isNum(v)) throw label + ' must be a number';
    if (v < lo || v > hi) throw label + ' out of range (' + lo + '..' + hi + ')';
    return v;
  }

  function parse(text) {
    if (typeof text !== 'string') return bad('Frame is not text');
    if (text.length > MAX_FRAME) return bad('Frame too large');
    if (!text.trim()) return bad('Empty frame');
    var o;
    try { o = JSON.parse(text); } catch (e) { return bad('Invalid JSON'); }
    return validate(o);
  }

  function validate(o) {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('Frame is not a JSON object');
    if (o.v !== VERSION) return bad('Unsupported protocol version: ' + String(o.v));
    if (typeof o.type !== 'string') return bad('Missing "type"');
    try {
      switch (o.type) {
        case 'hello': return { ok: true, msg: hello(o) };
        case 'node_frame': return { ok: true, msg: nodeFrame(o) };
        case 'status': return { ok: true, msg: status(o) };
        case 'mesh': return { ok: true, msg: mesh(o) };
        case 'event': return { ok: true, msg: event(o) };
        case 'trial_metrics': return { ok: true, msg: trialMetrics(o) };
        default: return { ok: true, msg: { type: 'unknown', rawType: o.type.slice(0, 32) } };
      }
    } catch (e) {
      return bad(typeof e === 'string' ? e : 'Invalid message');
    }
  }

  function nodeId(x) {
    if (typeof x !== 'string' || !NODE_ID.test(x)) throw 'Invalid node id';
    return x;
  }

  function hello(o) {
    var nodes = [];
    if (o.nodes !== undefined) {
      if (!Array.isArray(o.nodes)) throw 'hello.nodes must be an array';
      if (o.nodes.length > 32) throw 'hello.nodes too long';
      o.nodes.forEach(function (n) {
        if (!n || typeof n !== 'object') throw 'hello.nodes entry invalid';
        nodes.push({ id: nodeId(n.id), zone: str(n.zone, 60), material: str(n.material, 40), pos: pos2(n.pos, 'hello.nodes[].pos') });
      });
    }
    return {
      type: 'hello', gatewayId: str(o.gateway_id, 40), fw: str(o.fw, 40), nodes: nodes,
      simulated: o.simulated === true, kind: str(o.gateway_kind, 24),
      threshold: optNum(o, 'threshold', 0, 1e6, 'threshold'),
      staleMs: optNum(o, 'stale_ms', 500, 600000, 'stale_ms')
    };
  }

  // optional normalised room coordinate {x,y}, each 0..1 (0,0 = near-left corner of the room)
  function pos2(p, label) {
    if (p === undefined || p === null) return null;
    if (typeof p !== 'object' || !isNum(p.x) || !isNum(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) throw label + ' must be {x,y} numbers between 0 and 1';
    return { x: p.x, y: p.y };
  }

  function nodeFrame(o) {
    var raw = o.raw || {}, proc = o.processed || {}, est = o.estimate;
    if (typeof raw !== 'object' || typeof proc !== 'object') throw 'raw/processed must be objects';
    var m = {
      type: 'node_frame', node: nodeId(o.node),
      seq: isNum(o.seq) && o.seq >= 0 && Math.floor(o.seq) === o.seq ? o.seq : null,
      deviceTs: optNum(o, 'ts', 0, 1e15, 'ts'),
      rssi: optNum(raw, 'rssi', -127, 0, 'raw.rssi'),
      ampVar: optNum(raw, 'amp_var', 0, 1e9, 'raw.amp_var'),
      pktRate: optNum(raw, 'pkt_rate', 0, 10000, 'raw.pkt_rate'),
      battPct: optNum(o, 'batt_pct', 0, 100, 'batt_pct'),
      breathDb: optNum(proc, 'breath_band_db', -200, 200, 'processed.breath_band_db'),
      motion: optNum(proc, 'motion_idx', 0, 1e6, 'processed.motion_idx'),
      route: null, est: null, vitals: null
    };
    if (o.vitals !== undefined && o.vitals !== null) {
      var vt = o.vitals;
      if (typeof vt !== 'object') throw 'vitals must be an object';
      m.vitals = { respRpm: optNum(vt, 'resp_rpm', 0, 120, 'vitals.resp_rpm'), heartBpm: optNum(vt, 'heart_bpm', 0, 300, 'vitals.heart_bpm'), validated: vt.validated === true };
    }
    if (o.route !== undefined && o.route !== null) {
      var r = o.route;
      if (typeof r !== 'object' || !isNum(r.hops) || r.hops < 1 || r.hops > 16) throw 'route.hops invalid';
      m.route = { hops: Math.floor(r.hops), via: r.via == null ? null : nodeId(r.via) };
    }
    if (est !== undefined && est !== null) {
      if (typeof est !== 'object' || typeof est.present !== 'boolean') throw 'estimate.present must be boolean';
      var c = optNum(est, 'confidence', 0, 1, 'estimate.confidence');
      var cnt = optNum(est, 'count', 0, 64, 'estimate.count');
      if (cnt !== undefined && Math.floor(cnt) !== cnt) throw 'estimate.count must be an integer';
      m.est = { present: est.present, conf: c === undefined ? null : c, algo: str(est.algorithm, 40), validated: est.validated === true,
        count: cnt === undefined ? null : cnt, pos: pos2(est.position, 'estimate.position') };
    }
    if (m.rssi === undefined && m.ampVar === undefined && m.pktRate === undefined && m.breathDb === undefined && m.motion === undefined && !m.est && !m.vitals && m.battPct === undefined) throw 'node_frame carries no measurements';
    return m;
  }

  function status(o) {
    var out = { type: 'status', power: null, nodes: [] };
    if (o.power != null) {
      if (typeof o.power !== 'object') throw 'power must be an object';
      out.power = { source: str(o.power.source, 40), runtimeMin: optNum(o.power, 'runtime_min', 0, 100000, 'power.runtime_min') };
    }
    if (o.nodes !== undefined) {
      if (!Array.isArray(o.nodes) || o.nodes.length > 32) throw 'status.nodes invalid';
      o.nodes.forEach(function (n) {
        if (!n || typeof n.online !== 'boolean') throw 'status.nodes[].online must be boolean';
        out.nodes.push({ id: nodeId(n.id), online: n.online });
      });
    }
    return out;
  }

  function mesh(o) {
    return {
      type: 'mesh', pdr: optNum(o, 'pdr', 0, 1, 'pdr'), latencyMs: optNum(o, 'latency_ms', 0, 1e7, 'latency_ms'),
      rangeM: optNum(o, 'range_m', 0, 1e5, 'range_m'), setupS: optNum(o, 'setup_s', 0, 1e6, 'setup_s')
    };
  }

  function event(o) {
    var text = str(o.text, 200);
    if (!text) throw 'event.text required';
    if (CATS.indexOf(o.cat) < 0) throw 'event.cat must be Detect, Mesh, Gateway or System';
    if (o.sev !== undefined && SEVS.indexOf(o.sev) < 0) throw 'event.sev must be Info, Warning or Critical';
    return { type: 'event', cat: o.cat, sev: o.sev || 'Info', text: text, node: o.node == null ? null : nodeId(o.node) };
  }

  function trialMetrics(o) {
    if (!Array.isArray(o.rows) || o.rows.length > 12) throw 'trial_metrics.rows invalid';
    return {
      type: 'trial_metrics', rows: o.rows.map(function (r) {
        var name = str(r && r.obstruction, 60);
        if (!name) throw 'trial_metrics.rows[].obstruction required';
        return { name: name, acc: optNum(r, 'accuracy', 0, 1, 'accuracy'), fp: optNum(r, 'fp', 0, 1, 'fp'), fn: optNum(r, 'fn', 0, 1, 'fn') };
      })
    };
  }

  // ---- gateway address validation (local network only, no cloud) ----
  function validateGateway(cfg) {
    var errors = {};
    var host = String(cfg && cfg.host != null ? cfg.host : '').trim();
    var port = String(cfg && cfg.port != null ? cfg.port : '').trim();
    var path = String(cfg && cfg.path != null ? cfg.path : '').trim() || '/csi';
    if (!host) errors.host = 'Enter the gateway IP address or name.';
    else if (!/^[A-Za-z0-9.-]+$/.test(host)) errors.host = 'Use only an IP address or host name (no http://, slashes or spaces).';
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      var p = host.split('.').map(Number);
      if (p.some(function (n) { return n > 255; })) errors.host = 'Not a valid IPv4 address.';
      else if (!isPrivateIPv4(p)) errors.host = 'Only local-network addresses are allowed (192.168.x.x, 10.x.x.x, 172.16-31.x.x).';
    } else if (/^[0-9.]+$/.test(host)) errors.host = 'Not a valid IPv4 address.';
    else if (!isLocalName(host)) errors.host = 'Use a local name (name.local) or a private IP address. Internet host names are not allowed.';
    if (!/^\d{1,5}$/.test(port) || +port < 1 || +port > 65535) errors.port = 'Port must be 1-65535.';
    if (!/^\/[A-Za-z0-9._~\/-]{0,64}$/.test(path)) errors.path = 'Path must start with / and use letters, digits . _ ~ - /';
    var ok = Object.keys(errors).length === 0;
    return { ok: ok, errors: errors, config: { host: host, port: port, path: path }, url: ok ? 'ws://' + host + ':' + port + path : null };
  }
  function isPrivateIPv4(p) {
    return p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 169 && p[1] === 254) || p[0] === 127;
  }
  function isLocalName(h) {
    h = h.toLowerCase();
    if (h.charAt(0) === '.' || h.charAt(h.length - 1) === '.' || h.indexOf('..') >= 0) return false;
    if (h.indexOf('.') < 0) return true; // single label, e.g. "csi-gateway" or "localhost"
    return /\.(local|lan|home\.arpa)$/.test(h);
  }

  var api = { VERSION: VERSION, parse: parse, validate: validate, validateGateway: validateGateway };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CSI = root.CSI || {}; root.CSI.Protocol = api; }
})(typeof window !== 'undefined' ? window : globalThis);
