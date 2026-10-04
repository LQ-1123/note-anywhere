// 冒烟/诊断专用启动器：独立 userData + 临时笔记目录，
// 避开常驻实例的单例锁，也不触碰真实笔记（用法：npx electron tools/smoke-bootstrap.js --smoke [--diag]）
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noteanywhere-smoke-'));
app.setPath('userData', tmp);
fs.mkdirSync(path.join(tmp, 'notes'), { recursive: true });

// 卡死诊断：CPU profile + 定时强退（profile 需要优雅退出才落盘）
if (process.env.SMOKE_CPUPROF === '1') {
  const profDir = path.join(tmp, 'prof');
  fs.mkdirSync(profDir, { recursive: true });
  app.commandLine.appendSwitch('cpu-prof');
  app.commandLine.appendSwitch('cpu-prof-dir', profDir);
  app.commandLine.appendSwitch('cpu-prof-interval', '1000');
  setTimeout(() => {
    console.log('PROFILE-DIR', profDir);
    app.exit(3);
  }, 12000);
}

fs.writeFileSync(
  path.join(tmp, 'config.json'),
  // 热键换成不会与运行中的正式实例冲突的组合，避免冒烟时弹原生错误框卡住
  JSON.stringify({ notesDir: path.join(tmp, 'notes'), hotkey: 'Ctrl+Alt+Shift+F23' }),
  'utf8'
);

// 用户启动路径探针：隐藏窗口 + 恢复一篇含表格的笔记（开机自启场景），5 秒后探活
if (['1', 'hidden'].includes(process.env.SMOKE_USER_PROBE)) {
  const notesDir = path.join(tmp, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });
  const noteFile = path.join(notesDir, '2026-10-04_10-00-00.md');
  fs.writeFileSync(
    noteFile,
    '# 表格笔记\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n| 丁 | 戊 | 己 |\n\n结尾段落\n',
    'utf8'
  );
  fs.writeFileSync(path.join(tmp, 'state.json'), JSON.stringify({ file: noteFile, caret: 5 }), 'utf8');
  setTimeout(async () => {
    try {
      const electron = require('electron');
      const wins = electron.BrowserWindow.getAllWindows();
      // 复刻用户呼出窗口：show 后立刻推送 restore（含表格文档）
      if (process.env.SMOKE_USER_PROBE !== 'hidden') wins[0].show();
      wins[0].webContents.send('restore', {
        text: '# 表格笔记\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 甲 | 乙 | 丙 |\n| 丁 | 戊 | 己 |\n\n结尾段落\n',
        caret: 0,
        file: noteFile,
      });
      await new Promise((r) => setTimeout(r, 3000));
      const res = await Promise.race([
        wins[0].webContents.executeJavaScript(
          'window.__noteSnapshot ? "alive:" + document.querySelectorAll(".cm-table-wrap").length : "nosnap"'
        ),
        new Promise((r) => setTimeout(() => r('DEAD-RENDERER'), 3000)),
      ]);
      console.log('USERPROBE', res);
      process.exitCode = String(res).startsWith('alive') ? 0 : 4;
    } catch (e) {
      console.log('USERPROBE error', e.message);
      process.exitCode = 5;
    }
    require('electron').app.exit(process.exitCode || 0);
  }, 5000);
}

// 纯诊断存活探针：全新状态 + 隐藏窗口 + diag（不 show、不轮询），8 秒后探活
if (process.env.SMOKE_DIAG_PROBE === '1') {
  setTimeout(async () => {
    try {
      const wins = require('electron').BrowserWindow.getAllWindows();
      const res = await Promise.race([
        wins[0].webContents.executeJavaScript(
          'window.__diagResult ? "alive:" + window.__diagResult.length : (window.__noteSnapshot ? "alive:noDiag" : "nosnap")'
        ),
        new Promise((r) => setTimeout(() => r('DEAD-RENDERER'), 3000)),
      ]);
      console.log('DIAGPROBE', res);
      process.exitCode = String(res).startsWith('alive') ? 0 : 4;
    } catch (e) {
      console.log('DIAGPROBE error', e.message);
      process.exitCode = 5;
    }
    require('electron').app.exit(process.exitCode || 0);
  }, 8000);
}

process.on('exit', () => {
  if (process.env.SMOKE_KEEP !== '1') {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

require('../main.js');
