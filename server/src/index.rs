//! Library index: walks the shared roots and lists playable files.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_ITEMS: usize = 200_000;
/// Photos have a cap of their own, so a big camera roll never pushes videos, music or books out.
pub const MAX_PHOTOS: usize = 200_000;

#[derive(Clone, Debug, Serialize)]
pub struct Item {
    pub id: String,
    pub folder: String,
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub ext: String,
    pub size: u64,
    pub mtime: u64,
    /// Photos only: when the picture was taken, from EXIF DateTimeOriginal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taken: Option<String>,
    /// Whether `taken` was looked for, so a quick scan's empty date is not reused as "no date".
    #[serde(skip)]
    pub dated: bool,
    #[serde(skip)]
    pub abs: PathBuf,
}

#[derive(Default)]
pub struct Index {
    pub folders: Vec<String>,
    pub items: Vec<Item>,
    by_id: HashMap<String, usize>,
}

impl Index {
    pub fn get(&self, id: &str) -> Option<&Item> {
        self.by_id.get(id).map(|&i| &self.items[i])
    }
}

pub fn kind(ext: &str) -> Option<&'static str> {
    match ext {
        "mp4" | "m4v" | "mov" | "mkv" | "webm" | "avi" | "ts" | "m2ts" | "wmv" | "flv" | "mpg"
        | "mpeg" | "3gp" | "ogv" => Some("video"),
        "mp3" | "m4a" | "m4b" | "aac" | "flac" | "wav" | "ogg" | "oga" | "opus" | "alac"
        | "aiff" | "wma" => Some("audio"),
        "pdf" | "epub" => Some("book"),
        "jpg" | "jpeg" | "png" | "heic" | "heif" | "webp" | "gif" | "avif" => Some("photo"),
        _ => None,
    }
}

pub fn content_type(ext: &str) -> &'static str {
    match ext {
        "mp4" | "m4v" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" | "m4b" | "aac" | "alac" => "audio/mp4",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "epub" => "application/epub+zip",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// First 16 hex chars of SHA-256 of `<folder>/<path>`.
pub fn item_id(folder: &str, path: &str) -> String {
    let d = Sha256::digest(format!("{folder}/{path}").as_bytes());
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Labels for the roots: the directory name, with ` 2`, ` 3` on duplicates.
pub fn labels(roots: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in roots {
        let base = r
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| r.to_string_lossy().into_owned());
        let mut label = base.clone();
        let mut n = 2;
        while out.contains(&label) {
            label = format!("{base} {n}");
            n += 1;
        }
        out.push(label);
    }
    out
}

fn hidden(name: &std::ffi::OsStr) -> bool {
    name.to_string_lossy().starts_with('.')
}

/// How many items a scan keeps: `media` for video, audio and books, `photos` for photos.
#[derive(Clone, Copy, Debug)]
pub struct Caps {
    pub media: usize,
    pub photos: usize,
}

impl Default for Caps {
    fn default() -> Self {
        Caps {
            media: MAX_ITEMS,
            photos: MAX_PHOTOS,
        }
    }
}

pub fn scan(roots: &[PathBuf]) -> Index {
    scan_with(roots, None, true)
}

/// Scans, reusing `prev`'s capture dates for photos whose size and mtime have not changed.
/// With `dates` off, photos it has no date for are left undated and nothing is opened.
pub fn scan_with(roots: &[PathBuf], prev: Option<&Index>, dates: bool) -> Index {
    scan_capped(roots, prev, dates, Caps::default())
}

pub fn scan_capped(roots: &[PathBuf], prev: Option<&Index>, dates: bool, caps: Caps) -> Index {
    let (mut media, mut photos) = (0, 0);
    let mut idx = Index {
        folders: labels(roots),
        ..Default::default()
    };
    for (root, folder) in roots.iter().zip(idx.folders.clone()) {
        let walk = walkdir::WalkDir::new(root)
            .follow_links(false)
            .sort_by_file_name();
        for e in walk
            .into_iter()
            .filter_entry(|e| e.depth() == 0 || !hidden(e.file_name()))
        {
            if media >= caps.media && photos >= caps.photos {
                return idx;
            }
            let Ok(e) = e else { continue };
            if !e.file_type().is_file() {
                continue;
            }
            if let Some(mut item) = make_item(root, &folder, e.path()) {
                let count = if item.kind == "photo" {
                    (&mut photos, caps.photos)
                } else {
                    (&mut media, caps.media)
                };
                if *count.0 >= count.1 {
                    continue;
                }
                *count.0 += 1;
                if item.kind == "photo" {
                    match prev.and_then(|p| p.get(&item.id)) {
                        Some(old)
                            if old.size == item.size
                                && old.mtime == item.mtime
                                && (old.dated || !dates) =>
                        {
                            item.taken = old.taken.clone();
                            item.dated = old.dated;
                        }
                        _ if dates => {
                            item.taken = taken(&item.abs);
                            item.dated = true;
                        }
                        _ => {}
                    }
                }
                idx.by_id.insert(item.id.clone(), idx.items.len());
                idx.items.push(item);
            }
        }
    }
    idx
}

fn make_item(root: &Path, folder: &str, abs: &Path) -> Option<Item> {
    let ext = abs.extension()?.to_string_lossy().to_lowercase();
    let kind = kind(&ext)?;
    let rel = abs.strip_prefix(root).ok()?;
    let path: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let path = path.join("/");
    let meta = std::fs::metadata(abs).ok()?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok());
    Some(Item {
        id: item_id(folder, &path),
        folder: folder.to_string(),
        name: abs.file_name()?.to_string_lossy().into_owned(),
        path,
        kind,
        ext,
        size: meta.len(),
        mtime: mtime.map_or(0, |d| d.as_millis() as u64),
        taken: None,
        dated: false,
        abs: abs.to_path_buf(),
    })
}

/// EXIF DateTimeOriginal as `YYYY-MM-DDTHH:MM:SS`: the camera's wall clock, with no time zone.
/// Reads only the metadata at the start of the file, so it stays cheap.
pub fn taken(abs: &Path) -> Option<String> {
    let file = std::fs::File::open(abs).ok()?;
    let exif = exif::Reader::new()
        .read_from_container(&mut std::io::BufReader::new(file))
        .ok()?;
    let field = exif.get_field(exif::Tag::DateTimeOriginal, exif::In::PRIMARY)?;
    let exif::Value::Ascii(ref v) = field.value else {
        return None;
    };
    let d = exif::DateTime::from_ascii(v.first()?).ok()?;
    // Cameras with no clock set write zeros.
    let date_ok = d.year >= 1900 && (1..=12).contains(&d.month) && (1..=31).contains(&d.day);
    if !date_ok || d.hour > 23 || d.minute > 59 || d.second > 60 {
        return None;
    }
    Some(format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        d.year, d.month, d.day, d.hour, d.minute, d.second
    ))
}
