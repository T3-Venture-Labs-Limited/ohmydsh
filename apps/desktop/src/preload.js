'use strict'
// Preload of the loading/error screen ONLY (the DSH window has no preload and no node integration).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ohmydsh', {
  onProgress: (fn) => { ipcRenderer.on('progress', (_e, p) => fn(p)) },
  onError: (fn) => { ipcRenderer.on('error', (_e, p) => fn(p)) },
  retry: () => ipcRenderer.send('retry'),
  openLog: () => ipcRenderer.send('open-log'),
  quit: () => ipcRenderer.send('quit'),
})
