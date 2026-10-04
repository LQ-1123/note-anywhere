// NoteAnywhere —— Tauri 版宿主层。
// 渲染层与 Electron 版共用同一个 renderer/ 目录，靠 window.bridge 适配层对接。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod notes;
mod review;
mod search;
mod state;
mod store;
mod window;

use state::AppState;
use std::sync::atomic::Ordering;
use tauri::{Manager, WindowEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            window::toggle(app);
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        window::toggle(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::set_setting,
            commands::list_pages,
            commands::search_notes,
            commands::list_tags,
            commands::review_note,
            commands::review_dismiss,
            commands::save_page,
            commands::open_page,
            commands::open_page_at,
            commands::new_page,
            commands::delete_page,
            commands::hide_window,
            commands::show_window,
            commands::pick_notes_dir,
            commands::reset_window,
            commands::open_path,
            commands::open_link,
            commands::save_image,
            commands::save_clipboard_image,
            commands::debug_paths,
            commands::debug_window,
            commands::frontend_ready,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(AppState::new(&handle));

            // 托盘失败不该让整个应用起不来（受限环境里可能创建不了）
            match window::setup_tray(&handle) {
                Ok(_) => println!("[setup] tray ok"),
                Err(e) => eprintln!("[setup] tray FAILED: {}", e),
            }

            let hotkey = {
                let state = handle.state::<AppState>();
                let store = state.store.lock().unwrap();
                let h = store.setting_str("hotkey");
                if h.is_empty() {
                    "Alt+Q".to_string()
                } else {
                    h
                }
            };
            if window::register_hotkey(&handle, &hotkey).is_err() {
                eprintln!("[hotkey] 注册失败：{}", hotkey);
            }

            let theme = window::current_theme(&handle);
            window::apply_theme(&handle, &theme);

            if let Some(win) = handle.get_webview_window(window::MAIN) {
                let w = handle.clone();
                win.on_window_event(move |event| match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        if let Some(state) = w.try_state::<AppState>() {
                            if !state.quitting.load(Ordering::SeqCst) {
                                api.prevent_close();
                                window::hide(&w, &state);
                            }
                        }
                    }
                    WindowEvent::ThemeChanged(theme) => {
                        if let Some(state) = w.try_state::<AppState>() {
                            let mode = {
                                let store = state.store.lock().unwrap();
                                store.setting_str("theme")
                            };
                            if mode == "system" {
                                let v = match theme {
                                    tauri::Theme::Dark => "dark",
                                    _ => "light",
                                };
                                window::emit(&w, "theme", serde_json::json!(v));
                            }
                        }
                    }
                    _ => {}
                });
            }

            println!("APP-READY {{ hotkey: true }}");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
