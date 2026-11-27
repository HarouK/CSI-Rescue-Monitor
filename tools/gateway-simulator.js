#!/usr/bin/env node
/* CSI RESCUE MONITOR - SOFTWARE GATEWAY SIMULATOR
 * A TEST TOOL. It is NOT ESP32 firmware and everything it sends is SIMULATED. Its hello message says
 * "simulated": true, so the app labels the connection "SOFTWARE SIMULATOR".
 * It speaks the existing protocol v1 (docs/PROTOCOL.md). No npm packages needed: Node 18+ only.
 *
 *   node tools/gateway-simulator.js [--ws-port 81] [--ui-port 8090] [--host 0.0.0.0] [--interval 500]
 *
 *   WebSocket gateway : ws://<this-PC>:81/csi   (what the app connects to)
 *   Control panel     : http://127.0.0.1:8090   (buttons for every scenario; local PC only)
 *   Command line      : type "help" in the terminal.
 *
 * Module use (tests):  const { startSimulator } = require('./tools/gateway-simulator'); const sim = await startSimulator({ wsPort: 0, uiPort: 0, quiet: true }); sim.cmd('rssi','N2',-70); */
'use strict';
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const NODE_IDS = ['N1', 'N2', 'N3', 'N4'];
const ZONES = { N1: ['Zone A · concrete slab', 'concrete'], N2: ['Zone B · wood panel', 'wood'], N3: ['Zone C · metal sheet', 'metal'], N4: ['Zone D · mixed rubble', 'concrete + wood'] };
const BASE = { // scripted starting values (SIMULATED)
  N1: { rssi: -61, amp: 0.021, motion: 0.03, present: false, conf: 0.93 }, N2: { rssi: -54, amp: 0.184, motion: 0.11, present: true, conf: 0.87 },
  N3: { rssi: -73, amp: 0.047, motion: 0.05, present: false, conf: 0.64 }, N4: { rssi: -67, amp: 0.126, motion: 0.08, present: true, conf: 0.71 }
};
const MALFORMED = {
  json: '{"v":1,"type":"node_frame","node":"N1",',
  text: 'this is not JSON at all',
  empty: '   ',
  version: JSON.stringify({ v: 2, type: 'node_frame', node: 'N1', raw: { rssi: -60 } }),
  notype: JSON.stringify({ v: 1, node: 'N1', raw: { rssi: -60 } }),
  nonode: JSON.stringify({ v: 1, type: 'node_frame', raw: { rssi: -60 } }),
  badnode: JSON.stringify({ v: 1, type: 'node_frame', node: 'N 1/../x', raw: { rssi: -60 } }),
  badnumber: JSON.stringify({ v: 1, type: 'node_frame', node: 'N1', raw: { rssi: 'loud', amp_var: 0.02 } }),
  range: JSON.stringify({ v: 1, type: 'node_frame', node: 'N1', raw: { rssi: 55, amp_var: -3 } }),
  badts: JSON.stringify({ v: 1, type: 'node_frame', node: 'N1', ts: 'yesterday', raw: { rssi: -60 } }),
  nomeasure: JSON.stringify({ v: 1, type: 'node_frame', node: 'N1' }),
  badconf: JSON.stringify({ v: 1, type: 'node_frame', node: 'N1', estimate: { present: 'yes', confidence: 3 } })
};

function startSimulator(opts) {
  opts = opts || {};
  const intervalMs = opts.intervalMs || 500, heartbeatMs = opts.heartbeatMs || 2000, quiet = !!opts.quiet;
  const host = opts.host || '0.0.0.0', path = opts.path || '/csi';
  const clients = new Set();
  const S = {
    running: true, gatewayUp: true, heartbeat: true, seqDrop: 0, startedAt: Date.now(), sent: 0, notes: [],
    nodes: {}
  };
  NODE_IDS.forEach((id) => { const b = BASE[id]; S.nodes[id] = { enabled: true, announcedOffline: false, rssi: b.rssi, amp: b.amp, motion: b.motion, present: b.present, conf: b.conf, seq: 0, last: null, hops: 1, via: null }; });
  const log = (t) => { const line = new Date().toLocaleTimeString() + '  ' + t; S.notes.unshift(line); S.notes.length = Math.min(S.notes.length, 40); if (!quiet) console.log(line); };

  // ---------- minimal WebSocket server (server -> client text frames) ----------
  function frame(text) {
    const p = Buffer.from(text, 'utf8'), n = p.length; let h;
    if (n < 126) h = Buffer.from([0x81, n]); else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(n, 2); } else { h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    return Buffer.concat([h, p]);
  }
  function sendRaw(text) { const f = frame(text); clients.forEach((s) => { try { s.write(f); } catch (e) { /* ignore */ } }); S.sent += clients.size ? 1 : 0; }
  const send = (o) => sendRaw(JSON.stringify(o));
  function onClientData(sock, buf) { // only handle close(8) / ping(9); clients send nothing else in this protocol
    for (let i = 0; i + 2 <= buf.length;) {
      const op = buf[i] & 0x0f; let len = buf[i + 1] & 0x7f, off = i + 2; const masked = (buf[i + 1] & 0x80) !== 0;
      if (len === 126) { len = buf.readUInt16BE(off); off += 2; } else if (len === 127) { len = Number(buf.readBigUInt64BE(off)); off += 8; }
      let mask = null; if (masked) { mask = buf.slice(off, off + 4); off += 4; }
      const body = Buffer.from(buf.slice(off, off + len)); if (mask) for (let k = 0; k < body.length; k++) body[k] ^= mask[k % 4];
      if (op === 8) { try { sock.write(Buffer.from([0x88, 0x00])); sock.end(); } catch (e) { /* ignore */ } return; }
      if (op === 9) { try { sock.write(Buffer.concat([Buffer.from([0x8a, body.length]), body])); } catch (e) { /* ignore */ } }
      i = off + len;
    }
  }
  const wsServer = http.createServer((req, res) => { res.writeHead(426, { 'content-type': 'text/plain' }); res.end('CSI gateway simulator: connect with a WebSocket to ' + path + '\n'); });
  wsServer.on('upgrade', (req, sock) => {
    const key = req.headers['sec-websocket-key'];
    if (!S.gatewayUp || req.url.split('?')[0] !== path || !key) { sock.write('HTTP/1.1 ' + (S.gatewayUp ? '404 Not Found' : '503 Service Unavailable') + '\r\nConnection: close\r\n\r\n'); sock.destroy(); return; }
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + crypto.createHash('sha1').update(key + GUID).digest('base64') + '\r\n\r\n');
    clients.add(sock); log('client connected (' + clients.size + ' total)');
    sock.on('data', (b) => onClientData(sock, b)); sock.on('error', () => {}); sock.on('close', () => { clients.delete(sock); log('client left (' + clients.size + ' total)'); });
    sendHello();
  });

  function sendHello() {
    send({ v: 1, type: 'hello', gateway_id: 'SIMULATOR', gateway_kind: 'software-simulator', simulated: true, fw: 'sim-1', threshold: 0.1, stale_ms: 5000, nodes: NODE_IDS.map((id) => ({ id, zone: ZONES[id][0], material: ZONES[id][1] })) });
    send({ v: 1, type: 'event', cat: 'Gateway', sev: 'Info', text: 'SOFTWARE SIMULATOR: all values are simulated, not physical measurements' });
    heartbeat();
  }
  function heartbeat() {
    if (!S.running || !S.heartbeat) return;
    send({ v: 1, type: 'status', power: { source: 'Software simulator (no battery)', runtime_min: null }, nodes: NODE_IDS.map((id) => ({ id, online: S.nodes[id].enabled && !S.nodes[id].announcedOffline })) });
  }
  const j = (a) => (Math.random() - 0.5) * a;
  function nodeFrame(id) {
    const n = S.nodes[id]; n.seq++;
    const f = { v: 1, type: 'node_frame', node: id, seq: n.seq, ts: Date.now(), batt_pct: 80,
      route: { hops: n.hops, via: n.via },
      raw: { rssi: Math.round(n.rssi + j(3)), amp_var: Math.max(0.001, +(n.amp + j(n.amp * 0.15)).toFixed(4)), pkt_rate: 100 },
      processed: { breath_band_db: n.present ? 9.6 : 1.2, motion_idx: Math.max(0, +(n.motion + j(0.02)).toFixed(3)) },
      estimate: { present: n.present, confidence: Math.max(0, Math.min(1, +(n.conf + j(0.04)).toFixed(3))), algorithm: 'simulator-scripted', validated: false } };
    n.last = f; return f;
  }
  function tick() {
    if (!S.running || !S.gatewayUp || !clients.size) return;
    NODE_IDS.forEach((id) => { const n = S.nodes[id]; if (n.enabled) { if (S.seqDrop > 0 && Math.random() < S.seqDrop) { n.seq++; return; } send(nodeFrame(id)); } });
  }
  const t1 = setInterval(tick, intervalMs), t2 = setInterval(heartbeat, heartbeatMs);

  // ---------- commands (used by CLI, control panel and tests) ----------
  const num = (x) => (x === undefined || x === '' || isNaN(+x) ? null : +x);
  const nodeOf = (id) => { id = String(id || '').toUpperCase(); return S.nodes[id] ? id : null; };
  function cmd(name, a, b, c) {
    name = String(name || '').toLowerCase();
    const forNodes = (fn) => { if (String(a).toLowerCase() === 'all') { NODE_IDS.forEach(fn); return true; } const id = nodeOf(a); if (!id) return false; fn(id); return true; };
    switch (name) {
      case 'start': S.running = true; log('simulator STARTED'); heartbeat(); return 'started';
      case 'stop': S.running = false; log('simulator STOPPED (socket stays open, no data: gateway-silent scenario)'); return 'stopped';
      case 'startnodes': NODE_IDS.forEach((id) => { S.nodes[id].enabled = true; S.nodes[id].announcedOffline = false; }); log('all four nodes started'); heartbeat(); return 'all nodes started';
      case 'stopnode': if (!forNodes((id) => { S.nodes[id].enabled = false; log(id + ' stopped silently (app should show it stale, then offline)'); })) return 'unknown node'; return 'ok';
      case 'disconnect': if (!forNodes((id) => { S.nodes[id].enabled = false; S.nodes[id].announcedOffline = true; log(id + ' DISCONNECTED (gateway announces offline)'); })) return 'unknown node'; heartbeat(); return 'ok';
      case 'restore': case 'restorenode': if (!forNodes((id) => { S.nodes[id].enabled = true; S.nodes[id].announcedOffline = false; log(id + ' restored'); })) return 'unknown node'; heartbeat(); return 'ok';
      case 'rssi': { const v = num(b); if (v === null || v < -127 || v > 0) return 'rssi must be -127..0'; return forNodes((id) => { S.nodes[id].rssi = v; log(id + ' RSSI set to ' + v + ' dBm (simulated)'); }) ? 'ok' : 'unknown node'; }
      case 'variance': { const v = num(b); if (v === null || v < 0) return 'variance must be >= 0'; return forNodes((id) => { S.nodes[id].amp = v; log(id + ' CSI amplitude variance set to ' + v + ' (simulated)'); }) ? 'ok' : 'unknown node'; }
      case 'motion': { const v = num(b); if (v === null || v < 0) return 'motion must be >= 0'; return forNodes((id) => { S.nodes[id].motion = v; log(id + ' motion index set to ' + v + ' (simulated)'); }) ? 'ok' : 'unknown node'; }
      case 'present': { const p = /^(1|true|yes|on)$/i.test(String(b)); const cf = num(c); return forNodes((id) => { S.nodes[id].present = p; if (cf !== null) S.nodes[id].conf = Math.max(0, Math.min(1, cf)); log(id + ' presence ESTIMATE set to ' + (p ? 'present' : 'absent') + ' (simulated, not a detection)'); }) ? 'ok' : 'unknown node'; }
      case 'route': { const id = nodeOf(a); if (!id) return 'unknown node'; const h = num(b) || 1; S.nodes[id].hops = h; S.nodes[id].via = h > 1 ? (c || 'N3') : null; log(id + ' route: ' + h + ' hop(s)' + (h > 1 ? ' via ' + S.nodes[id].via : '')); return 'ok'; }
      case 'interrupt': S.gatewayUp = false; clients.forEach((s) => { try { s.destroy(); } catch (e) { /* ignore */ } }); log('GATEWAY INTERRUPTED (sockets closed, new connections refused)'); return 'gateway interrupted';
      case 'restoregateway': S.gatewayUp = true; log('gateway restored (accepting connections)'); return 'gateway restored';
      case 'malformed': { const k = String(a || 'json'); if (k === 'all') { Object.keys(MALFORMED).forEach((x) => sendRaw(MALFORMED[x])); log('sent ' + Object.keys(MALFORMED).length + ' malformed test messages'); return 'sent all'; } if (!MALFORMED[k]) return 'kinds: ' + Object.keys(MALFORMED).join(', ') + ', all'; sendRaw(MALFORMED[k]); log('sent malformed message: ' + k); return 'sent ' + k; }
      case 'unknown': send({ v: 1, type: 'future_message_type', note: 'unknown type for compatibility testing', payload: { x: 1 } }); log('sent unknown message type'); return 'sent';
      case 'duplicate': { const id = nodeOf(a) || 'N2'; const n = S.nodes[id]; if (!n.last) return 'no frame sent yet'; send(Object.assign({}, n.last, { raw: Object.assign({}, n.last.raw, { rssi: -99 }) })); log(id + ' duplicate/out-of-order frame sent (same seq, different RSSI): app should ignore it'); return 'sent'; }
      case 'dropframes': { const v = num(a); S.seqDrop = v === null ? 0 : Math.max(0, Math.min(1, v)); log('simulated packet loss ' + Math.round(S.seqDrop * 100) + '% (sequence gaps)'); return 'ok'; }
      case 'heartbeat': S.heartbeat = !/^(0|off|false)$/i.test(String(a)); log('status heartbeat ' + (S.heartbeat ? 'ON' : 'OFF')); return 'ok';
      case 'reset': NODE_IDS.forEach((id) => { const b2 = BASE[id], n = S.nodes[id]; Object.assign(n, { enabled: true, announcedOffline: false, rssi: b2.rssi, amp: b2.amp, motion: b2.motion, present: b2.present, conf: b2.conf, hops: 1, via: null }); }); S.running = true; S.gatewayUp = true; S.seqDrop = 0; log('scenario reset'); return 'reset';
      case 'status': return state();
      default: return 'unknown command "' + name + '". Type help.';
    }
  }
  function state() {
    return { simulated: true, running: S.running, gatewayUp: S.gatewayUp, heartbeat: S.heartbeat, clients: clients.size, packetLoss: S.seqDrop, uptimeS: Math.round((Date.now() - S.startedAt) / 1000),
      nodes: NODE_IDS.map((id) => { const n = S.nodes[id]; return { id, enabled: n.enabled, announcedOffline: n.announcedOffline, rssi: n.rssi, variance: n.amp, motion: n.motion, present: n.present, confidence: n.conf, seq: n.seq, hops: n.hops }; }), notes: S.notes.slice(0, 15) };
  }

  // ---------- control panel (HTTP, local PC only by default) ----------
  const ui = http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    if (req.method === 'GET' && u === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PANEL); }
    if (req.method === 'GET' && u === '/api/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(state())); }
    if (req.method === 'POST' && u === '/api/cmd') {
      let body = ''; req.on('data', (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on('end', () => { let r; try { const o = JSON.parse(body); r = cmd(o.cmd, o.a, o.b, o.c); } catch (e) { r = 'bad request'; } res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result: r })); });
      return;
    }
    res.writeHead(404); res.end('not found');
  });

  return new Promise((resolve, reject) => {
    wsServer.once('error', reject);
    wsServer.listen(opts.wsPort === undefined ? 81 : opts.wsPort, host, () => {
      ui.once('error', reject);
      ui.listen(opts.uiPort === undefined ? 8090 : opts.uiPort, opts.uiHost || '127.0.0.1', () => {
        const api = {
          wsPort: wsServer.address().port, uiPort: ui.address().port, cmd, state, sendRaw, send, clientCount: () => clients.size,
          stop: () => new Promise((done) => { clearInterval(t1); clearInterval(t2); clients.forEach((s) => s.destroy()); wsServer.close(() => ui.close(() => done())); })
        };
        log('SOFTWARE SIMULATOR ready: ws://' + (host === '0.0.0.0' ? '<this PC IP>' : host) + ':' + api.wsPort + path + '  control panel http://127.0.0.1:' + api.uiPort);
        resolve(api);
      });
    });
  });
}

const PANEL = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>CSI Gateway Simulator</title>
<style>body{font:14px system-ui,sans-serif;background:#071018;color:#d6e4ef;margin:0;padding:16px;max-width:980px;margin:auto}h1{font-size:18px;margin:0 0 4px}
.warn{background:#3a2a0a;border:1px solid #ffb454;color:#ffcf87;padding:8px 12px;border-radius:8px;margin:8px 0 14px}
button{background:#12303a;color:#d6e4ef;border:1px solid #2a6;border-radius:6px;padding:6px 10px;margin:2px;cursor:pointer}button:hover{background:#1b4a56}
.row{margin:10px 0}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #1d3340;padding:6px;text-align:left}input{background:#0b1b25;color:#d6e4ef;border:1px solid #2a4a5a;border-radius:4px;padding:4px;width:70px}
pre{background:#0b1b25;padding:10px;border-radius:8px;max-height:220px;overflow:auto;font-size:12px}.ok{color:#37e0a1}.bad{color:#ff8a8a}</style>
<h1>CSI Rescue Monitor · Software Gateway Simulator</h1>
<div class=warn><b>SIMULATED DATA.</b> Nothing here is measured by an ESP32. The app labels this connection "SOFTWARE SIMULATOR".</div>
<div class=row id=top></div>
<div class=row><b>Gateway</b> <button onclick="c('start')">Start simulator</button><button onclick="c('stop')">Stop (silent socket)</button><button onclick="c('interrupt')">Interrupt gateway</button><button onclick="c('restoregateway')">Restore gateway</button><button onclick="c('startnodes')">Start all 4 nodes</button><button onclick="c('reset')">Reset scenario</button></div>
<div class=row><b>Test messages</b> <button onclick="c('malformed','json')">Broken JSON</button><button onclick="c('malformed','badnumber')">Bad number</button><button onclick="c('malformed','nomeasure')">Empty frame</button><button onclick="c('malformed','badts')">Bad timestamp</button><button onclick="c('malformed','all')">All malformed</button><button onclick="c('unknown')">Unknown type</button><button onclick="c('duplicate','N2')">Duplicate frame</button><button onclick="c('dropframes',0.3)">30% packet loss</button><button onclick="c('dropframes',0)">No loss</button><button onclick="c('heartbeat','off')">Heartbeat off</button><button onclick="c('heartbeat','on')">Heartbeat on</button></div>
<table><thead><tr><th>Node<th>State<th>RSSI dBm<th>CSI variance<th>Motion<th>Presence estimate<th>Actions</thead><tbody id=nodes></tbody></table>
<h3>Recent events</h3><pre id=notes></pre>
<script>
async function c(cmd,a,b,cc){await fetch('/api/cmd',{method:'POST',body:JSON.stringify({cmd,a,b,c:cc})});load()}
function v(id,k){return document.getElementById(id+k).value}
async function load(){const s=await (await fetch('/api/state')).json();
document.getElementById('top').innerHTML='Simulator: <b class='+(s.running?'ok':'bad')+'>'+(s.running?'RUNNING':'STOPPED')+'</b> · Gateway: <b class='+(s.gatewayUp?'ok':'bad')+'>'+(s.gatewayUp?'UP':'INTERRUPTED')+'</b> · App connections: <b>'+s.clients+'</b> · Packet loss '+Math.round(s.packetLoss*100)+'% · Heartbeat '+(s.heartbeat?'on':'off');
const act=document.activeElement&&document.activeElement.tagName==='INPUT';
if(!act)document.getElementById('nodes').innerHTML=s.nodes.map(n=>'<tr><td><b>'+n.id+'</b><td>'+(n.announcedOffline?'<span class=bad>disconnected</span>':n.enabled?'<span class=ok>sending</span>':'<span class=bad>silent</span>')+'<td><input id='+n.id+'r value='+n.rssi+'><td><input id='+n.id+'a value='+n.variance+'><td><input id='+n.id+'m value='+n.motion+'><td>'+(n.present?'present':'absent')+' ('+n.confidence+')<td>'+
'<button onclick="c(\\'rssi\\',\\''+n.id+'\\',v(\\''+n.id+'\\',\\'r\\'))">Set RSSI</button><button onclick="c(\\'variance\\',\\''+n.id+'\\',v(\\''+n.id+'\\',\\'a\\'))">Set variance</button><button onclick="c(\\'motion\\',\\''+n.id+'\\',v(\\''+n.id+'\\',\\'m\\'))">Set motion</button><button onclick="c(\\'present\\',\\''+n.id+'\\',\\''+(n.present?'0':'1')+'\\')">Toggle presence</button><button onclick="c(\\'stopnode\\',\\''+n.id+'\\')">Stop</button><button onclick="c(\\'disconnect\\',\\''+n.id+'\\')">Disconnect</button><button onclick="c(\\'restore\\',\\''+n.id+'\\')">Restore</button>').map(x=>x).join('');
document.getElementById('notes').textContent=s.notes.join('\\n')}
load();setInterval(load,1500);
</script>`;

const HELP = `Commands (N = N1..N4 or all):
  start | stop                      start / stop sending (stop keeps the socket open: gateway-silent)
  startnodes                        enable all four nodes
  stopnode N                        node goes silent (app must detect it by timeout)
  disconnect N | restore N          gateway announces node offline / node returns
  rssi N dBm | variance N value | motion N value
  present N 1|0 [confidence]        set the simulated presence ESTIMATE
  route N hops [via]                e.g. route N4 2 N3
  interrupt | restoregateway        close all sockets and refuse connections / accept again
  malformed [json|text|empty|version|notype|nonode|badnode|badnumber|range|badts|nomeasure|badconf|all]
  unknown | duplicate N | dropframes 0..1 | heartbeat on|off | reset | status | help | quit`;

function arg(name, dflt) { const i = process.argv.indexOf('--' + name); return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : dflt; }
if (require.main === module) {
  startSimulator({ wsPort: +arg('ws-port', 81), uiPort: +arg('ui-port', 8090), host: arg('host', '0.0.0.0'), intervalMs: +arg('interval', 500) }).then((sim) => {
    console.log('\nSOFTWARE SIMULATOR (simulated values only). Type "help" for commands.\n');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'sim> ' }); rl.prompt();
    rl.on('line', (l) => { const p = l.trim().split(/\s+/); if (p[0] === 'help') console.log(HELP); else if (p[0] === 'quit' || p[0] === 'exit') { sim.stop().then(() => process.exit(0)); return; } else if (p[0]) { const r = sim.cmd(p[0], p[1], p[2], p[3]); console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1)); } rl.prompt(); });
    rl.on('close', () => { /* keep running when stdin closes (e.g. started in background) */ });
  }).catch((e) => { console.error('Could not start: ' + e.message + (e.code === 'EADDRINUSE' ? ' (port in use: try --ws-port 8081 --ui-port 8091)' : '')); process.exit(1); });
}
module.exports = { startSimulator, MALFORMED };
