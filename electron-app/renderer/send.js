'use strict';
// The "Send files" screen: choose songs, share them on the Wi-Fi (and optionally over the internet),
// and show where the files go on each device.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const fmtBytes = (n) => n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
  const bold = (t) => { const e = document.createElement('b'); e.textContent = t; return e; };

  let sel = [];          // paths chosen to send
  let info = null;       // the running share, if any
  let netBusy = false;

  const msg = (t, tone) => { const m = $('#sMsg'); m.textContent = t || ''; m.className = 'status' + (tone ? ' ' + tone : ''); };

  function drawQr(box, url) {
    box.replaceChildren();
    try {
      const qr = qrcode(0, 'M'); qr.addData(url); qr.make();
      const svg = new DOMParser().parseFromString(qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true }), 'image/svg+xml').documentElement;
      box.appendChild(document.importNode(svg, true));
    } catch {}
  }

  function updateSelection() {
    const f = $('#sPath');
    if (!sel.length) { f.textContent = 'Nothing chosen yet'; }
    else if (sel.length === 1) { f.textContent = ''; const b = document.createElement('bdi'); b.textContent = sel[0]; f.appendChild(b); f.title = sel[0]; }
    else { f.textContent = sel.length + ' files chosen'; f.title = sel.join('\n'); }
    $('#sStart').disabled = !sel.length;
    $('#sStart').textContent = info && info.running ? 'Update sharing' : 'Start sharing';
  }

  async function renderNet(i) {
    const box = $('#sNet');
    let t = null;
    try { t = await window.api.tunnelInfo(); } catch {}
    if (!t || !t.supported) { box.hidden = true; $('#sNetBody').hidden = true; return; }
    box.hidden = false;
    const on = !!(i && i.publicHost);
    $('#sNetBtn').textContent = on ? 'Stop internet link' : 'Make an internet link';
    $('#sNetBtn').disabled = netBusy;
    if (!netBusy) $('#sNetText').textContent = on
      ? 'The internet link is on.'
      : (t.installed ? 'Makes a temporary link that works from any network, using Cloudflare\'s free tunnel.' : `Makes a temporary link that works from any network. Needs a one-time ${t.mb} MB download of Cloudflare's free tunnel program.`);
    $('#sNetBody').hidden = !on;
    if (on) { const u = `https://${i.publicHost}/${i.token}/`; $('#sNetUrl').textContent = u; drawQr($('#sNetQr'), u); }
  }

  function render(i) {
    info = i && i.running ? i : null;
    $('#sShare').hidden = !info;
    updateSelection();
    if (!info) return;
    if (info.urls.length) {
      $('#sUrl').textContent = info.urls[0].url; drawQr($('#sQr'), info.urls[0].url);
      $('#sOthers').textContent = info.urls.length > 1 ? 'If that one does not load, try: ' + info.urls.slice(1).map((u) => u.url + ' (' + u.name + ')').join('   ') : '';
    } else {
      $('#sUrl').textContent = 'No Wi-Fi network found on this computer.'; $('#sQr').replaceChildren(); $('#sOthers').textContent = 'Connect to Wi-Fi, or use the internet link below.';
    }
    $('#sInfo').textContent = `Sharing ${info.count} file${info.count === 1 ? '' : 's'}, ${fmtBytes(info.bytes)} (${info.label}).`;
    $('#sStatus').textContent = info.received ? `Received ${info.received} file(s) from another device so far.` : '';
    renderNet(info);
  }

  async function startShare() {
    if (!sel.length) return;
    msg('Starting…'); $('#sStart').disabled = true;
    try { render(await window.api.shareStart(sel)); msg(''); }
    catch (e) { msg('Could not start sharing: ' + (e.message || e).toString().replace(/^Error invoking remote method '[^']*': (Error: )?/, ''), 'warn'); }
    updateSelection();
  }

  async function toggleNet() {
    if (!info) return;
    if (info.publicHost) { await window.api.tunnelStop(); render(await window.api.shareStatus()); return; }
    const t = await window.api.tunnelInfo();
    const body = [
      'This makes a temporary public link so a device on ANY network can download your files. ',
      t.installed ? '' : ['It needs a one-time ', bold(`${t.mb} MB`), ' download of Cloudflare\'s free "cloudflared" program from github.com/cloudflare/cloudflared. It is checked against Cloudflare\'s official checksum before it is run. '],
      'While the link is on, your files pass through Cloudflare\'s servers, and ', bold('anyone who has the link'), ' can download them. Stop sharing, or close the app, to turn it off.',
    ].flat().filter((x) => x !== '');
    const yes = await window.__lffConfirm('Make an internet link?', body, t.installed ? 'Turn it on' : 'Download and turn on');
    if (!yes) return;
    netBusy = true; $('#sNetBtn').disabled = true; $('#sNetText').textContent = t.installed ? 'Starting the internet link…' : 'Downloading… 0%';
    try { await window.api.tunnelStart(); msg(''); }
    catch (e) { msg('Internet link failed: ' + (e.message || e).toString().replace(/^Error invoking remote method '[^']*': (Error: )?/, ''), 'warn'); }
    netBusy = false;
    render(await window.api.shareStatus());
  }

  // ---------------------------------------------------------------- wiring
  $('#sFolder').addEventListener('click', async () => { const p = await window.api.pickFolder(); if (p) { sel = [p]; updateSelection(); msg(''); } });
  $('#sFiles').addEventListener('click', async () => { const f = await window.api.pickFiles(); if (f && f.length) { sel = f; updateSelection(); msg(''); } });
  $('#sStart').addEventListener('click', startShare);
  $('#sStop').addEventListener('click', async () => { await window.api.shareStop(); render(null); msg('Sharing stopped.'); });
  $('#sOpenRecv').addEventListener('click', () => window.api.openReceived());
  $('#sNetBtn').addEventListener('click', toggleNet);

  window.api.on('share-event', (ev) => { if (ev && ev.type === 'upload') $('#sStatus').textContent = `Received ${ev.received} file(s) from another device. Latest: ${ev.name}`; });
  window.api.on('tunnel-progress', ({ done, total }) => { if (total) $('#sNetText').textContent = `Downloading… ${Math.round((done / total) * 100)}%`; });
  window.api.on('tunnel-ended', () => { msg('The internet link stopped.', 'warn'); window.api.shareStatus().then(render); });

  // coming back to this screen shows a share that is still running
  document.addEventListener('click', (e) => { if (e.target.closest('[data-go="send"]')) window.api.shareStatus().then(render).catch(() => {}); });

  // from the Fix screen: share the folder that was just fixed
  window.__lffSend = { preset(folder) { sel = [folder]; updateSelection(); startShare(); } };

  // where-do-the-files-go tabs
  function pickHow(name) { $$('[data-how]').forEach((b) => b.classList.toggle('on', b.dataset.how === name)); $$('.howpane').forEach((p) => { p.hidden = p.id !== 'how-' + name; }); }
  function pickPhone(kind) { $$('[data-ph]').forEach((b) => b.classList.toggle('on', b.dataset.ph === kind)); $('#ph-android').hidden = kind !== 'android'; $('#ph-iphone').hidden = kind !== 'iphone'; }
  $$('[data-how]').forEach((b) => b.addEventListener('click', () => pickHow(b.dataset.how)));
  $$('[data-ph]').forEach((b) => b.addEventListener('click', () => pickPhone(b.dataset.ph)));
  pickHow(window.api.platform === 'darwin' ? 'mac' : 'pc'); pickPhone('android');

  updateSelection();
})();
