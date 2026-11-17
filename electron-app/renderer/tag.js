'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const views = { menu: $('#viewMenu'), fix: $('#viewFix'), tag: $('#viewTag'), send: $('#viewSend') };
  function go(name) { for (const k in views) views[k].hidden = k !== name; }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
  window.__lffGo = go;
  go(window.__lffStartFix ? 'fix' : 'menu');
  if (window.api && window.api.initialFolder) window.api.initialFolder().then((f) => { if (f) go('fix'); }).catch(() => {});

  let folder = null, items = [], busy = false, manual = null, trackerArtists = []; // manual = { path, name, dataUrl }
  const coverCache = new Map(); // tracker cover url -> data: URI (or null if it failed to load)
  function showCover(url, img) {
    if (coverCache.has(url)) { const v = coverCache.get(url); if (v) img.src = v; else img.remove(); return; }
    window.api.fetchCover(url).then((dataUrl) => { coverCache.set(url, dataUrl); if (dataUrl) img.src = dataUrl; else img.remove(); });
  }
  const filled = (i) => !!(i.title || '').trim();
  const eligible = (i) => i.matched || filled(i);
  const overrides = () => {
    const o = {};
    for (const i of items) {
      if (i.matched) { if (i.title !== i.orig) o[i.rel] = i.title; }
      else if (filled(i)) o[i.rel] = { title: i.title.trim(), artist: (i.artist || '').trim(), album: (i.album || '').trim() };
    }
    return o;
  };
  const status = (t, tone) => { const s = $('#tStatus'); s.textContent = t; s.className = 'status' + (tone ? ' ' + tone : ''); };
  const refresh = () => {
    const n = items.filter(eligible).length;
    $('#tFind').disabled = busy || !folder;
    $('#tApply').disabled = busy || !n;
    $('#tApply').textContent = n ? `Write tags to ${n} files` : 'Write tags';
    $('#tChoose').disabled = busy;
  };
  const step = (n) => document.querySelectorAll('.steps span').forEach((s, i) => s.classList.toggle('on', i < n));

  function render() {
    const box = $('#tRows'); box.textContent = '';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'row' + ((!it.matched && !filled(it)) || (it.matched && !it.cover && !manual) ? ' bad' : '');
      const cov = document.createElement('span'); cov.className = 'thumb';
      if ((it.matched || filled(it)) && (manual || it.cover)) {
        const im = document.createElement('img'); im.alt = ''; cov.appendChild(im);
        if (manual) im.src = manual.dataUrl; else showCover(it.cover.replace(/=s\d+$/, '=s96'), im);
      }
      row.appendChild(cov);
      const cell = (v) => { const s = document.createElement('span'); s.textContent = v; s.title = v; return s; };
      row.appendChild(cell(it.rel));
      if (it.matched) {
        const names = [it.orig, ...(it.alts || []).filter((a) => a !== it.orig)];
        if (names.length > 1) {
          const sel = document.createElement('select'); sel.className = 'namepick'; sel.setAttribute('aria-label', 'Preferred name for ' + it.rel);
          for (const n of names) { const o = document.createElement('option'); o.value = n; o.textContent = n + (n === it.orig ? '  (main)' : ''); sel.appendChild(o); }
          sel.value = it.title;
          sel.addEventListener('change', () => { it.title = sel.value; });
          row.appendChild(sel);
        } else row.appendChild(cell(it.title));
        row.appendChild(cell(it.artist)); row.appendChild(cell(it.album));
        const m = cell(manual ? 'Manual cover' : it.cover ? 'Matched' : 'No cover'); m.className = 'match'; row.appendChild(m);
      } else {
        const mstat = cell(filled(it) ? 'Manual' : 'No match'); mstat.className = 'match';
        const field = (key, placeholder, suggestions) => {
          const inp = document.createElement('input');
          inp.type = 'text'; inp.className = 'manualfield'; inp.placeholder = placeholder;
          inp.value = it[key] || ''; inp.spellcheck = false;
          inp.setAttribute('aria-label', placeholder + ' for ' + it.rel);
          if (suggestions) inp.setAttribute('list', suggestions);
          inp.addEventListener('input', () => {
            it[key] = inp.value;
            mstat.textContent = filled(it) ? 'Manual' : 'No match';
            row.classList.toggle('bad', !filled(it));
            refresh();
          });
          return inp;
        };
        row.appendChild(field('title', 'Title'));
        row.appendChild(field('artist', 'Artist', 'tArtistSuggestions'));
        row.appendChild(field('album', 'Album'));
        row.appendChild(mstat);
      }
      box.appendChild(row);
    }
  }

  const setManual = (m) => {
    manual = m; render();
    $('#tCoverName').textContent = m ? 'Cover for all files: ' + m.name : '';
    $('#tCoverClear').hidden = !m;
  };
  $('#tCover').addEventListener('click', async () => { const m = await window.api.pickImage(); if (m) setManual(m); });
  $('#tCoverClear').addEventListener('click', () => setManual(null));
  $('#tChoose').addEventListener('click', async () => { const f = await window.api.pickFolder(); if (f) { folder = f; $('#tPath').textContent = f; step(2); refresh(); } });
  $('#tLink').addEventListener('input', () => step($('#tLink').value.trim() ? (folder ? 2 : 1) : 0));
  $('#tFind').addEventListener('click', async () => {
    const link = $('#tLink').value.trim();
    if (!link) return status('Paste the tracker link(s) first.', 'warn');
    busy = true; refresh(); status('Reading the tracker and matching files…');
    try {
      const r = await window.api.tagRun(link, folder, false, true);
      items = r.items; items.forEach((i) => { i.orig = i.title; }); render(); step(3);
      trackerArtists = r.artists || [];
      const dl = $('#tArtistSuggestions'); dl.textContent = '';
      for (const a of trackerArtists) { const o = document.createElement('option'); o.value = a; dl.appendChild(o); }
      const n = items.filter((i) => i.matched).length;
      status(`${n} of ${items.length} files matched. Use the dropdown to pick a different name, or fill in the unmatched rows by hand, then write the tags.`, 'ok');
    } catch (e) { items = []; render(); status(e.message, 'warn'); }
    busy = false; refresh();
  });
  $('#tApply').addEventListener('click', async () => {
    const n = items.filter(eligible).length;
    if (!confirm(`Write tags to ${n} file(s)?` + ($('#tBackup').checked ? '\n\nOriginals are copied to a backup folder next to yours first.' : ''))) return;
    busy = true; refresh(); status('Writing tags…');
    try {
      const r = (await window.api.tagRun($('#tLink').value.trim(), folder, true, $('#tBackup').checked, overrides(), manual ? manual.path : null)).result;
      status(`Tagged ${r.ok} file(s), ${r.bad} failed.` + (r.backup ? ' Backup: ' + r.backup : ''), r.bad ? 'warn' : 'ok');
    } catch (e) { status(e.message, 'warn'); }
    busy = false; refresh();
  });
  step(0);
})();
