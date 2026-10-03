const editor = document.getElementById('editor');
const titleEl = document.getElementById('title');
const savedAt = document.getElementById('saved-at');
const listEl = document.getElementById('page-list');

let currentFile = null;
let saveTimer = null;
let listTimer = null;

// ---------- 主题（跟随系统，由主进程推送） ----------

window.bridge.onTheme((theme) => {
  document.body.classList.toggle('theme-light', theme === 'light');
});

// ---------- 侧栏文档列表 ----------

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `今天 ${hm}`;
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

async function refreshList() {
  let data;
  try {
    data = await window.bridge.listPages();
  } catch {
    return;
  }
  currentFile = data.current;
  listEl.textContent = '';

  if (!data.pages.length) {
    const tip = document.createElement('div');
    tip.id = 'empty-tip';
    tip.textContent = '目录还是空的';
    listEl.appendChild(tip);
    return;
  }

  for (const page of data.pages) {
    const item = document.createElement('div');
    item.className = 'page-item' + (page.path === currentFile ? ' active' : '');
    item.dataset.path = page.path;

    const t = document.createElement('div');
    t.className = 'page-title';
    t.textContent = page.title;
    item.appendChild(t);

    const s = document.createElement('div');
    s.className = 'page-sub';
    s.textContent = formatDate(page.mtime);
    item.appendChild(s);

    listEl.appendChild(item);
  }
}

listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.page-item');
  if (!item || item.dataset.path === currentFile) return;
  clearTimeout(saveTimer);
  saveNow();
  window.bridge.openPage(item.dataset.path);
});

// ---------- 编辑区 ----------

function titleFrom(text) {
  const first = text.split('\n', 1)[0].replace(/^#{1,6}\s*/, '').trim();
  return first ? first.slice(0, 60) : '新的一页';
}

function renderTitle() {
  const t = titleFrom(editor.value);
  titleEl.textContent = t;
  titleEl.classList.toggle('named', t !== '新的一页' && editor.value.trim() !== '');
}

function flashSaved() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  savedAt.textContent = `已保存 ${p(d.getHours())}:${p(d.getMinutes())}`;
  savedAt.classList.add('show');
}

function saveNow() {
  window.bridge.save(editor.value, editor.selectionStart);
  if (editor.value.trim()) flashSaved();
  clearTimeout(listTimer);
  listTimer = setTimeout(refreshList, 350); // 新文件落盘后侧栏补上
}

editor.addEventListener('input', () => {
  renderTitle();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
});

editor.addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 输入法组合期间不拦截按键

  if (e.key === 'Escape') {
    e.preventDefault();
    clearTimeout(saveTimer);
    saveNow();
    window.bridge.hide();
    return;
  }
  if (e.ctrlKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
    e.preventDefault();
    clearTimeout(saveTimer);
    saveNow();
    window.bridge.newPage();
    return;
  }
  if (e.ctrlKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
    e.preventDefault();
    clearTimeout(saveTimer);
    saveNow();
  }
});

document.getElementById('new-btn').addEventListener('click', () => {
  clearTimeout(saveTimer);
  saveNow();
  window.bridge.newPage();
});

// 主进程呼出/切换页面时：恢复内容与光标位置，刷新侧栏
window.bridge.onRestore(({ text, caret, file }) => {
  editor.value = text;
  const pos = Math.min(Math.max(0, caret | 0), text.length);
  editor.setSelectionRange(pos, pos);
  editor.focus();
  renderTitle();
  savedAt.classList.remove('show');
  currentFile = file || null;
  refreshList();

  const stage = document.getElementById('stage');
  stage.classList.remove('in');
  void stage.offsetWidth;
  stage.classList.add('in');
});
