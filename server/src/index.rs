//! Library index: walks the shared roots and lists playable files.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_ITEMS: usize = 200_000;

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

pub fn scan(roots: &[PathBuf]) -> Index {
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
            if idx.items.len() >= MAX_ITEMS {
                return idx;
            }
            let Ok(e) = e else { continue };
            if !e.file_type().is_file() {
                continue;
            }
            if let Some(item) = make_item(root, &folder, e.path()) {
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
        abs: abs.to_path_buf(),
    })
}
