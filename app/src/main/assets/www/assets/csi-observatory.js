/* CSI Rescue Monitor - Observatory scene (3D room view).
 * A small self-contained perspective renderer on a 2D canvas: no WebGL, no Three.js, no external files, so it works the
 * same in every Android WebView and costs little GPU. It only READS the store (CSI.app.store.view()); it never writes data.
 *
 * What is drawn, and where it comes from:
 *  - nodes, their status colour, RSSI label ....... store nodes (real in Hardware Mode, simulated in Demo Mode)
 *  - floor glow ................................... per-node CSI amplitude variance spread around each node (NOT a position map)
 *  - blue domes (wave rings) ...................... one set per node that is receiving; strength follows RSSI quality
 *  - pulses along links ........................... one pulse per frame actually received from that node
 *  - presence markers ............................. one per node whose estimate says "present" (zone level)
 *      Hardware: a glowing column at the node's zone centre. It is NOT a person's position and no silhouette is drawn.
 *      Demo:     an illustrative silhouette, labelled DEMO.
 *  - vital overlay ................................ breathing-band power (raw, processed) and validated vitals if the gateway sends them
 * Node positions are layout placeholders (DEFAULT_LAYOUT) unless the gateway's hello message supplies `pos` in metres. */
(function (root) {
  'use strict';
  var CSI = root.CSI = root.CSI || {};
  var W = 8, D = 6, H = 2.8;                         // room size in metres (illustrative)
  var BS = { x: 4, y: 0.35, z: 5.7 };                // base station
  var DEFAULT_LAYOUT = { N1: [0.6, 3.6], N2: [2.0, 0.7], N3: [6.0, 0.7], N4: [7.4, 3.6] };
  var EXTRA_LAYOUT = [[1.2, 5.2], [6.8, 5.2], [4, 0.5], [4, 3]];
  var GREEN = '37,224,161', CYAN = '61,232,255', BLUE = '77,141,255', AMBER = '255,180,84', GREY = '107,129,149', RED = '255,138,138';
  var TWO_PI = Math.PI * 2;

  var opts = { mode: 'presence', cam: 'orbit', sel: 'N2' };
  var cam = { yaw: 0.34, pitch: 0.50, dist: 14.2 }, camGoal = null;
  var canvas = null, ctx = null, rafId = 0, lastTs = 0, snap = null, snapAt = 0, quality = 1, frames = 0, ftAvg = 16, ftN = 0;
  var pulses = [], seenAt = {}, lastPulseAt = {}, debug = { frames: 0 };
  var reduce = false; try { reduce = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* ignore */ }
  var drag = null;
  var PRESETS = { orbit: { yaw: 0.34, pitch: 0.50, dist: 14.2 }, top: { yaw: 0, pitch: 1.42, dist: 12.6 }, front: { yaw: 0, pitch: 0.16, dist: 14.2 } };

  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function isNum(x) { return typeof x === 'number' && isFinite(x); }

  // ---- layout ----
  function nodePos(n, idx) {
    var p = n.pos && isNum(n.pos.x) && isNum(n.pos.y) ? [clamp(n.pos.x, 0, W), clamp(n.pos.y, 0, D)] : (DEFAULT_LAYOUT[n.id] || EXTRA_LAYOUT[idx % EXTRA_LAYOUT.length]);
    return { x: p[0], z: p[1] };
  }
  function zoneCentre(p) { var dx = W / 2 - p.x, dz = D / 2 - p.z, d = Math.sqrt(dx * dx + dz * dz) || 1, k = Math.min(1.7, d) / d; return { x: p.x + dx * k, z: p.z + dz * k }; }

  // ---- camera ----
  var vp = { w: 0, h: 0, cx: 0, cy: 0, f: 0 };
  function proj(x, y, z) {
    var dx = x - W / 2, dy = y - 0.7, dz = z - D / 2, cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    var x1 = cy * dx + sy * dz, z1 = -sy * dx + cy * dz, y2 = cp * dy - sp * z1, z2 = sp * dy + cp * z1, depth = cam.dist - z2;
    if (depth < 0.4) return null;
    var s = vp.f / depth;
    return { x: vp.cx + x1 * s, y: vp.cy - y2 * s, s: s, d: depth };
  }
  function line(a, b, rgb, alpha, w, dash) {
    var p = proj(a[0], a[1], a[2]), q = proj(b[0], b[1], b[2]);
    if (!p || !q) return;
    ctx.strokeStyle = 'rgba(' + rgb + ',' + alpha + ')'; ctx.lineWidth = w || 1;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y); ctx.stroke();
    if (dash) ctx.setLineDash([]);
  }
  function glow(x, y, r, rgb, a) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(' + rgb + ',' + a + ')'); g.addColorStop(0.45, 'rgba(' + rgb + ',' + a * 0.35 + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TWO_PI); ctx.fill();
  }
  function ring(cx, y, cz, r, rgb, alpha, w, steps, a0, a1) {
    var first = true; steps = steps || 28; a0 = a0 || 0; a1 = a1 === undefined ? TWO_PI : a1;
    ctx.strokeStyle = 'rgba(' + rgb + ',' + alpha + ')'; ctx.lineWidth = w || 1; ctx.beginPath();
    for (var i = 0; i <= steps; i++) {
      var a = a0 + (a1 - a0) * i / steps, p = proj(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
      if (!p) { first = true; continue; }
      if (first) { ctx.moveTo(p.x, p.y); first = false; } else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }
  function label(text, x, y, rgb, alpha, size, align) {
    ctx.font = '600 ' + Math.round((size || 11) * (vp.small ? 0.85 : 1)) + 'px "JetBrains Mono", monospace'; ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(' + rgb + ',' + (alpha === undefined ? 1 : alpha) + ')'; ctx.fillText(text, x, y);
  }

  // ---- data snapshot ----
  function takeSnapshot(nowMs) {
    if (snap && nowMs - snapAt < 200) return snap;
    var st = CSI.app && CSI.app.store; if (!st) return snap;
    var v = st.view(), demo = v.mode === 'demo', thr = v.ds && isNum(v.ds.threshold) && v.ds.threshold > 0 ? v.ds.threshold : 0.1;
    var order = ['N1', 'N2', 'N3', 'N4'], byId = {};
    v.nodes.forEach(function (n) { byId[n.id] = n; });
    var ids = order.concat(v.nodes.map(function (n) { return n.id; }).filter(function (id) { return order.indexOf(id) < 0; })).slice(0, 8);
    var nodes = ids.map(function (id, i) {
      var n = byId[id] || { id: id, status: 'nodata', est: null, rssi: null, ampVar: null, breathDb: null, route: null, vitals: null, lastSeen: null };
      var p = nodePos(n, i - 4), s = n.ampVar !== null && n.ampVar !== undefined ? clamp(n.ampVar / (3 * thr), 0, 1) : 0;
      var q = isNum(n.rssi) ? clamp((n.rssi + 90) / 50, 0, 1) : 0.25;
      return { id: id, n: n, p: p, z: zoneCentre(p), status: n.status, s: s, q: q, demoPhase: i };
    });
    snap = { mode: v.mode, demo: demo, nodes: nodes, link: v.link.state, thr: thr };
    snapAt = nowMs; return snap;
  }
  function spawnPulses(s, nowMs) {
    s.nodes.forEach(function (nd) {
      var ls = nd.n.lastSeen;
      if (ls === null || ls === undefined) return;
      if (seenAt[nd.id] !== ls) {
        var first = seenAt[nd.id] === undefined; seenAt[nd.id] = ls;
        if (!first && nowMs - (lastPulseAt[nd.id] || 0) > 250 && pulses.length < 24 && nd.status === 'online') { lastPulseAt[nd.id] = nowMs; pulses.push({ id: nd.id, t0: nowMs, via: nd.n.route && nd.n.route.via ? nd.n.route.via : null }); }
      }
    });
  }

  // ---- drawing ----
  function drawFloor(s, t) {
    var NX = quality ? 16 : 10, NZ = quality ? 12 : 8, cw = W / NX, cd = D / NZ, i, j, act = s.nodes.filter(function (n) { return n.status === 'online' || n.status === 'stale'; });
    for (j = 0; j < NZ; j++) for (i = 0; i < NX; i++) {
      var x0 = i * cw, z0 = j * cd, mx = x0 + cw / 2, mz = z0 + cd / 2, I = 0;
      act.forEach(function (nd) { var dx = mx - nd.p.x, dz = mz - nd.p.z, v = nd.s * (nd.status === 'stale' ? 0.35 : 1) * Math.exp(-(dx * dx + dz * dz) / 4.8); if (v > I) I = v; });
      var a = proj(x0 + 0.04, 0, z0 + 0.04), b = proj(x0 + cw - 0.04, 0, z0 + 0.04), c = proj(x0 + cw - 0.04, 0, z0 + cd - 0.04), d = proj(x0 + 0.04, 0, z0 + cd - 0.04);
      if (!a || !b || !c || !d) continue;
      var boost = opts.mode === 'signal' ? 1.25 : 1;
      ctx.fillStyle = 'rgba(' + (I > 0.55 ? CYAN : GREEN) + ',' + (0.035 + Math.min(0.75, I * 0.8 * boost)) + ')';
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y); ctx.closePath(); ctx.fill();
    }
    // floor outline + coarse grid
    var k;
    for (k = 0; k <= 8; k++) line([k, 0, 0], [k, 0, D], CYAN, 0.10, 1);
    for (k = 0; k <= 6; k++) line([0, 0, k], [W, 0, k], CYAN, 0.10, 1);
    line([0, 0, 0], [W, 0, 0], CYAN, 0.45, 1.4); line([W, 0, 0], [W, 0, D], CYAN, 0.45, 1.4); line([W, 0, D], [0, 0, D], CYAN, 0.45, 1.4); line([0, 0, D], [0, 0, 0], CYAN, 0.45, 1.4);
  }
  function drawWalls() {
    var tl = proj(0, H, 0), tr = proj(W, H, 0), br = proj(W, 0, 0), bl = proj(0, 0, 0);
    if (tl && tr && br && bl) {
      var g = ctx.createLinearGradient(0, tl.y, 0, bl.y); g.addColorStop(0, 'rgba(' + BLUE + ',0.00)'); g.addColorStop(1, 'rgba(' + BLUE + ',0.12)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(tl.x, tl.y); ctx.lineTo(tr.x, tr.y); ctx.lineTo(br.x, br.y); ctx.lineTo(bl.x, bl.y); ctx.closePath(); ctx.fill();
      label('WALL / DEBRIS (illustrative)', tl.x + 10, tl.y + 12, BLUE, 0.6, 10, 'left');
    }
    line([0, 0, 0], [0, H, 0], BLUE, 0.4, 1.2); line([W, 0, 0], [W, H, 0], BLUE, 0.4, 1.2); line([0, H, 0], [W, H, 0], BLUE, 0.4, 1.2);
    line([0, 0, D], [0, H, D], BLUE, 0.18, 1); line([W, 0, D], [W, H, D], BLUE, 0.18, 1);
    line([0, H, 0], [0, H, D], BLUE, 0.18, 1); line([W, H, 0], [W, H, D], BLUE, 0.18, 1);
  }
  function drawDome(nd, t) {
    var phases = quality ? 3 : 1, vitalDim = opts.mode === 'vital' ? 0.35 : opts.mode === 'presence' ? 0.7 : 1.15;
    for (var k = 0; k < phases; k++) {
      var ph = reduce ? (0.3 + k / phases) % 1 : ((t * 0.00022 + k / phases + nd.demoPhase * 0.17) % 1), r = 0.4 + ph * 3.4, a = (1 - ph) * (0.16 + 0.7 * nd.q) * vitalDim, j;
      for (j = 0; j <= 3; j++) ring(nd.p.x, 1.0 + Math.sin(j * 0.4) * 0 + j * 0.0, nd.p.z, r * Math.cos(j * 0.3), BLUE, a * 0.9, 1, 22);   // base rings
      for (j = 1; j <= 3; j++) { var el = j * 0.38; ring(nd.p.x, 1.0 + r * Math.sin(el), nd.p.z, r * Math.cos(el), BLUE, a * 0.8, 1, 24); }
      for (j = 0; j < 4; j++) {                                                                                                                  // meridians (half circles)
        var az = j * Math.PI / 4, first = true; ctx.strokeStyle = 'rgba(' + BLUE + ',' + a * 0.7 + ')'; ctx.lineWidth = 1; ctx.beginPath();
        for (var m = 0; m <= 14; m++) { var e = Math.PI * m / 14, pp = proj(nd.p.x + Math.cos(az) * Math.cos(e) * r, 1.0 + Math.sin(e) * r, nd.p.z + Math.sin(az) * Math.cos(e) * r); if (!pp) { first = true; continue; } if (first) { ctx.moveTo(pp.x, pp.y); first = false; } else ctx.lineTo(pp.x, pp.y); }
        ctx.stroke();
      }
    }
  }
  function nodeColor(nd) { return nd.status === 'online' ? GREEN : nd.status === 'stale' ? AMBER : nd.status === 'offline' ? RED : GREY; }
  function drawLinks(s, t) {
    var bs = [BS.x, BS.y, BS.z], byId = {};
    s.nodes.forEach(function (nd) { byId[nd.id] = nd; });
    s.nodes.forEach(function (nd) {
      var active = nd.status === 'online', rgb = active ? CYAN : GREY, via = nd.n.route && nd.n.route.via && byId[nd.n.route.via] ? byId[nd.n.route.via] : null;
      var a = [nd.p.x, 1.0, nd.p.z];
      if (via && active) { var m = [via.p.x, 1.0, via.p.z]; line(a, m, AMBER, 0.6, 1.4, [5, 4]); line(m, bs, CYAN, 0.35, 1.2); }
      else line(a, bs, rgb, active ? 0.30 + 0.3 * nd.q : 0.12, active ? 1.2 : 1, active ? null : [3, 5]);
    });
    pulses = pulses.filter(function (p) { return t - p.t0 < 1100; });
    pulses.forEach(function (p) {
      var nd = byId[p.id]; if (!nd) return; var u = (t - p.t0) / 1100, via = p.via && byId[p.via] ? byId[p.via] : null, A, B, uu;
      if (via) { if (u < 0.5) { A = [nd.p.x, 1, nd.p.z]; B = [via.p.x, 1, via.p.z]; uu = u * 2; } else { A = [via.p.x, 1, via.p.z]; B = bs; uu = (u - 0.5) * 2; } } else { A = [nd.p.x, 1, nd.p.z]; B = bs; uu = u; }
      var pt = proj(A[0] + (B[0] - A[0]) * uu, A[1] + (B[1] - A[1]) * uu, A[2] + (B[2] - A[2]) * uu);
      if (pt) { glow(pt.x, pt.y, 9 + 3 * Math.sin(u * 6), CYAN, 0.8 * (1 - u * 0.4)); }
    });
  }
  function drawBase() {
    var p = proj(BS.x, 0.05, BS.z), q = proj(BS.x, 0.5, BS.z);
    if (!p || !q) return;
    ctx.strokeStyle = 'rgba(' + GREEN + ',0.9)'; ctx.lineWidth = 1.6; ctx.fillStyle = 'rgba(10,16,23,0.9)';
    var w = Math.max(14, 0.55 * p.s); ctx.beginPath(); ctx.rect(q.x - w / 2, q.y - w / 2, w, w); ctx.fill(); ctx.stroke();
    label('BS', q.x, q.y, GREEN, 1, 10); label('base station', p.x, p.y + 14, GREEN, 0.6, 9);
  }
  function drawNode(nd, t) {
    var foot = proj(nd.p.x, 0, nd.p.z), top = proj(nd.p.x, 1.0, nd.p.z); if (!foot || !top) return;
    var rgb = nodeColor(nd), dim = nd.status === 'nodata' || nd.status === 'offline';
    line([nd.p.x, 0, nd.p.z], [nd.p.x, 1.0, nd.p.z], rgb, dim ? 0.3 : 0.7, 1.2);
    glow(top.x, top.y, 16, rgb, dim ? 0.18 : 0.55);
    ctx.strokeStyle = 'rgba(' + rgb + ',' + (dim ? 0.5 : 1) + ')'; ctx.lineWidth = 2; ctx.fillStyle = 'rgba(8,13,19,0.95)';
    ctx.beginPath(); ctx.arc(top.x, top.y, 6, 0, TWO_PI); ctx.fill(); ctx.stroke();
    var tag = nd.id + (nd.status === 'stale' ? ' · STALE' : nd.status === 'offline' ? ' · OFFLINE' : nd.status === 'nodata' ? ' · NO DATA' : '');
    label(tag, top.x, top.y - 17, rgb, dim ? 0.7 : 1, 11);
    if (opts.mode === 'signal') {
      var txt = isNum(nd.n.rssi) ? nd.n.rssi + ' dBm' : 'RSSI —';
      label(txt, top.x, top.y + 17, CYAN, nd.status === 'online' ? 1 : 0.5, 10);
      if (isNum(nd.n.ampVar)) label('var ' + nd.n.ampVar.toFixed(3), top.x, top.y + 30, CYAN, nd.status === 'online' ? 0.8 : 0.4, 9);
    }
    if (nd.id === opts.sel) { ctx.strokeStyle = 'rgba(' + CYAN + ',0.9)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(top.x, top.y, 11, 0, TWO_PI); ctx.stroke(); ctx.setLineDash([]); }
    nd.screen = { x: top.x, y: top.y };
  }
  function silhouette(cx, cz, rgb, alpha, t, sway) {
    var sx = Math.sin(t * 0.0013 + cx) * 0.04 * sway, pts = {
      head: [cx + sx, 1.68, cz], neck: [cx + sx, 1.5, cz], sh: [cx + sx, 1.42, cz], hip: [cx, 0.95, cz],
      lh: [cx - 0.30 + sx, 1.0, cz], rh: [cx + 0.30 + sx, 1.0, cz], lf: [cx - 0.13, 0, cz], rf: [cx + 0.13, 0, cz], lk: [cx - 0.12, 0.5, cz], rk: [cx + 0.12, 0.5, cz]
    };
    function seg(a, b, w) { line(pts[a], pts[b], rgb, alpha, w || 2.2); }
    seg('neck', 'sh'); seg('sh', 'hip', 3); seg('sh', 'lh'); seg('sh', 'rh'); seg('hip', 'lk'); seg('hip', 'rk'); seg('lk', 'lf'); seg('rk', 'rf');
    var h = proj(pts.head[0], pts.head[1], pts.head[2]), n = proj(pts.neck[0], pts.neck[1], pts.neck[2]);
    if (h) { glow(h.x, h.y, 26 * h.s / 60 + 10, rgb, alpha * 0.55); ctx.strokeStyle = 'rgba(' + rgb + ',' + alpha + ')'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(h.x, h.y, Math.max(4, 0.11 * h.s), 0, TWO_PI); ctx.stroke(); }
    var b = proj(cx, 0.95, cz); if (b) glow(b.x, b.y, 42 * b.s / 60 + 14, rgb, alpha * 0.35);
  }
  function drawMarkers(s, t) {
    var list = [], dimAll = opts.mode === 'signal' ? 0.4 : 1;
    s.nodes.forEach(function (nd) {
      var e = nd.n.est; if (!e || !e.present || (nd.status !== 'online' && nd.status !== 'stale')) return;
      var stale = nd.status === 'stale', conf = e.conf, hi = conf !== null && conf >= 0.8, rgb = stale ? GREY : hi ? GREEN : CYAN, pulse = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.004 + nd.demoPhase);
      var cx = nd.z.x, cz = nd.z.z;
      if (s.demo && !reduce) { cx += Math.cos(t * 0.00045 + nd.demoPhase) * 0.22; cz += Math.sin(t * 0.00038 + nd.demoPhase) * 0.18; }   // illustrative drift, demo only
      var a = (stale ? 0.55 : 0.95) * dimAll;
      ring(cx, 0.02, cz, 0.55 + pulse * 0.25, rgb, a * 0.8, 1.6, 26); ring(cx, 0.02, cz, 0.95 + pulse * 0.3, rgb, a * 0.35, 1, 26);
      var kind;
      if (s.demo) { kind = 'silhouette'; silhouette(cx, cz, rgb, a, t, reduce ? 0 : 1); }
      else {
        kind = 'column';                      // zone-level estimate: a glowing column, deliberately not a body shape
        var base = proj(cx, 0, cz), top = proj(cx, 1.9, cz);
        if (base && top) { var g = ctx.createLinearGradient(0, base.y, 0, top.y); g.addColorStop(0, 'rgba(' + rgb + ',' + a * 0.55 + ')'); g.addColorStop(1, 'rgba(' + rgb + ',0)'); ctx.strokeStyle = g; ctx.lineWidth = Math.max(10, 0.55 * base.s); ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke(); ctx.lineCap = 'butt'; glow(base.x, base.y, 34 * base.s / 60 + 12, rgb, a * 0.5); }
      }
      var lp = proj(cx, 2.45, cz);
      var pct = conf === null ? '—' : Math.round(conf * 100) + '%';
      if (lp) {
        label((nd.n.zoneShort || nd.id) + ' · estimate ' + pct + (stale ? ' · stale' : ''), lp.x, lp.y, rgb, a, 11);
        label(s.demo ? 'DEMO · illustrative position' : 'zone-level estimate, not a position', lp.x, lp.y + 13, rgb, a * 0.7, 9);
      }
      list.push({ node: nd.id, kind: kind, stale: stale, conf: conf, zone: nd.n.zoneShort || nd.id });
    });
    return list;
  }
  function drawVital(s, t) {
    var out = [], any = false;
    s.nodes.forEach(function (nd) {
      if (nd.status !== 'online' && nd.status !== 'stale') return;
      var b = nd.n.breathDb, vt = nd.n.vitals, ok = vt && vt.validated === true;
      if (!isNum(b) && !ok) return;
      any = true; var cx = nd.z.x, cz = nd.z.z, k = isNum(b) ? clamp(b / 20, 0.05, 1) : 0.3, pulse = reduce ? 0.5 : 0.5 + 0.5 * Math.sin(t * 0.0025 + nd.demoPhase);
      var rgb = nd.status === 'stale' ? GREY : CYAN;
      for (var i = 0; i < 3; i++) ring(cx, 0.05 + i * 0.22, cz, 0.4 + i * 0.12 + pulse * 0.05, rgb, 0.25 + 0.55 * k, 1.4, 24);
      var lp = proj(cx, 1.5, cz);
      if (lp) {
        var l1 = isNum(b) ? 'breathing-band power ' + b.toFixed(1) + ' dB (raw)' : '';
        if (l1) label(l1, lp.x, lp.y, rgb, 0.95, 10);
        if (ok) label((isNum(vt.respRpm) ? vt.respRpm + ' rpm' : '') + (isNum(vt.respRpm) && isNum(vt.heartBpm) ? ' · ' : '') + (isNum(vt.heartBpm) ? vt.heartBpm + ' bpm' : '') + ' (validated)', lp.x, lp.y + 13, GREEN, 0.95, 10);
        else label('not a respiration rate', lp.x, lp.y + 13, rgb, 0.55, 9);
      }
      out.push({ node: nd.id, breathDb: isNum(b) ? b : null, validated: !!ok });
    });
    return { any: any, rings: out };
  }

  function draw(t) {
    var s = snap, w = vp.w, h = vp.h;
    ctx.setTransform(vp.dpr, 0, 0, vp.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    // faint depth haze
    var bg = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.7); bg.addColorStop(0, 'rgba(14,34,48,0.55)'); bg.addColorStop(1, 'rgba(4,7,10,0)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    if (!s) return;
    drawFloor(s, t); drawWalls();
    ctx.globalCompositeOperation = 'lighter';
    var domes = 0;
    s.nodes.forEach(function (nd) { if (nd.status === 'online') { drawDome(nd, t); domes++; } });
    drawLinks(s, t);
    ctx.globalCompositeOperation = 'source-over';
    drawBase();
    var sorted = s.nodes.slice().sort(function (a, b) { var pa = proj(a.p.x, 0, a.p.z), pb = proj(b.p.x, 0, b.p.z); return (pb ? pb.d : 0) - (pa ? pa.d : 0); });
    sorted.forEach(function (nd) { drawNode(nd, t); });
    ctx.globalCompositeOperation = 'lighter';
    var markers = opts.mode === 'vital' ? [] : drawMarkers(s, t);
    var vital = opts.mode === 'vital' ? drawVital(s, t) : { any: false, rings: [] };
    ctx.globalCompositeOperation = 'source-over';
    if (opts.mode === 'vital' && !vital.any) label('No breathing-band or validated vital-sign data to show', w / 2, h * 0.52, AMBER, 0.9, 12);
    debug = { frames: frames, mode: opts.mode, cam: opts.cam, demo: s.demo, link: s.link, quality: quality, w: w, h: h, domes: domes, pulses: pulses.length,
      nodes: s.nodes.map(function (n) { return { id: n.id, status: n.status, s: +n.s.toFixed(3), screen: n.screen || null }; }), markers: markers, vital: vital, drew: true };
  }

  // ---- loop / canvas lifecycle ----
  function bind(c) {
    canvas = c; ctx = null; if (!c) return;
    try { ctx = c.getContext('2d'); } catch (e) { ctx = null; }
    var fb = document.getElementById('obs-fallback'); if (fb) fb.style.display = ctx ? 'none' : 'block';
    if (!ctx) return;
    c.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, id: e.pointerId }; try { c.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } });
    c.addEventListener('pointermove', function (e) { if (!drag || e.pointerId !== drag.id) return; cam.yaw = clamp(drag.yaw + (e.clientX - drag.x) * 0.006, -1.1, 1.1); if (e.pointerType === 'mouse') cam.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.004, 0.1, 1.45); camGoal = null; });
    function end() { drag = null; }
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', function () { setCam(opts.cam); });
  }
  function size() {
    var r = canvas.getBoundingClientRect(), dpr = Math.min(root.devicePixelRatio || 1, quality ? 2 : 1.25), w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    vp.w = w; vp.h = h; vp.dpr = dpr; vp.cx = w / 2; vp.cy = h * 0.57; vp.small = w < 620; vp.f = Math.min(w * (vp.small ? 1.75 : 1.0), h * 1.5);
  }
  function setCam(name) { var p = PRESETS[name] || PRESETS.orbit; camGoal = { yaw: p.yaw, pitch: p.pitch, dist: p.dist }; }
  function loop(ts) {
    rafId = 0;
    var c = document.getElementById('obs-canvas');
    if (c !== canvas) bind(c);
    if (!canvas || !ctx || document.hidden || !canvas.offsetParent) { schedule(300); return; }
    var minGap = reduce ? 500 : 33;
    if (ts - lastTs < minGap) { schedule(0); return; }
    var dt = ts - lastTs; lastTs = ts;
    var t0 = (root.performance || Date).now();
    if (camGoal) { var k = 0.14; cam.yaw += (camGoal.yaw - cam.yaw) * k; cam.pitch += (camGoal.pitch - cam.pitch) * k; cam.dist += (camGoal.dist - cam.dist) * k; if (Math.abs(camGoal.yaw - cam.yaw) + Math.abs(camGoal.pitch - cam.pitch) < 0.003) { cam.yaw = camGoal.yaw; cam.pitch = camGoal.pitch; cam.dist = camGoal.dist; camGoal = null; } }
    size(); takeSnapshot(Date.now()); if (snap) spawnPulses(snap, ts);
    try { draw(ts); } catch (e) { debug = { error: String(e && e.message || e), frames: frames }; }
    frames++;
    var ft = (root.performance || Date).now() - t0; ftAvg = ftAvg * 0.9 + ft * 0.1; ftN++;
    if (ftN > 40 && ftAvg > 18 && quality) { quality = 0; } else if (ftN > 200 && ftAvg < 6 && !quality) { quality = 1; ftN = 0; }
    schedule(0);
  }
  function schedule(ms) { if (rafId) return; if (ms) { rafId = setTimeout(function () { rafId = 0; kick(); }, ms); } else rafId = root.requestAnimationFrame(loop); }
  function kick() { if (!rafId) rafId = root.requestAnimationFrame(loop); }

  var api = {
    setOptions: function (o) {
      if (!o) return;
      if (o.mode && o.mode !== opts.mode) opts.mode = o.mode;
      if (o.sel) opts.sel = o.sel;
      if (o.cam && o.cam !== opts.cam) { opts.cam = o.cam; setCam(o.cam); }
    },
    debug: function () { return JSON.parse(JSON.stringify(debug)); },
    forceRedraw: function () { snapAt = 0; },
    layout: DEFAULT_LAYOUT, room: { w: W, d: D, h: H }
  };
  CSI.Observatory = api;
  if (typeof root.requestAnimationFrame === 'function') { root.addEventListener('load', function () { kick(); }); document.addEventListener('visibilitychange', function () { if (!document.hidden) { snapAt = 0; kick(); } }); }
})(typeof window !== 'undefined' ? window : globalThis);
