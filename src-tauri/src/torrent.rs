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
use rules::{
    Want, CHECK_SLOW, CHECK_WAIT, DROPPED, MAX_ACTIVE, MAX_PEERS, METADATA, NO_PEERS, TOO_MANY,
    UPLOAD_BPS,
};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, SeekFrom};
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tokio::sync::Notify;
use tokio::task::JoinHandle;
use tokio::time::{timeout, timeout_at, Instant};

/// A player read waiting on a piece gives up after this, freeing its server worker.
const READ_WAIT: Duration = Duration::from_secs(30);
/// How long a stop waits for a torrent's session to close (rule 6 allows 30 seconds).
pub const STOP_WAIT: Duration = Duration::from_secs(10);
/// How long a session may take to close before its torrent may play again anyway (rule 6's 30
/// seconds): a stop that never returns can't keep it "still stopping" until Flick restarts.
pub const CLOSE_LIMIT: Duration = Duration::from_secs(30);

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
    /// Metadata and the first data must arrive within this (rule 7: 45 seconds). The check of a
    /// replay's cached pieces doesn't count against it (CHECK_WAIT).
    pub wait: Duration,
    pub dht: bool,
    /// Peers every torrent also tries (tests: a seeder on this computer).
    pub peers: Vec<SocketAddr>,
    /// How long a stop waits for a session to close (STOP_WAIT; shorter in tests).
    pub stop_wait: Duration,
    /// How long a session may take to close before its closing mark goes (CLOSE_LIMIT).
    pub close_limit: Duration,
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

/// What the player's readout shows for a torrent (spec rule 32).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub down_bps: u64,
    pub peers: u32,
}

struct Running {
    token: u64,
    /// Its files after the checks, so another file of it is judged before this one stops.
    vetted: rules::Vetted,
    handle: Arc<ManagedTorrent>,
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
    table: Arc<Mutex<Table>>,
    /// Tests: how each session closes.
    #[cfg(test)]
    stall: Mutex<Close>,
}

#[derive(Default)]
struct Table {
    slots: HashMap<String, Slot>,
    /// The gate's last answer through `on_gate`, and how many it has heard.
    last: Option<GateState>,
    heard: u64,
    next: u64,
    /// Torrents whose sessions have left the table but not yet closed. No new session opens one
    /// of these cache folders until its old session has, or has been given up on.
    closing: HashSet<String>,
    /// Torrents whose last close was given up on (it panicked, was cancelled or passed
    /// `close_limit`), with the subfolder their next session opens: the old session may still
    /// write into the folder it had. Kept until Flick restarts; the trim never removes them.
    abandoned: HashMap<String, u64>,
}

impl Table {
    /// Takes `hash`'s running torrent out, marked as closing until its session has closed.
    fn retire(&mut self, hash: &str) -> Option<Running> {
        match self.slots.remove(hash) {
            Some(Slot::Running(r)) => {
                self.closing.insert(hash.to_string());
                Some(r)
            }
            Some(other) => {
                self.slots.insert(hash.to_string(), other);
                None
            }
            None => None,
        }
    }
}

fn lock(table: &Mutex<Table>) -> MutexGuard<'_, Table> {
    table.lock().unwrap_or_else(|e| e.into_inner())
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
        Ok(Engine {
            rt,
            server,
            gate,
            cfg,
            table: Arc::default(),
            #[cfg(test)]
            stall: Mutex::default(),
        })
    }

    // The gate is never called while this lock is held: its hooks call on_gate, which takes it.
    fn table(&self) -> MutexGuard<'_, Table> {
        lock(&self.table)
    }

    /// The gate's last answer through `on_gate`.
    #[cfg(test)]
    pub fn last_gate(&self) -> Option<GateState> {
        self.table().last.clone()
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
            if t.closing.contains(&hash) {
                return Err(STOPPING.into());
            }
            match t.slots.get(&hash) {
                Some(Slot::Running(r)) if want.file_idx.is_none_or(|i| i == r.file) => {
                    return Ok(r.url.clone());
                }
                Some(Slot::Starting(s)) if s.ended.is_some() => return Err(STOPPING.into()),
                Some(Slot::Starting(_)) => return Err("This torrent is still starting.".into()),
                // Another file of it: one it can't play leaves the one that plays alone.
                Some(Slot::Running(r)) => {
                    rules::pick_file(&r.vetted, want.file_idx)?;
                }
                None => {}
            }
            // Another file of a running torrent replaces it.
            let old = t.retire(&hash);
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
        if let Some(r) = old {
            if !self.end(&hash, r, true) {
                self.forget(&hash, token);
                return Err(STOPPING.into());
            }
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
        // A start ended while its hold ran (or while the old session closed) opens nothing.
        let ended = match self.table().slots.get_mut(&hash) {
            Some(Slot::Starting(s)) if s.token == token => {
                s.iface = Some(iface.clone());
                s.ended
            }
            _ => Some(DROPPED),
        };
        if let Some(why) = ended {
            self.forget(&hash, token);
            self.gate.release(&id);
            return Err(why.into());
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
                if started.is_ok() {
                    t.closing.insert(hash.clone());
                }
                drop(t);
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
        let dir = {
            let t = self.table();
            let home = self.cfg.cache.join(hash);
            match t.abandoned.get(hash) {
                Some(n) => home.join(format!(".flick-{n}")),
                None => home,
            }
        };
        let disk = |e: io::Error| format!("Flick can't write the torrent cache: {e}");
        std::fs::create_dir_all(&dir).map_err(disk)?;
        rules::touch(&self.cfg.cache.join(hash)).map_err(disk)?;
        trim(&self.table, &self.cfg.cache, self.cfg.cap, Some(hash)).map_err(disk)?;
        let opts = self.session_options(iface);
        let session = Session::new_with_opts(dir.clone(), opts)
            .await
            .map_err(|e| format!("The torrent engine didn't start: {e:#}"))?;
        let run = self.fetch(&session, hash, trackers, file_idx, dir, deadline);
        // A stop or a VPN drop ends the start at once; the caller gives the reason.
        let result = tokio::select! {
            r = run => r,
            () = cancel.notified() => Err(DROPPED.to_string()),
        };
        match result {
            Ok((handle, vetted, file, len, name)) => {
                let key = format!("{hash}/{file}");
                let rt = self.rt.handle().clone();
                let src = Arc::new(File {
                    handle: Arc::clone(&handle),
                    file,
                    len,
                    name,
                    rt,
                });
                match self.server.add(&key, src) {
                    Ok(url) => Ok(Running {
                        token,
                        vetted,
                        handle,
                        session,
                        iface: iface.to_string(),
                        file,
                        key,
                        url,
                    }),
                    Err(e) => {
                        self.shut(hash, session).await;
                        Err(e)
                    }
                }
            }
            Err(e) => {
                self.shut(hash, session).await;
                Err(e)
            }
        }
    }

    /// Closes the session of a start that won't play, marked as closing until it has.
    async fn shut(&self, hash: &str, session: Arc<Session>) {
        self.table().closing.insert(hash.to_string());
        closed(self.cfg.stop_wait, vec![self.close(hash, session)]).await;
    }

    /// Metadata (saved in the cache folder, or from peers), the checks, then only the chosen file,
    /// until its first data arrives or its first piece is already on disk (#113). Metadata and the
    /// first data must come by `deadline`; the check of cached pieces gets CHECK_WAIT on top.
    async fn fetch(
        &self,
        session: &Arc<Session>,
        hash: &str,
        trackers: &[String],
        file_idx: Option<usize>,
        dir: PathBuf,
        deadline: Instant,
    ) -> Result<(Arc<ManagedTorrent>, rules::Vetted, usize, u64, String), String> {
        let folder = Some(dir.to_string_lossy().into_owned());
        fn failed(e: impl std::fmt::Display) -> String {
            format!("This torrent didn't open: {e:#}")
        }
        let no_peers = |_| NO_PEERS.to_string();
        let saved = self.cfg.cache.join(hash).join(METADATA);
        let cached = rules::saved_metadata(&saved, hash);
        let fetched = cached.is_none();
        let (bytes, mut peers) = match cached {
            Some(b) => (b, vec![]),
            None => {
                let list = AddTorrentOptions {
                    list_only: true,
                    output_folder: folder.clone(),
                    initial_peers: Some(self.cfg.peers.clone()),
                    ..Default::default()
                };
                let link = rules::magnet(hash, trackers);
                let listed = session.add_torrent(AddTorrent::from_url(link), Some(list));
                let listed = timeout_at(deadline, listed)
                    .await
                    .map_err(no_peers)?
                    .map_err(failed)?;
                let AddTorrentResponse::ListOnly(listed) = listed else {
                    return Err("This torrent didn't open.".into());
                };
                (listed.torrent_bytes.to_vec(), listed.seen_peers)
            }
        };
        let vetted = rules::vet(&bytes)?;
        let file = rules::pick_file(&vetted, file_idx)?;
        let (name, len) = vetted.files[file].clone();
        if let Err(e) = fetched.then(|| std::fs::write(&saved, &bytes)).transpose() {
            eprintln!(
                "flick: torrent metadata not saved at {}: {e}",
                saved.display()
            );
        }
        peers.extend(&self.cfg.peers);
        let add = AddTorrentOptions {
            only_files: Some(vec![file]),
            output_folder: folder,
            overwrite: true,
            initial_peers: Some(peers),
            peer_limit: Some(MAX_PEERS),
            // Saved metadata carries no trackers, so a replay announces to the stream's own.
            trackers: Some(trackers.to_vec()),
            ..Default::default()
        };
        let added = session.add_torrent(AddTorrent::from_bytes(bytes), Some(add));
        let added = timeout_at(deadline, added)
            .await
            .map_err(no_peers)?
            .map_err(failed)?;
        let handle = added
            .into_handle()
            .ok_or_else(|| "This torrent didn't open.".to_string())?;
        // Fastresume is off, so the pieces already cached are hashed again first.
        let began = Instant::now();
        timeout(CHECK_WAIT, handle.wait_until_initialized())
            .await
            .map_err(|_| CHECK_SLOW.to_string())?
            .map_err(failed)?;
        let deadline = deadline + began.elapsed();
        let start = handle
            .with_metadata(|m| m.file_infos[file].piece_range.start)
            .map_err(failed)?;
        let api = librqbit::Api::new(Arc::clone(session), None);
        let id = librqbit::api::TorrentIdOrHash::Id(handle.id());
        let on_disk = || {
            api.api_dump_haves(id)
                .is_ok_and(|(have, _)| have.get(start as usize).is_some_and(|b| *b))
        };
        let first_data = async {
            let mut first = None;
            loop {
                let got = handle.stats().file_progress.get(file).copied();
                match (got, first) {
                    (Some(b), _) if b >= len => break,
                    (Some(b), Some(f)) if b > f => break,
                    (Some(b), None) => first = Some(b),
                    _ => {}
                }
                if on_disk() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        };
        timeout_at(deadline, first_data).await.map_err(no_peers)?;
        Ok((handle, vetted, file, len, name))
    }

    /// Stops a torrent: the player's URL goes away at once and its session closes every socket.
    /// With `wait` it blocks until the session closes and says whether it closed in time; without,
    /// the gate hears the release after the hook that asked returns (hooks must not call back
    /// into the gate), and it answers true.
    fn end(&self, hash: &str, r: Running, wait: bool) -> bool {
        self.server.remove(&r.key);
        let id = hold_id(hash, r.token);
        if wait {
            self.gate.release(&id);
            let closing = self.close(hash, r.session);
            self.rt.block_on(closed(self.cfg.stop_wait, vec![closing]))
        } else {
            self.close(hash, r.session);
            let gate = Arc::clone(&self.gate);
            self.rt.spawn(async move { gate.release(&id) });
            true
        }
    }

    /// Closes the session of `hash`, which left the table marked as closing. The mark goes once
    /// the session has closed, so no new session opens its cache folder before then. A close that
    /// passes `close_limit`, panics or is cancelled is given up on: the mark goes too, so the
    /// torrent can play again, and its next session opens a fresh folder.
    /// Once the session has closed, the cache trims back under its cap in a task of its own (a
    /// torrent that grew while it played may have pushed it over). The trim keeps this torrent,
    /// and no wait on the close waits for it.
    fn close(&self, hash: &str, session: Arc<Session>) -> JoinHandle<()> {
        let table = Arc::clone(&self.table);
        let mark = Unmark {
            table: Arc::clone(&table),
            hash: hash.to_string(),
            closed: false,
        };
        let limit = self.cfg.close_limit;
        let (cache, cap, own) = (self.cfg.cache.clone(), self.cfg.cap, hash.to_string());
        #[cfg(test)]
        let how = *self.stall.lock().unwrap();
        self.rt.spawn(async move {
            // The whole guard moves in, so it drops when the task ends, however it ends.
            let mut mark = mark;
            let stop = async {
                session.stop().await;
                #[cfg(test)]
                how.after().await;
            };
            match timeout(limit, stop).await {
                Ok(()) => mark.closed = true,
                Err(_) => eprintln!("torrent: a session took over {limit:?} to close; given up"),
            }
            drop(mark);
            tokio::task::spawn_blocking(move || {
                if let Err(e) = trim(&table, &cache, cap, Some(&own)) {
                    eprintln!("torrent: trimming the cache failed: {e}");
                }
            });
        })
    }

    /// A running torrent's download speed and live peers, for the player's readout: zero while
    /// librqbit is between states, none once it no longer runs.
    pub fn stats(&self, hash: &str) -> Option<Stats> {
        let handle = match self.table().slots.get(&hash.to_ascii_lowercase()) {
            Some(Slot::Running(r)) => Arc::clone(&r.handle),
            _ => return None,
        };
        let Some(live) = handle.stats().live else {
            return Some(Stats {
                down_bps: 0,
                peers: 0,
            });
        };
        Some(Stats {
            down_bps: live.download_speed.as_bytes(),
            peers: live.snapshot.peer_stats.live,
        })
    }

    /// Playback of `hash` stopped. A running torrent's session closes before this returns, so it
    /// runs on a blocking thread; a torrent still starting is told to end and closes on its own.
    pub fn stop(&self, hash: &str) {
        let hash = hash.to_ascii_lowercase();
        let running = {
            let mut t = self.table();
            if let Some(Slot::Starting(s)) = t.slots.get_mut(&hash) {
                s.end(STOPPED);
                return;
            }
            t.retire(&hash)
        };
        if let Some(r) = running {
            self.end(&hash, r, true);
        }
    }

    /// Every torrent stops (the gate failed, or the app quits). With `wait` it blocks until the
    /// sessions close.
    pub fn stop_all(&self, wait: bool) {
        let running = self.take(|_| true, true);
        if !wait {
            for (hash, r) in running {
                self.end(&hash, r, false);
            }
            return;
        }
        // At quit the sessions close together, under one bounded wait.
        let mut closing = vec![];
        for (hash, r) in running {
            self.server.remove(&r.key);
            self.gate.release(&hold_id(&hash, r.token));
            closing.push(self.close(&hash, r.session));
        }
        self.rt.block_on(closed(self.cfg.stop_wait, closing));
    }

    /// Ends the starts on a tunnel `gone` matches (every start with `all`) and takes out the
    /// running torrents on one.
    fn take(&self, gone: impl Fn(&str) -> bool, all: bool) -> Vec<(String, Running)> {
        let mut t = self.table();
        let mut out = vec![];
        let hashes: Vec<String> = t.slots.keys().cloned().collect();
        for hash in hashes {
            match t.slots.get_mut(&hash) {
                Some(Slot::Starting(s)) => {
                    // A start whose hold hasn't answered yet checks the last answer when it finishes.
                    if all || s.iface.as_deref().is_some_and(&gone) {
                        s.end(DROPPED);
                    }
                }
                Some(Slot::Running(r)) if gone(&r.iface) => {
                    if let Some(r) = t.retire(&hash) {
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
        for (hash, r) in self.take(gone, false) {
            self.end(&hash, r, false);
        }
    }
}

/// Trims the cache under `cap`, never deleting the folder of a torrent that is starting, playing,
/// closing or was given up on, nor `also`'s. It asks the table just before each delete and never
/// holds it while deleting, so the gate's hooks never wait on the disk.
fn trim(table: &Mutex<Table>, cache: &Path, cap: u64, also: Option<&str>) -> io::Result<()> {
    let held = |name: &str| {
        let t = lock(table);
        also == Some(name)
            || t.slots.contains_key(name)
            || t.closing.contains(name)
            || t.abandoned.contains_key(name)
    };
    rules::trim(cache, cap, held).map(drop)
}

/// Removes a torrent's closing mark when its close task ends, however it ends. A close that
/// didn't finish (it panicked, was cancelled or passed its limit) leaves the torrent abandoned.
struct Unmark {
    table: Arc<Mutex<Table>>,
    hash: String,
    closed: bool,
}

impl Drop for Unmark {
    fn drop(&mut self) {
        let mut t = lock(&self.table);
        t.closing.remove(&self.hash);
        if !self.closed {
            let n = t.next;
            t.next += 1;
            t.abandoned.insert(self.hash.clone(), n);
        }
    }
}

/// Tests: how a session closes. A close that panics or never returns once librqbit's stop has
/// run stands in for a stop that does.
#[cfg(test)]
#[derive(Clone, Copy, Default)]
enum Close {
    #[default]
    Now,
    Stall(Duration),
    Panic,
    Hang,
}

#[cfg(test)]
impl Close {
    async fn after(self) {
        match self {
            Close::Now => {}
            Close::Stall(d) => tokio::time::sleep(d).await,
            Close::Panic => panic!("a close that panics"),
            Close::Hang => std::future::pending().await,
        }
    }
}

/// Whether every session in `closing` closed within `wait`; a close that panicked or was
/// cancelled did not. Past `wait` they go on closing.
async fn closed(wait: Duration, closing: Vec<JoinHandle<()>>) -> bool {
    let all = async {
        let mut ok = true;
        for c in closing {
            if let Err(e) = c.await {
                eprintln!("torrent: closing a session failed: {e}");
                ok = false;
            }
        }
        ok
    };
    match timeout(wait, all).await {
        Ok(ok) => ok,
        Err(_) => {
            eprintln!("torrent: a session took over {wait:?} to stop");
            false
        }
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
    let mut e = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(e) = e.as_ref() {
        return Ok(Arc::clone(e));
    }
    let watch = crate::vpn::watch::get()?;
    let cfg = Config {
        cache: cache_dir(app)?,
        cap: rules::CACHE_CAP,
        wait: Duration::from_secs(45),
        dht: true,
        peers: vec![],
        stop_wait: STOP_WAIT,
        close_limit: CLOSE_LIMIT,
    };
    let gate: Arc<dyn Gate> = Arc::clone(watch) as Arc<dyn Gate>;
    let started = Arc::new(Engine::new(cfg, gate).map_err(|e| e.to_string())?);
    listen(watch, &started);
    *e = Some(Arc::clone(&started));
    Ok(started)
}

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    Ok(cache.join("torrents"))
}

/// At launch: trims a cache an earlier run left over its cap, before any torrent plays. It holds
/// the engine's lock, so a first play waits for it; once a torrent has played, start() trims.
pub fn trim_at_launch(app: &tauri::AppHandle) {
    let Ok(cache) = cache_dir(app) else { return };
    std::thread::spawn(move || {
        let e = ENGINE.lock().unwrap_or_else(|e| e.into_inner());
        if e.is_none() {
            trim_idle(&cache, rules::CACHE_CAP);
        }
    });
}

/// Trims a cache no torrent is using. A cache that was never made has nothing to trim.
fn trim_idle(cache: &Path, cap: u64) {
    match rules::trim(cache, cap, |_| false) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => eprintln!("torrent: trimming the cache failed: {e}"),
    }
}

/// The engine hears every gate answer the app hears, so a drop stops its torrents.
pub fn listen(watch: &crate::vpn::watch::Watch, engine: &Arc<Engine>) {
    let hooked = Arc::clone(engine);
    watch.subscribe(Box::new(move |s| hooked.on_gate(s)));
}

/// Plays a torrent stream: `{ infoHash, fileIdx?, trackers? }` to the URL the player opens.
#[tauri::command]
pub async fn torrent_play(app: tauri::AppHandle, torrent: Want) -> Result<String, String> {
    if cfg!(windows) {
        return Err(rules::WINDOWS_OFF.into());
    }
    // The engine starts here too: building or dropping its runtime must not run in an async task.
    let run = tauri::async_runtime::spawn_blocking(move || engine(&app)?.play(&torrent));
    run.await.map_err(|e| e.to_string())?
}

/// The stream of `info_hash` stopped: the player closed it, or its start was canceled, timed out or
/// lost to another tap. A stop during a start ends that start with `STOPPED` (`Engine::stop`).
#[tauri::command]
pub async fn torrent_stop(info_hash: String) -> Result<(), String> {
    let e = ENGINE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(e) = e {
        let run = tauri::async_runtime::spawn_blocking(move || e.stop(&info_hash));
        run.await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The player's readout for the torrent of `info_hash`; none once the engine no longer runs it.
/// librqbit's stats take the torrent's locks, so it runs off the window's thread.
#[tauri::command]
pub async fn torrent_stats(info_hash: String) -> Result<Option<Stats>, String> {
    let e = ENGINE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let Some(e) = e else { return Ok(None) };
    let run = tauri::async_runtime::spawn_blocking(move || e.stats(&info_hash));
    run.await.map_err(|e| e.to_string())
}

/// The app is quitting: every torrent stops and closes its sockets.
pub fn shutdown() {
    let e = ENGINE.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if let Some(e) = e {
        e.stop_all(true);
    }
}
