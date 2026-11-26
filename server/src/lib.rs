//! flick-server: share media folders with Flick over HTTP (API contract v1).
//! The library keeps no process-global state and never prints, so the desktop app can embed it.
pub mod index;
pub mod reach;
pub mod service;
pub mod thumb;
pub mod web;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use index::Index;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, RwLock};
use std::thread::JoinHandle;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_PORT: u16 = 8740;
pub const SETUP_BASE: &str = "https://flick-player.pages.dev";
const RESCAN_EVERY: Duration = Duration::from_secs(600);

#[derive(Clone, Debug)]
pub struct Config {
    pub media: Vec<PathBuf>,
    /// 0 picks a free port.
    pub port: u16,
    pub name: String,
    /// Bind 0.0.0.0 instead of 127.0.0.1.
    pub lan: bool,
    /// Holds `token`.
    pub config_dir: PathBuf,
    /// Flick web app folder. `None` serves the built-in copy with the `embed-web` feature, else a text page.
    pub web: Option<PathBuf>,
}

const WORKERS: usize = 16;
const STOP_WAIT: Duration = Duration::from_secs(2);

struct State {
    name: String,
    token: String,
    roots: Vec<PathBuf>,
    real_roots: Vec<PathBuf>,
    index: RwLock<Arc<Index>>,
    web: web::Web,
    /// Cached photo thumbnails.
    thumbs: PathBuf,
    renders: thumb::Gate,
    // Set by stop(); a body being streamed ends at its next read.
    stopping: AtomicBool,
}

impl State {
    /// `dates` reads the capture date of each new or changed photo.
    fn rescan(&self, dates: bool) {
        let prev = self.index();
        let fresh = Arc::new(index::scan_with(&self.roots, Some(&prev), dates));
        *self.index.write().unwrap() = fresh;
    }
    fn index(&self) -> Arc<Index> {
        self.index.read().unwrap().clone()
    }
}

pub struct Handle {
    port: u16,
    token: String,
    name: String,
    web: bool,
    server: Arc<Server>,
    stop_tx: Option<mpsc::Sender<()>>,
    threads: Vec<JoinHandle<()>>,
    state: Arc<State>,
}

impl Handle {
    pub fn port(&self) -> u16 {
        self.port
    }
    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
    pub fn token(&self) -> &str {
        &self.token
    }
    /// True when this server serves the Flick web app itself.
    pub fn serves_web(&self) -> bool {
        self.web
    }
    /// Setup link for `url`. Its base is `url` itself when the web app is served here, else `SETUP_BASE`.
    pub fn setup_link(&self, url: &str) -> String {
        let base = if self.web {
            url.trim_end_matches('/')
        } else {
            SETUP_BASE
        };
        setup_link(base, &self.name, url, &self.token)
    }
    pub fn stop(mut self) {
        self.shutdown();
    }
    fn shutdown(&mut self) {
        self.stop_tx.take();
        self.state.stopping.store(true, Ordering::SeqCst);
        for _ in 0..WORKERS {
            self.server.unblock();
        }
        // Streams end at their next read. A client that stopped reading can hold a worker in a
        // blocked write, so wait at most STOP_WAIT and then let such a worker go on its own.
        let deadline = std::time::Instant::now() + STOP_WAIT;
        for t in self.threads.drain(..) {
            while !t.is_finished() && std::time::Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(20));
            }
            if t.is_finished() {
                let _ = t.join();
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Reads `<dir>/token`, creating it (mode 0600 on Unix) when missing or when `renew` is set.
pub fn access_code(dir: &Path, renew: bool) -> Result<String, String> {
    let path = dir.join("token");
    if !renew {
        if let Ok(t) = std::fs::read_to_string(&path) {
            if !t.trim().is_empty() {
                return Ok(t.trim().to_string());
            }
        }
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| format!("random: {e}"))?;
    let code = B64.encode(bytes);
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    // Write the whole code to a private temp file first, then put it in place in one step, so a
    // second process (the service an install just started) never sees a half written or different
    // token: without renew the first one placed wins and everyone reads it.
    let tag: String = bytes[..6].iter().map(|b| format!("{b:02x}")).collect();
    let tmp = dir.join(format!("token.{}.{tag}", std::process::id()));
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let written = opts
        .open(&tmp)
        .and_then(|mut f| std::io::Write::write_all(&mut f, code.as_bytes()))
        .map_err(|e| format!("{}: {e}", tmp.display()));
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    let placed = if renew {
        std::fs::rename(&tmp, &path)
    } else {
        let r = std::fs::hard_link(&tmp, &path);
        let _ = std::fs::remove_file(&tmp);
        r
    };
    match placed {
        Ok(()) => {}
        Err(e) if !renew && e.kind() == std::io::ErrorKind::AlreadyExists => {
            let t =
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            return Ok(t.trim().to_string());
        }
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("{}: {e}", path.display()));
        }
    }
    Ok(code)
}

/// The Flick setup link for one server URL.
pub fn setup_link(base: &str, name: &str, url: &str, token: &str) -> String {
    let s = serde_json::json!({"v":1,"servers":[{"type":"flick","name":name,"url":url.trim_end_matches('/'),"token":token}]});
    format!("{base}/#/setup?c={}", B64.encode(s.to_string()))
}

/// True when a server started with this `web` setting would serve the Flick web app itself.
pub fn serves_web(web: Option<PathBuf>) -> bool {
    web::Web::new(web).available()
}

pub fn start(cfg: Config) -> Result<Handle, String> {
    let token = access_code(&cfg.config_dir, false)?;
    let host = if cfg.lan { "0.0.0.0" } else { "127.0.0.1" };
    let server = Arc::new(
        Server::http((host, cfg.port)).map_err(|e| format!("bind {host}:{}: {e}", cfg.port))?,
    );
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .unwrap_or(cfg.port);
    let web = web::Web::new(cfg.web);
    let serves_web = web.available();
    let name = cfg.name.clone();
    let state = Arc::new(State {
        web,
        thumbs: cfg.config_dir.join("thumbs"),
        renders: thumb::Gate::new(thumb::RENDERS, thumb::WAITING),
        name: cfg.name,
        token: token.clone(),
        real_roots: cfg
            .media
            .iter()
            .filter_map(|r| std::fs::canonicalize(r).ok())
            .collect(),
        roots: cfg.media,
        index: Default::default(),
        stopping: AtomicBool::new(false),
    });
    // Start answering after a quick scan; photo dates fill in on the first background pass.
    state.rescan(false);
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let st = state.clone();
    let rescan = std::thread::spawn(move || {
        st.rescan(true);
        while let Err(mpsc::RecvTimeoutError::Timeout) = stop_rx.recv_timeout(RESCAN_EVERY) {
            st.rescan(true);
        }
    });
    // A fixed set of workers answers requests, so a flood of connections can't spawn threads
    // without bound or crash the server when the OS refuses one.
    let shared = state.clone();
    let mut threads = vec![rescan];
    for _ in 0..WORKERS {
        let (srv, st) = (server.clone(), state.clone());
        threads.push(std::thread::spawn(move || {
            while let Ok(req) = srv.recv() {
                handle(&st, req);
            }
        }));
    }
    Ok(Handle {
        port,
        token,
        name,
        web: serves_web,
        server,
        stop_tx: Some(stop_tx),
        threads,
        state: shared,
    })
}

fn header(k: &str, v: &str) -> Header {
    Header::from_bytes(k.as_bytes(), v.as_bytes()).unwrap()
}

fn respond<R: Read>(req: Request, mut res: Response<R>) {
    for (k, v) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Headers", "Authorization, Range"),
        (
            "Access-Control-Expose-Headers",
            "Content-Range, Accept-Ranges, Content-Length",
        ),
        ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
    ] {
        res.add_header(header(k, v));
    }
    let _ = req.respond(res.with_chunked_threshold(usize::MAX));
}

fn json(req: Request, status: u16, body: serde_json::Value) {
    let res = Response::from_string(body.to_string())
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"));
    respond(req, res);
}

fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn handle(st: &State, req: Request) {
    let url = req.url().to_string();
    let (path, query) = url.split_once('?').unwrap_or((&url, ""));
    let param = |k: &str| {
        query
            .split('&')
            .find_map(|p| p.strip_prefix(k)?.strip_prefix('='))
    };
    let method = req.method().clone();
    if method == Method::Options {
        return respond(req, Response::empty(204));
    }
    if method != Method::Get && method != Method::Head {
        return json(req, 405, serde_json::json!({"error":"method not allowed"}));
    }
    if path == "/api/info" {
        return json(
            req,
            200,
            serde_json::json!({"app":"flick-server","v":1,"name":st.name,"version":VERSION}),
        );
    }
    if !path.starts_with("/api/") && !path.starts_with("/media/") && !path.starts_with("/thumb/") {
        return fallback(st, req);
    }
    let bearer = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .and_then(|h| h.value.as_str().strip_prefix("Bearer ").map(str::to_string));
    let given = bearer
        .or_else(|| param("t").map(str::to_string))
        .unwrap_or_default();
    if !ct_eq(given.as_bytes(), st.token.as_bytes()) {
        return json(
            req,
            401,
            serde_json::json!({"error":"missing or wrong access code"}),
        );
    }
    if path == "/api/library" {
        if param("rescan") == Some("1") {
            st.rescan(true);
        }
        let idx = st.index();
        return json(
            req,
            200,
            serde_json::json!({"name":st.name,"folders":idx.folders,"items":idx.items}),
        );
    }
    if let Some(id) = path.strip_prefix("/thumb/") {
        return match st.index().get(id) {
            Some(item) if item.kind == "photo" => thumbnail(req, item, st),
            _ => json(req, 404, serde_json::json!({"error":"not found"})),
        };
    }
    let Some(id) = path.strip_prefix("/media/") else {
        return json(req, 404, serde_json::json!({"error":"not found"}));
    };
    let idx = st.index();
    match idx.get(id) {
        Some(item) => media(req, item, &st.real_roots, &st.stopping),
        None => json(req, 404, serde_json::json!({"error":"not found"})),
    }
}

fn fallback(st: &State, req: Request) {
    match st.web.get(req.url().split('?').next().unwrap_or("/")) {
        Err(()) => return json(req, 404, serde_json::json!({"error":"not found"})),
        Ok(Some(a)) => {
            let res = Response::new(200.into(), vec![], a.body, Some(a.len), None)
                .with_header(header("Content-Type", a.content_type))
                .with_header(header("Cache-Control", a.cache));
            return respond(req, res);
        }
        Ok(None) => {}
    }
    let text = format!(
        "Flick server {} is running. Connect to it from Flick with the setup link it printed.\n",
        st.name
    );
    let res = Response::from_string(text)
        .with_header(header("Content-Type", "text/plain; charset=utf-8"));
    respond(req, res);
}

#[derive(Debug, PartialEq)]
pub enum Range {
    /// No usable range: send the whole file.
    Full,
    /// Inclusive byte range.
    Part(u64, u64),
    /// Answer 416.
    Unsatisfiable,
}

/// Parses a Range header against a file of `total` bytes. With several ranges only the first is used.
pub fn parse_range(h: &str, total: u64) -> Range {
    use Range::*;
    let Some(spec) = h.trim().strip_prefix("bytes=") else {
        return Full;
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else {
        return Full;
    };
    let num = |s: &str| s.trim().parse::<u64>().ok();
    match (a.trim().is_empty(), num(a), num(b)) {
        (true, _, Some(0)) => Unsatisfiable,
        (true, _, Some(_)) if total == 0 => Unsatisfiable,
        (true, _, Some(n)) => Part(total.saturating_sub(n), total - 1),
        (false, Some(a), _) if a >= total => Unsatisfiable,
        (false, Some(a), None) if b.trim().is_empty() => Part(a, total - 1),
        (false, Some(a), Some(b)) if b >= a => Part(a, b.min(total - 1)),
        _ => Full,
    }
}

/// True when `abs`, with every symlink resolved, is still inside one of the shared roots (resolved
/// once at start, so a root swapped for a link later does not count either). The index
/// was built without following links, but a file or folder can be swapped for a link after a scan.
fn inside_roots(abs: &std::path::Path, roots: &[PathBuf]) -> bool {
    let Ok(real) = std::fs::canonicalize(abs) else {
        return false;
    };
    roots.iter().any(|r| real.starts_with(r))
}

/// Opens the item's file only if what was opened is the file at its resolved path inside a shared
/// root. Checking after the open, and comparing the file's identity, closes the gap where the path
/// is swapped between a check and the open.
fn open_inside(abs: &Path, roots: &[PathBuf]) -> Option<File> {
    let file = File::open(abs).ok()?;
    if !inside_roots(abs, roots) {
        return None;
    }
    same_file(&file, &std::fs::canonicalize(abs).ok()?).then_some(file)
}

#[cfg(unix)]
pub fn same_file(file: &File, path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (file.metadata(), std::fs::metadata(path)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
pub fn same_file(file: &File, path: &Path) -> bool {
    // Without a stable file id here, compare size and modified time as a weaker check.
    match (file.metadata(), std::fs::metadata(path)) {
        (Ok(a), Ok(b)) => a.len() == b.len() && a.modified().ok() == b.modified().ok(),
        _ => false,
    }
}

/// Ends a streamed body once the server is stopping.
struct Stoppable<'a, R> {
    inner: R,
    stopping: &'a AtomicBool,
}

impl<R: Read> Read for Stoppable<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.stopping.load(Ordering::Relaxed) {
            return Err(std::io::Error::other("server stopping"));
        }
        self.inner.read(buf)
    }
}

fn thumbnail(req: Request, item: &index::Item, st: &State) {
    let cached = thumb::cache_path(&st.thumbs, &item.id, item.size, item.mtime);
    let failed = thumb::failed_path(&st.thumbs, &item.id, item.size, item.mtime);
    let no_thumb = |req| {
        json(
            req,
            415,
            serde_json::json!({"error":"no thumbnail for this file"}),
        )
    };
    let busy = |req: Request| {
        let res = Response::from_string(r#"{"error":"busy, try again"}"#)
            .with_status_code(503)
            .with_header(header("Content-Type", "application/json"))
            .with_header(header("Retry-After", "1"));
        respond(req, res)
    };
    if failed.exists() {
        return no_thumb(req);
    }
    let jpeg = match std::fs::read(&cached) {
        Ok(b) => b,
        Err(_) => {
            let Some(file) = open_inside(&item.abs, &st.real_roots) else {
                return json(req, 404, serde_json::json!({"error":"not found"}));
            };
            let Some(turn) = st.renders.enter() else {
                return busy(req);
            };
            let made = thumb::render(file);
            drop(turn);
            // A read-only config dir only costs the cache; the answer is the same.
            match made {
                Ok(jpeg) => {
                    let _ = thumb::store(&cached, &jpeg);
                    jpeg
                }
                Err(thumb::Failure::Undecodable) => {
                    let _ = thumb::store(&failed, b"");
                    return no_thumb(req);
                }
                Err(thumb::Failure::Io) => return busy(req),
            }
        }
    };
    let res = Response::from_data(jpeg)
        .with_header(header("Content-Type", "image/jpeg"))
        .with_header(header(
            "Cache-Control",
            "private, max-age=31536000, immutable",
        ));
    respond(req, res);
}

fn media(req: Request, item: &index::Item, roots: &[PathBuf], stopping: &AtomicBool) {
    let Some(mut file) = open_inside(&item.abs, roots) else {
        return json(req, 404, serde_json::json!({"error":"not found"}));
    };
    let total = file.metadata().map(|m| m.len()).unwrap_or(item.size);
    let range = req
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.to_string());
    let (start, end, status) = match range.map_or(Range::Full, |r| parse_range(&r, total)) {
        Range::Unsatisfiable => {
            let res = Response::empty(416)
                .with_header(header("Content-Range", &format!("bytes */{total}")));
            return respond(req, res);
        }
        Range::Part(a, b) => (a, b, 206),
        Range::Full => (0, total.saturating_sub(1), 200),
    };
    let len = if total == 0 { 0 } else { end - start + 1 };
    if file.seek(SeekFrom::Start(start)).is_err() {
        return json(req, 500, serde_json::json!({"error":"read failed"}));
    }
    let mut res = Response::new(
        status.into(),
        vec![],
        Stoppable {
            inner: file.take(len),
            stopping,
        },
        Some(len as usize),
        None,
    )
    .with_header(header("Accept-Ranges", "bytes"))
    .with_header(header("Content-Type", index::content_type(&item.ext)));
    if status == 206 {
        res.add_header(header(
            "Content-Range",
            &format!("bytes {start}-{end}/{total}"),
        ));
    }
    respond(req, res);
}
