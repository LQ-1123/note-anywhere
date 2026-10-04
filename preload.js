const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onRestore: (cb) => ipcRenderer.on('restore', (_e, data) => cb(data)),
  onTheme: (cb) => ipcRenderer.on('theme', (_e, theme) => cb(theme)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings-changed', (_e, s) => cb(s)),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  // 窗口真实可见性（渲染端 document.hidden 在未显示窗口里不可靠，会误报“可见”）
  onVisibility: (cb) => ipcRenderer.on('win-visibility', (_e, visible) => cb(visible)),
  listPages: () => ipcRenderer.invoke('list-pages'),
  searchNotes: (query) => ipcRenderer.invoke('search-notes', { query }),
  listTags: () => ipcRenderer.invoke('list-tags'),
  openPageAt: (path, offset) => ipcRenderer.invoke('open-page-at', { path, offset }),
  openPage: (p) => ipcRenderer.send('open-page', p),
  deletePage: (p) => ipcRenderer.invoke('delete-page', p),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSetting: (key, value) => ipcRenderer.invoke('set-setting', { key, value }),
  pickNotesDir: () => ipcRenderer.invoke('pick-notes-dir'),
  resetWindow: () => ipcRenderer.invoke('reset-window'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openLink: (url) => ipcRenderer.invoke('open-link', url),
  saveImage: (bytes, mime) => ipcRenderer.invoke('save-image', { bytes, mime }),
  saveClipboardImage: () => ipcRenderer.invoke('save-clipboard-image'),
  save: (text, caret) => ipcRenderer.send('save', { text, caret }),
  hide: () => ipcRenderer.send('hide'),
  newPage: () => ipcRenderer.send('new-page'),
});
