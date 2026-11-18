'use strict';
// Tag songs: match audio files to rows of a public Google-Sheets song tracker and write
// title / artist / album / cover art into the files.
//
// This is a pure-JavaScript port of ../tagger.py, so the app needs no Python (and on a Mac no
// Apple "command line developer tools") at all. Tags are written by node-taglib-sharp, which is
// bundled inside the app.
const fs = require('fs');
const path = require('path');
const tls = require('tls');
const { execFileSync } = require('child_process');
const { fetch: undiciFetch, Agent } = require('undici');

const UA = { 'User-Agent': 'Mozilla/5.0 (LocalFilesFixer tagger)' };
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav']);
let MAIN_ARTIST = 'Playboi Carti'; // used when a row has no "Artist - " prefix

// On macOS, some security software (antivirus HTTPS scanning, a corporate/VPN proxy, parental
// controls, ...) re-signs HTTPS traffic with its own root certificate. The system keychain trusts
// it (so curl/Safari work fine), but Node's own bundled CA list doesn't, which fails fetch() with
// "self signed certificate in certificate chain". Trust the system's roots on top of Node's own,
// so this app trusts exactly what the rest of the Mac already does.
let dispatcher = null;
function trustDispatcher() {
  if (dispatcher) return dispatcher;
  let ca = tls.rootCertificates;
  if (process.platform === 'darwin') {
    try {
      const dump = (args) => execFileSync('security', args, { encoding: 'utf8', maxBuffer: 1 << 26 });
      const extra = (dump(['find-certificate', '-a', '-p']) + dump(['find-certificate', '-a', '-p', '/Library/Keychains/System.keychain']))
        .match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) || [];
      if (extra.length) ca = [...ca, ...extra];
    } catch { /* couldn't read the keychain: fall back to Node's own bundled roots */ }
  }
  dispatcher = new Agent({ connect: { ca } });
  return dispatcher;
}

async function get(url, { binary = false, timeout = 60 } = {}) {
  let r;
  try {
    r = await undiciFetch(url, { headers: UA, redirect: 'follow', dispatcher: trustDispatcher(), signal: AbortSignal.timeout(timeout * 1000) });
  } catch (e) {
    // plain "fetch failed" hides the actual cause (no network, DNS, a blocked proxy, ...)
    const cause = e && e.cause && e.cause.message ? e.cause.message : e.message;
    throw new Error(`couldn't reach ${new URL(url).host} (${cause})`);
  }
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
  say('Downloading tracker rows...', 0);
  const rows = parseCsv(await get(`https://docs.google.com/spreadsheets/d/${sid}/gviz/tq?tqx=out:csv&gid=${gid}`));
  if (!rows.length) throw new Error('The tracker tab came back empty (is the sheet shared publicly?).');
  const songs = parseSongRows(rows);
  const order = songs.map((s) => s.era).filter((x, i) => i === 0 || x !== songs[i - 1].era);
  // tabs like "Art", "Merch" or "Social" carry fan art, mockups and screenshots, not official
  // covers - exclude them here too, not just for song rows, or ensureCovers() (below) can latch
  // an era onto a stray image from one of those tabs just because it happens to name that era
  const tabs = allTabs ? (await listTabs(sid)).filter(([g, n]) => g !== gid && !SKIP_TABS.some((k) => stripEmoji(n).toLowerCase().includes(k))) : [];
  const totalSteps = 1 + tabs.length + 1; // main sheet + other tabs + cover lookup
  if (allTabs) {
    for (let i = 0; i < tabs.length; i++) {
      say(`Reading other tabs (${i + 1}/${tabs.length}): ${stripEmoji(tabs[i][1])}...`, (1 + i) / totalSteps);
      try { songs.push(...parseSongRows(parseCsv(await get(`https://docs.google.com/spreadsheets/d/${sid}/gviz/tq?tqx=out:csv&gid=${tabs[i][0]}`)))); } catch { /* skip tab */ }
    }
  }
  say(`${songs.length} tracker rows. Looking up album covers...`, (totalSteps - 1) / totalSteps);
  const covers = await loadCovers(sid, gid);
  return { songs, covers, sid, gid, artist: MAIN_ARTIST, tabs: allTabs ? [gid, ...tabs.map((t) => t[0])] : [gid], scanned: new Set([gid]) };
}

const splitLinks = (s) => (Array.isArray(s) ? s : String(s || '').split(/[\n,]+/)).map((l) => l.trim()).filter(Boolean);

async function loadTrackers(links, progress, allTabs = true, artist = null) {
  links = splitLinks(links);
  if (!links.length) throw new Error('No tracker link given.');
  const say = progress || (() => {});
  const songs = [], covers = new Map(), sources = [], artists = [];
  for (let i = 0; i < links.length; i++) {
    const lead = links.length > 1 ? `[${i + 1}/${links.length}] ` : '';
    const one = await loadTracker(links[i], (s, frac) => say(lead + s, frac != null ? (i + frac) / links.length : null), allTabs, artist);
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

// True for an era-header row's first cell - a multi-line stats block ("14 Full / 0 Tagged /
// ..."), not a song title. Trackers phrase these differently, so this doesn't look for one
// specific wording: a genuine stats block is reliably multi-line (the same signal parseSongRows()
// uses for the CSV export), with a couple of known single-line phrasings as a fallback.
const isHeaderCell = (rawHtml, text) => text.trim().includes('\n') || rawHtml.includes('Total Full') || rawHtml.includes('Total Released') || rawHtml.includes('OG File');

async function loadCovers(sid, gid) {
  const covers = new Map();
  let h;
  try { h = await get(`https://docs.google.com/spreadsheets/d/${sid}/htmlview/sheet?headers=true&gid=${gid}`, { timeout: 120 }); } catch { return covers; }
  let pending = null; // a header whose era name is only inside a banner image: take it from the next song row
  for (const tr of trRows(h)) {
    const cells = tdCells(tr);
    if (cells.length < 2) continue;
    const isHead = isHeaderCell(cells[0], cellText(cells[0]));
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

// Only a genuine era-header row (the same shape loadCovers() reads on the main tab) gives that
// era its cover here - never a plain song row, even one that happens to name the era and also
// carries some unrelated image of its own (a screenshot, a feature's avatar, ...); that would
// attach that one song's picture to the whole era instead of its actual album cover.
function scanCovers(h, known, covers) {
  for (const tr of trRows(h)) {
    const cells = tdCells(tr);
    if (cells.length < 2 || !isHeaderCell(cells[0], cellText(cells[0]))) continue;
    const era = firstLine(cellText(cells[1]));
    const k = eraKey(stripEmoji(era));
    if (!era || !known.has(k) || covers.has(k)) continue;
    const urls = [];
    for (const c of cells.slice(2, 6)) urls.push(...[...c.matchAll(/<img src="([^"]+sheets-images-rt[^"]+)"/g)].map((m) => m[1]));
    urls.sort((a, b) => (a.includes('=w425') ? 1 : 0) - (b.includes('=w425') ? 1 : 0));
    if (urls.length) covers.set(k, { era: stripEmoji(era), url: bigCover(urls[0]) });
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
    // some trackers give a song a short era label ("FLXTRA") that's really just an abbreviated
    // form of the era's full name on its banner ("Flex Musix (FLXTRA)") - containment catches
    // that even when it shares too few whole words/characters to score well above otherwise
    if (overlaps(k, key)) sc = Math.max(sc, 0.8);
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

const LEN_WINDOW = 2; // seconds: a candidate this close in length to the file is treated as a sure match

// Search the whole tracker through every matching strategy - not just the first one that finds
// anything - then let scoring pick the best candidate across all of them. This avoids an early,
// narrow strategy locking in a wrong pick when a different song further down the tracker (only
// found by a looser strategy) would actually have fit this file better.
function matchFile(p, tracker, eraHint) {
  const info = fileStemInfo(p), dur = audioLength(p), songs = tracker.songs, key = info.key;
  const altKeys = (s) => s.alt_keys || [];
  const nov = stripVer(key);
  const keys = new Map();
  for (const s of songs) for (const k of [s.key, s.key_artist, ...altKeys(s)]) if (!keys.has(k)) keys.set(k, s);
  const close = closeMatches(key, [...keys.keys()], 3, 0.86).map((k) => keys.get(k));
  const tiers = [
    ['name', songs.filter((s) => key === s.key || key === s.key_artist)],
    ['alternate name', songs.filter((s) => altKeys(s).includes(key))],
    ['name (version differs)', songs.filter((s) => nov && (nov === stripVer(s.key) || nov === stripVer(s.key_artist)))],
    ['alternate name (version differs)', songs.filter((s) => nov && altKeys(s).some((k) => nov === stripVer(k)))],
    ['name contains / is within the tracker title',
      songs.filter((s) => overlaps(key, s.key) || overlaps(key, s.key_artist) || altKeys(s).some((k) => overlaps(key, k)))],
    ['close name', close],
  ];
  const cands = [], howOf = new Map();
  for (const [how, group] of tiers) {
    for (const s of group) {
      if (!howOf.has(s)) { howOf.set(s, how); cands.push(s); }
    }
  }
  if (!cands.length) return [null, 'no song with that name on the tracker', null, []];
  const score = (s) => {
    let sc = 0;
    if (eraHint && eraKey(s.era) === eraHint) sc -= 1000;
    if (dur && s.len) {
      const d = Math.abs(dur - s.len);
      // a length match within a couple of seconds is a near-certain sign of the right song, so
      // it should decisively beat a merely similar-looking title elsewhere
      sc += d <= LEN_WINDOW ? -500 + d : Math.min(d, 60);
    } else if (s.len === null) sc += 30;
    if (![s.key, s.key_artist, ...altKeys(s)].includes(key)) sc += 5;
    return sc;
  };
  cands.sort((x, y) => score(x) - score(y));
  const best = cands[0];
  let note = howOf.get(best);
  if (dur && best.len) {
    const d = Math.abs(dur - best.len);
    note += `, length ${Math.floor(dur / 60)}:${String(Math.floor(dur % 60)).padStart(2, '0')} vs tracker ${Math.floor(best.len / 60)}:${String(best.len % 60).padStart(2, '0')}`;
    if (d > 6) note += ' (differs)';
  }
  const bs = score(best);
  const tied = new Set(cands.filter((c) => score(c) === bs).map((c) => JSON.stringify([c.era, c.title, c.artists])));
  if (tied.size > 1) note += `, ${cands.length} similar rows - picked first`;
  return [best, note, dur, cands];
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

async function plan(tracker, folder, era, progress) {
  folder = path.resolve(folder);
  const hint = era ? eraKey(era) : eraKey(path.basename(folder));
  const say = progress || (() => {});
  const files = listAudio(folder);
  const matched = [];
  for (let i = 0; i < files.length; i++) {
    matched.push([files[i], ...matchFile(files[i], tracker, hint)]);
    say(`Matching files (${i + 1}/${files.length})...`, (i + 1) / Math.max(files.length, 1));
    // matchFile() is synchronous, so without yielding here the whole loop runs as one long
    // blocking stretch and no progress (or any other IPC) reaches the renderer until it's done
    if ((i + 1) % 5 === 0) await new Promise((r) => setImmediate(r));
  }
  const eras = new Set();
  for (const [, song, , , cands] of matched) {
    if (song) eras.add(song.era);
    for (const c of cands) eras.add(c.era);
  }
  say('Looking up any remaining album covers...', null);
  await ensureCovers(tracker, eras);
  return matched.map(([p, song, note, dur, cands]) => {
    const it = { path: p, rel: path.relative(folder, p), note };
    if (song) {
      const cov = findCover(tracker, song.era);
      Object.assign(it, {
        title: song.title, artist: song.artists.join(', '), album: cleanEra(song.era),
        album_artist: song.main_artist || MAIN_ARTIST, cover: cov ? cov.url : null, matched: true,
      });
      // every candidate row the matcher considered equally plausible, each with its own
      // alternate names, flattened into one pick list (index 0 is the auto-picked default).
      // The picked song always gets a slot; any OTHER candidate only gets one if its length
      // actually fits the file - otherwise the list fills up with unlikely alternatives. If the
      // file's own length couldn't be read at all, there's no window to judge by, so fall back
      // to listing every candidate rather than silently dropping them all.
      const optionCands = dur
        ? [song].concat(cands.filter((c) => c !== song && c.len !== null && Math.abs(dur - c.len) <= LEN_WINDOW))
        : cands;
      const options = [];
      for (const c of optionCands) {
        const cCov = findCover(tracker, c.era);
        const base = {
          title: c.title, artist: c.artists.join(', '), album: cleanEra(c.era),
          album_artist: c.main_artist || MAIN_ARTIST, cover: cCov ? cCov.url : null,
        };
        options.push(base);
        for (const a of c.alts || []) options.push({ ...base, title: a });
      }
      it.options = options;
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

// A string override renames a matched file to one of its alternate names. An object override
// either hand-tags a file the tracker couldn't match (title required, artist/album may be left
// blank), or switches a matched file to a different candidate match - title/artist/album and
// optionally cover, all taken from one of that file's `options` entries.
function applyOverrides(items, overrides) {
  for (const it of items) {
    const o = (overrides || {})[it.rel];
    if (!o) continue;
    if (typeof o === 'string') { if (it.matched) it.title = o; continue; }
    const title = (o.title || '').trim();
    if (!title) continue;
    it.title = title; it.artist = (o.artist || '').trim(); it.album = (o.album || '').trim();
    if ('album_artist' in o) it.album_artist = (o.album_artist || '').trim() || null;
    if ('cover' in o) it.cover = o.cover || null;
    it.matched = true;
  }
}

async function apply(items, folder, backup = true, log = () => {}, progress) {
  const root = backup ? defaultBackupRoot(folder) : null;
  const say = progress || (() => {});
  const todo = items.filter((it) => it.matched);
  let ok = 0, bad = 0;
  for (let i = 0; i < todo.length; i++) {
    const it = todo[i];
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
    say(`Writing tags (${i + 1}/${todo.length})...`, (i + 1) / Math.max(todo.length, 1));
  }
  return { ok, bad, backup: ok && root ? root : null };
}

// One call that does what `python tagger.py ... --json` did.
async function run({ link, folder, apply: doApply, backup = true, overrides, cover, excluded, era, artist, progress }) {
  const say = progress || (() => {});
  // Finding matches: the bar covers tracker-loading (0-50%) then file-matching (50-100%).
  // Writing tags: that whole lookup/match step runs again first (to rebuild `items` fresh) but
  // is fast and redundant, so it's left text-only (frac null) and the bar instead fills 0-100%
  // across the actual writing - that's the part worth watching.
  const tr = await loadTrackers(link, (text, frac) => say(text, frac != null && !doApply ? frac * 0.5 : null), true, artist);
  const items = await plan(tr, folder, era, (text, frac) => say(text, frac != null && !doApply ? 0.5 + frac * 0.5 : null));
  if (overrides && Object.keys(overrides).length) applyOverrides(items, overrides);
  if (cover) applyCover(items, cover);
  const result = { items, artists: tr.artist.split(', ').filter(Boolean) };
  if (doApply) {
    // the "Apply" checkbox lets the user keep a match/manual entry visible but leave its tags
    // untouched - treat it the same as "no match" for the purposes of writing files
    if (excluded && excluded.length) {
      const skip = new Set(excluded);
      for (const it of items) if (skip.has(it.rel)) it.matched = false;
    }
    result.result = await apply(items, folder, backup, undefined, say);
  }
  return result;
}

module.exports = { run, loadTrackers, plan, apply, applyOverrides, applyCover, fetchCover, parseNameCell, parseSongRows, parseCsv, norm, ratio, closeMatches };
