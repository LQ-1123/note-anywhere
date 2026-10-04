// 应用运行时状态：与 Electron 版 main.js 顶部的模块级变量一一对应。

use crate::store::Store;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;
use tauri::AppHandle;

pub struct AppState {
    pub store: Mutex<Store>,
    /// 渲染层当前真正持有的是哪一页（None = 编辑器是空的、还没载入任何一页）。
    /// 只有它和 state.file 一致时，「内容为空」才代表用户清空了这一页 —— 这是 v1.8.1 修掉
    /// 数据丢失 bug 的关键：开机自启常驻托盘，退出时 flush 的编辑器本来就是空的。
    pub loaded_file: Mutex<Option<String>>,
    pub page_ready: AtomicBool,
    pub quitting: AtomicBool,
}

impl AppState {
    pub fn new(app: &AppHandle) -> Self {
        AppState {
            store: Mutex::new(Store::load(app)),
            loaded_file: Mutex::new(None),
            page_ready: AtomicBool::new(false),
            quitting: AtomicBool::new(false),
        }
    }
}
