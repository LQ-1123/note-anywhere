// 全文搜索与 #标签：直接扫本地 .md，不建索引。
// 关键：offset 必须按 UTF-16 码元计算 —— CodeMirror 的光标位置是 JS 字符串下标，
// 中文一个字 3 字节但只占 1 个码元，用字节偏移会把光标定位错地方。

use crate::notes::{each_note, page_title};
use crate::store::Store;
use serde_json::{json, Value};
use std::collections::HashMap;

const MAX_HITS_PER_NOTE: usize = 4;
const MAX_RESULTS: usize = 60;

pub fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

pub fn search_notes(store: &Store, query: &str) -> Value {
    let q = query.trim();
    if q.is_empty() {
        return json!({ "ok": true, "results": [] });
    }
    let terms: Vec<String> = q
        .to_lowercase()
        .split_whitespace()
        .map(|s| s.to_string())
        .collect();

    let mut results: Vec<Value> = Vec::new();
    each_note(store, |file, text, mtime| {
        if results.len() >= MAX_RESULTS {
            return;
        }
        let mut hits: Vec<Value> = Vec::new();
        let mut offset: usize = 0; // UTF-16 码元偏移
        for (i, line) in text.split('\n').enumerate() {
            let hay = line.to_lowercase();
            if terms.iter().all(|t| hay.contains(t.as_str())) {
                let col_byte = terms
                    .first()
                    .and_then(|t| hay.find(t.as_str()))
                    .unwrap_or(0);
                let col_units = utf16_len(&hay[..col_byte.min(hay.len())]);
                let snippet: String = line.chars().take(400).collect();
                hits.push(json!({
                    "line": i + 1,
                    "text": snippet,
                    "col": col_units,
                    "offset": offset + col_units
                }));
                if hits.len() >= MAX_HITS_PER_NOTE {
                    break;
                }
            }
            offset += utf16_len(line) + 1; // +1 = 换行符
        }
        if !hits.is_empty() {
            results.push(json!({
                "file": file.to_string_lossy(),
                "title": page_title(file),
                "mtime": mtime,
                "hits": hits
            }));
        }
    });
    results.sort_by(|a, b| {
        let am = a.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        let bm = b.get("mtime").and_then(|v| v.as_u64()).unwrap_or(0);
        bm.cmp(&am)
    });
    results.truncate(MAX_RESULTS);
    json!({ "ok": true, "results": results, "query": q })
}

// ---------- #标签 ----------

fn is_tag_start(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_'
}
fn is_tag_char(c: char) -> bool {
    c.is_alphabetic() || c.is_numeric() || c == '_' || c == '/' || c == '-'
}
/// 纯十六进制且长度为 3/4/6/8 的按颜色值排除（#fff / #ffffff / #333）
fn is_color_tag(tag: &str) -> bool {
    tag.chars().all(|c| c.is_ascii_hexdigit()) && matches!(tag.len(), 3 | 4 | 6 | 8)
}

fn scan_line_tags(line: &str, out: &mut HashMap<String, i64>) {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '#' {
            let at_boundary = i == 0 || chars[i - 1].is_whitespace();
            if at_boundary && i + 1 < chars.len() && is_tag_start(chars[i + 1]) {
                let mut j = i + 1;
                while j < chars.len() && is_tag_char(chars[j]) {
                    j += 1;
                }
                let tag: String = chars[i + 1..j].iter().collect();
                if !is_color_tag(&tag) {
                    *out.entry(tag).or_insert(0) += 1;
                }
                i = j;
                continue;
            }
        }
        i += 1;
    }
}

pub fn list_tags(store: &Store) -> Value {
    let mut counts: HashMap<String, i64> = HashMap::new();
    each_note(store, |_file, text, _mtime| {
        let mut in_fence = false;
        for line in text.split('\n') {
            if line.trim_start().starts_with("```") {
                in_fence = !in_fence;
                continue;
            }
            if in_fence {
                continue;
            }
            scan_line_tags(line, &mut counts);
        }
    });
    let mut tags: Vec<(String, i64)> = counts.into_iter().collect();
    tags.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    let list: Vec<Value> = tags
        .into_iter()
        .map(|(tag, count)| json!({ "tag": tag, "count": count }))
        .collect();
    json!({ "ok": true, "tags": list })
}
