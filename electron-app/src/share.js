'use strict';
// Share a folder over the local network: a small web server that lets a phone or Mac on the same Wi-Fi
// download the songs (one by one or as a .zip per folder) and upload files back to this computer.
// Everything is behind a random secret in the address, and nothing leaves the local network.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const JUNK = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i;
const ZIP_LIMIT = 4000000000; // plain (non-zip64) zips must stay under 4 GB
const SITE = 'https://lxchster.github.io/local-files-fixer/#whereCard';
let state = null;

// ---------------------------------------------------------------- helpers
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crcUpdate(crc, buf) { for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8); return crc; }

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const send = (res, code, body, type) => { res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(body); };
function disposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

function walk(root, prefix = '') {
  const out = [];
  const rec = (dir, rel) => {
    let items; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const it of items) {
      if (JUNK.test(it.name) || it.name.startsWith('__MACOSX')) continue;
      const abs = path.join(dir, it.name), r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) rec(abs, r);
      else if (it.isFile()) { try { const st = fs.statSync(abs); out.push({ rel: r, abs, size: st.size, mtime: st.mtime }); } catch {} }
    }
  };
  rec(root, prefix);
  return out;
}

function lanAddresses() {
  const rank = (a) => /^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3;
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) list.push({ name, address: a.address });
  }
  return list.sort((a, b) => rank(a.address) - rank(b.address));
}

// ---------------------------------------------------------------- zip (stored, no compression; sizes + CRCs known up front)
const crcCache = new Map();
async function fileCrc(f) {
  const key = f.abs + '|' + f.size + '|' + +f.mtime;
  if (crcCache.has(key)) return crcCache.get(key);
  let crc = 0xFFFFFFFF;
  for await (const chunk of fs.createReadStream(f.abs)) crc = crcUpdate(crc, chunk);
  crc = (crc ^ 0xFFFFFFFF) >>> 0;
  crcCache.set(key, crc);
  return crc;
}
function dosDateTime(d) {
  const y = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

async function sendZip(res, files, zipName) {
  res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': disposition(zipName), 'Cache-Control': 'no-store' });
  let closed = false; res.on('close', () => { closed = true; });
  const write = (buf) => new Promise((resolve) => {
    if (closed) return resolve();
    const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
    if (res.write(buf)) resolve(); else { res.once('drain', done); res.once('close', done); }
  });
  try {
    const entries = [];
    for (const f of files) { entries.push({ f, crc: await fileCrc(f) }); if (closed) return; }
    let off = 0;
    for (const e of entries) {
      const name = Buffer.from(e.f.rel, 'utf8'), { time, date } = dosDateTime(e.f.mtime);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(e.crc, 14); h.writeUInt32LE(e.f.size, 18); h.writeUInt32LE(e.f.size, 22);
      h.writeUInt16LE(name.length, 26); h.writeUInt16LE(0, 28);
      e.off = off; e.name = name; e.time = time; e.date = date;
      await write(h); await write(name); off += 30 + name.length;
      if (e.f.size > 0) {
        let sent = 0;
        for await (const chunk of fs.createReadStream(e.f.abs, { start: 0, end: e.f.size - 1 })) { await write(chunk); sent += chunk.length; if (closed) return; }
        if (sent !== e.f.size) { res.destroy(); return; } // file changed while sending - better to fail than hand over a bad zip
      }
      off += e.f.size;
    }
    const cdStart = off; let cdSize = 0;
    for (const e of entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(e.time, 12); c.writeUInt16LE(e.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.f.size, 20); c.writeUInt32LE(e.f.size, 24);
      c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(e.off, 42);
      await write(c); await write(e.name); cdSize += 46 + e.name.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
    await write(end);
    res.end();
  } catch { res.destroy(); }
}

// ---------------------------------------------------------------- pages and routes
function pageHtml(s) {
  const base = '/' + s.token;
  const groupsHtml = s.groups.map((g, gi) => {
    const zipOk = g.size < ZIP_LIMIT && g.idx.length < 65000;
    const rows = g.idx.map((i) => `<a class="file" href="${base}/f/${i}"><span>${esc(path.posix.basename(s.files[i].rel))}</span><em>${fmt(s.files[i].size)}</em></a>`).join('');
    return `<section class="card"><div class="gh"><div><b>${esc(g.name)}</b><div class="muted">${g.idx.length} file${g.idx.length === 1 ? '' : 's'} - ${fmt(g.size)}</div></div>`
      + (zipOk ? `<a class="btn" href="${base}/z/${gi}">Download .zip</a>` : `<span class="muted">too big for one zip - use the files</span>`)
      + `</div><details><summary>Show files</summary><div class="files">${rows}</div></details></section>`;
  }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000000">
<title>Local Files Toolkit - send to this device</title><style>
:root{--grey:#121212;--line:rgba(30,215,96,.26);--muted:#9aaaa1;--green:#1ed760;--grad:linear-gradient(135deg,#1aa84b,#3be67f)}
*{box-sizing:border-box}body{margin:0;background:#0e0e0e;color:#fff;font:15px/1.5 system-ui,-apple-system,"Segoe UI",Inter,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 16px 48px;display:flex;flex-direction:column;gap:14px}
h1{margin:10px 0 0;font-size:clamp(30px,8vw,46px);line-height:1.05;letter-spacing:-.02em}.grad{background:var(--grad);-webkit-background-clip:text;background-clip:text;color:transparent}
.tag{display:inline-block;font-size:10px;letter-spacing:.3em;font-weight:700;color:#b9f5d0;border:1px solid var(--line);border-radius:999px;padding:6px 14px}
.muted{color:var(--muted);font-size:13px}.card{background:var(--grey);border:1px solid transparent;border-radius:20px;padding:18px}.edge{border-color:var(--line)}
.gh{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.btn{display:inline-block;border:0;border-radius:999px;padding:11px 22px;background:var(--grad);color:#03140a;font-weight:700;font-size:14px;text-decoration:none;cursor:pointer}
.btn.ghost{background:#000;color:#fff}details{margin-top:10px}summary{cursor:pointer;color:var(--muted);font-size:13px}
.files{display:flex;flex-direction:column;gap:2px;margin-top:8px}.file{display:flex;justify-content:space-between;gap:10px;padding:9px 12px;border-radius:12px;background:#000;color:#fff;text-decoration:none;font-size:14px}
.file span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file em{color:var(--muted);font-style:normal;flex:none}
.bar{height:8px;border-radius:99px;background:#000;overflow:hidden;margin:10px 0 4px}.bar i{display:block;height:100%;width:0;background:var(--grad)}
#upStatus{font-size:13px;color:var(--muted);word-break:break-all}a.link{color:#5fe596}
</style></head><body><main>
<header><span class="tag">LOCAL FILES TOOLKIT</span><h1>Send to <span class="grad">this device</span></h1>
<p class="muted">Songs from <b>${esc(s.label)}</b> on your computer. Tap a folder's .zip, or open it and tap single files.</p></header>
${groupsHtml || '<section class="card">No files found in the shared folder.</section>'}
<section class="card edge"><b>Send files to the computer</b><p class="muted">Pick files on this device. They are saved on the computer in a folder called <b>${esc(path.basename(s.recvDir))}</b>.</p>
<input id="pick" type="file" multiple hidden><button class="btn ghost" id="go">Choose files</button>
<div class="bar"><i id="fill"></i></div><div id="upStatus"></div></section>
<p class="muted">Where do the files go on this device? <a class="link" href="${SITE}">See the instructions</a>.</p>
</main><script>
const go=document.getElementById('go'),pick=document.getElementById('pick'),fill=document.getElementById('fill'),st=document.getElementById('upStatus');
go.onclick=()=>pick.click();
pick.onchange=async()=>{const files=[...pick.files];let done=0;const total=files.reduce((a,f)=>a+f.size,0)||1;let sent=0;
for(const f of files){st.textContent='Sending '+f.name+' ('+(done+1)+' of '+files.length+')';
await new Promise((ok)=>{const x=new XMLHttpRequest();let last=0;x.open('POST','${base}/up?name='+encodeURIComponent(f.name));
x.upload.onprogress=(e)=>{sent+=e.loaded-last;last=e.loaded;fill.style.width=Math.min(100,sent/total*100)+'%'};
x.onload=()=>{sent+=f.size-last;ok()};x.onerror=()=>{st.textContent='Failed on '+f.name;ok()};x.send(f)});done++}
fill.style.width='100%';st.textContent='Sent '+done+' file(s).';pick.value=''};
</script></body></html>`;
}

function handleUpload(req, res, name) {
  const safe = path.basename(String(name || '')).replace(/[<>:"|?*\\/\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 200) || 'file';
  fs.mkdirSync(state.recvDir, { recursive: true });
  const dot = safe.lastIndexOf('.'), stem = dot > 0 ? safe.slice(0, dot) : safe, ext = dot > 0 ? safe.slice(dot) : '';
  let finalName = safe, n = 0;
  while (fs.existsSync(path.join(state.recvDir, finalName))) finalName = `${stem} (${++n})${ext}`;
  const dest = path.join(state.recvDir, finalName), tmp = dest + '.part';
  const ws = fs.createWriteStream(tmp);
  let size = 0, failed = false;
  req.on('data', (c) => { size += c.length; });
  req.on('aborted', () => { failed = true; ws.destroy(); fs.rm(tmp, { force: true }, () => {}); });
  ws.on('error', () => { if (failed) return; failed = true; fs.rm(tmp, { force: true }, () => {}); send(res, 500, 'Could not save the file'); });
  ws.on('finish', () => {
    if (failed) return;
    try { fs.renameSync(tmp, dest); } catch { return send(res, 500, 'Could not save the file'); }
    state.received++;
    if (state.onEvent) state.onEvent({ type: 'upload', name: finalName, size, received: state.received });
    send(res, 200, JSON.stringify({ ok: true, name: finalName }), 'application/json');
  });
  req.pipe(ws);
}

function handle(req, res) {
  if (!state) return send(res, 503, 'Sharing has stopped');
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  if (!/^(\d{1,3}(\.\d{1,3}){3}|localhost)$/.test(host) && !(state.publicHost && host === state.publicHost)) return send(res, 403, 'Forbidden');
  let u, parts;
  try { u = new URL(req.url, 'http://x'); parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return send(res, 400, 'Bad request'); }
  if (parts[0] !== state.token) return send(res, 404, 'Not found');
  const [, a, b] = parts;

  if (req.method === 'GET' && !a) return send(res, 200, pageHtml(state), 'text/html; charset=utf-8');

  if (req.method === 'GET' && a === 'f') {
    const f = state.files[Number(b)];
    if (!f || !/^\d+$/.test(String(b))) return send(res, 404, 'Not found');
    let st; try { st = fs.statSync(f.abs); } catch { return send(res, 404, 'File is gone'); }
    const size = st.size, ext = path.extname(f.abs).toLowerCase();
    const headers = { 'Content-Type': ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : 'application/octet-stream', 'Content-Disposition': disposition(path.basename(f.abs)), 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    let start = 0, end = size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      if (m[1] === '') { start = Math.max(0, size - Number(m[2])); } else { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      code = 206; headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = size === 0 ? 0 : end - start + 1;
    res.writeHead(code, headers);
    if (size === 0) return res.end();
    const rs = fs.createReadStream(f.abs, { start, end });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    return rs.pipe(res);
  }

  if (req.method === 'GET' && a === 'z') {
    const g = state.groups[Number(b)];
    if (!g || !/^\d+$/.test(String(b))) return send(res, 404, 'Not found');
    if (g.size >= ZIP_LIMIT) return send(res, 413, 'Too big for one zip - download the files one by one.');
    return sendZip(res, g.idx.map((i) => state.files[i]), g.name.replace(/[\\/:*?"<>|]/g, '_') + '.zip');
  }

  if (req.method === 'POST' && a === 'up') return handleUpload(req, res, u.searchParams.get('name'));
  return send(res, 404, 'Not found');
}

// ---------------------------------------------------------------- public api
function buildGroups(files) {
  const map = new Map();
  files.forEach((f, i) => {
    const k = f.rel.includes('/') ? f.rel.split('/')[0] : 'Loose files';
    if (!map.has(k)) map.set(k, { name: k, idx: [], size: 0 });
    const g = map.get(k); g.idx.push(i); g.size += f.size;
  });
  return [...map.values()];
}

function info() {
  if (!state) return { running: false };
  const urls = lanAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${state.port}/${state.token}/` }));
  return { running: true, label: state.label, urls, port: state.port, token: state.token, publicHost: state.publicHost || null,
    count: state.files.length, bytes: state.files.reduce((a, f) => a + f.size, 0), recvDir: state.recvDir, received: state.received };
}

function setPublicHost(h) { if (state) state.publicHost = h || null; }

// paths: one or more folders and/or files to share.
async function start(paths, opts = {}) {
  const list = (Array.isArray(paths) ? paths : [paths]).filter(Boolean);
  if (!list.length) throw new Error('Choose a folder or some files first.');
  const key = list.join('|');
  if (state && state.key === key) { state.onEvent = opts.onEvent; return info(); }
  await stop();
  const files = []; let label;
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  if (list.length === 1 && isDir(list[0])) {
    files.push(...walk(list[0])); label = path.basename(list[0]) || list[0];
  } else {
    for (const p of list) {
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.isDirectory()) files.push(...walk(p, path.basename(p)));
      else if (st.isFile() && !JUNK.test(path.basename(p))) files.push({ rel: path.basename(p), abs: p, size: st.size, mtime: st.mtime });
    }
    label = list.length + ' selected item' + (list.length === 1 ? '' : 's');
  }
  if (!files.length) throw new Error('There are no files to share in that selection.');
  const s = { key, label, files, groups: buildGroups(files), token: crypto.randomBytes(9).toString('base64url'), received: 0, onEvent: opts.onEvent,
    publicHost: null, recvDir: opts.recvDir || path.join(os.homedir(), 'Downloads', 'Local Files Toolkit - received'), server: null, port: 0 };
  s.server = http.createServer(handle);
  s.server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });
  await new Promise((resolve, reject) => {
    let port = 8080;
    const tryListen = () => {
      s.server.once('error', (e) => { if (e.code === 'EADDRINUSE' && port < 8100) { port++; tryListen(); } else if (e.code === 'EADDRINUSE') { port = 0; tryListen(); } else reject(e); });
      s.server.listen(port, '0.0.0.0', () => { s.port = s.server.address().port; resolve(); });
    };
    tryListen();
  });
  state = s;
  // warm the zip checksums in the background so downloads start quickly
  (async () => { for (const f of files) { if (state !== s) return; try { await fileCrc(f); } catch {} } })();
  return info();
}

async function stop() {
  const s = state; state = null;
  if (s && s.server) await new Promise((r) => { s.server.close(() => r()); if (s.server.closeAllConnections) s.server.closeAllConnections(); });
}

module.exports = { start, stop, status: info, setPublicHost, lanAddresses };
