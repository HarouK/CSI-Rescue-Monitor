#!/usr/bin/env node
/* MOCK GATEWAY - a TEST TOOL, not ESP32 firmware. It speaks the PROPOSED protocol (docs/PROTOCOL.md)
 * so the app's Hardware Mode can be exercised without hardware.
 * Usage: node tools/mock-gateway.js [port=81]    (needs: npm i ws)
 * Module: const {startGateway} = require('./tools/mock-gateway'); */
'use strict';
let WebSocketServer;
try { ({ WebSocketServer } = require('ws')); } catch (e) { try { ({ WebSocketServer } = require('/opt/npm-tools/node_modules/ws')); } catch (e2) { console.error('Install ws first: npm i ws'); process.exit(1); } }

function startGateway(opts) {
  opts = opts || {};
  const port = opts.port || 81, path = opts.path || '/csi', intervalMs = opts.intervalMs || 500;
  const wss = new WebSocketServer({ port, path, host: opts.host || '127.0.0.1' });
  const seq = { N1: 0, N2: 0, N3: 0, N4: 0 };
  let timer = null, sending = !opts.paused;
  const silent = new Set(), routes = {};
  const clients = new Set();
  const send = (o) => clients.forEach((c) => c.readyState === 1 && c.send(typeof o === 'string' ? o : JSON.stringify(o)));
  function frames() {
    if (!sending) return;
    const cfg = { N1: [false, 0.93, -61, 0.021], N2: [true, 0.87, -54, 0.184], N3: [false, 0.64, -73, 0.047], N4: [true, 0.71, -67, 0.126] };
    Object.keys(cfg).forEach((id) => {
      if (silent.has(id)) return;
      const [p, c, r, a] = cfg[id]; seq[id]++;
      send({ v: 1, type: 'node_frame', node: id, seq: seq[id], raw: { rssi: r, amp_var: a, pkt_rate: 100 }, processed: { breath_band_db: p ? 9.6 : 1.2, motion_idx: 0.1 }, batt_pct: 80, route: routes[id] || { hops: 1 }, estimate: { present: p, confidence: c, algorithm: 'mock', validated: false } });
    });
  }
  wss.on('connection', (ws) => {
    clients.add(ws); ws.on('close', () => clients.delete(ws));
    if (opts.junkOnConnect) ws.send('this is not protocol v1');
    if (opts.hello !== false) ws.send(JSON.stringify({ v: 1, type: 'hello', gateway_id: 'MOCK-GATEWAY', fw: 'mock-0', threshold: 0.1, stale_ms: 5000, nodes: [{ id: 'N1', zone: 'Zone A · concrete slab', material: 'concrete' }, { id: 'N2', zone: 'Zone B · wood panel', material: 'wood' }, { id: 'N3', zone: 'Zone C · metal sheet', material: 'metal' }, { id: 'N4', zone: 'Zone D · mixed rubble', material: 'concrete + wood' }] }));
  });
  timer = setInterval(frames, intervalMs);
  return {
    port, send, sendRaw: (t) => send(String(t)),
    pauseFrames: () => { sending = false; }, resumeFrames: () => { sending = true; },
    silenceNode: (id, on) => { on ? silent.add(id) : silent.delete(id); },
    setRoute: (id, hops, via) => { if (hops > 1) routes[id] = { hops, via }; else delete routes[id]; },
    clientCount: () => clients.size,
    dropClients: () => clients.forEach((c) => c.terminate()),
    stop: () => new Promise((res) => { clearInterval(timer); clients.forEach((c) => c.terminate()); wss.close(() => res()); })
  };
}
module.exports = { startGateway };
if (require.main === module) { const g = startGateway({ port: +process.argv[2] || 81, host: '0.0.0.0' }); console.log('Mock gateway on ws://0.0.0.0:' + g.port + '/csi (TEST TOOL, simulated values)'); }
