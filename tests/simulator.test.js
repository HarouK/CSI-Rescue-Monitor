/* Tests for tools/gateway-simulator.js (software gateway simulator) against the app's real protocol parser.
 * Uses Node's built-in WebSocket client (Node 22+). Run: node --test tests/simulator.test.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const P = require('../app/src/main/assets/www/assets/csi-protocol.js');
const { startSimulator, MALFORMED } = require('../tools/gateway-simulator.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(sim) {
  const ws = new WebSocket('ws://127.0.0.1:' + sim.wsPort + '/csi'); const got = [];
  ws.onmessage = (e) => got.push(String(e.data));
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  return { ws, got, parsed: () => got.map((t) => ({ t, r: P.parse(t) })) };
}
const mk = () => startSimulator({ wsPort: 0, uiPort: 0, intervalMs: 40, heartbeatMs: 120, quiet: true, host: '127.0.0.1' });
const post = (sim, body) => new Promise((res, rej) => { const q = http.request({ port: sim.uiPort, method: 'POST', path: '/api/cmd' }, (r) => { let d = ''; r.on('data', (x) => d += x); r.on('end', () => res(JSON.parse(d))); }); q.on('error', rej); q.end(JSON.stringify(body)); });

test('handshake: hello is valid protocol v1 and identifies a SOFTWARE SIMULATOR', async () => {
  const sim = await mk(); const c = await connect(sim); await sleep(200);
  const hello = c.parsed().find((x) => x.r.ok && x.r.msg.type === 'hello');
  assert.ok(hello, 'hello received'); assert.strictEqual(hello.r.msg.simulated, true); assert.strictEqual(hello.r.msg.gatewayId, 'SIMULATOR'); assert.strictEqual(hello.r.msg.kind, 'software-simulator'); assert.strictEqual(hello.r.msg.nodes.length, 4);
  c.ws.close(); await sim.stop();
});

test('four nodes N1-N4 send valid frames with increasing seq; estimates are unvalidated; no vitals/positions invented', async () => {
  const sim = await mk(); const c = await connect(sim); await sleep(400);
  const frames = c.parsed().filter((x) => x.r.ok && x.r.msg.type === 'node_frame').map((x) => x.r.msg);
  for (const id of ['N1', 'N2', 'N3', 'N4']) { const f = frames.filter((m) => m.node === id); assert.ok(f.length >= 3, id + ' frames ' + f.length); assert.ok(f[1].seq > f[0].seq); }
  assert.ok(frames.every((m) => m.est && m.est.validated === false && /simulator/.test(m.est.algo) && m.vitals === null && m.est.pos === null && m.est.count === null), 'estimate labelled, no vitals/position/count');
  assert.ok(c.parsed().every((x) => x.r.ok), 'every message from the simulator passes the app parser');
  c.ws.close(); await sim.stop();
});

test('controls: rssi, variance, motion, presence change what is sent', async () => {
  const sim = await mk(); const c = await connect(sim);
  sim.cmd('rssi', 'N1', -80); sim.cmd('variance', 'N1', 0.5); sim.cmd('motion', 'N1', 0.9); sim.cmd('present', 'N1', '1', 0.95); await sleep(300);
  const last = c.parsed().filter((x) => x.r.ok && x.r.msg.type === 'node_frame' && x.r.msg.node === 'N1').pop().r.msg;
  assert.ok(last.rssi <= -77 && last.rssi >= -83, 'rssi ' + last.rssi); assert.ok(last.ampVar > 0.35, 'variance ' + last.ampVar); assert.ok(last.motion > 0.8); assert.strictEqual(last.est.present, true); assert.ok(last.est.conf > 0.85);
  assert.match(sim.cmd('rssi', 'N1', 50), /must be/); assert.match(sim.cmd('rssi', 'N9', -60), /unknown node/);
  c.ws.close(); await sim.stop();
});

test('node scenarios: silent stop, announced disconnect, restore', async () => {
  const sim = await mk(); const c = await connect(sim); await sleep(200);
  sim.cmd('stopnode', 'N3'); const n0 = c.parsed().filter((x) => x.r.ok && x.r.msg.node === 'N3' && x.r.msg.type === 'node_frame').length; await sleep(300);
  assert.strictEqual(c.parsed().filter((x) => x.r.ok && x.r.msg.node === 'N3' && x.r.msg.type === 'node_frame').length, n0, 'N3 silent');
  assert.ok(c.parsed().filter((x) => x.r.ok && x.r.msg.node === 'N2').length > 0, 'others continue');
  sim.cmd('disconnect', 'N4'); await sleep(300);
  const st = c.parsed().filter((x) => x.r.ok && x.r.msg.type === 'status').pop().r.msg; assert.strictEqual(st.nodes.find((n) => n.id === 'N4').online, false); assert.strictEqual(st.nodes.find((n) => n.id === 'N2').online, true);
  sim.cmd('restore', 'all'); await sleep(300);
  assert.strictEqual(c.parsed().filter((x) => x.r.ok && x.r.msg.type === 'status').pop().r.msg.nodes.every((n) => n.online), true);
  c.ws.close(); await sim.stop();
});

test('stop = gateway silent (socket open, no data); start resumes', async () => {
  const sim = await mk(); const c = await connect(sim); await sleep(200); sim.cmd('stop'); await sleep(100); const n = c.got.length; await sleep(300);
  assert.strictEqual(c.got.length, n, 'nothing sent while stopped'); assert.strictEqual(sim.clientCount(), 1, 'socket still open'); sim.cmd('start'); await sleep(300); assert.ok(c.got.length > n);
  c.ws.close(); await sim.stop();
});

test('interrupt closes sockets and refuses new connections; restore accepts again', async () => {
  const sim = await mk(); const c = await connect(sim); const closed = new Promise((r) => { c.ws.onclose = r; });
  sim.cmd('interrupt'); await closed; assert.strictEqual(sim.clientCount(), 0);
  await assert.rejects(connect(sim), /ws error/, 'refused while interrupted');
  sim.cmd('restoregateway'); const c2 = await connect(sim); await sleep(150); assert.ok(c2.parsed().some((x) => x.r.ok && x.r.msg.type === 'hello')); c2.ws.close(); await sim.stop();
});

test('malformed test messages: every kind is rejected by the app parser (none crash it); unknown type is accepted as unknown', async () => {
  for (const [k, text] of Object.entries(MALFORMED)) { const r = P.parse(text); assert.strictEqual(r.ok, false, k + ' should be rejected: ' + JSON.stringify(r)); }
  const sim = await mk(); const c = await connect(sim); sim.cmd('stop'); await sleep(100); c.got.length = 0;
  assert.strictEqual(sim.cmd('malformed', 'all'), 'sent all'); sim.cmd('unknown'); await sleep(250);
  assert.strictEqual(c.got.length, Object.keys(MALFORMED).length + 1);
  const u = P.parse(c.got[c.got.length - 1]); assert.ok(u.ok && u.msg.type === 'unknown');
  assert.match(sim.cmd('malformed', 'nope'), /kinds:/); c.ws.close(); await sim.stop();
});

test('control panel HTTP API: state, commands, page is labelled simulated', async () => {
  const sim = await mk(); const page = await new Promise((res) => http.get({ port: sim.uiPort, path: '/' }, (r) => { let d = ''; r.on('data', (x) => d += x); r.on('end', () => res(d)); }));
  assert.match(page, /SIMULATED DATA/); const r = await post(sim, { cmd: 'rssi', a: 'N2', b: -70 }); assert.strictEqual(r.result, 'ok'); assert.strictEqual(sim.state().nodes[1].rssi, -70); assert.strictEqual(sim.state().simulated, true);
  assert.strictEqual((await post(sim, { cmd: 'bogus' })).result.startsWith('unknown command'), true); await sim.stop();
});

test('protocol hardening: bad ts, empty node_frame and unknown fields', () => {
  assert.strictEqual(P.parse(JSON.stringify({ v: 1, type: 'node_frame', node: 'N1', ts: 'x', raw: { rssi: -50 } })).ok, false);
  assert.strictEqual(P.parse(JSON.stringify({ v: 1, type: 'node_frame', node: 'N1', ts: -5, raw: { rssi: -50 } })).ok, false);
  assert.strictEqual(P.parse(JSON.stringify({ v: 1, type: 'node_frame', node: 'N1' })).ok, false);
  assert.strictEqual(P.parse(JSON.stringify({ v: 1, type: 'node_frame', node: 'N1', raw: { rssi: -50 }, extra: { future: 1 } })).ok, true, 'unknown extra fields tolerated');
  assert.strictEqual(P.parse(JSON.stringify({ v: 1, type: 'hello', gateway_id: 'x' })).msg.simulated, false, 'simulated defaults to false');
});
