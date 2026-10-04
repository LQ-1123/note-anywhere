const {
  app,
  BrowserWindow,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  clipboard,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');

const IS_SMOKE = process.argv.includes('--smoke');
const IS_DIAG = process.argv.includes('--diag');
const IS_MANUAL = process.argv.includes('--manual');
const HOTKEY = 'Alt+Q';
const DEFAULT_NOTES_DIR = 'D:\\desktop\\insights';

let win = null;
let tray = null;
let quitting = false;
let pageReady = false;
// 渲染层当前真正持有的是哪一页的内容（null = 编辑器是空的、还没载入任何一页）。
// 用来区分「用户把这一页清空了」和「这一页只是还没 restore 过来」——
// 后者如果当成空页清理，会把用户的笔记误删（真实发生过：开机自启常驻托盘，
// 退出时 before-quit 会 flush，此时编辑器还空着，state.file 指向的笔记就被删了）。
let loadedFile = null;

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
  reviewMode: 'daily', // off | daily | always
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

// 保存当前页：空内容则回收文件并清掉指向，非空则落盘并记住该页光标
function writeCurrentPage(text, caret) {
  const st = loadState();
  if (!String(text || '').trim()) {
    // 只有「这一页确实载入过」时，编辑器为空才说明用户把它清空了。
    // 没载入过（刚启动还没 restore 就 flush）时编辑器本来就是空的，此时绝不能删文件。
    if (st.file && st.file === loadedFile && fs.existsSync(st.file)) {
      void trashFile(st.file);
      saveState({ ...st, file: null, caret: 0 });
    }
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
  // 每日回顾：呼出时按当前设置推一条旧笔记（没有可回顾的内容时不消耗当天名额）
  const sendReview = () => {
    const note = maybeAutoReview();
    if (!note) return;
    const send = () => win.webContents.send('review', note);
    pageReady ? send() : win.webContents.once('did-finish-load', send);
  };
  win.on('show', () => {
    sendVis();
    sendReview();
  });
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
  loadedFile = file || null; // 记住渲染层即将持有哪一页
  const send = () => win.webContents.send('restore', { text, caret, file });
  pageReady ? send() : win.webContents.once('did-finish-load', send);
}

// 删笔记一律走系统回收站，误删还能捞回来（unlinkSync 是永久删除，不进回收站）
function trashFile(file) {
  try {
    return Promise.resolve(shell.trashItem(file)).catch((err) => {
      console.error('[trash] 移入回收站失败，已跳过删除：', file, err && err.message);
    });
  } catch (err) {
    console.error('[trash] 移入回收站异常，已跳过删除：', file, err && err.message);
  }
  return Promise.resolve();
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
    case 'reviewMode': {
      if (!['off', 'daily', 'always'].includes(value)) return { ok: false };
      settings.reviewMode = value;
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

// 链接跳转（渲染端 Ctrl/Cmd+点击触发）：网络地址交给系统浏览器，
// 本地路径按「当前笔记所在目录」解析后用系统默认程序打开，文件不存在则不动作。
ipcMain.handle('open-link', async (_e, raw) => {
  const url = typeof raw === 'string' ? raw.trim() : '';
  if (!url) return { ok: false };
  if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) {
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }
  if (url.startsWith('#')) return { ok: false }; // 文内锚点暂不支持
  // 其它协议不处理；注意别把 Windows 盘符（D:\... / D:/...）误当成协议
  const isLocalPath = /^[a-zA-Z]:[\\/]/.test(url) || url.startsWith('\\\\');
  if (!isLocalPath && /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^file:/i.test(url)) return { ok: false };

  const cut = url.search(/[?#]/);
  const target = cut === -1 ? url : url.slice(0, cut);
  let localPath;
  try {
    localPath = /^file:/i.test(target) ? fileURLToPath(target) : decodeURIComponent(target);
  } catch {
    return { ok: false };
  }
  const st = loadState();
  const base = st.file ? path.dirname(st.file) : NOTES_DIR;
  const abs = path.resolve(base, localPath);
  if (!fs.existsSync(abs)) return { ok: false, error: '文件不存在' };
  const failure = await shell.openPath(abs);
  return failure ? { ok: false, error: failure } : { ok: true };
});

// ---------- 粘贴图片 ----------

// 只按白名单决定扩展名，绝不拿剪贴板给的 MIME 去拼路径
const IMAGE_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
};
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

// 落到「笔记目录/assets/时间戳.ext」，返回相对笔记的路径，让笔记自包含、可整体搬走
function saveImageBuffer(buf, mime) {
  const ext = IMAGE_EXT[String(mime || '').toLowerCase()];
  if (!ext) return { ok: false, error: '不支持的图片格式' };
  if (!buf || !buf.length) return { ok: false, error: '没有图片数据' };
  if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片过大（上限 25MB）' };
  const dir = path.join(NOTES_DIR, 'assets');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return { ok: false, error: '无法创建 assets 目录' };
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  let name = `${stamp}.${ext}`;
  let i = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${stamp}-${i++}.${ext}`;
  const file = path.join(dir, name);
  try {
    fs.writeFileSync(file, buf);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  return { ok: true, rel: 'assets/' + name, file };
}

ipcMain.handle('save-image', (_e, payload) => {
  const bytes = payload && payload.bytes;
  let buf;
  try {
    buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  } catch {
    return { ok: false, error: '图片数据无法读取' };
  }
  return saveImageBuffer(buf, payload && payload.mime);
});

// 兜底：渲染端拿不到剪贴板字节时（例如从资源管理器复制的图片），直接读系统剪贴板。
// 注意 Electron 44 的剪贴板是异步 ClipboardItem 接口，没有 readImage()/readBuffer()。
ipcMain.handle('save-clipboard-image', async () => {
  try {
    const items = await clipboard.read();
    for (const item of items || []) {
      const type = (item.types || []).find((t) => IMAGE_EXT[String(t).toLowerCase()]);
      if (!type) continue;
      const blob = await item.getType(type);
      const res = saveImageBuffer(Buffer.from(await blob.arrayBuffer()), type);
      if (res.ok) return res;
    }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  return { ok: false, error: '剪贴板里没有图片' };
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
  await trashFile(file); // 走回收站，误删可恢复
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

// ---------- 全文搜索 / 标签 ----------

// 笔记都是根目录下的小 md，直接读盘扫，不建索引（几百个文件毫秒级）
function eachNote(fn) {
  ensureNotesDir();
  let entries = [];
  try {
    entries = fs.readdirSync(NOTES_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    if (!d.isFile() || !d.name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(NOTES_DIR, d.name);
    let text = '';
    let mtime = 0;
    try {
      text = fs.readFileSync(file, 'utf8');
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    fn(file, text, mtime);
  }
}

const MAX_HITS_PER_NOTE = 4;
const MAX_RESULTS = 60;

ipcMain.handle('search-notes', (_e, payload) => {
  const query = typeof (payload && payload.query) === 'string' ? payload.query.trim() : '';
  if (!query) return { ok: true, results: [] };
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results = [];
  eachNote((file, text, mtime) => {
    if (results.length >= MAX_RESULTS) return;
    const lines = text.split('\n');
    const hits = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const hay = line.toLowerCase();
      if (terms.every((t) => hay.includes(t))) {
        const col = Math.max(0, hay.indexOf(terms[0]));
        hits.push({ line: i + 1, text: line.slice(0, 400), col, offset: offset + col });
        if (hits.length >= MAX_HITS_PER_NOTE) break;
      }
      offset += line.length + 1;
    }
    if (hits.length) {
      results.push({ file, title: pageTitle(file) || path.basename(file, '.md'), mtime, hits });
    }
  });
  results.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, results: results.slice(0, MAX_RESULTS), query };
});

// #标签：只在「行首或空白之后」才算，避免命中 URL 锚点(https://x/#a)；
// 纯十六进制且长度为 3/4/6/8 的（#fff / #ffffff / #333）按颜色值排除；
// 围栏代码块内的 # 一律不算（多为注释或颜色）
const TAG_RE = /(^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const isColorTag = (tag) => /^[0-9a-fA-F]+$/.test(tag) && [3, 4, 6, 8].includes(tag.length);

ipcMain.handle('list-tags', () => {
  const counts = new Map();
  eachNote((file, text) => {
    let inFence = false;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      TAG_RE.lastIndex = 0;
      let m;
      while ((m = TAG_RE.exec(line))) {
        const tag = m[2];
        if (isColorTag(tag)) continue;
        counts.set(tag, (counts.get(tag) || 0) + 1);
      }
    }
  });
  const tags = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return { ok: true, tags };
});

// 从搜索结果跳到具体位置：切页 + 把光标放到命中处（复用 restore 通道）
ipcMain.handle('open-page-at', async (_e, payload) => {
  const file = safePagePath(payload && payload.path);
  if (!file || !fs.existsSync(file)) return { ok: false };
  await flushEditor();
  const text = fs.readFileSync(file, 'utf8');
  const caret = Math.min(Math.max(0, (payload.offset | 0) || 0), text.length);
  const st = loadState();
  const carets = { ...(st.carets || {}), [file]: caret };
  saveState({ ...st, file, caret, carets });
  sendRestore(text, caret, file);
  return { ok: true };
});

// ---------- 每日回顾 ----------
//
// 关键资产：文件名就是创建时间（YYYY-MM-DD_HH-mm-ss.md），所以按「几年前的今天」筛选
// 完全不用读全文、不建索引、不联网。回看历史笔记必须按创建日期而不是 mtime——
// 改一下去年的笔记 mtime 就变新了，用它筛会让旧笔记"变年轻"。

const REVIEW_MIN_AGE_DAYS = 7; // 太新的笔记不值得回顾
const REVIEW_COOLDOWN_DAYS = 30; // 刚回顾过的先放一放
// 凌晨 4 点前算前一天：速记用户常熬夜，半夜写的笔记不该立刻被踢出回顾池
const REVIEW_DAY_CUTOFF_HOUR = 4;

const loadReviews = () => readJson(userDataFile('reviews.json'), { notes: {}, lastShown: '' });
const saveReviews = (r) => writeJson(userDataFile('reviews.json'), r);

function noteCreatedAt(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/.exec(name);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function logicalToday(now) {
  const d = new Date(now);
  if (d.getHours() < REVIEW_DAY_CUTOFF_HOUR) d.setDate(d.getDate() - 1);
  return dayStart(d);
}

const monthDistance = (from, to) =>
  (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());

function reviewAgeLabel(created, today, ageDays) {
  const sameDay = created.getMonth() === today.getMonth() && created.getDate() === today.getDate();
  const years = today.getFullYear() - created.getFullYear();
  if (sameDay && years >= 1) return years + ' 年前的今天';
  const months = monthDistance(created, today);
  if (sameDay && months >= 3 && months % 3 === 0) return months + ' 个月前的今天';
  if (ageDays < 30) return ageDays + ' 天前';
  if (months < 12) return months + ' 个月前';
  return years + ' 年前';
}

// 回顾卡片里的摘要是纯文本：Markdown 渲染是挂在 CodeMirror decoration 上的，
// 脱离编辑器复用不了，所以这里只剥掉常见记号，不重造一套渲染器。
function reviewExcerpt(text) {
  const lines = String(text || '').split('\n');
  const body = [];
  let len = 0;
  for (const raw of lines.slice(1)) {
    if (/^\s*```/.test(raw)) continue;
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>]/g, '')
      .trim();
    if (!line) continue;
    body.push(line);
    len += line.length;
    if (len > 220) break;
  }
  const out = body.join('\n').trim();
  if (out) return out.slice(0, 260);
  return lines[0].replace(/^#{1,6}\s*/, '').trim().slice(0, 80);
}

function pickReviewNote(exclude, nowMs) {
  const now = new Date(nowMs || Date.now());
  const today = logicalToday(now);
  const reviews = loadReviews();
  const excluded = new Set((Array.isArray(exclude) ? exclude : []).map((f) => path.basename(String(f))));
  const pool = [];
  eachNote((file, text) => {
    const created = noteCreatedAt(path.basename(file));
    if (!created) return;
    const ageDays = Math.round((today - dayStart(created)) / 86400000);
    if (ageDays < REVIEW_MIN_AGE_DAYS) return;
    pool.push({ file, text, created, ageDays });
  });
  if (!pool.length) return null;

  // 分档：往年同月同日 > 3/6/9 个月前的今天 > 很久没回顾的 > 全部
  const sameDayPast = pool.filter(
    (n) => n.created.getMonth() === today.getMonth() && n.created.getDate() === today.getDate() && n.created.getFullYear() < today.getFullYear()
  );
  const quarterPast = pool.filter((n) => {
    const m = monthDistance(n.created, today);
    return n.created.getDate() === today.getDate() && m >= 3 && m % 3 === 0 && n.created.getFullYear() === today.getFullYear();
  });
  const notRecent = pool.filter((n) => {
    const at = reviews.notes[path.basename(n.file)] || 0;
    return !at || now.getTime() - at > REVIEW_COOLDOWN_DAYS * 86400000;
  });
  // 按档位顺序取：同档内以"今天是第几天"为随机起点（一天内结果稳定）；
  // 档内被 exclude 光了（点「换一条」点到底）要落到下一档，而不是直接返回空。
  const seed = Math.floor(today.getTime() / 86400000);
  const pickFrom = (list) => {
    if (!list.length) return null;
    const start = seed % list.length;
    for (let i = 0; i < list.length; i++) {
      const cand = list[(start + i) % list.length];
      if (!excluded.has(path.basename(cand.file))) return cand;
    }
    return null;
  };
  let pick = null;
  for (const list of [sameDayPast, quarterPast, notRecent, pool]) {
    pick = pickFrom(list);
    if (pick) break;
  }
  if (!pick) return null;
  return {
    file: pick.file,
    title: pageTitle(pick.file) || path.basename(pick.file, '.md'),
    excerpt: reviewExcerpt(pick.text),
    label: reviewAgeLabel(pick.created, today, pick.ageDays),
    ageDays: pick.ageDays,
    created: pick.created.getTime(),
    date: dayKey(pick.created),
  };
}

// 每天只自动推一次；没有可回顾的内容时不消耗当天名额
function maybeAutoReview() {
  if (settings.reviewMode === 'off') return null;
  const today = logicalToday(new Date());
  const reviews = loadReviews();
  if (settings.reviewMode === 'daily' && reviews.lastShown === dayKey(today)) return null;
  const note = pickReviewNote([]);
  if (!note) return null;
  reviews.lastShown = dayKey(today);
  reviews.notes[path.basename(note.file)] = Date.now();
  saveReviews(reviews);
  return note;
}

ipcMain.handle('review-note', (_e, payload) => ({
  ok: true,
  note: pickReviewNote((payload && payload.exclude) || []),
}));

ipcMain.handle('review-dismiss', (_e, payload) => {
  const file = safePagePath(payload && payload.path);
  if (file) {
    const reviews = loadReviews();
    reviews.notes[path.basename(file)] = Date.now();
    saveReviews(reviews);
  }
  return { ok: true };
});
