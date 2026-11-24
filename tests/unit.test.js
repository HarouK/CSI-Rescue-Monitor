// Run: node --test tests/
const test = require('node:test'), assert = require('node:assert');
const P = require('../app/src/main/assets/www/assets/csi-protocol.js');
const { Transport } = require('../app/src/main/assets/www/assets/csi-transport.js');
const { Store } = require('../app/src/main/assets/www/assets/csi-store.js');
const { createDemo } = require('../app/src/main/assets/www/assets/csi-demo.js');
const frame = (o) => JSON.stringify(Object.assign({ v: 1, type: 'node_frame', node: 'N2', seq: 1, raw: { rssi: -54, amp_var: 0.18 }, estimate: { present: true, confidence: 0.87 } }, o));

test('protocol: accepts a valid node_frame', () => {
  const r = P.parse(frame({}));
  assert.ok(r.ok); assert.equal(r.msg.node, 'N2'); assert.equal(r.msg.rssi, -54); assert.equal(r.msg.est.conf, 0.87); assert.equal(r.msg.est.validated, false);
});
test('protocol: rejects malformed input without throwing', () => {
  ['', '   ', 'not json', '[]', 'null', '42', '{"v":2,"type":"node_frame"}', '{"v":1}', '{"v":1,"type":"node_frame"}',
    frame({ node: '../x' }), frame({ raw: { rssi: 5 } }), frame({ raw: { rssi: 'loud' } }), frame({ estimate: { present: 'yes' } }),
    frame({ estimate: { present: true, confidence: 1.5 } }), frame({ batt_pct: 101 }), frame({ route: { hops: 0 } }),
    '{"v":1,"type":"event","cat":"Bogus","text":"x"}', 'x'.repeat(70000)].forEach((t) => {
    const r = P.parse(t); assert.equal(r.ok, false, 'should reject: ' + t.slice(0, 40)); assert.ok(r.error);
  });
  assert.equal(P.parse(null).ok, false); assert.equal(P.parse(undefined).ok, false);
});
test('protocol: unknown type is tolerated', () => { const r = P.parse('{"v":1,"type":"future_thing"}'); assert.ok(r.ok); assert.equal(r.msg.type, 'unknown'); });
test('protocol: gateway address validation', () => {
  const ok = (c) => P.validateGateway(c).ok;
  assert.ok(ok({ host: '192.168.4.1', port: '81', path: '/csi' })); assert.ok(ok({ host: '10.0.0.5', port: 8080 })); assert.ok(ok({ host: 'csi-gateway.local', port: 81 }));
  assert.ok(ok({ host: '172.20.1.1', port: 81 })); assert.ok(ok({ host: 'localhost', port: 81 }));
  assert.equal(P.validateGateway({ host: '192.168.4.1', port: 81 }).url, 'ws://192.168.4.1:81/csi');
  [{ host: '', port: 81 }, { host: '8.8.8.8', port: 81 }, { host: '172.32.0.1', port: 81 }, { host: '999.1.1.1', port: 81 }, { host: 'http://192.168.4.1', port: 81 },
    { host: '192.168.4.1/x', port: 81 }, { host: 'example.com', port: 81 }, { host: '192.168.4.1', port: 0 }, { host: '192.168.4.1', port: 65536 }, { host: '192.168.4.1', port: 'abc' },
    { host: '192.168.4.1', port: 81, path: 'csi' }, { host: '192.168.4.1', port: 81, path: '/a b' }, { host: '1.2.3', port: 81 }, { host: '192.168.4.1 ', port: '8 1' }].forEach((c) => assert.equal(ok(c), false, JSON.stringify(c)));
});

class FakeWS { constructor(u) { FakeWS.all.push(this); this.url = u; this.closed = false; } close() { this.closed = true; } }
FakeWS.all = [];
function fakeTimers() { let now = 0, id = 0; const q = new Map(); return { now: () => now, setTimeout: (f, d) => { q.set(++id, [now + d, f]); return id; }, clearTimeout: (i) => q.delete(i), advance(ms) { const end = now + ms; for (;;) { let best = null; q.forEach((v, k) => { if (v[0] <= end && (!best || v[0] < best[1][0])) best = [k, v]; }); if (!best) break; q.delete(best[0]); now = best[1][0]; best[1][1](); } now = end; } }; }

test('transport: connects, reconnects with backoff, stops on disconnect', () => {
  FakeWS.all = []; const T = fakeTimers(), states = [];
  const t = new Transport({ WebSocket: FakeWS, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, now: T.now, random: () => 0.5, onState: (s, i) => states.push(s + ':' + i.attempt), onFrame: () => {} });
  t.connect('ws://x'); assert.equal(FakeWS.all.length, 1); FakeWS.all[0].onopen(); assert.equal(t.state, 'open');
  FakeWS.all[0].onclose({ code: 1006 }); assert.equal(t.state, 'reconnecting'); assert.equal(t.attempt, 1);
  T.advance(1100); assert.equal(FakeWS.all.length, 2, 'retried after ~1 s'); // connecting, no response
  T.advance(6100); assert.equal(t.state, 'reconnecting'); assert.equal(t.attempt, 2); assert.match(t.lastError, /timed out/);
  T.advance(2100); assert.equal(FakeWS.all.length, 3, 'backoff doubled to ~2 s');
  t.disconnect(); assert.equal(t.state, 'idle'); T.advance(60000); assert.equal(FakeWS.all.length, 3, 'no retries after manual disconnect');
});
test('transport: backoff is capped and resets after success', () => {
  FakeWS.all = []; const T = fakeTimers();
  const t = new Transport({ WebSocket: FakeWS, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, now: T.now, random: () => 0.5, onState: () => {}, onFrame: () => {} });
  t.connect('ws://x'); for (let i = 0; i < 12; i++) { const w = FakeWS.all[FakeWS.all.length - 1]; if (w.onclose) w.onclose({}); T.advance(1000); T.advance(20000); }
  assert.ok(t.attempt >= 6, 'attempts ' + t.attempt); assert.ok(t.nextRetryAt === null || t.nextRetryAt - T.now() <= 15000 * 1.15);
  let w2 = null; for (let i = 0; i < 300 && !w2; i++) { T.advance(100); const w = FakeWS.all[FakeWS.all.length - 1]; if (w.onopen) w2 = w; }
  assert.ok(w2, 'a connecting socket exists'); w2.onopen(); assert.equal(t.attempt, 0);
});
test('transport: stale socket events from an old connection are ignored', () => {
  FakeWS.all = []; const T = fakeTimers(), frames = [];
  const t = new Transport({ WebSocket: FakeWS, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, now: T.now, onState: () => {}, onFrame: (d) => frames.push(d) });
  t.connect('ws://a'); const old = FakeWS.all[0]; const oldMsg = old.onmessage; t.connect('ws://b');
  if (oldMsg) oldMsg({ data: 'late' }); assert.equal(frames.length, 0);
});
test('transport: constructor failure (bad URL) becomes reconnecting, not a crash', () => {
  const T = fakeTimers(); class Boom { constructor() { throw new Error('SyntaxError'); } }
  const t = new Transport({ WebSocket: Boom, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, now: T.now, onState: () => {}, onFrame: () => {} });
  t.connect('ws://x'); assert.equal(t.state, 'reconnecting'); assert.match(t.lastError, /Cannot open/);
});

function mkStore() { FakeWS.all = []; const T = fakeTimers(); const s = new Store({ now: T.now, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, setTransportTimeout: T.setTimeout, clearTransportTimeout: T.clearTimeout, storage: null, WebSocket: FakeWS, random: () => 0.5, demoFactory: (o) => createDemo(Object.assign({ now: T.now, setInterval: (f, d) => { let on = true; const loop = () => { if (on) { f(); T.setTimeout(loop, d); } }; T.setTimeout(loop, d); return { stop() { on = false; } }; }, clearInterval: (h) => h.stop() }, o)) }); return { s, T }; }

test('store: hardware dataset only changes from gateway frames; demo data never leaks in', () => {
  const { s, T } = mkStore(); s.setMode('hardware');
  assert.equal(s.cur().order.length, 0); T.advance(10000); assert.equal(s.ds.hardware.order.length, 0, 'demo must not feed hardware');
  assert.ok(s.connect({ host: '192.168.4.1', port: '81' }).ok); FakeWS.all[0].onopen();
  FakeWS.all[0].onmessage({ data: frame({ node: 'N2' }) });
  const v = s.view(); assert.equal(v.mode, 'hardware'); assert.equal(v.nodes.length, 1); assert.equal(v.link.state, 'receiving'); assert.equal(v.nodes[0].status, 'online');
});
test('store: open socket with no data is "waiting", then stale; values are kept, never replaced', () => {
  const { s, T } = mkStore(); s.setMode('hardware'); s.connect({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen();
  assert.equal(s.view().link.state, 'waiting');
  FakeWS.all[0].onmessage({ data: frame({}) }); assert.equal(s.view().link.state, 'receiving');
  T.advance(6000); const v = s.view(); assert.equal(v.link.state, 'stale'); assert.equal(v.nodes[0].rssi, -54, 'last value kept'); 
  s.tick(); assert.ok(s.ds.hardware.alerts.some((a) => a.id === 'gw:stale' && a.active && a.sev === 'Warning' && a.cat === 'Gateway'), 'gateway-stale alert');
  assert.ok(!s.ds.hardware.alerts.some((a) => a.id === 'node:N2'), 'no per-node alert when the whole gateway link is stale');
  T.advance(20000); assert.equal(s.view().nodes[0].status, 'offline');
});
test('store: malformed frames are counted, logged, and do not break state', () => {
  const { s } = mkStore(); s.setMode('hardware'); s.connect({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen();
  ['garbage', '{}', '{"v":1,"type":"node_frame","node":"N1","raw":{"rssi":"x"}}', ''].forEach((t) => FakeWS.all[0].onmessage({ data: t }));
  assert.equal(s.ds.hardware.stats.malformed, 4); assert.equal(s.ds.hardware.stats.rx, 0); assert.ok(s.ds.hardware.stats.lastError);
  FakeWS.all[0].onmessage({ data: frame({}) }); assert.equal(s.ds.hardware.stats.rx, 1);
});
test('store: alerts are derived from received data, with confidence tiers and clearing', () => {
  const { s, T } = mkStore(); s.setMode('hardware'); s.connect({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen();
  const sent = []; s.notifier = (a, b) => sent.push(a);
  FakeWS.all[0].onmessage({ data: frame({ estimate: { present: true, confidence: 0.87 } }) });
  FakeWS.all[0].onmessage({ data: frame({ node: 'N3', raw: { rssi: -73 }, estimate: { present: true, confidence: 0.5 } }) });
  const al = s.ds.hardware.alerts; assert.equal(al.find((a) => a.id === 'sig:N2').sev, 'Critical'); assert.equal(al.find((a) => a.id === 'sig:N3').sev, 'Warning'); assert.equal(al.find((a) => a.id === 'rssi:N3').sev, 'Warning'); assert.equal(al.find((a) => a.id === 'sig:N2').cat, 'Detect');
  assert.equal(s.ds.hardware.det.events, 2); assert.ok(sent.length >= 3, 'notifier called for hardware alerts');
  FakeWS.all[0].onmessage({ data: frame({ estimate: { present: false, confidence: 0.9 } }) });
  assert.equal(al.find((a) => a.id === 'sig:N2').active, false);
  s.ack('sig:N3'); assert.equal(al.find((a) => a.id === 'sig:N3').acked, true);
});
test('store: relay route raises a link alert; PDR computed from sequence gaps', () => {
  const { s } = mkStore(); s.setMode('hardware'); s.connect({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen();
  [1, 2, 3, 6, 7].forEach((q) => FakeWS.all[0].onmessage({ data: frame({ node: 'N4', seq: q, route: { hops: 2, via: 'N3' } }) }));
  assert.ok(s.ds.hardware.alerts.some((a) => a.id === 'link:N4'));
  const p = s.view().pdr; assert.ok(Math.abs(p.value - 5 / 7) < 1e-9, 'got ' + p.value);
});
test('store: connection loss moves to reconnecting and recovers', () => {
  const { s, T } = mkStore(); s.setMode('hardware'); s.connect({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen(); FakeWS.all[0].onmessage({ data: frame({}) });
  FakeWS.all[0].onclose({ code: 1006 }); assert.equal(s.view().link.state, 'reconnecting'); assert.ok(s.ds.hardware.log.some((l) => /Connection lost/.test(l.text)));
  T.advance(1500); assert.equal(FakeWS.all.length, 2); FakeWS.all[1].onopen(); FakeWS.all[1].onmessage({ data: frame({ seq: 2 }) }); assert.equal(s.view().link.state, 'receiving');
});
test('store: invalid address is rejected and nothing connects', () => {
  const { s } = mkStore(); s.setMode('hardware'); const r = s.connect({ host: '8.8.8.8', port: '81' });
  assert.equal(r.ok, false); assert.ok(r.errors.host); assert.equal(FakeWS.all.length, 0);
});
test('store: demo mode produces DEMO-labelled data through the same pipeline; exports are labelled', () => {
  const { s, T } = mkStore(); s.start(); T.advance(5000);
  const v = s.view(); assert.equal(v.mode, 'demo'); assert.equal(v.nodes.length, 4); assert.ok(v.nodes.every((n) => n.status === 'online'));
  assert.match(s.exportLogCsv(), /,DEMO,/); assert.match(s.exportReport(), /DEMO: simulated/);
  s.setMode('hardware'); assert.match(s.exportReport(), /HARDWARE/); assert.equal(s.view().nodes.length, 0);
});

// ======================= new-feature tests =======================
const VM = require('../app/src/main/assets/www/assets/csi-viewmodel.js');
const mem = () => { const m = {}; return { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, _m: m }; };
function mkStore2(storage) { FakeWS.all = []; const T = fakeTimers(); const s = new Store({ now: () => 1700000000000 + T.now(), setTimeout: T.setTimeout, clearTimeout: T.clearTimeout, setTransportTimeout: T.setTimeout, clearTransportTimeout: T.clearTimeout, storage: storage || null, WebSocket: FakeWS, random: () => 0.5 }); return { s, T }; }
function hw(s) { s.setMode('hardware'); s.connect({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen(); return FakeWS.all[0]; }
const UI = { tab: 'ana', sel: 'N2', filter: 'All', sevFilter: 'All', draft: { host: '10.0.0.2', port: '81', path: '/csi' }, errors: {} };
const ACT = { set() {}, ack() {}, cut() {}, mode() {}, draft() {}, connect() {}, disconnect() {}, test() {}, retry() {}, report() {}, exportLog() {} };
const vm = (s, ui) => VM.build(s.view(), Object.assign({}, UI, ui || {}), ACT, '#25e0a1', s);
function parseCsv(t) { const rows = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\r' && t[i + 1] === '\n') { row.push(f); rows.push(row); row = []; f = ''; i++; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else f += c; } if (f !== '' || row.length) { row.push(f); rows.push(row); } return rows; }

test('protocol: event severity is validated (default Info) and Gateway is an allowed category', () => {
  assert.equal(P.parse('{"v":1,"type":"event","cat":"Gateway","text":"x"}').msg.sev, 'Info');
  assert.equal(P.parse('{"v":1,"type":"event","cat":"Mesh","sev":"Critical","text":"x"}').msg.sev, 'Critical');
  assert.equal(P.parse('{"v":1,"type":"event","cat":"Mesh","sev":"Fatal","text":"x"}').ok, false);
});
test('alerts: severity + category model (detection / mesh / gateway), Info only for malformed data', () => {
  const { s } = mkStore2(); const w = hw(s);
  w.onmessage({ data: frame({ node: 'N4', seq: 1, route: { hops: 2, via: 'N3' }, estimate: { present: true, confidence: 0.9 } }) });
  w.onmessage({ data: 'garbage' });
  const al = s.ds.hardware.alerts, by = (id) => al.find((a) => a.id === id);
  assert.deepEqual([by('sig:N4').sev, by('sig:N4').cat], ['Critical', 'Detect']); assert.deepEqual([by('link:N4').sev, by('link:N4').cat], ['Warning', 'Mesh']); assert.deepEqual([by('gw:malformed').sev, by('gw:malformed').cat], ['Info', 'Gateway']);
});
test('alerts: one silent node while the gateway link is healthy -> Mesh "disconnected" (Warning then Critical)', () => {
  const { s, T } = mkStore2(); const w = hw(s);
  w.onmessage({ data: frame({ node: 'N1', seq: 1 }) }); w.onmessage({ data: frame({ node: 'N2', seq: 1 }) });
  for (let i = 2; i < 40; i++) { T.advance(1000); w.onmessage({ data: frame({ node: 'N1', seq: i }) }); s.tick(); if (i === 7) { const a = s.ds.hardware.alerts.find((x) => x.id === 'node:N2'); assert.ok(a && a.sev === 'Warning' && a.cat === 'Mesh', 'stale N2 -> Warning'); } }
  const a = s.ds.hardware.alerts.find((x) => x.id === 'node:N2'); assert.equal(a.sev, 'Critical'); assert.match(a.title, /disconnected/); assert.equal(s.view().link.state, 'receiving');
});
test('alerts: gateway connection loss -> one Critical Gateway alert (not one per node), cleared on recovery', () => {
  const { s, T } = mkStore2(); const w = hw(s); ['N1', 'N2', 'N3'].forEach((n) => w.onmessage({ data: frame({ node: n }) }));
  w.onclose({ code: 1006 }); s.tick(); T.advance(10000); s.tick();
  const al = s.ds.hardware.alerts.filter((a) => a.active); assert.deepEqual(al.map((a) => a.id).sort(), ['gw:link']); assert.equal(al[0].sev, 'Critical'); assert.equal(al[0].cat, 'Gateway');
  T.advance(1000); FakeWS.all[FakeWS.all.length - 1].onopen && FakeWS.all[FakeWS.all.length - 1].onopen(); FakeWS.all[FakeWS.all.length - 1].onmessage({ data: frame({ node: 'N1', seq: 9 }) }); s.tick();
  assert.equal(s.ds.hardware.alerts.find((a) => a.id === 'gw:link').active, false);
});
test('log: entries carry severity + category; link problems are Gateway/Warning; notifier skips Info', () => {
  const { s } = mkStore2(); const sent = []; s.notifier = (t) => sent.push(t); const w = hw(s);
  w.onmessage({ data: 'bad' }); w.onclose({ code: 1006 });
  const lg = s.ds.hardware.log; assert.ok(lg.every((l) => ['Info', 'Warning', 'Critical'].includes(l.sev) && ['Detect', 'Mesh', 'Gateway', 'System'].includes(l.cat)));
  assert.ok(lg.some((l) => l.cat === 'Gateway' && l.sev === 'Warning' && /Connection lost/.test(l.text))); assert.ok(lg.some((l) => l.cat === 'Gateway' && l.sev === 'Info' && /Connected to/.test(l.text)));
  assert.ok(sent.every((t) => !/^INFO/.test(t)), 'no notification for Info alerts');
  w.onmessage; const v = vm(s, { tab: 'log', sevFilter: 'Warning' }); assert.ok(v.logs.length && v.logs.every((l) => l.sev === 'WARNING'));
  assert.ok(vm(s, { tab: 'log', filter: 'Mesh' }).logs.every((l) => l.cat === 'Mesh'));
});
test('CSV export is valid RFC-4180: fixed columns, quoting round-trip, CRLF, data-source column', () => {
  const { s } = mkStore2(); const w = hw(s);
  w.onmessage({ data: JSON.stringify({ v: 1, type: 'event', cat: 'Mesh', sev: 'Warning', text: 'comma, "quote" and\nnewline' }) });
  const csv = s.exportLogCsv(), rows = parseCsv(csv);
  assert.deepEqual(rows[0], ['received_at_iso', 'severity', 'category', 'origin', 'data_source', 'message']); assert.ok(rows.length >= 3);
  assert.ok(rows.every((r) => r.length === 6), 'every row has 6 columns'); assert.ok(rows.slice(1).every((r) => !isNaN(Date.parse(r[0])) && r[4] === 'HARDWARE'));
  assert.ok(rows.some((r) => r[5] === 'comma, "quote" and\nnewline' && r[1] === 'Warning' && r[2] === 'Mesh')); assert.ok(csv.includes('\r\n') && csv.endsWith('\r\n'));
});
test('connection test: success on first valid frame; no effect on live link, datasets or counters', () => {
  const { s } = mkStore2(); s.setMode('hardware'); const before = JSON.stringify([s.ds.hardware.stats, s.ds.hardware.order, s.link]);
  s.testConnection({ host: '10.0.0.2', port: '81', path: '/csi' }); assert.equal(s.test.state, 'testing'); const w = FakeWS.all[0]; w.onopen(); assert.match(s.test.title, /opened in/);
  w.onmessage({ data: frame({}) }); assert.equal(s.test.state, 'ok'); assert.ok(w.closed, 'test socket closed'); assert.equal(JSON.stringify([s.ds.hardware.stats, s.ds.hardware.order, s.link]), before, 'nothing ingested');
  assert.equal(s.transport.wanted, false, 'live connection untouched');
});
test('connection test: warn (no data), warn (invalid data), fail (refused), fail (timeout), invalid address, single flight', () => {
  let { s, T } = mkStore2(); s.testConnection({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen(); T.advance(4100); assert.equal(s.test.state, 'warn'); assert.match(s.test.title, /no data/i);
  ({ s, T } = mkStore2()); s.testConnection({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onopen(); FakeWS.all[0].onmessage({ data: 'junk' }); T.advance(4100); assert.equal(s.test.state, 'warn'); assert.match(s.test.detail, /Invalid JSON/);
  ({ s, T } = mkStore2()); s.testConnection({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onerror(); assert.equal(s.test.state, 'fail'); assert.match(s.test.detail, /could not be reached/);
  ({ s, T } = mkStore2()); s.testConnection({ host: '10.0.0.2', port: '81' }); T.advance(6100); assert.equal(s.test.state, 'fail'); assert.match(s.test.detail, /did not answer/);
  ({ s, T } = mkStore2()); s.testConnection({ host: '8.8.8.8', port: '81' }); assert.equal(s.test.state, 'fail'); assert.equal(FakeWS.all.length, 0, 'no socket for invalid address');
  ({ s, T } = mkStore2()); s.testConnection({ host: '10.0.0.2', port: '81' }); s.testConnection({ host: '10.0.0.2', port: '81' }); assert.equal(FakeWS.all.length, 1, 'second click ignored while testing');
});
test('persistence: gateway settings, mode and last successful connection survive a restart', () => {
  const st = mem(); let { s, T } = mkStore2(st); s.setDraft({ host: '192.168.1.50', port: '8081', path: '/stream' }); assert.equal(s.view().lastConnectedAt, null);
  s.setMode('hardware'); assert.ok(s.connect({ host: '192.168.1.50', port: '8081', path: '/stream' }).ok); FakeWS.all[0].onopen(); const t = s.settings.lastConnectedAt; assert.ok(t > 0);
  const r = mkStore2(st); assert.deepEqual(r.s.settings.config, { host: '192.168.1.50', port: '8081', path: '/stream' }); assert.equal(r.s.settings.mode, 'hardware'); assert.equal(r.s.settings.lastConnectedAt, t); assert.equal(r.s.settings.autoConnect, true);
  r.s.start(); assert.equal(FakeWS.all[FakeWS.all.length - 1].url, 'ws://192.168.1.50:8081/stream', 'auto-reconnects to saved gateway'); r.s.stop();
  const e = mkStore2(mem()); e.s.setDraft({ host: 'abc', port: '1' }); const e2 = mkStore2(e.s.storage); assert.equal(e2.s.settings.config.host, 'abc', 'draft persisted even without Connect');
  const bad = mem(); bad.setItem('csi.settings.v1', '{not json'); assert.equal(mkStore2(bad).s.settings.mode, 'demo', 'corrupt settings fall back to defaults');
});
test('connection counters: all frames vs valid, last frame timestamp', () => {
  const { s, T } = mkStore2(); const w = hw(s); w.onmessage({ data: frame({}) }); T.advance(2000); w.onmessage({ data: 'bad' }); T.advance(1000);
  const v = vm(s, { tab: 'conn' }), row = (k) => v.linkRows.find((r) => r.k === k).v;
  assert.equal(row('Messages received (all frames)'), '2'); assert.match(row('Valid messages'), /^1 · last/); assert.equal(row('Malformed messages'), '1'); assert.match(row('Last message received'), /\(1 s ago\)/); assert.match(row('Last successful connection'), /\d{4}/);
});
test('analytics: each node selector shows that node\'s own values and chart', () => {
  const { s, T } = mkStore2(); const w = hw(s);
  const cfg = { N1: [-61, 0.021], N2: [-54, 0.184], N3: [-73, 0.047], N4: [-67, 0.126] };
  for (let i = 1; i <= 8; i++) { Object.keys(cfg).forEach((n) => w.onmessage({ data: frame({ node: n, seq: i, raw: { rssi: cfg[n][0], amp_var: cfg[n][1] * (1 + i / 100) } }) })); T.advance(1000); }
  const seen = {}; Object.keys(cfg).forEach((n) => { const v = vm(s, { sel: n }); assert.equal(v.selId, n); assert.ok(v.feats.find((f) => f.k.startsWith('RSSI')).v.includes(String(cfg[n][0])), n + ' rssi'); seen[n] = v.chartPoints + '|' + v.chartNote; assert.equal(v.chartEmpty, false); });
  assert.equal(new Set(Object.values(seen)).size, 4, 'four different chart shapes');
});
test('analytics: latest-measurement timestamp, empty state, collecting state, and frozen chart when data stops', () => {
  const { s, T } = mkStore2(); const w = hw(s);
  let v = vm(s, { sel: 'N3' }); assert.equal(v.chartEmpty, true); assert.match(v.chartEmptyText, /Waiting for the first measurement/); assert.match(v.chartStatus, /No measurements received/);
  s.disconnect(); v = vm(s, { sel: 'N3' }); assert.match(v.chartEmptyText, /Not connected.*Connection tab/);
  const w2 = (s.connect({ host: '10.0.0.2', port: '81' }), FakeWS.all[FakeWS.all.length - 1]); w2.onopen(); w2.onmessage({ data: frame({ node: 'N3', seq: 1 }) });
  v = vm(s, { sel: 'N3' }); assert.equal(v.chartEmpty, true); assert.match(v.chartEmptyText, /Collecting samples.*1 so far/);
  for (let i = 2; i <= 10; i++) { T.advance(1000); w2.onmessage({ data: frame({ node: 'N3', seq: i, raw: { rssi: -70, amp_var: 0.05 + i / 100 } }) }); }
  v = vm(s, { sel: 'N3' }); assert.equal(v.chartEmpty, false); assert.match(v.chartStatus, /^Live · latest sample \d\d:\d\d:\d\d \(0 s ago\)/);
  T.advance(2000); const live = vm(s, { sel: 'N3' }); assert.match(live.chartStatus, /^Live/);
  T.advance(10000); const f1 = vm(s, { sel: 'N3' }); T.advance(20000); const f2 = vm(s, { sel: 'N3' });
  assert.match(f1.chartStatus, /^Paused · last sample/); assert.equal(f1.chartPoints, f2.chartPoints, 'frozen: chart does not move without new data'); assert.equal(f2.chartOp, '1');
  assert.ok(f1.feats.find((f) => f.k.startsWith('Last measurement received')).v.match(/\d\d:\d\d:\d\d · \d+ s ago/));
});
test('analytics: hardware mode never plots demo samples; demo chart is labelled simulated; explanations present', () => {
  const { s } = mkStore2(); s.setMode('demo'); s.demo = null; s.ingest({ type: 'node_frame', node: 'N2', seq: 1, rssi: -50, ampVar: 0.2, est: null, route: null }, 'demo');
  s.setMode('hardware'); assert.equal(vm(s, { sel: 'N2' }).chartEmpty, true, 'hardware chart ignores demo samples');
  s.setMode('demo'); const d = vm(s, { sel: 'N2' }); assert.match(d.chartEmptyText, /simulated|Collecting/);
  assert.match(d.explainVar, /Channel State Information/); assert.match(d.explainEst, /never shows a confirmed detection/); assert.equal(d.exChart, false); assert.equal(vm(s, { exChart: true }).exChart, true);
});
test('viewmodel: connection tab shows test result, hints and retry only when relevant', () => {
  const { s } = mkStore2(); s.setMode('hardware'); let v = vm(s, { tab: 'conn' }); assert.equal(v.hasTest, false); assert.equal(v.showHints, false); assert.equal(v.canRetry, false);
  s.testConnection({ host: '10.0.0.2', port: '81' }); FakeWS.all[0].onerror(); v = vm(s, { tab: 'conn' }); assert.equal(v.hasTest, true); assert.equal(v.testColor, '#ff8a8a'); assert.equal(v.showHints, true); assert.ok(v.hints.length >= 4);
  s.connect({ host: '10.0.0.2', port: '81' }); FakeWS.all[FakeWS.all.length - 1].onclose({ code: 1006 }); v = vm(s, { tab: 'conn' }); assert.equal(v.canRetry, true); assert.match(v.linkRows.find((r) => r.k === 'Next retry').v, /^in \d+ s$/);
});

test('alerts: gateway-lost alert is raised immediately on link loss (no wait for the 1 s tick)', () => {
  const { s } = mkStore2(); const w = hw(s); w.onmessage({ data: frame({}) }); w.onclose({ code: 1006 });
  assert.ok(s.ds.hardware.alerts.some((a) => a.id === 'gw:link' && a.active && a.sev === 'Critical'));
});
