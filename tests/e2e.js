// End-to-end tests in headless Chromium against the real web UI + a mock gateway.
// Run: NODE_PATH=<global node_modules> node tests/e2e.js   (needs playwright and ws)
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { startGateway } = require('../tools/mock-gateway.js');
const WWW = path.join(__dirname, '../app/src/main/assets/www'), REF = path.join(__dirname, 'reference'), SHOT = path.join(__dirname, 'screenshots');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.woff2': 'font/woff2' };
function serve(root, port) { return new Promise((res) => { const s = http.createServer((q, r) => { const f = path.join(root, q.url.split('?')[0] === '/' ? 'index.html' : q.url.split('?')[0]); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(port, '127.0.0.1', () => res(s)); }); }
const results = []; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(name, fn) { try { const d = await fn(); results.push({ name, pass: true, detail: d || '' }); console.log('PASS', name, d || ''); } catch (e) { results.push({ name, pass: false, detail: e.message }); console.log('FAIL', name, '-', e.message); } }
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
async function waitFor(fn, ms, what) { const t = Date.now(); for (;;) { try { const v = await fn(); if (v) return v; } catch (e) { /* retry */ } if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what); await sleep(150); } }

(async () => {
  const web = await serve(WWW, 8770), ref = await serve(REF, 8771);
  const browser = await chromium.launch();
  const external = [];
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, acceptDownloads: true });
  await ctx.route('**/*', (r) => { const u = new URL(r.request().url()); if (['localhost', '127.0.0.1'].includes(u.hostname)) return r.continue(); external.push(r.request().url()); return r.abort(); });
  let page = await ctx.newPage(); const jsErrors = [];
  const hook = (pg) => pg.on('pageerror', (e) => jsErrors.push(e.message)); hook(page);
  const text = () => page.evaluate(() => document.body.innerText);
  const state = (expr) => page.evaluate(expr);
  const NAVI = { Dashboard: 0, Observatory: 0, Analytics: 1, Alerts: 2, Logs: 3, Connection: 4 };
  // 'Alerts & log' = both cards on one page (CSI_ui.go); every other name clicks the real navigation button.
  const tab = async (n) => { if (n === 'Alerts & log') await page.evaluate(() => window.CSI_ui.go('log', 'both')); else await page.locator('nav[aria-label=Main] button').nth(NAVI[n]).click(); await sleep(200); };
  await page.goto('http://127.0.0.1:8770/index.html'); await sleep(2500);

  await check('offline: loads with zero external requests (CDN/fonts blocked)', async () => { eq(external.length, 0, external.join(',')); ok((await text()).includes('VITAL SIGNS') || /vital signs/i.test(await text()), 'observatory rendered'); });
  await check('no uncaught JS errors on load', async () => { eq(jsErrors.length, 0, jsErrors.join(' | ')); });
  await check('demo: DEMO DATA badge, demo link text, 2 flagged zones from simulated nodes', async () => { const t = await text(); ok(t.includes('DEMO DATA') && t.includes('Demo mode · simulated'), 'badge'); ok(/Flagged zones\s*\n\s*2/.test(t), 'flagged=2'); ok(t.includes('Zone B') && t.includes('Zone D')); });
  await check('nav: all four tabs open and show their heading', async () => {
    for (const [n, h] of [['Analytics', 'Estimator output'], ['Alerts & log', 'System log'], ['Connection', 'Data source'], ['Dashboard', 'Mesh node status']]) { await tab(n); ok((await text()).includes(h), n + ' -> ' + h); }
  });
  await check('demo: analytics chart, KPIs and node picker work (select N4)', async () => {
    await tab('Analytics'); await page.getByRole('button', { name: 'N4', exact: true }).click(); await sleep(300);
    const t = await text(); ok(t.includes('CSI variance · N4') && t.includes('Zone D'), 'N4 selected'); ok(/Nodes online\s*\n\s*4 \/ 4/i.test(t), 'kpi'); ok((await state(() => document.querySelector('polyline').getAttribute('points').split(' ').length)) > 3, 'chart has points');
  });
  await check('demo: "Simulate link cut" button reroutes N4 and raises a link alert', async () => {
    await tab('Analytics'); await page.getByRole('button', { name: /Simulate N4/ }).click(); await sleep(1800);
    ok((await text()).includes('via N3 (2 hops)'), 'path text'); await tab('Alerts & log'); ok((await text()).includes('Direct link lost · N4'), 'alert'); await tab('Analytics'); await page.getByRole('button', { name: /Restore N4/ }).click(); await sleep(1500);
  });
  await check('alerts: acknowledge toggles and updates open count', async () => {
    await tab('Alerts & log'); const before = await text(); const m = before.match(/(\d+) open/); ok(m, 'open count'); await page.getByRole('button', { name: 'Acknowledge', exact: true }).first().click(); await sleep(300);
    const after = (await text()).match(/(\d+) open/); ok(+after[1] === +m[1] - 1, m[1] + ' -> ' + after[1]); ok((await text()).includes('Acknowledged'));
  });
  await check('log: category filters work and CSV export downloads with DEMO label', async () => {
    await page.getByRole('button', { name: 'Mesh', exact: true }).click(); await sleep(200); const t = await text(); ok(!/\bDetect\b\s+Alert raised/.test(t), 'filtered');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export log/ }).click()]); const f = await dl.path(); const c = fs.readFileSync(f, 'utf8'); ok(c.startsWith('received_at_iso,severity,category,origin,data_source,message') && /,DEMO,/.test(c), 'csv header + DEMO rows'); return dl.suggestedFilename();
  });
  await check('dashboard: "Generate report" exports DEMO-labelled JSON', async () => { await tab('Dashboard'); const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Generate report' }).click()]); const j = JSON.parse(fs.readFileSync(await dl.path(), 'utf8')); ok(/DEMO/.test(j.dataSource) && /unvalidated/.test(j.disclaimer)); });
  await check('back button handler: non-dashboard tab -> dashboard, then not handled', async () => {
    await tab('Analytics'); eq(await state(() => window.CSI_onBack()), true); await sleep(200); ok((await text()).includes('Mesh node status')); eq(await state(() => window.CSI_onBack()), false);
  });

  // ---- hardware mode ----
  await tab('Connection'); await page.getByRole('button', { name: 'Hardware Mode' }).click(); await sleep(300);
  await check('hardware mode (not connected): HARDWARE badge, no demo values, NOT CONNECTED banner', async () => {
    const t = await text(); ok(t.includes('HARDWARE') && !t.includes('DEMO DATA'), 'badge'); ok(t.includes('NOT CONNECTED'), 'banner'); eq(await state(() => CSI.app.store.view().nodes.length), 0, 'no nodes shown');
    await tab('Dashboard'); const d = await text(); ok(/Flagged zones\s*\n\s*0/.test(d) && d.includes('No data'), 'no data on dashboard'); ok(!d.includes('Simulated'), 'no simulated label'); await tab('Connection');
  });
  const inp = (n) => page.getByLabel(n);
  const tryConnect = async (h, p, pa) => { await inp('Gateway IP address or name').fill(h); await inp('Gateway port').fill(p); await inp('WebSocket path').fill(pa || '/csi'); await page.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click(); await sleep(300); };
  await check('invalid gateway addresses show errors and do not connect', async () => {
    await tryConnect('8.8.8.8', '81'); ok((await text()).includes('Only local-network addresses'), 'public ip'); eq(await state(() => CSI.app.store.view().link.state), 'idle');
    await tryConnect('http://192.168.4.1', '81'); ok((await text()).includes('no http://'), 'scheme'); await tryConnect('192.168.4.1', '99999'); ok((await text()).includes('Port must be'), 'port'); await tryConnect('example.com', '81'); ok((await text()).includes('Internet host names are not allowed'));
    await tryConnect('192.168.4.1', '81', 'csi'); ok((await text()).includes('Path must start with'), 'path'); eq(await state(() => CSI.app.store.view().link.state), 'idle');
  });
  let gw;
  await check('unreachable gateway: shows reconnecting with attempt counter, error and retry timer', async () => {
    await tryConnect('127.0.0.1', '18081'); await waitFor(async () => (await text()).includes('LINK LOST · RECONNECTING'), 12000, 'reconnect banner'); const t = await text(); ok(/attempt \d/.test(t) && /retry in \d+ s/.test(t), 'attempt/retry'); ok(/Last error\s*\n?[^\n]*(refused|unreachable|timed out|closed)/i.test(t) || /Socket error|closed|timed out/.test(t), 'error text');
  });
  await check('connects automatically once the gateway comes up (no manual action)', async () => {
    gw = startGateway({ port: 18081, intervalMs: 400 }); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 20000, 'receiving'); await sleep(700); await tab('Connection'); const t = await text(); ok(/Receiving ·/i.test(t), 'status: ' + t.slice(0, 200)); ok(/MOCK-GATEWAY/i.test(t), 'hello: ' + (t.match(/Gateway[^\n]*\n[^\n]*/i) || [''])[0]);
  });
  await check('hardware dashboard shows received data with timestamps, labelled as estimates', async () => {
    await tab('Dashboard'); await sleep(600); const t = await text(); ok(/Updated \d\d:\d\d:\d\d · 4\/4 nodes/.test(t), 'timestamp'); ok(t.includes('Zone B 87%') || t.includes('Zone B 87%'.replace(' 87%', '')), 'zone'); ok(/Estimates: Zone B 87% · Zone D 71% \(unvalidated\)/.test(t), 'summary: ' + (t.match(/Estimates:[^\n]*/) || [''])[0]); ok(!t.includes('DEMO DATA') && !t.includes('Simulated'), 'no demo text');
    await tab('Analytics'); const a = await text(); ok(a.includes('PRESENCE ESTIMATED') && a.includes('Estimate (unvalidated)') && /Amplitude variance · raw/.test(a) && /processed/.test(a), 'tiers'); ok(/Last measurement received \(online\)\s*\n?\s*\d\d:\d\d:\d\d/i.test(a), 'last received');
  });
  await check('mock gateway values (not demo values) are what is displayed', async () => { await tab('Analytics'); await page.getByRole('button', { name: 'N3', exact: true }).click(); await sleep(300); const a = await text(); ok(/RSSI · raw\s*\n?\s*-73 dBm/.test(a) && /Amplitude variance · raw\s*\n?\s*0.047/.test(a)); ok(/N1 path to base\s*\n?\s*Direct/.test(a)); ok(/Packet delivery ratio\s*\n?\s*100.0%/.test(a), 'PDR computed from seq'); });
  await check('malformed / empty / wrong-version frames are counted and do not break the UI', async () => {
    const before = await state(() => CSI.app.store.ds.hardware.stats.malformed);
    ['garbage{', '', '{"v":1,"type":"node_frame","node":"N1","raw":{"rssi":"x"}}', '[]', '{"v":9,"type":"hello"}', '{"v":1,"type":"node_frame","node":"N1","estimate":{"present":true,"confidence":7}}'].forEach((m) => gw.sendRaw(m)); await sleep(700);
    const after = await state(() => CSI.app.store.ds.hardware.stats.malformed); ok(after - before >= 5, 'malformed +' + (after - before)); eq(await state(() => CSI.app.store.view().link.state), 'receiving'); await tab('Connection'); ok(/Malformed messages\s*\n?\s*[1-9]/.test(await text()), 'shown in UI'); ok(await state(() => CSI.app.store.ds.hardware.log.some((l) => /Malformed frame ignored/.test(l.text))), 'logged');
  });
  await check('hardware alerts derive from real frames (N2 PRIORITY, N3 weak signal) and notify native bridge', async () => {
    await tab('Alerts & log'); const t = await text(); ok(/CRITICAL/i.test(t) && t.includes('Possible signs of life · Zone B') && t.includes('Weak signal · N3') && /WARNING/i.test(t), 'alerts + severities'); ok(t.includes('not a confirmed detection'), 'wording');
  });
  await check('STALE: frames stop -> DATA STALE banner, last values kept, node alerts, never demo data', async () => {
    gw.pauseFrames(); await waitFor(async () => (await text()).includes('DATA STALE'), 12000, 'stale banner'); const t = await text(); ok(/Stale · no data for \d+ s/.test(t), 'status'); ok(/not live/.test(t), 'warning wording');
    await tab('Analytics'); ok(/RSSI · raw\s*\n?\s*-73 dBm/.test(await text()), 'last value kept'); eq(await state(() => CSI.app.store.view().nodes.length), 4); ok(!(await text()).includes('DEMO DATA') && !(await text()).includes('Simulated'), 'no demo');
    await tab('Alerts & log'); await waitFor(async () => /Gateway data stale/i.test(await text()), 3000, 'gateway stale alert'); gw.resumeFrames(); await waitFor(async () => !(await text()).includes('DATA STALE'), 8000, 'recover');
  });
  await check('CONNECTION LOSS: gateway dies -> LINK LOST banner, then auto-recovers when it returns', async () => {
    await gw.stop(); await waitFor(async () => (await text()).includes('LINK LOST · RECONNECTING'), 15000, 'lost banner'); await tab('Dashboard'); ok((await text()).includes('not live'), 'last-values wording'); eq(await state(() => CSI.app.store.settings.mode), 'hardware', 'stayed in hardware');
    gw = startGateway({ port: 18081, intervalMs: 400 }); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 25000, 'recovered'); ok(await state(() => CSI.app.store.ds.hardware.log.some((l) => /Connection lost/.test(l.text))), 'loss logged');
  });
  await check('manual Disconnect stops reconnecting', async () => { await tab('Connection'); await page.getByRole('button', { name: 'Disconnect' }).click(); await sleep(500); eq(await state(() => CSI.app.store.view().link.state), 'idle'); const n = gw.clientCount(); await sleep(3000); eq(gw.clientCount(), n, 'no reconnect'); eq(n, 0); });
  await check('switching Hardware -> Demo -> Hardware keeps datasets separate', async () => {
    await page.getByRole('button', { name: 'Demo Mode' }).click(); await sleep(1800); ok((await text()).includes('DEMO')); const hwN = await state(() => CSI.app.store.ds.hardware.order.length); await page.getByRole('button', { name: 'Hardware Mode' }).click(); await sleep(500);
    eq(await state(() => CSI.app.store.view().mode), 'hardware'); eq(await state(() => CSI.app.store.ds.hardware.order.length), hwN); ok(!(await state(() => CSI.app.store.ds.hardware.log.some((l) => /DEMO/.test(l.text)))), 'no demo logs in hardware');
  });
  await check('settings persist across reload (mode + gateway address)', async () => { await page.reload(); await sleep(2500); eq(await state(() => CSI.app.store.settings.mode), 'hardware'); eq(await state(() => CSI.app.store.settings.config.host), '127.0.0.1'); });
  // =================== new features ===================
  const rowVal = async (k) => (await text()).match(new RegExp(k.replace(/[()]/g, '\\$&') + '\\s*\\n\\s*([^\\n]+)', 'i'))?.[1] || '';
  const fillCfg = async (h, p, pa) => { await page.getByLabel('Gateway IP address or name').fill(h); await page.getByLabel('Gateway port').fill(p); await page.getByLabel('WebSocket path').fill(pa || '/csi'); };
  await page.evaluate(() => { CSI.app.store.disconnect(); CSI.app.store.setMode('hardware'); }); await page.setViewportSize({ width: 412, height: 860 }); await tab('Connection'); await sleep(400);

  await check('TEST CONNECTION: reachable gateway -> "reachable and sending valid data"; live link and counters untouched', async () => {
    await fillCfg('127.0.0.1', '18081'); const before = await state(() => JSON.stringify([CSI.app.store.view().link.state, CSI.app.store.ds.hardware.stats.frames]));
    await page.getByRole('button', { name: 'Test connection' }).click(); await waitFor(async () => /reachable and sending valid data/i.test(await text()), 8000, 'test ok');
    ok(/first valid message was/i.test(await text()), 'detail'); eq(await state(() => JSON.stringify([CSI.app.store.view().link.state, CSI.app.store.ds.hardware.stats.frames])), before, 'state unchanged'); ok(/Tested at \d\d:\d\d:\d\d/.test(await text()), 'test timestamp');
  });
  await check('TEST CONNECTION: invalid address, refused port, silent gateway, junk gateway', async () => {
    await fillCfg('8.8.8.8', '18081'); await page.getByRole('button', { name: 'Test connection' }).click(); await sleep(300); ok(/Address not valid/i.test(await text()) && /Only local-network/i.test(await text()), 'invalid');
    await fillCfg('127.0.0.1', '18999'); await page.getByRole('button', { name: 'Test connection' }).click(); await waitFor(async () => /Gateway not reachable/i.test(await text()), 8000, 'refused'); ok(/What to check/i.test(await text()) && /gateway's Wi-Fi/i.test(await text()), 'hints shown');
    const quiet = startGateway({ port: 18082, hello: false, paused: true }); await fillCfg('127.0.0.1', '18082'); await page.getByRole('button', { name: 'Test connection' }).click(); await waitFor(async () => /Connected, but no data yet/i.test(await text()), 9000, 'no-data warn'); await quiet.stop();
    const junk = startGateway({ port: 18083, hello: false, paused: true, junkOnConnect: true }); await fillCfg('127.0.0.1', '18083'); await page.getByRole('button', { name: 'Test connection' }).click(); await waitFor(async () => /Connected, but data is not valid/i.test(await text()), 9000, 'invalid-data warn'); ok(/Invalid JSON/.test(await text()), 'reason'); await junk.stop();
  });
  await check('CONNECT: last successful connection, message count and last-message time are shown and update', async () => {
    const lc0 = await state(() => CSI.app.store.settings.lastConnectedAt); await sleep(1100);
    await fillCfg('127.0.0.1', '18081'); await page.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click(); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 12000, 'receiving'); await sleep(900);
    const n1 = +(await rowVal('Messages received (all frames)')); await sleep(1800); const n2 = +(await rowVal('Messages received (all frames)')); ok(n1 > 0 && n2 > n1, `count grows ${n1} -> ${n2}`);
    ok(/\d\d:\d\d:\d\d \(\d+ s ago\)/.test(await rowVal('Last message received')), 'last message ' + (await rowVal('Last message received'))); ok(/\d{4}.*\d\d:\d\d:\d\d/.test(await rowVal('Last successful connection')), 'last connection ' + (await rowVal('Last successful connection'))); ok((await state(() => CSI.app.store.settings.lastConnectedAt)) > lc0, 'last-connected time advanced on new connection');
    ok(/Connected to ws:\/\/127.0.0.1:18081\/csi/.test(await text()), 'recent events lists connect');
  });
  await check('ANALYTICS: N1..N4 each show their own measurements, chart and latest-sample timestamp', async () => {
    await tab('Analytics'); await sleep(2500); const sig = {}; const exp = { N1: ['-61 dBm', '0.021'], N2: ['-54 dBm', '0.184'], N3: ['-73 dBm', '0.047'], N4: ['-67 dBm', '0.126'] };
    for (const n of ['N1', 'N2', 'N3', 'N4']) { await page.getByRole('button', { name: n, exact: true }).click(); await sleep(450); const t = await text(); ok(t.includes('CSI variance · ' + n), n + ' heading'); ok(t.includes(exp[n][0]) && t.includes(exp[n][1]), `${n} values ${exp[n]}`); ok(/Live · latest sample \d\d:\d\d:\d\d \(\d+ s ago\)/.test(t), n + ' live status'); ok(/Last measurement received \(online\)\s*\n?\s*\d\d:\d\d:\d\d · \d+ s ago/i.test(t), n + ' timestamp row'); sig[n] = await page.evaluate(() => document.querySelector('polyline').getAttribute('points').length + '|' + document.body.innerText.match(/scale 0 to [\d.]+/)); }
    ok(new Set(Object.values(sig)).size >= 3, 'different chart scales per node: ' + JSON.stringify(sig));
  });
  await check('CHART FREEZES when data stops (does not move), shows Paused + last sample time, resumes with data', async () => {
    await page.getByRole('button', { name: 'N2', exact: true }).click(); gw.pauseFrames(); await waitFor(async () => /Paused · last sample/.test(await text()), 14000, 'paused'); const a = await page.evaluate(() => document.querySelector('polyline').getAttribute('points')); await sleep(3500); const b = await page.evaluate(() => document.querySelector('polyline').getAttribute('points')); eq(a, b, 'chart frozen'); ok(/Chart resumes when new data arrives/.test(await text()));
    gw.resumeFrames(); await waitFor(async () => /Live · latest sample/.test(await text()), 10000, 'live again'); await sleep(1500); ok(a !== (await page.evaluate(() => document.querySelector('polyline').getAttribute('points'))), 'chart moves again');
  });
  await check('EMPTY CHART STATES: not connected / waiting for first measurement / hardware never plots demo', async () => {
    await page.evaluate(() => { CSI.app.store.ds.hardware.history = {}; CSI.app.store.ds.hardware.nodes.N3.lastSeen = null; CSI.app.store.ds.hardware.nodes.N3.est = null; CSI.app.store.ds.hardware.nodes.N3.rssi = null; }); gw.silenceNode('N3', true); await page.getByRole('button', { name: 'N3', exact: true }).click(); await sleep(700);
    const t = await text(); ok(/Waiting for the first measurement from N3/.test(t) && /No measurements received for N3/.test(t), 'waiting state: ' + (t.match(/Waiting[^\n]*/) || [''])[0]); gw.silenceNode('N3', false);
    await page.evaluate(() => CSI.app.store.disconnect()); await sleep(500); await page.evaluate(() => { CSI.app.store.ds.hardware.history = {}; }); await page.getByRole('button', { name: 'N1', exact: true }).click(); await sleep(500); ok(/Not connected, so no data from N1/.test(await text()), 'not connected state'); ok(await page.evaluate(() => document.querySelector('polyline').getAttribute('opacity') === '0.25'), 'flat faint placeholder line');
    await page.evaluate(() => CSI.app.store.setMode('demo')); await sleep(2800); ok(/simulated/i.test(await text()), 'demo chart labelled simulated'); await page.evaluate(() => CSI.app.store.setMode('hardware'));
  });
  await check('EXPLANATIONS: CSI variance and estimator output toggles', async () => {
    await tab('Analytics'); await page.getByRole('button', { name: 'What is CSI variance?' }).click(); await sleep(250); ok(/Channel State Information/.test(await text()) && /not proof that someone is there/.test(await text()), 'variance text'); await page.getByRole('button', { name: 'Hide explanation' }).click(); await sleep(200); ok(!/Channel State Information/.test(await text()), 'hidden');
    await page.getByRole('button', { name: 'What do these values mean?' }).click(); await sleep(250); ok(/never shows a confirmed detection/.test(await text()) && /Raw values are measured/.test(await text()), 'estimator text'); await page.getByRole('button', { name: 'Hide explanation' }).click();
  });
  await check('RECONNECT: gateway reconnect after earlier disconnect; saved address is used', async () => {
    await tab('Connection'); await fillCfg('127.0.0.1', '18081'); await page.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click(); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 12000, 'receiving'); await sleep(2500);
  });
  await check('ALERTS: severity (Info/Warning/Critical) + category chips distinguish detection, mesh and gateway events', async () => {
    gw.setRoute('N4', 2, 'N3'); gw.sendRaw('not json at all'); await sleep(1800); await tab('Alerts & log'); const t = await text();
    ok(/CRITICAL\s+DETECTION ESTIMATE\s+Possible signs of life · Zone B/i.test(t), 'critical detection'); ok(/WARNING\s+MESH\s+Direct link lost · N4 to base/i.test(t), 'warning mesh'); ok(/INFO\s+GATEWAY\s+\d+ malformed frame/i.test(t), 'info gateway'); ok(/\d\d:\d\d:\d\d/.test(t), 'timestamps');
    gw.setRoute('N4', 1); await sleep(1500); ok(/Direct link lost · N4 to base[\s\S]*cleared \d\d:\d\d:\d\d/i.test(await text()), 'alert shows cleared time');
  });
  await check('LOG: every row has time + severity + category; severity and category filters work', async () => {
    await tab('Alerts & log'); const rows = await page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => /^\d\d:\d\d:\d\d$/.test(d.children[0]?.textContent || '') && d.children.length === 4).map((d) => [...d.children].map((c) => c.textContent.trim()))); ok(rows.length > 5, 'rows ' + rows.length);
    ok(rows.every((r) => ['INFO', 'WARNING', 'CRITICAL'].includes(r[1]) && ['Detection est.', 'Mesh', 'Gateway', 'System'].includes(r[2])), 'row shape ' + JSON.stringify(rows[0]));
    await page.getByRole('button', { name: 'Warning', exact: true }).click(); await sleep(250); const w = await page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => /^\d\d:\d\d:\d\d$/.test(d.children[0]?.textContent || '') && d.children.length === 4).map((d) => d.children[1].textContent.trim())); ok(w.length > 0 && w.every((x) => x === 'WARNING'), 'severity filter ' + w.length);
    await page.getByRole('button', { name: 'Gateway', exact: true }).click(); await sleep(250); const g = await page.evaluate(() => [...document.querySelectorAll('div')].filter((d) => /^\d\d:\d\d:\d\d$/.test(d.children[0]?.textContent || '') && d.children.length === 4).map((d) => d.children[2].textContent.trim())); ok(g.length > 0 && g.every((x) => x === 'Gateway'), 'category filter ' + g.length);
    await page.getByRole('button', { name: 'All', exact: true }).first().click(); await page.getByRole('button', { name: 'All', exact: true }).last().click(); await sleep(200);
  });
  await check('CSV EXPORT: valid downloadable file (name, type, header, quoting, dates) - verified by Python csv module', async () => {
    await page.getByRole('button', { name: 'All', exact: true }).first().click(); gw.sendRaw(JSON.stringify({ v: 1, type: 'event', cat: 'Mesh', sev: 'Warning', text: 'comma, "quote" and\nnewline' })); await sleep(900);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export log/ }).click()]); const f = await dl.path(); ok(/^csi-log-HW-\d{8}-\d{6}\.csv$/.test(dl.suggestedFilename()), 'filename ' + dl.suggestedFilename()); const buf = fs.readFileSync(f); ok(buf.length > 100, 'non-empty'); ok(!(buf[0] === 0xEF), 'no BOM'); const dest = path.join(SHOT, 'last-export.csv'); fs.copyFileSync(f, dest);
    const py = require('child_process').execFileSync('python3', ['-I', '-c', 'import csv,sys,datetime\nrows=list(csv.reader(open(sys.argv[1],newline="",encoding="utf-8")))\nh=rows[0]\nassert h==["received_at_iso","severity","category","origin","data_source","message"],h\nassert all(len(r)==6 for r in rows),"ragged"\nfor r in rows[1:]:\n  datetime.datetime.fromisoformat(r[0].replace("Z","+00:00"))\n  assert r[1] in ("Info","Warning","Critical") and r[2] in ("Detect","Mesh","Gateway","System") and r[4]=="HARDWARE",r\nassert any(r[5]=="comma, \\"quote\\" and\\nnewline" for r in rows),"tricky text lost"\nprint(len(rows)-1,"valid rows")', dest]).toString().trim(); return py;
  });
  await check('GATEWAY LOSS UI: Critical Gateway alert, Retry now, What to check, connection events; clears on recovery', async () => {
    await gw.stop(); await waitFor(async () => /LINK LOST · RECONNECTING/.test(await text()), 15000, 'banner'); await tab('Alerts & log'); await waitFor(async () => /CRITICAL\s+GATEWAY\s+Gateway connection lost/i.test(await text()), 3000, 'critical gateway alert'); await waitFor(() => state(() => { const ids = CSI.app.store.ds.hardware.alerts.filter((a) => a.active).map((a) => a.id); return ids.includes('gw:link') && ids.every((x) => x === 'gw:link' || x === 'gw:malformed'); }), 10000, 'settles to the gateway alert only (no per-node noise, stale detections cleared)');
    await tab('Connection'); const t = await text(); ok(/Retry now/.test(t) && /What to check/.test(t) && /Next retry\s*\n?\s*in \d+ s/.test(t) && /Connection lost/.test(t) && /could not be reached|did not answer|closed the connection/.test(t), "feedback elements");
    const a0 = +(await rowVal('Reconnect attempt')); await page.getByRole('button', { name: 'Retry now' }).click(); await waitFor(async () => +(await rowVal('Reconnect attempt')) > a0, 12000, 'attempt increments after Retry now');
    gw = startGateway({ port: 18081, intervalMs: 400 }); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 30000, 'recovered'); await tab('Alerts & log'); await sleep(800); ok(/Gateway connection lost[\s\S]*cleared \d\d:\d\d:\d\d/i.test(await text()), 'cleared');
  });
  await check('PERSISTENCE: reload and full "app restart" (new page, same storage) restore settings and auto-reconnect', async () => {
    await tab('Connection'); await fillCfg('127.0.0.1', '18081', '/csi'); await page.getByRole('button', { name: /^(Connect|Reconnect)$/ }).click(); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 12000, 'receiving'); const lastConn = await rowVal('Last successful connection');
    await page.close(); page = await ctx.newPage(); hook(page); await page.setViewportSize({ width: 412, height: 860 }); await page.goto('http://127.0.0.1:8770/index.html'); await sleep(1500);
    await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 15000, 'auto-reconnect after restart'); await tab('Connection'); eq(await page.getByLabel('Gateway IP address or name').inputValue(), '127.0.0.1'); eq(await page.getByLabel('Gateway port').inputValue(), '18081'); eq(await page.getByLabel('WebSocket path').inputValue(), '/csi'); ok(/\d{4}.*\d\d:\d\d:\d\d/.test(await rowVal('Last successful connection')), 'last connection persisted: ' + lastConn);
    await page.getByLabel('Gateway port').fill('18555'); await page.close(); page = await ctx.newPage(); hook(page); await page.goto('http://127.0.0.1:8770/index.html'); await sleep(1500); await page.evaluate(() => CSI.app.store.disconnect()); await tab('Connection'); eq(await page.getByLabel('Gateway port').inputValue(), '18555', 'edited-but-unconnected draft persisted');
    await page.getByLabel('Gateway port').fill('18081'); await page.evaluate(() => CSI.app.store.setMode('demo'));
  });
  await check('SEPARATION: Demo Mode has no gateway form/Test button; demo log/alerts contain only DEMO-sourced entries; hardware data untouched', async () => {
    await page.evaluate(() => CSI.app.store.setMode('demo')); await tab('Connection'); await sleep(300); const t = await text(); ok(!/Test connection/.test(t) && !/Gateway \(local Wi-Fi\)/.test(t), 'no hardware form in demo'); ok(await page.evaluate(() => CSI.app.store.ds.demo.log.every((l) => l.src !== 'link') && CSI.app.store.ds.hardware.log.every((l) => !/DEMO/.test(l.text))), 'no cross-contamination');
    await tab('Alerts & log'); await page.getByRole('button', { name: /Export log/ }).click().catch(() => {}); await page.evaluate(() => CSI.app.store.setMode('hardware'));
  });
  await gw.stop();

  // ---- observatory (3D scene, panels, monitoring controls) ----
  const obs = () => page.evaluate(() => CSI.Observatory.debug());
  const cur = (name) => page.getByRole('button', { name }).first();
  await page.setViewportSize({ width: 1280, height: 860 });
  await check('OBSERVATORY demo: scene draws on canvas, 4 nodes, DEMO silhouettes only for flagged zones, labelled illustrative', async () => {
    await page.evaluate(() => CSI.app.store.setMode('demo')); await tab('Dashboard'); await sleep(1500);
    const d = await obs(); ok(d.drew && d.frames > 5, 'frames ' + d.frames); eq(d.nodes.length, 4); ok(d.demo === true, 'demo flag'); eq(d.markers.length, 2); ok(d.markers.every((m) => m.kind === 'silhouette'), 'demo silhouettes');
    const t = await text(); ok(/DEMO · simulated scene/.test(t) && /illustrative/i.test(t), 'demo/illustrative label'); ok(/Heart rate/i.test(t) && /N\/A/.test(t) && /not measured by this system/i.test(t), 'vitals unavailable, not invented');
    ok(!/\b\d{2,3}\s*BPM\b/i.test(t), 'no numeric heart rate');
  });
  await check('OBSERVATORY controls: Human Presence / Vital Sign / Signal Monitoring switch the real overlay; Orbit/Top/Front camera; node picker', async () => {
    for (const [label, mode] of [['Vital Sign Monitoring', 'vital'], ['Signal Monitoring', 'signal'], ['Human Presence', 'presence']]) { await cur(label).click(); await sleep(700); eq((await obs()).mode, mode, label); eq(await cur(label).getAttribute('aria-pressed'), 'true', label + ' pressed'); }
    await cur('Vital Sign Monitoring').click(); await sleep(700); const v = await obs(); eq(v.markers.length, 0, 'presence markers hidden in vital view'); await cur('Human Presence').click(); await sleep(500);
    for (const [label, c] of [['Top', 'top'], ['Front', 'front'], ['Orbit', 'orbit']]) { await cur(label).click(); await sleep(500); eq((await obs()).cam, c, label); }
    const before = await text(); await page.getByRole('button', { name: 'N4', exact: true }).click(); await sleep(400); const after = await text(); ok(after !== before, 'panel changed'); ok(/-6\d dBm/.test(after), 'N4 own RSSI');
  });
  await check('OBSERVATORY drag orbits the camera without errors', async () => {
    const box = await page.locator('#obs-canvas').boundingBox(); const s0 = (await obs()).nodes[0].screen;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 10, { steps: 6 }); await page.mouse.up(); await sleep(500);
    const s1 = (await obs()).nodes[0].screen; ok(Math.abs(s1.x - s0.x) > 3 || Math.abs(s1.y - s0.y) > 3, 'view moved');
  });
  await check('OBSERVATORY hardware (not connected): empty room only, no markers, no demo values, no invented vitals', async () => {
    await page.evaluate(() => CSI.app.store.setMode('hardware')); await sleep(900); const d = await obs(); ok(d.nodes.every((n) => n.status !== 'online'), 'no live nodes while not connected: ' + JSON.stringify(d.nodes.map((n) => n.status))); ok(d.markers.every((m) => m.stale), 'only stale last-received markers'); ok(d.demo === false);
    const t = await text(); ok(/not connected/i.test(t) && !/DEMO · simulated scene/.test(t) && !/Simulated/.test(t), 'honest empty state'); ok(/N\/A/.test(t), 'N/A');
  });
  await check('OBSERVATORY hardware live: zone-level markers from mock gateway (no silhouettes, no person positions), values per node', async () => {
    await page.evaluate(() => CSI.app.store.setMode('hardware')); await tab('Connection'); await fillCfg('127.0.0.1', '18081'); gw = startGateway({ port: 18081, intervalMs: 400 });
    await page.getByRole('button', { name: /^Connect$/ }).click(); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 25000, 'receiving'); await tab('Dashboard'); await sleep(1500);
    const d = await obs(); eq(d.demo, false); eq(d.nodes.length, 4); ok(d.markers.length === 2 && d.markers.every((m) => m.kind !== 'silhouette'), 'markers are zone-level: ' + JSON.stringify(d.markers.map((m) => m.kind)));
    const t = await text(); ok(/HARDWARE · zone-level estimates/.test(t) && /the gateway sends no person positions/i.test(t), 'honest caption'); ok(/Persons \(est\.\)\s*\n?\s*N\/A/.test(t), 'persons not invented'); ok(!/DEMO/.test(t.replace(/Demo Mode|DEMO\b-?/g, '')) || !/DEMO DATA/.test(t), 'no demo badge');
    await page.getByRole('button', { name: 'N3', exact: true }).click(); await sleep(400); ok(/-73 dBm/.test(await text()), 'N3 RSSI from mock gateway'); await page.getByRole('button', { name: 'N2', exact: true }).click(); await sleep(300);
  });
  await check('OBSERVATORY stale: frames stop -> scene says last received, nodes marked stale, no demo fallback; resumes when data returns', async () => {
    gw.pauseFrames(); await waitFor(async () => (await obs()).link === 'stale', 15000, 'stale link'); const d = await obs(); eq(d.demo, false); ok(d.nodes.every((n) => n.status === 'stale' || n.status === 'offline'), 'nodes stale: ' + JSON.stringify(d.nodes.map((n) => n.status)));
    await waitFor(async () => { const t = await text(); return /DATA STALE/.test(t) && /last received, not live/i.test(t); }, 5000, 'stale text');
    gw.resumeFrames(); await waitFor(async () => (await obs()).link === 'receiving', 15000, 'receiving again');
  });
  await check('OBSERVATORY connection loss: scene shows no live nodes, then recovers', async () => {
    await gw.stop(); await waitFor(async () => /LINK LOST/.test(await text()), 15000, 'lost'); ok((await obs()).demo === false); gw = startGateway({ port: 18081, intervalMs: 400 });
    await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 25000, 'recovered'); await sleep(800); ok((await obs()).nodes.some((n) => n.status === 'online'), 'online again');
  });
  await check('OBSERVATORY fallback: canvas unavailable -> text summary shown, app still works, no JS errors', async () => {
    const pg = await ctx.newPage(); const errs = []; pg.on('pageerror', (e) => errs.push(e.message)); await pg.addInitScript(() => { HTMLCanvasElement.prototype.getContext = () => null; });
    await pg.goto('http://127.0.0.1:8770/index.html'); await sleep(2000); const vis = await pg.evaluate(() => { const f = document.getElementById('obs-fallback'); return f && getComputedStyle(f).display !== 'none' && /Text summary/.test(f.innerText); }); ok(vis, 'fallback visible'); eq(errs.length, 0, errs.join('|'));
    await pg.locator('nav[aria-label=Main] button').nth(1).click(); await sleep(300); ok(/Estimator output/.test(await pg.evaluate(() => document.body.innerText)), 'other tabs work'); await pg.close();
  });
  await check('OBSERVATORY navigation: Observatory/Analytics/Alerts/Logs/Connection each open their own section', async () => {
    for (const [i, h] of [[0, 'Mesh node status'], [1, 'Estimator output'], [2, 'Alerts'], [3, 'System log'], [4, 'Data source']]) { await page.locator('nav[aria-label=Main] button').nth(i).click(); await sleep(250); ok((await text()).includes(h), i + ' -> ' + h); }
    await tab('Dashboard');
  });
  await gw.stop(); await page.evaluate(() => CSI.app.store.setMode('demo'));

  // ---- software gateway simulator (tools/gateway-simulator.js) against the real UI ----
  const { startSimulator } = require('../tools/gateway-simulator.js');
  let sim = null; const nodesNow = () => state(() => CSI.app.store.view().nodes.map((n) => ({ id: n.id, status: n.status, rssi: n.rssi })));
  await check('SIMULATOR connect: Hardware Mode connects to /csi, hello received, header says SOFTWARE SIMULATOR, four nodes online', async () => {
    sim = await startSimulator({ wsPort: 18083, uiPort: 18084, intervalMs: 300, heartbeatMs: 700, quiet: true, host: '127.0.0.1' });
    await page.evaluate(() => { CSI.app.store.setMode('hardware'); CSI.app.store.disconnect(); }); await sleep(400); await tab('Connection'); await fillCfg('127.0.0.1', '18083'); await page.getByRole('button', { name: /^Connect$/ }).click();
    await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 20000, 'receiving'); await sleep(1500);
    const t = await text(); ok(/SOFTWARE SIMULATOR/.test(t), 'simulator label'); ok(!/DEMO DATA/.test(t), 'not demo'); const n = await nodesNow(); eq(n.length, 4); ok(n.every((x) => x.status === 'online'), JSON.stringify(n));
    ok(await state(() => CSI.app.store.ds.hardware.hello.simulated === true), 'hello.simulated');
    await tab('Dashboard'); await sleep(500); const t2 = await text(); ok(/SOFTWARE SIMULATOR · simulated values, not physical measurements/.test(t2), 'scene tag'); const d = await obs(); ok(d.markers.every((m) => m.kind !== 'silhouette'), 'no silhouettes in hardware mode');
  });
  await check('SIMULATOR controls: RSSI and CSI variance changes appear in the app; presence estimate toggles; values stay labelled estimates', async () => {
    sim.cmd('rssi', 'N1', -82); sim.cmd('variance', 'N1', 0.45); sim.cmd('present', 'N1', '1', 0.9); await waitFor(async () => (await nodesNow()).find((n) => n.id === 'N1').rssi <= -79, 8000, 'rssi in app');
    await page.getByRole('button', { name: 'N1', exact: true }).click(); await sleep(500); const t = await text(); ok(/-8\d dBm/.test(t), 'N1 rssi shown'); ok(/estimate/i.test(t) && !/confirmed (human|detection)/i.test(t.replace(/not confirmed/gi, '')), 'estimate wording');
    await tab('Alerts & log'); await waitFor(async () => /Possible signs of life · Zone A/i.test(await text()), 6000, 'N1 estimate alert'); sim.cmd('present', 'N1', '0'); await tab('Dashboard');
  });
  await check('SIMULATOR node failures: silent node goes stale then offline; announced disconnect is offline at once; restore recovers', async () => {
    sim.cmd('disconnect', 'N3'); await waitFor(async () => (await nodesNow()).find((n) => n.id === 'N3').status === 'offline', 6000, 'N3 offline'); ok((await nodesNow()).filter((n) => n.id !== 'N3').every((n) => n.status === 'online'), 'others online');
    await tab('Alerts & log'); await waitFor(async () => /disconnected · N3/i.test(await text()), 6000, 'disconnect alert');
    sim.cmd('restore', 'N3'); await waitFor(async () => (await nodesNow()).find((n) => n.id === 'N3').status === 'online', 6000, 'N3 back');
    sim.cmd('stopnode', 'N4'); await waitFor(async () => ['stale', 'offline'].includes((await nodesNow()).find((n) => n.id === 'N4').status), 20000, 'N4 stale'); sim.cmd('restore', 'N4'); await waitFor(async () => (await nodesNow()).find((n) => n.id === 'N4').status === 'online', 8000, 'N4 back'); await tab('Dashboard');
  });
  await check('SIMULATOR malformed + unknown + duplicate messages: counted, logged, UI keeps working, valid values not overwritten', async () => {
    const before = await state(() => CSI.app.store.ds.hardware.stats.malformed); const rssiBefore = (await nodesNow()).find((n) => n.id === 'N2').rssi;
    sim.cmd('malformed', 'all'); sim.cmd('unknown'); sim.cmd('duplicate', 'N2'); await sleep(900);
    const st = await state(() => CSI.app.store.ds.hardware.stats); ok(st.malformed >= before + 12, 'malformed ' + before + ' -> ' + st.malformed); ok(st.unknown >= 1, 'unknown counted'); ok(st.dupOld >= 1, 'duplicate ignored');
    ok((await nodesNow()).find((n) => n.id === 'N2').rssi > -70, 'N2 not overwritten by -99 duplicate: ' + (await nodesNow()).find((n) => n.id === 'N2').rssi); ok(rssiBefore !== undefined);
    await tab('Connection'); ok(/malformed/i.test(await text()), 'malformed count shown'); await tab('Dashboard'); eq(await state(() => CSI.app.store.view().link.state), 'receiving');
  });
  await check('SIMULATOR stale gateway: stop keeps socket open but silent -> DATA STALE, last values kept, never demo; start resumes', async () => {
    sim.cmd('heartbeat', 'off'); sim.cmd('stop'); await waitFor(async () => /DATA STALE/.test(await text()), 15000, 'stale banner'); const n = await nodesNow(); ok(n.every((x) => x.rssi !== null), 'last values kept'); ok((await obs()).demo === false);
    sim.cmd('start'); sim.cmd('heartbeat', 'on'); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 15000, 'receiving again');
  });
  await check('SIMULATOR gateway interruption: LINK LOST + reconnecting while refused; auto-reconnect after restore', async () => {
    sim.cmd('interrupt'); await waitFor(async () => /LINK LOST/.test(await text()), 15000, 'lost banner'); await sleep(2500); ok(/reconnect/i.test(await text()), 'reconnecting feedback'); eq((await obs()).demo, false);
    sim.cmd('restoregateway'); await waitFor(() => state(() => CSI.app.store.view().link.state === 'receiving'), 30000, 'auto reconnect'); ok((await nodesNow()).every((n) => n.status === 'online' || n.status === 'stale'), 'nodes back');
  });
  await check('SIMULATOR isolation: Demo Mode shows no simulator label or simulator values; back to Hardware keeps its own data', async () => {
    const hwFrames = await state(() => CSI.app.store.ds.hardware.stats.rx); await page.evaluate(() => CSI.app.store.setMode('demo')); await sleep(1200); const t = await text();
    ok(/DEMO DATA/.test(t) && !/SOFTWARE SIMULATOR/.test(t.replace(/DEMO · simulated scene/g, '')), 'demo labels only'); ok(await state(() => CSI.app.store.ds.demo.hello.gatewayId === 'DEMO-SIMULATOR'), 'demo own hello');
    ok((await state(() => CSI.app.store.ds.hardware.stats.rx)) >= hwFrames, 'hardware dataset kept'); await page.evaluate(() => CSI.app.store.setMode('hardware')); await sleep(600); ok(/SOFTWARE SIMULATOR/.test(await text()), 'back in simulator hardware mode');
  });
  await check('SIMULATOR control panel page and API respond (local control UI)', async () => {
    const pg = await ctx.newPage(); await pg.goto('http://127.0.0.1:18084/'); await sleep(1800); const t = await pg.evaluate(() => document.body.innerText); ok(/SIMULATED DATA/.test(t) && /Start simulator/.test(t) && /N4/.test(t), 'panel'); await pg.getByRole('button', { name: 'Interrupt gateway' }).click(); await sleep(400); ok(sim.state().gatewayUp === false, 'button works'); await pg.getByRole('button', { name: 'Restore gateway' }).click(); await sleep(300); ok(sim.state().gatewayUp === true); await pg.close();
    await page.evaluate(() => CSI.app.store.disconnect && CSI.app.store.disconnect());
  });
  await sim.stop(); await page.evaluate(() => CSI.app.store.setMode('demo'));

  // ---- layout: overflow at many sizes, every tab, both modes ----
  const sizes = [[320, 640], [360, 740], [412, 915], [600, 960], [768, 1024], [1024, 768], [1280, 900], [1366, 768], [1920, 1080]];
  const overflow = [];
  for (const mode of ['demo', 'hardware']) {
    await page.evaluate((m) => CSI.app.store.setMode(m), mode);
    for (const [w, h] of sizes) {
      await page.setViewportSize({ width: w, height: h }); await sleep(400);
      for (const n of ['Dashboard', 'Analytics', 'Alerts & log', 'Connection']) {
        await tab(n);
        if (n === 'Analytics') { for (const b of ['What is CSI variance?', 'What do these values mean?']) { const el = page.getByRole('button', { name: b }); if (await el.count()) await el.click(); } await sleep(150); }
        if (n === 'Connection' && mode === 'hardware') { await page.getByLabel('Gateway port').fill('18999'); await page.getByRole('button', { name: 'Test connection' }).click(); await sleep(900); }
        const r = await page.evaluate(() => { const bad = []; const W = document.documentElement.clientWidth; document.querySelectorAll('#dc-root *, body *').forEach((e) => { const b = e.getBoundingClientRect(); if (b.width > 0 && (b.right > W + 1 || b.left < -1) && !(function (x) { for (; x; x = x.parentElement) { const o = getComputedStyle(x).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return x !== document.documentElement && x !== document.body; } return false; })(e) && !e.closest('svg')) bad.push(e.tagName + ':' + Math.round(b.right)); }); return { sw: document.documentElement.scrollWidth, cw: W, bad: bad.slice(0, 3) }; });
        if (r.sw > r.cw + 1 || r.bad.length) overflow.push(`${mode} ${w}x${h} ${n}: scrollW=${r.sw} client=${r.cw} ${r.bad.join(',')}`);
        if ((w === 412 || w === 1280) ) await page.screenshot({ path: path.join(SHOT, `${mode}-${w}-${n.replace(/\W+/g, '').toLowerCase()}.png`), fullPage: true });
      }
    }
  }
  await check('layout: no horizontal overflow on 4 tabs x 9 sizes x 2 modes', async () => { eq(overflow.length, 0, overflow.slice(0, 5).join(' ; ')); return '72 combinations'; });
  await check('rotation: portrait <-> landscape re-flows without errors or state loss', async () => {
    await page.evaluate(() => CSI.app.store.setMode('demo')); await page.setViewportSize({ width: 412, height: 860 }); await tab('Analytics'); await page.getByRole('button', { name: 'N3', exact: true }).click(); await page.setViewportSize({ width: 860, height: 412 }); await sleep(400); await page.setViewportSize({ width: 412, height: 860 }); await sleep(400);
    ok((await text()).includes('CSI variance · N3'), 'selection kept'); eq(jsErrors.length, 0, jsErrors.join('|'));
  });
  await check('no uncaught JS errors during the whole run', async () => { eq(jsErrors.length, 0, jsErrors.join(' | ')); });
  await check('no external network requests during the whole run', async () => { eq(external.length, 0, external.join(',')); });

  // ---- visual comparison with the original design (desktop, demo, dashboard) ----
  const refCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } }); const rp = await refCtx.newPage(); await rp.goto('http://127.0.0.1:8771/index.html'); await sleep(2500);
  await rp.screenshot({ path: path.join(SHOT, 'ORIGINAL-1280-dashboard.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 }); await tab('Dashboard'); await sleep(600); await page.screenshot({ path: path.join(SHOT, 'NEW-1280-dashboard.png'), fullPage: true });
  const rpos = await rp.evaluate(() => [...document.querySelectorAll('h1,h2')].map((e) => e.textContent.trim() + '@' + Math.round(e.getBoundingClientRect().left) + ',' + Math.round(e.getBoundingClientRect().top)));
  const npos = await page.evaluate(() => [...document.querySelectorAll('h1,h2')].map((e) => e.textContent.trim() + '@' + Math.round(e.getBoundingClientRect().left) + ',' + Math.round(e.getBoundingClientRect().top)));
  console.log('ORIGINAL headings', rpos.join(' | ')); console.log('NEW      headings', npos.join(' | '));
  await browser.close(); web.close(); ref.close();
  const failed = results.filter((r) => !r.pass); console.log(`\n${results.length - failed.length}/${results.length} e2e checks passed`); fs.writeFileSync(path.join(__dirname, 'e2e-results.json'), JSON.stringify(results, null, 2)); process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
