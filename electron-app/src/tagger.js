'use strict';
// Tag songs: match audio files to rows of a public Google-Sheets song tracker and write
// title / artist / album / cover art into the files.
//
// This is a pure-JavaScript port of ../tagger.py, so the app needs no Python (and on a Mac no
// Apple "command line developer tools") at all. Tags are written by node-taglib-sharp, which is
// bundled inside the app.
const fs = require('fs');
const path = require('path');

const UA = { 'User-Agent': 'Mozilla/5.0 (LocalFilesFixer tagger)' };
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav']);
let MAIN_ARTIST = 'Playboi Carti'; // used when a row has no "Artist - " prefix

async function get(url, { binary = false, timeout = 60 } = {}) {
  const r = await fetch(url, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(timeout * 1000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return binary ? buf : buf.toString('utf8');
}

// ------------------------------------------------------------------ helpers (Python-compatible)
const stripMarks = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '');
const norm = (s) => stripMarks(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const eraKey = norm;
const EMOJI = /[\u{1F000}-\u{1FAFF}←-⇿⌀-⏿①-⓿■-➿⤀-⥿⬀-⯿〰〽㊗㊙︀-️‍⃣\u{E0020}-\u{E007F}]/gu;
const stripEmoji = (s) => (s || '').replace(EMOJI, '').replace(/[ \t]{2,}/g, ' ').trim();
const cleanEra = (s) => stripEmoji(s).replace(/\[(V\d+)\]/g, '$1').replace(/\s+/g, ' ').trim();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unescapeHtml = (s) => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&(lt|gt|quot|apos|nbsp|amp);/g, (_, n) => ({ lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', amp: '&' }[n]));

function stripLead(s) { // drop leading emoji / status symbols and trailing asterisks
  s = s.trim();
  const chars = Array.from(s);
  let i = 0;
  while (i < chars.length && !(/[\p{L}\p{N}]/u.test(chars[i]) || '([$@\'"#&'.includes(chars[i]))) i++;
  return chars.slice(i).join('').trim().replace(/\*+$/, '').trim();
}

function splitPeople(txt) {
  const out = [];
  for (let p of txt.split(/,|&|\band\b|\bx\b(?=\s)/)) {
    p = (p || '').trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

const isTrackerWord = (w) => ['tracker', 'trackers'].includes(stripMarks(w).toLowerCase().replace(/[^a-z]/g, ''));
const cleanArtistName = (s) => (s || '').split(/\s+/).filter((w) => w && !isTrackerWord(w)).join(' ').trim().replace(/^[ \-|:]+|[ \-|:]+$/g, '');

const AKA = /(?:also\s+known\s+as|a\.?k\.?a\.?|alternately\s+(?:titled|known\s+as)|alternatively\s+(?:titled|known\s+as)|previously\s+(?:titled|known\s+as)|originally\s+(?:titled|named|called)|(?:was\s+)?(?:also\s+)?(?:titled|named|called))\s*[:\-]?\s*["“‘']([^"”’'\n]{2,60})["”’']/gi;

function findAltNames(lines, notes, baseTitle) {
  const alts = [];
  for (const l of lines.slice(1)) {
    if (/^\(\s*(feat|ft|with|prod|ref|remix|cover)\b/i.test(l)) continue;
    const m = /^\((.+)\)$/.exec(l);
    if (!m || /\b(feat|prod)\./i.test(m[1])) continue;
    for (let part of m[1].split(/\s*,\s*/)) {
      part = part.replace(/^[ "'*]+|[ "'*]+$/g, '');
      if (part && part.toLowerCase() !== baseTitle.toLowerCase() && !alts.includes(part)) alts.push(part);
    }
  }
  if (!alts.length) {
    for (const m of (notes || '').matchAll(AKA)) {
      const part = m[1].trim();
      if (part && part.toLowerCase() !== baseTitle.toLowerCase() && !alts.includes(part)) alts.push(part);
    }
  }
  return alts;
}

function parseNameCell(cell, notes = '') {
  const lines = stripEmoji(cell).replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let first = lines.length ? stripLead(lines[0]) : '';
  const rest = lines.slice(1).join(' ');
  let prefix = null;
  const m = /^(.+?)\s+-\s+(.+)$/.exec(first);
  if (m) { prefix = m[1].trim(); first = m[2].trim(); }
  let ver = null;
  const vm = /\[\s*(V\d+)\s*\]/i.exec(first);
  if (vm) ver = vm[1].toUpperCase();
  let base = first.replace(/\[\s*V\d*\??\s*\]/gi, '');
  base = base.replace(/\[([^\]]*)\]/g, '$1');
  base = base.replace(/\s+/g, ' ').trim().replace(/\*+$/, '').trim();
  const title = ver ? `${base} ${ver}` : base;
  let feats = [];
  for (const fm of rest.matchAll(/\((?:feat\.?|ft\.?|with)\s+([^)]*)\)/gi)) feats = feats.concat(splitPeople(fm[1]));
  const artists = [];
  for (let a of (prefix ? splitPeople(prefix) : (MAIN_ARTIST ? [MAIN_ARTIST] : [])).concat(feats)) {
    a = cleanArtistName(a);
    if (a && !artists.some((x) => x.toLowerCase() === a.toLowerCase())) artists.push(a);
  }
  if (prefix && MAIN_ARTIST && !artists.some((x) => x.toLowerCase() === MAIN_ARTIST.toLowerCase()) && new RegExp(escRe(MAIN_ARTIST), 'i').test(rest)) {
    artists.push(MAIN_ARTIST);
  }
  const alts = findAltNames(lines, notes, base).map((a) => (ver ? `${a} ${ver}` : a));
  return { title, base, ver, artists, alts, key: norm(title), key_artist: norm((prefix || '') + title), alt_keys: alts.map(norm) };
}

function parseLen(s) {
  const m = /^\s*(\d+):(\d{2})(?::(\d{2}))?\s*$/.exec(s || '');
  if (!m) return null;
  const a = +m[1], b = +m[2];
  return m[3] !== undefined ? a * 3600 + b * 60 + +m[3] : a * 60 + b;
}

function parseCsv(text) { // RFC-4180-ish CSV -> array of rows
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(f); f = ''; rows.push(row); row = [];
    } else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const SKIP_TABS = ['art', 'merch', 'interview', 'video', 'tour', 'social', 'key', 'buys', 'tracklist', 'compilation', 'performance', 'album copies', 'fakes', 'fan edit', 'stem'];

function parseSongRows(rows) {
  if (!rows.length) return [];
  const hdr = rows[0].map((h) => h.split('\n')[0].trim().toLowerCase());
  const col = (...names) => { const i = hdr.findIndex((h) => names.some((n) => h.startsWith(n))); return i < 0 ? null : i; };
  const cName = col('name');
  if (cName === null) return [];
  const cEra = 0, cLen = col('track length', 'length'), cNotes = col('notes');
  const out = [];
  for (const r of rows.slice(1)) {
    if (r.length <= cName || !r[cName].trim() || !(r[cEra] || '').trim()) continue;
    const p = parseNameCell(r[cName], cNotes !== null && r.length > cNotes ? r[cNotes] : '');
    if (!p.title) continue;
    if (r[cEra].trim().includes('\n') || /Total (Full|Released)|OG File/.test(r[cEra])) continue; // an era header row
    p.era = stripEmoji(r[cEra]).trim();
    p.len = cLen !== null && r.length > cLen ? parseLen(r[cLen]) : null;
    p.raw = r[cName].split('\n')[0];
    p.main_artist = MAIN_ARTIST;
    out.push(p);
  }
  return out;
}

const parseLink = (link) => {
  const m = /\/spreadsheets\/d\/([\w-]+)/.exec(link);
  if (!m) throw new Error("That doesn't look like a Google Sheets link.");
  const g = /[#&?]gid=(\d+)/.exec(link);
  return [m[1], g ? g[1] : '0'];
};

async function listTabs(sid) {
  try {
    const h = await get(`https://docs.google.com/spreadsheets/d/${sid}/htmlview`);
    return [...h.matchAll(/items\.push\(\{name: "([^"]*)".*?gid: "(\d+)"/gs)].map((m) => [m[2], m[1].replace(/\\x26/g, '&')]);
  } catch { return []; }
}

async function sheetArtist(sid) {
  let t;
  try {
    const h = await get(`https://docs.google.com/spreadsheets/d/${sid}/htmlview`);
    t = unescapeHtml(/<title>(.*?)<\/title>/s.exec(h)[1]);
  } catch { return ''; }
  t = t.replace(/\s*-\s*Google (Drive|Sheets).*$/, '');
  t = stripEmoji(t).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ');
  t = t.replace(/\b(song|songs|music|unreleased|leaks?|the|official|spreadsheet|sheet|tracker|trackers|archive|database|\d{4})\b/gi, ' ');
  return t.replace(/\s+/g, ' ').trim().replace(/^[ \-|:]+|[ \-|:]+$/g, '');
}

async function loadTracker(link, say, allTabs, artist) {
  const [sid, gid] = parseLink(link);
  MAIN_ARTIST = cleanArtistName((artist || '').trim() || (await sheetArtist(sid)) || MAIN_ARTIST) || MAIN_ARTIST;
  say('Downloading tracker rows...');
  const rows = parseCsv(await get(`https://docs.google.com/spreadsheets/d/${sid}/gviz/tq?tqx=out:csv&gid=${gid}`));
  if (!rows.length) throw new Error('The tracker tab came back empty (is the sheet shared publicly?).');
  const songs = parseSongRows(rows);
  const order = songs.map((s) => s.era).filter((x, i) => i === 0 || x !== songs[i - 1].era);
  const allTabList = allTabs ? await listTabs(sid) : [];
  if (allTabs) {
    const tabs = allTabList.filter(([g, n]) => g !== gid && !SKIP_TABS.some((k) => stripEmoji(n).toLowerCase().includes(k)));
    for (let i = 0; i < tabs.length; i++) {
      say(`Reading other tabs (${i + 1}/${tabs.length}): ${stripEmoji(tabs[i][1])}...`);
      try { songs.push(...parseSongRows(parseCsv(await get(`https://docs.google.com/spreadsheets/d/${sid}/gviz/tq?tqx=out:csv&gid=${tabs[i][0]}`)))); } catch { /* skip tab */ }
    }
  }
  say(`${songs.length} tracker rows. Looking up album covers...`);
  const covers = await loadCovers(sid, gid);
  return { songs, covers, sid, gid, artist: MAIN_ARTIST, tabs: allTabs ? allTabList.map((t) => t[0]) : [gid], scanned: new Set([gid]) };
}

const splitLinks = (s) => (Array.isArray(s) ? s : String(s || '').split(/[\n,]+/)).map((l) => l.trim()).filter(Boolean);

async function loadTrackers(links, progress, allTabs = true, artist = null) {
  links = splitLinks(links);
  if (!links.length) throw new Error('No tracker link given.');
  const say = progress || (() => {});
  const songs = [], covers = new Map(), sources = [], artists = [];
  for (let i = 0; i < links.length; i++) {
    const lead = links.length > 1 ? `[${i + 1}/${links.length}] ` : '';
    const one = await loadTracker(links[i], (s) => say(lead + s), allTabs, artist);
    songs.push(...one.songs);
    for (const [k, v] of one.covers) if (!covers.has(k)) covers.set(k, v);
    sources.push({ sid: one.sid, gid: one.gid, tabs: one.tabs, scanned: one.scanned });
    const a = cleanArtistName(one.artist);
    if (a && !artists.includes(a)) artists.push(a);
  }
  return { songs, covers, sources, artist: artists.join(', ') };
}

const cellText = (c) => unescapeHtml(c.replace(/<br>/g, '\n').replace(/<[^>]+>/g, '\n'));
const trRows = (h) => [...h.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map((m) => m[1]);
const tdCells = (tr) => [...tr.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]);
const firstLine = (t) => t.split('\n').map((l) => l.trim()).find(Boolean) || '';
const bigCover = (u) => u.replace(/=w\d+-h\d+$/, '=s1200');

async function loadCovers(sid, gid) {
  const covers = new Map();
  let h;
  try { h = await get(`https://docs.google.com/spreadsheets/d/${sid}/htmlview/sheet?headers=true&gid=${gid}`, { timeout: 120 }); } catch { return covers; }
  let pending = null; // a header whose era name is only inside a banner image: take it from the next song row
  for (const tr of trRows(h)) {
    const cells = tdCells(tr);
    if (cells.length < 2) continue;
    const isHead = cells[0].includes('Total Full') || cells[0].includes('Total Released');
    if (!isHead) {
      if (pending !== null) {
        const era = firstLine(cellText(cells[0]));
        if (era && !/\d+ (Single|Total|OG)/.test(era)) {
          if (!covers.has(eraKey(stripEmoji(era)))) covers.set(eraKey(stripEmoji(era)), { era: stripEmoji(era), url: pending });
          pending = null;
        }
      }
      continue;
    }
    pending = null;
    const era = firstLine(cellText(cells[1]));
    let cover = null;
    for (const c of cells.slice(2, 6)) {
      const m = /<img src="([^"]+sheets-images-rt[^"]+)"/.exec(c);
      if (m) cover = bigCover(m[1]);
    }
    if (!cover) continue;
    if (era) { if (!covers.has(eraKey(stripEmoji(era)))) covers.set(eraKey(stripEmoji(era)), { era: stripEmoji(era), url: cover }); } else pending = cover;
  }
  return covers;
}

function scanCovers(h, known, covers) {
  for (const tr of trRows(h)) {
    if (!tr.includes('sheets-images-rt')) continue;
    let era = null;
    for (const c of tdCells(tr)) {
      for (const line of cellText(c).split('\n')) {
        const k = eraKey(stripEmoji(line));
        if (known.has(k) && !covers.has(k)) { era = [k, stripEmoji(line).trim()]; break; }
      }
      if (era) break;
    }
    if (!era) continue;
    const urls = [...tr.matchAll(/<img src="([^"]+sheets-images-rt[^"]+)"/g)].map((m) => m[1]);
    urls.sort((a, b) => (a.includes('=w425') ? 1 : 0) - (b.includes('=w425') ? 1 : 0));
    if (urls.length) covers.set(era[0], { era: era[1], url: bigCover(urls[0]) });
  }
}

// ---- difflib equivalents
function matchingChars(a, b) {
  const rec = (alo, ahi, blo, bhi) => {
    let best = 0, bi = 0, bj = 0, prev = new Array(bhi - blo + 1).fill(0);
    for (let i = alo; i < ahi; i++) {
      const cur = new Array(bhi - blo + 1).fill(0);
      for (let j = blo; j < bhi; j++) {
        if (a[i] === b[j]) {
          const k = prev[j - blo] + 1; // length of the match ending at (i-1, j-1) plus this one
          cur[j - blo + 1] = k;
          if (k > best) { best = k; bi = i - k + 1; bj = j - k + 1; }
        }
      }
      prev = cur;
    }
    if (!best) return 0;
    return best + (bi > alo && bj > blo ? rec(alo, bi, blo, bj) : 0) + (bi + best < ahi && bj + best < bhi ? rec(bi + best, ahi, bj + best, bhi) : 0);
  };
  return rec(0, a.length, 0, b.length);
}
const ratio = (a, b) => (a.length + b.length ? (2 * matchingChars(a, b)) / (a.length + b.length) : 1);
function closeMatches(word, possibilities, n, cutoff) {
  const scored = [];
  for (const x of possibilities) {
    const r = ratio(x, word);
    if (r >= cutoff) scored.push([r, x]);
  }
  scored.sort((p, q) => (q[0] - p[0]) || (q[1] < p[1] ? -1 : q[1] > p[1] ? 1 : 0));
  return scored.slice(0, n).map((p) => p[1]);
}

const STOP = new Set(['the', 'with', 'era', 'collab', 'collaboration', 'collaborations', 'and', 'of', 'a', 'feat']);
const tokens = (s) => new Set((s.normalize('NFKD').toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOP.has(w)));

function findCover(tracker, era) {
  const covers = tracker.covers, k = eraKey(era);
  if (covers.has(k)) return covers.get(k);
  const want = tokens(era);
  let best = null, score = 0;
  for (const [key, c] of covers) {
    const have = tokens(c.era);
    let sc = 0;
    if (want.size && have.size) {
      const inter = [...want].filter((w) => have.has(w)).length;
      sc = inter / new Set([...want, ...have]).size;
    }
    sc = Math.max(sc, ratio(k, key) - 0.2);
    if (sc > score) { best = c; score = sc; }
  }
  return score >= 0.5 ? best : null;
}

async function ensureCovers(tracker, eras) {
  const known = new Set([...eras].map(eraKey));
  const covers = tracker.covers;
  const have = () => [...known].every((k) => covers.has(k));
  for (const src of tracker.sources || []) {
    if (have()) break;
    for (const g of [src.gid, ...src.tabs.filter((x) => x !== src.gid)]) {
      if (have()) break;
      if (src.scanned.has(g) && g !== src.gid) continue;
      let h;
      try { h = await get(`https://docs.google.com/spreadsheets/d/${src.sid}/htmlview/sheet?headers=true&gid=${g}`, { timeout: 120 }); } catch { continue; }
      src.scanned.add(g);
      scanCovers(h, known, covers);
    }
  }
}

// ------------------------------------------------------------------ matching
function fileStemInfo(p) {
  let stem = path.basename(p, path.extname(p));
  stem = stripEmoji(stem.normalize('NFC'));
  stem = stripLead(stem.trimEnd().endsWith('_') ? stem.replace(/_/g, '*') : stem);
  stem = stem.replace(/^\d+[-.]?\d*\s+/, '');
  const v = stem.replace(/\[\s*(V\d+)\s*\]/gi, '$1').replace(/\[([^\]]*)\]/g, '$1');
  return { stem, key: norm(v) };
}

let taglib = null;
// node-taglib-sharp crashes when saving an .m4a that has no "udta" (tag) box yet - an empty box has no
// parent tree to read. Give such a box an empty tree plus a harmless [-1] entry, so the library takes its
// "append a new udta at the end of moov" path instead.
function patchMp4NoUdta() {
  try {
    const Box = require('node-taglib-sharp/dist/mpeg4/boxes/isoUserDataBox').default;
    const orig = Box.fromEmpty;
    Box.fromEmpty = function () {
      const box = orig.call(this);
      Object.defineProperty(box, 'parentTree', {
        get() { const a = []; a[-1] = { totalBoxSize: 0, position: 0 }; return a; },
        set() {}, configurable: true,
      });
      return box;
    };
    // ...and its freshly made "hdlr" box is rendered with no name, which it then refuses to write.
    const Hdlr = require('node-taglib-sharp/dist/mpeg4/boxes/isoHandlerBox').default;
    const origH = Hdlr.fromHandlerTypeAndHandlerName;
    Hdlr.fromHandlerTypeAndHandlerName = function (type, name) { return origH.call(this, type, name || ''); };
  } catch { /* library layout changed: fall back to its own behaviour */ }
}
function lib() {
  if (!taglib) {
    taglib = require('node-taglib-sharp');
    taglib.Id3v2Settings.defaultVersion = 3; // ID3v2.3 - what players and Spotify read best
    taglib.Id3v2Settings.forceDefaultVersion = true;
    patchMp4NoUdta();
  }
  return taglib;
}

function audioLength(p) {
  let f;
  try { f = lib().File.createFromPath(p); const ms = f.properties.durationMilliseconds; return ms > 0 ? ms / 1000 : null; } catch { return null; } finally { try { f && f.dispose(); } catch { /* ignore */ } }
}

const stripVer = (k) => k.replace(/v\d+$/, '');
const overlaps = (a, b, minLen = 4) => (!a || !b || a.length < minLen || b.length < minLen ? a === b : a.includes(b) || b.includes(a));

function matchFile(p, tracker, eraHint) {
  const info = fileStemInfo(p), dur = audioLength(p), songs = tracker.songs, key = info.key;
  const altKeys = (s) => s.alt_keys || [];
  let cands = songs.filter((s) => key === s.key || key === s.key_artist);
  let how = 'name';
  if (!cands.length) { cands = songs.filter((s) => altKeys(s).includes(key)); if (cands.length) how = 'alternate name'; }
  if (!cands.length) {
    const nov = stripVer(key);
    cands = songs.filter((s) => nov && (nov === stripVer(s.key) || nov === stripVer(s.key_artist)));
    how = 'name (version differs)';
    if (!cands.length) {
      cands = songs.filter((s) => nov && altKeys(s).some((k) => nov === stripVer(k)));
      if (cands.length) how = 'alternate name (version differs)';
    }
  }
  if (!cands.length) {
    cands = songs.filter((s) => overlaps(key, s.key) || overlaps(key, s.key_artist) || altKeys(s).some((k) => overlaps(key, k)));
    if (cands.length) how = 'name contains / is within the tracker title';
  }
  if (!cands.length) {
    const keys = new Map();
    for (const s of songs) for (const k of [s.key, s.key_artist, ...altKeys(s)]) if (!keys.has(k)) keys.set(k, s);
    cands = closeMatches(key, [...keys.keys()], 3, 0.86).map((k) => keys.get(k));
    how = 'close name';
  }
  if (!cands.length) return [null, 'no song with that name on the tracker', null];
  const score = (s) => {
    let sc = 0;
    if (eraHint && eraKey(s.era) === eraHint) sc -= 1000;
    if (dur && s.len) sc += Math.min(Math.abs(dur - s.len), 60);
    else if (s.len === null) sc += 30;
    if (![s.key, s.key_artist, ...altKeys(s)].includes(key)) sc += 5;
    return sc;
  };
  cands.sort((x, y) => score(x) - score(y));
  const best = cands[0];
  let note = how;
  if (dur && best.len) {
    const d = Math.abs(dur - best.len);
    note += `, length ${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')} vs tracker ${Math.floor(best.len / 60)}:${String(best.len % 60).padStart(2, '0')}`;
    if (d > 6) note += ' (differs)';
  }
  const bs = score(best);
  const tied = new Set(cands.filter((c) => score(c) === bs).map((c) => JSON.stringify([c.era, c.title, c.artists])));
  if (tied.size > 1) note += `, ${cands.length} similar rows - picked first`;
  return [best, note, dur];
}

function listAudio(folder) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const files = ents.filter((e) => !e.isDirectory()).map((e) => e.name).sort();
    for (const f of files) if (!f.startsWith('._') && AUDIO_EXT.has(path.extname(f).toLowerCase())) out.push(path.join(dir, f));
    for (const e of ents) if (e.isDirectory() && e.name !== '__MACOSX') walk(path.join(dir, e.name));
  };
  walk(folder);
  return out;
}

async function plan(tracker, folder, era) {
  folder = path.resolve(folder);
  const hint = era ? eraKey(era) : eraKey(path.basename(folder));
  const matched = listAudio(folder).map((p) => [p, ...matchFile(p, tracker, hint)]);
  await ensureCovers(tracker, new Set(matched.filter((m) => m[1]).map((m) => m[1].era)));
  return matched.map(([p, song, note]) => {
    const it = { path: p, rel: path.relative(folder, p), note };
    if (song) {
      const cov = findCover(tracker, song.era);
      Object.assign(it, {
        title: song.title, alts: song.alts || [], artist: song.artists.join(', '), album: cleanEra(song.era),
        album_artist: song.main_artist || MAIN_ARTIST, cover: cov ? cov.url : null, matched: true,
      });
    } else it.matched = false;
    return it;
  });
}

// ------------------------------------------------------------------ writing
const coverCache = new Map();
async function fetchCover(url) {
  if (!coverCache.has(url)) {
    const data = fs.existsSync(url) && fs.statSync(url).isFile() ? fs.readFileSync(url) : await get(url, { binary: true });
    let mime;
    if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = 'image/png';
    else if (data[0] === 0xff && data[1] === 0xd8) mime = 'image/jpeg';
    else throw new Error('unsupported cover image format (use a JPG or PNG)');
    coverCache.set(url, { data, mime });
  }
  return coverCache.get(url);
}

async function writeTags(item) {
  const { File, Picture, PictureType, ByteVector } = lib();
  const cover = item.cover ? await fetchCover(item.cover) : null;
  const file = File.createFromPath(item.path);
  try {
    const t = file.tag;
    t.title = item.title;
    t.performers = item.artist ? [item.artist] : [];
    t.albumArtists = (item.album_artist || MAIN_ARTIST) ? [item.album_artist || MAIN_ARTIST] : [];
    t.album = item.album || "";
    if (cover) t.pictures = [Picture.fromFullData(ByteVector.fromByteArray(cover.data), PictureType.FrontCover, cover.mime, 'Cover')];
    file.save();
  } finally { file.dispose(); }
}

function defaultBackupRoot(folder) {
  folder = path.resolve(folder);
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const st = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  return path.join(path.dirname(folder), `${path.basename(folder)} - tag backup ${st}`);
}

function applyCover(items, p) { if (p) for (const it of items) if (it.matched) it.cover = p; }

function applyOverrides(items, overrides) {
  for (const it of items) {
    const o = (overrides || {})[it.rel];
    if (!o) continue;
    if (typeof o === 'string') { if (it.matched) it.title = o; continue; }
    const title = (o.title || '').trim();
    if (!title) continue;
    it.title = title; it.artist = (o.artist || '').trim(); it.album = (o.album || '').trim(); it.matched = true;
  }
}

async function apply(items, folder, backup = true, log = () => {}) {
  const root = backup ? defaultBackupRoot(folder) : null;
  let ok = 0, bad = 0;
  for (const it of items) {
    if (!it.matched) continue;
    try {
      if (root) {
        const dst = path.join(root, it.rel);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(it.path, dst);
        const st = fs.statSync(it.path); fs.utimesSync(dst, st.atime, st.mtime);
      }
      await writeTags(it);
      ok++;
      log(`TAGGED  ${it.rel} -> ${it.artist} - ${it.title} [${it.album}]` + (it.cover ? '' : ' (no cover found)'));
    } catch (e) { bad++; log(`FAILED  ${it.rel} - ${e.message || e}`); }
  }
  return { ok, bad, backup: ok && root ? root : null };
}

// One call that does what `python tagger.py ... --json` did.
async function run({ link, folder, apply: doApply, backup = true, overrides, cover, era, artist, progress }) {
  const tr = await loadTrackers(link, progress, true, artist);
  const items = await plan(tr, folder, era);
  if (overrides && Object.keys(overrides).length) applyOverrides(items, overrides);
  if (cover) applyCover(items, cover);
  const result = { items, artists: tr.artist.split(', ').filter(Boolean) };
  if (doApply) result.result = await apply(items, folder, backup);
  return result;
}

module.exports = { run, loadTrackers, plan, apply, applyOverrides, applyCover, parseNameCell, parseSongRows, parseCsv, norm, ratio, closeMatches };
