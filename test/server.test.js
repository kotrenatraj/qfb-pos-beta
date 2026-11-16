'use strict';
// Server API tests. Run: node test/server.test.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfb-')), PORT = 3600 + Math.floor(Math.random() * 300), BASE = 'http://127.0.0.1:' + PORT;
let proc, fails = 0, cookie = '';
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
const call = async (method, p, body, o = {}) => {
  const h = Object.assign({ 'x-qfb': '1' }, o.headers || {}); if (cookie && !o.nocookie) h.cookie = cookie;
  if (body !== undefined && !(body instanceof Buffer)) h['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : (body instanceof Buffer ? body : JSON.stringify(body)) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = null; }
  return { s: r.status, j, t, h: r.headers };
};
const start = () => new Promise((res, rej) => {
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT, QFB_PASSWORD: 'pw123', DATA_DIR: DIR, HOST: '127.0.0.1' }) });
  proc.stdout.on('data', d => { if (/listening/.test(d)) res(); }); proc.stderr.on('data', d => process.stderr.write(d)); proc.on('exit', c => { if (c) rej(new Error('server exited ' + c)); });
});
const stop = () => new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); });
const mkInv = no => ({ no, date: new Date().toISOString(), customer: { name: 'Acme', phone: '', gstin: '' }, items: [{ name: 'Dosa', price: 80, qty: 1, gst: 5, taxable: 80, tax: 4, amount: 84 }], inclusive: false, rates: [{ rate: 5, taxable: 80, cgst: 2, sgst: 2 }], taxable: 80, cgst: 2, sgst: 2, tax: 4, roundoff: 0, total: 84, paper: '80', co: {} });

(async () => {
  await start();
  let r = await call('GET', '/api/ping', undefined, { nocookie: 1 });
  ok(r.j.qfb === 1 && r.j.auth === true && r.j.authed === false, 'ping works without login and says login is needed');
  r = await call('GET', '/api/state', undefined, { nocookie: 1 }); ok(r.s === 401, 'state needs login (401)');
  r = await call('POST', '/api/login', { password: 'wrong' }); ok(r.s === 401, 'wrong password rejected');
  r = await call('POST', '/api/login', { password: 'pw123' }); ok(r.s === 200, 'right password accepted');
  const sc = r.h.get('set-cookie'); ok(/HttpOnly/.test(sc) && /SameSite=Lax/.test(sc), 'session cookie is HttpOnly + SameSite'); cookie = sc.split(';')[0];
  r = await call('POST', '/api/menu/batch', { upsert: [] }, { headers: { 'x-qfb': '0' } }); ok(r.s === 403, 'writes without the app header are refused (CSRF guard)');
  r = await call('GET', '/api/state'); ok(r.s === 200 && r.j.menu.length === 8 && r.j.invoices.length === 0 && r.j.settings.prefix === 'INV-', 'first run: 8 sample menu items, no invoices, default settings');
  const rev0 = r.j.rev;

  // atomic numbering under concurrency
  const nums = await Promise.all(Array.from({ length: 40 }, () => call('POST', '/api/invoices/reserve', {})));
  const set = new Set(nums.map(x => x.j.no)); ok(set.size === 40 && set.has('INV-0001') && set.has('INV-0040'), '40 parallel reservations give 40 different, gap-free invoice numbers');
  r = await call('GET', '/api/state'); ok(r.j.settings.nextNo === 41, 'next number advanced to 41');
  // create, update, stale
  r = await call('POST', '/api/invoices', { inv: mkInv('INV-0001') }); ok(r.s === 200 && r.j.v === 1, 'invoice created (version 1)');
  r = await call('POST', '/api/invoices', { inv: mkInv('INV-0001') }); ok(r.s === 409, 'creating the same invoice number twice is refused');
  r = await call('POST', '/api/invoices', { inv: { no: 'X', items: [] } }); ok(r.s === 400, 'malformed invoice refused');
  let inv = mkInv('INV-0001'); inv.total = 99; inv.history = [{ action: 'edited', reason: 'test' }];
  r = await call('PUT', '/api/invoices/INV-0001', { inv, baseV: 1 }); ok(r.s === 200 && r.j.v === 2, 'edit with correct version accepted (version 2)');
  r = await call('PUT', '/api/invoices/INV-0001', { inv, baseV: 1 }); ok(r.s === 409 && r.j.code === 'stale' && r.j.current.total === 99, 'edit from an outdated copy is refused with the current copy');
  r = await call('PUT', '/api/invoices/INV-0001', { inv: mkInv('INV-0002'), baseV: 2 }); ok(r.s === 400, 'invoice number cannot be changed by an edit');
  r = await call('PUT', '/api/invoices/NOPE', { inv: mkInv('NOPE'), baseV: 1 }); ok(r.s === 404, 'editing a missing invoice gives 404');
  // menu
  r = await call('GET', '/api/state'); const m0 = r.j.menu[0];
  r = await call('POST', '/api/menu/batch', { upsert: [{ id: 'new1', name: 'Lassi', price: 45, gst: 5, cat: 'Beverages', hsn: '996331' }, Object.assign({}, m0, { price: 99 })], remove: [r.j.menu[1].id] });
  ok(r.s === 200, 'menu batch accepted'); r = await call('GET', '/api/state');
  ok(r.j.menu.length === 8 && r.j.menu[0].price === 99 && r.j.menu.some(x => x.name === 'Lassi') && r.j.menu[0].id === m0.id, 'menu: added Lassi, updated price in place, removed one');
  r = await call('POST', '/api/menu/batch', { upsert: [{ id: 'z', name: '', price: 1 }] }); ok(r.s === 400, 'menu item without a name refused');
  r = await call('POST', '/api/menu/batch', { upsert: [{ id: 'z', name: 'X', price: -5 }] }); ok(r.s === 400, 'negative price refused');
  // settings patch only touches what is sent
  r = await call('PATCH', '/api/settings', { patch: { company: 'QFB', phone: '080 1234', alertPhone: '98765', bogus: 'x' } }); ok(r.s === 200, 'settings patch accepted');
  r = await call('GET', '/api/state'); ok(r.j.settings.company === 'QFB' && r.j.settings.nextNo === 41 && !('bogus' in r.j.settings), 'settings patch keeps the server-owned invoice counter and ignores unknown keys');
  r = await call('PATCH', '/api/settings', { patch: { nextNo: 0 } }); ok(r.s === 400, 'invalid counter value refused');
  // summaries
  const sreq = { key: 'acme||2026-11-01|2026-11-16', sig: 'INV-0001:99', name: 'Acme', gstin: '', a: '2026-11-01', b: '2026-11-16', n: 1, total: 99 };
  const ss = await Promise.all([1, 2, 3, 4, 5].map(() => call('POST', '/api/summaries/issue', sreq)));
  ok(new Set(ss.map(x => x.j.entry.no)).size === 1 && ss[0].j.entry.no === 'SI-0001', 'same summary asked 5 times at once gets one number (SI-0001)');
  r = await call('POST', '/api/summaries/issue', Object.assign({}, sreq, { sig: 'INV-0001:99,INV-0002:50', n: 2 }));
  ok(r.j.entry.no === 'SI-0002' && r.j.summaries.find(x => x.no === 'SI-0001').superseded === true, 'changed invoices get a new summary number and supersede the old one');
  // files
  r = await call('PUT', '/api/files/INV-0001.pdf', Buffer.from('%PDF-test')); ok(r.s === 200, 'PDF stored on the server');
  const f = await fetch(BASE + '/files/INV-0001.pdf', { headers: { cookie } }); ok(f.status === 200 && f.headers.get('content-type') === 'application/pdf' && (await f.text()) === '%PDF-test', 'stored PDF downloads back identical');
  r = await call('PUT', '/api/files/' + encodeURIComponent('../evil.pdf'), Buffer.from('x')); ok(r.s === 400 || r.s === 404, 'path traversal in file name refused');
  r = await call('PUT', '/api/files/run.sh', Buffer.from('x')); ok(r.s === 400, 'only pdf / xlsx / csv files allowed');
  const nf = await fetch(BASE + '/files/INV-0001.pdf'); ok(nf.status === 401, 'files need login');
  const lst = await fetch(BASE + '/files', { headers: { cookie } }); ok(lst.status === 200 && /INV-0001\.pdf/.test(await lst.text()), 'file list page shows saved files');
  // app page + headers
  const pg = await fetch(BASE + '/'); const html = await pg.text(); ok(pg.status === 200 && /<title>/.test(html) && /Content-Security-Policy|content-security-policy/i.test([...pg.headers.keys()].join()), 'app page served with security headers');
  // restart keeps everything
  const before = (await call('GET', '/api/state')).j; await stop(); await start();
  r = await call('GET', '/api/state'); ok(r.s === 200 && r.j.invoices.length === 1 && r.j.invoices[0].total === 99 && r.j.invoices[0]._v === 2 && r.j.settings.nextNo === 41 && r.j.menu.length === before.menu.length && r.j.summaries.length === 2, 'after a restart all data is still there (cookie still valid)');
  ok(r.j.rev >= rev0, 'revision counter survives restart');
  // restore
  r = await call('POST', '/api/restore', { settings: { company: 'Restored', nextNo: 7 }, menu: [{ id: 'a', name: 'Tea', price: 10, gst: 5 }], invoices: [mkInv('INV-0001'), mkInv('INV-0002')], summaries: [] });
  ok(r.s === 200, 'backup restore accepted'); r = await call('GET', '/api/state');
  ok(r.j.invoices.length === 2 && r.j.menu.length === 1 && r.j.settings.company === 'Restored' && r.j.settings.nextNo === 7, 'restore replaced the data');
  ok(fs.readdirSync(path.join(DIR, 'backups')).some(d => /^before-restore/.test(d)), 'a safety backup was taken before the restore');
  r = await call('POST', '/api/restore', { settings: {}, menu: [], invoices: [mkInv('A'), mkInv('A')] }); ok(r.s === 400, 'restore with duplicate invoice numbers refused');
  // shard files
  ok(fs.readdirSync(DIR).some(f => /^invoices-0000\.json$/.test(f)), 'invoices stored in shard files');
  // login throttle
  for (let i = 0; i < 11; i++) await call('POST', '/api/login', { password: 'bad' + i }, { nocookie: 1 });
  r = await call('POST', '/api/login', { password: 'pw123' }, { nocookie: 1 }); ok(r.s === 429, 'repeated wrong passwords lock login for a few minutes');
  await stop(); fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nALL SERVER CHECKS PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); try { proc.kill(); } catch (x) {} process.exit(1); });
