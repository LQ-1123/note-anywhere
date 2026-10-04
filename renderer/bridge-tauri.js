// Tauri 版的 window.bridge 适配层。
//
// 渲染层完全通过 window.bridge 与宿主通信：
//   - Electron 下由 preload.js 注入（此时本文件直接返回，什么都不做）
//   - Tauri 下由这里把 bridge 映射到 __TAURI__ 的 invoke / listen
// 因此 renderer/src/app.js 两边共用，一行都不用改。
(function () {
  if (window.bridge) return; // Electron：preload 已经注入
  const T = window.__TAURI__;
  if (!T || !T.core || !T.core.invoke) return; // 两个宿主都没有：保持原样，便于浏览器里调试
  const invoke = T.core.invoke;
  const listen = T.event && T.event.listen ? T.event.listen : null;

  const handlers = Object.create(null);
  const sub = (name) => (cb) => {
    (handlers[name] || (handlers[name] = [])).push(cb);
  };
  const wire = (event, name) => {
    if (!listen) return;
    listen(event, (e) => {
      const list = handlers[name];
      if (!list) return;
      for (const cb of list) {
        try {
          cb(e.payload);
        } catch (err) {
          console.error('[bridge] handler failed', event, err);
        }
      }
    }).catch((err) => console.error('[bridge] listen failed', event, err));
  };

  const call = (cmd, args) => invoke(cmd, args || {});
  // 与 Electron 的 ipcRenderer.send 对应：不等结果，但失败要看得到
  const fire = (cmd, args) => {
    invoke(cmd, args || {}).catch((err) => console.error('[bridge]', cmd, err));
  };

  window.bridge = {
    onRestore: sub('restore'),
    onTheme: sub('theme'),
    onSettingsChanged: sub('settings'),
    onOpenSettings: sub('openSettings'),
    onVisibility: sub('visibility'),
    onReview: sub('review'),

    getSettings: () => call('get_settings'),
    setSetting: (key, value) => call('set_setting', { key, value }),
    pickNotesDir: () => call('pick_notes_dir'),
    listPages: () => call('list_pages'),
    searchNotes: (query) => call('search_notes', { query }),
    listTags: () => call('list_tags'),
    openPageAt: (path, offset) => call('open_page_at', { path, offset }),
    openPage: (p) => fire('open_page', { path: p }),
    deletePage: (p) => call('delete_page', { path: p }),
    resetWindow: () => call('reset_window'),
    openPath: (target) => call('open_path', { target }),
    openLink: (url) => call('open_link', { url }),
    // Uint8Array 不能直接跨 IPC，转成普通数组（速记里的截图都很小）
    saveImage: (bytes, mime) =>
      call('save_image', {
        bytes: Array.prototype.slice.call(bytes || []),
        mime: mime || 'image/png',
      }),
    saveClipboardImage: () => call('save_clipboard_image'),
    save: (text, caret) => fire('save_page', { text, caret }),
    hide: () => fire('hide_window'),
    newPage: () => fire('new_page'),
    reviewNote: (exclude) => call('review_note', { exclude: exclude || [] }),
    reviewDismiss: (path) => call('review_dismiss', { path }),

    // Tauri 专有：前端就绪报到（窗口由配置创建，没有 did-finish-load 钩子）
    ready: () => call('frontend_ready'),
  };

  wire('restore', 'restore');
  wire('theme', 'theme');
  wire('settings-changed', 'settings');
  wire('open-settings', 'openSettings');
  wire('win-visibility', 'visibility');
  wire('review', 'review');

  const ready = () => {
    window.bridge.ready().catch((err) => console.error('[bridge] ready failed', err));
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', () => setTimeout(ready, 0));
  } else {
    setTimeout(ready, 0);
  }
})();
