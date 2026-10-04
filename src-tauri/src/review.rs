// 每日回顾：按文件名里的创建日期挑一条旧笔记。
// 不用 mtime —— 改一下去年的笔记 mtime 就变新了，用它筛会让旧笔记「变年轻」。

use crate::notes::{each_note, page_title};
use crate::store::Store;
use chrono::{Datelike, Duration, Local, NaiveDate, NaiveDateTime, Timelike};
use serde_json::{json, Value};
use std::path::Path;

pub const REVIEW_MIN_DAYS_CHOICES: [i64; 5] = [1, 3, 7, 14, 30];
const REVIEW_COOLDOWN_DAYS: i64 = 30;
/// 凌晨 4 点前算前一天：速记用户常熬夜，半夜写的笔记不该立刻被踢出回顾池
const REVIEW_DAY_CUTOFF_HOUR: u32 = 4;

/// 文件名就是创建时间：YYYY-MM-DD_HH-mm-ss.md
pub fn note_created_at(name: &str) -> Option<NaiveDateTime> {
    if name.len() < 19 {
        return None;
    }
    NaiveDateTime::parse_from_str(&name[..19], "%Y-%m-%d_%H-%M-%S").ok()
}

pub fn logical_today() -> NaiveDate {
    let now = Local::now();
    let date = now.date_naive();
    if now.hour() < REVIEW_DAY_CUTOFF_HOUR {
        date - Duration::days(1)
    } else {
        date
    }
}

pub fn day_key(d: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", d.year(), d.month(), d.day())
}

fn month_distance(from: NaiveDate, to: NaiveDate) -> i64 {
    (to.year() as i64 - from.year() as i64) * 12 + (to.month() as i64 - from.month() as i64)
}

fn age_label(created: NaiveDate, today: NaiveDate, age_days: i64) -> String {
    let same_day = created.month() == today.month() && created.day() == today.day();
    let years = today.year() - created.year();
    if same_day && years >= 1 {
        return format!("{} 年前的今天", years);
    }
    let months = month_distance(created, today);
    if same_day && months >= 3 && months % 3 == 0 {
        return format!("{} 个月前的今天", months);
    }
    if age_days < 30 {
        return format!("{} 天前", age_days);
    }
    if months < 12 {
        return format!("{} 个月前", months);
    }
    format!("{} 年前", years)
}

/// 摘要只做纯文本：Markdown 渲染挂在编辑器内核上，脱离编辑器复用不了
fn excerpt(text: &str) -> String {
    let mut body = String::new();
    for raw in text.split('\n').skip(1) {
        if raw.trim_start().starts_with("```") {
            continue;
        }
        let line = strip_marks(raw);
        if line.trim().is_empty() {
            continue;
        }
        if !body.is_empty() {
            body.push('\n');
        }
        body.push_str(line.trim());
        if body.chars().count() > 220 {
            break;
        }
    }
    let out = body.trim().to_string();
    if !out.is_empty() {
        return out.chars().take(260).collect();
    }
    text.split('\n')
        .next()
        .unwrap_or("")
        .trim_start_matches('#')
        .trim()
        .chars()
        .take(80)
        .collect()
}

/// 剥掉常见的行内 Markdown 记号（标题 #、图片、链接、强调、引用）
fn strip_marks(raw: &str) -> String {
    let mut s = raw.trim_start();
    // 标题记号
    let hashes = s.chars().take_while(|c| *c == '#').count();
    if hashes > 0 && hashes <= 6 {
        let rest = &s[hashes..];
        if rest.starts_with(' ') {
            s = rest.trim_start();
        }
    }
    // 图片 ![alt](url) 整个去掉
    let mut out = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '!' && i + 1 < chars.len() && chars[i + 1] == '[' {
            if let Some(close) = find_seq(&chars, i + 1, "](") {
                if let Some(end) = find_char(&chars, close + 2, ')') {
                    i = end + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    // 链接 [文字](url) → 文字
    let mut linked = String::new();
    let chars: Vec<char> = out.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i] == '[' {
            if let Some(close) = find_char(&chars, i + 1, ']') {
                if close + 1 < chars.len() && chars[close + 1] == '(' {
                    if let Some(end) = find_char(&chars, close + 2, ')') {
                        linked.extend(chars[i + 1..close].iter());
                        i = end + 1;
                        continue;
                    }
                }
            }
        }
        linked.push(chars[i]);
        i += 1;
    }
    linked
        .chars()
        .filter(|c| !matches!(c, '*' | '_' | '`' | '>'))
        .collect()
}

fn find_char(chars: &[char], from: usize, target: char) -> Option<usize> {
    (from..chars.len()).find(|i| chars[*i] == target)
}
fn find_seq(chars: &[char], from: usize, seq: &str) -> Option<usize> {
    let want: Vec<char> = seq.chars().collect();
    (from..chars.len()).find(|i| i + want.len() <= chars.len() && chars[*i..*i + want.len()] == want[..])
}

pub fn pick_review_note(store: &Store, exclude: &[String]) -> Option<Value> {
    let today = logical_today();
    let reviews = store.load_reviews();
    let reviewed = reviews.get("notes").cloned().unwrap_or(json!({}));
    let min_days = {
        let v = store.setting_i64("reviewMinDays", 7);
        if REVIEW_MIN_DAYS_CHOICES.contains(&v) {
            v
        } else {
            7
        }
    };
    let now_ms = Local::now().timestamp_millis();

    struct Cand {
        file: String,
        text: String,
        created: NaiveDate,
        age_days: i64,
    }
    let mut pool: Vec<Cand> = Vec::new();
    each_note(store, |file, text, _mtime| {
        let name = file.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
        let created = match note_created_at(&name) {
            Some(d) => d.date(),
            None => return,
        };
        let age_days = (today - created).num_days();
        if age_days < min_days {
            return;
        }
        pool.push(Cand {
            file: file.to_string_lossy().to_string(),
            text: text.to_string(),
            created,
            age_days,
        });
    });
    if pool.is_empty() {
        return None;
    }

    let excluded: std::collections::HashSet<String> = exclude
        .iter()
        .map(|f| {
            Path::new(f)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| f.clone())
        })
        .collect();

    // 分档：往年同月同日 > 3/6/9 个月前的今天 > 很久没回顾过的 > 全部
    let same_day_past: Vec<&Cand> = pool
        .iter()
        .filter(|c| {
            c.created.month() == today.month()
                && c.created.day() == today.day()
                && c.created.year() < today.year()
        })
        .collect();
    let quarter_past: Vec<&Cand> = pool
        .iter()
        .filter(|c| {
            let m = month_distance(c.created, today);
            c.created.day() == today.day() && m >= 3 && m % 3 == 0 && c.created.year() == today.year()
        })
        .collect();
    let not_recent: Vec<&Cand> = pool
        .iter()
        .filter(|c| {
            let name = Path::new(&c.file)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            match reviewed.get(&name).and_then(|v| v.as_i64()) {
                Some(at) if at > 0 => now_ms - at > REVIEW_COOLDOWN_DAYS * 86_400_000,
                _ => true,
            }
        })
        .collect();

    let all: Vec<&Cand> = pool.iter().collect();
    let tiers: [&Vec<&Cand>; 4] = [&same_day_past, &quarter_past, &not_recent, &all];
    let seed = (today.num_days_from_ce() as usize).max(0);
    let mut picked: Option<&Cand> = None;
    for tier in tiers.iter() {
        if tier.is_empty() {
            continue;
        }
        let start = seed % tier.len();
        for i in 0..tier.len() {
            let cand = tier[(start + i) % tier.len()];
            let name = Path::new(&cand.file)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default();
            if !excluded.contains(&name) {
                picked = Some(cand);
                break;
            }
        }
        if picked.is_some() {
            break;
        }
    }
    let picked = picked?;
    let picked_path = Path::new(&picked.file);
    let title = {
        let t = page_title(picked_path);
        if t.is_empty() {
            picked_path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            t
        }
    };

    Some(json!({
        "file": picked.file,
        "title": title,
        "excerpt": excerpt(&picked.text),
        "label": age_label(picked.created, today, picked.age_days),
        "ageDays": picked.age_days,
        "date": day_key(picked.created)
    }))
}

/// 每天只自动推一次；没有可回顾的内容时不消耗当天名额
pub fn maybe_auto_review(store: &Store) -> Option<Value> {
    let mode = store.setting_str("reviewMode");
    if mode == "off" {
        return None;
    }
    let today = logical_today();
    let mut reviews = store.load_reviews();
    if mode == "daily" {
        let last = reviews.get("lastShown").and_then(|v| v.as_str()).unwrap_or("");
        if last == day_key(today) {
            return None;
        }
    }
    let note = pick_review_note(store, &[])?;
    let mut notes = reviews.get("notes").cloned().unwrap_or(json!({}));
    if let Some(file) = note.get("file").and_then(|v| v.as_str()) {
        let name = Path::new(file)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file.to_string());
        crate::notes::set_key(&mut notes, &name, json!(Local::now().timestamp_millis()));
    }
    crate::notes::set_key(&mut reviews, "notes", notes);
    crate::notes::set_key(&mut reviews, "lastShown", json!(day_key(today)));
    store.save_reviews(&reviews);
    Some(note)
}

/// 记一笔「已回顾」，避免很快又推同一篇
pub fn dismiss_review(store: &Store, file: &str) {
    let name = Path::new(file)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| file.to_string());
    let mut reviews = store.load_reviews();
    let mut notes = reviews.get("notes").cloned().unwrap_or(json!({}));
    crate::notes::set_key(&mut notes, &name, json!(Local::now().timestamp_millis()));
    crate::notes::set_key(&mut reviews, "notes", notes);
    store.save_reviews(&reviews);
}
