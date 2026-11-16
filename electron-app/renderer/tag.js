'use strict';
(() => {
  const $ = (s) => document.querySelector(s);
  const views = { menu: $('#viewMenu'), fix: $('#viewFix'), tag: $('#viewTag') };
  function go(name) { for (const k in views) views[k].hidden = k !== name; }
  document.addEventListener('click', (e) => { const b = e.target.closest('[data-go]'); if (b) go(b.dataset.go); });
  window.__lffGo = go;
  go(window.__lffStartFix ? 'fix' : 'menu');
  if (window.api && window.api.initialFolder) window.api.initialFolder().then((f) => { if (f) go('fix'); }).catch(() => {});

  let folder = null, items = [], busy = false;
  const status = (t, tone) => { const s = $('#tStatus'); s.textContent = t; s.className = 'status' + (tone ? ' ' + tone : ''); };
  const refresh = () => {
    $('#tFind').disabled = busy || !folder;
    $('#tApply').disabled = busy || !items.some((i) => i.matched);
    $('#tChoose').disabled = busy;
  };
  function render() {
    const box = $('#tRows'); box.textContent = '';
    for (const it of items) {
      const row = document.createElement('div');
      const vals = it.matched ? [it.rel, it.title, it.artist, it.album, it.cover ? 'yes' : 'no'] : [it.rel, 'no match', '', '', ''];
      row.className = 'row' + (!it.matched || !it.cover ? ' bad' : '');
      for (const v of vals) { const s = document.createElement('span'); s.textContent = v; s.title = v; row.appendChild(s); }
      box.appendChild(row);
    }
  }
  $('#tChoose').addEventListener('click', async () => { const f = await window.api.pickFolder(); if (f) { folder = f; $('#tPath').textContent = f; refresh(); } });
  $('#tFind').addEventListener('click', async () => {
    const link = $('#tLink').value.trim();
    if (!link) return status('Paste the tracker link first.', 'warn');
    busy = true; refresh(); status('Reading the tracker and matching files…');
    try {
      const r = await window.api.tagRun(link, folder, false, true);
      items = r.items; render();
      const n = items.filter((i) => i.matched).length;
      status(`${n} of ${items.length} files matched. Check the list, then Write tags.`);
    } catch (e) { items = []; render(); status(e.message, 'warn'); }
    busy = false; refresh();
  });
  $('#tApply').addEventListener('click', async () => {
    const n = items.filter((i) => i.matched).length;
    if (!confirm(`Write tags to ${n} file(s)?` + ($('#tBackup').checked ? '\n\nOriginals are copied to a backup folder next to yours first.' : ''))) return;
    busy = true; refresh(); status('Writing tags…');
    try {
      const r = (await window.api.tagRun($('#tLink').value.trim(), folder, true, $('#tBackup').checked)).result;
      status(`Tagged ${r.ok} file(s), ${r.bad} failed.` + (r.backup ? ' Backup: ' + r.backup : ''), r.bad ? 'warn' : 'ok');
    } catch (e) { status(e.message, 'warn'); }
    busy = false; refresh();
  });
})();
