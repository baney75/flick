use flick_server::{start, Config};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::{fs, path::PathBuf};

struct Res {
    status: u16,
    head: String,
    body: Vec<u8>,
}

impl Res {
    fn header(&self, k: &str) -> Option<String> {
        let k = format!("{}:", k.to_lowercase());
        self.head
            .lines()
            .find(|l| l.to_lowercase().starts_with(&k))
            .map(|l| l[k.len()..].trim().to_string())
    }
}

fn send(port: u16, method: &str, path: &str, extra: &str) -> Res {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "{method} {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{extra}\r\n"
    )
    .unwrap();
    let mut raw = vec![];
    s.read_to_end(&mut raw).unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let status = head[9..12].parse().unwrap();
    Res {
        status,
        head,
        body: raw[split + 4..].to_vec(),
    }
}

fn setup(tag: &str) -> (flick_server::Handle, String, Vec<u8>, PathBuf) {
    let base = std::env::temp_dir().join(format!("flick-server-http-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let media = base.join("Movies");
    fs::create_dir_all(&media).unwrap();
    let bytes: Vec<u8> = (0..100_000u32).map(|i| (i % 251) as u8).collect();
    fs::write(media.join("clip.mp4"), &bytes).unwrap();
    fs::write(media.join("book.pdf"), b"%PDF").unwrap();
    let cfg = Config {
        media: vec![media],
        port: 0,
        name: "Test box".into(),
        lan: false,
        config_dir: base.join("cfg"),
        web: None,
    };
    let h = start(cfg).unwrap();
    let id = flick_server::index::item_id("Movies", "clip.mp4");
    (h, id, bytes, base)
}

#[test]
fn serves_the_contract() {
    let (h, id, bytes, base) = setup("contract");
    let (p, t) = (h.port(), h.token().to_string());
    assert_eq!(t.len(), 43);
    assert_eq!(fs::read_to_string(base.join("cfg/token")).unwrap(), t);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(base.join("cfg/token"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let auth = format!("Authorization: Bearer {t}\r\n");

    let r = send(p, "GET", "/api/info", "");
    assert_eq!(r.status, 200);
    let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(
        (v["app"].as_str(), v["v"].as_i64(), v["name"].as_str()),
        (Some("flick-server"), Some(1), Some("Test box"))
    );
    assert_eq!(
        r.header("Access-Control-Allow-Origin").as_deref(),
        Some("*")
    );
    assert_eq!(
        r.header("Access-Control-Allow-Headers").as_deref(),
        Some("Authorization, Range")
    );
    assert_eq!(
        r.header("Access-Control-Expose-Headers").as_deref(),
        Some("Content-Range, Accept-Ranges, Content-Length")
    );
    assert_eq!(
        r.header("Access-Control-Allow-Methods").as_deref(),
        Some("GET, HEAD, OPTIONS")
    );

    let r = send(p, "GET", "/api/library", "");
    assert_eq!(r.status, 401);
    assert!(serde_json::from_slice::<serde_json::Value>(&r.body).unwrap()["error"].is_string());
    assert_eq!(
        r.header("Access-Control-Allow-Origin").as_deref(),
        Some("*")
    );
    assert_eq!(send(p, "GET", "/api/library?t=wrong", "").status, 401);
    assert_eq!(send(p, "GET", &format!("/media/{id}"), "").status, 401);

    let r = send(p, "GET", "/api/library", &auth);
    assert_eq!(r.status, 200);
    let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(v["folders"], serde_json::json!(["Movies"]));
    assert_eq!(v["items"].as_array().unwrap().len(), 2);
    let clip = v["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == "clip.mp4")
        .unwrap();
    assert_eq!(
        (
            clip["id"].as_str(),
            clip["size"].as_u64(),
            clip["kind"].as_str()
        ),
        (Some(id.as_str()), Some(100_000), Some("video"))
    );
    assert!(clip.get("abs").is_none());

    fs::write(base.join("Movies/new.mp3"), b"abc").unwrap();
    let r = send(p, "GET", &format!("/api/library?rescan=1&t={t}"), "");
    assert_eq!(r.status, 200);
    let v: serde_json::Value = serde_json::from_slice(&r.body).unwrap();
    assert_eq!(v["items"].as_array().unwrap().len(), 3);

    let r = send(p, "GET", &format!("/media/{id}?t={t}"), "");
    assert_eq!(r.status, 200);
    assert_eq!(r.body, bytes);
    assert_eq!(r.header("Content-Length").as_deref(), Some("100000"));
    assert_eq!(r.header("Accept-Ranges").as_deref(), Some("bytes"));
    assert_eq!(r.header("Content-Type").as_deref(), Some("video/mp4"));
    assert!(r.header("Transfer-Encoding").is_none());

    let r = send(
        p,
        "GET",
        &format!("/media/{id}"),
        &format!("{auth}Range: bytes=40000-40099\r\n"),
    );
    assert_eq!(r.status, 206);
    assert_eq!(r.body, &bytes[40000..40100]);
    assert_eq!(
        r.header("Content-Range").as_deref(),
        Some("bytes 40000-40099/100000")
    );
    assert_eq!(r.header("Content-Length").as_deref(), Some("100"));

    let r = send(
        p,
        "GET",
        &format!("/media/{id}?t={t}"),
        "Range: bytes=-10\r\n",
    );
    assert_eq!((r.status, r.body.as_slice()), (206, &bytes[99990..]));

    let r = send(
        p,
        "GET",
        &format!("/media/{id}?t={t}"),
        "Range: bytes=200000-\r\n",
    );
    assert_eq!(r.status, 416);
    assert_eq!(r.header("Content-Range").as_deref(), Some("bytes */100000"));

    let r = send(p, "HEAD", &format!("/media/{id}?t={t}"), "");
    assert_eq!(r.status, 200);
    assert_eq!(r.header("Content-Length").as_deref(), Some("100000"));
    assert!(r.body.is_empty());

    let r = send(p, "OPTIONS", "/media/anything", "");
    assert_eq!(r.status, 204);
    assert_eq!(
        r.header("Access-Control-Allow-Methods").as_deref(),
        Some("GET, HEAD, OPTIONS")
    );

    assert_eq!(
        send(p, "GET", &format!("/media/0000000000000000?t={t}"), "").status,
        404
    );
    let r = send(p, "GET", &format!("/media/../../etc/passwd?t={t}"), "");
    assert_eq!(r.status, 404);
    assert!(!String::from_utf8_lossy(&r.body).contains("root:"));
    let r = send(p, "GET", "/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd", &auth);
    assert_eq!(r.status, 404);

    let r = send(p, "GET", "/", "");
    assert_eq!(r.status, 200);
    assert!(String::from_utf8_lossy(&r.body).contains("Flick server Test box is running"));

    h.stop();
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(TcpStream::connect(("127.0.0.1", p)).is_err());
    let _ = fs::remove_dir_all(base);
}

#[test]
fn setup_link_matches_contract() {
    use base64::Engine;
    let link = flick_server::setup_link(
        "https://flick-player.pages.dev",
        "NAS",
        "http://10.0.0.2:8740/",
        "abc",
    );
    let c = link
        .strip_prefix("https://flick-player.pages.dev/#/setup?c=")
        .unwrap();
    let json = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(c)
        .unwrap();
    let v: serde_json::Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(
        v,
        serde_json::json!({"v":1,"servers":[{"type":"flick","name":"NAS","url":"http://10.0.0.2:8740","token":"abc"}]})
    );
}

#[cfg(unix)]
#[test]
fn a_file_swapped_for_a_link_after_the_scan_is_not_served() {
    let (h, id, _, base) = setup("swap");
    let auth = format!("Authorization: Bearer {}\r\n", h.token());
    assert_eq!(
        send(h.port(), "GET", &format!("/media/{id}"), &auth).status,
        200
    );
    // After the scan, the indexed file becomes a link to a file outside every shared root.
    fs::write(base.join("secret.txt"), b"outside the share").unwrap();
    let clip = base.join("Movies/clip.mp4");
    fs::remove_file(&clip).unwrap();
    std::os::unix::fs::symlink(base.join("secret.txt"), &clip).unwrap();
    let r = send(h.port(), "GET", &format!("/media/{id}"), &auth);
    assert_eq!(r.status, 404);
    assert!(!String::from_utf8_lossy(&r.body).contains("outside the share"));
    // The same holds when a folder on the path is swapped for a link.
    fs::remove_dir_all(base.join("Movies")).unwrap();
    fs::create_dir_all(base.join("elsewhere")).unwrap();
    fs::write(base.join("elsewhere/clip.mp4"), b"outside the share").unwrap();
    std::os::unix::fs::symlink(base.join("elsewhere"), base.join("Movies")).unwrap();
    assert_eq!(
        send(h.port(), "GET", &format!("/media/{id}"), &auth).status,
        404
    );
    h.stop();
}

#[test]
fn many_requests_at_once_are_all_answered_by_the_worker_pool() {
    let (h, _, _, _) = setup("pool");
    let port = h.port();
    let clients: Vec<_> = (0..200)
        .map(|_| std::thread::spawn(move || send(port, "GET", "/api/info", "").status))
        .collect();
    assert!(clients.into_iter().all(|c| c.join().unwrap() == 200));
    h.stop();
}

#[test]
fn stop_returns_while_a_client_holds_a_large_stream_open() {
    let (h, _, _, base) = setup("stop");
    // A 256 MB file (sparse, so it costs no disk) that a client starts and then stops reading.
    let big = base.join("Movies/big.mp4");
    fs::File::create(&big).unwrap().set_len(256 << 20).unwrap();
    let auth = format!("Authorization: Bearer {}\r\n", h.token());
    assert_eq!(
        send(h.port(), "GET", "/api/library?rescan=1", &auth).status,
        200
    );
    let id = flick_server::index::item_id("Movies", "big.mp4");
    let mut s = TcpStream::connect(("127.0.0.1", h.port())).unwrap();
    write!(s, "GET /media/{id} HTTP/1.1\r\nHost: x\r\n{auth}\r\n").unwrap();
    let mut first = [0u8; 4096];
    s.read_exact(&mut first).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        h.stop();
        tx.send(()).unwrap();
    });
    assert!(
        rx.recv_timeout(std::time::Duration::from_secs(5)).is_ok(),
        "stop() hung on a stalled stream"
    );
    drop(s);
}

/// A shared folder on a drive that mounts after the server started is served once a rescan finds it,
/// and a folder already resolved stays pinned: swapping it for a link later serves nothing new.
#[cfg(unix)]
#[test]
fn a_folder_that_appears_after_start_is_served_after_a_rescan() {
    let base = std::env::temp_dir().join(format!("flick-server-http-late-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let late = base.join("Drive");
    let h = start(Config {
        media: vec![late.clone()],
        port: 0,
        name: "Test box".into(),
        lan: false,
        config_dir: base.join("cfg"),
        web: None,
    })
    .unwrap();
    let auth = format!("Authorization: Bearer {}\r\n", h.token());
    // The drive mounts.
    fs::create_dir_all(&late).unwrap();
    fs::write(late.join("clip.mp4"), b"on the late drive").unwrap();
    let lib = send(h.port(), "GET", "/api/library?rescan=1", &auth);
    assert!(String::from_utf8_lossy(&lib.body).contains("clip.mp4"));
    let id = flick_server::index::item_id("Drive", "clip.mp4");
    let r = send(h.port(), "GET", &format!("/media/{id}"), &auth);
    assert_eq!(r.status, 200);
    assert_eq!(r.body, b"on the late drive");
    // Now resolved, the folder stays pinned: swapped for a link elsewhere, nothing outside is served.
    fs::remove_dir_all(&late).unwrap();
    fs::create_dir_all(base.join("elsewhere")).unwrap();
    fs::write(base.join("elsewhere/clip.mp4"), b"outside the share").unwrap();
    std::os::unix::fs::symlink(base.join("elsewhere"), &late).unwrap();
    send(h.port(), "GET", "/api/library?rescan=1", &auth);
    assert_eq!(
        send(h.port(), "GET", &format!("/media/{id}"), &auth).status,
        404
    );
    h.stop();
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn same_file_tells_files_apart() {
    let dir = std::env::temp_dir().join(format!("flick-server-same-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("a"), b"a").unwrap();
    fs::write(dir.join("b"), b"bb").unwrap();
    let a = fs::File::open(dir.join("a")).unwrap();
    assert!(flick_server::same_file(&a, &dir.join("a")));
    assert!(!flick_server::same_file(&a, &dir.join("b")));
    let _ = fs::remove_dir_all(dir);
}
