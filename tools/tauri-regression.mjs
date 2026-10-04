// Tauri 版的键鼠/输入法回归：用 CDP 驱动 WebView2 里的真实前端。
// 用例与 tools/table-regression.js 的 Electron 版一一对应，用来验证"宿主换掉后行为不变"。
import assert from 'node:assert/strict';
import { Driver, sleep } from './tauri-driver.mjs';

const FIRST_CELL = '.cm-table-wrap td[data-line="0"][data-col="0"] .cm-tb-edit';
const PORT = Number(process.env.TAURI_CDP_PORT || 9223);

let pass = 0;
let fail = 0;
const check = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log('TAURI PASS', name);
  } catch (err) {
    fail++;
    console.log('TAURI FAIL', name, '-', (err && err.message) || err);
  }
};

const d = await Driver.connect(PORT);
await d.enableConsole();
console.log('已连接:', await d.evaluate('navigator.userAgent.slice(0,60)'));
// 等界面稳定 + 确保编辑器拿到焦点（空文档时 .cm-content 很矮，点中心可能落空）
await sleep(800);
await d.mouse('.cm-content');

const newPage = async () => {
  await d.mouse('#new-btn');
  await d.until('document.querySelectorAll(".cm-table-wrap").length === 0', '新建页后仍有表格卡片');
  await d.until('JSON.parse(window.__noteSnapshot()).t === ""', '新建页后文档不为空');
};
const slashMenu = () => d.evaluate('document.querySelector("#slash-menu").style.display');
const menuText = () => d.evaluate('document.querySelector("#slash-menu").textContent');
const tableCards = () => d.evaluate('document.querySelectorAll(".cm-table-wrap").length');

// ---------- 输入法：本项目的命门 ----------
// 组合期间 CodeMirror 会丢弃全部键盘事件（DOMObserver.ignoreDuringComposition），
// 确认意图必须由 DOM 捕获阶段旁听，并在 compositionend 之后补一次确认。
await check('/bg confirmed by IME composition commits and renders', async () => {
  // 从空白页开始：斜杠菜单只在行首/空白后触发，若光标停在上一轮遗留的文字中间就不会弹
  await newPage();
  await d.mouse('.cm-content');
  await d.type('/');
  await d.until('document.querySelector("#slash-menu").style.display === "block"', '斜杠菜单未打开', 2000);
  await d.imeSetComposition('bg');
  await d.until(
    'document.querySelector("#slash-menu").textContent === "表格3 列"',
    'IME 查询词未收窄到表格片段',
    2000
  );
  await d.key('Enter');
  await sleep(250);
  assert.equal(await tableCards(), 0, '组合态的回车不得在输入法上屏前插入');
  await d.insertText('bg');
  await d.until(`document.activeElement.matches(${JSON.stringify(FIRST_CELL)})`, 'IME 上屏未确认 /bg');
  await newPage();
});

await check('/bg confirmed by IME space commit, and Chinese commit does not insert', async () => {
  await d.mouse('.cm-content');
  await d.type('/');
  await d.imeSetComposition('ni');
  await sleep(150);
  await d.key('Space');
  await sleep(200);
  await d.insertText('你');
  await sleep(300);
  assert.equal(await tableCards(), 0, '中文候选上屏不得插入表格');
  assert.equal(await slashMenu(), 'none', '中文查询时菜单应关闭');
  await newPage();

  await d.mouse('.cm-content');
  await d.type('/');
  await d.imeSetComposition('bg');
  await sleep(150);
  await d.key('Space');
  await sleep(250);
  assert.equal(await tableCards(), 0, '组合态的空格不得在输入法上屏前插入');
  await d.insertText('bg');
  await d.until(`document.activeElement.matches(${JSON.stringify(FIRST_CELL)})`, 'IME 空格上屏未确认 /bg');
  await newPage();
});

// 真实事件顺序：compositionend 先到，其后的 keydown 是 key='Process'/kc=229/isComposing=false；
// preedit 里还会混入分音节撇号（"b'g"）。
await check('IME commit order: compositionend first, apostrophe in preedit', async () => {
  await d.mouse('.cm-content');
  await d.type('/');
  await d.imeSetComposition('b');
  await sleep(150);
  assert.equal(await slashMenu(), 'block', '组合 "b" 时菜单被关掉了');
  await d.imeSetComposition("b'g", 3, 3);
  await sleep(200);
  assert.equal(await slashMenu(), 'block', 'preedit 里的撇号错误地关掉了菜单');
  assert.equal(await menuText(), '表格3 列', 'preedit "b\'g" 未收窄到表格');
  await d.insertText('bg');
  await d.until(`JSON.parse(window.__noteSnapshot()).t.startsWith('| 列1')`, 'compositionend 未确认 /bg');
  await newPage();
});

await check('incomplete alias survives IME commit without inserting', async () => {
  await d.mouse('.cm-content');
  await d.type('/');
  await d.imeSetComposition('b');
  await sleep(150);
  await d.insertText('b');
  await sleep(500);
  assert.equal((await d.snapshot()).t, '/b', '不完整别名 /b 不得被插入');
  await newPage();
});

// ---------- 表格 ----------
await check('/bg Enter renders and focuses within one second', async () => {
  await d.mouse('.cm-content');
  await d.type('/bg');
  assert.equal(await slashMenu(), 'block', '斜杠菜单未打开');
  const start = Date.now();
  await d.key('Enter');
  await d.until(`document.activeElement.matches(${JSON.stringify(FIRST_CELL)})`, '/bg 未渲染/聚焦首格', 950);
  assert.ok(Date.now() - start < 1000, '渲染超过 1 秒');
});

await check('fast Tab preserves both edited cells', async () => {
  await d.type('one');
  await d.key('Tab');
  await d.type('two');
  await d.key('Tab');
  const text = (await d.snapshot()).t;
  assert.ok(text.includes('列1one'), text);
  assert.ok(text.includes('列2two'), text);
  await newPage();
});

// ---------- 列表 ----------
await check('nested ordered list shows 1. / a. / i.', async () => {
  await newPage();
  await d.mouse('.cm-content');
  await d.insertText('1. 甲');
  await d.key('Enter');
  await d.key('Tab');
  await d.insertText('乙');
  await d.key('Enter');
  await d.key('Tab');
  await d.insertText('丙');
  await sleep(400);
  await d.key('End', ['ctrl']); // 光标移到最后，让上面的行进入渲染态
  await sleep(400);
  const marks = await d.evaluate('JSON.stringify(Array.from(document.querySelectorAll(".cm-ol-marker")).map(e => e.textContent))');
  assert.equal(marks, '["1.","a.","i."]', '多级编号不对: ' + marks);
  await newPage();
});

await check('Tab indents the whole list item from anywhere in the line', async () => {
  await d.mouse('.cm-content');
  await d.insertText('- abc');
  await d.key('End');
  await d.key('Tab');
  await sleep(300);
  let text = (await d.snapshot()).t;
  assert.ok(/^ {2,}-\s+abc$/.test(text), 'Tab 未整项缩进: ' + JSON.stringify(text));
  await d.key('Tab', ['shift']);
  await sleep(300);
  text = (await d.snapshot()).t;
  assert.ok(/^- abc$/.test(text), 'Shift+Tab 未回退: ' + JSON.stringify(text));
  await newPage();
});

// ---------- 搜索 / 标签 ----------
await check('Ctrl+K search finds across pages and jumps to the hit', async () => {
  await d.mouse('.cm-content');
  await d.insertText('# 架构笔记\n\n今天试了下 nginx 的 proxy_pass。');
  await sleep(900); // 等自动落盘
  await d.key('k', ['ctrl']);
  await sleep(250);
  assert.equal(await d.evaluate('document.activeElement.id'), 'search-input', 'Ctrl+K 未聚焦搜索框');
  await d.evaluate(`(() => { const i = document.getElementById('search-input'); i.value = 'nginx'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
  await d.until('document.querySelectorAll(".sr-hit").length >= 1', '搜索无命中', 3000);
  await d.evaluate('document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
  await d.until('document.getElementById("search-mask").hidden === true', '回车后搜索未收起');
  await sleep(500);
  const snap = await d.snapshot();
  const line = snap.t.slice(0, snap.c).split('\n').length;
  assert.ok((snap.t.split('\n')[line - 1] || '').includes('nginx'), '光标未落在命中行: line=' + line);
});

await check('host tag scanner ignores colours, URL anchors and fences', async () => {
  await newPage();
  await d.mouse('.cm-content');
  await d.insertText('# 标签规则\n\n用了 #nginx 和 #待办；参考 https://x.com/#anchor 与颜色 #fff。\n\n```js\n// #notatag\n```\n');
  await sleep(1300); // 等自动落盘，宿主的 listTags 扫的是磁盘
  const tags = JSON.parse(
    await d.evaluate('(async () => JSON.stringify(await window.__TAURI__.core.invoke("list_tags")))()')
  ).tags.map((t) => t.tag);
  assert.ok(tags.includes('nginx') && tags.includes('待办'), 'tags: ' + JSON.stringify(tags));
  assert.ok(!tags.includes('anchor') && !tags.includes('fff') && !tags.includes('notatag'), 'false tags: ' + JSON.stringify(tags));
});

await check('tag bar under the note shows only this note tags and searches on click', async () => {
  await d.until('document.getElementById("tag-bar").hidden === false', '标签栏未出现', 3000);
  const chips = JSON.parse(
    await d.evaluate('JSON.stringify(Array.from(document.querySelectorAll("#tag-bar .tag-chip")).map(e => e.dataset.tag))')
  );
  assert.deepEqual(chips, ['nginx', '待办'], 'chips: ' + JSON.stringify(chips));
  assert.equal(
    await d.evaluate('document.querySelectorAll("#tag-box, #tag-list").length'),
    0,
    '侧栏标签栏应该已经移除'
  );

  await d.mouse('#tag-bar .tag-chip');
  await d.until('document.getElementById("search-input").value === "#nginx"', '点标签未按标签搜索', 3000);
  await d.evaluate('document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');

  // 没有标签的页 → 整条隐藏，不占地方
  await newPage();
  assert.equal(await d.evaluate('document.getElementById("tag-bar").hidden'), true, '无标签时标签栏应隐藏');
});

// ---------- 每日回顾 ----------
await check('daily review surfaces an old note and typing dismisses it', async () => {
  await d.evaluate('window.__TAURI__.core.invoke("set_setting", { key: "reviewMode", value: "always" })');
  await d.evaluate('window.__TAURI__.core.invoke("hide_window")');
  await sleep(500);
  await d.evaluate('window.__TAURI__.core.invoke("show_window")');
  await d.until('document.getElementById("review").hidden === false', '回顾横幅未出现', 4000);
  const label = await d.evaluate('document.getElementById("review-label").textContent');
  const excerpt = await d.evaluate('document.getElementById("review-text").textContent');
  assert.ok(/天前|个月前|年前/.test(label), '回顾标签异常: ' + label);
  assert.ok(excerpt.length > 0, '回顾摘要为空');
  await d.mouse('.cm-content');
  await d.type('x');
  await d.until('document.getElementById("review").hidden === true', '打字后回顾未收起', 3000);
  await d.evaluate('window.__TAURI__.core.invoke("set_setting", { key: "reviewMode", value: "daily" })');
});

// ---------- 设置面板 / 主题 ----------
await check('settings panel opens, reflects host settings and persists changes', async () => {
  await d.mouse('#settings-btn');
  await d.until('document.getElementById("settings-mask").hidden === false', '设置面板未打开', 2500);
  const notesDir = await d.evaluate('document.getElementById("set-notesdir").textContent');
  const version = await d.evaluate('document.getElementById("set-version").textContent');
  assert.ok(notesDir.length > 0, '笔记目录未回填');
  assert.ok(/v1\.\d/.test(version), '版本号未回填: ' + version);

  const before = JSON.parse(await d.evaluate('(async () => JSON.stringify(await window.bridge.getSettings()))()')).fontSize;
  await d.mouse('#set-font-plus');
  await d.until(
    `document.getElementById('set-font-size').textContent === '${before + 1}'`,
    '字号未 +1',
    2500
  );
  const after = JSON.parse(await d.evaluate('(async () => JSON.stringify(await window.bridge.getSettings()))()')).fontSize;
  assert.equal(after, before + 1, '宿主持久化字号失败');
  await d.mouse('#set-font-minus'); // 还原
  await d.mouse('#settings-close');
  await d.until('document.getElementById("settings-mask").hidden === true', '设置面板未关闭', 2500);
});

await check('theme switch reaches the renderer', async () => {
  await d.evaluate(`window.bridge.setSetting('theme', 'dark')`);
  await sleep(400);
  assert.equal(
    await d.evaluate(`document.body.classList.contains('theme-light')`),
    false,
    '切到深色后仍在浅色主题'
  );
  await d.evaluate(`window.bridge.setSetting('theme', 'light')`);
  await sleep(400);
  assert.equal(
    await d.evaluate(`document.body.classList.contains('theme-light')`),
    true,
    '切到浅色未生效'
  );
  await d.evaluate(`window.bridge.setSetting('theme', 'system')`);
  await sleep(300);
});

console.log(`TAURI ${fail ? 'FAIL ' + fail : 'OK'} (pass ${pass})`);
if (d.logs.length) {
  const errs = d.logs.filter((l) => /error|Error|failed|Uncaught/.test(l)).slice(0, 8);
  if (errs.length) console.log('渲染层错误日志:', JSON.stringify(errs, null, 1));
}
d.close();
process.exit(fail ? 1 : 0);
