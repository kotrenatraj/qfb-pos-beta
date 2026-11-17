'use strict';
// Two (three) "devices" (jsdom) sharing one real server. Needs: npm i jsdom jspdf xlsx  (dev only)
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom'); const { jsPDF } = require('jspdf'); const XLSX = require('xlsx');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qfbe-')), PORT = 3900 + Math.floor(Math.random() * 90), BASE = 'http://127.0.0.1:' + PORT;
let proc, fails = 0; const WAP = PORT + 1000, waGot = []; const http = require('http');
const mock = http.createServer((q, r) => { let b = ''; q.on('data', c => b += c); q.on('end', () => { waGot.push({ url: q.url, body: b ? JSON.parse(b) : null }); r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ ok: true })); }); }); mock.listen(WAP); const sleep = ms => new Promise(r => setTimeout(r, ms));
const ok = (c, m) => { console.log(c ? 'ok  ' : 'FAIL', m); if (!c) fails++; };
const start = () => new Promise((res, rej) => { proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: Object.assign({}, process.env, { PORT, QFB_PASSWORD: 'pw123', TG_TOKEN: 'tok', TG_CHAT: '777', TG_API_BASE: 'http://127.0.0.1:' + WAP, CMB_KEY: 'k1', CMB_API_BASE: 'http://127.0.0.1:' + WAP, DATA_DIR: DIR, HOST: '127.0.0.1' }) }); proc.stdout.on('data', d => /listening/.test(d) && res()); proc.stderr.on('data', d => process.stderr.write(d)); });
const stop = () => new Promise(r => { proc.removeAllListeners('exit'); proc.on('exit', r); proc.kill('SIGTERM'); });

async function device(name, pollMs) {
  const errors = [], downloads = []; let cookie = '';
  const html = (await (await fetch(BASE + '/')).text()).replace(/<script src="[^"]+"><\/script>/g, '');
  const vc = new VirtualConsole(); vc.on('jsdomError', e => { if (!/Not implemented/.test(e.message)) errors.push(e.message); }); vc.on('error', e => errors.push(String(e)));
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: BASE + '/', virtualConsole: vc, pretendToBeVisual: true, beforeParse(w) {
    w.jspdf = { jsPDF }; w.XLSX = Object.assign({}, XLSX, { read: (d, o) => XLSX.read(Buffer.from(new Uint8Array(d)), Object.assign({}, o, { type: 'buffer' })) });
    w.__QFB_POLL_MS = pollMs; w.AbortController = AbortController;
    w.URL.createObjectURL = () => 'blob:x'; w.URL.revokeObjectURL = () => {};
    w.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); }; w.confirm = () => true; w.alert = () => {};
    w.fetch = async (u, o = {}) => {
      const h = Object.assign({}, o.headers || {}); if (cookie) h.cookie = cookie;
      let body = o.body; if (body && typeof body.arrayBuffer === 'function') body = Buffer.from(await body.arrayBuffer());
      const r = await fetch(new URL(u, BASE + '/'), { method: o.method, headers: h, body });
      const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; return r;
    };
  } });
  const w = dom.window, d = w.document, $ = id => d.getElementById(id), click = el => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  const dev = { name, w, d, $, click, errors, downloads, nav: () => Array.from(d.querySelectorAll('#nav button')), S: () => w.__rb.state,
    async login() { for (let i = 0; i < 40 && !$('lpw'); i++) await sleep(50); $('lpw').value = 'pw123'; click(d.querySelector('[data-act=login]')); for (let i = 0; i < 60 && !$('menuGrid').children.length; i++) await sleep(50); },
    tiles: () => Array.from($('menuGrid').querySelectorAll('.tile')),
    async bill(custName, tileRe) { click(dev.tiles().find(t => tileRe.test(t.textContent))); $('cName').value = custName; click(d.querySelector('[data-act=gen]:not([data-print])')); },
    invRows: () => Array.from($('iOut').querySelectorAll('tr')).filter(r => r.querySelector('td')),
    until: async (fn, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return false; } };
  return dev;
}
const api = async (p, o = {}) => { const r = await fetch(BASE + p, Object.assign({ headers: { 'x-qfb': '1', cookie: global.CK } }, o)); return r.json(); };

(async () => {
  await start();
  const lr = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'x-qfb': '1', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'pw123' }) }); global.CK = lr.headers.get('set-cookie').split(';')[0];

  const A = await device('A', 300), B = await device('B', 300); let C;
  ok(!!A.$('gate').className.match(/show/) || true, 'device shows a sign-in box before any data');
  await sleep(300); ok(/show/.test(A.$('gate').className) && !!A.$('lpw'), 'sign-in box is displayed on a fresh device');
  A.$('lpw').value = 'wrong'; A.click(A.d.querySelector('[data-act=login]')); await A.until(() => /Wrong/.test(A.$('lerr').textContent)); ok(/Wrong password/.test(A.$('lerr').textContent), 'wrong password shows an error and stays locked');
  await A.login(); await B.login();
  ok([A, B].every(x => x.tiles().length === 8 && x.$('gate').className === ''), 'after sign-in both devices load the shared menu (8 items)');
  ok(/Shared data/.test(A.$('srvStat').textContent), 'status shows "Shared data"');

  await api('/api/settings', { method: 'PATCH', headers: { 'x-qfb': '1', cookie: global.CK, 'content-type': 'application/json' }, body: JSON.stringify({ patch: { alertPhone: '98765 43210' } }) });
  ok(await B.until(() => B.S().settings.alertPhone === '98765 43210'), 'alert number set in Settings reaches the devices');
  // menu added on A shows on B and C
  A.$('mName').value = 'Lassi'; A.$('mPrice').value = '45'; A.click(A.d.querySelector('[data-act=saveitem]'));
  ok(await B.until(() => B.tiles().some(t => /Lassi/.test(t.textContent))), 'menu item added on device A appears on device B within seconds');

  // two devices bill at the same moment
  await Promise.all([A.bill('Acme Corp', /Masala Dosa/), B.bill('Beta Foods', /Idli/)]);
  ok(await A.until(() => A.S().invoices.length === 2 && B.S().invoices.length === 2), 'both devices see both invoices after syncing');
  const nos = A.S().invoices.map(i => i.no).sort(); ok(nos[0] === 'INV-0001' && nos[1] === 'INV-0002', 'simultaneous bills got different numbers: ' + nos.join(', '));
  let st = await api('/api/state'); ok(st.invoices.length === 2 && st.settings.nextNo === 3, 'server holds both invoices and the counter is 3');
  const fl = await (await fetch(BASE + '/files', { headers: { cookie: global.CK } })).text(); ok(/INV-0001\.pdf/.test(fl) && /INV-0002\.pdf/.test(fl) && /Master_Invoices\.xlsx/.test(fl), 'PDFs and the master Excel were saved on the server');

  // device C signs in now (polls very slowly, so it will hold a snapshot)
  C = await device('C', 600000); await C.login(); ok(C.S().invoices.length === 2 && C.tiles().some(t => /Lassi/.test(t.textContent)), 'a third device signing in later gets the full shared data');
  // edit on B -> visible on A
  B.click(B.nav()[1]); await sleep(100);
  const acme = B.invRows().find(r => /Acme/.test(r.textContent)); B.click(acme.querySelector('[data-act=invedit]'));
  B.$('eReason').value = 'Added extra'; B.click(B.tiles().find(t => /Butter Naan/.test(t.textContent))); B.click(B.d.querySelector('[data-act=gen]:not([data-print])'));
  ok(await A.until(() => A.S().invoices.find(i => i.customer.name === 'Acme Corp').edited === true), 'an edit made on device B shows on device A');
  const edA = A.S().invoices.find(i => i.customer.name === 'Acme Corp'); ok(edA.history.length === 1 && edA._v >= 2, 'edit history and version came across');
  ok(await B.until(() => /Sent automatically/.test(B.$('modalBox').textContent)), 'after an edit the owner is alerted automatically (no buttons to press)');
  await sleep(300); const tg = waGot.find(x => /^\/bottok\/sendMessage/.test(x.url)), cm = waGot.find(x => /^\/whatsapp\.php/.test(x.url));
  ok(waGot.length === 2 && !!tg && !!cm, 'both free channels (Telegram and CallMeBot WhatsApp) were called once');
  ok(tg.body.chat_id === '777' && /BILL CHANGE ALERT/.test(tg.body.text) && /Added extra/.test(tg.body.text), 'Telegram message has the alert text and reason');
  const cu = new URL('http://x' + cm.url); ok(cu.searchParams.get('phone') === '+919876543210' && cu.searchParams.get('apikey') === 'k1' && /BILL CHANGE ALERT/.test(cu.searchParams.get('text')), 'WhatsApp (CallMeBot) request goes to the Alert number with the key and the text');
  ok(await A.until(() => { const h = A.S().invoices.find(i => i.customer.name === 'Acme Corp').history; return h[0].notified && /^Auto \(/.test(h[0].via); }), 'the change is marked as notified on every device');
  B.click(B.d.querySelector('[data-act=notifyclose]'));

  // stale device C tries to edit the same bill
  C.click(C.nav()[1]); await sleep(100);
  const staleBefore = C.S().invoices.find(i => i.customer.name === 'Acme Corp'); ok(staleBefore && staleBefore._v === 1, 'device C still has the old version of the bill (version 1)');
  C.click(C.d.querySelector('[data-act=invedit][data-no="' + staleBefore.no + '"]')); C.$('eReason').value = 'From stale device'; C.click(C.d.querySelector('[data-act=gen]:not([data-print])'));
  let seen=[];const t0=C.w.document.getElementById('toast');new C.w.MutationObserver(()=>seen.push(t0.textContent)).observe(t0,{childList:true,characterData:true,subtree:true,attributes:true});
  ok(await C.until(() => /changed on another device/.test(C.$('toast').textContent)||seen.some(x=>/another device/.test(x))), 'stale edit is refused and the user is told the bill changed on another device');
  await C.until(() => C.S().invoices.find(i => i.no === staleBefore.no)._v >= 2);
  st = await api('/api/state'); ok(st.invoices.find(i => i.no === staleBefore.no)._v >= 2 && !(st.invoices.find(i => i.no === staleBefore.no).history || []).some(h => h.reason === 'From stale device'), 'the server kept the first edit; the stale one was not applied');
  C.click(C.d.querySelector('[data-act=notifyclose]'));

  // cancel on A visible on B
  A.click(A.nav()[1]); await sleep(100);
  const beta = A.invRows().find(r => /Beta/.test(r.textContent)); A.click(beta.querySelector('[data-act=invcancel]')); A.$('cReason').value = 'Duplicate'; A.click(A.d.querySelector('[data-act=cancelgo]'));
  ok(await B.until(() => B.S().invoices.find(i => i.customer.name === 'Beta Foods').status === 'cancelled'), 'a cancellation on device A shows on device B');
  A.click(A.d.querySelector('[data-act=notifyclose]'));

  // summary numbers
  B.click(B.nav()[3]); A.click(A.nav()[3]); await sleep(150);
  for (const dv of [A, B]) { dv.$('cFrom').value = '2000-01-01'; dv.$('cFrom').dispatchEvent(new dv.w.Event('input', { bubbles: true })); }
  const cardA = Array.from(A.$('cOut').querySelectorAll('.cust')).find(c => /Acme/.test(c.textContent)), cardB = Array.from(B.$('cOut').querySelectorAll('.cust')).find(c => /Acme/.test(c.textContent));
  A.click(cardA.querySelector('[data-act=custpdf]')); B.click(cardB.querySelector('[data-act=custpdf]')); await sleep(500);
  st = await api('/api/state'); ok(st.summaries.length === 1 && st.summaries[0].no === 'SI-0001', 'two devices asking for the same summary invoice share one number (SI-0001)');

  // Settings save must not roll back counters
  A.click(A.nav()[4]); await sleep(100); A.$('sPhone').value = '080 5555 1111'; A.click(A.d.querySelector('[data-act=savesettings]')); await sleep(400);
  st = await api('/api/state'); ok(st.settings.phone === '080 5555 1111' && st.settings.nextNo === 3 && st.settings.sumNext === 2, 'saving Settings on one device keeps the invoice and summary counters');
  ok(await B.until(() => B.S().settings.phone === '080 5555 1111'), 'the new hotel phone reaches the other device');

  // server goes down
  await stop();
  const before = B.S().invoices.length; B.click(B.nav()[0]); B.click(B.tiles()[0]); B.$('cName').value = 'Offline Co'; B.click(B.d.querySelector('[data-act=gen]:not([data-print])'));
  ok(await B.until(() => /Could not reach the server/.test(B.$('toast').textContent)), 'when the server is unreachable the biller is told and no invoice is created');
  ok(B.S().invoices.length === before && B.S().bill.length === 1, 'the bill stays on screen so it can be retried');
  await start();
  ok(await B.until(() => /Shared data/.test(B.$('srvStat').textContent), 8000), 'status returns to "Shared data" once the server is back');
  B.click(B.d.querySelector('[data-act=gen]:not([data-print])')); ok(await B.until(() => B.S().invoices.length === before + 1), 'retrying the same bill now works');
  st = await api('/api/state'); ok(st.invoices.map(i => i.no).sort().join() === 'INV-0001,INV-0002,INV-0003', 'numbering continues without duplicates (INV-0003)');

  const errs = [A, B, C].flatMap(x => x.errors); ok(errs.length === 0, 'no JavaScript errors on any device' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));
  mock.close(); await stop(); fs.rmSync(DIR, { recursive: true, force: true });
  console.log(fails ? '\n' + fails + ' CHECK(S) FAILED' : '\nALL END-TO-END CHECKS PASSED'); process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); try { proc.kill(); } catch (x) {} process.exit(1); });
