// 笔记文件操作：对应 Electron 版 main.js 里的 listPages / writeCurrentPage / pageTitle 等。
// 注意 writeCurrentPage 保留了 v1.8.1 的数据安全修复：只有「这一页确实载入过」时才允许空页回收。

use crate::store::Store;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub fn set_key(v: &mut Value, key: &str, val: Value) {
    if let Some(obj) = v.as_object_mut() {
        obj.insert(key.to_string(), val);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 读取文件首行作为标题（只读前 512 字节，避免大文件开销）
pub fn page_title(file: &Path) -> String {
    let bytes = match fs::read(file) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    let head = &bytes[..bytes.len().min(512)];
    let text = String::from_utf8_lossy(head);
    let first = text
        .trim_start_matches('\u{feff}')
        .split('\n')
        .next()
        .unwrap_or("")
        .trim_end_matches('\r');
    let stripped = strip_tags(&strip_heading(first));
    stripped.trim().to_string()
}

fn strip_heading(s: &str) -> String {
    let t = s.trim_start();
    if !t.starts_with('#') {
        return t.to_string();
    }
    let hashes = t.chars().take_while(|c| *c == '#').count();
    if hashes > 6 {
        return t.to_string();
    }
    t[hashes..].trim_start().to_string()
}

/// 去掉行内 HTML 标签（对应 Electron 版的 replace(/<[^>]*>?/g, '')）
fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in s.chars() {
        match c {
            '<' => depth += 1,
            '>' => {
                if depth > 0 {
                    depth -= 1;
                }
            }
            _ => {
                if depth == 0 {
                    out.push(c);
                }
            }
        }
    }
    out
}

/// 渲染层传来的路径必须是笔记目录根层下的 .md，防止路径穿越
pub fn safe_page_path(store: &Store, p: &str) -> Option<PathBuf> {
    if p.is_empty() {
        return None;
    }
    let resolved = PathBuf::from(p);
    let resolved = if resolved.is_absolute() {
        resolved
    } else {
        std::env::current_dir().ok()?.join(resolved)
    };
    let root = store.notes_dir.clone();
    let name = resolved.file_name()?.to_string_lossy().to_string();
    if !name.to_ascii_lowercase().ends_with(".md") {
        return None;
    }
    // 必须在笔记根目录下且不能再有子目录
    if resolved.parent() != Some(root.as_path()) {
        return None;
    }
    Some(resolved)
}

pub fn new_file_path(store: &Store) -> PathBuf {
    let now = chrono::Local::now();
    let base = now.format("%Y-%m-%d_%H-%M-%S").to_string();
    let mut file = store.notes_dir.join(format!("{}.md", base));
    let mut i = 2;
    while file.exists() {
        file = store.notes_dir.join(format!("{}-{}.md", base, i));
        i += 1;
    }
    file
}

pub fn list_pages(store: &Store) -> Value {
    store.ensure_notes_dir();
    let state = store.load_state();
    let mut pages: Vec<Value> = Vec::new();
    if let Ok(entries) = fs::read_dir(&store.notes_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default();
            if !name.ends_with(".md") {
                continue;
            }
            let mtime = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let title = {
                let t = page_title(&path);
                if t.is_empty() {
                    path.file_stem()
                        .map(|s| s.to_string_lossy().to_string())
                        .unwrap_or_default()
                } else {
                    t
                }
            };
            pages.push(json!({
                "path": path.to_string_lossy(),
                "title": title,
                "mtime": mtime,
                // 侧栏每行显示用；太多会挤掉标题，取前 3 个
                "tags": crate::search::tags_of(&fs::read_to_string(&path).unwrap_or_default())
                    .into_iter()
                    .take(3)
                    .collect::<Vec<String>>()
            }));
        }
    }
    pages.sort_by(|a, b| {
        let am = a.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        let bm = b.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        bm.cmp(&am)
    });
    json!({
        "pages": pages,
        "current": state.get("file").cloned().unwrap_or(Value::Null)
    })
}

pub fn read_page(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

/// 删笔记一律走系统回收站，误删还能捞回来
pub fn trash_file(path: &Path) -> bool {
    match trash::delete(path) {
        Ok(_) => true,
        Err(err) => {
            eprintln!("[trash] 移入回收站失败，已跳过删除：{} {}", path.display(), err);
            false
        }
    }
}

/// 保存当前页。loaded_file 记录渲染层真正持有的是哪一页：
/// 只有它和 state.file 一致时，「内容为空」才代表用户清空了这一页；
/// 否则（例如刚启动还没 restore 就 flush）绝不能删文件 —— 那会误删用户的笔记。
pub fn write_current_page(
    store: &Store,
    loaded_file: &Option<String>,
    text: &str,
    caret: i64,
) -> Option<PathBuf> {
    let mut state = store.load_state();
    if text.trim().is_empty() {
        let file = state
            .get("file")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if let Some(file) = file {
            let is_loaded = loaded_file.as_deref() == Some(file.as_str());
            if is_loaded && Path::new(&file).exists() {
                trash_file(Path::new(&file));
                set_key(&mut state, "file", Value::Null);
                set_key(&mut state, "caret", json!(0));
                store.save_state(&state);
            }
        }
        return None;
    }

    store.ensure_notes_dir();
    let file = match state.get("file").and_then(|v| v.as_str()) {
        Some(f) if !f.is_empty() => PathBuf::from(f),
        _ => new_file_path(store),
    };
    if let Some(dir) = file.parent() {
        let _ = fs::create_dir_all(dir);
    }
    if fs::write(&file, text).is_err() {
        return None;
    }
    let key = file.to_string_lossy().to_string();
    let mut carets = state.get("carets").cloned().unwrap_or(json!({}));
    if carets.as_object().is_none() {
        carets = json!({});
    }
    set_key(&mut carets, &key, json!(caret.max(0)));
    set_key(&mut state, "carets", carets);
    set_key(&mut state, "file", json!(key));
    set_key(&mut state, "caret", json!(caret.max(0)));
    store.save_state(&state);
    Some(file)
}

/// 遍历根目录下所有 .md
pub fn each_note<F: FnMut(&PathBuf, &str, u64)>(store: &Store, mut f: F) {
    store.ensure_notes_dir();
    let entries = match fs::read_dir(&store.notes_dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default();
        if !name.ends_with(".md") {
            continue;
        }
        let text = match fs::read_to_string(&path) {
            Ok(t) => t,
            Err(_) => continue,
        };
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(now_ms());
        f(&path, &text, mtime);
    }
}

/// 图片落盘：assets/年-月-日_时-分-秒.png
pub fn save_image_bytes(store: &Store, bytes: &[u8], ext: &str) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("空图片".into());
    }
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("超过 25MB".into());
    }
    let assets = store.notes_dir.join("assets");
    fs::create_dir_all(&assets).map_err(|e| e.to_string())?;
    let base = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let ext = match ext.to_ascii_lowercase().as_str() {
        "png" => "png",
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        _ => "png",
    };
    let mut file = assets.join(format!("{}.{}", base, ext));
    let mut i = 2;
    while file.exists() {
        file = assets.join(format!("{}-{}.{}", base, i, ext));
        i += 1;
    }
    fs::write(&file, bytes).map_err(|e| e.to_string())?;
    Ok(format!("assets/{}", file.file_name().unwrap().to_string_lossy()))
}
