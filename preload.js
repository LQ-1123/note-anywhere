const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onRestore: (cb) => ipcRenderer.on('restore', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, theme) => cb(theme)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (_e, s) => cb(s)),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  listPages: () => ipcRenderer.invoke('list-pages'),
  openPage: (p) => ipcRenderer.send('open-page', p),
  deletePage: (p) => ipcRenderer.invoke('delete-page', p),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  pickNotesDir: () => ipcRenderer.invoke('pick-notes-dir'),
  resetWindow: () => ipcRenderer.invoke('reset-window'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  save: (text, caret) => ipcRenderer.send('save', { text, caret }),
  hide: () => ipcRenderer.send('hide'),
  newPage: () => ipcRenderer.send('new-page'),
});
