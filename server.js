'use strict';
/*
 * QFB POS server: serves the billing app and keeps ONE shared set of data for every device.
 * No npm packages needed (Node 18+). Run:  QFB_PASSWORD=yourpassword node server.js
 */
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');

const PORT = +process.env.PORT || 3000;
const PASSWORD = process.env.QFB_PASSWORD || '';
const HOST = process.env.HOST || (PASSWORD ? '0.0.0.0' : '127.0.0.1');
const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const FILES = path.join(DATA, 'files'), BACKUPS = path.join(DATA, 'backups');
const INDEX = path.join(__dirname, 'restaurant-billing.html');
const VENDOR = path.join(__dirname, 'vendor');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SHARD = 500;                       // invoices per storage file
const MAX_JSON = 12 * 1024 * 1024, MAX_FILE = 40 * 1024 * 1024;

if (!PASSWORD && process.env.QFB_ALLOW_NO_PASSWORD !== '1' && HOST !== '127.0.0.1' && HOST !== 'localhost') {
  console.error('Refusing to listen on a network address without QFB_PASSWORD. Set QFB_PASSWORD=...'); process.exit(1);
}
[DATA, FILES, BACKUPS].forEach(d => fs.mkdirSync(d, { recursive: true }));

/* ---------------- storage ---------------- */
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return def; throw new Error('Cannot read ' + f + ': ' + e.message); } }
function writeJson(f, obj) { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(obj)); fs.renameSync(t, f); }
const P = n => path.join(DATA, n);

const DEFAULTS = { company: '', address: '', phone: '', alertPhone: '', email: '', gstin: '', fssai: '', state: '', prefix: 'INV-', nextNo: 1, sumPrefix: 'SI-', sumNext: 1, paper: '80', inclusive: false, defGst: 5, seal: '', sign: '', imgClean: false, folderName: '' };
const SAMPLE = [['Masala Dosa', 'South Indian', 80], ['Idli (2 pcs)', 'South Indian', 50], ['Paneer Butter Masala', 'Main Course', 220], ['Butter Naan', 'Breads', 40], ['Veg Biryani', 'Rice', 180], ['Chicken Biryani', 'Rice', 240], ['Masala Chai', 'Beverages', 20], ['Cold Coffee', 'Beverages', 90]];
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');

const meta = readJson(P('meta.json'), { rev: 0, invSeq: 0 });
const db = {
  settings: Object.assign({}, DEFAULTS, readJson(P('settings.json'), {})),
  menu: readJson(P('menu.json'), null),
  summaries: readJson(P('summaries.json'), []),
  invoices: []
};
if (!db.menu) { db.menu = SAMPLE.map(x => ({ id: uid(), name: x[0], cat: x[1], price: x[2], gst: 5, hsn: '996331', img: '' })); writeJson(P('menu.json'), db.menu); }
for (const f of fs.readdirSync(DATA).filter(f => /^invoices-\d+\.json$/.test(f)).sort()) db.invoices.push(...readJson(P(f), []));
db.invoices.sort((a, b) => (a._n || 0) - (b._n || 0));
const invIndex = new Map(db.invoices.map(i => [i.no, i]));
meta.invSeq = Math.max(meta.invSeq || 0, ...db.invoices.map(i => i._n || 0), 0);

function persist(what) {
  dailyBackup();                         // first change of the day: snapshot before writing
  what = new Set(what);
  if (what.has('settings')) writeJson(P('settings.json'), db.settings);
  if (what.has('menu')) writeJson(P('menu.json'), db.menu);
  if (what.has('summaries')) writeJson(P('summaries.json'), db.summaries);
  for (const w of what) if (typeof w === 'number') {            // invoice shard numbers
    writeJson(P('invoices-' + String(w).padStart(4, '0') + '.json'), db.invoices.filter(i => Math.floor((i._n - 1) / SHARD) === w));
  }
  meta.rev++; writeJson(P('meta.json'), meta);
}
const shardOf = inv => Math.floor((inv._n - 1) / SHARD);

let lastBackupDay = '';
function dailyBackup(force) {
  const day = new Date().toISOString().slice(0, 10), name = force || day;
  if (!force) { if (day === lastBackupDay) return; lastBackupDay = day; }
  try {
    const dst = path.join(BACKUPS, name); if (fs.existsSync(dst) && !force) return; fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(DATA)) if (/\.json$/.test(f)) fs.copyFileSync(P(f), path.join(dst, f));
    const all = fs.readdirSync(BACKUPS).filter(d => /^\d{4}-\d\d-\d\d$/.test(d)).sort();
    all.slice(0, Math.max(0, all.length - 30)).forEach(d => fs.rmSync(path.join(BACKUPS, d), { recursive: true, force: true }));
  } catch (e) { console.error('backup failed:', e.message); }
}

/* ---------------- validation ---------------- */
const isNum = v => typeof v === 'number' && isFinite(v);
const str = (v, max) => typeof v === 'string' && v.length <= max;
class HttpError extends Error { constructor(code, msg, extra) { super(msg); this.code = code; this.extra = extra; } }
const bad = m => new HttpError(400, m);

function cleanMenuItem(x) {
  if (!x || typeof x !== 'object') throw bad('Menu item must be an object');
  if (!str(x.id, 60) || !x.id) throw bad('Menu item needs an id');
  if (!str(x.name, 200) || !x.name.trim()) throw bad('Menu item needs a name');
  if (!isNum(x.price) || x.price < 0) throw bad('Menu item needs a price');
  const gst = isNum(+x.gst) ? +x.gst : 0; if (gst < 0 || gst > 100) throw bad('GST % out of range');
  return { id: x.id, name: x.name.trim(), cat: str(x.cat || '', 100) ? (x.cat || '') : '', price: x.price, gst, hsn: str(x.hsn || '', 20) ? (x.hsn || '') : '', img: str(x.img || '', 400000) ? (x.img || '') : '', upd: str(x.upd || '', 40) ? (x.upd || '') : '' };
}
const SETTING_TYPES = { company: 's', address: 's', phone: 's', alertPhone: 's', email: 's', gstin: 's', fssai: 's', state: 's', prefix: 's', sumPrefix: 's', paper: 's', folderName: 's', logo: 'img', seal: 'img', sign: 'img', nextNo: 'int', sumNext: 'int', defGst: 'n', inclusive: 'b', imgClean: 'b' };
function cleanSettings(p) {
  if (!p || typeof p !== 'object') throw bad('Settings must be an object');
  const out = {};
  for (const k of Object.keys(p)) {
    const t = SETTING_TYPES[k]; if (!t) continue; const v = p[k];
    if (t === 's' && str(v, 1000)) out[k] = v;
    else if (t === 'img' && str(v, 3000000)) out[k] = v;
    else if (t === 'int' && Number.isInteger(v) && v >= 1 && v < 1e9) out[k] = v;
    else if (t === 'n' && isNum(v) && v >= 0 && v <= 100) out[k] = v;
    else if (t === 'b' && typeof v === 'boolean') out[k] = v;
    else throw bad('Invalid value for setting ' + k);
  }
  return out;
}
function cleanInvoice(x) {
  if (!x || typeof x !== 'object') throw bad('Invoice must be an object');
  if (!str(x.no, 40) || !x.no) throw bad('Invoice needs a number');
  if (!Array.isArray(x.items) || !x.items.length || x.items.length > 500) throw bad('Invoice needs items');
  if (!isNum(x.total) || !isNum(x.taxable) || !Array.isArray(x.rates)) throw bad('Invoice totals missing');
  if (!x.customer || typeof x.customer !== 'object' || !str(x.customer.name, 300)) throw bad('Invoice needs a customer');
  if (isNaN(Date.parse(x.date))) throw bad('Invoice date invalid');
  const o = JSON.parse(JSON.stringify(x)); delete o._n; return o;
}

/* ---------------- auth ---------------- */
let SECRET; { const f = P('secret.key'); try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch (e) { SECRET = crypto.randomBytes(32).toString('hex'); fs.writeFileSync(f, SECRET, { mode: 0o600 }); } }
const hmac = s => crypto.createHmac('sha256', SECRET + '|' + PASSWORD).update(s).digest('hex');
const makeToken = () => { const ts = Date.now(); return ts + '.' + hmac('t' + ts); };
function validToken(tok) {
  if (!PASSWORD) return true;
  const m = /^(\d+)\.([0-9a-f]{64})$/.exec(tok || ''); if (!m) return false;
  if (Date.now() - +m[1] > 30 * 864e5 || +m[1] > Date.now() + 60000) return false;
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(hmac('t' + m[1])));
}
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(a => a[0]).map(a => [a[0], a.slice(1).join('=')]));
const attempts = new Map();
function clientIp(req) { return (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '?'; }
function throttled(ip) { const n = Date.now(), a = attempts.get(ip); if (!a || a.reset < n) return false; return a.count >= 10; }
function noteFail(ip) { const n = Date.now(), a = attempts.get(ip); if (!a || a.reset < n) attempts.set(ip, { count: 1, reset: n + 5 * 60000 }); else a.count++; }

/* ---------------- http helpers ---------------- */
function send(res, code, body, headers) {
  const h = Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store' }, headers || {});
  if (typeof body === 'object' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; }
  res.writeHead(code, h); res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new HttpError(413, 'Too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
}
async function readJsonBody(req) { const b = await readBody(req, MAX_JSON); try { return JSON.parse(b.toString('utf8') || '{}'); } catch (e) { throw bad('Invalid JSON'); } }
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self' blob: about:; object-src 'none'; base-uri 'none'; form-action 'self'";

let indexCache = { m: 0, html: '' };
function indexHtml() {
  const st = fs.statSync(INDEX);
  if (st.mtimeMs !== indexCache.m) {
    let h = fs.readFileSync(INDEX, 'utf8');
    if (fs.existsSync(path.join(VENDOR, 'jspdf.umd.min.js'))) h = h.replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/[\d.]+\/jspdf\.umd\.min\.js/, '/vendor/jspdf.umd.min.js');
    if (fs.existsSync(path.join(VENDOR, 'xlsx.full.min.js'))) h = h.replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/[\d.]+\/xlsx\.full\.min\.js/, '/vendor/xlsx.full.min.js');
    indexCache = { m: st.mtimeMs, html: h };
  }
  return indexCache.html;
}
const MIME = { '.pdf': 'application/pdf', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv; charset=utf-8', '.js': 'text/javascript' };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}\.(pdf|xlsx|csv)$/;


/* ---------------- Free alert channels (optional): Telegram bot and CallMeBot WhatsApp ---------------- */
const TG_TOKEN = process.env.TG_TOKEN || '', TG_CHAT = process.env.TG_CHAT || '';
const CMB_KEY = process.env.CMB_KEY || '', CMB_PHONE = process.env.CMB_PHONE || '';
const TG_API = process.env.TG_API_BASE || 'https://api.telegram.org', CMB_API = process.env.CMB_API_BASE || 'https://api.callmebot.com';
function waNumber(p) { let d = String(p || '').replace(/\D/g, ''); if (d.length === 11 && d[0] === '0') d = d.slice(1); if (d.length === 10) d = '91' + d; return d.length >= 11 ? d : ''; }
function alertChannels() { const c = []; if (TG_TOKEN && TG_CHAT) c.push('telegram'); if (CMB_KEY) c.push('whatsapp'); return c; }
async function sendTelegram(text) {
  const r = await fetch(TG_API + '/bot' + TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: TG_CHAT, text: text.slice(0, 3500) }), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Telegram refused the message (' + r.status + ')');
}
async function sendCallMeBot(text) {
  const to = waNumber(CMB_PHONE) || waNumber(db.settings.alertPhone) || waNumber(db.settings.phone);
  if (!to) throw new Error('no valid phone number for WhatsApp');
  const u = CMB_API + '/whatsapp.php?phone=' + encodeURIComponent('+' + to) + '&text=' + encodeURIComponent(text.slice(0, 1500)) + '&apikey=' + encodeURIComponent(CMB_KEY);
  const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); const t = await r.text();
  if (!r.ok || /error/i.test(t)) throw new Error('CallMeBot refused the message');
}
async function sendAlerts(text) {
  const jobs = []; if (alertChannels().includes('telegram')) jobs.push(['Telegram', sendTelegram]); if (alertChannels().includes('whatsapp')) jobs.push(['WhatsApp', sendCallMeBot]);
  const sent = [], failed = [];
  await Promise.all(jobs.map(async ([n, f]) => { try { await f(text); sent.push(n); } catch (e) { failed.push(n + ': ' + e.message); } }));
  return { sent, failed };
}

/* ---------------- API ---------------- */
const pad = (n, l) => String(n).padStart(l, '0');
async function api(req, res, p, q) {
  const m = req.method;
  if (p === '/api/ping' && m === 'GET') return send(res, 200, { qfb: 1, auth: !!PASSWORD, authed: validToken(cookies(req).qfb), alerts: alertChannels() });
  if (p === '/api/login' && m === 'POST') {
    const ip = clientIp(req); if (throttled(ip)) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const b = await readJsonBody(req);
    const a = crypto.createHash('sha256').update(String(b.password || '')).digest(), c = crypto.createHash('sha256').update(PASSWORD).digest();
    if (!PASSWORD || !crypto.timingSafeEqual(a, c)) { noteFail(ip); throw new HttpError(401, 'Wrong password'); }
    const secure = (req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted) ? '; Secure' : '';
    return send(res, 200, { ok: 1 }, { 'Set-Cookie': 'qfb=' + makeToken() + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + 30 * 86400 + secure });
  }
  if (p === '/api/logout' && m === 'POST') return send(res, 200, { ok: 1 }, { 'Set-Cookie': 'qfb=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
  if (!validToken(cookies(req).qfb)) throw new HttpError(401, 'Login required');
  if (m !== 'GET' && req.headers['x-qfb'] !== '1') throw new HttpError(403, 'Missing header');

  if (p === '/api/notify' && m === 'POST') {
    if (!alertChannels().length) throw new HttpError(501, 'No free alert channel is set up on the server');
    const b = await readJsonBody(req); if (typeof b.text !== 'string' || !b.text.trim()) throw bad('text required');
    const r = await sendAlerts(b.text);
    if (!r.sent.length) throw new HttpError(502, r.failed.join('; '));
    return send(res, 200, { ok: 1, sent: r.sent, failed: r.failed });
  }
  if (p === '/api/rev' && m === 'GET') return send(res, 200, { rev: meta.rev });
  if (p === '/api/state' && m === 'GET') {
    const body = Buffer.from(JSON.stringify({ rev: meta.rev, settings: db.settings, menu: db.menu, invoices: db.invoices, summaries: db.summaries }));
    if (/\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 2000) return send(res, 200, zlib.gzipSync(body), { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip' });
    return send(res, 200, body, { 'Content-Type': 'application/json; charset=utf-8' });
  }
  if (p === '/api/settings' && m === 'PATCH') {
    const patch = cleanSettings((await readJsonBody(req)).patch); Object.assign(db.settings, patch); persist(['settings']);
    return send(res, 200, { rev: meta.rev, settings: { nextNo: db.settings.nextNo, sumNext: db.settings.sumNext } });
  }
  if (p === '/api/menu/batch' && m === 'POST') {
    const b = await readJsonBody(req), up = (b.upsert || []).map(cleanMenuItem), rm = new Set((b.remove || []).filter(x => typeof x === 'string'));
    if (up.length > 5000) throw bad('Too many items');
    const idx = new Map(db.menu.map((x, i) => [x.id, i]));
    for (const it of up) { if (idx.has(it.id)) db.menu[idx.get(it.id)] = it; else { idx.set(it.id, db.menu.length); db.menu.push(it); } }
    if (rm.size) db.menu = db.menu.filter(x => !rm.has(x.id));
    persist(['menu']); return send(res, 200, { rev: meta.rev });
  }
  if (p === '/api/invoices/reserve' && m === 'POST') {
    const s = db.settings; let no = s.prefix + pad(s.nextNo, 4); while (invIndex.has(no)) { s.nextNo++; no = s.prefix + pad(s.nextNo, 4); }
    s.nextNo++; persist(['settings']); return send(res, 200, { no, nextNo: s.nextNo, rev: meta.rev });
  }
  if (p === '/api/invoices' && m === 'POST') {
    const inv = cleanInvoice((await readJsonBody(req)).inv);
    if (invIndex.has(inv.no)) throw new HttpError(409, 'Invoice number already exists', { code: 'exists' });
    inv._n = ++meta.invSeq; inv._v = 1; db.invoices.push(inv); invIndex.set(inv.no, inv); persist([shardOf(inv)]);
    return send(res, 200, { v: 1, rev: meta.rev });
  }
  let mm = /^\/api\/invoices\/([^/]+)$/.exec(p);
  if (mm && m === 'PUT') {
    const no = decodeURIComponent(mm[1]), cur = invIndex.get(no); if (!cur) throw new HttpError(404, 'Invoice not found');
    const b = await readJsonBody(req), inv = cleanInvoice(b.inv);
    if (inv.no !== no) throw bad('Invoice number cannot change');
    if (b.baseV !== cur._v) throw new HttpError(409, 'This bill was changed on another device', { code: 'stale', current: cur });
    inv._n = cur._n; inv._v = cur._v + 1; db.invoices[db.invoices.indexOf(cur)] = inv; invIndex.set(no, inv); persist([shardOf(inv)]);
    return send(res, 200, { v: inv._v, rev: meta.rev });
  }
  if (p === '/api/summaries/issue' && m === 'POST') {
    const b = await readJsonBody(req);
    if (!str(b.key, 600) || !str(b.sig, 200000) || !str(b.name, 300) || !str(b.a, 12) || !str(b.b, 12) || !isNum(b.n) || !isNum(b.total)) throw bad('Invalid summary request');
    let ex = db.summaries.find(x => x.key === b.key && x.sig === b.sig && !x.superseded);
    if (!ex) {
      db.summaries.forEach(x => { if (x.key === b.key) x.superseded = true; });
      const s = db.settings; ex = { no: s.sumPrefix + pad(s.sumNext, 4), date: new Date().toISOString(), key: b.key, sig: b.sig, name: b.name, gstin: str(b.gstin || '', 30) ? (b.gstin || '') : '', a: b.a, b: b.b, n: b.n, total: b.total };
      s.sumNext++; db.summaries.push(ex); persist(['settings', 'summaries']);
    }
    return send(res, 200, { entry: ex, summaries: db.summaries, sumNext: db.settings.sumNext, rev: meta.rev });
  }
  if (p === '/api/restore' && m === 'POST') {
    const b = await readJsonBody(req);
    if (!b.settings || !Array.isArray(b.menu) || !Array.isArray(b.invoices)) throw bad('Not a valid backup');
    const menu = b.menu.map(cleanMenuItem), invs = b.invoices.map(cleanInvoice), seen = new Set();
    invs.forEach(i => { if (seen.has(i.no)) throw bad('Duplicate invoice ' + i.no); seen.add(i.no); });
    dailyBackup('before-restore-' + new Date().toISOString().replace(/[:.]/g, '-'));
    for (const f of fs.readdirSync(DATA)) if (/^invoices-\d+\.json$/.test(f)) fs.unlinkSync(P(f));
    db.settings = Object.assign({}, DEFAULTS, cleanSettings(b.settings)); db.menu = menu; db.summaries = Array.isArray(b.summaries) ? b.summaries : [];
    db.invoices = invs.map((i, k) => Object.assign(i, { _n: k + 1, _v: 1 })); meta.invSeq = db.invoices.length;
    invIndex.clear(); db.invoices.forEach(i => invIndex.set(i.no, i));
    const shards = new Set(db.invoices.map(shardOf)); persist(['settings', 'menu', 'summaries', ...shards]);
    return send(res, 200, { rev: meta.rev });
  }
  mm = /^\/api\/files\/([^/]+)$/.exec(p);
  if (mm && m === 'PUT') {
    const name = decodeURIComponent(mm[1]); if (!FILE_RE.test(name)) throw bad('File name not allowed');
    const buf = await readBody(req, MAX_FILE), f = path.join(FILES, name), t = f + '.tmp'; fs.writeFileSync(t, buf); fs.renameSync(t, f);
    return send(res, 200, { ok: 1 });
  }
  throw new HttpError(404, 'Not found');
}

/* ---------------- request router ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    if (p.startsWith('/api/')) return await api(req, res, p, u.searchParams);
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
    if (p === '/' || p === '/index.html') return send(res, 200, indexHtml(), { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': CSP });
    if (p === '/healthz') return send(res, 200, { ok: 1 });
    let mm = /^\/vendor\/(jspdf\.umd\.min\.js|xlsx\.full\.min\.js)$/.exec(p);
    if (mm && fs.existsSync(path.join(VENDOR, mm[1]))) return send(res, 200, fs.readFileSync(path.join(VENDOR, mm[1])), { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    if (p === '/files' || p === '/files/' || /^\/files\/[^/]+$/.test(p)) {
      if (!validToken(cookies(req).qfb)) return send(res, 401, '<p style="font:16px system-ui;padding:20px">Please log in on the main page first, then reopen this link.</p>', { 'Content-Type': 'text/html; charset=utf-8' });
      if (p.startsWith('/files/') && p.length > 7) {
        const name = decodeURIComponent(p.slice(7)); if (!FILE_RE.test(name) || !fs.existsSync(path.join(FILES, name))) throw new HttpError(404, 'No such file');
        return send(res, 200, fs.readFileSync(path.join(FILES, name)), { 'Content-Type': MIME[path.extname(name)] || 'application/octet-stream', 'Content-Disposition': 'inline; filename="' + name + '"', 'Cache-Control': 'private, no-cache' });
      }
      const list = fs.readdirSync(FILES).filter(f => FILE_RE.test(f)).map(f => ({ f, t: fs.statSync(path.join(FILES, f)).mtimeMs, s: fs.statSync(path.join(FILES, f)).size })).sort((a, b) => b.t - a.t);
      const rows = list.map(x => '<tr><td><a href="/files/' + encodeURIComponent(x.f) + '">' + esc(x.f) + '</a></td><td>' + new Date(x.t).toLocaleString('en-IN') + '</td><td style="text-align:right">' + Math.ceil(x.s / 1024) + ' KB</td></tr>').join('');
      return send(res, 200, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved invoices</title><body style="font:15px system-ui;margin:16px"><h2>Saved invoices and master files</h2><p><a href="/">← Back to the app</a></p><table cellpadding="6" style="border-collapse:collapse;width:100%;max-width:760px"><tr style="text-align:left;border-bottom:1px solid #ccc"><th>File</th><th>Saved</th><th>Size</th></tr>' + (rows || '<tr><td colspan=3>No files yet.</td></tr>') + '</table>', { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" });
    }
    throw new HttpError(404, 'Not found');
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.code, Object.assign({ error: e.message }, e.extra || {}));
    console.error(new Date().toISOString(), req.method, req.url, e); send(res, 500, { error: 'Server error' });
  }
});
server.requestTimeout = 60000;
if (require.main === module) {
  server.listen(PORT, HOST, () => console.log('QFB POS listening on http://' + HOST + ':' + PORT + '  data: ' + DATA + (PASSWORD ? '' : '  (NO PASSWORD: local only)')));
  const stop = () => server.close(() => process.exit(0)); process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
module.exports = { server, db, meta };
