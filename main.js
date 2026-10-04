const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_DIAG = process.argv.includes('--diag');
const IS_MANUAL = process.argv.includes('--manual');
const HOTKEY = 'Alt+Q';
const DEFAULT_NOTES_DIR = 'D:\\desktop\\insights';

let win = null;
let tray = null;
let quitting = false;
let pageReady = false;

// ---------- 配置与状态 ----------

const userDataFile = (name) => path.join(app.getPath('userData'), name);

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

const config = readJson(userDataFile('config.json'), {});
const DEFAULT_SETTINGS = {
  hotkey: HOTKEY,
  theme: 'system', // system | dark | light
  fontSize: 15,
  tabWidth: 4, // 中文场景：一格 = 4 空格 = 2 个中文字宽
  livePreview: true,
  lineNumbers: true,
  indentDots: true,
  alwaysOnTop: true,
};
const settings = {};
for (const k of Object.keys(DEFAULT_SETTINGS)) {
  settings[k] = config[k] !== undefined ? config[k] : DEFAULT_SETTINGS[k];
}
let NOTES_DIR = path.resolve(config.notesDir || DEFAULT_NOTES_DIR);

function persistConfig() {
  writeJson(userDataFile('config.json'), { ...settings, notesDir: NOTES_DIR });
}

const loadState = () => readJson(userDataFile('state.json'), {});
const saveState = (s) => writeJson(userDataFile('state.json'), s);

function ensureNotesDir() {
  fs.mkdirSync(NOTES_DIR, { recursive: true });
}

// 渲染层传来的文件路径必须是笔记目录根层下的 .md，防止路径穿越
function safePagePath(p) {
  if (typeof p !== 'string') return null;
  const root = NOTES_DIR + path.sep;
  const resolved = path.resolve(p);
  if (!resolved.toLowerCase().startsWith(root.toLowerCase())) return null;
  if (!resolved.toLowerCase().endsWith('.md')) return null;
  if (resolved.slice(root.length).toLowerCase().includes(path.sep)) return null;
  return resolved;
}

// ---------- 笔记文件 ----------

function newFilePath() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  let f = path.join(NOTES_DIR, `${base}.md`);
  let i = 2;
  while (fs.existsSync(f)) f = path.join(NOTES_DIR, `${base}-${i++}.md`);
  return f;
}

// 读取文件首行作为标题（只读前 512 字节，避免大文件开销）
function pageTitle(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const first = buf
      .slice(0, n)
      .toString('utf8')
      .replace(/^\uFEFF/, '')
      .split('\n')[0]
      .replace(/\r$/, '')
      .replace(/^#{1,6}\s*/, '')
      .replace(/<[^>]*>?/g, '') // 侧栏标题不显示行内 HTML 标签
      .trim();
    return first || '';
  } catch {
    return '';
  }
}

function listPages() {
  ensureNotesDir();
  const st = loadState();
  let entries = [];
  try {
    entries = fs.readdirSync(NOTES_DIR, { withFileTypes: true });
  } catch {}
  const pages = entries
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.md'))
    .map((d) => {
      const p = path.join(NOTES_DIR, d.name);
      let mtime = 0;
      try { mtime = fs.statSync(p).mtimeMs; } catch {}
      return {
        path: p,
        title: pageTitle(p) || d.name.replace(/\.md$/i, ''),
        mtime,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return { pages, current: st.file || null };
}

// 保存当前页：空内容则删除文件并清掉指向，非空则落盘并记住该页光标
function writeCurrentPage(text, caret) {
  const st = loadState();
  if (!String(text || '').trim()) {
    if (st.file && fs.existsSync(st.file)) {
      try { fs.unlinkSync(st.file); } catch {}
    }
    saveState({ ...st, file: null, caret: 0 });
    return;
  }
  ensureNotesDir();
  const file = st.file || newFilePath();
  fs.writeFileSync(file, String(text), 'utf8');
  const carets = { ...(st.carets || {}), [file]: Math.max(0, caret | 0) };
  saveState({ ...st, file, caret: Math.max(0, caret | 0), carets });
}

// ---------- 窗口 ----------

function createWindow() {
  const b = loadState().bounds;
  // 旧的窄窗口（无侧栏时代）尺寸直接作废
  const keepBounds = b && typeof b.x === 'number' && b.width >= 620;
  win = new BrowserWindow({
    width: (keepBounds && b.width) || 880,
    height: (keepBounds && b.height) || 580,
    x: keepBounds ? b.x : undefined,
    y: keepBounds ? b.y : undefined,
    minWidth: 620,
    minHeight: 360,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
  win.loadFile(
    path.join(__dirname, 'renderer', 'index.html'),
    IS_DIAG ? { search: 'diag=1' } : undefined
  );
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });
  // 窗口真实可见性推送给渲染端（表格卡片等测量敏感组件依赖它做渲染门控）
  const sendVis = () => {
    if (!win || win.isDestroyed()) return;
    const visible = win.isVisible();
    console.log('[win-visibility] send', visible);
    win.webContents.send('win-visibility', visible);
  };
  win.on('show', sendVis);
  win.on('hide', sendVis);
  win.webContents.on('did-finish-load', () => {
    pageReady = true;
    sendTheme();
    sendVis();
    win.webContents.send('settings-changed', settings);
  });
  // 渲染层报错转发到主进程日志，便于排查
  win.webContents.on('console-message', (event) => {
    if (event.level === 'warning' || event.level === 'error' || event.message.startsWith('[table-render]')) {
      console.log(`[renderer:${event.level}]`, event.message, event.sourceId);
    }
  });
}

// 从渲染层拉取编辑器内容与光标（窗口隐藏后 executeJavaScript 依然可用）
async function flushEditor() {
  if (!win || !pageReady) return;
  try {
    const raw = await win.webContents.executeJavaScript(
      'window.__noteSnapshot ? window.__noteSnapshot() : null'
    );
    if (!raw) return;
    const { t, c } = JSON.parse(raw);
    writeCurrentPage(t, c);
  } catch {}
}

function sendRestore(text, caret, file) {
  const send = () => win.webContents.send('restore', { text, caret, file });
  pageReady ? send() : win.webContents.once('did-finish-load', send);
}

function restoreCurrent() {
  const st = loadState();
  let text = '';
  let caret = st.caret || 0;
  if (st.file && fs.existsSync(st.file)) {
    try { text = fs.readFileSync(st.file, 'utf8'); } catch {}
  }
  sendRestore(text, caret, st.file || null);
}

function showOnly() {
  ensureNotesDir();
  const st = loadState();
  if (!st.bounds || typeof st.bounds.x !== 'number') win.center();
  win.show();
  win.focus();
}

function showWindow() {
  showOnly();
  restoreCurrent();
}

async function hideWindow() {
  await flushEditor();
  if (!win) return;
  const st = loadState();
  st.bounds = win.getNormalBounds();
  saveState(st);
  win.hide();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    hideWindow();
  } else if (win.isVisible()) {
    win.focus();
  } else {
    showWindow();
  }
}

async function newPage() {
  await flushEditor(); // 先保存旧页
  const st = loadState();
  saveState({ ...st, file: null, caret: 0 });
  sendRestore('', 0, null);
}

// 侧栏点击切换文档：先保存当前页，再恢复目标页（含该页上次光标位置）
async function openPage(p) {
  const file = safePagePath(p);
  if (!file) return;
  await flushEditor();
  if (!fs.existsSync(file)) return;
  const st = loadState();
  const text = fs.readFileSync(file, 'utf8');
  const remembered = st.carets && typeof st.carets[file] === 'number' ? st.carets[file] : text.length;
  const caret = Math.min(Math.max(0, remembered), text.length);
  saveState({ ...st, file, caret });
  sendRestore(text, caret, file);
}

// ---------- 主题（跟随系统） ----------

function sendTheme() {
  if (!win || !pageReady) return;
  win.webContents.send('theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
}

// ---------- 托盘 ----------

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'build', 'icon.png'))
    .resize({ width: 16 });
  tray = new Tray(icon);
  tray.setToolTip('NoteAnywhere — 灵感速记');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => toggleWindow());
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开书写区（' + settings.hotkey + '）', click: () => toggleWindow() },
    { label: '新建一页', click: async () => { showOnly(); await newPage(); } },
    { type: 'separator' },
    {
      label: '打开笔记文件夹',
      click: () => { ensureNotesDir(); shell.openPath(NOTES_DIR); },
    },
    {
      label: '设置',
      click: () => { showOnly(); win.webContents.send('open-settings'); },
    },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (mi) => {
        app.setLoginItemSettings({ openAtLogin: mi.checked });
        tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true;
        Promise.resolve(flushEditor()).finally(() => app.quit());
      },
    },
  ]);
}

// ---------- 生命周期 ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => toggleWindow());

  app.whenReady().then(async () => {
    nativeTheme.themeSource =
      settings.theme === 'dark' ? 'dark' : settings.theme === 'light' ? 'light' : 'system';
    nativeTheme.on('updated', sendTheme);
    Menu.setApplicationMenu(null); // 去掉默认菜单，避免 Ctrl+N 等加速键被截获

    createWindow();
    createTray();

    if (IS_MANUAL) {
      await new Promise((resolve) =>
        pageReady ? resolve() : win.webContents.once('did-finish-load', resolve)
      );
      showWindow();
    }

    if (app.isPackaged) {
      const st = loadState();
      if (!st.autostartInit) {
        app.setLoginItemSettings({ openAtLogin: true });
        saveState({ ...st, autostartInit: true });
      }
    }

    const ok = globalShortcut.register(settings.hotkey, toggleWindow);
    if (!ok) {
      dialog.showErrorBox(
        '热键注册失败',
        settings.hotkey + ' 被其他程序占用了（如果旧版 NoteAnywhere 还在运行，请先从托盘退出它）。可在设置中更换热键。'
      );
    }

    console.log('APP-READY', { hotkey: ok, theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' });

    if (IS_SMOKE) {
      await new Promise((res) =>
        (pageReady ? Promise.resolve() : new Promise((r) => win.webContents.once('did-finish-load', r))).then(res)
      );
      try {
        const snapshotOk = await win.webContents.executeJavaScript('typeof window.__noteSnapshot');
        if (snapshotOk !== 'function') throw new Error('editor bundle not initialized: ' + snapshotOk);
        console.log('SMOKE editor OK');
      } catch (err) {
        console.error('SMOKE editor FAIL:', err.message);
        process.exitCode = 1;
      }
      if (IS_DIAG) {
        // 诊断样例含组件（代码/表格卡片），必须等窗口真实可见后再由渲染端插入。
        // 注意：本机远程桌面/部分 GPU 环境下，窗口显示初期不产出稳定布局，插入样例会
        // 让组件测量自旋（v1.3.1 起即如此）；渲染端会等真实可见信号再插入，此处只负责
        // 显示窗口与单次读取（不做高频轮询），超时优雅降级不影响冒烟结论
        await new Promise((r) => setTimeout(r, 600));
        win.setBounds({ width: 900, height: 600 });
        win.center();
        win.show();
        win.focus();
        await new Promise((r) => setTimeout(r, 3500));
        const res = await Promise.race([
          win.webContents.executeJavaScript('window.__diagResult || JSON.stringify({ pending: true, tableRender: window.__tableRenderState, visibility: document.visibilityState })'),
          new Promise((r) => setTimeout(() => r(null), 2000)),
        ]);
        const diag = res && JSON.parse(res);
        if (diag && !diag.pending) {
          console.log('DIAG', res);
          if (diag.buildErr || !Object.values(diag.tableCheck).every((value) => value === true)) process.exitCode = 1;
        } else {
          console.error('DIAG incomplete: renderer/compositor unavailable; this is not a rendering pass.', res || 'renderer did not respond');
          process.exitCode = 1;
        }
        win.hide();
      }
      try {
        await newPage();
        const snap = JSON.parse(await win.webContents.executeJavaScript('window.__noteSnapshot()'));
        if (snap.t !== '' || loadState().file !== null) throw new Error('new-page not applied');
        console.log('SMOKE new-page OK');
      } catch (err) {
        console.error('SMOKE new-page FAIL:', err.message);
        process.exitCode = 1;
      }
      try {
        ensureNotesDir();
        const probe = path.join(NOTES_DIR, '.smoke-test');
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        console.log('SMOKE notes-dir OK:', NOTES_DIR);
      } catch (err) {
        console.error('SMOKE notes-dir FAIL:', err.message);
        process.exitCode = 1;
      }
      console.log('SMOKE hotkey:', ok ? 'OK' : 'FAIL');
      console.log(process.exitCode ? 'SMOKE-FAIL' : 'SMOKE-OK');
      app.exit(process.exitCode || 0);
    }
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('window-all-closed', () => {/* 常驻托盘，不退出 */});

  // 兜底：任何退出路径前先落盘
  app.on('before-quit', (e) => {
    if (quitting || !win || !pageReady) return;
    e.preventDefault();
    quitting = true;
    Promise.resolve(flushEditor()).finally(() => app.quit());
  });
}

// ---------- 设置 ----------

ipcMain.handle('get-settings', () => ({
  ...settings,
  notesDir: NOTES_DIR,
  autostart: app.getLoginItemSettings().openAtLogin,
  version: app.getVersion(),
  userData: app.getPath('userData'),
}));

ipcMain.handle('set-setting', (_e, { key, value }) => {
  switch (key) {
    case 'hotkey': {
      if (typeof value !== 'string' || !value.includes('+')) return { ok: false, error: '无效的热键' };
      const prev = settings.hotkey;
      try { globalShortcut.unregister(prev); } catch {}
      let ok = false;
      try { ok = globalShortcut.register(value, toggleWindow); } catch {}
      if (!ok) {
        try { globalShortcut.register(prev, toggleWindow); } catch {}
        return { ok: false, error: '该组合键被其他程序占用' };
      }
      settings.hotkey = value;
      persistConfig();
      tray && tray.setContextMenu(buildTrayMenu());
      win.webContents.send('settings-changed', settings);
      return { ok: true };
    }
    case 'theme': {
      if (!['system', 'dark', 'light'].includes(value)) return { ok: false };
      settings.theme = value;
      persistConfig();
      nativeTheme.themeSource = value === 'system' ? 'system' : value;
      return { ok: true };
    }
    case 'autostart': {
      app.setLoginItemSettings({ openAtLogin: !!value });
      tray && tray.setContextMenu(buildTrayMenu());
      return { ok: true };
    }
    case 'alwaysOnTop': {
      settings.alwaysOnTop = !!value;
      persistConfig();
      if (win) win.setAlwaysOnTop(settings.alwaysOnTop, 'floating');
      return { ok: true };
    }
    case 'fontSize': {
      if (![14, 15, 16, 17, 18].includes(value)) return { ok: false };
      settings.fontSize = value;
      persistConfig();
      win.webContents.send('settings-changed', settings);
      return { ok: true };
    }
    case 'tabWidth': {
      if (![2, 4].includes(value)) return { ok: false };
      settings.tabWidth = value;
      persistConfig();
      win.webContents.send('settings-changed', settings);
      return { ok: true };
    }
    case 'livePreview':
    case 'lineNumbers':
    case 'indentDots': {
      settings[key] = !!value;
      persistConfig();
      win.webContents.send('settings-changed', settings);
      return { ok: true };
    }
    default:
      return { ok: false };
  }
});

ipcMain.handle('pick-notes-dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false };
  NOTES_DIR = path.resolve(r.filePaths[0]);
  persistConfig();
  ensureNotesDir();
  return { ok: true, dir: NOTES_DIR };
});

ipcMain.handle('reset-window', () => {
  const st = loadState();
  delete st.bounds;
  saveState(st);
  if (win) win.center();
  return { ok: true };
});

ipcMain.handle('open-path', (_e, p) => {
  if (p === 'notes') {
    ensureNotesDir();
    shell.openPath(NOTES_DIR);
  } else if (p === 'userData') {
    shell.openPath(app.getPath('userData'));
  }
  return { ok: true };
});

ipcMain.handle('list-pages', () => listPages());
ipcMain.on('save', (_e, { text, caret }) => writeCurrentPage(text, caret));
ipcMain.on('hide', () => hideWindow());
ipcMain.on('new-page', async () => {
  if (!win.isVisible()) showOnly();
  await newPage();
});
ipcMain.on('open-page', async (_e, p) => {
  if (!win.isVisible()) showOnly();
  await openPage(p);
});
ipcMain.handle('delete-page', async (_e, p) => {
  const file = safePagePath(p);
  if (!file || !fs.existsSync(file)) return { ok: false };
  try {
    fs.unlinkSync(file);
  } catch {
    return { ok: false };
  }
  const st = loadState();
  const carets = { ...(st.carets || {}) };
  delete carets[file];
  if (st.file === file) {
    // 删除的是当前页：清空指向与编辑区，避免下次保存又写回新文件
    saveState({ ...st, file: null, caret: 0, carets });
    sendRestore('', 0, null);
  } else {
    saveState({ ...st, carets });
  }
  return { ok: true };
});
