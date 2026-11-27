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
    for t in &w.trackers {
        if t.len() > 2048 {
            return Err("torrent.trackers entries are at most 2048 bytes.".into());
        }
        // The literal prefix too, so the parsed URL is the string the engine gets.
        let web = |u: &tauri::Url| {
            matches!(u.scheme(), "udp" | "http" | "https")
                && t.starts_with(&format!("{}://", u.scheme()))
        };
        let parsed = tauri::Url::parse(t).ok().filter(web);
        // udp isn't a special scheme, so its host is never normalized: judge every tracker's
        // host as an http URL's, the way the system resolver reads it (127.1, 2130706433 and
        // 0x7f.1 are all 127.0.0.1).
        let rest = t.split_once("://").map_or("", |(_, r)| r);
        let judged = parsed.and_then(|_| tauri::Url::parse(&format!("http://{rest}")).ok());
        let host = judged.as_ref().and_then(|u| u.host_str()).unwrap_or("");
        if host.is_empty() || !t.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(format!(
                "torrent.trackers takes udp, http and https trackers: {t:?}"
            ));
        }
        // Like a plugin's own requests (plugins.rs), a tracker never points at this computer or
        // the LAN. Every engine socket is also bound to the VPN tunnel.
        if crate::plugins::is_private(&host.to_ascii_lowercase()) {
            return Err(format!(
                "torrent.trackers can't point inside this network: {t:?}"
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

/// Deletes the least recently used torrent folders (40-hex names only) until the cache takes at
/// most `cap` bytes on disk, never one in `keep`. Returns what it deleted.
pub fn trim(cache: &Path, cap: u64, keep: &[String]) -> std::io::Result<Vec<PathBuf>> {
    let hex = |n: &str| n.len() == 40 && n.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    let mut dirs = vec![];
    // An entry that vanishes or can't be read while the trim runs is simply not counted.
    for e in std::fs::read_dir(cache)?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(meta) = e.metadata() else { continue };
        if !hex(&name) || !meta.is_dir() {
            continue;
        }
        let Ok(used) = meta.modified() else { continue };
        let size: u64 = walkdir::WalkDir::new(e.path())
            .into_iter()
            .filter_map(Result::ok)
            .filter_map(|f| f.metadata().ok())
            .filter(|m| m.is_file())
            .map(|m| on_disk(&m))
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
        // One folder that won't delete doesn't stop the trim; the next folder may.
        if let Err(e) = std::fs::remove_dir_all(&path) {
            eprintln!("torrent cache: can't delete {}: {e}", path.display());
            continue;
        }
        total -= size;
        gone.push(path);
    }
    Ok(gone)
}

/// The bytes a file takes on disk: a torrent's files are sparse until their pieces arrive.
fn on_disk(m: &std::fs::Metadata) -> u64 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        m.blocks() * 512
    }
    #[cfg(not(unix))]
    {
        m.len()
    }
}
