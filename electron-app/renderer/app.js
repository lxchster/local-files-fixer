'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const BADGE = { mp3: 'MP3', m4a: 'M4A', junk: 'MAC', minor: 'OPTIONAL' };

  const state = { folder: null, issues: [], selected: new Set(), phase: 'idle', fixRuns: 0, lastBackup: null };

  // ---------------------------------------------------------------- small UI helpers
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  function setStatus(text, tone) { const s = $('#status'); s.textContent = text; s.className = 'status' + (tone ? ' ' + tone : ''); }
  function setBar(frac, busy) { $('#barFill').style.width = Math.max(0, Math.min(1, frac)) * 100 + '%'; $('.bar').classList.toggle('busy', !!busy); }

  function animateNumber(node, to) {
    if (typeof to !== 'number') { node.textContent = to; return; }
    const from = parseInt(node.textContent, 10) || 0, t0 = performance.now(), dur = 600;
    const step = (t) => { const k = Math.min((t - t0) / dur, 1), e = 1 - Math.pow(1 - k, 3); node.textContent = Math.round(from + (to - from) * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }
  function setTile(k, num, sub, tone) {
    const tile = $(`.tile[data-k="${k}"]`);
    animateNumber($('.tn', tile), num);
    const s = $('.ts', tile); s.textContent = sub || ' '; s.className = 'ts' + (tone ? ' ' + tone : '');
  }
  function resetTiles() { ['scanned', 'fix', 'junk', 'opt'].forEach((k) => { const t = $(`.tile[data-k="${k}"]`); $('.tn', t).textContent = '–'; const s = $('.ts', t); s.textContent = ' '; s.className = 'ts'; }); }

  function log(text, tone) {
    const line = el('div', tone || '', text);
    const body = $('#log'); body.appendChild(line); body.scrollTop = body.scrollHeight;
    $('#logLast').textContent = text;
  }

  function setEmpty(text, cls) { const e = $('#empty'); if (text) { e.textContent = text; e.className = 'empty ' + (cls || ''); } else e.className = 'empty hide'; }

  function enabledCats() { return new Set($$('.chip input[data-cat]').filter((i) => i.checked).map((i) => i.dataset.cat)); }
  function ticked() { const c = enabledCats(); return state.issues.filter((x) => c.has(x.cat)); }

  function setPhase(p) { state.phase = p; refreshButtons(); }
  function refreshButtons() {
    const busy = state.phase === 'scanning' || state.phase === 'fixing';
    const n = ticked().length;
    $('#choose').disabled = busy;
    $('#rescan').disabled = busy || !state.folder;
    $('#fixAll').disabled = busy || n === 0;
    $('#fixAll').textContent = n ? `Fix everything ticked (${n})` : 'Fix everything ticked';
    $('#fixSel').disabled = busy || state.selected.size === 0;
    $('#fixSel').textContent = state.selected.size ? `Fix selected (${state.selected.size})` : 'Fix selected rows';
    $('#openBk').disabled = busy || !state.lastBackup;
    $('#hint').textContent = state.issues.length ? (state.selected.size ? `${state.selected.size} row(s) selected` : 'Click rows to select them') : '';
  }

  // ---------------------------------------------------------------- list
  function renderRows() {
    const box = $('#rows'); box.textContent = '';
    state.issues.forEach((x, i) => {
      const row = el('div', 'row'); row.dataset.id = x.id; row.style.animationDelay = Math.min(i, 14) * 28 + 'ms';
      row.appendChild(el('span', 'badge b-' + x.cat, BADGE[x.cat] || x.cat));
      const f = el('div'); const base = x.rel.split(/[\\/]/); const name = base.pop();
      f.appendChild(el('div', 'fname', name)); f.appendChild(el('div', 'fdir', base.join(' › ') || '(top folder)'));
      f.title = x.rel; row.appendChild(f);
      row.appendChild(el('div', 'rp', x.problem)).title = x.problem;
      row.appendChild(el('div', 'rx', x.fix));
      row.appendChild(el('div', 'tick'));
      row.addEventListener('click', () => { const id = x.id; if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id); row.classList.toggle('sel', state.selected.has(id)); refreshButtons(); });
      box.appendChild(row);
    });
  }

  // ---------------------------------------------------------------- scan
  async function scan() {
    if (!state.folder || state.phase === 'scanning' || state.phase === 'fixing') return;
    state.issues = []; state.selected.clear(); renderRows(); resetTiles();
    setBar(0, true); setStatus('Scanning…'); setEmpty('Scanning…'); setPhase('scanning');
    try {
      const res = await window.api.scan(state.folder);
      state.issues = res.issues;
      const c = (k) => res.issues.filter((x) => x.cat === k).length;
      const main = c('mp3') + c('m4a');
      renderRows();
      setTile('scanned', res.nAudio, `${res.nMp3} MP3  ·  ${res.nM4a} M4A`);
      setTile('fix', main, main ? 'MP3 + M4A problems' : 'all clear', main ? 'accent' : 'good');
      setTile('junk', c('junk'), c('junk') ? 'safe to remove' : 'none found', c('junk') ? 'warn' : '');
      setTile('opt', c('minor'), c('minor') ? 'off by default' : 'none found');
      if (!res.issues.length) { setStatus(`Scanned ${res.nAudio} audio files (${res.nMp3} MP3, ${res.nM4a} M4A) - no problems found.`, 'good'); setEmpty('✓  No problems found - this folder looks good.', 'good'); }
      else { setStatus(`Scanned ${res.nAudio} audio files (${res.nMp3} MP3, ${res.nM4a} M4A): ${main} need fixing, ${c('junk')} Mac leftovers, ${c('minor')} optional.`, 'bright'); setEmpty(null); }
      res.errors.slice(0, 20).forEach((e) => log("Couldn't read " + e, 'skip'));
      log('Scan finished: ' + $('#status').textContent);
      setBar(1, false);
    } catch (e) {
      setStatus('Scan failed: ' + e.message); setEmpty('Scan failed: ' + e.message); setBar(0, false); log('Scan failed: ' + e.message, 'skip');
    }
    setPhase('ready');
  }

  async function setFolder(p) {
    state.folder = p; state.lastBackup = null;
    const f = $('#path'); f.textContent = ''; const b = document.createElement('bdi'); b.textContent = p; f.appendChild(b); f.title = p;
    await scan();
  }

  // ---------------------------------------------------------------- confirm dialog
  function confirmDialog(title, bodyNodes, okLabel) {
    return new Promise((resolve) => {
      $('#mTitle').textContent = title;
      const body = $('#mBody'); body.textContent = ''; bodyNodes.forEach((n) => body.appendChild(typeof n === 'string' ? document.createTextNode(n) : n));
      $('#modalOk').textContent = okLabel;
      const m = $('#modal'); m.classList.add('open'); m.setAttribute('aria-hidden', 'false');
      const done = (v) => { m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); cleanup(); resolve(v); };
      const ok = () => done(true), no = () => done(false), key = (e) => { if (e.key === 'Escape') no(); };
      const cleanup = () => { $('#modalOk').removeEventListener('click', ok); $('#modalCancel').removeEventListener('click', no); document.removeEventListener('keydown', key); };
      $('#modalOk').addEventListener('click', ok); $('#modalCancel').addEventListener('click', no); document.addEventListener('keydown', key);
    });
  }

  // ---------------------------------------------------------------- fix
  async function fix(list) {
    if (!list.length || state.phase === 'scanning' || state.phase === 'fixing') return;
    const backup = $('#backup').checked;
    const b = (t) => { const e = document.createElement('b'); e.textContent = t; return e; };
    const body = backup
      ? [b(`${list.length} item(s)`), ' will be fixed. The original of every changed file is saved first, in a new folder next to ', b(state.folder.split(/[\\/]/).filter(Boolean).pop() || state.folder), '.']
      : [b('Warning: '), `${list.length} item(s) will be fixed WITHOUT a backup. The originals are overwritten (or deleted) and can't be recovered.`];
    const yes = await confirmDialog(backup ? `Fix ${list.length} item(s)?` : 'Fix without a backup?', body, 'Fix now');
    if (!yes) return;
    setPhase('fixing'); setBar(0, true); setStatus('Fixing…');
    let res;
    try { res = await window.api.fix(list.map((x) => x.id), backup); }
    catch (e) { log('Fix failed: ' + e.message, 'skip'); setStatus('Fix failed: ' + e.message); setPhase('ready'); return; }
    log(`Done: ${res.ok} fixed, ${res.bad} skipped.`);
    state.lastBackup = res.backupRoot; setPhase('ready');
    await scan();           // re-check so you can see what's left
    state.fixRuns++; refreshButtons();
  }

  // ---------------------------------------------------------------- wiring
  window.api.on('scan-progress', ({ n, t, rel }) => { if (state.phase !== 'scanning') return; setBar(n / Math.max(t, 1), true); setStatus(`Scanning ${n} / ${t}   ${rel}`); });
  window.api.on('fix-progress', ({ n, t }) => { setBar(n / Math.max(t, 1), true); setStatus(`Fixing ${n} / ${t}`); });
  window.api.on('fix-log', ({ tone, text }) => log(text, tone));

  $('#choose').addEventListener('click', async () => { const p = await window.api.pickFolder(); if (p) setFolder(p); });
  $('#rescan').addEventListener('click', scan);
  $('#fixAll').addEventListener('click', () => fix(ticked()));
  $('#fixSel').addEventListener('click', () => fix(state.issues.filter((x) => state.selected.has(x.id))));
  $('#openBk').addEventListener('click', () => window.api.openBackup(state.lastBackup));
  $$('.chip input').forEach((i) => i.addEventListener('change', refreshButtons));
  $('#logToggle').addEventListener('click', () => { const c = $('#logCard'); const open = c.classList.toggle('open'); $('#logToggle').setAttribute('aria-expanded', open); });

  // drag a folder onto the window
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0]; if (!f) return;
    const p = window.api.pathForFile(f);
    if (p && await window.api.isDir(p)) setFolder(p); else setStatus('Drop a folder, not a file.');
  });

  window.__lff = { setFolder, state: () => ({ phase: state.phase, fixRuns: state.fixRuns, issues: state.issues.length, selected: state.selected.size, status: $('#status').textContent }) };
  refreshButtons();
  window.api.initialFolder().then((p) => { if (p) setFolder(p); });
})();
