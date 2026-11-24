// Android-WebView SIMULATION (NOT a real WebView): Chromium serves the app from the same origin the
// WebViewAssetLoader uses, with a fake window.AndroidBridge that records calls, plus phone UA/touch.
// It proves the JS side of the bridge contract; it cannot prove that Java, WebView or the APK work.
const fs = require('fs'), path = require('path');
const { chromium } = require('playwright');
const { startGateway } = require('../tools/mock-gateway.js');
const WWW = path.join(__dirname, '../app/src/main/assets'); // = Android assets/ root, like AssetsPathHandler("/assets/")
const ORIGIN = 'http://appassets.androidplatform.net';
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.woff2': 'font/woff2' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function check(n, f) { try { const d = await f(); pass++; console.log('PASS', n, d || ''); } catch (e) { fail++; console.log('FAIL', n, '-', e.message); } }
const ok = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
(async () => {
  const gw = await startGateway({ port: 8791, intervalMs: 200 });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6,
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 6 Build/TQ3A) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36' });
  const blocked = [], served = [];
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.host === 'appassets.androidplatform.net') {
      const rel = u.pathname.replace(/^\/assets\//, ''); const f = path.join(WWW, rel);
      if (!f.startsWith(WWW) || !fs.existsSync(f)) { blocked.push('404 ' + u.pathname); return r.fulfill({ status: 404, body: '' }); }
      served.push(u.pathname); return r.fulfill({ status: 200, headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }, body: fs.readFileSync(f) });
    }
    blocked.push(u.href); return r.fulfill({ status: 403, body: '' }); // mirrors MainActivity.shouldInterceptRequest
  });
  await ctx.addInitScript(() => {
    window.__bridge = { notify: [], share: [], shareOk: true };
    window.AndroidBridge = { notify: (t, x) => window.__bridge.notify.push([t, x]), shareFile: (n, m, c) => { window.__bridge.share.push({ n, m, c }); return window.__bridge.shareOk; } };
  });
  const page = await ctx.newPage(); const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(ORIGIN + '/assets/www/index.html'); await sleep(2500);
  const text = () => page.evaluate(() => document.body.innerText);
  const tab = async (n) => { await page.getByRole('button', { name: n, exact: true }).first().click(); await sleep(250); };

  await check('loads from the WebViewAssetLoader-style origin; all assets served; nothing external requested', async () => {
    ok((await text()).includes('Live through-wall view'), 'rendered'); ok(errs.length === 0, errs.join('|')); ok(blocked.length === 0, blocked.join(','));
    for (const f of ['index.html', 'csi-store.js', 'csi-transport.js', 'inter-a.woff2']) ok(served.some((s) => s.endsWith(f)), f + ' not served');
    return served.length + ' files';
  });
  await check('bridge detected (store/app know they are native); no notification in Demo Mode', async () => {
    ok(await page.evaluate(() => CSI.app.native === true)); ok((await page.evaluate(() => __bridge.notify.length)) === 0, 'demo must not notify');
  });
  await check('CSV export in native mode calls AndroidBridge.shareFile with a valid CSV (no browser download)', async () => {
    await tab('Alerts & log');
    await page.getByRole('button', { name: /Export log/ }).click(); await sleep(300);
    const s = await page.evaluate(() => __bridge.share); ok(s.length === 1, 'one share call'); ok(s[0].m === 'text/csv' && /^csi-log-DEMO-\d{8}-\d{6}\.csv$/.test(s[0].n), s[0].n);
    ok(/^[A-Za-z0-9._-]+$/.test(s[0].n), 'filename safe for Java sanitiser'); ok(s[0].c.startsWith('received_at_iso,severity,category,origin,data_source,message\r\n'), 'header'); ok(s[0].c.length < 2 * 1024 * 1024);
    return s[0].n;
  });
  await check('report export (JSON) goes through shareFile with application/json', async () => {
    await tab('Dashboard'); await page.getByRole('button', { name: 'Generate report' }).click(); await sleep(300);
    const s = await page.evaluate(() => __bridge.share[1]); ok(s && s.m === 'application/json'); JSON.parse(s.c);
  });
  await check('failed native share (bridge returns false) is reported to the user, not silent', async () => {
    await page.evaluate(() => { __bridge.shareOk = false; }); await tab('Alerts & log');
    await page.getByRole('button', { name: /Export log/ }).click(); await sleep(300); const t = await text(); ok(/could not|failed|not exported/i.test(t), 'no failure message: ' + (t.match(/Log [^\n]*/) || [''])[0]);
    await page.evaluate(() => { __bridge.shareOk = true; });
  });
  await check('Hardware Mode + mock gateway: telemetry shown; Critical/Warning alerts call notify, Info does not', async () => {
    await tab('Connection'); await page.getByRole('button', { name: 'Hardware Mode' }).click(); await sleep(200);
    await page.evaluate(() => CSI.app.store.connect({ host: '127.0.0.1', port: '8791', path: '/csi' })); await sleep(4000);
    const n = await page.evaluate(() => __bridge.notify); ok(n.length >= 1, 'no notifications'); ok(n.every((x) => /^(CRITICAL|WARNING) ·/.test(x[0])), JSON.stringify(n.map((x) => x[0])));
    ok(n.some((x) => /estimate|unvalidated/i.test(x[1])) || n.length > 0);
    const d = await page.evaluate(() => CSI.app.store.view().stats.frames); ok(d > 5, 'frames ' + d);
  });
  await check('hardware CSV export labelled HARDWARE via bridge', async () => {
    await tab('Alerts & log'); await page.getByRole('button', { name: /Export log/ }).click(); await sleep(300);
    const s = await page.evaluate(() => __bridge.share.slice(-1)[0]); ok(/csi-log-HW-/.test(s.n) && /,HARDWARE,/.test(s.c), s.n);
  });
  await check('settings persisted under the app origin (localStorage) and survive a new page (restart)', async () => {
    const p2 = await ctx.newPage(); await p2.goto(ORIGIN + '/assets/www/index.html'); await sleep(1800);
    const cfg = await p2.evaluate(() => CSI.app.store.settings); ok(cfg.mode === 'hardware' && cfg.config.host === '127.0.0.1' && cfg.config.port === '8791', JSON.stringify(cfg)); await p2.close();
  });
  await check('lifecycle: setVisible(false) (onPause) stops socket; setVisible(true) (onResume) reconnects', async () => {
    await page.evaluate(() => CSI.app.store.setVisible(false)); await sleep(800);
    const a = await page.evaluate(() => CSI.app.store.view().link.state); ok(a !== 'receiving', 'state while paused: ' + a);
    await page.evaluate(() => CSI.app.store.setVisible(true)); await sleep(3500);
    const b = await page.evaluate(() => CSI.app.store.view().link.state); ok(b === 'receiving', 'state after resume: ' + b);
  });
  await check('Android back: handler returns true from sub-tab, false on dashboard (Java then finishes the activity)', async () => {
    await tab('Connection'); ok(await page.evaluate(() => window.CSI_onBack() === true)); await sleep(250); ok((await text()).includes('Mesh node status')); ok(await page.evaluate(() => window.CSI_onBack() === false));
  });
  await check('rotation: portrait -> landscape -> portrait keeps state and has no horizontal overflow', async () => {
    for (const [w, h] of [[860, 412], [412, 860]]) { await page.setViewportSize({ width: w, height: h }); await sleep(400); const m = await page.evaluate(() => [document.documentElement.scrollWidth, innerWidth]); ok(m[0] <= m[1] + 1, 'overflow at ' + w + ': ' + m.join('>')); }
    ok(await page.evaluate(() => CSI.app.store.view().link.state === 'receiving'));
  });
  await check('no JS errors during the whole run', async () => { ok(errs.length === 0, errs.join('|')); });
  await browser.close(); await gw.stop();
  console.log(`${pass}/${pass + fail} android-sim checks passed`); process.exit(fail ? 1 : 0);
})();
