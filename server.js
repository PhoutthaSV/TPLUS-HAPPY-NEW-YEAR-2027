// TPLUS Lucky Draw server — no dependencies, run with: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LIST_CSV = path.join(ROOT, 'List.csv');
const LIST_XLSX = path.join(ROOT, 'List.xlsx');

fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- state ----------
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { prizes: s.prizes || [], results: s.results || [], attendees: s.attendees || [], version: s.version || 1 };
  } catch {
    return { prizes: [], results: [], attendees: [], version: 1 };
  }
}
let state = loadState();
function saveState() {
  state.version++;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- CSV ----------
function parseCSV(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function readEmployeesCSV() {
  const rows = parseCSV(fs.readFileSync(LIST_CSV, 'utf8'));
  if (!rows.length) return [];
  const head = rows[0].map(h => h.trim().toLowerCase());
  const col = (...names) => head.findIndex(h => names.some(n => h.includes(n)));
  const iId = col('staff id', 'id');
  const iSex = col('sex', 'gender');
  const iName = col('name');
  const iDept = col('department', 'dept');
  const iLoc = col('location', 'branch');
  const out = [];
  for (const r of rows.slice(1)) {
    const name = (r[iName] || '').trim();
    if (!name) continue;
    out.push({
      staffId: (r[iId] || '').trim(),
      sex: (r[iSex] || '').trim(),
      name,
      department: (r[iDept] || '').trim(),
      location: (r[iLoc] || '').trim(),
    });
  }
  return out;
}

let empCache = { key: '', data: [], error: null };
function employeeSource() {
  const st = f => { try { return fs.statSync(f); } catch { return null; } };
  const csv = st(LIST_CSV), xlsx = st(LIST_XLSX);
  if (xlsx && (!csv || xlsx.mtimeMs > csv.mtimeMs)) return { format: 'xlsx', file: 'List.xlsx', mtime: xlsx.mtimeMs, size: xlsx.size };
  if (csv) return { format: 'csv', file: 'List.csv', mtime: csv.mtimeMs, size: csv.size };
  return null;
}
function getEmployees() {
  const src = employeeSource();
  if (!src) return { error: 'ບໍ່ພົບໄຟລ໌ List.csv ຫຼື List.xlsx', employees: [] };
  const key = src.file + ':' + src.mtime + ':' + src.size;
  if (src.format === 'xlsx') return { ...src, version: key };
  if (empCache.key !== key) {
    try { empCache = { key, data: readEmployeesCSV(), error: null }; }
    catch (e) { /* file may be locked mid-save; keep last good copy */ empCache.error = String(e.message || e); }
  }
  return { ...src, version: empCache.key, employees: empCache.data, error: empCache.error };
}

// ---------- helpers ----------
function lanUrls() {
  // Real Wi-Fi / Ethernet first; virtual adapters (VMware, Hyper-V, WSL, Docker...) last
  const virtual = /vmware|virtualbox|vbox|vethernet|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|vpn/i;
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) found.push({ url: `http://${a.address}:${PORT}`, rank: virtual.test(name) ? 2 : /wi-?fi|wlan|wireless|ethernet|eth|en\d/i.test(name) ? 0 : 1 });
    }
  }
  return found.sort((a, b) => a.rank - b.rank).map(x => x.url);
}
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
  '.csv': 'text/csv; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
const clean = (v, n = 120) => String(v == null ? '' : v).trim().slice(0, n);
const norm = s => clean(s).toLowerCase().replace(/\s+/g, ' ');

// ---------- routes ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/api/employees' && req.method === 'GET') return send(res, 200, getEmployees());
    if (p === '/api/state' && req.method === 'GET') return send(res, 200, state);
    if (p === '/api/info' && req.method === 'GET') return send(res, 200, { port: PORT, urls: lanUrls() });

    if (p === '/api/admin' && req.method === 'PUT') {
      const b = await readBody(req);
      if (Array.isArray(b.prizes)) state.prizes = b.prizes;
      if (Array.isArray(b.results)) state.results = b.results;
      saveState();
      return send(res, 200, { ok: true, version: state.version });
    }

    if (p === '/api/lookup' && req.method === 'GET') {
      const id = norm(url.searchParams.get('id'));
      const emp = getEmployees();
      const e = (emp.employees || []).find(x => norm(x.staffId) === id);
      return send(res, 200, e ? { found: true, name: e.name, department: e.department, location: e.location } : { found: false });
    }

    if (p === '/api/register' && req.method === 'POST') {
      const b = await readBody(req, 64 * 1024);
      const a = { staffId: clean(b.staffId, 40).toUpperCase(), name: clean(b.name), department: clean(b.department), phone: clean(b.phone, 30) };
      if (!a.name) return send(res, 400, { ok: false, error: 'ກະລຸນາປ້ອນຊື່ ແລະ ນາມສະກຸນ' });
      const dup = state.attendees.find(x => (a.staffId && norm(x.staffId) === norm(a.staffId)) || norm(x.name) === norm(a.name));
      if (dup) return send(res, 200, { ok: true, already: true, attendee: dup });
      a.id = crypto.randomUUID();
      a.time = new Date().toISOString();
      state.attendees.push(a);
      saveState();
      return send(res, 200, { ok: true, attendee: a, count: state.attendees.length });
    }

    if (p === '/api/attendees/remove' && req.method === 'POST') {
      const b = await readBody(req);
      state.attendees = state.attendees.filter(x => x.id !== b.id);
      saveState();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/attendees/clear' && req.method === 'POST') {
      state.attendees = [];
      saveState();
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET') {
      if (p === '/List.csv') return serveFile(res, LIST_CSV);
      if (p === '/List.xlsx') return serveFile(res, LIST_XLSX);
      const rel = p === '/' ? '/index.html' : p === '/register' ? '/register.html' : decodeURIComponent(p);
      const file = path.normalize(path.join(PUBLIC, rel));
      if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
      return serveFile(res, file);
    }
    res.writeHead(404); res.end();
  } catch (e) {
    send(res, 500, { ok: false, error: String(e.message || e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n  TPLUS Lucky Draw is running');
  console.log(`  Wheel (this computer): http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  Check-in form (phones on same Wi-Fi): ${u}/register`);
  console.log('');
});
