// The torrent engine's checks, as pure functions: what a stream may ask for (rule 2), which file
// plays (rule 4), and the cache trim (rule 6).

#[cfg(test)]
pub mod tests;

use crate::torrent_http::media_type;
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const MAX_TRACKERS: usize = 50;

/// A torrent stream from a plugin: `{ infoHash, fileIdx?, trackers? }`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Want {
    pub info_hash: String,
    pub file_idx: Option<usize>,
    #[serde(default)]
    pub trackers: Vec<String>,
}

/// The info hash in lowercase and the trackers, or what is wrong with them.
pub fn check_want(w: &Want) -> Result<(String, Vec<String>), String> {
    let hash = w.info_hash.to_ascii_lowercase();
    if hash.len() != 40 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("torrent.infoHash must be 40 hex characters.".into());
    }
    if w.trackers.len() > MAX_TRACKERS {
        return Err(format!(
            "torrent.trackers holds at most {MAX_TRACKERS} trackers."
        ));
    }
    let schemes = ["udp://", "http://", "https://"];
    for t in &w.trackers {
        let plain = t.len() <= 2048 && t.bytes().all(|b| b.is_ascii_graphic());
        if !plain
            || !schemes
                .iter()
                .any(|s| t.starts_with(s) && t.len() > s.len())
        {
            return Err(format!(
                "torrent.trackers takes udp, http and https trackers: {t:?}"
            ));
        }
    }
    Ok((hash, w.trackers.clone()))
}

/// The magnet link for a checked hash and trackers.
pub fn magnet(hash: &str, trackers: &[String]) -> String {
    use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
    let mut m = format!("magnet:?xt=urn:btih:{hash}");
    for t in trackers {
        m.push_str("&tr=");
        m.extend(utf8_percent_encode(t, NON_ALPHANUMERIC));
    }
    m
}

/// A torrent's files after the checks: each file's name (its last path part) and length.
#[derive(Debug, PartialEq, Eq)]
pub struct Vetted {
    pub files: Vec<(String, u64)>,
}

/// The file to play: `file_idx` when given, which must be video or audio, else the largest video.
pub fn pick_file(v: &Vetted, file_idx: Option<usize>) -> Result<usize, String> {
    let media = |i: usize| media_type(&v.files[i].0).is_some();
    if let Some(i) = file_idx {
        if i >= v.files.len() {
            return Err(format!("This torrent has no file {i}."));
        }
        if !media(i) {
            return Err("This stream's file isn't a video or audio file.".into());
        }
        return Ok(i);
    }
    let video = |i: &usize| media_type(&v.files[*i].0).is_some_and(|t| t.starts_with("video/"));
    (0..v.files.len())
        .filter(video)
        .max_by_key(|i| v.files[*i].1)
        .ok_or_else(|| "This torrent has no video file.".to_string())
}

/// Marks a torrent's cache folder as just used, for the oldest-first trim.
pub fn touch(dir: &Path) -> std::io::Result<()> {
    std::fs::File::open(dir)?.set_modified(SystemTime::now())
}

/// Deletes the least recently used torrent folders (40-hex names only) until the cache holds at
/// most `cap` bytes, never one in `keep`. Returns what it deleted.
pub fn trim(cache: &Path, cap: u64, keep: &[String]) -> std::io::Result<Vec<PathBuf>> {
    let hex = |n: &str| n.len() == 40 && n.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let mut dirs = vec![];
    for e in std::fs::read_dir(cache)? {
        let e = e?;
        let name = e.file_name().to_string_lossy().into_owned();
        if !hex(&name) || !e.file_type()?.is_dir() {
            continue;
        }
        let used = e.metadata()?.modified()?;
        let size: u64 = walkdir::WalkDir::new(e.path())
            .into_iter()
            .filter_map(Result::ok)
            .filter_map(|f| f.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| m.len())
            .sum();
        dirs.push((used, size, name, e.path()));
    }
    dirs.sort();
    let mut total: u64 = dirs.iter().map(|d| d.1).sum();
    let mut gone = vec![];
    for (_, size, name, path) in dirs {
        if total <= cap {
            break;
        }
        if keep.contains(&name) {
            continue;
        }
        std::fs::remove_dir_all(&path)?;
        total -= size;
        gone.push(path);
    }
    Ok(gone)
}
