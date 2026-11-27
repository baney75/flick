// Torrent streams from source plugins (spec P6), played with no Stremio installed. Each torrent
// gets its own librqbit session, started only while the VPN gate passes, with every socket bound
// to the tunnel the gate found (rule 27): DHT, trackers and peers. It never listens, never
// forwards a port and never announces on the LAN. Only the chosen media file downloads, into the
// app's cache, and the player reads it through the token-guarded 127.0.0.1 server
// (torrent_http). A gate failure stops every torrent at once (rule 26).

mod rules;
#[cfg(test)]
mod tests;

use crate::torrent_http::{Server, Source};
use crate::vpn::{watch::Watch, GateState};
use librqbit::dht::Id20;
use librqbit::limits::LimitsConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ManagedTorrent, Session,
    SessionOptions,
};
use rules::{Want, DROPPED, MAX_ACTIVE, MAX_PEERS, NO_PEERS, TOO_MANY, UPLOAD_BPS};
use std::collections::HashMap;
use std::io::{self, Read, SeekFrom};
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tokio::sync::Notify;
use tokio::time::{timeout, timeout_at, Instant};

/// A player read waiting on a piece gives up after this, freeing its server worker.
const READ_WAIT: Duration = Duration::from_secs(30);
/// Stopping a torrent's session (rule 6 allows 30 seconds).
const STOP_WAIT: Duration = Duration::from_secs(10);

/// Playback stopped while its torrent was still starting.
const STOPPED: &str = "Playback stopped before the torrent started.";
const STOPPING: &str = "This torrent is still stopping. Press Play again in a moment.";

/// What the engine asks of the VPN gate: the app's `Watch`, or a stand-in in tests.
pub trait Gate: Send + Sync {
    /// The gate now; when it passes, `id` is held until released. A failed hold records nothing.
    fn hold(&self, id: &str) -> GateState;
    fn release(&self, id: &str);
}

impl Gate for Watch {
    fn hold(&self, id: &str) -> GateState {
        Watch::hold(self, id)
    }
    fn release(&self, id: &str) {
        Watch::release(self, id)
    }
}

pub struct Config {
    pub cache: PathBuf,
    pub cap: u64,
    /// Metadata and the first data must arrive within this (rule 7: 45 seconds).
    pub wait: Duration,
    pub dht: bool,
    /// Peers every torrent also tries (tests: a seeder on this computer).
    pub peers: Vec<SocketAddr>,
}

/// A torrent the engine runs, keyed by info hash.
enum Slot {
    Starting(Start),
    Running(Running),
}

/// A play that is starting its torrent. Its token tells it apart from a later play of the same
/// torrent, and names its gate hold.
struct Start {
    token: u64,
    /// The tunnel its gate hold passed on, once the gate answers.
    iface: Option<String>,
    /// Set when its playback stopped or the gate dropped it; the start then ends itself.
    ended: Option<&'static str>,
    /// The count of gate answers heard before its hold.
    heard: u64,
    cancel: Arc<Notify>,
}

impl Start {
    fn end(&mut self, why: &'static str) {
        self.ended.get_or_insert(why);
        self.cancel.notify_one();
    }
}

struct Running {
    token: u64,
    session: Arc<Session>,
    iface: String,
    file: usize,
    key: String,
    url: String,
}

pub struct Engine {
    rt: tokio::runtime::Runtime,
    server: Arc<Server>,
    gate: Arc<dyn Gate>,
    cfg: Config,
    table: Mutex<Table>,
}

#[derive(Default)]
struct Table {
    slots: HashMap<String, Slot>,
    /// The gate's last answer through `on_gate`, and how many it has heard.
    last: Option<GateState>,
    heard: u64,
    next: u64,
}

fn hold_id(hash: &str, token: u64) -> String {
    format!("torrent:{hash}:{token}")
}

impl Engine {
    pub fn new(cfg: Config, gate: Arc<dyn Gate>) -> io::Result<Engine> {
        std::fs::create_dir_all(&cfg.cache)?;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("torrent")
            .build()?;
        let server = Server::start()?;
        let table = Mutex::default();
        Ok(Engine {
            rt,
            server,
            gate,
            cfg,
            table,
        })
    }

    // The gate is never called while this lock is held: its hooks call on_gate, which takes it.
    fn table(&self) -> MutexGuard<'_, Table> {
        self.table.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Info hashes of the torrents running now.
    #[cfg(test)]
    pub fn running(&self) -> Vec<String> {
        let t = self.table();
        let running = t
            .slots
            .iter()
            .filter(|(_, s)| matches!(s, Slot::Running(_)));
        running.map(|(h, _)| h.clone()).collect()
    }

    /// Info hashes of the torrents starting now.
    #[cfg(test)]
    pub fn starting(&self) -> Vec<String> {
        let t = self.table();
        let starting = t
            .slots
            .iter()
            .filter(|(_, s)| matches!(s, Slot::Starting(_)));
        starting.map(|(h, _)| h.clone()).collect()
    }

    /// Takes the start `token` of `hash` out of the table, if it is still there.
    fn forget(&self, hash: &str, token: u64) {
        let mut t = self.table();
        if matches!(t.slots.get(hash), Some(Slot::Starting(s)) if s.token == token) {
            t.slots.remove(hash);
        }
    }

    /// Starts `want` (or finds it running) and returns the URL the player opens. It blocks for up
    /// to the start wait, so it runs on a blocking thread, never inside an async task.
    pub fn play(&self, want: &Want) -> Result<String, String> {
        if cfg!(windows) {
            return Err(rules::WINDOWS_OFF.into());
        }
        let (hash, trackers) = rules::check_want(want)?;
        let (token, cancel, old) = {
            let mut t = self.table();
            match t.slots.get(&hash) {
                Some(Slot::Running(r)) if want.file_idx.is_none_or(|i| i == r.file) => {
                    return Ok(r.url.clone());
                }
                Some(Slot::Starting(s)) if s.ended.is_some() => return Err(STOPPING.into()),
                Some(Slot::Starting(_)) => return Err("This torrent is still starting.".into()),
                _ => {}
            }
            // Another file of a running torrent replaces it.
            let old = t.slots.remove(&hash);
            if old.is_none() && t.slots.len() >= MAX_ACTIVE {
                return Err(TOO_MANY.into());
            }
            t.next += 1;
            let (token, cancel) = (t.next, Arc::new(Notify::new()));
            let start = Start {
                token,
                iface: None,
                ended: None,
                heard: t.heard,
                cancel: Arc::clone(&cancel),
            };
            t.slots.insert(hash.clone(), Slot::Starting(start));
            (token, cancel, old)
        };
        // The old session closes before a new one opens the same cache folder.
        if let Some(Slot::Running(r)) = old {
            self.end(&hash, r, true);
        }
        let id = hold_id(&hash, token);
        let gate = self.gate.hold(&id);
        let iface = match (gate.ok, gate.iface) {
            (true, Some(i)) => i,
            _ => {
                self.forget(&hash, token);
                self.gate.release(&id);
                let msg = gate.message.unwrap_or("Turn on your VPN to play torrents");
                return Err(msg.into());
            }
        };
        if let Some(Slot::Starting(s)) = self.table().slots.get_mut(&hash) {
            if s.token == token {
                s.iface = Some(iface.clone());
            }
        }
        let started =
            self.rt
                .block_on(self.start(&hash, &trackers, want.file_idx, &iface, (token, &cancel)));
        let mut t = self.table();
        // A gate answer since the hold on another tunnel, or a failure, ends this start too, even
        // one on_gate heard before the start knew its tunnel.
        let off = |h: &GateState| !h.ok || h.iface.as_deref() != Some(iface.as_str());
        let why = match t.slots.get(&hash) {
            Some(Slot::Starting(s)) if s.token == token => {
                let moved = t.heard != s.heard && t.last.as_ref().is_some_and(off);
                s.ended.or(moved.then_some(DROPPED))
            }
            _ => Some(DROPPED),
        };
        match (started, why) {
            (Ok(r), None) => {
                let url = r.url.clone();
                t.slots.insert(hash, Slot::Running(r));
                Ok(url)
            }
            (started, why) => {
                drop(t);
                // The slot stays until the session is closed, so a new play waits for it.
                let err = match started {
                    Ok(r) => {
                        self.end(&hash, r, true);
                        String::new()
                    }
                    Err(e) => {
                        self.gate.release(&id);
                        e
                    }
                };
                self.forget(&hash, token);
                Err(why.map_or(err, str::to_string))
            }
        }
    }

    fn session_options(&self, iface: &str) -> SessionOptions {
        let mut id = [0u8; 20];
        id[..8].copy_from_slice(b"-FL0100-");
        // A random id per torrent (rule 23); without randomness the session's own default stands.
        let peer_id = getrandom::fill(&mut id[8..]).ok().map(|_| Id20::new(id));
        let dht = self.cfg.dht.then_some(DhtSessionConfig {
            bootstrap_addrs: None,
            port: None,
            persistence: None,
        });
        SessionOptions {
            dht,
            bind_device_name: Some(iface.to_string()),
            peer_id,
            listen: None,
            persistence: None,
            fastresume: false,
            disable_local_service_discovery: true,
            peer_limit: Some(MAX_PEERS),
            ratelimits: LimitsConfig {
                // Every session's share, so all of them together stay under the cap (rule 10).
                upload_bps: NonZeroU32::new(UPLOAD_BPS / MAX_ACTIVE as u32),
                download_bps: None,
            },
            // Room for the streams' permits beside the disk work they wait on.
            runtime_worker_threads: Some(32),
            client_name_and_version: Some("Flick".into()),
            ..Default::default()
        }
    }

    async fn start(
        &self,
        hash: &str,
        trackers: &[String],
        file_idx: Option<usize>,
        iface: &str,
        (token, cancel): (u64, &Notify),
    ) -> Result<Running, String> {
        let deadline = Instant::now() + self.cfg.wait;
        let dir = self.cfg.cache.join(hash);
        let disk = |e: io::Error| format!("Flick can't write the torrent cache: {e}");
        std::fs::create_dir_all(&dir).map_err(disk)?;
        rules::touch(&dir).map_err(disk)?;
        let mut keep: Vec<String> = self.table().slots.keys().cloned().collect();
        keep.push(hash.to_string());
        rules::trim(&self.cfg.cache, self.cfg.cap, &keep).map_err(disk)?;
        let opts = self.session_options(iface);
        let session = Session::new_with_opts(dir.clone(), opts)
            .await
            .map_err(|e| format!("The torrent engine didn't start: {e:#}"))?;
        let run = self.fetch(&session, hash, trackers, file_idx, dir);
        // A stop or a VPN drop ends the start at once; the caller gives the reason.
        let result = tokio::select! {
            r = timeout_at(deadline, run) => r.unwrap_or_else(|_| Err(NO_PEERS.to_string())),
            () = cancel.notified() => Err(DROPPED.to_string()),
        };
        match result {
            Ok((handle, file, len, name)) => {
                let key = format!("{hash}/{file}");
                let rt = self.rt.handle().clone();
                let src = Arc::new(File {
                    handle,
                    file,
                    len,
                    name,
                    rt,
                });
                match self.server.add(&key, src) {
                    Ok(url) => Ok(Running {
                        token,
                        session,
                        iface: iface.to_string(),
                        file,
                        key,
                        url,
                    }),
                    Err(e) => {
                        stop(&session).await;
                        Err(e)
                    }
                }
            }
            Err(e) => {
                stop(&session).await;
                Err(e)
            }
        }
    }

    /// Metadata, the checks, then only the chosen file, until its first data arrives.
    async fn fetch(
        &self,
        session: &Arc<Session>,
        hash: &str,
        trackers: &[String],
        file_idx: Option<usize>,
        dir: PathBuf,
    ) -> Result<(Arc<ManagedTorrent>, usize, u64, String), String> {
        let folder = Some(dir.to_string_lossy().into_owned());
        let peers = Some(self.cfg.peers.clone());
        let list = AddTorrentOptions {
            list_only: true,
            output_folder: folder.clone(),
            initial_peers: peers,
            ..Default::default()
        };
        let link = rules::magnet(hash, trackers);
        fn failed(e: impl std::fmt::Display) -> String {
            format!("This torrent didn't open: {e:#}")
        }
        let listed = session
            .add_torrent(AddTorrent::from_url(link), Some(list))
            .await
            .map_err(failed)?;
        let AddTorrentResponse::ListOnly(listed) = listed else {
            return Err("This torrent didn't open.".into());
        };
        let vetted = rules::vet(&listed.torrent_bytes)?;
        let file = rules::pick_file(&vetted, file_idx)?;
        let (name, len) = vetted.files[file].clone();
        let mut peers = listed.seen_peers;
        peers.extend(&self.cfg.peers);
        let add = AddTorrentOptions {
            only_files: Some(vec![file]),
            output_folder: folder,
            overwrite: true,
            initial_peers: Some(peers),
            peer_limit: Some(MAX_PEERS),
            ..Default::default()
        };
        let added = session
            .add_torrent(
                AddTorrent::TorrentFileBytes(listed.torrent_bytes),
                Some(add),
            )
            .await
            .map_err(failed)?;
        let handle = added
            .into_handle()
            .ok_or_else(|| "This torrent didn't open.".to_string())?;
        let mut first = None;
        loop {
            let got = handle.stats().file_progress.get(file).copied();
            match (got, first) {
                (Some(b), _) if b >= len => break,
                (Some(b), Some(f)) if b > f => break,
                (Some(b), None) => first = Some(b),
                _ => {}
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        Ok((handle, file, len, name))
    }

    /// Stops a torrent: the player's URL goes away at once and its session closes every socket.
    /// With `wait` it blocks until the session closes; without, the gate hears the release after
    /// the hook that asked returns (hooks must not call back into the gate).
    fn end(&self, hash: &str, r: Running, wait: bool) {
        self.server.remove(&r.key);
        let id = hold_id(hash, r.token);
        let session = r.session;
        if wait {
            self.gate.release(&id);
            self.rt.block_on(stop(&session));
        } else {
            let gate = Arc::clone(&self.gate);
            self.rt.spawn(async move {
                gate.release(&id);
                stop(&session).await;
            });
        }
    }

    /// Playback of `hash` stopped. A torrent still starting ends its start. Blocks until the
    /// session closes, so it runs on a blocking thread.
    pub fn stop(&self, hash: &str) {
        let hash = hash.to_ascii_lowercase();
        let running = {
            let mut t = self.table();
            if let Some(Slot::Starting(s)) = t.slots.get_mut(&hash) {
                s.end(STOPPED);
                return;
            }
            t.slots.remove(&hash)
        };
        if let Some(Slot::Running(r)) = running {
            self.end(&hash, r, true);
        }
    }

    /// Every torrent stops (the gate failed, or the app quits). With `wait` it blocks until the
    /// sessions close.
    pub fn stop_all(&self, wait: bool) {
        let running = self.take(|_| true);
        for (hash, r) in running {
            self.end(&hash, r, wait);
        }
    }

    /// Ends every start and takes out every running torrent whose tunnel `gone` matches.
    fn take(&self, gone: impl Fn(&str) -> bool) -> Vec<(String, Running)> {
        let mut t = self.table();
        let mut out = vec![];
        let hashes: Vec<String> = t.slots.keys().cloned().collect();
        for hash in hashes {
            match t.slots.get_mut(&hash) {
                Some(Slot::Starting(s)) => {
                    // A start whose hold hasn't answered yet checks the last answer when it finishes.
                    if s.iface.as_deref().is_some_and(&gone) {
                        s.end(DROPPED);
                    }
                }
                Some(Slot::Running(r)) if gone(&r.iface) => {
                    if let Some(Slot::Running(r)) = t.slots.remove(&hash) {
                        out.push((hash, r));
                    }
                }
                _ => {}
            }
        }
        out
    }

    /// The gate's new answer: a failure stops everything; a pass on another tunnel stops the
    /// torrents bound to the old one. Runs inside the gate's hooks, so it never waits and never
    /// calls the gate.
    pub fn on_gate(&self, s: &GateState) {
        let mut t = self.table();
        t.last = Some(s.clone());
        t.heard += 1;
        drop(t);
        if !s.ok {
            return self.stop_all(false);
        }
        let gone = |iface: &str| s.iface.as_deref() != Some(iface);
        for (hash, r) in self.take(gone) {
            self.end(&hash, r, false);
        }
    }
}

async fn stop(session: &Arc<Session>) {
    if timeout(STOP_WAIT, session.stop()).await.is_err() {
        eprintln!("torrent: a session took over {:?} to stop", STOP_WAIT);
    }
}

/// The chosen file of a running torrent, read from the playhead (librqbit fetches the pieces
/// ahead of each reader first).
struct File {
    handle: Arc<ManagedTorrent>,
    file: usize,
    len: u64,
    name: String,
    rt: tokio::runtime::Handle,
}

fn timed_out() -> io::Error {
    io::Error::new(io::ErrorKind::TimedOut, "no data from the torrent yet")
}

impl Source for File {
    fn len(&self) -> u64 {
        self.len
    }
    fn name(&self) -> &str {
        &self.name
    }
    fn open(&self, start: u64) -> io::Result<Box<dyn Read + Send>> {
        let handle = Arc::clone(&self.handle);
        let rt = self.rt.clone();
        self.rt.block_on(async {
            let mut s = timeout(READ_WAIT, handle.stream(self.file))
                .await
                .map_err(|_| timed_out())?
                .map_err(io::Error::other)?;
            s.seek(SeekFrom::Start(start)).await?;
            let s: Box<dyn AsyncRead + Send + Unpin> = Box::new(s);
            Ok(Box::new(Reader { s, rt }) as Box<dyn Read + Send>)
        })
    }
}

struct Reader {
    s: Box<dyn AsyncRead + Send + Unpin>,
    rt: tokio::runtime::Handle,
}

impl Read for Reader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let s = &mut self.s;
        self.rt.block_on(async {
            match timeout(READ_WAIT, s.read(buf)).await {
                Ok(r) => r,
                Err(_) => Err(timed_out()),
            }
        })
    }
}

static ENGINE: Mutex<Option<Arc<Engine>>> = Mutex::new(None);

/// The app's engine, started on first use (rule 4) and told about every gate answer.
fn engine(app: &tauri::AppHandle) -> Result<Arc<Engine>, String> {
    use tauri::Manager;
    let mut e = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = e.as_ref() {
        return Ok(Arc::clone(e));
    }
    let watch = crate::vpn::watch::get()?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let cfg = Config {
        cache: cache.join("torrents"),
        cap: rules::CACHE_CAP,
        wait: Duration::from_secs(45),
        dht: true,
        peers: vec![],
    };
    let gate: Arc<dyn Gate> = Arc::clone(watch) as Arc<dyn Gate>;
    let started = Arc::new(Engine::new(cfg, gate).map_err(|e| e.to_string())?);
    let hooked = Arc::clone(&started);
    watch.subscribe(Box::new(move |s| hooked.on_gate(s)));
    *e = Some(Arc::clone(&started));
    Ok(started)
}

/// Plays a torrent stream: `{ infoHash, fileIdx?, trackers? }` to the URL the player opens.
#[tauri::command]
pub async fn torrent_play(app: tauri::AppHandle, torrent: Want) -> Result<String, String> {
    if cfg!(windows) {
        return Err(rules::WINDOWS_OFF.into());
    }
    let e = engine(&app)?;
    let run = tauri::async_runtime::spawn_blocking(move || e.play(&torrent));
    run.await.map_err(|e| e.to_string())?
}

/// The player stopped the stream of `info_hash`.
#[tauri::command]
pub async fn torrent_stop(info_hash: String) -> Result<(), String> {
    let e = ENGINE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(e) = e {
        let run = tauri::async_runtime::spawn_blocking(move || e.stop(&info_hash));
        run.await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The app is quitting: every torrent stops and closes its sockets.
pub fn shutdown() {
    let e = ENGINE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(e) = e {
        e.stop_all(true);
    }
}
