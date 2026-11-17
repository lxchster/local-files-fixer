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
  pickImage: () => ipcRenderer.invoke('pick-image'),
  tagRun: (link, folder, apply, backup, overrides, cover) => ipcRenderer.invoke('tag-run', { link, folder, apply, backup, overrides, cover }),
  openBackup: (p) => ipcRenderer.invoke('open-backup', p),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  shareStart: (paths) => ipcRenderer.invoke('share-start', paths),
  shareStop: () => ipcRenderer.invoke('share-stop'),
  shareStatus: () => ipcRenderer.invoke('share-status'),
  openReceived: () => ipcRenderer.invoke('open-received'),
  tunnelInfo: () => ipcRenderer.invoke('tunnel-info'),
  tunnelStart: () => ipcRenderer.invoke('tunnel-start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel-stop'),
  on: (channel, fn) => { ipcRenderer.on(channel, (_e, data) => fn(data)); },
});
