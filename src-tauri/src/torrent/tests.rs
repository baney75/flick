// The engine against a second librqbit session seeding on this computer's loopback interface.

use super::rules;
use super::rules::tests::{tmp, want, HASH, PIECE};
use super::{Config, Engine, Gate};
use crate::vpn::{Fail, GateState};
use librqbit::{CreateTorrentOptions, ListenerMode, ListenerOptions, Session, SessionOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock, Weak};
use std::time::Duration;

const LOOPBACK: &str = if cfg!(target_os = "macos") {
    "lo0"
} else {
    "lo"
};

/// A gate that passes on `iface` (or fails with no VPN), records its holds, and can run a step
/// inside `hold` (a VPN drop while a torrent starts).
#[derive(Default)]
struct Fake {
    iface: Mutex<Option<String>>,
    held: Mutex<Vec<String>>,
    engine: OnceLock<Weak<Engine>>,
    drop_on_hold: Mutex<bool>,
}

impl Fake {
    fn passing() -> Arc<Fake> {
        let f = Fake::default();
        *f.iface.lock().unwrap() = Some(LOOPBACK.into());
        Arc::new(f)
    }
    fn held(&self) -> Vec<String> {
        self.held.lock().unwrap().clone()
    }
}

fn failed() -> GateState {
    GateState::fail(Fail::NoVpn)
}

impl Gate for Fake {
    fn hold(&self, id: &str) -> GateState {
        let Some(iface) = self.iface.lock().unwrap().clone() else {
            return failed();
        };
        self.held.lock().unwrap().push(id.into());
        if std::mem::take(&mut *self.drop_on_hold.lock().unwrap()) {
            let e = self.engine.get().and_then(Weak::upgrade).unwrap();
            e.on_gate(&failed());
        }
        GateState::pass(iface, "203.0.113.9".parse().unwrap())
    }
    fn release(&self, id: &str) {
        self.held.lock().unwrap().retain(|h| h != id);
    }
}

/// A second librqbit session seeding files from `dir` on 127.0.0.1, with no DHT and no LAN
/// discovery, so the engine can reach only it.
struct Seeder {
    rt: tokio::runtime::Runtime,
    session: Arc<Session>,
    dir: PathBuf,
}

impl Seeder {
    fn new(tag: &str) -> Seeder {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let dir = tmp(&format!("seed-{tag}"));
        let opts = SessionOptions {
            dht: None,
            listen: Some(ListenerOptions {
                mode: ListenerMode::TcpOnly,
                listen_addr: "127.0.0.1:0".parse().unwrap(),
                enable_upnp_port_forwarding: false,
                ..Default::default()
            }),
            persistence: None,
            fastresume: false,
            disable_local_service_discovery: true,
            ..Default::default()
        };
        let session = rt
            .block_on(Session::new_with_opts(dir.clone(), opts))
            .unwrap();
        Seeder { rt, session, dir }
    }

    fn addr(&self) -> SocketAddr {
        self.session.listen_addr().unwrap()
    }

    /// Seeds one file and returns its info hash.
    fn seed(&self, name: &str, body: &[u8]) -> String {
        let sub = self.dir.join(name.replace('.', "-"));
        std::fs::create_dir_all(&sub).unwrap();
        let path = sub.join(name);
        std::fs::write(&path, body).unwrap();
        let opts = CreateTorrentOptions {
            name: None,
            trackers: vec![],
            piece_length: Some(PIECE as u32),
        };
        let made = self
            .rt
            .block_on(self.session.create_and_serve_torrent(&path, opts));
        made.unwrap().0.info_hash().as_string()
    }
}

impl Drop for Seeder {
    fn drop(&mut self) {
        self.rt.block_on(self.session.stop());
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn body(len: usize, salt: u8) -> Vec<u8> {
    (0..len)
        .map(|i| ((i * 31 + usize::from(salt)) % 251) as u8)
        .collect()
}

fn engine(tag: &str, gate: &Arc<Fake>, peers: Vec<SocketAddr>, wait: Duration) -> Arc<Engine> {
    let cfg = Config {
        cache: tmp(&format!("cache-{tag}")),
        cap: rules::CACHE_CAP,
        wait,
        dht: false,
        peers,
    };
    let e = Arc::new(Engine::new(cfg, Arc::clone(gate) as Arc<dyn Gate>).unwrap());
    let _ = gate.engine.set(Arc::downgrade(&e));
    e
}

/// GET `url` (or another path on its server) with `extra` header lines: status and body.
fn get(url: &str, path: Option<&str>, extra: &str) -> (u16, Vec<u8>) {
    let rest = url.strip_prefix("http://").unwrap();
    let (host, own) = rest.split_once('/').unwrap();
    let path = path.map_or_else(|| format!("/{own}"), str::to_string);
    let mut c = TcpStream::connect(host).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(60))).unwrap();
    let req = format!("GET {path} HTTP/1.1\r\nHost: {host}\r\n{extra}Connection: close\r\n\r\n");
    c.write_all(req.as_bytes()).unwrap();
    let mut raw = vec![];
    c.read_to_end(&mut raw).unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, raw[split + 4..].to_vec())
}

#[test]
fn a_seeded_torrent_plays_from_the_local_url_with_ranges_and_stops() {
    let seeder = Seeder::new("play");
    let movie = body(3 << 20, 1);
    let hash = seeder.seed("movie.mp4", &movie);
    let gate = Fake::passing();
    let e = engine("play", &gate, vec![seeder.addr()], Duration::from_secs(30));

    let url = e.play(&want(&hash.to_ascii_uppercase(), &[])).unwrap();
    assert!(url.starts_with("http://127.0.0.1:"), "{url}");
    assert!(url.ends_with(&format!("/{hash}/0")), "{url}");
    assert_eq!(e.running(), std::slice::from_ref(&hash));
    assert_eq!(gate.held(), [format!("torrent:{hash}")]);
    assert_eq!(
        e.play(&want(&hash, &[])).unwrap(),
        url,
        "a second play reuses the stream"
    );

    let (status, got) = get(&url, None, "Range: bytes=-1024\r\n");
    assert_eq!(status, 206);
    assert_eq!(got, movie[movie.len() - 1024..]);
    let (status, got) = get(&url, None, "Range: bytes=1048576-1049599\r\n");
    assert_eq!(status, 206);
    assert_eq!(got, movie[1 << 20..(1 << 20) + 1024]);

    let (_, own) = url.split_once("127.0.0.1:").unwrap();
    let (_, path) = own.split_once('/').unwrap();
    let (_, key) = path.split_once('/').unwrap();
    assert_eq!(get(&url, Some(&format!("/{key}")), "").0, 403, "no token");
    let other = url.replace(&format!("/{hash}/0"), &format!("/{hash}/1"));
    assert_eq!(get(&other, None, "").0, 404, "another file");

    let started = std::time::Instant::now();
    e.stop(&hash.to_ascii_uppercase());
    assert!(started.elapsed() < Duration::from_secs(30));
    assert!(e.running().is_empty());
    assert!(gate.held().is_empty());
    assert_eq!(get(&url, None, "").0, 404, "stopped");
    assert!(e.cfg.cache.join(&hash).is_dir(), "pieces stay in the cache");
}

#[test]
fn a_torrent_with_no_peers_gives_up_with_the_no_peers_message() {
    // A peer that takes the connection and never answers, as DHT and trackers do in the app.
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let peer = silent.local_addr().unwrap();
    let gate = Fake::passing();
    let e = engine("nopeers", &gate, vec![peer], Duration::from_secs(2));
    let started = std::time::Instant::now();
    assert_eq!(e.play(&want(HASH, &[])), Err(rules::NO_PEERS.into()));
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(e.running().is_empty());
    assert!(gate.held().is_empty(), "the hold ends with the torrent");
    assert!(
        e.play(&want(HASH, &[])).is_err(),
        "a retry starts over, not 'still starting'"
    );
}

#[test]
fn with_the_gate_failing_nothing_starts() {
    let gate = Arc::new(Fake::default());
    let e = engine("closed", &gate, vec![], Duration::from_secs(2));
    let msg = Fail::NoVpn.message();
    assert_eq!(e.play(&want(HASH, &[])), Err(msg.into()));
    assert!(e.running().is_empty());
    assert!(
        !e.cfg.cache.join(HASH).exists(),
        "no cache folder, no session"
    );
}

#[test]
fn a_gate_failure_stops_every_torrent_and_a_new_tunnel_stops_the_old_ones() {
    let seeder = Seeder::new("gate");
    let a = seeder.seed("a.mp4", &body(200_000, 2));
    let b = seeder.seed("b.mp4", &body(200_000, 3));
    let gate = Fake::passing();
    let e = engine("gate", &gate, vec![seeder.addr()], Duration::from_secs(30));
    let url = e.play(&want(&a, &[])).unwrap();
    e.play(&want(&b, &[])).unwrap();
    assert_eq!(e.running().len(), 2);

    e.on_gate(&GateState::pass(
        LOOPBACK.into(),
        "203.0.113.9".parse().unwrap(),
    ));
    assert_eq!(e.running().len(), 2, "the same tunnel keeps playing");

    let started = std::time::Instant::now();
    e.on_gate(&failed());
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "on_gate never waits"
    );
    assert!(e.running().is_empty());
    assert!(gate.held().is_empty());
    assert_eq!(get(&url, None, "").0, 404);

    e.play(&want(&a, &[])).unwrap();
    e.on_gate(&GateState::pass(
        "utun9".into(),
        "203.0.113.9".parse().unwrap(),
    ));
    assert!(
        e.running().is_empty(),
        "a torrent bound to the old tunnel stops"
    );
}

#[test]
fn a_vpn_drop_while_a_torrent_starts_stops_it() {
    let seeder = Seeder::new("drop");
    let hash = seeder.seed("movie.mp4", &body(200_000, 4));
    let gate = Fake::passing();
    let e = engine("drop", &gate, vec![seeder.addr()], Duration::from_secs(30));
    *gate.drop_on_hold.lock().unwrap() = true;
    assert_eq!(e.play(&want(&hash, &[])), Err(rules::DROPPED.into()));
    assert!(e.running().is_empty());
    assert!(gate.held().is_empty());
}

#[test]
fn at_most_three_torrents_play_at_once() {
    let seeder = Seeder::new("three");
    let gate = Fake::passing();
    let e = engine("three", &gate, vec![seeder.addr()], Duration::from_secs(30));
    for i in 0..3u8 {
        let hash = seeder.seed(&format!("m{i}.mp4"), &body(100_000, 10 + i));
        e.play(&want(&hash, &[])).unwrap();
    }
    assert_eq!(e.play(&want(HASH, &[])), Err(rules::TOO_MANY.into()));
    assert_eq!(e.running().len(), 3);
    assert_eq!(
        gate.held().len(),
        3,
        "the refused torrent never asked the gate"
    );
}

#[test]
fn a_torrent_whose_only_file_is_not_media_is_refused_before_download() {
    let seeder = Seeder::new("notmedia");
    let hash = seeder.seed("setup.exe", &body(100_000, 5));
    let gate = Fake::passing();
    let e = engine(
        "notmedia",
        &gate,
        vec![seeder.addr()],
        Duration::from_secs(30),
    );
    let err = e.play(&want(&hash, &[])).unwrap_err();
    assert!(err.contains("no video"), "{err}");
    let written = walkdir::WalkDir::new(e.cfg.cache.join(&hash))
        .into_iter()
        .filter_map(Result::ok)
        .any(|f| f.file_type().is_file() && f.file_name() == "setup.exe");
    assert!(!written, "nothing of the refused file was written");
    assert!(gate.held().is_empty());
}

#[cfg(windows)]
#[test]
fn windows_plays_torrents_through_debrid_only() {
    let gate = Fake::passing();
    let e = engine("windows", &gate, vec![], Duration::from_secs(2));
    assert_eq!(e.play(&want(HASH, &[])), Err(rules::WINDOWS_OFF.into()));
}
