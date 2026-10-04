// NoteAnywhere 编辑器 —— CodeMirror 6 + Markdown 实时渲染 + 斜杠菜单 + VSCode 代码配色
import {
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  Decoration,
  WidgetType,
} from '@codemirror/view';
import { EditorState, Compartment, StateField, Prec } from '@codemirror/state';
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
  indentUnit,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap, undo, redo, isolateHistory } from '@codemirror/commands';

const bridge = window.bridge;

const titleEl = document.getElementById('title');
const savedAt = document.getElementById('saved-at');
const listEl = document.getElementById('page-list');
const editorHost = document.getElementById('editor');

let currentFile = null;
let saveTimer = null;
let listTimer = null;

// ---------- 运行时可调设置（由主进程推送/更新） ----------
const uiSettings = { fontSize: 15, tabWidth: 2, lineNumbers: true, indentDots: true };
const indentComp = new Compartment();
const previewComp = new Compartment();
const historyComp = new Compartment();

// ---------- 语法高亮（VSCode Dark+/Light+ 调性，颜色取自 CSS 变量） ----------

const highlight = HighlightStyle.define([
  { tag: [t.processingInstruction, t.meta], class: 'tok-mark' }, // 未实时渲染的残留记号
  { tag: t.heading, class: 'tok-head' },
  { tag: t.heading1, class: 'tok-head tok-h1' },
  { tag: t.heading2, class: 'tok-head tok-h2' },
  { tag: t.heading3, class: 'tok-head tok-h3' },
  { tag: t.heading4, class: 'tok-head tok-h4' },
  { tag: t.heading5, class: 'tok-head tok-h5' },
  { tag: t.heading6, class: 'tok-head tok-h6' },
  { tag: t.emphasis, class: 'tok-em' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: t.strikethrough, class: 'tok-strike' },
  { tag: t.link, class: 'tok-link' },
  { tag: t.url, class: 'tok-url' },
  { tag: t.quote, class: 'tok-quote' },
  { tag: t.monospace, class: 'tok-code' },
  // 代码块内部语言着色（VSCode 风格）
  { tag: [t.controlKeyword, t.moduleKeyword, t.definitionKeyword], class: 'tok-kw' },
  { tag: [t.keyword, t.operatorKeyword], class: 'tok-kw2' },
  // 基础类型 int/float/bool → VSCode 的蓝（storage.type），而非青
  { tag: t.standard(t.typeName), class: 'tok-kw2' },
  // 函数定义名（cpp 的 main、js 的 f）tag 带 definition 修饰，需单独匹配 → 黄
  { tag: [t.function(t.definition(t.variableName)), t.function(t.definition(t.propertyName))], class: 'tok-fn' },
  { tag: [t.string, t.special(t.string)], class: 'tok-str' },
  { tag: [t.lineComment, t.blockComment, t.comment], class: 'tok-com' },
  { tag: [t.number, t.bool, t.atom, t.null], class: 'tok-num' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-fn' },
  { tag: [t.variableName, t.propertyName], class: 'tok-var' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
  { tag: t.labelName, class: 'tok-lang' }, // ```cpp 的语言标识串
]);

// ---------- 实时渲染（Live Preview） ----------

class HrWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-hr';
    return s;
  }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}

// 有序列表的显示记号。注意：Markdown 语法只有「数字.」一种有序列表记号，
// a. / i. / 1.1. 都不是合法列表语法，所以多级编号只能做在显示层。
const LIST_ROMAN = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii'];
class OrderedMarkWidget extends WidgetType {
  constructor(text) {
    super();
    this.text = text;
  }
  eq(other) { return other.text === this.text; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-ol-marker';
    s.textContent = this.text;
    return s;
  }
}

// 代码块行号
class LnWidget extends WidgetType {
  constructor(n) {
    super();
    this.n = n;
  }
  eq(other) {
    return other.n === this.n;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-ln';
    s.textContent = String(this.n);
    return s;
  }
}

// 缩进圆点：一个 · 表示一个缩进格（Tab 宽度空格），宽度与缩进等宽保持对齐
class DotsWidget extends WidgetType {
  constructor(levels, tabWidth) {
    super();
    this.levels = levels;
    this.tabWidth = tabWidth;
  }
  eq(other) {
    return other.levels === this.levels && other.tabWidth === this.tabWidth;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-dot';
    s.textContent = ('·' + ' '.repeat(this.tabWidth - 1)).repeat(this.levels);
    return s;
  }
}

// 无语言围栏的「纯文本」提示徽标
class PlainWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-lang-plain';
    s.textContent = '纯文本';
    return s;
  }
}

// ---------- 表格卡片（GFM 表格渲染 + 行列编辑） ----------

// 按未转义的 | 切分一行表格文本；每格保留行内区间，用于点击跳回源码定位
function splitRow(text) {
  const bounds = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '|' && text[i - 1] !== '\\') bounds.push(i);
  }
  if (text[0] !== '|') bounds.unshift(-1);
  if (bounds[bounds.length - 1] !== text.length - 1) bounds.push(text.length);
  const cells = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const from = bounds[i] + 1;
    const to = bounds[i + 1];
    const seg = text.slice(from, to);
    cells.push({ text: seg, raw: seg.trim(), from, to });
  }
  return cells;
}

const isDelimCells = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c.raw));

// 单元格以源码原文存储（含 \| 转义），结构改动时原样拼回，显示时再还原
const serializeRow = (cells) => '| ' + cells.join(' | ') + ' |';

// 序列化文本里第 col 格内光标应落的相对位置（空格落在两空格中间）
function tableCellAnchor(text, col) {
  const cells = splitRow(text);
  if (col >= cells.length) return text.length;
  const c = cells[col];
  return c.from + (c.raw ? c.text.length - c.text.trimStart().length : 1);
}

function readTableLines(st, node) {
  const lines = [];
  for (let pos = node.from; pos <= node.to; ) {
    const line = st.doc.lineAt(pos);
    lines.push(line);
    if (line.to >= node.to) break;
    pos = line.to + 1;
  }
  return lines;
}

// 解析表格块：lines[0]=表头 lines[1]=分隔行 lines[2..]=数据行；数据行补齐到表头列数
function readTableBlock(st, node) {
  const lines = readTableLines(st, node);
  if (lines.length < 2) return null;
  const head = splitRow(lines[0].text);
  const delim = splitRow(lines[1].text);
  if (!head.length || !isDelimCells(delim)) return null;
  const n = head.length;
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l.text).map((c) => c.raw);
    while (cells.length < n) cells.push('');
    return cells;
  });
  return { lines, head: head.map((c) => c.raw), delim: delim.map((c) => c.raw), rows, n };
}

function climbTableAt(st, p) {
  for (const side of [-1, 1]) {
    let node = syntaxTree(st).resolveInner(p, side);
    while (node) {
      if (node.name === 'Table') return node;
      node = node.parent;
    }
  }
  return null;
}

// 点击发生在卡片 DOM 里，此刻按当前文档重新定位表格范围
function findTableRangeAt(el) {
  let pos;
  try { pos = view.posAtDOM(el); } catch { return null; }
  const st = view.state;
  const node = climbTableAt(st, Math.max(0, Math.min(pos, st.doc.length)));
  if (node) return { from: node.from, to: node.to };
  return scanTableAround(st, pos);
}

// 兜底：语法树没命中时按「表头行 + 分隔行」的文本特征找表格
function scanTableAround(st, pos) {
  const start = st.doc.lineAt(Math.max(0, Math.min(pos, st.doc.length))).number;
  for (let ln = start; ln >= Math.max(1, start - 1); ln--) {
    const delim = st.doc.line(ln);
    if (delim.text.indexOf('|') === -1 || !isDelimCells(splitRow(delim.text))) continue;
    if (ln <= 1) continue;
    const head = st.doc.line(ln - 1);
    if (head.text.indexOf('|') === -1) continue;
    let end = delim.to;
    for (let l = ln + 1; l <= st.doc.lines; l++) {
      const row = st.doc.line(l);
      if (row.text.indexOf('|') === -1) break;
      end = row.to;
    }
    return { from: head.from, to: end };
  }
  return null;
}

function tbBtn(op, arg, label, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cm-tb-btn';
  b.dataset.op = op;
  if (arg != null) b.dataset.arg = String(arg);
  b.textContent = label;
  if (title) b.title = title;
  return b;
}

// 单元格：可直接编辑的输入块（plaintext-only 拦截富文本粘贴），data-line/data-col 定位
function tbCellEdit(raw, lineIdx, col, isHead) {
  const td = document.createElement('td');
  td.className = 'cm-tb-cell' + (isHead ? ' cm-tb-head' : '');
  td.dataset.line = String(lineIdx);
  td.dataset.col = String(col);
  const d = document.createElement('div');
  d.className = 'cm-tb-edit';
  d.contentEditable = 'plaintext-only';
  d.textContent = raw.replace(/\\\|/g, '|');
  td.appendChild(d);
  return td;
}

// 卡片内正在编辑时保持组件 DOM 不被重建（否则输入焦点丢失）；
// 只在结构变化（行列增删）或编辑结束时重建
let tableLiveEdit = null; // { from } 正在编辑的表格（表头行位置）
let tableSyncTimer = null;
let tableComposing = false;
let tableColumnWidths = new Map(); // 当前页面中每张表的列宽（像素）；不改 Markdown 语法。
const tableWidthSignature = (head, delim) => JSON.stringify([head, delim]);

// 渲染态表格卡片：单元格可直接编辑，悬停表头/行首增删行列，底部整体追加
class TableWidget extends WidgetType {
  constructor(block) {
    super();
    this.from = block.lines[0].from;
    this.head = block.head;
    this.delim = block.delim;
    this.rows = block.rows;
    this.nCols = block.head.length;
    this.rowCount = block.rows.length;
    this.key = JSON.stringify([block.head, block.delim, block.rows]);
  }
  eq(other) {
    if (
      tableLiveEdit && tableLiveEdit.from === this.from &&
      other instanceof TableWidget &&
      other.from === this.from &&
      other.nCols === this.nCols &&
      other.rowCount === this.rowCount
    ) {
      return true; // 编辑期间：DOM 是最新内容的载体，不重建
    }
    return other.from === this.from && other.key === this.key;
  }
  ignoreEvent() { return true; } // 卡片内事件全部自行处理
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table-wrap';
    wrap.dataset.tableFrom = String(this.from);
    const table = document.createElement('table');
    table.className = 'cm-table';
    const n = this.head.length;
    const entry = tableColumnWidths.get(this.from);
    const widths = entry && entry.signature === tableWidthSignature(this.head, this.delim)
      ? entry.widths
      : [];
    const cols = document.createElement('colgroup');
    cols.appendChild(document.createElement('col'));
    this.head.forEach((_raw, c) => {
      const col = document.createElement('col');
      col.style.width = (widths[c] || 120) + 'px';
      cols.appendChild(col);
    });
    table.appendChild(cols);
    table.style.width = (20 + this.head.reduce((sum, _raw, c) => sum + (widths[c] || 120), 0)) + 'px';
    const align = (c) => {
      const marker = this.delim[c] || '';
      return marker.endsWith(':') ? (marker.startsWith(':') ? 'center' : 'right') : 'left';
    };

    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    const hg = document.createElement('td');
    hg.className = 'cm-tb-gutter cm-tb-gutter-head';
    hr.appendChild(hg);
    this.head.forEach((raw, c) => {
      const th = tbCellEdit(raw, 0, c, true);
      th.style.textAlign = align(c);
      const ops = document.createElement('span');
      ops.className = 'cm-tb-colops';
      ops.appendChild(tbBtn('col-add', c, '+', '右侧插入列'));
      ops.appendChild(tbBtn('col-del', c, '×', n > 1 ? '删除此列（Ctrl+Z 撤销）' : '删除整表（Ctrl+Z 撤销）'));
      th.appendChild(ops);
      const handle = document.createElement('span');
      handle.className = 'cm-tb-resize';
      handle.dataset.col = String(c);
      handle.title = '拖动调整列宽';
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-orientation', 'vertical');
      handle.setAttribute('aria-label', '第 ' + (c + 1) + ' 列宽度');
      handle.tabIndex = 0;
      th.appendChild(handle);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    this.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      const g = document.createElement('td');
      g.className = 'cm-tb-gutter';
      const ops = document.createElement('span');
      ops.className = 'cm-tb-rowops';
      ops.appendChild(tbBtn('row-add', r, '+', '下方插入行'));
      ops.appendChild(tbBtn('row-del', r, '×', '删除此行（Ctrl+Z 撤销）'));
      g.appendChild(ops);
      tr.appendChild(g);
      for (let c = 0; c < n; c++) {
        const td = tbCellEdit(row[c] || '', 2 + r, c, false);
        td.style.textAlign = align(c);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    const foot = document.createElement('div');
    foot.className = 'cm-table-foot';
    foot.appendChild(tbBtn('row-append', null, '＋ 行'));
    foot.appendChild(tbBtn('col-append', null, '＋ 列'));
    const tip = document.createElement('span');
    tip.className = 'cm-table-tip';
    tip.textContent = '删除可 Ctrl+Z 撤销';
    foot.appendChild(tip);
    wrap.appendChild(foot);
    bindTableCardEvents(wrap);
    bindTableResize(wrap, tableWidthSignature(this.head, this.delim));
    return wrap;
  }
}

function bindTableResize(wrap, signature) {
  const table = wrap.querySelector('table');
  const setWidth = (c, width) => {
    const columns = Array.from(table.querySelectorAll('col')).slice(1);
    const widths = columns.map((col) => parseFloat(col.style.width));
    widths[c] = Math.max(64, Math.min(900, width));
    columns[c].style.width = widths[c] + 'px';
    table.style.width = (20 + widths.reduce((sum, value) => sum + value, 0)) + 'px';
    const from = Number(wrap.dataset.tableFrom);
    const entry = tableColumnWidths.get(from);
    tableColumnWidths.set(from, { widths, signature: entry ? entry.signature : signature });
  };
  wrap.querySelectorAll('.cm-tb-resize').forEach((handle) => {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      flushTableInput();
      const c = Number(handle.dataset.col);
      const startWidth = parseFloat(table.querySelectorAll('col')[c + 1].style.width);
      const startX = e.clientX;
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      const move = (event) => setWidth(c, startWidth + event.clientX - startX);
      const stop = () => {
        handle.classList.remove('dragging');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('lostpointercapture', stop);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('lostpointercapture', stop);
    });
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      e.stopPropagation();
      const c = Number(handle.dataset.col);
      setWidth(c, parseFloat(table.querySelectorAll('col')[c + 1].style.width) + (e.key === 'ArrowRight' ? 16 : -16));
    });
  });
}

// 把卡片单元格的文本同步回 Markdown 源码（整行重写，一次撤销步骤）
function syncTableCell(lineIdx, col, text) {
  if (!tableLiveEdit) return;
  const node = climbTableAt(view.state, Math.min(tableLiveEdit.from, view.state.doc.length - 1));
  if (!node) return;
  const block = readTableBlock(view.state, node);
  if (!block) return;
  const li = Math.min(Math.max(0, lineIdx), block.lines.length - 1);
  const line = block.lines[li];
  const raws = splitRow(line.text).map((c) => c.raw);
  while (raws.length < block.n) raws.push('');
  raws[Math.min(col, raws.length - 1)] = text.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  const insert = serializeRow(raws);
  if (insert === line.text) return;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    userEvent: 'input.table-cell',
  });
}

// 结束卡片编辑：先落盘未同步的输入，再解除 DOM 保持并重建装饰采纳最新源码
function flushTableInput(force = false) {
  if (tableComposing && !force) return;
  clearTimeout(tableSyncTimer);
  tableSyncTimer = null;
  const pending = tablePendingSync;
  tablePendingSync = null;
  if (pending && tableLiveEdit) syncTableCell(pending.lineIdx, pending.col, pending.text);
}

function endTableEdit() {
  flushTableInput(true);
  tableComposing = false;
  if (!tableLiveEdit) return;
  tableLiveEdit = null;
  view.dispatch({ selection: view.state.selection });
}

let tablePendingSync = null; // { lineIdx, col, text } 待写回的单元格内容

// 聚焦单元格并把光标放到文本末尾
function focusTableCell(td) {
  const edit = td.querySelector('.cm-tb-edit');
  if (!edit) return;
  edit.focus();
  const rng = document.createRange();
  rng.selectNodeContents(edit);
  rng.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(rng);
}

let tableFocusTimer = null;
function cancelTableFocus() {
  clearTimeout(tableFocusTimer);
  tableFocusTimer = null;
}

// 最近一次「希望聚焦某个表格单元格」的意图；被面板等打断后，关掉面板时可以续上
let tableFocusIntent = null;

// 只聚焦目标表格；定时重试不依赖 rAF，切页/用户移动光标后不抢回焦点。
function requestTableCellFocus(from, line, col, delay = 0) {
  cancelTableFocus();
  const caret = view.state.selection.main.head;
  tableFocusIntent = { from, line, col, caret };
  let retries = 0;
  const attempt = () => {
    tableFocusTimer = null;
    if (view.state.selection.main.head !== caret) return;
    const active = document.activeElement;
    if (active && !editorHost.contains(active) && active !== document.body) return;
    if (active && active.closest && active.closest('.cm-tb-edit')) return;
    if (tableRenderOk && tableWindowVisible) {
      const td = document.querySelector(
        '.cm-table-wrap[data-table-from="' + from + '"] td[data-line="' + line + '"][data-col="' + col + '"]'
      );
      if (td) { focusTableCell(td); return; }
    }
    if (retries++ < 5) tableFocusTimer = setTimeout(attempt, 200);
  };
  tableFocusTimer = setTimeout(attempt, delay);
}

window.addEventListener('mousedown', (event) => {
  if (tableFocusTimer && !event.target.closest('.cm-table-wrap')) cancelTableFocus();
}, true);
window.addEventListener('blur', cancelTableFocus);

// 卡片内全部可聚焦单元格序列：表头 → 数据行逐行（跳过分隔行）
function tableCellSeq(wrap) {
  const seq = [];
  wrap.querySelectorAll('td[data-line]').forEach((td) => {
    if (Number(td.dataset.line) !== 1) seq.push(td);
  });
  return seq;
}

// 卡片内交互（组件 ignoreEvent，事件全在这里接）
function bindTableCardEvents(el) {
  const wrap = el; // .cm-table-wrap
  wrap.addEventListener('focusin', (e) => {
    const td = e.target.closest && e.target.closest('td[data-line]');
    if (td) {
      const w = wrap.dataset.tableFrom;
      tableLiveEdit = { from: Number(w) };
    }
  });
  wrap.addEventListener('focusout', (e) => {
    if (wrap.contains(e.relatedTarget)) flushTableInput();
    else endTableEdit();
  });
  // 输入防抖同步：打字期间不重建 DOM，350ms 静默后写回源码
  wrap.addEventListener('input', (e) => {
    const td = e.target.closest && e.target.closest('td[data-line]');
    if (!td) return;
    tablePendingSync = {
      lineIdx: Number(td.dataset.line),
      col: Number(td.dataset.col),
      text: e.target.textContent,
    };
    clearTimeout(tableSyncTimer);
    if (tableComposing || e.isComposing) return;
    tableSyncTimer = setTimeout(() => {
      flushTableInput();
    }, 350);
  });
  wrap.addEventListener('compositionstart', () => {
    tableComposing = true;
    clearTimeout(tableSyncTimer);
  });
  wrap.addEventListener('compositionend', (e) => {
    tableComposing = false;
    const td = e.target.closest('td[data-line]');
    if (!td) return;
    tablePendingSync = { lineIdx: Number(td.dataset.line), col: Number(td.dataset.col), text: e.target.textContent };
    clearTimeout(tableSyncTimer);
    tableSyncTimer = setTimeout(flushTableInput, 350);
  });
  wrap.addEventListener('keydown', (e) => {
    const td = e.target.closest && e.target.closest('td[data-line]');
    if (!td) return;
    const li = Number(td.dataset.line);
    const col = Number(td.dataset.col);
    if (tableComposing || e.isComposing || e.keyCode === 229) return;
    const tableFrom = Number(wrap.dataset.tableFrom);
    if (e.key === 'Enter') {
      e.preventDefault();
      // 表头/分隔行回车 → 首个数据行；数据行回车 → 该行下方插行
      const insertAfterLine = li <= 1 ? 1 : li;
      endTableEdit();
      tableStructOp('row-insert-at', insertAfterLine, { focus: [insertAfterLine + 1, col], tableFrom });
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault();
      const seq = tableCellSeq(wrap);
      const idx = seq.indexOf(td);
      const target = e.shiftKey ? seq[idx - 1] : seq[idx + 1];
      if (target) {
        focusTableCell(target);
      } else if (!e.shiftKey) {
        // 末格 Tab：追加一行并聚焦新行首格
        endTableEdit();
        tableStructOp('row-append', null, { tableFrom });
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      endTableEdit();
      cancelTableFocus();
      view.focus();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      endTableEdit();
      (e.shiftKey ? redo : undo)(view);
      restoreTableFocus(tableFrom, li, col);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      endTableEdit();
      redo(view);
      restoreTableFocus(tableFrom, li, col);
      return;
    }
    if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      flushAndSend();
      return;
    }
  });
  // 粘贴纯文本（plaintext-only 不生效时的兜底）
  wrap.addEventListener('paste', (e) => {
    const td = e.target.closest && e.target.closest('td[data-line]');
    if (!td) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text.replace(/\s+/g, ' '));
  });
}

function restoreTableFocus(from, line, col) {
  const node = climbTableAt(view.state, Math.min(from, view.state.doc.length));
  const block = node && readTableBlock(view.state, node);
  if (!block) { view.focus(); return; }
  // 撤销的历史选择可能落在表内，把它移到表外再恢复同坐标单元格。
  if (view.state.selection.main.head >= node.from && view.state.selection.main.head <= node.to) {
    view.dispatch({ selection: { anchor: Math.min(node.to + 1, view.state.doc.length) } });
  }
  const targetLine = line === 0 || block.lines.length === 2 ? 0 : Math.min(Math.max(2, line), block.lines.length - 1);
  const td = document.querySelector('.cm-table-wrap[data-table-from="' + node.from + '"] td[data-line="' + targetLine + '"][data-col="' + Math.min(col, block.n - 1) + '"]');
  if (td) focusTableCell(td);
  else requestTableCellFocus(node.from, targetLine, Math.min(col, block.n - 1));
}

// 结构操作：按当前文档重解析表格 → 修改行列 → 整表重写；focus=[li,col] 指定重建后聚焦的单元格
function tableStructOp(op, arg, opts) {
  const focus = opts && opts.focus ? opts.focus : null;
  const rangeEl = opts && opts.tableFrom != null
    ? document.querySelector('.cm-table-wrap[data-table-from="' + opts.tableFrom + '"]')
    : document.querySelector('.cm-table-wrap');
  const range = rangeEl ? findTableRangeAt(rangeEl) : null;
  if (!range) return;
  const block = readTableBlock(view.state, range);
  if (!block) return;
  const head = block.head.slice();
  const delim = block.delim.slice();
  const rows = block.rows.map((r) => r.slice());
  const n = block.n;
  const addCol = (at) => {
    head.splice(at, 0, '');
    delim.splice(at, 0, '---');
    rows.forEach((r) => r.splice(at, 0, ''));
    const entry = tableColumnWidths.get(range.from);
    if (entry) entry.widths.splice(at, 0, 120);
  };
  let insert = null;
  let focusCell = focus;
  if (op === 'row-append') {
    rows.push(Array(n).fill(''));
    focusCell = focus || [2 + rows.length - 1, 0];
  } else if (op === 'row-insert-at') {
    const afterLineIdx = arg; // 0=表头行 1=分隔行 li=数据行所在行
    const atRow = afterLineIdx <= 1 ? 0 : afterLineIdx - 1; // 数据行索引
    rows.splice(atRow, 0, Array(n).fill(''));
    focusCell = focus || [2 + atRow, 0];
  } else if (op === 'row-add') {
    rows.splice(arg + 1, 0, Array(n).fill(''));
    focusCell = focus || [3 + arg, 0];
  } else if (op === 'row-del') {
    rows.splice(arg, 1);
    focusCell = rows.length ? [2 + Math.min(arg, rows.length - 1), 0] : [0, 0];
  } else if (op === 'col-append') {
    addCol(n);
    focusCell = focus || [0, n];
  } else if (op === 'col-add') {
    addCol(arg + 1);
    focusCell = focus || [0, arg + 1];
  } else if (op === 'col-del') {
    if (n <= 1) insert = ''; // 最后一列也删 → 删除整个表格
    else {
      head.splice(arg, 1);
      delim.splice(arg, 1);
      rows.forEach((r) => r.splice(arg, 1));
      const entry = tableColumnWidths.get(range.from);
      if (entry) entry.widths.splice(arg, 1);
      focusCell = [0, Math.min(arg, n - 2)];
    }
  } else return;
  if (insert === null) {
    insert = [serializeRow(head), serializeRow(delim), ...rows.map(serializeRow)].join('\n');
  }
  const widthEntry = tableColumnWidths.get(range.from);
  if (insert === '') tableColumnWidths.delete(range.from);
  else if (widthEntry) widthEntry.signature = tableWidthSignature(head, delim);
  view.dispatch({ changes: { from: range.from, to: range.to, insert }, userEvent: 'input.table', annotations: isolateHistory.of('full') });
  if (focusCell) {
    const [fl, fc] = focusCell;
    requestTableCellFocus(range.from, fl, fc);
  } else {
    view.focus();
  }
}

// 在 line 之后插入空行并把光标放进第一格
function insertRowAfter(view, line, n) {
  view.dispatch({
    changes: { from: line.to, insert: '\n' + serializeRow(Array(n).fill('')) },
    selection: { anchor: line.to + 3 },
    userEvent: 'input.table-row',
  });
}

// 跳到 lines[li] 的第 col 格（格子不足时补齐）
function gotoCell(view, block, li, col) {
  const tLine = block.lines[li];
  if (splitRow(tLine.text).length < block.n) {
    const raws = splitRow(tLine.text).map((c) => c.raw);
    while (raws.length < block.n) raws.push('');
    const padded = serializeRow(raws);
    view.dispatch({
      changes: { from: tLine.from, to: tLine.to, insert: padded },
      selection: { anchor: tLine.from + tableCellAnchor(padded, col) },
      userEvent: 'select.table-cell',
    });
    return;
  }
  view.dispatch({
    selection: { anchor: tLine.from + tableCellAnchor(tLine.text, col) },
    userEvent: 'select.table-cell',
  });
}

// 表格内回车：追加一行；空行上回车 = 清空该行退出表格
function tableEnter(view) {
  if (view.composing) return false;
  const st = view.state;
  const sel = st.selection.main;
  if (!sel.empty) return false;
  const table = climbTableAt(st, sel.head);
  if (!table) return false;
  const block = readTableBlock(st, table);
  if (!block) return false;
  const line = st.doc.lineAt(sel.head);
  const li = line.number - block.lines[0].number;
  if (li === 0) {
    // 表头回车：跳到第一个数据行（没有就建一行）
    if (block.lines.length > 2) gotoCell(view, block, 2, 0);
    else insertRowAfter(view, block.lines[1], block.n);
    return true;
  }
  if (li === 1) {
    // 分隔行回车：跳到第一个数据行（没有就建一行）
    if (block.lines.length > 2) gotoCell(view, block, 2, 0);
    else insertRowAfter(view, block.lines[1], block.n);
    return true;
  }
  if (li < 0 || li >= block.lines.length) return false;
  const cells = splitRow(line.text);
  if (cells.length && cells.every((c) => c.raw === '')) {
    view.dispatch({
      changes: { from: line.from, to: line.to },
      selection: { anchor: line.from },
      userEvent: 'delete.table-exit',
    });
    return true;
  }
  insertRowAfter(view, line, block.n);
  return true;
}

// 表格内 Tab / Shift+Tab：在单元格间跳转；末格 Tab 追加一行
function tableTab(view, shift) {
  if (view.composing) return false;
  const st = view.state;
  const sel = st.selection.main;
  if (!sel.empty) return false;
  const table = climbTableAt(st, sel.head);
  if (!table) return false;
  const block = readTableBlock(st, table);
  if (!block) return false;
  const line = st.doc.lineAt(sel.head);
  const li = line.number - block.lines[0].number;
  if (li < 0 || li >= block.lines.length) return false;
  if (li === 1) return true; // 分隔行吞掉 Tab，避免插入缩进
  const n = block.n;
  const rel = sel.head - line.from;
  const cells = splitRow(line.text);
  let col = cells.findIndex((c) => rel < c.to);
  if (col === -1) col = Math.max(0, cells.length - 1);

  let targetLine = li;
  let targetCol = shift ? col - 1 : col + 1;
  if (targetCol < 0) {
    if (targetLine <= 0) return true; // 表头第一格再往前：原地不动
    targetLine -= 1;
    if (targetLine === 1) targetLine = 0; // 跳过分隔行
    targetCol = n - 1;
  } else if (targetCol >= n) {
    targetLine += 1;
    targetCol = 0;
    if (targetLine === 1) targetLine = 2; // 表头往后跳过分隔行
    if (targetLine >= block.lines.length) {
      insertRowAfter(view, block.lines[block.lines.length - 1], n);
      return true;
    }
  }
  gotoCell(view, block, targetLine, targetCol);
  return true;
}

// 渲染态表格的删除保护：退格/删除会把行外文本拼进表格时，先转进源码而不是破坏表格
function tableDeleteGuard(view, forward) {
  if (view.composing) return false;
  const st = view.state;
  const sel = st.selection.main;
  if (!sel.empty) return false;
  const head = sel.head;
  const line = st.doc.lineAt(head);
  const table = forward
    ? (head === line.to && line.number < st.doc.lines ? climbTableAt(st, head + 1) : null)
    : (head === line.from && line.number > 1 ? climbTableAt(st, head - 1) : null);
  if (!table) return false;
  if (head >= table.from && head <= table.to) return false; // 已在源码态，不劫持
  if (line.text === '') return false; // 空行上的删除维持默认（正常吸收空行）
  const block = readTableBlock(st, table);
  if (!block) return false;
  if (forward) {
    gotoCell(view, block, 0, 0);
  } else {
    const lastLine = block.lines[block.lines.length - 1];
    const cells = splitRow(lastLine.text);
    const anchor = cells.length
      ? lastLine.from + cells[cells.length - 1].to -
        (cells[cells.length - 1].text.length - cells[cells.length - 1].text.trimEnd().length)
      : lastLine.to;
    view.dispatch({ selection: { anchor }, userEvent: 'select.table' });
  }
  return true;
}

// ---------- 粘贴代码自动识别语言 ----------

function guessLanguage(code) {
  if (/^\s*#\s*(include|pragma|define)\b/.test(code) || /\b(using namespace|std::|cout\s*<<|printf\s*\()/.test(code)) return 'cpp';
  if (/^\s*(def\s+\w+\s*\(|from\s+[\w.]+\s+import|import\s+[\w.]+\s*$)/m.test(code) || /^\s*print\(/.test(code)) return 'python';
  if (/^[\[{]/.test(code.trim())) {
    try { JSON.parse(code); return 'json'; } catch {}
  }
  if (/^\s*<(!DOCTYPE|html|[a-zA-Z][\w-]*\s)/i.test(code)) return 'html';
  if (/^\s*(function\s|const\s|let\s|var\s|class\s)/m.test(code) || /=>|console\.log/.test(code)) return 'javascript';
  if (/^\s*(package\s|func\s|import\s")/m.test(code)) return 'go';
  if (/^\s*(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE)\b/im.test(code)) return 'sql';
  return null;
}

// 给粘贴文本里「无语言的完整围栏代码块」补上识别出的语言标签
function addLangsToBareFences(text) {
  if (text.indexOf('```') === -1) return text;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```') continue;
    const close = lines.indexOf('```', i + 1);
    if (close === -1 || close === i + 1) continue; // 未闭合或空块不处理
    const lang = guessLanguage(lines.slice(i + 1, close).join('\n'));
    if (lang) lines[i] = '```' + lang;
    i = close;
  }
  return lines.join('\n');
}

// 实时渲染拆成两部分：md 标记隐藏（设置可关）与代码卡片（常开）
function lineInactive(st, head, pos) {
  const line = st.doc.lineAt(pos);
  return head < line.from || head > line.to;
}

// ---------- 图片 ----------

// ![alt](src)、![alt](<带空格的 src>)、![alt](src "标题")
function parseImageMarkdown(raw) {
  const m = /^!\[([^\]]*)\]\(\s*(?:<([^>]*)>|([^\s)]+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/.exec(raw);
  if (!m) return null;
  const src = (m[2] !== undefined ? m[2] : m[3] || '').trim();
  if (!src) return null;
  return { alt: m[1] || '', src };
}

function normalizePath(p) {
  const s = String(p).replace(/\\/g, '/');
  const lead = s.startsWith('/') ? '/' : '';
  const out = [];
  for (const seg of s.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return lead + out.join('/');
}

function fileUrlOf(absPath) {
  let p = normalizePath(absPath);
  if (/^[a-zA-Z]:/.test(p)) p = '/' + p;
  if (!p.startsWith('/')) p = '/' + p;
  return 'file://' + encodeURI(p).replace(/[?#]/g, (c) => '%' + c.charCodeAt(0).toString(16));
}

// 笔记目录缓存：新页还没落盘时 currentFile 为空，相对路径要退回按它解析
let notesDirCache = '';
function refreshNotesDir() {
  bridge.getSettings().then((s) => {
    if (s && s.notesDir) notesDirCache = String(s.notesDir);
  }).catch(() => {});
}
refreshNotesDir();

// 网络地址原样用；本地绝对路径直接转 file://；相对路径按当前笔记所在目录解析
function resolveImageSrc(src) {
  const s = String(src || '').trim();
  if (!s) return '';
  if (/^(https?|data|blob|file):/i.test(s)) return s;
  if (/^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')) return fileUrlOf(s);
  if (s.startsWith('/')) return fileUrlOf(s);
  const file = String(currentFile || '').replace(/\\/g, '/');
  const cut = file.lastIndexOf('/');
  const base = cut !== -1 ? file.slice(0, cut) : String(notesDirCache || '').replace(/\\/g, '/');
  if (!base) return fileUrlOf(s);
  return fileUrlOf(base + '/' + s);
}

class ImageWidget extends WidgetType {
  constructor(src, alt) {
    super();
    this.src = src;
    this.alt = alt;
  }
  eq(other) {
    return other.src === this.src && other.alt === this.alt;
  }
  toDOM() {
    const box = document.createElement('span');
    box.className = 'cm-image';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.draggable = false;
    img.addEventListener('error', () => {
      if (box.classList.contains('cm-image-broken')) return;
      box.classList.add('cm-image-broken');
      const tip = document.createElement('span');
      tip.className = 'cm-image-tip';
      tip.textContent = (this.alt ? this.alt + ' · ' : '') + '图片无法加载';
      box.appendChild(tip);
    });
    box.appendChild(img);
    return box;
  }
  ignoreEvent() { return false; } // 点一下把光标放进该节点 → 直接看到 ![]() 源码去修改
}

// ---------- 粘贴图片（Ctrl+V 截图 / 复制的位图） ----------

let imageErrorTimer = null;

function imageFromClipboard(cd) {
  if (!cd) return null;
  const found = [];
  if (cd.items) {
    for (const item of cd.items) {
      if (item.kind === 'file' && /^image\//i.test(item.type || '')) {
        const file = item.getAsFile();
        if (file) found.push(file);
      }
    }
  }
  if (!found.length && cd.files) {
    for (const file of cd.files) {
      if (/^image\//i.test(file.type || '')) found.push(file);
    }
  }
  return found[0] || null;
}

// 图片独占一段：光标所在行前后还有内容时各补一个空行；
// 末尾始终留一个换行并把光标放到图片节点之外，粘完立刻就是渲染态
function insertImageMarkdown(rel) {
  const sel = view.state.selection.main;
  const line = view.state.doc.lineAt(sel.from);
  const before = line.text.slice(0, sel.from - line.from).trim();
  const after = line.text.slice(sel.to - line.from).trim();
  const md = '![图片](' + rel + ')';
  const lead = before ? '\n\n' : '';
  const tail = after ? '\n\n' : '\n';
  view.dispatch({
    changes: { from: sel.from, to: sel.to, insert: lead + md + tail },
    selection: { anchor: sel.from + lead.length + md.length + 1 },
    scrollIntoView: true,
    userEvent: 'input.paste',
  });
  view.focus();
}

function flashImageError(message) {
  savedAt.textContent = message;
  savedAt.classList.add('show');
  clearTimeout(imageErrorTimer);
  imageErrorTimer = setTimeout(() => savedAt.classList.remove('show'), 2600);
}

// 优先用粘贴事件里的字节；拿不到就退回让主进程读系统剪贴板位图
async function insertPastedImage(file) {
  let bytes = null;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    bytes = null;
  }
  let res = null;
  try {
    if (bytes && bytes.length) res = await bridge.saveImage(bytes, file.type || 'image/png');
    if (!res || !res.ok) res = await bridge.saveClipboardImage();
  } catch (err) {
    res = { ok: false, error: String((err && err.message) || err) };
  }
  if (!res || !res.ok) {
    flashImageError('图片保存失败' + (res && res.error ? '：' + res.error : ''));
    return;
  }
  insertImageMarkdown(res.rel);
  saveNow(); // 顺手落盘，新页也会因此拿到文件
}

function buildMdDecos(view) {
  const st = view.state;
  const head = st.selection.main.head;
  const inline = [];
  const lineDecos = [];
  const hiddenLines = new Set(); // 被表格卡片整块替换的行，行内 HTML 扫描跳过
  if (st.doc.length > 300000) return Decoration.none;

  syntaxTree(st).iterate({
    enter: (ref) => {
      const name = ref.name;
      const from = ref.from;
      const to = ref.to;

      if (name === 'Table') {
        // 表格整体交给表格卡片插件；渲染态的行不再做行内处理
        if (head < from || head > to) {
          for (let pos = from; pos <= to; ) {
            const line = st.doc.lineAt(pos);
            hiddenLines.add(line.number);
            if (line.to >= to) break;
            pos = line.to + 1;
          }
        }
        return false;
      }
      if (name === 'CodeBlock') {
        // 缩进式代码块（4 空格起头）：按普通正文呈现，避免中文缩进触发“怪格式”
        for (let pos = from; pos <= to; ) {
          const line = st.doc.lineAt(pos);
          lineDecos.push(Decoration.line({ class: 'cm-plain-line' }).range(line.from));
          if (line.to >= to) break;
          pos = line.to + 1;
        }
        return;
      }
      if (name === 'Blockquote') {
        for (let pos = from; pos <= to; ) {
          const line = st.doc.lineAt(pos);
          lineDecos.push(Decoration.line({ class: 'cm-quote-line' }).range(line.from));
          if (line.to >= to) break;
          pos = line.to + 1;
        }
        return;
      }
      if (name === 'HorizontalRule') {
        if (lineInactive(st, head, from)) {
          inline.push(Decoration.replace({ widget: new HrWidget() }).range(from, to));
        }
        return;
      }
      if (name === 'ListMark') {
        const mark = st.doc.sliceString(from, to);
        if (/^\d+[.)]$/.test(mark)) {
          // 有序列表：显示层的多级编号与源码数字常常不同（源码 2. 显示 a.），
          // 所以不能等「整行不在编辑态」才替换，否则光标停在这一行时，
          // 刚按完 Tab 看到的还是源码 2.。改为按「光标是否落在记号内部」判断。
          if (!(head > from && head < to)) {
            inline.push(
              Decoration.replace({ widget: new OrderedMarkWidget(orderedListMarker(ref.node, mark)) }).range(from, to)
            );
          }
        } else if (lineInactive(st, head, from)) {
          inline.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
        }
        return;
      }
      if (name === 'Image') {
        // 光标在图片节点内 → 显示 ![]() 源码；在外 → 渲染成真实图片
        if (head < from || head > to) {
          const parsed = parseImageMarkdown(st.doc.sliceString(from, to));
          if (parsed) {
            inline.push(
              Decoration.replace({
                widget: new ImageWidget(resolveImageSrc(parsed.src), parsed.alt),
              }).range(from, to)
            );
            return false; // 整段已被组件替换，不再进子节点
          }
        }
        return;
      }
      // 链接：光标在外时整段加可点击样式（Ctrl/Cmd+点击跳转）；
      // 不剪枝，子节点仍按原规则隐藏 [] () 与 URL
      if ((name === 'Link' || name === 'Autolink') && (head < from || head > to)) {
        inline.push(Decoration.mark({ class: 'cm-link' }).range(from, to));
        return;
      }

      // 行内样式（粗体/斜体/链接等）的源码显隐按“光标是否在该样式节点内”判定（Obsidian 习惯），
      // 而非整行：加粗后光标稍移开标记即隐藏
      const nodeActive = () => {
        const p = ref.node.parent;
        const pFrom = p ? p.from : from;
        const pTo = p ? p.to : to;
        return head >= pFrom && head <= pTo;
      };
      const hide = () => {
        if (!nodeActive()) inline.push(Decoration.replace({}).range(from, to));
      };

      if (
        name === 'HeaderMark' || name === 'EmphasisMark' || name === 'StrongEmphasisMark' ||
        name === 'StrikethroughMark' || name === 'QuoteMark' || name === 'LinkMark'
      ) {
        hide();
        return;
      }
      if (name === 'CodeMark') {
        const parent = ref.node.parent; // 行内代码记号；围栏记号归代码卡片插件处理
        if (parent && parent.name === 'InlineCode') hide();
        return;
      }
      if (name === 'URL') {
        const parent = ref.node.parent; // 只隐藏链接里的裸 URL，自动链接不动
        if (parent && parent.name === 'Link') hide();
        return;
      }
    },
  });

  // 行内 HTML（下划线/荧光笔/字号）：标签按节点级隐藏，效果常显（单行内有效）
  try {
    for (let i = 1; i <= st.doc.lines; i++) {
      if (hiddenLines.has(i)) continue;
      const line = st.doc.line(i);
      if (!line.length) continue;
      scanInlineHtml(line, head, inline);
    }
  } catch {
    // 单个异常不拖垮整个实时渲染
  }

  return Decoration.set(lineDecos.concat(inline), true);
}

function scanInlineHtml(line, head, out) {
  // 标签仅在光标位于标签字符内部（< 与 > 之间）时显示，其余一律隐藏、效果常显
  const inTagText = (a, b) => head > a && head < b;
  const hideTags = (openFrom, openTo, closeFrom, closeTo, contentFrom, contentTo, markDeco) => {
    if (!inTagText(openFrom, openTo)) {
      out.push(Decoration.replace({}).range(openFrom, openTo));
    }
    if (!inTagText(closeFrom, closeTo)) {
      out.push(Decoration.replace({}).range(closeFrom, closeTo));
    }
    out.push(markDeco.range(contentFrom, contentTo));
  };
  let m;

  const RE_U = /<u>(.*?)<\/u>/g;
  for (m of line.text.matchAll(RE_U)) {
    const openFrom = line.from + m.index;
    const contentFrom = openFrom + 3;
    const contentTo = contentFrom + m[1].length;
    const closeTo = contentTo + 4;
    hideTags(openFrom, contentFrom, contentTo, closeTo, contentFrom, contentTo, Decoration.mark({ class: 'cm-u' }));
  }

  const RE_MARK = /<mark>(.*?)<\/mark>/g;
  for (m of line.text.matchAll(RE_MARK)) {
    const openFrom = line.from + m.index;
    const contentFrom = openFrom + 6;
    const contentTo = contentFrom + m[1].length;
    const closeTo = contentTo + 7;
    hideTags(openFrom, contentFrom, contentTo, closeTo, contentFrom, contentTo, Decoration.mark({ class: 'cm-highlight' }));
  }

  const RE_FS = /<span style="font-size:(\d+)px">(.*?)<\/span>/g;
  for (m of line.text.matchAll(RE_FS)) {
    const openFrom = line.from + m.index;
    const openTo = openFrom + m[0].indexOf('>') + 1;
    const contentFrom = openTo;
    const contentTo = contentFrom + m[2].length;
    const closeTo = contentTo + 7;
    hideTags(
      openFrom, openTo, contentTo, closeTo, contentFrom, contentTo,
      Decoration.mark({ class: 'cm-fs', attributes: { style: 'font-size:' + m[1] + 'px' } })
    );
  }
}

function buildCardDecos(view) {
  const st = view.state;
  const head = st.selection.main.head;
  const inline = [];
  const lineDecos = [];
  if (st.doc.length > 300000) return Decoration.none;

  syntaxTree(st).iterate({
    enter: (ref) => {
      if (ref.name !== 'FencedCode') return;
      const node = ref.node;
      const first = node.firstChild;
      const last = node.lastChild;
      const hasOpen = !!(first && first.name === 'CodeMark');
      const hasClose = !!(last && last !== first && last.name === 'CodeMark');
      const infoNode = hasOpen && first.nextSibling ? first.nextSibling : null;
      const hasLang = !!(infoNode && infoNode.name === 'CodeInfo');

      const lines = [];
      for (let pos = ref.from; pos <= ref.to; ) {
        const line = st.doc.lineAt(pos);
        lines.push(line);
        if (line.to >= ref.to) break;
        pos = line.to + 1;
      }

      let n = 1;
      lines.forEach((line, i) => {
        const lineActive = head >= line.from && head <= line.to;
        let cls = 'cm-code-line';
        if (i === 0) cls += ' cm-code-top';
        if (i === lines.length - 1) cls += ' cm-code-bottom';
        if (lineActive) cls += ' cm-code-active';
        lineDecos.push(Decoration.line({ class: cls }).range(line.from));

        const isOpenFence = hasOpen && i === 0;
        const isCloseFence = hasClose && i === lines.length - 1;
        if (isOpenFence) {
          // 开栏行：光标不在时隐藏 ``` 记号；语言显示徽标，无语言显示「纯文本」提示
          if (!lineActive) {
            inline.push(Decoration.replace({}).range(first.from, first.to));
          }
          if (hasLang) {
            inline.push(Decoration.mark({ class: 'cm-lang' }).range(infoNode.from, infoNode.to));
          } else {
            inline.push(Decoration.widget({ widget: new PlainWidget(), side: 1 }).range(line.from));
          }
          return;
        }
        if (isCloseFence) {
          if (!lineActive) {
            inline.push(Decoration.replace({}).range(last.from, last.to));
          }
          return;
        }
        if (uiSettings.lineNumbers) {
          inline.push(Decoration.widget({ widget: new LnWidget(n++), side: -1 }).range(line.from));
        }
        // 非编辑行：前导缩进显示为圆点（一个 · = 一个 Tab 宽，保持列对齐）
        // 列表行除外：记号本身已表明层级，再画圆点会变成「· •」很乱
        if (uiSettings.indentDots && !lineActive && !LIST_ITEM.test(line.text)) {
          const indent = (line.text.match(/^ */) || [''])[0].length;
          const tw = uiSettings.tabWidth;
          const levels = Math.floor(indent / tw);
          if (levels > 0) {
            inline.push(
              Decoration.replace({ widget: new DotsWidget(levels, tw) }).range(
                line.from,
                line.from + levels * tw
              )
            );
          }
        }
      });
    },
  });

  return Decoration.set(lineDecos.concat(inline), true);
}

const mdPreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildMdDecos(view);
    }
    update(u) {
      if (u.docChanged && tableColumnWidths.size) {
        const shifted = new Map();
        for (const [from, entry] of tableColumnWidths) shifted.set(u.changes.mapPos(from, 1), entry);
        tableColumnWidths = shifted;
      }
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildMdDecos(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

const codeCard = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildCardDecos(view);
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildCardDecos(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// 表格卡片：光标在表外 → 表头行渲染整卡、其余行隐藏（行内逐行替换，不用块级装饰——
// 块级组件在隐藏窗口与快速连续事务下存在测量竞态，会死循环）；光标进表 → 源码编辑
// 渲染门控：主进程的窗口真实可见性驱动（document.hidden 在未显示窗口里会误报可见，
// 且隐藏窗口里 rAF 照跑、布局为零——表格组件此时测量会让渲染进程自旋卡死）。
// 2 帧 + 200ms 与 600ms 定时器竞速；隐藏/再次呼出使上次等待失效。
let tableRenderOk = false;
let tableWindowVisible = false;
let tableRenderEpoch = 0;
let tableRenderFrame = null;
let tableRenderSettle = null;
let tableRenderFallback = null;
window.__tableRenderOk = false;
window.__tableRenderState = { visible: false, ready: false, reason: 'hidden' };

function cancelTableRenderWait() {
  if (tableRenderFrame !== null) cancelAnimationFrame(tableRenderFrame);
  clearTimeout(tableRenderSettle);
  clearTimeout(tableRenderFallback);
  tableRenderFrame = tableRenderSettle = tableRenderFallback = null;
}

function armTableRender() {
  if (!tableWindowVisible || tableRenderOk || tableRenderFallback !== null) return;
  const epoch = ++tableRenderEpoch;
  const open = (reason) => {
    if (!tableWindowVisible || epoch !== tableRenderEpoch || tableRenderOk) return;
    cancelTableRenderWait();
    tableRenderOk = window.__tableRenderOk = true;
    window.__tableRenderState = { visible: true, ready: true, reason };
    console.debug('[table-render] ready', reason, epoch);
    view.dispatch({ selection: view.state.selection });
  };
  tableRenderFallback = setTimeout(() => open('timeout'), 600);
  tableRenderFrame = requestAnimationFrame(() => {
    tableRenderFrame = requestAnimationFrame(() => {
      tableRenderFrame = null;
      if (!tableWindowVisible || epoch !== tableRenderEpoch) return;
      tableRenderSettle = setTimeout(() => open('frames'), 200);
    });
  });
}
if (bridge.onVisibility) {
  bridge.onVisibility((visible) => {
    tableWindowVisible = !!visible;
    console.debug('[table-render] visibility', tableWindowVisible);
    if (visible) armTableRender();
    else {
      ++tableRenderEpoch;
      cancelTableRenderWait();
      tableRenderOk = window.__tableRenderOk = false;
      window.__tableRenderState = { visible: false, ready: false, reason: 'hidden' };
      hideReview(); // 下次呼出重新判定要不要推回顾
      // 隐藏时不触发测量；装饰在下一次可见时重建。
    }
  });
}

function buildTableDecos(view) {
  const st = view.state;
  const decos = [];
  if (st.doc.length > 300000) return Decoration.none;
  const head = st.selection.main.head;
  syntaxTree(st).iterate({
    enter: (ref) => {
      if (ref.name !== 'Table') return; // 非表格节点继续下降，勿在祖先节点剪枝
      const node = ref.node;
      const block = readTableBlock(st, node);
      if (!block) return false;
      if (head >= node.from && head <= node.to) {
        for (const line of block.lines) {
          decos.push(Decoration.line({ class: 'cm-table-line' }).range(line.from));
        }
        return false;
      }
      if (tableRenderOk) {
        block.lines.forEach((line, i) => {
          if (i === 0) {
            decos.push(
              Decoration.replace({ widget: new TableWidget(block) }).range(line.from, line.to)
            );
          } else {
            decos.push(Decoration.replace({}).range(line.from, line.to));
            decos.push(Decoration.line({ class: 'cm-table-hidden' }).range(line.from));
          }
        });
      }
      return false; // 表格是叶子块，无需再进子节点
    },
  });
  return Decoration.set(decos, true);
}

const tableCard = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildTableDecos(view);
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildTableDecos(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations }
);

// ---------- 斜杠快速插入 ----------

// ⟦⟧ 包住插入后要选中的文字
function mk(s) {
  const a = s.indexOf('⟦');
  const b = s.indexOf('⟧');
  if (a === -1) return { text: s, sel: null };
  const text = s.slice(0, a) + s.slice(a + 1, b) + s.slice(b + 1);
  return { text, sel: { anchor: a, head: b - 1 } };
}

function buildSnippets() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  const time = p(d.getHours()) + ':' + p(d.getMinutes());
  return [
    { label: '表格', hint: '3 列', alias: 'table biaoge bg', snip: mk('| ⟦列1⟧ | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |') },
    { label: '链接', hint: 'https://', alias: 'link lianjie lj', snip: mk('[⟦链接文字⟧](https://)') },
    { label: '代码块', hint: '带语法高亮', alias: 'code daimakuai dmk', snip: mk('```js\n⟦⟧\n```') },
    { label: '引用', hint: 'blockquote', alias: 'quote yinyong qy', snip: mk('> ⟦⟧') },
    { label: '分隔线', hint: '---', alias: 'hr fengeXian fgx', snip: mk('---') },
    { label: '任务列表', hint: '- [ ]', alias: 'todo task renwu rw', snip: mk('- [ ] ⟦⟧') },
    { label: '无序列表', hint: '- 项目', alias: 'ul list wuxu wbx', snip: mk('- ⟦⟧') },
    { label: '有序列表', hint: '1. 项目', alias: 'ol list youxu yx', snip: mk('1. ⟦⟧') },
    { label: '一级标题', hint: '# 标题', alias: 'h1 heading yiji bt', snip: mk('# ⟦⟧') },
    { label: '二级标题', hint: '## 标题', alias: 'h2 heading erji bt', snip: mk('## ⟦⟧') },
    { label: '三级标题', hint: '### 标题', alias: 'h3 heading sanji bt', snip: mk('### ⟦⟧') },
    { label: '粗体', hint: '**文字**', alias: 'bold cuti ct', snip: mk('**⟦粗体⟧**') },
    { label: '斜体', hint: '*文字*', alias: 'italic xieti xt', snip: mk('*⟦斜体⟧*') },
    { label: '删除线', hint: '~~文字~~', alias: 'strike shanchuxian scx', snip: mk('~~⟦删除线⟧~~') },
    { label: '行内代码', hint: '`代码`', alias: 'inline hangnei hndm', snip: mk('`⟦代码⟧`') },
    { label: '日期', hint: date, alias: 'date riqi rq', snip: { text: date, sel: null } },
    { label: '时间', hint: time, alias: 'time shijian sj', snip: { text: time, sel: null } },
    { label: '日期时间', hint: date + ' ' + time, alias: 'datetime riqishijian rqsj', snip: { text: date + ' ' + time, sel: null } },
  ];
}

const slashMenu = document.createElement('div');
slashMenu.id = 'slash-menu';
slashMenu.style.display = 'none';
editorHost.appendChild(slashMenu);

const slash = { open: false, anchor: -1, query: '', items: [], selected: 0, pendingConfirm: 0 };

function closeSlash() {
  slash.open = false;
  slash.pendingConfirm = 0;
  slashMenu.style.display = 'none';
  slashMenu.textContent = '';
}

function filterSlash() {
  const q = slash.query.toLowerCase();
  slash.items = buildSnippets().filter(
    (it) => !q || it.label.includes(slash.query) || it.alias.includes(q)
  );
  if (!slash.items.length) {
    closeSlash();
    return;
  }
  slash.selected = 0;
  renderSlash();
}

// 输入法的拼音分音节撇号会混进查询词（真实事件日志里能看到 "b'f"→"bf"），
// 匹配前一律剥掉，否则菜单会在组合中途被误关。
const slashQueryOf = (text) => String(text || '').replace(/['\u2019]/g, '');

// 查询词「整词」命中某个条目的英文别名时才返回该条目。
// 必须是整词而不是子串：输入 /b 时不能误插，输入 /bg 才插。
function slashItemForExactAlias(query) {
  const q = slashQueryOf(query).trim().toLowerCase();
  if (!q) return null;
  return buildSnippets().find((it) => it.alias.toLowerCase().split(/\s+/).includes(q)) || null;
}

function renderSlash() {
  slashMenu.textContent = '';
  slash.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'slash-item' + (i === slash.selected ? ' sel' : '');
    const label = document.createElement('span');
    label.textContent = it.label;
    const hint = document.createElement('span');
    hint.className = 'slash-hint';
    hint.textContent = it.hint;
    row.appendChild(label);
    if (it.label === '表格') {
      const preview = document.createElement('span');
      preview.className = 'slash-table-preview';
      preview.setAttribute('aria-hidden', 'true');
      for (let cell = 0; cell < 6; cell++) preview.appendChild(document.createElement('i'));
      row.appendChild(preview);
    }
    row.appendChild(hint);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySnippet(it);
    });
    slashMenu.appendChild(row);
  });
  slashMenu.style.display = 'block';
  scrollSlashSelectionIntoView();
  positionSlash();
}

// 列表重建会把 scrollTop 归零，这里把选中项重新带回可视区（↑↓ 时列表跟着翻）
function scrollSlashSelectionIntoView() {
  const row = slashMenu.children[slash.selected];
  if (!row) return;
  const pad = 4; // 与 #slash-menu 的 padding 对齐，留一点余量
  const top = row.offsetTop - pad;
  const bottom = row.offsetTop + row.offsetHeight + pad;
  if (top < slashMenu.scrollTop) {
    slashMenu.scrollTop = Math.max(0, top);
  } else if (bottom > slashMenu.scrollTop + slashMenu.clientHeight) {
    slashMenu.scrollTop = bottom - slashMenu.clientHeight;
  }
}

function positionSlash() {
  let coords = null;
  try { coords = view.coordsAtPos(slash.anchor); } catch {}
  if (!coords) return;
  const host = editorHost.getBoundingClientRect();
  let left = coords.left - host.left;
  let top = coords.bottom - host.top + 4;
  if (left + slashMenu.offsetWidth > host.width - 8) {
    left = Math.max(8, host.width - slashMenu.offsetWidth - 8);
  }
  if (top + slashMenu.offsetHeight > host.height - 8) {
    top = coords.top - host.top - slashMenu.offsetHeight - 4;
  }
  slashMenu.style.left = Math.max(8, left) + 'px';
  slashMenu.style.top = Math.max(8, top) + 'px';
}

function applySnippet(item) {
  if (!slash.open) return;
  const from = slash.anchor;
  const to = view.state.selection.main.head;
  const isTable = item.label === '表格';
  const prefix = isTable && from > view.state.doc.lineAt(from).from ? '\n\n' : '';
  // 表尾加空行：node.to 本身仍属于表内，必须让光标真正离开整表。
  const insert = prefix + item.snip.text + (isTable ? '\n\n' : '');
  const selEnd = insert.length;
  const sel = item.snip.sel || { anchor: selEnd, head: selEnd };
  closeSlash();
  view.dispatch({
    changes: { from, to, insert },
    // 表格：光标放到表外（末尾），让卡片立即渲染并聚焦第一个表头格
    selection: isTable
      ? { anchor: from + selEnd }
      : { anchor: from + sel.anchor, head: from + sel.head },
    userEvent: 'input.complete',
  });
  view.focus();
  if (isTable) {
    requestTableCellFocus(from + prefix.length, 0, 0, 260);
  }
}

function handleSlashKey(event) {
  if (event.isComposing || event.keyCode === 229 || view.composing) return false;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const dir = event.key === 'ArrowDown' ? 1 : -1;
    slash.selected = (slash.selected + dir + slash.items.length) % slash.items.length;
    renderSlash();
    return true;
  }
  // 空格确认（输入法场景下空格常被占用，回车/Tab 始终可用）
  if (event.key === ' ' && !event.isComposing) {
    applySnippet(slash.items[slash.selected]);
    return true;
  }
  if (event.key === 'Enter' || event.key === 'Tab') {
    applySnippet(slash.items[slash.selected]);
    return true;
  }
  if (event.key === 'Escape') {
    closeSlash();
    return true;
  }
  return false;
}

// 输入法组合态下，回车 / 空格 / Tab 都是给输入法上屏用的，而 CodeMirror 会直接丢弃
// 组合期间的全部键盘事件（@codemirror/view 的 DOMObserver.ignoreDuringComposition），
// 所以 CM 的 keydown 处理器与 keymap 都收不到这次「确认」，文档会停在孤零零的 /bg。
// 解决：在 DOM 捕获阶段旁听（早于 CM 的观察器），只记下确认意图（时间戳），
// 等组合结束、上屏文本真正并入文档后再补一次确认。
// 空格中文输入法下是选择/上屏候选键：若上屏的是中文，查询词会变且菜单关闭，
// confirmSlashAfterComposition 重新核对后不会误插。
const SLASH_IME_CONFIRM_MS = 1200;

editorHost.addEventListener('keydown', (event) => {
  if (!slash.open) return;
  if (event.key !== 'Enter' && event.key !== 'Tab' && event.key !== ' ') return;
  if (!(event.isComposing || event.keyCode === 229 || view.composing)) return;
  slash.pendingConfirm = Date.now();
}, true);

// 组合结束后按当前文档重新核对查询词，仍匹配才确认，避免误插。
// fromKeydown：上屏前收到过明确的确认键（keydown 先、compositionend 后的引擎顺序）。
// 真实中文输入法（实测 Windows 微软拼音）的顺序是 compositionend 在前，紧随其后的那次
// 按键 key='Process'、keyCode=229、isComposing=false，无法辨认是回车还是空格，
// 所以只能靠「查询词整词命中英文别名」来判定，例如 /bg。
function confirmSlashAfterComposition(fromKeydown) {
  if (!slash.open || !slash.items.length) return;
  const head = view.state.selection.main.head;
  if (head <= slash.anchor) { closeSlash(); return; }
  const q = slashQueryOf(view.state.doc.sliceString(slash.anchor + 1, head));
  if (/[\s/]/.test(q) || q.length > 20) { closeSlash(); return; }
  if (q !== slash.query) {
    slash.query = q;
    filterSlash();
    if (!slash.open || !slash.items.length) return;
  }
  const exact = slashItemForExactAlias(q);
  if (!fromKeydown && !exact) return;
  applySnippet(exact || slash.items[slash.selected]);
}

document.addEventListener('compositionend', () => {
  const at = slash.pendingConfirm;
  slash.pendingConfirm = 0;
  const fromKeydown = !!(at && Date.now() - at <= SLASH_IME_CONFIRM_MS);
  // 让 CodeMirror 先把上屏文本并入文档，再按最新文档确认
  setTimeout(() => confirmSlashAfterComposition(fromKeydown), 0);
});

function handleSlashUpdate(u) {
  if (!u.docChanged && !u.selectionSet) return;
  const head = u.state.selection.main.head;

  if (!slash.open) {
    if (u.docChanged && !view.composing) {
      const ch = u.state.doc.sliceString(head - 1, head);
      const prev = u.state.doc.sliceString(head - 2, head - 1);
      if (ch === '/' && (prev === '' || /\s/.test(prev))) {
        slash.open = true;
        slash.anchor = head - 1;
        slash.query = '';
        filterSlash();
      }
    }
    return;
  }

  if (head <= slash.anchor) {
    closeSlash();
    return;
  }
  const raw = u.state.doc.sliceString(slash.anchor + 1, head);
  if (/[\s/]/.test(raw) || raw.length > 20) {
    closeSlash();
    return;
  }
  slash.query = slashQueryOf(raw);
  filterSlash();
}

// 光标是否在围栏代码块内部（避免在代码块里粘贴时再包一层围栏）
function isInsideCodeBlock(v) {
  let node = syntaxTree(v.state).resolveInner(v.state.selection.main.head, -1);
  while (node) {
    if (node.name === 'FencedCode') return true;
    node = node.parent;
  }
  return false;
}

// ---------- 编辑命令 ----------

// Ctrl+B / Ctrl+I：用 ** 或 * 包裹选中文字；无选中时插入成对记号
function wrapMark(mark) {
  return (view) => {
    if (view.composing) return false;
    const range = view.state.selection.main;
    if (!range.empty) {
      view.dispatch({
        changes: [
          { from: range.from, insert: mark },
          { from: range.to, insert: mark },
        ],
        selection: { anchor: range.from + mark.length, head: range.to + mark.length },
        userEvent: 'input.wrap',
      });
    } else {
      view.dispatch({
        changes: { from: range.from, insert: mark + mark },
        selection: { anchor: range.from + mark.length },
        userEvent: 'input.wrap',
      });
    }
    return true;
  };
}

const LIST_ITEM = /^(\s*)([-*+]|\d+\.)(\s+)(.*)$/;
const ORDERED_BULLET = /^(\d+)\.$/;

// 有序列表项该显示什么记号：层级 0 用源码里的数字，层级 1 用 a./b.，
// 层级 2 用 i./ii.，再深的层级循环回数字（与常见公文/大纲习惯一致）。
// lezer 的树形是 OrderedList/BulletList > ListItem > ListMark，嵌套列表挂在 ListItem 里。
function orderedListMarker(node, sourceMark) {
  let item = node.parent;
  while (item && item.name !== 'ListItem') item = item.parent;
  if (!item) return sourceMark;
  let depth = 0;
  for (let n = item.parent; n; n = n.parent) {
    if (n.name === 'OrderedList' || n.name === 'BulletList') depth++;
  }
  depth = Math.max(0, depth - 1);
  const level = depth % 3;
  if (level === 0) return sourceMark;
  // 同级里的序号
  let index = 0;
  const parent = item.parent;
  if (parent) {
    for (let c = parent.firstChild; c; c = c.nextSibling) {
      if (c.name === 'ListItem') {
        if (c.from === item.from) break;
        index++;
      }
    }
  }
  if (level === 1) return String.fromCharCode(97 + (index % 26)) + '.';
  return (LIST_ROMAN[index] || String(index + 1)) + '.';
}

// 回车自动续写列表（- / * / 1.），空列表项回车退出列表
function listContinuation(view) {
  if (view.composing) return false;
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) return false;
  const line = state.doc.lineAt(range.head);
  const m = line.text.match(LIST_ITEM);
  if (!m) return false;
  if (range.head !== line.to) return false; // 仅在行尾回车时接手

  const indent = m[1] || '';
  const bullet = m[2] || '';
  const sp = m[3] || ' ';
  const rest = m[4] || '';
  if (rest === '') {
    // 空列表项：清掉记号退出列表
    view.dispatch({
      changes: { from: line.from, to: line.to },
      selection: { anchor: line.from },
      userEvent: 'input',
    });
    return true;
  }
  const num = bullet.match(ORDERED_BULLET);
  const next = num ? String(Number(num[1]) + 1) + '.' : bullet;
  view.dispatch({
    changes: { from: line.to, insert: '\n' + indent + next + sp },
    selection: { anchor: line.to + 1 + indent.length + next.length + sp.length },
    userEvent: 'input',
  });
  return true;
}

// Tab：列表行整项缩进（在项内任意位置按 Tab 都缩进整行），普通行插入一个缩进格
function tabIndent(view) {
  if (view.composing) return false;
  const unit = ' '.repeat(uiSettings.tabWidth);
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) {
    const changes = [];
    for (let line = state.doc.lineAt(sel.from); ; ) {
      changes.push({ from: line.from, insert: unit });
      if (line.to >= sel.to) break;
      line = state.doc.lineAt(line.to + 1);
    }
    view.dispatch({ changes, userEvent: 'input.indent' });
    return true;
  }
  // 列表项：缩进必须加在整行行首（记号之前）。否则光标停在文字中间时，
  // 只会在光标处插入空格、记号和整项都不动 —— 用户就得先把光标移到记号前面。
  const line = state.doc.lineAt(sel.from);
  const from = LIST_ITEM.test(line.text) ? line.from : sel.from;
  view.dispatch({
    changes: { from, insert: unit },
    selection: { anchor: sel.from + unit.length },
    userEvent: 'input.indent',
  });
  return true;
}

// Shift+Tab：每行去掉至多一个缩进格的前导空格
function tabDedent(view) {
  const re = new RegExp('^ {1,' + uiSettings.tabWidth + '}');
  const { state } = view;
  const sel = state.selection.main;
  const changes = [];
  for (let line = state.doc.lineAt(sel.from); ; ) {
    const m = line.text.match(re);
    if (m) changes.push({ from: line.from, to: line.from + m[0].length });
    if (line.to >= sel.to) break;
    line = state.doc.lineAt(line.to + 1);
  }
  if (!changes.length) return false;
  view.dispatch({ changes, userEvent: 'delete.dedent' });
  return true;
}

// ---------- 编辑器实例 ----------

const view = new EditorView({
  state: EditorState.create({
    doc: '',
    extensions: [
      historyComp.of(history()),
      EditorView.lineWrapping,
      indentComp.of(indentUnit.of('  ')), // Tab/自动缩进宽度（设置可改为 4）
      placeholder('记下此刻的灵感…'),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(highlight),
      previewComp.of([mdPreview, tableCard]),
      codeCard,
      keymap.of([
        { key: 'Enter', run: tableEnter },
        { key: 'Tab', run: (v) => tableTab(v, false), shift: (v) => tableTab(v, true) },
        { key: 'Backspace', run: (v) => tableDeleteGuard(v, false) },
        { key: 'Delete', run: (v) => tableDeleteGuard(v, true) },
        { key: 'Enter', run: listContinuation },
        { key: 'Mod-b', run: wrapMark('**') },
        { key: 'Mod-i', run: wrapMark('*') },
        { key: 'Tab', run: tabIndent, shift: tabDedent },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      Prec.high(EditorView.domEventHandlers({
        // 粘贴代码：无围栏的裸代码自动包上带语言的围栏；带围栏但无语言的自动补标签
        paste(event) {
          // 剪贴板里是图片（截图等）→ 先落盘再插入 ![]()，其余粘贴逻辑不受影响
          const image = imageFromClipboard(event.clipboardData);
          if (image) {
            event.preventDefault();
            void insertPastedImage(image);
            return true;
          }
          const text = event.clipboardData && event.clipboardData.getData('text/plain');
          if (!text) return false;
          if (text.indexOf('```') !== -1) {
            const normalized = addLangsToBareFences(text);
            if (normalized === text) return false;
            event.preventDefault();
            view.dispatch(view.state.replaceSelection(normalized));
            return true;
          }
          const lang = guessLanguage(text);
          if (!lang || isInsideCodeBlock(view)) return false;
          event.preventDefault();
          const fenced = '```' + lang + '\n' + text.replace(/\n+$/, '') + '\n```';
          view.dispatch(view.state.replaceSelection(fenced));
          return true;
        },
        contextmenu(event) {
          const sel = view.state.selection.main;
          if (sel.empty) return false;
          event.preventDefault();
          showCtxMenu(event.clientX, event.clientY);
          return true;
        },
        keydown(event) {
          if (event.isComposing || event.keyCode === 229) return false;
          if (settingsOpen && event.key === 'Escape') {
            closeSettings();
            return true;
          }
          if (ctxOpen && event.key === 'Escape') {
            hideCtx();
            return true;
          }
          if (modalOpen && event.key === 'Escape') {
            closeModal();
            return true;
          }
          if (slash.open && handleSlashKey(event)) return true;
          if (event.key === 'Escape') {
            flushAndSend();
            bridge.hide();
            return true;
          }
          if (event.altKey && !event.ctrlKey && (event.key === 'n' || event.key === 'N')) {
            flushAndSend();
            bridge.newPage();
            return true;
          }
          // Alt+Del：删除当前页（普通 Del 完全保留给文本编辑）
          if (
            event.altKey && !event.ctrlKey && !event.shiftKey && !event.metaKey &&
            event.key === 'Delete' && currentFile
          ) {
            event.preventDefault();
            confirmDelete({ path: currentFile });
            return true;
          }
          if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === '=' || event.key === '+')) {
            event.preventDefault();
            stepFontSize(1);
            return true;
          }
          if (event.ctrlKey && !event.altKey && !event.metaKey && (event.key === '-' || event.key === '_')) {
            event.preventDefault();
            stepFontSize(-1);
            return true;
          }
          if (event.ctrlKey && !event.altKey && (event.key === 's' || event.key === 'S')) {
            flushAndSend();
            return true;
          }
          return false;
        },
      })),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          // 开始打字就收起回顾横幅：它是唤起记忆用的，不该挡着你写
          if (u.transactions.some((tr) => tr.isUserEvent('input') || tr.isUserEvent('delete'))) hideReview();
          renderTitle();
          renderCurrentTags(); // 正文下方的标签栏：随文档即时更新
          clearTimeout(saveTimer);
          saveTimer = setTimeout(saveNow, 600);
        }
        if (u.selectionSet) hideCtx();
        handleSlashUpdate(u);
      }),
    ],
  }),
  parent: editorHost,
});

// 主进程收起/退出时从这里拉取内容与光标
window.__noteSnapshot = () => {
  flushTableInput(true);
  return JSON.stringify({ t: view.state.doc.toString(), c: view.state.selection.main.head });
};

// 表格卡片交互（卡片 ignoreEvent）：按钮改结构；单元格是 contenteditable，原生聚焦编辑
editorHost.addEventListener('mousedown', (e) => {
  const btn = e.target.closest('.cm-table-wrap button');
  if (!btn) return;
  e.preventDefault();
  const tableFrom = Number(btn.closest('.cm-table-wrap').dataset.tableFrom);
  endTableEdit(); // 结构变化前先落盘未同步的输入
  const arg = btn.dataset.arg != null ? Number(btn.dataset.arg) : null;
  tableStructOp(btn.dataset.op, arg, { tableFrom });
});

// 滚动 / 窗口失焦时收起斜杠菜单
view.scrollDOM.addEventListener('scroll', closeSlash, true);
window.addEventListener('blur', closeSlash);

// ---------- 链接跳转（Ctrl/Cmd + 点击） ----------

function linkNodeAt(st, pos) {
  let node = syntaxTree(st).resolveInner(pos, 1);
  while (node) {
    if (node.name === 'Link' || node.name === 'Autolink') return node;
    node = node.parent;
  }
  return null;
}

// 从链接源码里取目标地址：<https://x>、[文字](https://x "标题")、[文字](<带 空格>)
function linkTargetOf(st, node) {
  const raw = st.doc.sliceString(node.from, node.to).trim();
  const angle = /^<([^>]+)>$/.exec(raw);
  if (angle) return angle[1].trim();
  const md = /^\[[^\]]*\]\(\s*(?:<([^>]*)>|([^\s)]+?))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/.exec(raw);
  if (md) return (md[1] !== undefined ? md[1] : md[2] || '').trim();
  return '';
}

// 命中链接时在这里拦下来：交给主进程决定用浏览器还是系统默认程序打开
editorHost.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !(event.ctrlKey || event.metaKey)) return;
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos == null) return;
  const node = linkNodeAt(view.state, pos);
  if (!node) return;
  const target = linkTargetOf(view.state, node);
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  bridge.openLink(target);
}, true);

// ---------- 主题（跟随系统，由主进程推送） ----------

bridge.onTheme((theme) => {
  document.body.classList.toggle('theme-light', theme === 'light');
});

// ---------- 应用内确认弹窗（替代原生 MessageBox，样式跟随主题） ----------

const modalMask = document.createElement('div');
modalMask.id = 'modal-mask';
modalMask.hidden = true;
const modalCard = document.createElement('div');
modalCard.id = 'modal';
modalCard.setAttribute('role', 'dialog');
modalCard.setAttribute('aria-modal', 'true');
const modalTitle = document.createElement('div');
modalTitle.id = 'modal-title';
const modalText = document.createElement('div');
modalText.id = 'modal-text';
const modalActions = document.createElement('div');
modalActions.id = 'modal-actions';
const modalCancel = document.createElement('button');
modalCancel.id = 'modal-cancel';
modalCancel.textContent = '取消';
const modalOk = document.createElement('button');
modalOk.id = 'modal-ok';
modalActions.appendChild(modalCancel);
modalActions.appendChild(modalOk);
modalCard.appendChild(modalTitle);
modalCard.appendChild(modalText);
modalCard.appendChild(modalActions);
modalMask.appendChild(modalCard);
document.body.appendChild(modalMask);
let modalOpen = false;
let modalOnOk = null;

function openModal({ title, text, okLabel, danger, onOk }) {
  modalTitle.textContent = title;
  modalText.textContent = text;
  modalOk.textContent = okLabel;
  modalOk.classList.toggle('danger', !!danger);
  modalOnOk = onOk;
  modalOpen = true;
  modalMask.hidden = false;
  modalCancel.focus();
}

function closeModal() {
  if (!modalOpen) return;
  modalOpen = false;
  modalMask.hidden = true;
  modalOnOk = null;
}

modalCancel.addEventListener('click', closeModal);
modalOk.addEventListener('click', () => {
  const fn = modalOnOk;
  closeModal();
  if (fn) fn();
});
modalMask.addEventListener('mousedown', (e) => {
  if (e.target === modalMask) closeModal();
});

function confirmDelete(page) {
  const name = page.path.split(/[\\/]/).pop();
  openModal({
    title: '删除这一页？',
    text: name + ' 将被永久删除，不可恢复。',
    okLabel: '删除',
    danger: true,
    onOk: () => {
      bridge.deletePage(page.path).then((r) => {
        if (r && r.ok) refreshList();
      });
    },
  });
}

// ---------- 设置面板 ----------

const settingsMask = document.getElementById('settings-mask');
const hotkeyBtn = document.getElementById('set-hotkey');
let settingsOpen = false;
let hotkeyListening = false;
let lastHotkey = 'Alt+Q';

function segSet(id, v) {
  for (const b of document.getElementById(id).querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === v);
  }
}

function fillSettings(s) {
  lastHotkey = s.hotkey;
  hotkeyBtn.textContent = s.hotkey;
  hotkeyBtn.classList.remove('listening', 'fail');
  segSet('set-theme', s.theme);
  document.getElementById('set-autostart').checked = !!s.autostart;
  document.getElementById('set-notesdir').textContent = s.notesDir;
  document.getElementById('set-font-size').textContent = s.fontSize;
  segSet('set-tabwidth', String(s.tabWidth));
  document.getElementById('set-livepreview').checked = s.livePreview !== false;
  document.getElementById('set-linenumbers').checked = s.lineNumbers !== false;
  document.getElementById('set-indentdots').checked = s.indentDots !== false;
  document.getElementById('set-alwaysontop').checked = s.alwaysOnTop !== false;
  segSet('set-reviewmode', s.reviewMode || 'daily');
  segSet('set-reviewdays', String(s.reviewMinDays || 7));
  document.getElementById('set-version').textContent = 'NoteAnywhere v' + s.version;
}

// 打开设置时焦点会离开编辑区；记住它，关闭面板后归还，
// 否则用户关掉设置后焦点停在头部按钮上，得重新点回表格单元格。
let settingsReturnFocus = null;

async function openSettings() {
  if (!settingsOpen && !settingsReturnFocus) settingsReturnFocus = document.activeElement;
  try {
    fillSettings(await bridge.getSettings());
  } catch {}
  settingsOpen = true;
  settingsMask.hidden = false;
}

function closeSettings() {
  if (!settingsOpen) return;
  settingsOpen = false;
  hotkeyListening = false;
  settingsMask.hidden = true;
  const back = settingsReturnFocus;
  settingsReturnFocus = null;
  const td = back && back.isConnected && back.closest ? back.closest('td[data-line]') : null;
  if (td) { focusTableCell(td); return; }
  if (back && back.isConnected && back.focus) back.focus();
  resumeTableFocusIntent();
}

// 面板打断过一次表格聚焦（例如 /bg 插入后的自动聚焦）时，关掉面板后续上；
// 期间用户若移动过光标则视为意图失效，不抢焦点。
function resumeTableFocusIntent() {
  if (!tableFocusIntent || tableFocusIntent.caret !== view.state.selection.main.head) return;
  const { from, line, col } = tableFocusIntent;
  requestTableCellFocus(from, line, col);
}

function updateHintKeys(hotkey) {
  const el = document.querySelector('#hint span:first-child');
  if (el && hotkey) el.textContent = hotkey + ' / Esc 收起并保存 · Alt+N 新建 · Alt+Del 删除本页';
}

// 主进程推送设置变化：应用并同步面板
bridge.onSettingsChanged((s) => {
  uiSettings.fontSize = s.fontSize || 15;
  uiSettings.tabWidth = s.tabWidth === 4 ? 4 : 2;
  uiSettings.lineNumbers = s.lineNumbers !== false;
  uiSettings.indentDots = s.indentDots !== false;
  document.documentElement.style.setProperty('--font-size', uiSettings.fontSize + 'px');
  view.dispatch({
    effects: [
      indentComp.reconfigure(indentUnit.of(' '.repeat(uiSettings.tabWidth))),
      previewComp.reconfigure(s.livePreview === false ? [] : [mdPreview, tableCard]),
    ],
  });
  if (s.hotkey) {
    lastHotkey = s.hotkey;
    updateHintKeys(s.hotkey);
  }
  if (settingsOpen) {
    bridge.getSettings().then(fillSettings).catch(() => {});
  }
});

bridge.onOpenSettings(() => openSettings());

// mousedown 早于按钮自身获得焦点，此刻记下的才是用户原本的焦点位置；
// 再次点按钮是「关闭」，别用按钮自己的焦点覆盖掉打开前记录的位置。
document.getElementById('settings-btn').addEventListener('mousedown', () => {
  if (!settingsOpen) settingsReturnFocus = document.activeElement;
}, true);
document.getElementById('settings-btn').addEventListener('click', () => {
  settingsOpen ? closeSettings() : openSettings();
});
document.getElementById('settings-close').addEventListener('click', closeSettings);

// Esc 关闭设置面板：面板打开时焦点在面板控件上，编辑器的 keydown 收不到按键，
// 必须在 DOM 层兜住（正在录制热键时让给热键录制逻辑自己处理）。
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return;
  if (!settingsOpen || hotkeyListening) return;
  event.preventDefault();
  closeSettings();
}, true);
settingsMask.addEventListener('mousedown', (e) => {
  if (e.target === settingsMask) closeSettings();
});

// 主题
document.getElementById('set-theme').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  bridge.setSetting('theme', b.dataset.v).then((r) => r && r.ok && segSet('set-theme', b.dataset.v));
});

// Tab 宽度
document.getElementById('set-tabwidth').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  bridge.setSetting('tabWidth', Number(b.dataset.v)).then((r) => r && r.ok && segSet('set-tabwidth', b.dataset.v));
});
document.getElementById('set-reviewmode').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  bridge.setSetting('reviewMode', b.dataset.v).then((r) => r && r.ok && segSet('set-reviewmode', b.dataset.v));
});
document.getElementById('set-reviewdays').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  bridge.setSetting('reviewMinDays', Number(b.dataset.v)).then((r) => r && r.ok && segSet('set-reviewdays', b.dataset.v));
});

// 开关类
for (const [id, key] of [
  ['set-autostart', 'autostart'],
  ['set-livepreview', 'livePreview'],
  ['set-linenumbers', 'lineNumbers'],
  ['set-indentdots', 'indentDots'],
  ['set-alwaysontop', 'alwaysOnTop'],
]) {
  const el = document.getElementById(id);
  el.addEventListener('change', () => bridge.setSetting(key, el.checked));
}

// 字号
const fontSizeEl = document.getElementById('set-font-size');
document.getElementById('set-font-minus').addEventListener('click', () => {
  const n = Math.max(14, Number(fontSizeEl.textContent) - 1);
  bridge.setSetting('fontSize', n).then((r) => r && r.ok && (fontSizeEl.textContent = n));
});
document.getElementById('set-font-plus').addEventListener('click', () => {
  const n = Math.min(18, Number(fontSizeEl.textContent) + 1);
  bridge.setSetting('fontSize', n).then((r) => r && r.ok && (fontSizeEl.textContent = n));
});

// 保存目录
document.getElementById('set-notesdir-change').addEventListener('click', async () => {
  const r = await bridge.pickNotesDir();
  if (r && r.ok) {
    notesDirCache = String(r.dir || ''); // 相对图片路径的解析基准随之更新
    document.getElementById('set-notesdir').textContent = r.dir;
    refreshList();
  }
});
document.getElementById('set-notesdir-open').addEventListener('click', () => bridge.openPath('notes'));
document.getElementById('set-open-notes').addEventListener('click', () => bridge.openPath('notes'));
document.getElementById('set-open-userdata').addEventListener('click', () => bridge.openPath('userData'));
document.getElementById('set-reset-window').addEventListener('click', () => bridge.resetWindow());

// 热键录入：点击后捕获下一个组合键（Esc 取消）
hotkeyBtn.addEventListener('click', () => {
  if (hotkeyListening) return;
  hotkeyListening = true;
  hotkeyBtn.textContent = '按下新组合键…';
  hotkeyBtn.classList.add('listening');
  hotkeyBtn.classList.remove('fail');
});

function accelFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null; // 只有修饰键
  const k = e.key;
  const named = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  let key = null;
  if (named[k] !== undefined) key = named[k];
  else if (/^[a-zA-Z0-9]$/.test(k)) key = k.toUpperCase();
  else if (/^F([1-9]|1[0-2])$/.test(k)) key = k;
  else if (k.length === 1) key = k;
  if (!key || !mods.length) return null;
  return mods.join('+') + '+' + key;
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!hotkeyListening) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      hotkeyListening = false;
      hotkeyBtn.textContent = lastHotkey;
      hotkeyBtn.classList.remove('listening');
      return;
    }
    const acc = accelFromEvent(e);
    if (!acc) return; // 等待完整组合
    hotkeyListening = false;
    bridge.setSetting('hotkey', acc).then((r) => {
      if (r && r.ok) {
        hotkeyBtn.textContent = acc;
        lastHotkey = acc;
        hotkeyBtn.classList.remove('listening');
        updateHintKeys(acc);
      } else {
        hotkeyBtn.textContent = (r && r.error) || '注册失败';
        hotkeyBtn.classList.remove('listening');
        hotkeyBtn.classList.add('fail');
        setTimeout(() => {
          hotkeyBtn.textContent = lastHotkey;
          hotkeyBtn.classList.remove('fail');
        }, 1600);
      }
    });
  },
  true
);

// ---------- 选中文字右键格式菜单 ----------

const ctxMenu = document.createElement('div');
ctxMenu.id = 'ctx-menu';
ctxMenu.style.display = 'none';
editorHost.appendChild(ctxMenu);

let ctxOpen = false;
let ctxSel = null; // {from, to} 打开菜单时的选区

function hideCtx() {
  if (!ctxOpen) return;
  ctxOpen = false;
  ctxMenu.style.display = 'none';
  ctxMenu.textContent = '';
  ctxSel = null;
}

// 在选区所在行查找“包裹住选区”的 open/close 标记对（容忍选区边界不精确）
function findEnclosing(sel, open, close) {
  const doc = view.state.doc;
  if (doc.lineAt(sel.from).number !== doc.lineAt(sel.to).number) return null;
  const line = doc.lineAt(sel.from);
  const text = line.text;
  let idx = 0;
  while ((idx = text.indexOf(open, idx)) !== -1) {
    const closeIdx = text.indexOf(close, idx + open.length);
    if (closeIdx === -1) return null;
    const openFrom = line.from + idx;
    const contentFrom = openFrom + open.length;
    const contentTo = line.from + closeIdx;
    const closeTo = contentTo + close.length;
    if (sel.from >= contentFrom && sel.to <= contentTo) {
      return { openFrom, contentFrom, contentTo, closeTo };
    }
    idx = closeIdx + close.length;
  }
  return null;
}

// 查找包裹选区的字号 span
function findSpan(sel) {
  const doc = view.state.doc;
  if (doc.lineAt(sel.from).number !== doc.lineAt(sel.to).number) return null;
  const line = doc.lineAt(sel.from);
  const text = line.text;
  let idx = 0;
  while ((idx = text.indexOf('<span style="font-size:', idx)) !== -1) {
    const gt = text.indexOf('>', idx);
    const closeIdx = gt === -1 ? -1 : text.indexOf('</span>', gt);
    if (gt === -1 || closeIdx === -1) return null; // 标签残缺，不处理
    const openFrom = line.from + idx;
    const openTo = line.from + gt + 1;
    const contentFrom = openTo;
    const contentTo = line.from + closeIdx;
    const closeTo = contentTo + 7;
    if (sel.from >= contentFrom && sel.to <= contentTo) {
      const sm = text.slice(idx, gt).match(/(\d+)px/);
      return { openFrom, openTo, contentFrom, contentTo, closeTo, size: sm ? Number(sm[1]) : null };
    }
    idx = closeIdx + 7;
  }
  return null;
}

// 包裹/取消包裹（选区落在已包裹内容内任意位置都识别为“取消”）
function applyWrap(open, close) {
  const sel = ctxSel || view.state.selection.main;
  const enc = findEnclosing(sel, open, close);
  let changes;
  let anchor;
  let head;
  if (enc) {
    changes = [
      { from: enc.openFrom, to: enc.contentFrom },
      { from: enc.contentTo, to: enc.closeTo },
    ];
    anchor = enc.openFrom;
    head = enc.contentTo - open.length;
  } else {
    changes = [
      { from: sel.from, insert: open },
      { from: sel.to, insert: close },
    ];
    anchor = sel.from + open.length;
    head = sel.to + open.length;
  }
  view.dispatch({ changes, selection: { anchor, head }, userEvent: 'input.wrap' });
  view.focus();
}

const FONT_SIZES = [12, 14, 16, 18, 20, 24];

function applyFontSize(px) {
  const sel = ctxSel || view.state.selection.main;
  const open = '<span style="font-size:' + px + 'px">';
  view.dispatch({
    changes: [
      { from: sel.from, insert: open },
      { from: sel.to, insert: '</span>' },
    ],
    selection: { anchor: sel.from + open.length, head: sel.to + open.length },
    userEvent: 'input.wrap',
  });
  view.focus();
}

// Ctrl+= / Ctrl+-：有选区时步进选区字号（±2px，10–28）；无选区时调整全局正文字号（14–18）
function stepFontSize(dir) {
  const sel = view.state.selection.main;
  if (sel.empty) {
    const next = Math.min(18, Math.max(14, uiSettings.fontSize + dir));
    if (next !== uiSettings.fontSize) bridge.setSetting('fontSize', next);
    return;
  }
  const enc = findSpan(sel);
  if (enc && enc.size) {
    // 已包裹：只替换开标签（尺寸写在开标签里），内容与选区原位不动
    const next = Math.min(28, Math.max(10, enc.size + dir * 2));
    const open = '<span style="font-size:' + next + 'px">';
    view.dispatch({
      changes: [{ from: enc.openFrom, to: enc.openTo, insert: open }],
      selection: { anchor: sel.from, head: sel.to },
      userEvent: 'input.wrap',
    });
    return;
  }
  const open = '<span style="font-size:' + Math.min(28, Math.max(10, uiSettings.fontSize + dir * 2)) + 'px">';
  view.dispatch({
    changes: [
      { from: sel.from, insert: open },
      { from: sel.to, insert: '</span>' },
    ],
    selection: { anchor: sel.from + open.length, head: sel.to + open.length },
    userEvent: 'input.wrap',
  });
}

function ctxRow(label, hint, run, keepOpen) {
  const row = document.createElement('div');
  row.className = 'ctx-item';
  const l = document.createElement('span');
  l.textContent = label;
  row.appendChild(l);
  if (hint) {
    const h = document.createElement('span');
    h.className = 'slash-hint';
    h.textContent = hint;
    row.appendChild(h);
  }
  row.addEventListener('mousedown', (e) => {
    e.preventDefault();
    run();
    if (!keepOpen) hideCtx();
  });
  return row;
}

function renderCtxMenu(page) {
  ctxMenu.textContent = '';
  if (page === 'size') {
    ctxMenu.appendChild(ctxRow('← 返回', 'Esc', () => renderCtxMenu('main'), true));
    for (const px of FONT_SIZES) {
      ctxMenu.appendChild(ctxRow(px + ' px', '', () => applyFontSize(px)));
    }
    return;
  }
  const sel = ctxSel;
  ctxMenu.appendChild(
    ctxRow(findEnclosing(sel, '**', '**') ? '取消加粗' : '加粗', 'Ctrl+B', () => applyWrap('**', '**'))
  );
  ctxMenu.appendChild(
    ctxRow(findEnclosing(sel, '*', '*') ? '取消斜体' : '斜体', 'Ctrl+I', () => applyWrap('*', '*'))
  );
  ctxMenu.appendChild(ctxRow('调整字号', 'Ctrl+±', () => renderCtxMenu('size'), true));
  ctxMenu.appendChild(
    ctxRow(findEnclosing(sel, '<u>', '</u>') ? '取消下划线' : '下划线', '', () => applyWrap('<u>', '</u>'))
  );
  ctxMenu.appendChild(
    ctxRow(findEnclosing(sel, '<mark>', '</mark>') ? '取消荧光笔' : '荧光笔', '', () => applyWrap('<mark>', '</mark>'))
  );
  ctxMenu.appendChild(
    ctxRow(findEnclosing(sel, '`', '`') ? '取消行内代码' : '转换为代码', '', () => applyWrap('`', '`'))
  );
}

function showCtxMenu(x, y) {
  const sel = view.state.selection.main;
  if (sel.empty) return;
  ctxSel = { from: sel.from, to: sel.to };
  renderCtxMenu('main');
  ctxMenu.style.display = 'block';
  ctxOpen = true;
  const host = editorHost.getBoundingClientRect();
  let left = x - host.left;
  let top = y - host.top + 4;
  if (left + ctxMenu.offsetWidth > host.width - 8) left = host.width - ctxMenu.offsetWidth - 8;
  if (top + ctxMenu.offsetHeight > host.height - 8) top = y - host.top - ctxMenu.offsetHeight - 4;
  ctxMenu.style.left = Math.max(8, left) + 'px';
  ctxMenu.style.top = Math.max(8, top) + 'px';
}

// 点击菜单外部 / 滚动 / 选区变化时收起
window.addEventListener(
  'mousedown',
  (e) => {
    if (ctxOpen && e.button !== 2 && !ctxMenu.contains(e.target)) hideCtx();
  },
  true
);
view.scrollDOM.addEventListener('scroll', hideCtx, true);

// ---------- 侧栏文档列表 ----------

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const hm = p(d.getHours()) + ':' + p(d.getMinutes());
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return '今天 ' + hm;
  if (sameDay(d, yesterday)) return '昨天 ' + hm;
  if (d.getFullYear() === now.getFullYear()) return d.getMonth() + 1 + '月' + d.getDate() + '日 ' + hm;
  return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日';
}

async function refreshList() {
  let data;
  try {
    data = await bridge.listPages();
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

    const meta = document.createElement('div');
    meta.className = 'page-meta';
    meta.style.minWidth = '0';

    const title = document.createElement('div');
    title.className = 'page-title';
    title.textContent = page.title;
    meta.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'page-sub';
    sub.textContent = formatDate(page.mtime);
    meta.appendChild(sub);

    item.appendChild(meta);

    const del = document.createElement('button');
    del.className = 'page-del';
    del.title = '删除这一页';
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmDelete(page);
    });
    item.appendChild(del);

    listEl.appendChild(item);
  }
}

listEl.addEventListener('click', (e) => {
  const item = e.target.closest('.page-item');
  if (!item || item.dataset.path === currentFile) return;
  flushAndSend();
  bridge.openPage(item.dataset.path);
});

document.getElementById('new-btn').addEventListener('click', () => {
  flushAndSend();
  bridge.newPage();
});

// ---------- 保存与标题 ----------

function titleFrom(text) {
  const first = text
    .split('\n', 1)[0]
    .replace(/^#{1,6}\s*/, '')
    .replace(/<[^>]*>?/g, '') // 顶栏标题不显示行内 HTML 标签
    .trim();
  return first ? first.slice(0, 60) : '新的一页';
}

function renderTitle() {
  const text = view.state.doc.toString();
  const name = titleFrom(text);
  titleEl.textContent = name;
  titleEl.classList.toggle('named', name !== '新的一页' && text.trim() !== '');
}

function flashSaved() {
  clearTimeout(imageErrorTimer);
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  savedAt.textContent = '已保存 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  savedAt.classList.add('show');
}

function saveNow() {
  flushTableInput();
  const text = view.state.doc.toString();
  bridge.save(text, view.state.selection.main.head);
  if (text.trim()) flashSaved();
  clearTimeout(listTimer);
  listTimer = setTimeout(refreshList, 350); // 新文件落盘后侧栏补上
}

function flushAndSend() {
  clearTimeout(saveTimer);
  saveNow();
}

// ---------- 全文搜索 / 标签 ----------

const searchMask = document.getElementById('search-mask');
const searchInput = document.getElementById('search-input');
const searchListEl = document.getElementById('search-list');
const searchCountEl = document.getElementById('search-count');
const searchScopeEl = document.getElementById('search-scope');

const search = { open: false, items: [], selected: 0, query: '', timer: null, seq: 0 };

function showSearchResults() {
  search.open = true;
  searchMask.hidden = false;
}

// 只收起结果下拉，不动输入框的焦点/内容
function hideSearchResults() {
  search.open = false;
  searchMask.hidden = true;
  search.items = [];
  search.selected = 0;
  searchListEl.textContent = '';
  searchCountEl.textContent = '';
  searchScopeEl.textContent = '';
  clearTimeout(search.timer);
  ++search.seq;
}

function openSearch(initialQuery) {
  if (typeof initialQuery === 'string') searchInput.value = initialQuery;
  searchInput.focus();
  searchInput.select();
  runSearch(searchInput.value);
}

function closeSearch() {
  hideSearchResults();
  if (document.activeElement === searchInput) searchInput.blur();
}

function runSearch(query) {
  const q = String(query || '').trim();
  search.query = q;
  clearTimeout(search.timer);
  // 没输入内容就不展开下拉，避免弹出一个空框
  if (!q) {
    hideSearchResults();
    return;
  }
  searchScopeEl.textContent = q.startsWith('#') ? '标签：' + q : '';
  const seq = ++search.seq;
  search.timer = setTimeout(async () => {
    let res = null;
    try {
      res = await bridge.searchNotes(q);
    } catch {}
    if (seq !== search.seq) return; // 丢弃过期结果
    search.items = [];
    if (res && res.ok) {
      for (const page of res.results) {
        for (const hit of page.hits) {
          search.items.push({
            file: page.file,
            title: page.title,
            mtime: page.mtime,
            line: hit.line,
            text: hit.text,
            offset: hit.offset,
            term: q.split(/\s+/)[0],
          });
        }
      }
    }
    search.selected = 0;
    showSearchResults();
    renderSearchResults();
  }, 110);
}

// 命中行太长时只保留命中处前后一小段，并把关键词套上 <mark>
function renderHitText(el, text, term) {
  el.textContent = '';
  const src = String(text || '');
  const t = String(term || '');
  const at = t ? src.toLowerCase().indexOf(t.toLowerCase()) : -1;
  if (at < 0) {
    el.textContent = src.slice(0, 160);
    return;
  }
  const start = Math.max(0, at - 30);
  const end = Math.min(src.length, at + t.length + 90);
  el.appendChild(document.createTextNode((start > 0 ? '…' : '') + src.slice(start, at)));
  const mark = document.createElement('mark');
  mark.textContent = src.slice(at, at + t.length);
  el.appendChild(mark);
  el.appendChild(document.createTextNode(src.slice(at + t.length, end) + (end < src.length ? '…' : '')));
}

function renderSearchResults() {
  searchListEl.textContent = '';
  if (!search.items.length) {
    const tip = document.createElement('div');
    tip.id = 'search-empty';
    tip.textContent = '没有找到匹配的笔记';
    searchListEl.appendChild(tip);
    searchCountEl.textContent = '';
    return;
  }
  searchCountEl.textContent = search.items.length + ' 条';
  search.items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = 'sr-hit' + (i === search.selected ? ' sel' : '');
    const meta = document.createElement('div');
    meta.className = 'sr-meta';
    const title = document.createElement('span');
    title.className = 'sr-title';
    title.textContent = it.title || '(无标题)';
    meta.appendChild(title);
    const ln = document.createElement('span');
    ln.className = 'sr-line';
    ln.textContent = '第 ' + it.line + ' 行';
    meta.appendChild(ln);
    const date = document.createElement('span');
    date.className = 'sr-date';
    date.textContent = formatDate(it.mtime);
    meta.appendChild(date);
    row.appendChild(meta);
    const text = document.createElement('div');
    text.className = 'sr-text';
    renderHitText(text, it.text, it.term);
    row.appendChild(text);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      openSearchHit(i);
    });
    searchListEl.appendChild(row);
  });
  const sel = searchListEl.children[search.selected];
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}

function moveSearchSelection(dir) {
  if (!search.items.length) return;
  search.selected = (search.selected + dir + search.items.length) % search.items.length;
  const rows = searchListEl.querySelectorAll('.sr-hit');
  rows.forEach((r, i) => r.classList.toggle('sel', i === search.selected));
  const sel = rows[search.selected];
  if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
}

async function openSearchHit(i) {
  const it = search.items[i];
  if (!it) return;
  closeSearch();
  try {
    await bridge.openPageAt(it.file, it.offset); // 切页 + 光标定位到命中处
  } catch {}
}

searchInput.addEventListener('input', () => runSearch(searchInput.value));
// 顶栏搜索框是常驻的：里面已有内容时，重新聚焦就把上次的结果再展开
searchInput.addEventListener('focus', () => {
  if (searchInput.value.trim()) runSearch(searchInput.value);
});
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    moveSearchSelection(1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    moveSearchSelection(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    openSearchHit(search.selected);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closeSearch();
    view.focus();
  }
  e.stopPropagation(); // 别让编辑器/全局处理器再抢这些键
});
// 点别处收起下拉（下拉层不吃点击，编辑器/侧栏该收到的点击照常收到）
document.addEventListener(
  'mousedown',
  (e) => {
    if (!search.open) return;
    const t = e.target;
    if (t && t.closest && (t.closest('#search-panel') || t.closest('#search-box'))) return;
    hideSearchResults();
  },
  true
);

// Ctrl+K 打开搜索（全局捕获，编辑器没焦点时也能用）
document.addEventListener(
  'keydown',
  (event) => {
    if (event.isComposing || event.keyCode === 229 || hotkeyListening) return;
    if (
      event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey &&
      (event.key === 'k' || event.key === 'K')
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (search.open) {
        searchInput.focus();
        searchInput.select();
      } else {
        openSearch(searchInput.value || '');
      }
    }
  },
  true
);

// 标签：只解析**当前这一篇**的 #tag，显示在正文下方；点一下就用该标签做跨页搜索。
// 扫描规则必须与宿主（main.js / search.rs）一致：
//   # 必须在行首或空白之后（URL 锚点不算）、纯十六进制 3/4/6/8 位按颜色值排除、围栏代码块内不算。
const tagBar = document.getElementById('tag-bar');
const tagBarList = document.getElementById('tag-bar-list');

const RE_TAG_START = /[\p{L}\p{N}_]/u;
const RE_TAG_CHAR = /[\p{L}\p{N}_/-]/u;
const RE_COLOR_TAG = /^[0-9a-fA-F]+$/;

function scanTags(text) {
  const tags = [];
  const seen = new Set();
  let inFence = false;
  for (const line of String(text).split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let i = 0;
    while (i < line.length) {
      if (line[i] === '#') {
        const boundary = i === 0 || /\s/.test(line[i - 1]);
        if (boundary && i + 1 < line.length && RE_TAG_START.test(line[i + 1])) {
          let j = i + 1;
          while (j < line.length && RE_TAG_CHAR.test(line[j])) j++;
          const tag = line.slice(i + 1, j);
          const isColor = RE_COLOR_TAG.test(tag) && [3, 4, 6, 8].includes(tag.length);
          if (!isColor && !seen.has(tag)) {
            seen.add(tag);
            tags.push(tag);
          }
          i = j;
          continue;
        }
      }
      i++;
    }
  }
  return tags;
}

function renderCurrentTags() {
  const tags = scanTags(view.state.doc.toString());
  if (!tags.length) {
    if (!tagBar.hidden) {
      tagBar.hidden = true;
      tagBarList.textContent = '';
    }
    return;
  }
  tagBar.hidden = false;
  tagBarList.textContent = '';
  for (const tag of tags) {
    const chip = document.createElement('button');
    chip.className = 'tag-chip';
    chip.type = 'button';
    chip.dataset.tag = tag;
    chip.title = '搜索 #' + tag;
    chip.textContent = '#' + tag;
    chip.addEventListener('mousedown', (e) => {
      e.preventDefault();
      openSearch('#' + tag);
    });
    tagBarList.appendChild(chip);
  }
}

// ---------- 每日回顾 ----------

const reviewEl = document.getElementById('review');
const reviewLabelEl = document.getElementById('review-label');
const reviewDateEl = document.getElementById('review-date');
const reviewTextEl = document.getElementById('review-text');

const review = { note: null, shown: [] };

function hideReview() {
  if (reviewEl.hidden) return;
  reviewEl.hidden = true;
  const note = review.note;
  review.note = null;
  if (note) bridge.reviewDismiss(note.file); // 记一笔，避免很快又推同一篇
}

function showReview(note) {
  if (!note || !note.file) return;
  const prev = review.note;
  if (prev && prev.file !== note.file) bridge.reviewDismiss(prev.file);
  review.note = note;
  if (!review.shown.includes(note.file)) review.shown.push(note.file);
  reviewLabelEl.textContent = note.label || '旧笔记';
  reviewDateEl.textContent = (note.title ? note.title + ' · ' : '') + (note.date || '');
  reviewTextEl.textContent = note.excerpt || '';
  reviewEl.hidden = false;
}

document.getElementById('review-open').addEventListener('click', async () => {
  const note = review.note;
  if (!note) return;
  reviewEl.hidden = true; // 打开原页本身就说明看过，不必再记一次
  review.note = null;
  try {
    await bridge.openPage(note.file);
  } catch {}
});

document.getElementById('review-next').addEventListener('click', async () => {
  let res = null;
  try {
    res = await bridge.reviewNote(review.shown);
  } catch {}
  if (res && res.ok && res.note) showReview(res.note);
  else hideReview(); // 没有别的可回顾了
});

document.getElementById('review-close').addEventListener('click', hideReview);

if (bridge.onReview) bridge.onReview(showReview);

// ---------- 恢复页面（呼出/切换/新建） ----------

bridge.onRestore(({ text, caret, file }) => {
  cancelTableFocus();
  endTableEdit();
  clearTimeout(saveTimer);
  closeModal();
  closeSettings();
  closeSearch();
  const changedPage = currentFile !== (file || null);
  if (changedPage) {
    tableColumnWidths = new Map();
    view.dispatch({ effects: historyComp.reconfigure([]) });
  }
  if (view.state.doc.toString() !== text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }
  const pos = Math.min(Math.max(0, caret | 0), text.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
  if (changedPage) view.dispatch({ effects: historyComp.reconfigure(history()) });
  view.focus();
  currentFile = file || null;
  renderTitle();
  savedAt.classList.remove('show');
  refreshList();

  const stage = document.getElementById('stage');
  stage.classList.remove('in');
  void stage.offsetWidth;
  stage.classList.add('in');
});

// ---------- 渲染诊断（--diag 启动时运行，验证着色链路） ----------
// 样例须等窗口真实可见后再插入：真隐藏窗口里 DOM 仍会报 visible、rAF 照跑，
// 但布局为零——含组件（代码卡片/表格卡片）的测量会自旋卡死渲染进程
if (location.search.indexOf('diag') !== -1) {
  const startDiag = () => {
  setTimeout(() => {
  (async () => {
    const sample =
      '# 标题\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n\n正文 <span style="font-size:24px">外层大字<u>嵌套下划线</u>尾部</span> 结束\n<u>纯下划线</u> <mark>纯荧光</mark> **加粗叠加<mark>荧光</mark>**\n\n```cpp\n#include <iostream>\nusing namespace std;\nint main() {\n  std::cout << "hi" << x;\n}\n```\n';
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sample } });
    view.dispatch({ selection: { anchor: 0 } }); // 光标移到文档开头，所有标签应隐藏
    await new Promise((r) => setTimeout(r, 1500)); // 等嵌套语言懒加载
    let buildErr = null;
    try {
      buildMdDecos(view);
      buildTableDecos(view);
    } catch (e) {
      buildErr = e && e.message ? e.message : String(e);
    }
    const counts = {};
    for (const c of ['cm-line','cm-content','cm-fs','cm-u','cm-highlight','tok-kw','tok-kw2','tok-fn','tok-var','tok-type','tok-str','tok-mark','cm-code-line','cm-ln','cm-lang','tok-lang','cm-table-wrap']) {
      counts[c] = document.querySelectorAll('.' + c).length;
    }
    // 检查行内 HTML 标签是否仍以文本形式出现在渲染 DOM 中（应全部隐藏）
    const tagVisible = Array.from(document.querySelectorAll('.cm-line')).some(
      (l) => l.textContent.includes('<span') || l.textContent.includes('<u>') || l.textContent.includes('<mark>')
    );
    const colorOf = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).color : 'none';
    };
    const texts = {};
    for (const c of ['tok-kw2', 'tok-fn', 'tok-var', 'tok-type']) {
      texts[c] = Array.from(document.querySelectorAll('.' + c)).map((e) => e.textContent).slice(0, 6);
    }
    // 表格链路自检：卡片渲染 → 卡片内输入同步源码 → Tab 聚焦跳格 → 按钮追加行
    const tableCheck = { rendered: false, cellEditOk: false, tabOk: false, rowAppendOk: false };
    const wrapEl = document.querySelector('.cm-table-wrap');
    if (wrapEl) {
      tableCheck.rendered = true;
      // 卡片内编辑：聚焦 (0,1) 表头格 → 改文本 → 触发 input → 防抖后源码应更新
      const editEl = wrapEl.querySelector('td[data-line="0"][data-col="1"] .cm-tb-edit');
      if (editEl) {
        editEl.focus();
        editEl.textContent = '列2改';
        editEl.dispatchEvent(new InputEvent('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 500));
        const headLine = view.state.doc.lineAt(
          Math.min(tableLiveEdit ? tableLiveEdit.from : 0, view.state.doc.length - 1)
        );
        tableCheck.cellEditOk = headLine.text.includes('列2改');
      }
      // Tab：聚焦 (2,0) → Tab → 焦点应到 (2,1)
      const cellA = wrapEl.querySelector('td[data-line="2"][data-col="0"] .cm-tb-edit');
      if (cellA) {
        cellA.focus();
        cellA.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
        );
        await new Promise((r) => setTimeout(r, 60));
        const active = document.activeElement;
        const td = active && active.closest && active.closest('td[data-line]');
        tableCheck.tabOk = !!(td && td.dataset.line === '2' && td.dataset.col === '1');
      }
      await new Promise((r) => setTimeout(r, 500)); // 等防抖落盘
      // 按钮追加行：模拟点击底部「＋ 行」
      const btn = document.querySelector('.cm-tb-btn[data-op="row-append"]');
      tableCheck.btnFound = !!btn;
      if (btn) btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 150));
      const tableNode = climbTableAt(view.state, wrapEl ? Number(wrapEl.dataset.tableFrom) : 0);
      const tableBlock = tableNode && readTableBlock(view.state, tableNode);
      tableCheck.rowAppendOk = !!(tableBlock && tableBlock.rows.length === 2 && tableBlock.rows[1].every((cell) => cell === ''));
    }
    window.__diagResult = JSON.stringify({
      buildErr,
      docLength: view.state.doc.length,
      docLines: view.state.doc.lines,
      counts,
      tagVisible,
      tableCheck,
      kw2Color: colorOf('.tok-kw2'),
      fnColor: colorOf('.tok-fn'),
      varColor: colorOf('.tok-var'),
      fsColor: colorOf('.cm-fs'),
      bodyClass: document.body.className,
      texts,
    });
  })();
  }, 100);
  };
  if (tableRenderOk) startDiag();
  else {
    // 等主进程的真实可见信号（诊断会显示并激活屏幕内的独立测试窗口）
    const timer = setInterval(() => {
      if (tableRenderOk) {
        clearInterval(timer);
        startDiag();
      }
    }, 50);
    setTimeout(() => clearInterval(timer), 10000); // 兜底退出等待
  }
}
