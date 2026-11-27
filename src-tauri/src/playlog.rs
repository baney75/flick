//! The playback log (SPEC-playback-2 rules 7 and 8): one JSON line per playback event in the app's log
//! folder (`~/Library/Logs/com.dbaney.flick/playback.log`), rotated at 1 MB with one old file kept.
//! Every string is scrubbed before it is written: a debrid URL carries its key in the path and its
//! token in the query, so a URL keeps only its host and file type, and a file path only its type.
//! Nothing leaves the Mac; Settings copies the last 200 lines for Donovan to paste.

use serde_json::{Map, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::SystemTime;

pub const LIMIT: u64 = 1_000_000;
pub const TAIL: usize = 200;
const NAME: &str = "playback.log";
const OLD: &str = "playback.log.1";
/// A longer string is cut: one line stays one event, not a dump.
const LONGEST: usize = 400;
/// What may follow a URL or path in a sentence.
const TRAIL: [char; 7] = [':', ',', ';', ')', ']', '"', '.'];

static DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITE: Mutex<()> = Mutex::new(());

/// Points the log at the app's log folder; the first call wins.
pub fn init(dir: PathBuf) {
    let _ = DIR.set(dir);
}

/// The file type a path names (`mkv`), when its last part has a short extension.
fn ext(path: &str) -> Option<String> {
    let last = path.rsplit('/').next()?;
    let (_, e) = last.rsplit_once('.')?;
    let ok = !e.is_empty() && e.len() <= 5 && e.chars().all(|c| c.is_ascii_alphanumeric());
    ok.then(|| e.to_ascii_lowercase())
}

/// A URL as the log keeps it: its host, then its file type (`x.example .mkv`).
fn url_shape(u: &str) -> String {
    let rest = u.split_once("://").map_or(u, |(_, r)| r);
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let host = rest[..end].rsplit('@').next().unwrap_or("");
    let path = rest[end..].split(['?', '#']).next().unwrap_or("");
    let host = if host.is_empty() { "[file]" } else { host };
    match ext(path) {
        Some(e) => format!("{host} .{e}"),
        None => host.to_string(),
    }
}

/// A word that names a file: absolute, home or file: paths, and pieces of a path a space split.
/// A content type (`video/mp4`) or a ratio (`16/9`) is not one.
fn is_path(w: &str) -> bool {
    let w = w.trim_start_matches(['"', '\'', '(', '[', '<']);
    w.starts_with('/')
        || w.starts_with("~/")
        || w.starts_with("file:")
        || w.matches('/').count() >= 2
        || (w.contains('/') && ext(w).is_some())
}

/// `s` with every URL cut to its host and type, every path to its type, and any header value dropped.
pub fn scrub(s: &str) -> String {
    let mut out: Vec<String> = Vec::new();
    let mut words = s.split_whitespace();
    while let Some(w) = words.next() {
        let lower = w.to_ascii_lowercase();
        if ["authorization:", "cookie:", "set-cookie:", "proxy-authorization:"].contains(&lower.as_str()) {
            out.push(format!("{w} [header]"));
            break;
        }
        if let Some(i) = w.find("://") {
            let start = w[..i].rfind(|c: char| !c.is_ascii_alphanumeric()).map_or(0, |j| j + 1);
            let tail = if w.ends_with(':') { ":" } else { "" };
            let url = w[start..].trim_end_matches(TRAIL);
            out.push(format!("{}{}{tail}", &w[..start], url_shape(url)));
        } else if let Some((who, at)) = w.split_once('@').filter(|(who, _)| who.contains(':')) {
            // A login without a scheme (`user:pass@host`) keeps only the host.
            let lead = who.len() - who.trim_start_matches(['"', '\'', '(', '[', '<']).len();
            out.push(format!("{}{at}", &w[..lead]));
        } else if is_path(w) {
            // A path with spaces runs on to the word that ends it: the first with a file type, else the
            // first ending in a colon or period (`Dr. Strangelove.mkv` ends at the second), else the end.
            let rest: Vec<&str> = std::iter::once(w).chain(words.clone()).collect();
            let typed = rest.iter().position(|w| ext(w.trim_end_matches(TRAIL)).is_some());
            let stop = rest.iter().position(|w| w.ends_with([':', '.']));
            let end = typed.or(stop).unwrap_or(rest.len() - 1);
            let last = rest[end];
            for _ in 0..end {
                words.next();
            }
            let tail = if last.ends_with(':') { ":" } else if last.ends_with('.') { "." } else { "" };
            out.push(match ext(last.trim_end_matches(TRAIL)) {
                Some(e) => format!("[file] .{e}{tail}"),
                None => format!("[file]{tail}"),
            });
        } else {
            out.push(w.to_string());
        }
    }
    let mut s = out.join(" ");
    if s.len() > LONGEST {
        let mut cut = LONGEST;
        while !s.is_char_boundary(cut) {
            cut -= 1;
        }
        s.truncate(cut);
    }
    s
}

fn scrub_value(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(scrub(&s)),
        Value::Array(a) => Value::Array(a.into_iter().map(scrub_value).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, scrub_value(v))).collect()),
        v => v,
    }
}

/// The JSON line for `event`: the time, the event name, then the scrubbed fields.
pub fn line(event: &str, fields: Map<String, Value>) -> String {
    let ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let name: String = event
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(32)
        .collect();
    let mut o = Map::new();
    o.insert("t".into(), ms.into());
    o.insert("event".into(), name.into());
    for (k, v) in fields {
        if k != "t" && k != "event" {
            o.insert(k, scrub_value(v));
        }
    }
    Value::Object(o).to_string()
}

/// Appends one line to `dir`'s log, first moving a log of `limit` bytes or more to the one old file.
pub fn append_to(dir: &Path, limit: u64, event: &str, fields: Map<String, Value>) -> std::io::Result<()> {
    let _one = WRITE.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::create_dir_all(dir)?;
    let p = dir.join(NAME);
    if std::fs::metadata(&p).is_ok_and(|m| m.len() >= limit) {
        std::fs::rename(&p, dir.join(OLD))?;
    }
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&p)?;
    writeln!(f, "{}", line(event, fields))
}

/// The last `n` lines of `dir`'s log, the old file's first.
pub fn tail_of(dir: &Path, n: usize) -> String {
    let read = |name: &str| std::fs::read_to_string(dir.join(name)).unwrap_or_default();
    let (old, now) = (read(OLD), read(NAME));
    let all: Vec<&str> = old.lines().chain(now.lines()).filter(|l| !l.is_empty()).collect();
    all[all.len().saturating_sub(n)..].join("\n")
}

/// Logs `event` when the app has a log folder; a failed write never touches playback.
pub fn note(event: &str, fields: Map<String, Value>) {
    if let Some(dir) = DIR.get() {
        let _ = append_to(dir, LIMIT, event, fields);
    }
}

#[tauri::command]
pub fn playback_log(event: String, fields: Option<Map<String, Value>>) {
    note(&event, fields.unwrap_or_default());
}

#[tauri::command]
pub fn playback_log_tail() -> String {
    DIR.get().map(|d| tail_of(d, TAIL)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fields(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flick-playlog-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    // Case 13: a debrid URL keeps its host and type; its key, path and token never reach the log.
    #[test]
    fn a_debrid_url_keeps_only_its_host_and_type() {
        let url = "https://x.example/resolve/realdebrid/SECRETKEY/abc/file.mkv?token=T0K";
        let dir = scratch("case13");
        let f = fields(json!({ "source": url, "error": format!("{url}: Server returned 404 Not Found") }));
        append_to(&dir, LIMIT, "play_start", f).unwrap();
        let l = tail_of(&dir, TAIL);
        assert!(l.contains("x.example") && l.contains("mkv"), "{l}");
        for no in ["SECRETKEY", "abc", "T0K", "token", "resolve", "realdebrid"] {
            assert!(!l.contains(no), "{no} in {l}");
        }
        assert!(l.contains("Server returned 404 Not Found"), "{l}");
        let v: Value = serde_json::from_str(&l).unwrap();
        assert_eq!(v["event"], "play_start");
        assert!(v["t"].as_u64().unwrap() > 0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_path_keeps_only_its_type_and_a_header_drops_its_value() {
        let s = scrub("Error opening input file /Users/someone/Movies/My Film (2024).mkv: No such file");
        assert_eq!(s, "Error opening input file [file] .mkv: No such file");
        assert_eq!(scrub("/Volumes/Disk/A Show/: Permission denied"), "[file]: Permission denied");
        assert_eq!(scrub("Error opening input file /tmp/My Film.mkv."), "Error opening input file [file] .mkv.");
        assert_eq!(scrub("No access to /Volumes/Disk/A Show. Try again"), "No access to [file]. Try again");
        assert_eq!(
            scrub("Error opening input file /Users/me/Movies/Dr. Strangelove (1964).mkv: No such file"),
            "Error opening input file [file] .mkv: No such file"
        );
        let s = scrub("bad header Authorization: Basic dXNlcjpwYXNz");
        assert!(!s.contains("dXNlcjpwYXNz") && !s.contains("Basic"), "{s}");
        assert_eq!(scrub("[http @ 0x1] user:pass@h.example"), "[http @ 0x1] h.example");
        assert_eq!(scrub("http://user:pw@h.example:8080/a/b"), "h.example:8080");
        assert_eq!(scrub("file:///Volumes/Disk/x.MP4"), "[file] .mp4");
        // Content types, ratios and ffmpeg's own words stay.
        assert_eq!(scrub("video/mp4 16/9 h264 (High)"), "video/mp4 16/9 h264 (High)");
        assert_eq!(scrub("application/vnd.apple.mpegurl"), "application/vnd.apple.mpegurl");
    }

    #[test]
    fn the_log_rotates_keeping_one_old_file_and_the_tail_spans_both() {
        let dir = scratch("rotate");
        for i in 0..30 {
            append_to(&dir, 400, "stall", fields(json!({ "n": i }))).unwrap();
        }
        assert!(std::fs::metadata(dir.join(NAME)).unwrap().len() < 400 + 80);
        assert!(dir.join(OLD).exists() && !dir.join("playback.log.2").exists());
        let t = tail_of(&dir, 5);
        let n: Vec<u64> = t
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["n"].as_u64().unwrap())
            .collect();
        assert_eq!(n, vec![25, 26, 27, 28, 29]);
        // The tail reaches into the old file when the new one is short.
        let all = tail_of(&dir, TAIL);
        assert!(all.lines().count() > std::fs::read_to_string(dir.join(NAME)).unwrap().lines().count());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_tail_is_the_last_200_lines() {
        let dir = scratch("tail");
        for i in 0..250 {
            append_to(&dir, LIMIT, "probe", fields(json!({ "n": i }))).unwrap();
        }
        let t = tail_of(&dir, TAIL);
        assert_eq!(t.lines().count(), 200);
        assert!(t.lines().next().unwrap().contains("\"n\":50"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
