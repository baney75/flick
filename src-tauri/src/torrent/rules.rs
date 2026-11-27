// The torrent engine's checks, as pure functions: what a stream may ask for (rule 2), what a
// torrent may hold (rules 15 and 16), which file plays (rule 4), and the cache trim (rule 6).

#[cfg(test)]
pub mod tests;

use crate::torrent_http::media_type;
use serde::Deserialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

pub const MAX_INFO: usize = 10 << 20;
pub const MAX_FILES: usize = 10_000;
pub const MAX_PIECE: u32 = 16 << 20;
pub const MAX_TRACKERS: usize = 50;
pub const MAX_ACTIVE: usize = 3;
pub const MAX_PEERS: usize = 80;
pub const UPLOAD_BPS: u32 = 1_000_000;
pub const CACHE_CAP: u64 = 5 << 30;

pub const NO_PEERS: &str = "No one is sharing this torrent right now. Try another source.";
pub const WINDOWS_OFF: &str = "Torrents play on Windows through a debrid service for now";
pub const DROPPED: &str =
    "Your VPN dropped or isn't hiding you, so playback stopped. Reconnect it and press Play.";
pub const TOO_MANY: &str = "Flick plays up to 3 torrents at once. Stop one to start another.";

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

/// One part of a stored path: never empty, `.` or `..`, no separator, drive or stream colon, or
/// NUL, and at most 255 bytes.
fn safe_part(b: &[u8]) -> bool {
    let bad = |c: &u8| matches!(c, b'/' | b'\\' | b':' | 0);
    !b.is_empty() && b != b"." && b != b".." && b.len() <= 255 && !b.iter().any(bad)
}

/// Parses a .torrent and applies rules 15 and 16: every name stays inside the torrent's folder,
/// no symlinks, and the size limits.
pub fn vet(torrent: &[u8]) -> Result<Vetted, String> {
    if torrent.len() > MAX_INFO {
        return Err("This torrent's file list is over 10 MB, so Flick won't open it.".into());
    }
    let unreadable = |e: &dyn std::fmt::Display| format!("This torrent can't be read: {e}");
    let meta = librqbit::torrent_from_bytes(torrent).map_err(|e| unreadable(&e))?;
    let raw = &meta.info.data;
    if raw.piece_length > MAX_PIECE {
        return Err("This torrent's pieces are over 16 MB, so Flick won't open it.".into());
    }
    // librqbit's own check overflows on lengths its piece hashes don't cover, so these come first:
    // the lengths add up, and there is a 20-byte hash for every piece of that total. One spare
    // hash at the end is harmless when the length is a whole number of pieces (librqbit's own
    // torrents end with one then).
    let lens: Vec<u64> = match &raw.files {
        Some(files) => files.iter().map(|f| f.length).collect(),
        None => raw.length.into_iter().collect(),
    };
    let total = lens.iter().try_fold(0u64, |t, l| t.checked_add(*l));
    let hashes = raw.pieces.as_ref().len() as u64;
    let fits = total.is_some_and(|t| {
        let piece = u64::from(raw.piece_length);
        let spare = (hashes / 20).checked_sub(t.div_ceil(piece.max(1)));
        piece > 0
            && hashes.is_multiple_of(20)
            && (spare == Some(0) || (spare == Some(1) && t.is_multiple_of(piece)))
    });
    if !fits {
        return Err(unreadable(&"its file lengths don't match its pieces"));
    }
    let info = meta.info.data.validate().map_err(|e| unreadable(&e))?;
    if let Some(name) = &info.info().name {
        if !safe_part(name.as_ref()) {
            return Err(unsafe_name(name.as_ref()));
        }
    }
    let mut files = vec![];
    // Paths as a case-insensitive disk (APFS, NTFS) sees them, and the folders they need.
    let (mut paths, mut dirs) = (HashSet::new(), HashSet::new());
    for f in info.iter_file_details() {
        if files.len() == MAX_FILES {
            return Err("This torrent has over 10,000 files, so Flick won't open it.".into());
        }
        let parts: Vec<&[u8]> = f.filename.iter_components_bytes().collect();
        if let Some(bad) = parts.iter().find(|p| !safe_part(p)) {
            return Err(unsafe_name(bad));
        }
        let attrs = f.attrs();
        if !attrs.padding {
            let lower: Vec<String> = parts
                .iter()
                .map(|p| String::from_utf8_lossy(p).to_lowercase())
                .collect();
            for n in 1..lower.len() {
                dirs.insert(lower[..n].join("/"));
            }
            let path = lower.join("/");
            if !paths.insert(path) {
                return Err(unsafe_name(parts.last().copied().unwrap_or_default()));
            }
        }
        if attrs.symlink || f.symlink_path.is_some() {
            return Err(
                "This torrent holds a link to another file, so Flick won't open it.".into(),
            );
        }
        let name = parts
            .last()
            .map(|p| String::from_utf8_lossy(p).into_owned());
        let name = if attrs.padding {
            String::new()
        } else {
            name.unwrap_or_default()
        };
        files.push((name, f.len));
    }
    if paths.iter().any(|p| dirs.contains(p)) {
        return Err(
            "This torrent has a file where another needs a folder, so Flick won't open it.".into(),
        );
    }
    Ok(Vetted { files })
}

fn unsafe_name(b: &[u8]) -> String {
    let shown: String = String::from_utf8_lossy(b).chars().take(80).collect();
    format!("This torrent has a file name Flick won't write: {shown:?}")
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
