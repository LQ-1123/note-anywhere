# NoteAnywhere —— Tauri 版宿主层

Electron 版的宿主层（`../main.js` + `../preload.js`）在这里用 Rust 重写。
**渲染层完全共用**：`../renderer/` 一行都不用改，靠 `../renderer/bridge-tauri.js` 把
`window.bridge` 映射到 Tauri 的 `invoke` / `listen`。

```
renderer/src/app.js  ──window.bridge──┬── preload.js      （Electron）
                                      └── bridge-tauri.js （Tauri → Rust 命令）
```

## 模块

| 文件 | 对应 Electron 版 | 职责 |
| --- | --- | --- |
| `main.rs` | `main.js` 顶部 | 插件注册、托盘、热键、窗口事件、命令表 |
| `store.rs` | `config.json`/`state.json`/`reviews.json` | 设置与状态持久化，首次运行从 Electron 版导入 |
| `state.rs` | 模块级变量 | `loaded_file`（数据安全关键，见下）、pageReady、quitting |
| `notes.rs` | `listPages`/`writeCurrentPage`/`pageTitle` | 笔记读写、列表、标题、回收站删除、图片落盘 |
| `search.rs` | `search-notes`/`list-tags` | 全文搜索与 `#标签` 扫描 |
| `review.rs` | `pickReviewNote`/`maybeAutoReview` | 每日回顾的挑选与分档 |
| `window.rs` | `showWindow`/`hideWindow`/托盘/主题 | 窗口显隐、托盘菜单、全局热键、主题推送 |
| `commands.rs` | `preload.js` 暴露的命令面 | 19 个 `#[tauri::command]` |

## 构建

```bash
npm run tauri:build     # = npm run bundle && cargo build --release --manifest-path src-tauri/Cargo.toml
# 产物：src-tauri/target/release/noteanywhere.exe
```

前端（`../renderer`）在**编译期**由 `generate_context!` 嵌入 exe，所以发布时不需要带任何资源目录。
安装包需要 Tauri CLI（`cargo install tauri-cli`）后跑 `cargo tauri build`；只出 exe 的话 `cargo build --release` 就够。

## 两个必须知道的坑

### 1. `capabilities/` 不配，事件订阅会被拒

Tauri 2 有 ACL：自定义命令不受影响，但 `plugin:event|listen` 这类核心插件命令需要授权。
漏配时的报错是 **`Command plugin:event|listen not allowed by ACL`**，表现为「宿主推送的事件一个都收不到」。
见 `capabilities/default.json`（只放开 `core:default` + `core:event:default`）。

### 2. 某些受限目录下 WebView2 起不来

若 exe 放在权限受限的目录（本仓库开发时的工作区就是），启动会崩在

```
Failed to setup app: ... failed to create webview: WebView2 error: WindowsError(Error { code: HRESULT(0x800700AA) })
```

或 `拒绝访问 (os error 5)`。这是**目录 ACL**问题，不是代码问题。绕开：

```bash
CARGO_TARGET_DIR=D:\some\writable\path cargo build --release --manifest-path src-tauri/Cargo.toml
```

## 数据安全：`loaded_file`

`notes.rs::write_current_page` 有一条从 Electron 版继承下来的硬规则：
**只有 `state.file == loaded_file` 时，「编辑器内容为空」才代表用户清空了这一页，才允许回收文件。**

否则（例如开机自启、还没 `restore` 就退出触发 flush）编辑器本来就是空的，删文件会误删用户的笔记。
Electron 版曾因此丢过真实笔记（v1.8.1 修复），Tauri 版一并保留了这个约束，删除也一律走 `trash`（回收站）。

## 测试

`tools/tauri-cdp-eval.mjs` 通过 CDP 驱动 WebView2 里的前端（Tauri 无 `sendInputEvent`）：

```bash
# 启动时带上调试端口
set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
noteanywhere.exe
# 另一终端
node tools/tauri-cdp-eval.mjs "<wsUrl>" "@tools/expr.js"
```

`wsUrl` 从 `http://127.0.0.1:9223/json/list` 取。
