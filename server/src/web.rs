//! Serves the Flick web app from a folder or from the copy built in with the `embed-web` feature.
use std::fs::File;
#[cfg(feature = "embed-web")]
use std::io::Cursor;
use std::io::Read;
use std::path::PathBuf;

#[cfg(feature = "embed-web")]
static DIST: include_dir::Dir = include_dir::include_dir!("$CARGO_MANIFEST_DIR/../dist");

pub(crate) enum Web {
    #[cfg(not(feature = "embed-web"))]
    None,
    Dir(PathBuf),
    #[cfg(feature = "embed-web")]
    Embedded,
}

pub(crate) struct Asset {
    pub body: Box<dyn Read + Send>,
    pub len: usize,
    pub content_type: &'static str,
    pub cache: &'static str,
}

impl Web {
    /// `dir` wins; without it the embedded copy is used when the feature is on.
    pub fn new(dir: Option<PathBuf>) -> Web {
        match dir {
            Some(d) => Web::Dir(std::fs::canonicalize(&d).unwrap_or(d)),
            #[cfg(feature = "embed-web")]
            None => Web::Embedded,
            #[cfg(not(feature = "embed-web"))]
            None => Web::None,
        }
    }

    pub fn available(&self) -> bool {
        self.open("index.html").is_some()
    }

    /// `Err(())` for a path that tries to leave the web dir; `Ok(None)` when there is no app.
    pub fn get(&self, url_path: &str) -> Result<Option<Asset>, ()> {
        let rel = safe_path(url_path).ok_or(())?;
        let rel = if rel.is_empty() {
            "index.html".to_string()
        } else {
            rel
        };
        Ok(self
            .open(&rel)
            .map(|a| with_meta(a, &rel))
            .or_else(|| self.open("index.html").map(|a| with_meta(a, "index.html"))))
    }

    fn open(&self, rel: &str) -> Option<(Box<dyn Read + Send>, usize)> {
        match self {
            #[cfg(not(feature = "embed-web"))]
            Web::None => None,
            Web::Dir(root) => {
                let p = std::fs::canonicalize(root.join(rel)).ok()?;
                if !p.starts_with(root) || !p.is_file() {
                    return None;
                }
                let f = File::open(&p).ok()?;
                let len = f.metadata().ok()?.len() as usize;
                Some((Box::new(f), len))
            }
            #[cfg(feature = "embed-web")]
            Web::Embedded => {
                let f = DIST.get_file(rel)?;
                Some((Box::new(Cursor::new(f.contents())), f.contents().len()))
            }
        }
    }
}

fn with_meta((body, len): (Box<dyn Read + Send>, usize), rel: &str) -> Asset {
    let cache = if rel.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    Asset {
        body,
        len,
        content_type: web_type(rel),
        cache,
    }
}

/// Percent-decodes a URL path and returns it relative to the web root, or `None` if any segment
/// is `.`, `..`, holds a backslash, colon or NUL, or the path is not UTF-8.
pub fn safe_path(url_path: &str) -> Option<String> {
    let raw = url_path.as_bytes();
    let mut bytes = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'%' {
            let hex = std::str::from_utf8(raw.get(i + 1..i + 3)?).ok()?;
            bytes.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            bytes.push(raw[i]);
            i += 1;
        }
    }
    let path = String::from_utf8(bytes).ok()?;
    let mut segs = vec![];
    for s in path.split('/').filter(|s| !s.is_empty()) {
        if s == "." || s == ".." || s.contains(['\\', ':', '\0']) {
            return None;
        }
        segs.push(s);
    }
    Some(segs.join("/"))
}

pub fn web_type(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map_or("", |(_, e)| e);
    match ext.to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "webp" => "image/webp",
        "woff2" => "font/woff2",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "ico" => "image/x-icon",
        "txt" => "text/plain; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        _ => "application/octet-stream",
    }
}
