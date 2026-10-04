// 配置与状态持久化：对应 Electron 版的 config.json / state.json / reviews.json。
// 另外负责首次运行时从 Electron 版导入设置，避免迁移后笔记目录被重置。

use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// 与 Electron 版一致的默认笔记目录
pub const DEFAULT_NOTES_DIR: &str = "D:\\desktop\\insights";

pub fn default_settings() -> Map<String, Value> {
    json!({
        "hotkey": "Alt+Q",
        "theme": "system",
        "fontSize": 15,
        "tabWidth": 4,
        "livePreview": true,
        "lineNumbers": true,
        "indentDots": true,
        "alwaysOnTop": true,
        "reviewMode": "daily",
        "reviewMinDays": 7
    })
    .as_object()
    .cloned()
    .unwrap_or_default()
}

pub struct Store {
    pub data_dir: PathBuf,
    pub notes_dir: PathBuf,
    pub settings: Map<String, Value>,
}

fn read_json(path: &PathBuf) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or(Value::Null)
}

fn write_json(path: &PathBuf, value: &Value) {
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string_pretty(value) {
        let _ = fs::write(path, text);
    }
}

/// Electron 版把配置放在 %APPDATA%\NoteAnywhere（打包版）或 %APPDATA%\note-anywhere（开发版）
fn electron_config() -> Option<Value> {
    let appdata = std::env::var("APPDATA").ok()?;
    for name in ["NoteAnywhere", "note-anywhere"] {
        let path = PathBuf::from(&appdata).join(name).join("config.json");
        let v = read_json(&path);
        if v.is_object() {
            return Some(v);
        }
    }
    None
}

fn electron_state() -> Option<Value> {
    let appdata = std::env::var("APPDATA").ok()?;
    for name in ["NoteAnywhere", "note-anywhere"] {
        let path = PathBuf::from(&appdata).join(name).join("state.json");
        let v = read_json(&path);
        if v.is_object() {
            return Some(v);
        }
    }
    None
}

impl Store {
    pub fn load(app: &AppHandle) -> Store {
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("."));
        let _ = fs::create_dir_all(&data_dir);
        let config_path = data_dir.join("config.json");
        let saved = read_json(&config_path);
        // 首次运行（还没有自己的 config.json）：从 Electron 版导入
        let source = if saved.is_object() {
            saved
        } else {
            let imported = electron_config().unwrap_or(Value::Null);
            if imported.is_object() {
                write_json(&config_path, &imported);
                println!("[store] 已从 Electron 版导入配置");
            }
            imported
        };

        let mut settings = default_settings();
        if let Some(obj) = source.as_object() {
            for (k, v) in obj {
                if k != "notesDir" {
                    settings.insert(k.clone(), v.clone());
                }
            }
        }
        let notes_dir = source
            .get("notesDir")
            .and_then(|v| v.as_str())
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(DEFAULT_NOTES_DIR));

        // state.json 也顺带导入一次，保留"上次编辑的页与光标"
        let state_path = data_dir.join("state.json");
        if !state_path.exists() {
            if let Some(st) = electron_state() {
                write_json(&state_path, &st);
            }
        }

        Store {
            data_dir,
            notes_dir,
            settings,
        }
    }

    pub fn config_path(&self) -> PathBuf {
        self.data_dir.join("config.json")
    }
    pub fn state_path(&self) -> PathBuf {
        self.data_dir.join("state.json")
    }
    pub fn reviews_path(&self) -> PathBuf {
        self.data_dir.join("reviews.json")
    }

    pub fn save_config(&self) {
        let mut obj = self.settings.clone();
        obj.insert(
            "notesDir".into(),
            Value::String(self.notes_dir.to_string_lossy().to_string()),
        );
        write_json(&self.config_path(), &Value::Object(obj));
    }

    pub fn load_state(&self) -> Value {
        read_json(&self.state_path())
    }
    pub fn save_state(&self, value: &Value) {
        write_json(&self.state_path(), value);
    }
    pub fn load_reviews(&self) -> Value {
        let v = read_json(&self.reviews_path());
        if v.is_object() {
            v
        } else {
            json!({ "notes": {}, "lastShown": "" })
        }
    }
    pub fn save_reviews(&self, value: &Value) {
        write_json(&self.reviews_path(), value);
    }

    pub fn ensure_notes_dir(&self) {
        let _ = fs::create_dir_all(&self.notes_dir);
    }

    pub fn setting_str(&self, key: &str) -> String {
        self.settings
            .get(key)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    }
    pub fn setting_i64(&self, key: &str, fallback: i64) -> i64 {
        self.settings.get(key).and_then(|v| v.as_i64()).unwrap_or(fallback)
    }
    pub fn setting_bool(&self, key: &str, fallback: bool) -> bool {
        self.settings
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(fallback)
    }
}
