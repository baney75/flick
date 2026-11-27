// The engine against a second librqbit session seeding on this computer's loopback interface.

use super::rules;
use super::rules::tests::{folder, tmp, want, HASH, PIECE};
use super::{closed, trim_idle, Close, Config, Engine, Gate, CLOSE_LIMIT, STOPPING, STOP_WAIT};
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

type Step = Box<dyn FnOnce(&Engine) + Send>;

/// A gate that passes on `iface` (or fails with no VPN), records its holds, and can run a step
/// inside `hold` (a VPN drop or a stop while a torrent starts).
#[derive(Default)]
struct Fake {
    iface: Mutex<Option<String>>,
    held: Mutex<Vec<String>>,
    engine: OnceLock<Weak<Engine>>,
    on_hold: Mutex<Option<Step>>,
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
        let step = self.on_hold.lock().unwrap().take();
        if let Some(step) = step {
            step(&self.engine.get().and_then(Weak::upgrade).unwrap());
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

    /// Seeds a folder of `files` as one torrent and returns its info hash.
    fn seed_dir(&self, name: &str, files: &[(&str, Vec<u8>)]) -> String {
        let sub = self.dir.join(name);
        std::fs::create_dir_all(&sub).unwrap();
        for (file, body) in files {
            std::fs::write(sub.join(file), body).unwrap();
        }
        let opts = CreateTorrentOptions {
            name: None,
            trackers: vec![],
            piece_length: Some(PIECE as u32),
        };
        let made = self
            .rt
            .block_on(self.session.create_and_serve_torrent(&sub, opts));
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
    engine_with(tag, gate, peers, wait, STOP_WAIT, CLOSE_LIMIT)
}

fn engine_with(
    tag: &str,
    gate: &Arc<Fake>,
    peers: Vec<SocketAddr>,
    wait: Duration,
    stop_wait: Duration,
    close_limit: Duration,
) -> Arc<Engine> {
    let cfg = Config {
        cache: tmp(&format!("cache-{tag}")),
        cap: rules::CACHE_CAP,
        wait,
        dht: false,
        peers,
        stop_wait,
        close_limit,
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
    let stats = e
        .stats(&hash.to_ascii_uppercase())
        .expect("a running torrent has stats");
    assert!(stats.peers <= 1, "{stats:?}");
    assert_eq!(gate.held(), [format!("torrent:{hash}:1")]);
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
    // A file the torrent doesn't have leaves the one that plays alone.
    let mut missing = want(&hash, &[]);
    missing.file_idx = Some(5);
    assert_eq!(e.play(&missing), Err("This torrent has no file 5.".into()));
    assert_eq!(
        get(&url, None, "Range: bytes=0-9\r\n").0,
        206,
        "still playing"
    );

    let started = std::time::Instant::now();
    e.stop(&hash.to_ascii_uppercase());
    assert!(started.elapsed() < Duration::from_secs(30));
    assert!(e.running().is_empty());
    assert!(e.stats(&hash).is_none(), "no stats once stopped");
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
    // The app's commands call play on a blocking thread of their async runtime.
    let rt = tokio::runtime::Runtime::new().unwrap();
    let e2 = Arc::clone(&e);
    let got = rt.block_on(rt.spawn_blocking(move || e2.play(&want(HASH, &[]))));
    assert_eq!(got.unwrap(), Err(rules::NO_PEERS.into()));
    assert!(started.elapsed() < Duration::from_secs(15));
    assert!(e.running().is_empty());
    assert!(gate.held().is_empty(), "the hold ends with the torrent");
    assert_eq!(
        e.play(&want(HASH, &[])),
        Err(rules::NO_PEERS.into()),
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
    // Their sessions close in the background; a new play waits for that.
    wait_until(|| gate.held().is_empty() && e.table().closing.is_empty());
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
    *gate.on_hold.lock().unwrap() = Some(Box::new(|e| e.on_gate(&failed())));
    assert_eq!(e.play(&want(&hash, &[])), Err(rules::DROPPED.into()));
    assert!(e.running().is_empty());
    assert!(
        !e.cfg.cache.join(&hash).exists(),
        "a start ended inside its hold opens no session"
    );
    wait_until(|| gate.held().is_empty());

    // A new tunnel the engine hears before the start knows its own: the start still stops.
    let utun9 = || GateState::pass("utun9".into(), "203.0.113.9".parse().unwrap());
    *gate.on_hold.lock().unwrap() = Some(Box::new(move |e| e.on_gate(&utun9())));
    assert_eq!(e.play(&want(&hash, &[])), Err(rules::DROPPED.into()));
    assert!(e.running().is_empty());
    wait_until(|| gate.held().is_empty());

    // Every torrent stopping (a quit) ends a start whose hold just passed.
    *gate.on_hold.lock().unwrap() = Some(Box::new(|e| e.stop_all(false)));
    assert_eq!(e.play(&want(&hash, &[])), Err(rules::DROPPED.into()));
    assert!(e.running().is_empty());
    wait_until(|| gate.held().is_empty());

    // The same tunnel again changes nothing.
    let lo = || GateState::pass(LOOPBACK.into(), "203.0.113.9".parse().unwrap());
    *gate.on_hold.lock().unwrap() = Some(Box::new(move |e| e.on_gate(&lo())));
    assert!(e.play(&want(&hash, &[])).is_ok());
    assert_eq!(e.running(), vec![hash]);
}

/// Waits up to 10 seconds for `ok`.
fn wait_until(ok: impl Fn() -> bool) {
    let until = std::time::Instant::now() + Duration::from_secs(10);
    while !ok() {
        assert!(std::time::Instant::now() < until, "timed out");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn a_stop_while_a_torrent_starts_ends_that_start_and_a_new_play_runs_on_its_own_hold() {
    let seeder = Seeder::new("stopstart");
    let hash = seeder.seed("movie.mp4", &body(200_000, 6));
    let gate = Fake::passing();
    let e = engine(
        "stopstart",
        &gate,
        vec![seeder.addr()],
        Duration::from_secs(30),
    );
    let h = hash.clone();
    *gate.on_hold.lock().unwrap() = Some(Box::new(move |e| e.stop(&h)));
    let msg = "Playback stopped before the torrent started.";
    assert_eq!(e.play(&want(&hash, &[])), Err(msg.into()));
    assert!(e.running().is_empty() && e.starting().is_empty());
    assert!(gate.held().is_empty());

    let url = e.play(&want(&hash, &[])).unwrap();
    assert_eq!(e.running(), vec![hash.clone()]);
    assert_eq!(gate.held().len(), 1, "one hold, the running torrent's own");
    assert_eq!(get(&url, None, "Range: bytes=0-9\r\n").0, 206);
}

#[test]
fn a_stop_or_a_vpn_drop_cuts_a_start_short() {
    let silent = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let gate = Fake::passing();
    let e = engine(
        "cut",
        &gate,
        vec![silent.local_addr().unwrap()],
        Duration::from_secs(60),
    );
    type Cut = fn(&Engine);
    let cuts: [(Cut, &str); 2] = [
        (
            |e| e.stop(HASH),
            "Playback stopped before the torrent started.",
        ),
        (|e| e.on_gate(&failed()), rules::DROPPED),
    ];
    for (cut, msg) in cuts {
        let started = std::time::Instant::now();
        let e2 = Arc::clone(&e);
        let play = std::thread::spawn(move || e2.play(&want(HASH, &[])));
        wait_until(|| !gate.held().is_empty());
        assert_eq!(
            e.play(&want(HASH, &[])),
            Err("This torrent is still starting.".into())
        );
        cut(&e);
        assert_eq!(play.join().unwrap(), Err(msg.into()));
        assert!(started.elapsed() < Duration::from_secs(5), "{msg}");
        assert!(e.starting().is_empty());
        wait_until(|| gate.held().is_empty());
    }
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
    // Quitting closes them all together: three 2 second closes, one after another, take 6.
    *e.stall.lock().unwrap() = Close::Stall(Duration::from_secs(2));
    let started = std::time::Instant::now();
    e.stop_all(true);
    let took = started.elapsed();
    assert!(
        took >= Duration::from_secs(2) && took < Duration::from_secs(4),
        "{took:?}"
    );
    assert!(e.running().is_empty());
    assert!(gate.held().is_empty());
}

#[test]
fn a_session_slow_to_close_keeps_its_torrent_refused_until_it_has() {
    let seeder = Seeder::new("slow");
    let files = [("e1.mp4", body(200_000, 21)), ("e2.mp4", body(200_000, 22))];
    let hash = seeder.seed_dir("show", &files);
    let gate = Fake::passing();
    let quick = Duration::from_millis(300);
    let e = engine_with(
        "slow",
        &gate,
        vec![seeder.addr()],
        Duration::from_secs(30),
        quick,
        CLOSE_LIMIT,
    );
    let file = |i| {
        let mut w = want(&hash, &[]);
        w.file_idx = Some(i);
        w
    };
    let closing = || !e.table().closing.is_empty();
    e.play(&file(0)).unwrap();
    // Each session now takes 2 seconds to close, past the 300 ms a stop waits for it.
    *e.stall.lock().unwrap() = Close::Stall(Duration::from_secs(2));
    let stopping = Err(STOPPING.to_string());
    assert_eq!(
        e.play(&file(1)),
        stopping,
        "another file waits for the old session"
    );
    assert!(e.running().is_empty() && e.starting().is_empty());
    assert!(gate.held().is_empty());
    assert_eq!(
        e.play(&file(1)),
        stopping,
        "Play again while it still closes"
    );
    wait_until(|| !closing());
    let url = e.play(&file(1)).unwrap();
    assert!(url.ends_with(&format!("/{hash}/1")), "{url}");

    // A stop that outlasts its wait leaves the torrent closing the same way.
    e.stop(&hash);
    assert!(closing());
    assert_eq!(e.play(&file(1)), stopping);
    wait_until(|| !closing());
    *e.stall.lock().unwrap() = Close::Now;
    assert!(e.play(&file(1)).is_ok());
}

#[test]
fn a_close_that_panics_lets_its_torrent_play_again() {
    let seeder = Seeder::new("panic");
    let hash = seeder.seed("p.mp4", &body(100_000, 31));
    let gate = Fake::passing();
    let e = engine("panic", &gate, vec![seeder.addr()], Duration::from_secs(30));
    e.play(&want(&hash, &[])).unwrap();
    *e.stall.lock().unwrap() = Close::Panic;
    e.stop(&hash);
    assert!(e.table().closing.is_empty(), "the panic took its mark");
    *e.stall.lock().unwrap() = Close::Now;
    assert!(e.play(&want(&hash, &[])).is_ok());
    assert!(fresh(&e, &hash), "the next session opened a fresh folder");
}

/// Whether `hash`'s file was written under a fresh subfolder, away from the abandoned session's.
fn fresh(e: &Engine, hash: &str) -> bool {
    walkdir::WalkDir::new(e.cfg.cache.join(hash))
        .into_iter()
        .filter_map(Result::ok)
        .any(|f| {
            f.file_type().is_file()
                && f.path()
                    .components()
                    .any(|c| c.as_os_str().to_string_lossy().starts_with(".flick-"))
        })
}

#[test]
fn a_close_that_never_returns_lets_its_torrent_play_after_the_limit() {
    let seeder = Seeder::new("hang");
    let hash = seeder.seed("h.mp4", &body(100_000, 32));
    let gate = Fake::passing();
    let limit = Duration::from_secs(1);
    let e = engine_with(
        "hang",
        &gate,
        vec![seeder.addr()],
        Duration::from_secs(30),
        Duration::from_millis(200),
        limit,
    );
    e.play(&want(&hash, &[])).unwrap();
    *e.stall.lock().unwrap() = Close::Hang;
    let started = std::time::Instant::now();
    e.stop(&hash);
    assert_eq!(e.play(&want(&hash, &[])), Err(STOPPING.to_string()));
    wait_until(|| e.table().closing.is_empty());
    assert!(started.elapsed() >= limit, "{:?}", started.elapsed());
    *e.stall.lock().unwrap() = Close::Now;
    assert!(e.play(&want(&hash, &[])).is_ok());
    assert!(fresh(&e, &hash), "the next session opened a fresh folder");
    // A close that finishes keeps the folder it has; only a given-up close moves the next one.
    let quiet = Seeder::new("quiet");
    let other = quiet.seed("q.mp4", &body(100_000, 33));
    let calm = Fake::passing();
    let f = engine("quiet", &calm, vec![quiet.addr()], Duration::from_secs(30));
    f.play(&want(&other, &[])).unwrap();
    f.stop(&other);
    assert!(f.play(&want(&other, &[])).is_ok());
    assert!(!fresh(&f, &other));
}

#[test]
fn a_close_that_panicked_did_not_close() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let wait = Duration::from_secs(5);
    let ok = rt.block_on(closed(wait, vec![rt.spawn(async {})]));
    assert!(ok);
    let failed = rt.block_on(closed(wait, vec![rt.spawn(async { panic!("close") })]));
    assert!(!failed, "a panicked close counts as not closed");
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

/// Bytes that no filesystem compresses, so what a folder holds on disk matches its length.
fn noise(len: usize, salt: u32) -> Vec<u8> {
    let mut x: u32 = 0x9e37_79b9 ^ salt;
    (0..len)
        .map(|_| {
            x = x.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (x >> 24) as u8
        })
        .collect()
}

/// Audit F4: a torrent that grows past the cap while it plays is trimmed back under it when it
/// stops, oldest folder first, not only at the next start.
#[test]
fn a_stop_trims_the_cache_back_under_its_cap() {
    let seeder = Seeder::new("trimstop");
    let movie = noise(3 << 20, 7);
    let hash = seeder.seed("movie.mp4", &movie);
    let gate = Fake::passing();
    let cfg = Config {
        cache: tmp("cache-trimstop"),
        // Room for the movie, not for the movie and the older torrent.
        cap: (3 << 20) + (512 << 10),
        wait: Duration::from_secs(30),
        dht: false,
        peers: vec![seeder.addr()],
        stop_wait: STOP_WAIT,
        close_limit: CLOSE_LIMIT,
    };
    let old = folder(&cfg.cache, &"a".repeat(40), 1024, 300);
    let e = Arc::new(Engine::new(cfg, Arc::clone(&gate) as Arc<dyn Gate>).unwrap());
    let _ = gate.engine.set(Arc::downgrade(&e));

    let url = e.play(&want(&hash, &[])).unwrap();
    assert!(
        old.is_dir(),
        "the cache was under its cap when the torrent started"
    );
    let (status, got) = get(&url, None, "");
    assert_eq!(status, 200);
    assert!(got == movie, "the whole movie came down");
    assert!(old.is_dir(), "nothing trims while the torrent plays");
    e.stop(&hash);
    wait_until(|| !old.exists());
    assert!(
        e.cfg.cache.join(&hash).is_dir(),
        "the torrent that stopped stays cached"
    );
}

/// Audit F4: at launch a cache an earlier run left over its cap trims, and a cache never made is
/// no error.
#[test]
fn the_launch_trim_takes_the_cache_back_under_its_cap() {
    let cache = tmp("cache-launch");
    let (old, new) = ("a".repeat(40), "b".repeat(40));
    let old_dir = folder(&cache, &old, 64, 300);
    let new_dir = folder(&cache, &new, 64, 100);
    trim_idle(&cache, 100 << 10);
    assert!(!old_dir.exists() && new_dir.is_dir());
    std::fs::remove_dir_all(&cache).unwrap();
    trim_idle(&cache, 0);
}
