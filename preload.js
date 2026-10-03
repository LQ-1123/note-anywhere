const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onRestore: (cb) => ipcRenderer.on('restore', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, theme) => cb(theme)),
  listPages: () => ipcRenderer.invoke('list-pages'),
  openPage: (p) => ipcRenderer.send('open-page', p),
  deletePage: (p) => ipcRenderer.invoke('delete-page', p),
  save: (text, caret) => ipcRenderer.send('save', { text, caret }),
  hide: () => ipcRenderer.send('hide'),
  newPage: () => ipcRenderer.send('new-page'),
});
