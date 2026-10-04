// 所有 #[tauri::command]：对应 Electron 版 preload.js 暴露的 window.bridge 命令面。

use crate::notes::{self, safe_page_path};
use crate::review;
use crate::search;
use crate::state::AppState;
use crate::window;
use serde_json::{json, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use tauri_plugin_opener::OpenerExt;

pub(crate) fn settings_payload(app: &AppHandle, state: &AppState) -> Value {
    let store = state.store.lock().unwrap();
    let mut obj = store.settings.clone();
    obj.insert(
        "notesDir".into(),
        Value::String(store.notes_dir.to_string_lossy().to_string()),
    );
    obj.insert(
        "userData".into(),
        Value::String(store.data_dir.to_string_lossy().to_string()),
    );
    obj.insert(
        "version".into(),
        Value::String(app.package_info().version.to_string()),
    );
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    obj.insert("autostart".into(), Value::Bool(autostart));
    Value::Object(obj)
}

#[tauri::command]
pub fn get_settings(app: AppHandle, state: State<'_, AppState>) -> Value {
    settings_payload(&app, &state)
}

#[tauri::command]
pub fn set_setting(
    app: AppHandle,
    state: State<'_, AppState>,
    key: String,
    value: Value,
) -> Value {
    match key.as_str() {
        "hotkey" => {
            let v = value.as_str().unwrap_or("").to_string();
            if v.is_empty() {
                return json!({ "ok": false });
            }
            let previous = state.store.lock().unwrap().setting_str("hotkey");
            if window::register_hotkey(&app, &v).is_err() {
                let _ = window::register_hotkey(&app, &previous);
                return json!({ "ok": false, "error": "该组合键被其他程序占用" });
            }
            state.store.lock().unwrap().settings.insert("hotkey".into(), json!(v));
            state.store.lock().unwrap().save_config();
            window::refresh_tray(&app);
        }
        "theme" => {
            let v = value.as_str().unwrap_or("system").to_string();
            if !["system", "dark", "light"].contains(&v.as_str()) {
                return json!({ "ok": false });
            }
            state.store.lock().unwrap().settings.insert("theme".into(), json!(v));
            state.store.lock().unwrap().save_config();
            window::apply_theme(&app, &v);
        }
        "autostart" => {
            let on = value.as_bool().unwrap_or(false);
            let r = if on {
                app.autolaunch().enable()
            } else {
                app.autolaunch().disable()
            };
            if r.is_err() {
                return json!({ "ok": false });
            }
            window::refresh_tray(&app);
        }
        "alwaysOnTop" => {
            let on = value.as_bool().unwrap_or(true);
            state
                .store
                .lock()
                .unwrap()
                .settings
                .insert("alwaysOnTop".into(), json!(on));
            state.store.lock().unwrap().save_config();
            if let Some(win) = app.get_webview_window(window::MAIN) {
                let _ = win.set_always_on_top(on);
            }
        }
        "fontSize" => {
            let n = value.as_i64().unwrap_or(15);
            if ![14, 15, 16, 17, 18].contains(&n) {
                return json!({ "ok": false });
            }
            state.store.lock().unwrap().settings.insert("fontSize".into(), json!(n));
            state.store.lock().unwrap().save_config();
        }
        "tabWidth" => {
            let n = value.as_i64().unwrap_or(4);
            if ![2, 4].contains(&n) {
                return json!({ "ok": false });
            }
            state.store.lock().unwrap().settings.insert("tabWidth".into(), json!(n));
            state.store.lock().unwrap().save_config();
        }
        "livePreview" | "lineNumbers" | "indentDots" => {
            let on = value.as_bool().unwrap_or(true);
            state.store.lock().unwrap().settings.insert(key.clone(), json!(on));
            state.store.lock().unwrap().save_config();
        }
        "reviewMode" => {
            let v = value.as_str().unwrap_or("daily").to_string();
            if !["off", "daily", "always"].contains(&v.as_str()) {
                return json!({ "ok": false });
            }
            state.store.lock().unwrap().settings.insert("reviewMode".into(), json!(v));
            state.store.lock().unwrap().save_config();
        }
        "reviewMinDays" => {
            let n = value.as_i64().unwrap_or(7);
            if !review::REVIEW_MIN_DAYS_CHOICES.contains(&n) {
                return json!({ "ok": false });
            }
            state.store.lock().unwrap().settings.insert("reviewMinDays".into(), json!(n));
            state.store.lock().unwrap().save_config();
        }
        _ => return json!({ "ok": false }),
    }
    // 与 Electron 版一致：设置变化后整体推一份给渲染层
    let payload = settings_payload(&app, &state);
    window::emit(&app, "settings-changed", payload);
    json!({ "ok": true })
}

#[tauri::command]
pub fn list_pages(state: State<'_, AppState>) -> Value {
    let store = state.store.lock().unwrap();
    notes::list_pages(&store)
}

#[tauri::command]
pub fn search_notes(state: State<'_, AppState>, query: String) -> Value {
    let store = state.store.lock().unwrap();
    search::search_notes(&store, &query)
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Value {
    let store = state.store.lock().unwrap();
    search::list_tags(&store)
}

#[tauri::command]
pub fn review_note(state: State<'_, AppState>, exclude: Option<Vec<String>>) -> Value {
    let store = state.store.lock().unwrap();
    let note = review::pick_review_note(&store, &exclude.unwrap_or_default());
    json!({ "ok": true, "note": note })
}

#[tauri::command]
pub fn review_dismiss(state: State<'_, AppState>, path: String) {
    let store = state.store.lock().unwrap();
    review::dismiss_review(&store, &path);
}

#[tauri::command]
pub fn save_page(app: AppHandle, state: State<'_, AppState>, text: String, caret: i64) {
    let store = state.store.lock().unwrap();
    let loaded = state.loaded_file.lock().unwrap().clone();
    let written = notes::write_current_page(&store, &loaded, &text, caret);
    drop(store);
    if written.is_some() {
        let _ = app.emit("note-saved", json!({ "at": chrono::Local::now().timestamp_millis() }));
    }
}

#[tauri::command]
pub fn open_page(app: AppHandle, state: State<'_, AppState>, path: String) -> Value {
    let store = state.store.lock().unwrap();
    let file = match safe_page_path(&store, &path) {
        Some(f) if f.exists() => f,
        _ => return json!({ "ok": false }),
    };
    let text = notes::read_page(&file);
    let mut st = store.load_state();
    let remembered = st
        .get("carets")
        .and_then(|c| c.get(file.to_string_lossy().to_string()))
        .and_then(|v| v.as_i64())
        .unwrap_or(text.len() as i64);
    let caret = remembered.clamp(0, text.chars().count() as i64);
    notes::set_key(&mut st, "file", json!(file.to_string_lossy()));
    notes::set_key(&mut st, "caret", json!(caret));
    store.save_state(&st);
    drop(store);
    window::restore_to_ui(&app, &state, text, caret, Some(file.to_string_lossy().to_string()));
    json!({ "ok": true })
}

#[tauri::command]
pub fn open_page_at(app: AppHandle, state: State<'_, AppState>, path: String, offset: i64) -> Value {
    let store = state.store.lock().unwrap();
    let file = match safe_page_path(&store, &path) {
        Some(f) if f.exists() => f,
        _ => return json!({ "ok": false }),
    };
    let text = notes::read_page(&file);
    let caret = offset.max(0).min(text.chars().count() as i64);
    let mut st = store.load_state();
    let mut carets = st.get("carets").cloned().unwrap_or(json!({}));
    notes::set_key(&mut carets, &file.to_string_lossy(), json!(caret));
    notes::set_key(&mut st, "carets", carets);
    notes::set_key(&mut st, "file", json!(file.to_string_lossy()));
    notes::set_key(&mut st, "caret", json!(caret));
    store.save_state(&st);
    drop(store);
    window::restore_to_ui(&app, &state, text, caret, Some(file.to_string_lossy().to_string()));
    json!({ "ok": true })
}

#[tauri::command]
pub fn new_page(app: AppHandle, state: State<'_, AppState>) -> Value {
    let store = state.store.lock().unwrap();
    let st = store.load_state();
    let mut st = st;
    notes::set_key(&mut st, "file", Value::Null);
    notes::set_key(&mut st, "caret", json!(0));
    store.save_state(&st);
    drop(store);
    window::restore_to_ui(&app, &state, String::new(), 0, None);
    json!({ "ok": true })
}

#[tauri::command]
pub fn delete_page(app: AppHandle, state: State<'_, AppState>, path: String) -> Value {
    let file: PathBuf = {
        let store = state.store.lock().unwrap();
        match safe_page_path(&store, &path) {
            Some(f) if f.exists() => f,
            _ => return json!({ "ok": false }),
        }
    };
    notes::trash_file(&file);
    let store = state.store.lock().unwrap();
    let mut st = store.load_state();
    let mut carets = st.get("carets").cloned().unwrap_or(json!({}));
    if let Some(obj) = carets.as_object_mut() {
        obj.remove(&file.to_string_lossy().to_string());
    }
    notes::set_key(&mut st, "carets", carets);
    let is_current = st.get("file").and_then(|v| v.as_str()) == Some(file.to_string_lossy().as_ref());
    if is_current {
        notes::set_key(&mut st, "file", Value::Null);
        notes::set_key(&mut st, "caret", json!(0));
    }
    store.save_state(&st);
    drop(store);
    if is_current {
        window::restore_to_ui(&app, &state, String::new(), 0, None);
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn hide_window(app: AppHandle, state: State<'_, AppState>) {
    window::hide(&app, &state);
}

#[tauri::command]
pub fn show_window(app: AppHandle, state: State<'_, AppState>) {
    window::show(&app, &state);
}

#[tauri::command]
pub async fn pick_notes_dir(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |picked| {
        let _ = tx.send(picked.map(|p| p.to_string()));
    });
    let picked = match rx.recv() {
        Ok(Some(dir)) => dir,
        _ => return Ok(json!({ "ok": false })),
    };
    let path = PathBuf::from(&picked);
    {
        let mut store = state.store.lock().unwrap();
        store.notes_dir = path;
        store.ensure_notes_dir();
        store.save_config();
    }
    window::refresh_tray(&app);
    Ok(json!({ "ok": true, "dir": picked }))
}

#[tauri::command]
pub fn reset_window(app: AppHandle, state: State<'_, AppState>) -> Value {
    let store = state.store.lock().unwrap();
    let mut st = store.load_state();
    if let Some(obj) = st.as_object_mut() {
        obj.remove("bounds");
    }
    store.save_state(&st);
    drop(store);
    if let Some(win) = app.get_webview_window(window::MAIN) {
        let _ = win.center();
    }
    json!({ "ok": true })
}

#[tauri::command]
pub fn open_path(app: AppHandle, state: State<'_, AppState>, target: String) -> Value {
    let path = {
        let store = state.store.lock().unwrap();
        match target.as_str() {
            "notes" => store.notes_dir.clone(),
            "userData" => store.data_dir.clone(),
            _ => return json!({ "ok": false }),
        }
    };
    let _ = std::fs::create_dir_all(&path);
    let _ = app.opener().open_path(path.to_string_lossy().to_string(), None::<&str>);
    json!({ "ok": true })
}

#[tauri::command]
pub fn open_link(app: AppHandle, url: String) -> Value {
    if url.is_empty() {
        return json!({ "ok": false });
    }
    let is_web = url.starts_with("http://") || url.starts_with("https://") || url.starts_with("mailto:");
    let result = if is_web {
        app.opener().open_url(url.clone(), None::<&str>)
    } else {
        app.opener().open_path(url.clone(), None::<&str>)
    };
    match result {
        Ok(_) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

#[tauri::command]
pub fn save_image(state: State<'_, AppState>, bytes: Vec<u8>, mime: String) -> Value {
    let store = state.store.lock().unwrap();
    let ext = mime.rsplit('/').next().unwrap_or("png").to_string();
    match notes::save_image_bytes(&store, &bytes, &ext) {
        Ok(rel) => json!({ "ok": true, "rel": rel }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn save_clipboard_image(state: State<'_, AppState>) -> Value {
    let mut clipboard = match arboard::Clipboard::new() {
        Ok(c) => c,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    let img = match clipboard.get_image() {
        Ok(i) => i,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    let mut png_bytes: Vec<u8> = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png_bytes, img.width as u32, img.height as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = match encoder.write_header() {
            Ok(w) => w,
            Err(e) => return json!({ "ok": false, "error": e.to_string() }),
        };
        if let Err(e) = writer.write_image_data(&img.bytes) {
            return json!({ "ok": false, "error": e.to_string() });
        }
    }
    let store = state.store.lock().unwrap();
    match notes::save_image_bytes(&store, &png_bytes, "png") {
        Ok(rel) => json!({ "ok": true, "rel": rel }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

/// 渲染层加载完成后主动报到：宿主据此推初始主题/可见性/设置，并标记 pageReady。
/// （Tauri 里窗口由配置创建，没有 Electron 那样的 did-finish-load 钩子，所以由前端报到。）
#[tauri::command]
pub fn frontend_ready(app: AppHandle, state: State<'_, AppState>) -> Value {
    state.page_ready.store(true, std::sync::atomic::Ordering::SeqCst);
    let theme = window::current_theme(&app);
    window::emit(&app, "theme", json!(theme));
    let visible = app
        .get_webview_window(window::MAIN)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    window::emit_visibility(&app, visible);
    let payload = settings_payload(&app, &state);
    window::emit(&app, "settings-changed", payload);
    // 调试/手测：NOTEANYWHERE_SHOW=1 时启动即显形
    if std::env::var("NOTEANYWHERE_SHOW").is_ok() {
        window::show(&app, &state);
    }
    json!({ "ok": true })
}

/// 供外部（CDP 测试 / 调试）校验宿主能力：无边框置顶卡、托盘、全局热键都得能验证
#[tauri::command]
pub fn debug_window(app: AppHandle, state: State<'_, AppState>) -> Value {
    let Some(win) = app.get_webview_window(window::MAIN) else {
        return json!({ "ok": false });
    };
    let size = win
        .outer_size()
        .map(|s| json!({ "w": s.width, "h": s.height }))
        .unwrap_or(Value::Null);
    let hotkey = state.store.lock().unwrap().setting_str("hotkey");
    let shortcut: Option<tauri_plugin_global_shortcut::Shortcut> = hotkey.parse().ok();
    let hotkey_registered = shortcut
        .map(|s| app.global_shortcut().is_registered(s))
        .unwrap_or(false);
    json!({
        "ok": true,
        "decorations": win.is_decorated().unwrap_or(true),
        "alwaysOnTop": win.is_always_on_top().unwrap_or(false),
        "visible": win.is_visible().unwrap_or(false),
        "focused": win.is_focused().unwrap_or(false),
        "resizable": win.is_resizable().unwrap_or(true),
        "size": size,
        "theme": format!("{:?}", win.theme()),
        "tray": app.tray_by_id(window::TRAY_ID).is_some(),
        "hotkey": hotkey,
        "hotkeyRegistered": hotkey_registered,
        "singleInstance": true
    })
}

/// 供外部（CDP 测试 / 调试）读取：当前设置与状态文件路径
#[tauri::command]
pub fn debug_paths(state: State<'_, AppState>) -> Value {
    let store = state.store.lock().unwrap();
    json!({
        "dataDir": store.data_dir.to_string_lossy(),
        "notesDir": store.notes_dir.to_string_lossy(),
        "statePath": store.state_path().to_string_lossy(),
        "configPath": store.config_path().to_string_lossy(),
        "reviewsPath": store.reviews_path().to_string_lossy()
    })
}
