'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  initialFolder: () => ipcRenderer.invoke('initial-folder'),
  isDir: (p) => ipcRenderer.invoke('is-dir', p),
  pathForFile: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  scan: (folder) => ipcRenderer.invoke('scan', folder),
  fix: (ids, backup) => ipcRenderer.invoke('fix', { ids, backup }),
  openBackup: (p) => ipcRenderer.invoke('open-backup', p),
  on: (channel, fn) => { ipcRenderer.on(channel, (_e, data) => fn(data)); },
});
