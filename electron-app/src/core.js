'use strict';
/*
 * Core scanner + fixer (JavaScript port of local_files_fixer.py, same rules, same byte-for-byte results).
 *
 *  MP3  - remove a CBR "Info" length-header frame when its bitrate disagrees with the audio, or when the
 *         song's length sits within a hair of a whole second. VBR ("Xing") headers are never touched.
 *  M4A  - rewrite the 3 numbers of an iTunSMPB gapless tag that contradicts the real length.
 *  Mac leftovers - .DS_Store, __MACOSX folders, AppleDouble "._" files.
 *  Minor - optional: gapless tag that is off by whole audio frame(s).
 */
const fs = require('fs');
const path = require('path');

const CAT_MP3 = 'mp3', CAT_M4A = 'm4a', CAT_JUNK = 'junk', CAT_MINOR = 'minor';
const CATEGORY_LABELS = {
  [CAT_MP3]: 'MP3 length header',
  [CAT_M4A]: 'M4A gapless tag',
  [CAT_JUNK]: 'Mac leftovers',
  [CAT_MINOR]: 'Minor tag tidy-up (optional)',
};
const CATEGORY_DEFAULT_ON = { [CAT_MP3]: true, [CAT_M4A]: true, [CAT_JUNK]: true, [CAT_MINOR]: false };
const CAT_ORDER = [CAT_MP3, CAT_M4A, CAT_JUNK, CAT_MINOR];

// ------------------------------------------------------------------ helpers
const pyRound = (x) => { // Python's round-half-to-even, to match the Python version exactly
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
};
const allEqual = (arr) => new Set(arr).size === 1;
const mmss = (sec) => { sec = Math.trunc(sec); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
const yieldToUi = () => new Promise((r) => setImmediate(r));

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return n === len ? b : b.subarray(0, n);
}

// ------------------------------------------------------------------ MP3
const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SR_V1 = [44100, 48000, 32000];

function parseFrameHeader(b, p = 0) {
  if (p < 0 || p + 4 > b.length) return null;
  const b0 = b[p], b1 = b[p + 1], b2 = b[p + 2], b3 = b[p + 3];
  if (b0 !== 0xFF || (b1 & 0xFE) !== 0xFA) return null;
  const bri = b2 >> 4, sri = (b2 >> 2) & 3, pad = (b2 >> 1) & 1;
  if (bri === 0 || bri === 15 || sri === 3) return null;
  const kbps = BR_V1_L3[bri], sr = SR_V1[sri];
  return { kbps, sr, size: Math.floor(144 * kbps * 1000 / sr) + pad, mono: (b3 >> 6) === 3, crc: (b1 & 1) === 0 };
}

function id3v2End(head10) {
  if (head10.length < 10 || head10.toString('latin1', 0, 3) !== 'ID3') return 0;
  const n = (head10[6] << 21) | (head10[7] << 14) | (head10[8] << 7) | head10[9];
  return 10 + n + ((head10[5] & 0x10) ? 10 : 0);
}

function parseMp3Head(buf, base) {
  let first = null;
  const lim = Math.min(buf.length - 4, 8192);
  for (let i = 0; i < lim; i++) {
    if (buf[i] !== 0xFF) continue;
    const h = parseFrameHeader(buf, i);
    if (!h) continue;
    const nxt = i + h.size;
    if (nxt + 4 <= buf.length) {
      const h2 = parseFrameHeader(buf, nxt);
      if (!h2 || h2.sr !== h.sr) continue;
    }
    first = i;
    break;
  }
  if (first === null) return null;
  const h = parseFrameHeader(buf, first);
  const side = h.mono ? 17 : 32;
  const xo = first + 4 + (h.crc ? 2 : 0) + side;
  const tag = buf.toString('latin1', xo, xo + 4);
  const info = { ffo: base + first, hdr: h, tag, frames: null, delay: null, padding: null, nextKbps: null };
  if ((tag === 'Info' || tag === 'Xing') && xo + 8 <= buf.length) {
    const fl = buf.readUInt32BE(xo + 4);
    let p = xo + 8;
    if (fl & 1) { info.frames = buf.readUInt32BE(p); p += 4; }
    if (fl & 2) p += 4;
    if (fl & 4) p += 100;
    if (fl & 8) p += 4;
    const enc = buf.toString('latin1', p, p + 9);
    if (['LAME', 'Lavc', 'Lavf', 'Lame'].includes(enc.slice(0, 4)) && p + 24 <= buf.length) {
      const d0 = buf[p + 21], d1 = buf[p + 22], d2 = buf[p + 23];
      const delay = (d0 << 4) | (d1 >> 4), padding = ((d1 & 0xF) << 8) | d2;
      if (delay >= 0 && delay <= 3000 && padding >= 0 && padding <= 5000) { info.delay = delay; info.padding = padding; }
    }
    const nxt = parseFrameHeader(buf, first + h.size);
    info.nextKbps = nxt ? nxt.kbps : null;
  }
  return info;
}

function mp3Problems(info) {
  if (!info || info.tag !== 'Info') return []; // no header, or a VBR header that must stay
  const out = [];
  const h = info.hdr;
  if (info.nextKbps && info.nextKbps !== h.kbps) {
    out.push(`length-header frame is ${h.kbps} kbps but the audio is ${info.nextKbps} kbps, so apps read different lengths`);
  }
  const n = info.frames;
  if (n) {
    const sr = h.sr;
    const reads = [n * 1152 / sr, (n + 1) * 1152 / sr];
    if (info.delay !== null) reads.push((n * 1152 - info.delay - info.padding) / sr);
    const fl = [...new Set(reads.map(Math.floor))].sort((a, b) => a - b);
    if (fl.length > 1) {
      out.push(`length is ${reads[0].toFixed(2)} s, just under a whole second, so apps can show ${mmss(fl[0])} or ${mmss(fl[fl.length - 1])}`);
    }
  }
  return out;
}

function scanMp3(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const start = id3v2End(readAt(fd, 0, 10));
    const info = parseMp3Head(readAt(fd, start, 16384), start);
    return mp3Problems(info);
  } finally { fs.closeSync(fd); }
}

function fixMp3(file) {
  const data = fs.readFileSync(file);
  const start = id3v2End(data.subarray(0, 10));
  const info = parseMp3Head(data.subarray(start, start + 16384), start);
  if (!info || info.tag !== 'Info') throw new Error('no CBR length header found');
  const ffo = info.ffo, size = info.hdr.size;
  if (parseFrameHeader(data, ffo + size) === null) throw new Error("the frame after the header isn't valid audio");
  const out = Buffer.concat([data.subarray(0, ffo), data.subarray(ffo + size)]);
  let end = out.length;
  if (out.length >= 128 && out.toString('latin1', out.length - 128, out.length - 125) === 'TAG') end -= 128;
  let p = ffo, n = 0;
  const rates = new Set();
  while (p + 4 <= end) {
    const hh = parseFrameHeader(out, p);
    if (!hh) break;
    rates.add(hh.kbps); n++; p += hh.size;
  }
  if (n === 0 || rates.size !== 1 || p < end) throw new Error("audio isn't constant-bitrate or has unexpected data after it");
  return { data: out, msg: `removed the ${info.hdr.kbps} kbps length-header frame (${size} bytes); ${n} audio frames untouched` };
}

function verifyMp3(tmp) {
  const fd = fs.openSync(tmp, 'r');
  try {
    const start = id3v2End(readAt(fd, 0, 10));
    const info = parseMp3Head(readAt(fd, start, 16384), start);
    if (!info || info.tag === 'Info' || info.tag === 'Xing') throw new Error('verification: header frame still present');
  } finally { fs.closeSync(fd); }
}

// ------------------------------------------------------------------ M4A
function* children(buf, s, e) {
  let p = s;
  while (p + 8 <= e) {
    let sz = buf.readUInt32BE(p);
    const typ = buf.toString('latin1', p + 4, p + 8);
    let hl = 8;
    if (sz === 1) { sz = Number(buf.readBigUInt64BE(p + 8)); hl = 16; }
    else if (sz === 0) sz = e - p;
    if (sz < hl || p + sz > e) return;
    yield [typ, p, hl, sz];
    p += sz;
  }
}
function findBox(buf, s, e, pathArr) {
  for (const [typ, p, hl, sz] of children(buf, s, e)) {
    if (typ === pathArr[0]) {
      if (pathArr.length === 1) return [p, hl, sz];
      const r = findBox(buf, p + hl, p + sz, pathArr.slice(1));
      if (r) return r;
    }
  }
  return null;
}

function parseM4a(file) {
  const size = fs.statSync(file).size;
  let moov = null;
  const fd = fs.openSync(file, 'r');
  try {
    let pos = 0;
    while (pos + 8 <= size) {
      const h = readAt(fd, pos, 16);
      if (h.length < 8) break;
      let bs = h.readUInt32BE(0), hl = 8;
      const typ = h.toString('latin1', 4, 8);
      if (bs === 1 && h.length >= 16) { bs = Number(h.readBigUInt64BE(8)); hl = 16; }
      else if (bs === 0) bs = size - pos;
      if (bs < hl) break;
      if (typ === 'moov') { moov = { base: pos, buf: readAt(fd, pos, bs), hl }; break; }
      pos += bs;
    }
  } finally { fs.closeSync(fd); }
  if (!moov) return null;
  const { base, buf: mb, hl: mhl } = moov;
  const ms = mhl, me = mb.length;
  const mv = findBox(mb, ms, me, ['mvhd']);
  if (!mv) return null;
  let p = mv[0], ts, du;
  if (mb[p + 8] === 1) { ts = mb.readUInt32BE(p + 28); du = Number(mb.readBigUInt64BE(p + 32)); }
  else { ts = mb.readUInt32BE(p + 20); du = mb.readUInt32BE(p + 24); }
  const res = { mvhd: ts ? du / ts : 0, mts: null, N: null, smpb: null, span: null, text: null };
  for (const [typ, tp, thl, tsz] of children(mb, ms, me)) {
    if (typ !== 'trak') continue;
    const hd = findBox(mb, tp + thl, tp + tsz, ['mdia', 'hdlr']);
    if (hd && mb.toString('latin1', hd[0] + 16, hd[0] + 20) !== 'soun') continue;
    const md = findBox(mb, tp + thl, tp + tsz, ['mdia', 'mdhd']);
    const st = findBox(mb, tp + thl, tp + tsz, ['mdia', 'minf', 'stbl', 'stts']);
    if (!md || !st) continue;
    const q0 = md[0];
    const mts = mb[q0 + 8] === 1 ? mb.readUInt32BE(q0 + 28) : mb.readUInt32BE(q0 + 20);
    const cnt = mb.readUInt32BE(st[0] + 12);
    let tot = 0, q = st[0] + 16;
    for (let i = 0; i < cnt; i++) { tot += mb.readUInt32BE(q) * mb.readUInt32BE(q + 4); q += 8; }
    res.mts = mts; res.N = tot;
    break;
  }
  const ud = findBox(mb, ms, me, ['udta', 'meta']);
  if (ud) {
    const il = findBox(mb, ud[0] + ud[1] + 4, ud[0] + ud[2], ['ilst']);
    if (il) {
      for (const [t, ip, ih, isz] of children(mb, il[0] + il[1], il[0] + il[2])) {
        if (t !== '----') continue;
        let name = null, data = null;
        for (const [t2, p2, h2, s2] of children(mb, ip + ih, ip + isz)) {
          if (t2 === 'name') name = mb.toString('utf8', p2 + h2 + 4, p2 + s2);
          else if (t2 === 'data') data = [p2 + h2 + 8, p2 + s2];
        }
        if (name === 'iTunSMPB' && data) {
          const text = mb.toString('utf8', data[0], data[1]);
          const tk = text.trim().split(/\s+/);
          const a = parseInt(tk[1], 16), b = parseInt(tk[2], 16), c = parseInt(tk[3], 16);
          if ([a, b, c].every(Number.isFinite)) {
            res.smpb = [a, b, c]; res.span = [base + data[0], base + data[1]]; res.text = text;
          }
          break;
        }
      }
    }
  }
  return res;
}

function m4aProblem(i) {
  if (!i || !i.smpb || !i.N || !i.mts) return null;
  const [pr, pad, valid] = i.smpb, ts = i.mts;
  const diff = valid / ts - i.mvhd;
  if (Math.abs(diff) > 0.3) {
    return [CAT_M4A, `gapless tag says ${(valid / ts).toFixed(1)} s but the song is ${i.mvhd.toFixed(1)} s long (Macs read the tag, Windows ignores it, so they disagree)`];
  }
  const gap = i.N - (valid + pr + pad);
  if (gap !== 0) {
    return [CAT_MINOR, `gapless tag doesn't add up - off by ${Math.floor(Math.abs(gap) / 1024) || 1} audio frame(s) (${(Math.abs(gap) / ts * 1000).toFixed(0)} ms)`];
  }
  return null;
}

function planM4aTag(i, minor) {
  const N = i.N, ts = i.mts;
  const [pr0, pad0] = i.smpb;
  if (minor) { const v = N - pr0 - pad0; return v > 0 ? [pr0, pad0, v] : null; }
  const pr = (pr0 >= 1024 && pr0 <= 4096) ? pr0 : 2112;
  const first = (pad0 >= 0 && pad0 < 2048) ? pad0 : 0;
  const cands = [first]; for (let x = 0; x < 1024; x += 8) cands.push(x);
  for (const strict of [true, false]) {
    for (const pd of cands) {
      const v = N - pr - pd;
      if (v <= 0) continue;
      const reads = [i.mvhd, N / ts, (N - 2112) / ts, v / ts, (N - pr) / ts];
      if (allEqual(reads.map(Math.floor)) && (!strict || allEqual(reads.map(pyRound)))) return [pr, pd, v];
    }
  }
  return null;
}

function fixM4a(file, minor) {
  const i = parseM4a(file);
  if (!i || !i.smpb || !i.span) throw new Error('no gapless tag found');
  const plan = planM4aTag(i, minor);
  if (!plan) throw new Error("couldn't work out safe tag values");
  const data = fs.readFileSync(file);
  const [s, e] = i.span;
  const text = data.toString('utf8', s, e);
  const re = /\S+/g;
  const toks = []; let m;
  while ((m = re.exec(text)) !== null) toks.push({ a: m.index, b: m.index + m[0].length });
  let chars = text.split('');
  [1, 2, 3].forEach((idx, k) => {
    const { a, b } = toks[idx];
    const rep = plan[k].toString(16).toUpperCase().padStart(b - a, '0');
    if (rep.length !== b - a) throw new Error("new value doesn't fit the tag");
    chars.splice(a, b - a, ...rep.split(''));
  });
  const newText = chars.join('');
  if (Buffer.byteLength(newText, 'utf8') !== e - s) throw new Error('tag length would change');
  const out = Buffer.from(data);
  out.write(newText, s, 'utf8');
  return { data: out, msg: `gapless tag ${(i.smpb[2] / i.mts).toFixed(1)} s -> ${(plan[2] / i.mts).toFixed(1)} s (song is ${i.mvhd.toFixed(1)} s); only those 3 numbers changed` };
}

function verifyM4a(tmp, original, minor) {
  const a = parseM4a(original), b = parseM4a(tmp);
  if (!b || !b.smpb) throw new Error('verification: tag unreadable after the change');
  const [pr, pad, v] = b.smpb;
  if (v + pr + pad !== b.N) throw new Error("verification: tag still doesn't add up");
  if (a.mvhd !== b.mvhd || a.N !== b.N) throw new Error('verification: file structure changed');
  if (!minor) {
    const ts = b.mts;
    const reads = [b.mvhd, b.N / ts, (b.N - 2112) / ts, v / ts];
    if (!allEqual(reads.map(Math.floor))) throw new Error('verification: lengths still disagree');
  }
}

// ------------------------------------------------------------------ folder scan / fix
function isAppleDouble(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try { const b = readAt(fd, 0, 4); return b.length === 4 && b[0] === 0 && b[1] === 5 && b[2] === 0x16 && b[3] === 7; }
    finally { fs.closeSync(fd); }
  } catch { return false; }
}

function listAudioAndJunk(root) {
  const audio = [], junk = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '__MACOSX') junk.push([full, 'dir']);
        else walk(full);
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name).toLowerCase();
        if (ent.name === '.DS_Store') junk.push([full, 'ds']);
        else if (ent.name.startsWith('._') && isAppleDouble(full)) junk.push([full, 'ad']);
        else if (ext === '.mp3' || ext === '.m4a') audio.push(full);
      }
    }
  };
  walk(root);
  return { audio, junk };
}

const JUNK_TEXT = {
  dir: ["'__MACOSX' folder - leftover Mac metadata from unzipping", 'Remove the folder'],
  ds: ['.DS_Store - Mac folder-settings file', 'Remove the file'],
  ad: ["Mac '._' companion file - not audio, and it can show up as a broken track if it's named like a song", 'Remove the file'],
};

async function scanFolder(root, progress) {
  const res = { issues: [], nMp3: 0, nM4a: 0, errors: [] };
  const { audio, junk } = listAudioAndJunk(root);
  const total = audio.length;
  for (const [p, kind] of junk) {
    const [problem, fix] = JUNK_TEXT[kind];
    res.issues.push({ cat: CAT_JUNK, path: p, rel: path.relative(root, p), problem, fix, kind: 'junk-' + kind });
  }
  let n = 0;
  for (const p of audio) {
    n++;
    const rel = path.relative(root, p);
    if (progress && (n % 5 === 0 || n === total)) { progress(n, total, rel); await yieldToUi(); }
    try {
      if (p.toLowerCase().endsWith('.mp3')) {
        res.nMp3++;
        const probs = scanMp3(p);
        if (probs.length) res.issues.push({ cat: CAT_MP3, path: p, rel, problem: probs.join('; '), fix: 'Remove the length-header frame', kind: 'mp3' });
      } else {
        res.nM4a++;
        const pr = m4aProblem(parseM4a(p));
        if (pr) res.issues.push({ cat: pr[0], path: p, rel, problem: pr[1], fix: 'Correct the gapless tag numbers', kind: pr[0] === CAT_MINOR ? 'm4a-minor' : 'm4a' });
      }
    } catch (ex) { res.errors.push(`${rel}: ${ex.message}`); }
  }
  res.issues.sort((a, b) => (CAT_ORDER.indexOf(a.cat) - CAT_ORDER.indexOf(b.cat)) || a.rel.toLowerCase().localeCompare(b.rel.toLowerCase()));
  res.nAudio = res.nMp3 + res.nM4a;
  return res;
}

function defaultBackupRoot(root) {
  root = path.resolve(root);
  const d = new Date(), z = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
  const name = path.basename(root), parent = path.dirname(root);
  if (!name || parent === root) return path.join(root, 'Local Files Fixer backup ' + stamp);
  return path.join(parent, `${name} - backup ${stamp}`);
}

function moveAny(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try { fs.renameSync(src, dst); }
  catch { fs.cpSync(src, dst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
}

function fixIssue(issue, root, backupRoot) {
  const file = issue.path;
  if (issue.kind.startsWith('junk-')) {
    if (backupRoot) { moveAny(file, path.join(backupRoot, issue.rel)); return 'moved to backup'; }
    fs.rmSync(file, { recursive: true, force: true });
    return 'deleted';
  }
  let result, verifier;
  if (issue.kind === 'mp3') { result = fixMp3(file); verifier = (t) => verifyMp3(t); }
  else { const minor = issue.kind === 'm4a-minor'; result = fixM4a(file, minor); verifier = (t) => verifyM4a(t, file, minor); }
  const tmp = file + '.fixing';
  try {
    fs.writeFileSync(tmp, result.data);
    verifier(tmp);
    if (backupRoot) {
      const dst = path.join(backupRoot, issue.rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const st = fs.statSync(file);
      fs.copyFileSync(file, dst);
      fs.utimesSync(dst, st.atime, st.mtime);
    }
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) { try { fs.rmSync(tmp); } catch { /* ignore */ } }
  }
  return result.msg;
}

module.exports = {
  CATEGORY_LABELS, CATEGORY_DEFAULT_ON, CAT_MP3, CAT_M4A, CAT_JUNK, CAT_MINOR,
  scanFolder, fixIssue, defaultBackupRoot,
};
