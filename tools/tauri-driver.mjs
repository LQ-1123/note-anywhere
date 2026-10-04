// Tauri(WebView2) 键鼠/输入法驱动：通过 CDP 驱动真实前端。
// 对应 Electron 版 tools/table-regression.js 里的 win.webContents.sendInputEvent 原语
// （Tauri 没有 sendInputEvent，所以走 CDP）。
import { setTimeout as sleep } from 'node:timers/promises';

// CDP modifiers 位掩码
const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

const NAMED = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Space: { key: ' ', code: 'Space', vk: 32 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
};

function letter(name) {
  const upper = name.toUpperCase();
  return { key: name, code: 'Key' + upper, vk: upper.charCodeAt(0) };
}

export class Driver {
  constructor(url) {
    this.url = url;
    this.seq = 0;
    this.pending = new Map();
    this.logs = [];
  }

  static async connect(port = 9223) {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`);
    const list = await res.json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('未找到 WebView2 页面目标（CDP 未就绪？）');
    const d = new Driver(page.webSocketDebuggerUrl);
    await d.open();
    return d;
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.addEventListener('message', (e) => {
        const m = JSON.parse(e.data);
        if (m.method === 'Runtime.consoleAPICalled') {
          this.logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
          return;
        }
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          p(m);
        }
      });
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', (e) => reject(new Error('CDP 连接失败: ' + (e.message || e.type))));
    });
  }

  send(method, params = {}) {
    return new Promise((resolve) => {
      const id = ++this.seq;
      this.pending.set(id, resolve);
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async enableConsole() {
    await this.send('Runtime.enable');
    await this.send('Log.enable');
  }

  async evaluate(expr) {
    const m = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (m.result && m.result.exceptionDetails) {
      throw new Error('JS 异常: ' + JSON.stringify(m.result.exceptionDetails).slice(0, 300));
    }
    return m.result && m.result.result ? m.result.result.value : undefined;
  }

  /** 单个按键，name 见 NAMED，或单个字母 */
  async key(name, mods = []) {
    const spec = NAMED[name] || letter(name);
    const modifiers = mods.reduce((acc, x) => acc | (MOD[x] || 0), 0);
    const base = {
      key: spec.key,
      code: spec.code,
      windowsVirtualKeyCode: spec.vk,
      nativeVirtualKeyCode: spec.vk,
      modifiers,
    };
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(30);
  }

  /** 逐字输入（char 事件，等价 Electron 的 sendInputEvent type:char） */
  async type(text) {
    for (const ch of text) {
      await this.send('Input.dispatchKeyEvent', {
        type: 'char',
        text: ch,
        unmodifiedText: ch,
        key: ch,
      });
      await sleep(35);
    }
  }

  /** 输入法组合中（preedit），不触发上屏 */
  imeSetComposition(text, start = text.length, end = text.length) {
    return this.send('Input.imeSetComposition', { text, selectionStart: start, selectionEnd: end });
  }

  /** 上屏：结束组合并触发 compositionend */
  insertText(text) {
    return this.send('Input.insertText', { text });
  }

  async mouse(selector, dy = 0.5) {
    const raw = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height * ${dy}) });
    })()`);
    if (!raw) throw new Error('找不到元素: ' + selector);
    const p = JSON.parse(raw);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p, button: 'none', clickCount: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    await sleep(60);
  }

  async snapshot() {
    return JSON.parse(await this.evaluate('window.__noteSnapshot()'));
  }

  async until(code, message, timeout = 2500) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await this.evaluate(code)) return;
      await sleep(40);
    }
    throw new Error(message);
  }

  close() {
    try {
      this.ws.close();
    } catch {}
  }
}

export { sleep };
