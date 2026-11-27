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
use crate::vpn::GateState;
use librqbit::dht::Id20;
use librqbit::limits::LimitsConfig;
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ManagedTorrent, Session,
    SessionOptions,
};
use rules::{Want, MAX_ACTIVE, MAX_PEERS, NO_PEERS, TOO_MANY, UPLOAD_BPS};
use std::collections::HashMap;
use std::io::{self, Read, SeekFrom};
use std::net::SocketAddr;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tokio::time::{timeout, timeout_at, Instant};

/// A player read waiting on a piece gives up after this, freeing its server worker.
const READ_WAIT: Duration = Duration::from_secs(30);
/// Stopping a torrent's session (rule 6 allows 30 seconds).
const STOP_WAIT: Duration = Duration::from_secs(10);

/// What the engine asks of the VPN gate: the app's `Watch` (wired up with the app's commands), or
/// a stand-in in tests.
pub trait Gate: Send + Sync {
    fn hold(&self, id: &str) -> GateState;
    fn release(&self, id: &str);
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
    Starting,
    Running(Running),
}

struct Running {
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
    slots: Mutex<HashMap<String, Slot>>,
}

fn hold_id(hash: &str) -> String {
    format!("torrent:{hash}")
}

impl Engine {
    pub fn new(cfg: Config, gate: Arc<dyn Gate>) -> io::Result<Engine> {
        std::fs::create_dir_all(&cfg.cache)?;
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("torrent")
            .build()?;
        let server = Server::start()?;
        let slots = Mutex::default();
        Ok(Engine {
            rt,
            server,
            gate,
            cfg,
            slots,
        })
    }

    fn slots(&self) -> MutexGuard<'_, HashMap<String, Slot>> {
        self.slots.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Info hashes of the torrents running now.
    #[cfg(test)]
    pub fn running(&self) -> Vec<String> {
        let slots = self.slots();
        let running = slots.iter().filter(|(_, s)| matches!(s, Slot::Running(_)));
        running.map(|(h, _)| h.clone()).collect()
    }

    /// Starts `want` (or finds it running) and returns the URL the player opens.
    pub fn play(&self, want: &Want) -> Result<String, String> {
        if cfg!(windows) {
            return Err(rules::WINDOWS_OFF.into());
        }
        let (hash, trackers) = rules::check_want(want)?;
        {
            let mut slots = self.slots();
            match slots.get(&hash) {
                Some(Slot::Running(r)) if want.file_idx.is_none_or(|i| i == r.file) => {
                    return Ok(r.url.clone());
                }
                Some(Slot::Starting) => return Err("This torrent is still starting.".into()),
                _ => {}
            }
            if let Some(Slot::Running(r)) = slots.remove(&hash) {
                self.end(&hash, r, false);
            }
            if slots.len() >= MAX_ACTIVE {
                return Err(TOO_MANY.into());
            }
            slots.insert(hash.clone(), Slot::Starting);
        }
        let gate = self.gate.hold(&hold_id(&hash));
        let iface = match (gate.ok, gate.iface) {
            (true, Some(i)) => i,
            _ => {
                self.slots().remove(&hash);
                let msg = gate.message.unwrap_or("Turn on your VPN to play torrents");
                return Err(msg.into());
            }
        };
        let started = self
            .rt
            .block_on(self.start(&hash, &trackers, want.file_idx, &iface));
        let mut slots = self.slots();
        match (started, slots.get(&hash)) {
            // A gate failure while it started (on_gate) took the slot: it doesn't run.
            (Ok(r), Some(Slot::Starting)) => {
                let url = r.url.clone();
                slots.insert(hash, Slot::Running(r));
                Ok(url)
            }
            (r, _) => {
                if matches!(slots.get(&hash), Some(Slot::Starting)) {
                    slots.remove(&hash);
                }
                drop(slots);
                self.gate.release(&hold_id(&hash));
                match r {
                    Ok(r) => {
                        self.end(&hash, r, false);
                        Err(rules::DROPPED.into())
                    }
                    Err(e) => Err(e),
                }
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
                upload_bps: NonZeroU32::new(UPLOAD_BPS),
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
    ) -> Result<Running, String> {
        let deadline = Instant::now() + self.cfg.wait;
        let dir = self.cfg.cache.join(hash);
        let disk = |e: io::Error| format!("Flick can't write the torrent cache: {e}");
        std::fs::create_dir_all(&dir).map_err(disk)?;
        rules::touch(&dir).map_err(disk)?;
        let mut keep: Vec<String> = self.slots().keys().cloned().collect();
        keep.push(hash.to_string());
        rules::trim(&self.cfg.cache, self.cfg.cap, &keep).map_err(disk)?;
        let opts = self.session_options(iface);
        let session = Session::new_with_opts(dir.clone(), opts)
            .await
            .map_err(|e| format!("The torrent engine didn't start: {e:#}"))?;
        let run = self.fetch(&session, hash, trackers, file_idx, dir);
        let result = match timeout_at(deadline, run).await {
            Ok(r) => r,
            Err(_) => Err(NO_PEERS.to_string()),
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
    fn end(&self, hash: &str, r: Running, wait: bool) {
        self.server.remove(&r.key);
        self.gate.release(&hold_id(hash));
        let session = r.session;
        if wait {
            self.rt.block_on(stop(&session));
        } else {
            self.rt.spawn(async move { stop(&session).await });
        }
    }

    /// Playback of `hash` stopped.
    pub fn stop(&self, hash: &str) {
        let hash = hash.to_ascii_lowercase();
        let slot = self.slots().remove(&hash);
        if let Some(Slot::Running(r)) = slot {
            self.end(&hash, r, true);
        }
    }

    /// Every torrent stops (the gate failed, or the app quits).
    pub fn stop_all(&self, wait: bool) {
        let all: Vec<(String, Slot)> = self.slots().drain().collect();
        for (hash, slot) in all {
            if let Slot::Running(r) = slot {
                self.end(&hash, r, wait);
            }
        }
    }

    /// The gate's new answer: a failure stops everything; a pass on another tunnel stops the
    /// torrents bound to the old one. Runs inside the gate's hooks, so it never waits.
    pub fn on_gate(&self, s: &GateState) {
        if !s.ok {
            return self.stop_all(false);
        }
        let mut slots = self.slots();
        let moved: Vec<String> = slots
            .iter()
            .filter(|(_, slot)| match slot {
                Slot::Running(r) => s.iface.as_deref() != Some(r.iface.as_str()),
                Slot::Starting => false,
            })
            .map(|(h, _)| h.clone())
            .collect();
        for hash in moved {
            if let Some(Slot::Running(r)) = slots.remove(&hash) {
                self.end(&hash, r, false);
            }
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
