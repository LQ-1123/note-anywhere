// 窗口、托盘、全局热键、主题：对应 Electron 版 main.js 的 showWindow/hideWindow/toggleWindow/
// buildTrayMenu/sendTheme 等。

use crate::notes;
use crate::review;
use crate::state::AppState;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Theme};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
use tauri_plugin_opener::OpenerExt;

pub const MAIN: &str = "main";
pub const TRAY_ID: &str = "main";

pub fn emit(app: &AppHandle, event: &str, payload: Value) {
    let _ = app.emit(event, payload);
}

pub fn emit_visibility(app: &AppHandle, visible: bool) {
    println!("[win-visibility] send {}", visible);
    emit(app, "win-visibility", json!(visible));
}

pub fn restore_to_ui(
    app: &AppHandle,
    state: &AppState,
    text: String,
    caret: i64,
    file: Option<String>,
) {
    *state.loaded_file.lock().unwrap() = file.clone();
    emit(
        app,
        "restore",
        json!({ "text": text, "caret": caret, "file": file }),
    );
}

/// 恢复上次编辑的页（含光标位置）
pub fn restore_current(app: &AppHandle, state: &AppState) {
    let (file, caret) = {
        let store = state.store.lock().unwrap();
        let st = store.load_state();
        (
            st.get("file").and_then(|v| v.as_str()).map(|s| s.to_string()),
            st.get("caret").and_then(|v| v.as_i64()).unwrap_or(0),
        )
    };
    let (text, file) = match file {
        Some(f) if Path::new(&f).exists() => (fs::read_to_string(&f).unwrap_or_default(), Some(f)),
        _ => (String::new(), None),
    };
    // 光标是 CodeMirror 位置（UTF-16 码元），按码元长度收敛
    let caret = caret.min(crate::search::utf16_len(&text) as i64).max(0);
    restore_to_ui(app, state, text, caret, file);
}

pub fn show(app: &AppHandle, state: &AppState) {
    let Some(win) = app.get_webview_window(MAIN) else {
        return;
    };
    let _ = win.show();
    let _ = win.set_focus();
    emit_visibility(app, true);
    restore_current(app, state);
    // 每日回顾：没有可回顾的内容时不消耗当天名额
    let note = review::maybe_auto_review(&state.store.lock().unwrap());
    if let Some(note) = note {
        emit(app, "review", note);
    }
}

pub fn hide(app: &AppHandle, state: &AppState) {
    let Some(win) = app.get_webview_window(MAIN) else {
        return;
    };
    if let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) {
        let store = state.store.lock().unwrap();
        let mut st = store.load_state();
        notes::set_key(
            &mut st,
            "bounds",
            json!({ "x": pos.x, "y": pos.y, "width": size.width, "height": size.height }),
        );
        store.save_state(&st);
    }
    let _ = win.hide();
    emit_visibility(app, false);
}

pub fn toggle(app: &AppHandle) {
    // 单实例回调可能在状态托管之前触发，这里必须容错
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let Some(win) = app.get_webview_window(MAIN) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        if win.is_focused().unwrap_or(false) {
            hide(app, &state);
        } else {
            let _ = win.set_focus();
        }
    } else {
        show(app, &state);
    }
}

pub fn new_page(app: &AppHandle, state: &AppState) {
    {
        let store = state.store.lock().unwrap();
        let mut st = store.load_state();
        notes::set_key(&mut st, "file", Value::Null);
        notes::set_key(&mut st, "caret", json!(0));
        store.save_state(&st);
    }
    restore_to_ui(app, state, String::new(), 0, None);
}

pub fn apply_theme(app: &AppHandle, mode: &str) {
    let Some(win) = app.get_webview_window(MAIN) else {
        return;
    };
    let theme = match mode {
        "dark" => Some(Theme::Dark),
        "light" => Some(Theme::Light),
        _ => None,
    };
    let _ = win.set_theme(theme);
    let resolved = match mode {
        "dark" => "dark",
        "light" => "light",
        _ => match win.theme() {
            Ok(Theme::Dark) => "dark",
            _ => "light",
        },
    };
    emit(app, "theme", json!(resolved));
}

pub fn current_theme(app: &AppHandle) -> String {
    let mode = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        store.setting_str("theme")
    };
    match mode.as_str() {
        "dark" => "dark".to_string(),
        "light" => "light".to_string(),
        _ => match app.get_webview_window(MAIN).and_then(|w| w.theme().ok()) {
            Some(Theme::Dark) => "dark".to_string(),
            _ => "light".to_string(),
        },
    }
}

pub fn register_hotkey(app: &AppHandle, accel: &str) -> Result<(), ()> {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let shortcut: Shortcut = accel.parse().map_err(|_| ())?;
    gs.register(shortcut).map_err(|_| ())?;
    Ok(())
}

fn folder_label(notes_dir: &Path) -> String {
    format!("打开笔记文件夹（{}）", notes_dir.to_string_lossy())
}

pub fn build_tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let (notes_dir, autostart) = {
        let state = app.state::<AppState>();
        let store = state.store.lock().unwrap();
        (store.notes_dir.clone(), app.autolaunch().is_enabled().unwrap_or(false))
    };
    let open = MenuItem::with_id(app, "open", "打开书写区", true, None::<&str>)?;
    let new = MenuItem::with_id(app, "new", "新建一页", true, None::<&str>)?;
    let folder = MenuItem::with_id(app, "folder", folder_label(&notes_dir), true, None::<&str>)?;
    let auto = CheckMenuItem::with_id(app, "autostart", "开机自启", true, autostart, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(app, &[&open, &new, &sep1, &folder, &auto, &sep2, &quit])
}

pub fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = build_tray_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
}

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_tray_menu(app)?;
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("NoteAnywhere")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                let state = app.state::<AppState>();
                show(app, &state);
            }
            "new" => {
                let state = app.state::<AppState>();
                show(app, &state);
                new_page(app, &state);
            }
            "folder" => {
                let path = {
                    let state = app.state::<AppState>();
                    let store = state.store.lock().unwrap();
                    store.notes_dir.clone()
                };
                let _ = fs::create_dir_all(&path);
                let _ = app
                    .opener()
                    .open_path(path.to_string_lossy().to_string(), None::<&str>);
            }
            "autostart" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let _ = if enabled {
                    app.autolaunch().disable()
                } else {
                    app.autolaunch().enable()
                };
                refresh_tray(app);
            }
            "quit" => {
                let state = app.state::<AppState>();
                state.quitting.store(true, std::sync::atomic::Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}
