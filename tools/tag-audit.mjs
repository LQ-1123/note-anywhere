// tools/tag-audit.mjs
// 诊断脚本：验证 CodeMirror 6 中 cpp / js / markdown 的实际 tag、修饰符与节点名。
// 三层验证：
//   A. 每个原始 tag 一个 class 的调试样式 -> highlightTree 打印 token 命中的最终 tag
//   B. getStyleTags 打印每个节点的完整 tag 集（含 function()/definition() 等修饰符）
//   C. 精确复刻 renderer/src/app.js 的 HighlightStyle -> 每个 token 实际拿到的 class
//      （分别测独立解析 与 markdown 嵌入真实路径）
// 运行：node tools/tag-audit.mjs   （项目根目录，Node >= 18，ESM）

import { EditorState } from '@codemirror/state';
import { HighlightStyle, ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { highlightTree, getStyleTags, tags as t } from '@lezer/highlight';
import { languages } from '@codemirror/language-data';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';

// ---------- tag 实例 -> 可读名（含常见修饰符组合） ----------

const tagNames = new Map();
for (const [name, v] of Object.entries(t)) {
  if (typeof v !== 'function') tagNames.set(v, name);
}
const MODS = ['definition', 'function', 'special', 'local', 'standard', 'changed'];
const BASES = [
  'variableName', 'propertyName', 'typeName', 'className', 'namespace',
  'labelName', 'macroName', 'name', 'atom', 'bool', 'number', 'string',
  'comment', 'keyword', 'operator', 'punctuation', 'meta',
];
for (const m of MODS) {
  if (typeof t[m] !== 'function') continue;
  for (const b of BASES) {
    try {
      const tag = t[m](t[b]);
      if (!tagNames.has(tag)) tagNames.set(tag, `${m}(${b})`);
    } catch { /* ignore */ }
  }
}
const nameOf = (tag) => tagNames.get(tag) || String(tag);

// getStyleTags 返回单个 Rule（已按 context 解析），不是数组
function dumpB(label, state) {
  console.log(`\n===== B. ${label}（getStyleTags 完整 tag 集） =====`);
  const rows = [];
  syntaxTree(state).iterate({
    enter: (ref) => {
      const text = state.doc.sliceString(ref.from, ref.to);
      if (!text || !/[A-Za-z_]/.test(text)) return; // 只看标识符类 token
      const rule = getStyleTags(ref.node);
      if (!rule) {
        rows.push(`  ${JSON.stringify(text).padEnd(20)} node=${ref.name.padEnd(22)} -> 无 tag`);
        return;
      }
      rows.push(`  ${JSON.stringify(text).padEnd(20)} node=${ref.name.padEnd(22)} -> [${rule.tags.map(nameOf).join(', ')}]`);
    },
  });
  console.log(rows.join('\n') || '  （无）');
}

const debugStyle = HighlightStyle.define(
  [...tagNames.entries()]
    .filter(([, name]) => !name.includes('('))
    .map(([tag, name]) => ({ tag, class: name }))
);

function dumpA(label, state) {
  console.log(`\n===== A. ${label}（highlightTree + 每tag一样式） =====`);
  const rows = [];
  highlightTree(syntaxTree(state), debugStyle, (from, to, cls) => {
    const text = state.doc.sliceString(from, to).replace(/\n/g, '\\n');
    rows.push(`  ${JSON.stringify(text).padEnd(24)} -> ${cls}`);
  });
  console.log(rows.join('\n') || '  （无）');
}

// ---------- C. 复刻 app.js 的 HighlightStyle（与 renderer/src/app.js 逐条一致） ----------

const appStyle = HighlightStyle.define([
  { tag: [t.processingInstruction, t.meta], class: 'tok-mark' },
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
  { tag: [t.controlKeyword, t.moduleKeyword, t.definitionKeyword], class: 'tok-kw' },
  { tag: [t.keyword, t.operatorKeyword], class: 'tok-kw2' },
  { tag: [t.string, t.special(t.string)], class: 'tok-str' },
  { tag: [t.lineComment, t.blockComment, t.comment], class: 'tok-com' },
  { tag: [t.number, t.bool, t.atom, t.null], class: 'tok-num' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-fn' },
  { tag: [t.variableName, t.propertyName], class: 'tok-var' },
  { tag: [t.typeName, t.className, t.namespace], class: 'tok-type' },
]);

function dumpC(label, state) {
  console.log(`\n===== C. ${label}（app.js 样式下的实际 class） =====`);
  const rows = [];
  highlightTree(syntaxTree(state), appStyle, (from, to, cls) => {
    const text = state.doc.sliceString(from, to).replace(/\n/g, '\\n');
    rows.push(`  ${JSON.stringify(text).padEnd(24)} -> ${cls}`);
  });
  console.log(rows.join('\n') || '  （无任何 class）');
}

// ---------- 语言加载：模拟真实运行时（language-data 懒加载路径） ----------

async function loadByAlias(...aliases) {
  const desc = languages.find((l) => l.alias && aliases.some((a) => l.alias.includes(a)));
  if (!desc) throw new Error('language not found: ' + aliases);
  console.log(`[load] name=${desc.name} alias=${desc.alias.join(',')} load=${typeof desc.load}`);
  const support = await desc.load();
  console.log(`[load] ${desc.name} 加载成功: ${support ? 'OK' : 'FAIL'}`);
  return support;
}

// ---------- 样本 ----------

const CPP_DOC = `#include <iostream>
using namespace std;
int main() {
    std::cout << "hi" << x << std::endl;
    return 0;
}`;

const JS_DOC = `const s = "a";
function f(arg) { let n = 1; return n + arg; }`;

const MD_DOC = '```cpp\n' + CPP_DOC + '\n```\n\n```javascript\n' + JS_DOC + '\n```';

// ---------- 主流程 ----------

console.log('================ C++（language-data 懒加载） ================');
const cppSupport = await loadByAlias('cpp');
const cppState = EditorState.create({ doc: CPP_DOC, extensions: [cppSupport] });
dumpA('C++ 直接解析', cppState);
dumpB('C++ 直接解析', cppState);
dumpC('C++ 直接解析', cppState);

console.log('\n================ JavaScript（language-data 懒加载） ================');
const jsSupport = await loadByAlias('js');
const jsState = EditorState.create({ doc: JS_DOC, extensions: [jsSupport] });
dumpA('JS 直接解析', jsState);
dumpB('JS 直接解析', jsState);
dumpC('JS 直接解析', jsState);

// --- Markdown + codeLanguages（复刻 app.js 的真实编辑器路径） ---
console.log('\n================ Markdown 嵌入（app.js 真实路径复现） ================');
// 注意：cpp/js 已在上面 load 过，LanguageDescription 会复用已加载的 support，
// 与真实运行时（编辑器内懒加载后缓存）行为一致。
let mdState = EditorState.create({
  doc: MD_DOC,
  extensions: [markdown({ base: markdownLanguage, codeLanguages: languages })],
});

// 嵌套语言是异步挂载的：轮询 ensureSyntaxTree 直到 main/f 被嵌套解析命中
let mounted = false;
for (let i = 1; i <= 40; i++) {
  ensureSyntaxTree(mdState, mdState.doc.length, 5000);
  let found = 0;
  highlightTree(syntaxTree(mdState), appStyle, (from, to, cls) => {
    const tok = mdState.doc.sliceString(from, to);
    if ((tok === 'main' || tok === 'f') && cls) found++;
  });
  if (found >= 2) { mounted = true; console.log(`[嵌套挂载] 第 ${i} 轮轮询后 cpp+js 均已嵌套解析`); break; }
  await new Promise((r) => setTimeout(r, 50));
}
if (!mounted) console.log('[嵌套挂载] 超时：嵌套语言未在 2s 内解析');

dumpA('Markdown 嵌入（代码块内部）', mdState);
dumpB('Markdown 嵌入（代码块内部）', mdState);
dumpC('Markdown 嵌入（代码块内部）', mdState);

// ---------- Markdown 围栏代码节点名 ----------
console.log('\n===== Markdown 围栏代码块语法树节点 =====');
const mdSimple = EditorState.create({
  doc: '```cpp\ncode here\n```',
  extensions: [markdown({ base: markdownLanguage })],
});
const rows = [];
syntaxTree(mdSimple).iterate({
  enter: (ref) => {
    const text = mdSimple.doc.sliceString(ref.from, ref.to).replace(/\n/g, '\\n');
    rows.push(`  name=${ref.name.padEnd(16)} ${JSON.stringify(text)}`);
  },
});
console.log(rows.join('\n'));
