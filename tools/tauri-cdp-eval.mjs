// Tauri(WebView2) 前端 CDP 驱动：对页面执行一段 JS 并打印结果。
// 用法：node tools/tauri-cdp-eval.mjs <wsUrl> "<expression>"
//      node tools/tauri-cdp-eval.mjs <wsUrl> @path/to/expr.js   （避免 PowerShell 传参破坏引号）
import fs from 'node:fs';

let [target, expression] = process.argv.slice(2);
if (expression && expression.startsWith('@')) {
  expression = fs.readFileSync(expression.slice(1), 'utf8');
}
if (!target || !expression) {
  console.error('用法: node tools/tauri-cdp-eval.mjs <wsUrl> "<expression>" | @file.js');
  process.exit(2);
}
const ws = new WebSocket(target);
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
function send(method, params) {
  return new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
ws.addEventListener('open', async () => {
  const r = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(r.result));
  process.exit(0);
});
ws.addEventListener('error', (e) => {
  console.error('WS-ERROR', e.message || e.type);
  process.exit(4);
});
setTimeout(() => {
  console.error('CDP-TIMEOUT');
  process.exit(3);
}, 20000);
