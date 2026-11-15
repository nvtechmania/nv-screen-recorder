'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nv', {
  appInfo: () => ipcRenderer.invoke('app:info'),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  chooseDir: () => ipcRenderer.invoke('dir:choose'),
  openDir: () => ipcRenderer.invoke('dir:open'),

  listSources: () => ipcRenderer.invoke('sources:list'),
  selectSource: (id, systemAudio) => ipcRenderer.invoke('source:select', id, systemAudio),

  recStart: (ext) => ipcRenderer.invoke('rec:start', ext),
  recChunk: (buf) => ipcRenderer.send('rec:chunk', buf),
  recStop: () => ipcRenderer.invoke('rec:stop'),
  recAbort: () => ipcRenderer.invoke('rec:abort'),

  openFile: (p) => ipcRenderer.invoke('file:open', p),
  revealFile: (p) => ipcRenderer.invoke('file:reveal', p),

  uiState: (s) => ipcRenderer.send('ui:state', s),
  miniCmd: (c) => ipcRenderer.send('mini:cmd', c),

  onMini: (cb) => ipcRenderer.on('mini:update', (_e, s) => cb(s)),
  onRecError: (cb) => ipcRenderer.on('rec:error', (_e, m) => cb(m))
});
