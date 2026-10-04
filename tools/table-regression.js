// 使用独立笔记目录，通过 Chromium 键鼠输入验证真实编辑路径；不直接改编辑器状态。
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

require('./smoke-bootstrap');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let win;
let originalClipboard = '';
const read = (code) => win.webContents.executeJavaScript(code);
const snapshot = async () => JSON.parse(await read('window.__noteSnapshot()'));
const first = '.cm-table-wrap td[data-line="0"][data-col="0"] .cm-tb-edit';

async function until(code, message, timeout = 2500) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await read(code)) return;
    await delay(40);
  }
  throw new Error(message);
}

async function mouse(selector, type = 'click') {
  const point = await read(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  assert.ok(point, 'Missing element: ' + selector);
  win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  if (type === 'click') {
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  }
  await delay(40);
}

async function key(keyCode, modifiers = []) {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await delay(25);
}

async function paste(text) {
  require('electron').clipboard.writeText(text);
  await key('v', ['control']);
}

async function type(text) {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    await delay(35);
  }
}

// 输入法上屏：insertText 结束当前组合并触发 compositionend
const debuggerInsert = (text) => win.webContents.debugger.sendCommand('Input.insertText', { text });

async function check(name, fn) {
  await fn();
  console.log('TABLE PASS', name);
}

const watchdog = setTimeout(() => { console.error('TABLE FAIL renderer timeout'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  win = BrowserWindow.getAllWindows()[0];
  originalClipboard = require('electron').clipboard.readText() || '';
  try {
    if (win.webContents.isLoading()) await new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
    win.center();
    win.show();
    win.focus();
    await delay(900);
    // 中文输入法组合态：/bg 的那次回车被输入法用于上屏，而 CodeMirror 会丢弃组合期间的
    // 全部键盘事件（DOMObserver.ignoreDuringComposition），keydown/keymap 都收不到。
    // 确认意图必须由 DOM 捕获阶段旁听，并在 compositionend 之后补一次确认。
    await check('/bg confirmed by IME composition commits and renders', async () => {
      await mouse('.cm-content');
      await type('/');
      win.webContents.debugger.attach('1.3');
      try {
        await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
          text: 'bg', selectionStart: 2, selectionEnd: 2,
        });
        assert.equal(
          await read('document.querySelector("#slash-menu").textContent'),
          '表格3 列',
          'IME query did not narrow to the table snippet'
        );
        await key('Enter');
        await delay(250);
        assert.equal(
          await read('document.querySelectorAll(".cm-table-wrap").length'),
          0,
          'composing Enter must not insert before the IME commits'
        );
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'bg' });
      } finally {
        win.webContents.debugger.detach();
      }
      await until(
        `document.activeElement.matches(${JSON.stringify(first)})`,
        'IME commit did not confirm /bg; snapshot=' + JSON.stringify(await snapshot())
      );
      // 复原成空页，后续用例从空白文档开始
      await mouse('#new-btn');
      await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'new page after IME case');
    });
    // 中文输入法下更常用的上屏键是空格；空格也必须能确认，且上屏中文时不能误插
    await check('/bg confirmed by IME space commit, and Chinese commit does not insert', async () => {
      await mouse('.cm-content');
      await type('/');
      win.webContents.debugger.attach('1.3');
      try {
        // 先验证：空格上屏中文候选时菜单应关闭、不插表格
        await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
          text: 'ni', selectionStart: 2, selectionEnd: 2,
        });
        await delay(150);
        await key('Space');
        await delay(200);
        await debuggerInsert('你');
        await delay(300);
        assert.equal(
          await read('document.querySelectorAll(".cm-table-wrap").length'),
          0,
          'Chinese candidate commit must not insert a table'
        );
        assert.equal(await read('document.querySelector("#slash-menu").style.display'), 'none', 'menu should close on Chinese query');
        // 回到空文档，验证：空格上屏 ASCII 查询词应确认表格
        await mouse('#new-btn');
        await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'new page before IME space case');
        await mouse('.cm-content');
        await type('/');
        await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
          text: 'bg', selectionStart: 2, selectionEnd: 2,
        });
        await delay(150);
        await key('Space');
        await delay(250);
        assert.equal(
          await read('document.querySelectorAll(".cm-table-wrap").length'),
          0,
          'composing Space must not insert before the IME commits'
        );
        await debuggerInsert('bg');
      } finally {
        win.webContents.debugger.detach();
      }
      await until(
        `document.activeElement.matches(${JSON.stringify(first)})`,
        'IME space commit did not confirm /bg; snapshot=' + JSON.stringify(await snapshot())
      );
      await mouse('#new-btn');
      await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'new page after IME space case');
    });
    // 真实中文输入法的事件顺序（实测自 Windows 微软拼音 + WebView2 事件日志）：
    //   compositionend 先到，紧随其后的那次 keydown 是 key='Process'、keyCode=229、isComposing=false，
    //   无法辨认是回车还是空格；并且 preedit 里会混入分音节撇号（"b'g"）。
    // 所以确认不能只认 keydown『回车』，必须在 compositionend 时按「整词命中英文别名」判定。
    await check('IME commit order: compositionend first, apostrophe in preedit', async () => {
      await mouse('.cm-content');
      await type('/');
      win.webContents.debugger.attach('1.3');
      try {
        await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
          text: 'b', selectionStart: 1, selectionEnd: 1,
        });
        await delay(150);
        assert.equal(
          await read('document.querySelector("#slash-menu").style.display'), 'block',
          'menu closed while composing "b"'
        );
        await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
          text: "b'g", selectionStart: 3, selectionEnd: 3,
        });
        await delay(200);
        assert.equal(
          await read('document.querySelector("#slash-menu").style.display'), 'block',
          'apostrophe in preedit wrongly closed the menu'
        );
        assert.equal(
          await read('document.querySelector("#slash-menu").textContent'), '表格3 列',
          'preedit "b\'g" did not narrow to the table'
        );
        // 直接上屏（触发 compositionend），中间没有任何「回车」
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'bg' });
      } finally {
        win.webContents.debugger.detach();
      }
      await until(
        `JSON.parse(window.__noteSnapshot()).t.startsWith('| 列1')`,
        'compositionend did not confirm /bg; snapshot=' + JSON.stringify(await snapshot())
      );
      await mouse('#new-btn');
      await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'new page after IME order case');
    });
    // 不完整的别名（/b）不得被误插
    await check('incomplete alias survives IME commit without inserting', async () => {
      await mouse('.cm-content');
      await type('/');
      win.webContents.debugger.attach('1.3');
      try {
        await win.webContents.debugger.sendCommand('Input.imeSetComposition', {
          text: 'b', selectionStart: 1, selectionEnd: 1,
        });
        await delay(150);
        await win.webContents.debugger.sendCommand('Input.insertText', { text: 'b' });
      } finally {
        win.webContents.debugger.detach();
      }
      await delay(500);
      const text = (await snapshot()).t;
      assert.equal(text, '/b', 'incomplete alias /b must not insert; got ' + JSON.stringify(text));
      await mouse('#new-btn');
      await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'new page after incomplete alias case');
    });
    await check('/bg Enter renders and focuses within one second', async () => {
      await mouse('.cm-content');
      await type('/bg');
      assert.equal(await read('document.querySelector("#slash-menu").style.display'), 'block', 'slash menu did not open');
      const start = Date.now();
      await key('Enter');
      await until(`document.activeElement.matches(${JSON.stringify(first)})`,
        '/bg did not render/focus first cell; snapshot=' + JSON.stringify(await snapshot()), 950);
      assert.ok(Date.now() - start < 1000);
    });
    await check('fast Tab preserves both edited cells', async () => {
      await type('one');
      await key('Tab');
      await type('two');
      await key('Tab');
      const text = (await snapshot()).t;
      assert.ok(text.includes('列1one'), text);
      assert.ok(text.includes('列2two'), text);
    });
    await check('Enter adds a row and keeps the same column focused', async () => {
      await mouse('.cm-table-wrap td[data-line="2"][data-col="1"] .cm-tb-edit');
      await key('Enter');
      await until('document.activeElement.closest("td")?.dataset.line === "3" && document.activeElement.closest("td")?.dataset.col === "1"', 'Enter row focus');
      assert.equal(await read('document.querySelectorAll(".cm-table tbody tr").length'), 2);
    });
    await check('row/column buttons modify the table and Ctrl+Z restores focus', async () => {
      await mouse('.cm-table-wrap');
      await mouse('.cm-tb-btn[data-op="col-append"]');
      await until('document.querySelectorAll(".cm-table thead td[data-line]").length === 4', 'append column');
      await until('document.activeElement.matches(".cm-tb-edit")', 'new column focus');
      await key('z', ['control']);
      await until('document.querySelectorAll(".cm-table thead td[data-line]").length === 3', 'undo column');
      assert.ok(await read('document.activeElement.matches(".cm-tb-edit")'), 'undo lost cell focus');
    });
    await check('Chinese text saves immediately when hiding, and returns rendered', async () => {
      await paste('中文输入');
      // 主进程真正收起时拉取 snapshot，不能丢掉 350ms 防抖内的输入。
      await read('window.bridge.hide()');
      for (let i = 0; i < 30 && win.isVisible(); i++) await delay(40);
      assert.equal(win.isVisible(), false);
      const state = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'state.json'), 'utf8'));
      assert.ok(fs.readFileSync(state.file, 'utf8').includes('中文输入'));
      win.show(); win.focus();
      await until('window.__tableRenderOk === true && document.querySelectorAll(".cm-table-wrap").length === 1', 'show did not restore card');
    });
    await check('long IME composition keeps candidates out of Markdown until commit', async () => {
      await mouse(first);
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('Input.imeSetComposition', { text: 'zhongwen', selectionStart: 8, selectionEnd: 8 });
      await delay(800);
      const state = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'state.json'), 'utf8'));
      assert.ok(!fs.readFileSync(state.file, 'utf8').includes('zhongwen'), 'uncommitted IME saved');
      await win.webContents.debugger.sendCommand('Input.insertText', { text: '长组合中文' });
      win.webContents.debugger.detach();
      await key('Tab');
      assert.ok((await snapshot()).t.includes('长组合中文'));
    });
    await check('hover row add/delete buttons and single-step undo', async () => {
      const before = await read('document.querySelectorAll(".cm-table tbody tr").length');
      await mouse('.cm-table tbody tr:first-child');
      await mouse('.cm-tb-btn[data-op="row-add"][data-arg="0"]');
      await until(`document.querySelectorAll('.cm-table tbody tr').length === ${before + 1}`, 'hover add row');
      await mouse('.cm-table tbody tr:first-child');
      await mouse('.cm-tb-btn[data-op="row-del"][data-arg="0"]');
      await until(`document.querySelectorAll('.cm-table tbody tr').length === ${before}`, 'hover delete row');
      await until('document.activeElement.matches(".cm-tb-edit")', 'delete row focus');
      await key('z', ['control']);
      await until(`document.querySelectorAll('.cm-table tbody tr').length === ${before + 1}`, 'undo delete row');
    });
    await check('switching pages preserves table and isolates undo history', async () => {
      await mouse('#new-btn');
      await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'new page');
      await type('second page');
      await delay(1100);
      const tablePage = await read('Array.from(document.querySelectorAll(".page-item")).find(el => el.textContent.includes("列1"))?.dataset.path');
      assert.ok(tablePage, 'table page missing');
      const selector = '.page-item[data-path=' + JSON.stringify(tablePage) + ']';
      await mouse(selector);
      await until('document.querySelectorAll(".cm-table-wrap").length === 1', 'table page did not render');
      assert.ok((await snapshot()).t.includes('中文输入'));
      await key('z', ['control']);
      assert.ok(!(await snapshot()).t.includes('second page'), 'undo leaked another page');
    });
    await check('GFM alignment and resizing handles', async () => {
      await mouse('#new-btn');
      await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'new page');
      await paste('| 左 | 中 | 右 |\n| :--- | :---: | ---: |\n| 甲 | 乙 | 丙 |\n\n');
      await until('document.querySelectorAll(".cm-table-wrap").length === 1', 'aligned table not rendered');
      const aligns = await read('Array.from(document.querySelectorAll(".cm-table tbody td[data-line]")).map(el => getComputedStyle(el).textAlign)');
      assert.deepEqual(aligns, ['left', 'center', 'right']);
      assert.equal(await read('document.querySelectorAll(".cm-tb-resize").length'), 3);
      const point = await read('(() => { const r = document.querySelector(".cm-tb-resize").getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()');
      const before = await read('document.querySelector(".cm-table col:nth-child(2)").style.width');
      win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
      win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x + 70, y: point.y });
      win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x + 70, y: point.y });
      await delay(80);
      assert.ok(parseFloat(await read('document.querySelector(".cm-table col:nth-child(2)").style.width')) > parseFloat(before) + 50);
    });
    await check('editing buttons affect the chosen table on a page with two tables', async () => {
      await key('End', ['control']);
      await paste('| 第二表 | B |\n| --- | --- |\n| x | y |\n\n');
      await until('document.querySelectorAll(".cm-table-wrap").length === 2', 'second table');
      await mouse('.cm-table-wrap:nth-of-type(1)');
      const tables = await read('Array.from(document.querySelectorAll(".cm-table-wrap")).map(el => el.dataset.tableFrom)');
      const second = '.cm-table-wrap[data-table-from="' + tables[1] + '"]';
      await mouse(second);
      await mouse(second + ' .cm-tb-btn[data-op="col-append"]');
      await until('Array.from(document.querySelectorAll(".cm-table thead")).map(el => el.querySelectorAll("td[data-line]").length).join() === "3,3"', 'second table column button targeted first table');
    });
    await check('visible fallback renders with requestAnimationFrame suppressed', async () => {
      await read('window.bridge.hide()');
      for (let i = 0; i < 30 && win.isVisible(); i++) await delay(40);
      // 下一次显示前仅停止帧调度，所有插入仍通过键鼠。
      await read('window.__savedRaf = window.requestAnimationFrame; window.requestAnimationFrame = () => 999999; void 0;');
      win.show(); win.focus();
      await mouse('#new-btn');
      await type('/bg');
      const start = Date.now();
      await key('Enter');
      await until(`document.activeElement.matches(${JSON.stringify(first)})`, 'timer fallback failed to focus', 950);
      assert.ok(Date.now() - start < 1000);
      assert.equal(await read('window.__tableRenderState.reason'), 'timeout');
      await read('window.requestAnimationFrame = window.__savedRaf; void 0;');
    });
    await check('reload restores a saved page through the main process', async () => {
      const text = (await snapshot()).t;
      await read('window.bridge.hide()');
      for (let i = 0; i < 30 && win.isVisible(); i++) await delay(40);
      const state = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'state.json'), 'utf8'));
      const loaded = new Promise((resolve) => win.webContents.once('did-finish-load', resolve));
      win.reload(); await loaded;
      assert.equal(await read('window.__tableRenderOk'), false);
      win.show(); win.focus();
      win.webContents.send('restore', { text: fs.readFileSync(state.file, 'utf8'), caret: state.caret, file: state.file });
      await until('document.querySelectorAll(".cm-table-wrap").length === 1', 'reload table restore');
      assert.equal((await snapshot()).t, text);
    });
    await check('Space/Tab confirm menus, arrows select, and Esc exits a cell', async () => {
      await key('Escape');
      assert.ok(await read('document.activeElement.matches(".cm-content")'));
      await mouse('#new-btn');
      await type('/bg'); await key('Space');
      await until(`document.activeElement.matches(${JSON.stringify(first)})`, 'Space did not confirm table');
      await mouse('#new-btn');
      await type('/bg'); await key('Enter');
      await mouse('#settings-btn');
      await delay(1100);
      assert.equal(await read('!!document.activeElement.closest(".cm-tb-edit")'), false, 'focus retry stole focus from settings');
      await key('Escape');
      await key('Tab'); await key('Tab', ['shift']);
      assert.ok(await read(`document.activeElement.matches(${JSON.stringify(first)})`));
      await mouse('#new-btn');
      await type('/bg'); await key('Tab');
      await until(`document.activeElement.matches(${JSON.stringify(first)})`, 'Tab did not confirm table');
      await mouse('#new-btn');
      await type('/'); await key('Down'); await key('Up'); await key('Enter');
      await until(`document.activeElement.matches(${JSON.stringify(first)})`, 'arrow selection did not confirm table');
    });
    await check('last column deletes the table and Ctrl+Z restores it', async () => {
      for (const count of [3, 2]) {
        await mouse('.cm-table thead td[data-col="0"]');
        await mouse('.cm-tb-btn[data-op="col-del"][data-arg="0"]');
        await until(`document.querySelectorAll('.cm-table thead td[data-line]').length === ${count - 1}`, 'column delete');
      }
      await mouse('.cm-table thead td[data-col="0"]');
      await mouse('.cm-tb-btn[data-op="col-del"][data-arg="0"]');
      await until('document.querySelectorAll(".cm-table-wrap").length === 0', 'last column did not delete table');
      await key('z', ['control']);
      await until('document.querySelectorAll(".cm-table thead td[data-line]").length === 1', 'undo entire table deletion');
    });
    await check('wide table scrolls horizontally within the editor', async () => {
      await mouse('#new-btn');
      await paste('| 一 | 二 | 三 | 四 | 五 | 六 | 七 | 八 | 九 | 十 |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |\n\n');
      await until('document.querySelectorAll(".cm-table thead td[data-line]").length === 10', 'wide table');
      const scroll = await read('(() => { const el = document.querySelector(".cm-table-wrap"); const host = document.querySelector(".cm-content"); el.scrollLeft = 200; return {width: el.clientWidth, host: host.clientWidth, overflow: el.scrollWidth > el.clientWidth, moved: el.scrollLeft > 0}; })()');
      assert.ok(scroll.overflow && scroll.moved && scroll.width <= scroll.host, JSON.stringify(scroll));
    });
    // ---------- 列表：多级编号渲染 + Tab 整项缩进（与表格共用同一套编辑器行为）----------
    await check('nested ordered list shows 1. / a. / b. / i. and bullets stay bullets', async () => {
      await mouse('#new-btn');
      await paste([
        '1. 一级一',
        '   1. 二级一',
        '   1. 二级二',
        '      1. 三级一',
        '2. 一级二',
        '',
        '- 无序一',
        '   - 无序二',
        '',
        '结尾行',
      ].join('\n'));
      await delay(600);
      await key('End', ['control']);
      await delay(350);
      const marks = await read('Array.from(document.querySelectorAll(".cm-ol-marker")).map(e => e.textContent)');
      assert.deepEqual(marks, ['1.', 'a.', 'b.', 'i.', '2.'], 'nested numbering: ' + JSON.stringify(marks));
      // 光标停在某个列表行上时，该行也要显示层级记号，不能退回源码数字
      // （源码里第二层写的是 1.，显示层是 a.；只按「整行是否在编辑态」判断会退回 1.）
      await key('Home', ['control']);
      await key('Down');
      await delay(300);
      const onLine = await read('Array.from(document.querySelectorAll(".cm-ol-marker")).map(e => e.textContent)');
      assert.ok(onLine.includes('a.'), 'caret on a nested line hid its level marker: ' + JSON.stringify(onLine));
      assert.equal(await read('document.querySelectorAll(".cm-bullet").length'), 2, 'bullets replaced by numbers');
      assert.equal(await read('document.querySelectorAll(".cm-dot").length'), 0, 'indent dots drawn on list lines');
    });
    await check('Tab indents the whole list item from anywhere in the line', async () => {
      await mouse('#new-btn');
      await type('- abc');
      await key('End'); // 光标停在文字末尾，而不是记号前面
      await key('Tab');
      await delay(300);
      let text = (await snapshot()).t;
      assert.ok(/^ {2,}-\s+abc$/.test(text), 'Tab did not indent the item: ' + JSON.stringify(text));
      await key('Tab', ['shift']);
      await delay(300);
      text = (await snapshot()).t;
      assert.ok(/^- abc$/.test(text), 'Shift+Tab did not dedent: ' + JSON.stringify(text));
    });
    await check('ordered list keeps numbering on Enter', async () => {
      await mouse('#new-btn');
      await type('1. abc');
      await key('End');
      await key('Enter');
      await delay(300);
      const text = (await snapshot()).t;
      assert.ok(/^1\. abc\n2\. $/.test(text), 'Enter did not continue numbering: ' + JSON.stringify(text));
    });
    // ---------- 全文搜索 / #标签 ----------
    await check('sidebar tags ignore colours, URL anchors and code fences', async () => {
      const notesDir = path.join(app.getPath('userData'), 'notes');
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(path.join(notesDir, '2026-10-01_10-00-00.md'), [
        '# 架构笔记',
        '',
        '今天试了下 #nginx 的 proxy_pass，发现超时问题。',
        '参考 https://example.com/page#anchor 和颜色 #fff',
        '# 这是标题不是标签',
        '',
        '```js',
        '// #notatag 在代码块里',
        '```',
        '',
        '#待办 明天确认 upstream 超时',
      ].join('\n'), 'utf8');
      fs.writeFileSync(path.join(notesDir, '2026-10-02_11-00-00.md'), [
        '# 读书笔记',
        '',
        '#读书笔记 今天读了关于 #nginx 的一章，讲负载均衡。',
      ].join('\n'), 'utf8');

      // 标签扫描有 3 秒节流，先越过窗口再触发一次侧栏刷新
      await delay(3200);
      await read('window.bridge.newPage()');
      await until('document.querySelectorAll(".tag-item").length > 0', 'tags did not appear in the sidebar', 4000);
      const tags = await read('Array.from(document.querySelectorAll(".tag-item .tag-name")).map(e => e.textContent)');
      assert.ok(tags.includes('nginx') && tags.includes('待办') && tags.includes('读书笔记'), 'tags: ' + JSON.stringify(tags));
      assert.ok(
        !tags.includes('anchor') && !tags.includes('fff') && !tags.includes('notatag') && !tags.some((t) => t.includes('这是标题')),
        'false tags collected: ' + JSON.stringify(tags)
      );
    });
    await check('top bar hosts a persistent search box that does not swallow clicks', async () => {
      const info = await read('(() => { const b = document.getElementById("search-box"); const bar = document.getElementById("bar"); const r = b.getBoundingClientRect(); return { inBar: bar.contains(b), width: Math.round(r.width), rightAligned: Math.abs(bar.getBoundingClientRect().right - r.right) < 24 }; })()');
      assert.ok(info.inBar && info.width > 40 && info.rightAligned, 'search box not in top-right of the bar: ' + JSON.stringify(info));
      await read('document.getElementById("search-input").focus()');
      assert.equal(
        await read('document.getElementById("search-mask").hidden'),
        true,
        'an empty query must not open the dropdown'
      );
      await read('(() => { const i = document.getElementById("search-input"); i.value = "nginx"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
      await until('document.getElementById("search-mask").hidden === false', 'dropdown did not open after typing');
      await mouse('.cm-content');
      await delay(350);
      assert.equal(await read('document.getElementById("search-mask").hidden'), true, 'clicking the editor did not close the dropdown');
      assert.ok(
        String(await read('document.activeElement.className')).includes('cm-content'),
        'the dropdown swallowed the click instead of passing it to the editor'
      );
    });
    await check('Ctrl+K search finds across pages and jumps to the hit', async () => {
      await key('K', ['control']);
      await delay(220);
      assert.equal(await read('document.activeElement.id'), 'search-input', 'Ctrl+K did not focus the search box');
      await read('(() => { const i = document.getElementById("search-input"); i.value = "nginx"; i.dispatchEvent(new Event("input", { bubbles: true })); return 1; })()');
      await until('document.querySelectorAll(".sr-hit").length >= 2', 'search returned no hits');
      assert.ok(await read('document.querySelectorAll(".sr-hit mark").length >= 2'), 'matches not highlighted');
      const titles = await read('Array.from(document.querySelectorAll(".sr-hit .sr-title")).map(e => e.textContent)');
      assert.ok(titles.includes('架构笔记') && titles.includes('读书笔记'), 'cross-page titles: ' + JSON.stringify(titles));

      await read('document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
      await delay(150);
      await read('document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))');
      await until('document.getElementById("search-mask").hidden === true', 'search panel did not close after Enter');
      await delay(500);
      const snap = await snapshot();
      const line = snap.t.slice(0, snap.c).split('\n').length;
      assert.ok(
        (snap.t.split('\n')[line - 1] || '').toLowerCase().includes('nginx'),
        'caret not on the matched line: caret=' + snap.c + ' line=' + line + ' head=' + JSON.stringify(snap.t.slice(0, 40))
      );
    });
    await check('clicking a sidebar tag searches for that tag', async () => {
      await read('(() => { const el = Array.from(document.querySelectorAll(".tag-item")).find(e => e.dataset.tag === "待办"); el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); return 1; })()');
      await until('document.querySelectorAll(".sr-hit").length === 1', 'tag search returned unexpected hit count');
      assert.equal(await read('document.getElementById("search-input").value'), '#待办');
      assert.ok((await read('document.querySelector(".sr-hit .sr-text").textContent')).includes('#待办'), 'tag hit text wrong');
      await read('document.getElementById("search-input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      await until('document.getElementById("search-mask").hidden === true', 'Esc did not close search');
    });
    // ---------- 每日回顾 ----------
    await check('daily review surfaces an old note, falls back a tier, and typing dismisses it', async () => {
      const notesDir = path.join(app.getPath('userData'), 'notes');
      const pad = (n) => String(n).padStart(2, '0');
      const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const y1 = new Date();
      y1.setFullYear(y1.getFullYear() - 1); // 一年前的今天 → 第一档
      const y2 = new Date();
      y2.setDate(y2.getDate() - 40); // 40 天前 → 兜底档
      const today = new Date();
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(path.join(notesDir, `${ymd(y1)}_09-00-00.md`), '# 并发写的风险\n\n我觉得这个方案的风险在于**并发写**。', 'utf8');
      fs.writeFileSync(path.join(notesDir, `${ymd(y2)}_09-00-00.md`), '# 另一次记录\n\n今天试了下别的。', 'utf8');
      fs.writeFileSync(path.join(notesDir, `${ymd(today)}_08-00-00.md`), '# 刚刚写的\n\n不该被回顾。', 'utf8');

      // 收起再呼出 → 主进程按设置推一条回顾
      await read('window.bridge.hide()');
      for (let i = 0; i < 40 && win.isVisible(); i++) await delay(40);
      win.show();
      win.focus();
      await until('document.getElementById("review").hidden === false', 'review banner did not appear', 4000);
      assert.equal(await read('document.getElementById("review-label").textContent'), '1 年前的今天', 'wrong tier picked');
      assert.ok((await read('document.getElementById("review-text").textContent')).includes('并发写'), 'wrong review note body');
      assert.ok((await read('document.getElementById("review-date").textContent')).includes(ymd(y1)), 'review source date missing');
      assert.ok(!(await read('document.getElementById("review-text").textContent')).includes('**'), 'review excerpt kept markdown marks');

      // 换一条：第一档被 exclude 后必须落到下一档，而不是直接收起
      await mouse('#review-next');
      await until('document.getElementById("review-text").textContent.includes("别的")', 'next review did not fall back to a lower tier', 4000);
      assert.equal(await read('document.getElementById("review").hidden'), false, 'banner closed after 换一条');

      // 开始打字 → 自动收起
      await mouse('.cm-content');
      await type('a');
      await until('document.getElementById("review").hidden === true', 'typing did not dismiss the review', 3000);

      // 今天写的笔记永远不进回顾池
      const picked = await read('(async () => { const r = await window.bridge.reviewNote([]); return r.note ? r.note.file : ""; })()');
      assert.ok(!String(picked).includes(ymd(today)), 'today note was picked for review: ' + picked);
    });
    // ---------- 数据安全：空编辑器绝不能删掉「没载入过」的笔记 ----------
    // 真实事故：应用开机自启常驻托盘，退出时 before-quit 会 flushEditor()，
    // 此时若书写卡这次没被呼出过，编辑器就是空的、而 state.json 仍指向上一篇笔记，
    // 于是那篇笔记被 unlinkSync 永久删除（不进回收站）。
    await check('an empty editor never deletes a note that was never loaded', async () => {
      const notesDir = path.join(app.getPath('userData'), 'notes');
      const statePath = path.join(app.getPath('userData'), 'state.json');
      const victim = path.join(notesDir, '2026-09-09_09-09-09.md');
      fs.mkdirSync(notesDir, { recursive: true });
      fs.writeFileSync(victim, '# 不该被删的笔记\n\n这篇有内容。', 'utf8');

      // 复刻事故现场：state.json 指向它，但渲染层从未载入过它（编辑器为空）
      const st = JSON.parse(fs.readFileSync(statePath, 'utf8') || '{}');
      fs.writeFileSync(statePath, JSON.stringify({ ...st, file: victim, caret: 0 }), 'utf8');
      await read('window.bridge.save("", 0)');
      await delay(500);
      assert.ok(fs.existsSync(victim), 'a note that was never loaded got deleted by an empty save');

      // 反过来：确实载入过、又清空了的页，仍应被回收（原有行为不能丢）
      await read(`window.bridge.openPage(${JSON.stringify(victim)})`);
      await delay(700);
      await read('window.bridge.save("", 0)');
      await delay(900);
      assert.ok(!fs.existsSync(victim), 'a loaded-then-emptied note should still be cleaned up');
    });
    console.log('TABLE-OK');
    try { if (originalClipboard) require('electron').clipboard.writeText(originalClipboard); else require('electron').clipboard.clear(); } catch {}
    clearTimeout(watchdog);
    app.exit(0);
  } catch (error) {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    console.error('TABLE FAIL', error.stack);
    console.error('TABLE STATE', await snapshot().catch(() => null));
    try { if (originalClipboard) require('electron').clipboard.writeText(originalClipboard); else require('electron').clipboard.clear(); } catch {}
    clearTimeout(watchdog);
    app.exit(1);
  }
});
