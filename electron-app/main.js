'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const core = require('./src/core');

nativeTheme.themeSource = 'dark';
let win = null;
let lastScan = { folder: null, issues: [] };

const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const argFolder = process.argv.slice(app.isPackaged ? 1 : 2).find((a) => !a.startsWith('--') && isDir(a)) || null;

function createWindow() {
  Menu.setApplicationMenu(null);
  const mac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 980, minHeight: 620,
    backgroundColor: '#000000', title: 'Local Files Toolkit', icon: path.join(__dirname, 'icon.png'),
    titleBarStyle: mac ? 'hiddenInset' : 'hidden',
    titleBarOverlay: mac ? undefined : { color: '#000000', symbolColor: '#ffffff', height: 38 },
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.env.LFF_TEST_FOLDER) win.webContents.once('did-finish-load', () => runSelfTest().catch((e) => { console.error('SELFTEST FAILED:', e.message); app.exit(1); }));
}

// ---------------------------------------------------------------- IPC
ipcMain.handle('initial-folder', () => argFolder);
ipcMain.handle('is-dir', (_e, p) => isDir(p));
ipcMain.handle('pick-image', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a cover image for all the files', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }] });
  if (r.canceled) return null;
  const p = r.filePaths[0];
  const ext = path.extname(p).toLowerCase() === '.png' ? 'png' : 'jpeg';
  return { path: p, name: path.basename(p), dataUrl: `data:image/${ext};base64,` + fs.readFileSync(p).toString('base64') };
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose your music / local files folder', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('scan', async (e, folder) => {
  if (!isDir(folder)) throw new Error('That folder no longer exists.');
  const res = await core.scanFolder(folder, (n, t, rel) => e.sender.send('scan-progress', { n, t, rel }));
  lastScan = { folder, issues: res.issues };
  return {
    nMp3: res.nMp3, nM4a: res.nM4a, nAudio: res.nAudio, errors: res.errors,
    issues: res.issues.map((x, id) => ({ id, cat: x.cat, rel: x.rel, problem: x.problem, fix: x.fix, kind: x.kind })),
  };
});

ipcMain.handle('fix', async (e, { ids, backup }) => {
  const list = [...new Set(ids)].filter((i) => Number.isInteger(i) && lastScan.issues[i]);
  const backupRoot = backup ? core.defaultBackupRoot(lastScan.folder) : null;
  let ok = 0, bad = 0, n = 0;
  for (const id of list) {
    const issue = lastScan.issues[id];
    n++;
    try {
      const msg = core.fixIssue(issue, lastScan.folder, backupRoot);
      ok++; e.sender.send('fix-log', { tone: 'ok', text: `FIXED   ${issue.rel} - ${msg}` });
    } catch (ex) {
      bad++; e.sender.send('fix-log', { tone: 'skip', text: `SKIPPED ${issue.rel} - ${ex.message} (file left unchanged)` });
    }
    e.sender.send('fix-progress', { n, t: list.length });
    await new Promise((r) => setImmediate(r));
  }
  return { ok, bad, backupRoot: ok && backupRoot && fs.existsSync(backupRoot) ? backupRoot : null };
});

ipcMain.handle('open-backup', (_e, p) => { if (p && isDir(p)) shell.openPath(p); });

// ---------------------------------------------------------------- send files to other devices (Wi-Fi share + optional internet link)
const share = require('./src/share');
const tunnel = require('./src/tunnel');
const toolsDir = () => path.join(app.getPath('userData'), 'tools');
const recvDir = () => path.join(app.getPath('downloads'), 'Local Files Toolkit - received');

ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose files to send', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('share-start', async (e, paths) => {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && fs.existsSync(p));
  if (!list.length) throw new Error('Those files or folders no longer exist.');
  const before = share.status().token;
  const info = await share.start(list, { recvDir: recvDir(), onEvent: (ev) => { try { e.sender.send('share-event', ev); } catch {} } });
  if (before && before !== info.token) tunnel.stop(); // a new share has a new secret, so the old internet link is dead
  return info;
});
ipcMain.handle('share-stop', async () => { tunnel.stop(); await share.stop(); });
ipcMain.handle('share-status', () => share.status());
ipcMain.handle('open-received', () => { const d = recvDir(); fs.mkdirSync(d, { recursive: true }); return shell.openPath(d); });

ipcMain.handle('tunnel-info', () => {
  const a = tunnel.asset();
  return { supported: !!a, installed: tunnel.installed(toolsDir()), mb: a ? a.mb : 0, url: tunnel.current() };
});
ipcMain.handle('tunnel-start', async (e) => {
  const st = share.status();
  if (!st.running) throw new Error('Start sharing first.');
  if (!tunnel.installed(toolsDir())) await tunnel.download(toolsDir(), (done, total) => { try { e.sender.send('tunnel-progress', { done, total }); } catch {} });
  const host = await tunnel.start(toolsDir(), st.port, () => { share.setPublicHost(null); try { e.sender.send('tunnel-ended'); } catch {} });
  share.setPublicHost(host);
  return { url: `https://${host}/${st.token}/` };
});
ipcMain.handle('tunnel-stop', () => { tunnel.stop(); share.setPublicHost(null); });
app.on('before-quit', () => { tunnel.stop(); share.stop(); });


// ---------------------------------------------------------------- tag songs (pure JavaScript - see src/tagger.js)
const tagger = require('./src/tagger');
ipcMain.handle('tag-run', async (_e, { link, folder, apply, backup, overrides, cover }) => {
  if (!isDir(folder)) throw new Error('That folder no longer exists.');
  return tagger.run({ link, folder, apply: !!apply, backup: backup !== false, overrides, cover });
});

// ---------------------------------------------------------------- headless self-test (used only when LFF_TEST_FOLDER is set)
async function runSelfTest() {
  const folder = process.env.LFF_TEST_FOLDER, shotDir = process.env.LFF_SHOT_DIR || __dirname;
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (cond, ms = 120000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(cond)) return; await sleep(100); } throw new Error('timeout waiting for: ' + cond); };
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(shotDir, name + '.png'), img.toPNG()); };
  const state = async () => console.log('STATE', await js('JSON.stringify(window.__lff.state())'));
  await wait('!!window.__lff');
  await js(`window.__lff.setFolder(${JSON.stringify(folder)})`);
  await wait('window.__lff.state().phase==="ready"');
  await sleep(1300); await shot('1-scanned'); await state();
  // fix ONE selected row first
  await js('document.querySelector(".row").click()');
  await js('document.getElementById("fixSel").click()');
  await wait('document.getElementById("modal").classList.contains("open")'); await sleep(450); await shot('2-confirm');
  await js('document.getElementById("modalOk").click()');
  await wait('window.__lff.state().fixRuns>=1 && window.__lff.state().phase==="ready"'); await state();
  // then everything ticked
  await js('document.getElementById("fixAll").click()');
  await wait('document.getElementById("modal").classList.contains("open")');
  await js('document.getElementById("modalOk").click()');
  await wait('window.__lff.state().fixRuns>=2 && window.__lff.state().phase==="ready"');
  await sleep(1300); await shot('3-fixed'); await state();
  console.log('SELFTEST COMPLETED');
  app.quit();
}

app.setAppUserModelId('com.localfilestoolkit.app');
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
