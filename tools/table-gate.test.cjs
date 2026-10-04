const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// 在受控浏览器时钟下执行实际门控，覆盖无帧、隐藏与快速呼出的竞态。
const source = fs.readFileSync(path.join(__dirname, '../renderer/src/app.js'), 'utf8');
const gateSource = source.slice(source.indexOf('let tableRenderOk = false;'), source.indexOf('function buildTableDecos'));
function gate() {
  let time = 0, id = 0, visibility;
  const timers = new Map(), frames = new Map();
  const context = vm.createContext({
    window: {}, console: { debug() {} },
    view: { state: { selection: {} }, dispatch() {} },
    bridge: { onVisibility(cb) { visibility = cb; } },
    hideReview() {}, // 可视性处理器顺带收起每日回顾，门控测试不关心它
    setTimeout(fn, ms) { const key = ++id; timers.set(key, { at: time + ms, fn }); return key; },
    clearTimeout(key) { timers.delete(key); },
    requestAnimationFrame(fn) { const key = ++id; frames.set(key, fn); return key; },
    cancelAnimationFrame(key) { frames.delete(key); },
  });
  vm.runInContext(gateSource, context);
  return {
    visible(value) { visibility(value); },
    ready() { return vm.runInContext('tableRenderOk', context); },
    frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn(time)); },
    advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at; timers.delete(next[0]); next[1].fn();
      }
      time = end;
    },
  };
}

test('visible window renders within one second even when no animation frame arrives', () => {
  const g = gate();
  g.visible(true); g.advance(650);
  assert.equal(g.ready(), true);
});
test('hiding during compositor settling cancels pending render permission', () => {
  const g = gate();
  g.visible(true); g.frame(); g.frame(); g.advance(50);
  g.visible(false); g.advance(1000);
  assert.equal(g.ready(), false);
});
test('stale show callbacks cannot open the gate during a later show', () => {
  const g = gate();
  g.visible(true); g.frame(); g.frame(); g.advance(50);
  g.visible(false); g.visible(true); g.advance(151);
  assert.equal(g.ready(), false);
  g.advance(500);
  assert.equal(g.ready(), true);
});
test('normal compositor frames allow rendering before the fallback', () => {
  const g = gate();
  g.visible(true); g.frame(); g.frame(); g.advance(210);
  assert.equal(g.ready(), true);
  g.visible(false); g.advance(1000);
  assert.equal(g.ready(), false);
});

test('saving the first note recreates a missing notes directory', () => {
  const os = require('node:os');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const writer = main.slice(main.indexOf('function writeCurrentPage('), main.indexOf('// ---------- 窗口'));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noteanywhere-save-test-'));
  const notes = path.join(tmp, 'notes'), file = path.join(notes, 'first.md');
  let state = {};
  try {
    const context = vm.createContext({
      fs, NOTES_DIR: notes,
      loadState: () => state, saveState: (next) => { state = next; },
      newFilePath: () => file,
      ensureNotesDir: () => fs.mkdirSync(notes, { recursive: true }),
    });
    vm.runInContext(writer + '\nwriteCurrentPage("新笔记", 3);', context);
    assert.equal(fs.readFileSync(file, 'utf8'), '新笔记');
    assert.equal(state.file, file);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
