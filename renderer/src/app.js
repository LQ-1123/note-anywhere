// NoteAnywhere 编辑器 —— CodeMirror 6 + Markdown 实时渲染 + 斜杠菜单 + VSCode 代码配色
import {
  EditorView,
  keymap,
  placeholder,
  ViewPlugin,
  Decoration,
  WidgetType,
} from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
  indentUnit,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';

const bridge = window.bridge;

const titleEl = document.getElementById('title');
const savedAt = document.getElementById('saved-at');
const listEl = document.getElementById('page-list');
const editorHost = document.getElementById('editor');

let currentFile = null;
let saveTimer = null;
let listTimer = null;

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

// 缩进圆点：一个 · 表示一个缩进格（2 空格），'· ' 宽度与两空格等宽保持对齐
class DotsWidget extends WidgetType {
  constructor(levels) {
    super();
    this.levels = levels;
  }
  eq(other) {
    return other.levels === this.levels;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-dot';
    s.textContent = '· '.repeat(this.levels);
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

// 光标所在行保持源码显示，其余行隐藏标记呈现效果
function buildPreviewDecos(view) {
  const st = view.state;
  const head = st.selection.main.head;
  const inline = [];
  const lineDecos = [];
  const BIG_DOC = 300000;
  if (st.doc.length > BIG_DOC) return Decoration.none;

  syntaxTree(st).iterate({
    enter: (ref) => {
      const name = ref.name;
      const from = ref.from;
      const to = ref.to;

      // 块级行装饰
      if (name === 'Blockquote') {
        for (let pos = from; pos <= to; ) {
          const line = st.doc.lineAt(pos);
          lineDecos.push(Decoration.line({ class: 'cm-quote-line' }).range(line.from));
          if (line.to >= to) break;
          pos = line.to + 1;
        }
      }

      // 代码块：VSCode 式卡片（顶/底行、边框、行号、当前行高亮）
      if (name === 'FencedCode') {
        const node = ref.node;
        const first = node.firstChild;
        const last = node.lastChild;
        const hasOpen = !!(first && first.name === 'CodeMark');
        const hasClose = !!(last && last !== first && last.name === 'CodeMark');
        const infoNode = hasOpen && first.nextSibling ? first.nextSibling : null;
        const hasLang = !!(infoNode && infoNode.name === 'CodeInfo');

        const lines = [];
        for (let pos = from; pos <= to; ) {
          const line = st.doc.lineAt(pos);
          lines.push(line);
          if (line.to >= to) break;
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
          const isFenceLine = (hasOpen && i === 0) || (hasClose && i === lines.length - 1);
          if (!isFenceLine) {
            inline.push(Decoration.widget({ widget: new LnWidget(n++), side: -1 }).range(line.from));
            // 非编辑行：前导缩进显示为圆点（每 2 空格一个 ·，保持列对齐）
            if (!lineActive) {
              const indent = (line.text.match(/^ */) || [''])[0].length;
              const levels = Math.floor(indent / 2);
              if (levels > 0) {
                inline.push(
                  Decoration.replace({ widget: new DotsWidget(levels) }).range(
                    line.from,
                    line.from + levels * 2
                  )
                );
              }
            }
          } else if (i === 0 && !hasLang) {
            // 无语言围栏：显示「纯文本」提示，说明为什么没有着色
            inline.push(Decoration.widget({ widget: new PlainWidget(), side: 1 }).range(line.from));
          }
        });
      }

      // 语言徽标（``` 后面的 js / cpp 等）
      if (name === 'CodeInfo') {
        inline.push(Decoration.mark({ class: 'cm-lang' }).range(from, to));
        return;
      }

      if (name === 'HorizontalRule') {
        const line = st.doc.lineAt(from);
        if (!(head >= line.from && head <= line.to)) {
          inline.push(Decoration.replace({ widget: new HrWidget() }).range(from, to));
        }
        return;
      }
      if (name === 'ListMark') {
        const line = st.doc.lineAt(from);
        if (!(head >= line.from && head <= line.to)) {
          inline.push(Decoration.replace({ widget: new BulletWidget() }).range(from, to));
        }
        return;
      }

      const line = st.doc.lineAt(from);
      const lineActive = head >= line.from && head <= line.to;
      const hide = () => {
        if (!lineActive) inline.push(Decoration.replace({}).range(from, to));
      };

      if (
        name === 'HeaderMark' || name === 'EmphasisMark' || name === 'StrongEmphasisMark' ||
        name === 'StrikethroughMark' || name === 'QuoteMark' || name === 'LinkMark' ||
        name === 'CodeMark'
      ) {
        hide();
        return;
      }
      if (name === 'URL') {
        const parent = ref.node.parent; // 只隐藏链接里的裸 URL，自动链接不动
        if (parent && parent.name === 'Link') hide();
        return;
      }
    },
  });

  return Decoration.set(lineDecos.concat(inline), true);
}

const livePreview = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = buildPreviewDecos(view);
    }
    update(u) {
      if (u.docChanged || u.selectionSet || u.viewportChanged) {
        this.decorations = buildPreviewDecos(u.view);
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

const slash = { open: false, anchor: -1, query: '', items: [], selected: 0 };

function closeSlash() {
  slash.open = false;
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
    row.appendChild(hint);
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applySnippet(it);
    });
    slashMenu.appendChild(row);
  });
  slashMenu.style.display = 'block';
  positionSlash();
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
  const insert = item.snip.text;
  const selEnd = insert.length;
  const sel = item.snip.sel || { anchor: selEnd, head: selEnd };
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + sel.anchor, head: from + sel.head },
    userEvent: 'input.complete',
  });
  closeSlash();
  view.focus();
}

function handleSlashKey(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const dir = event.key === 'ArrowDown' ? 1 : -1;
    slash.selected = (slash.selected + dir + slash.items.length) % slash.items.length;
    renderSlash();
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
  const q = u.state.doc.sliceString(slash.anchor + 1, head);
  if (/[\s/]/.test(q) || q.length > 20) {
    closeSlash();
    return;
  }
  slash.query = q;
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

// Tab：固定插入 2 空格（= 一个缩进格 ·），光标随之移到空格后
function tabIndent(view) {
  if (view.composing) return false;
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) {
    const changes = [];
    for (let line = state.doc.lineAt(sel.from); ; ) {
      changes.push({ from: line.from, insert: '  ' });
      if (line.to >= sel.to) break;
      line = state.doc.lineAt(line.to + 1);
    }
    view.dispatch({ changes, userEvent: 'input.indent' });
    return true;
  }
  view.dispatch({
    changes: { from: sel.from, insert: '  ' },
    selection: { anchor: sel.from + 2 },
    userEvent: 'input.indent',
  });
  return true;
}

// Shift+Tab：每行去掉最多 2 个前导空格
function tabDedent(view) {
  const { state } = view;
  const sel = state.selection.main;
  const changes = [];
  for (let line = state.doc.lineAt(sel.from); ; ) {
    const m = line.text.match(/^ {1,2}/);
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
      history(),
      EditorView.lineWrapping,
      indentUnit.of('  '), // Tab / 自动缩进用 2 空格（VSCode 习惯）
      placeholder('记下此刻的灵感…'),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      syntaxHighlighting(highlight),
      livePreview,
      keymap.of([
        { key: 'Enter', run: listContinuation },
        { key: 'Mod-b', run: wrapMark('**') },
        { key: 'Mod-i', run: wrapMark('*') },
        { key: 'Tab', run: tabIndent, shift: tabDedent },
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.domEventHandlers({
        // 粘贴代码：无围栏的裸代码自动包上带语言的围栏；带围栏但无语言的自动补标签
        paste(event) {
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
        keydown(event) {
          if (event.isComposing || event.keyCode === 229) return false;
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
          if (event.ctrlKey && !event.altKey && (event.key === 'n' || event.key === 'N')) {
            flushAndSend();
            bridge.newPage();
            return true;
          }
          if (event.ctrlKey && !event.altKey && (event.key === 's' || event.key === 'S')) {
            flushAndSend();
            return true;
          }
          return false;
        },
      }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          renderTitle();
          clearTimeout(saveTimer);
          saveTimer = setTimeout(saveNow, 600);
        }
        handleSlashUpdate(u);
      }),
    ],
  }),
  parent: editorHost,
});

// 主进程收起/退出时从这里拉取内容与光标
window.__noteSnapshot = () =>
  JSON.stringify({ t: view.state.doc.toString(), c: view.state.selection.main.head });

// 滚动 / 窗口失焦时收起斜杠菜单
view.scrollDOM.addEventListener('scroll', closeSlash, true);
window.addEventListener('blur', closeSlash);

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
  const first = text.split('\n', 1)[0].replace(/^#{1,6}\s*/, '').trim();
  return first ? first.slice(0, 60) : '新的一页';
}

function renderTitle() {
  const text = view.state.doc.toString();
  const name = titleFrom(text);
  titleEl.textContent = name;
  titleEl.classList.toggle('named', name !== '新的一页' && text.trim() !== '');
}

function flashSaved() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  savedAt.textContent = '已保存 ' + p(d.getHours()) + ':' + p(d.getMinutes());
  savedAt.classList.add('show');
}

function saveNow() {
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

// ---------- 恢复页面（呼出/切换/新建） ----------

bridge.onRestore(({ text, caret, file }) => {
  closeModal();
  if (view.state.doc.toString() !== text) {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }
  const pos = Math.min(Math.max(0, caret | 0), text.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
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
if (location.search.indexOf('diag') !== -1) {
  (async () => {
    const sample =
      '# 标题\n\n```cpp\n#include <iostream>\nusing namespace std;\nint main() {\n  std::cout << "hi" << x;\n}\n```\n\n```\nbare fence line\n```\n';
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: sample } });
    await new Promise((r) => setTimeout(r, 1500)); // 等嵌套语言懒加载
    const counts = {};
    for (const c of ['cm-line','cm-content','tok-kw','tok-kw2','tok-fn','tok-var','tok-type','tok-str','tok-mark','cm-code-line','cm-ln','cm-lang','tok-lang']) {
      counts[c] = document.querySelectorAll('.' + c).length;
    }
    const colorOf = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).color : 'none';
    };
    const texts = {};
    for (const c of ['tok-kw2', 'tok-fn', 'tok-var', 'tok-type']) {
      texts[c] = Array.from(document.querySelectorAll('.' + c)).map((e) => e.textContent).slice(0, 6);
    }
    window.__diagResult = JSON.stringify({
      docLength: view.state.doc.length,
      docLines: view.state.doc.lines,
      counts,
      kw2Color: colorOf('.tok-kw2'),
      fnColor: colorOf('.tok-fn'),
      varColor: colorOf('.tok-var'),
      bodyClass: document.body.className,
      texts,
    });
  })();
}
