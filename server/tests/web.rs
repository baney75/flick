use flick_server::{start, Config};
use std::fs;
use std::io::{Read, Write};
use std::net::TcpStream;

fn get(port: u16, path: &str) -> (u16, String, Vec<u8>) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut raw = vec![];
    s.read_to_end(&mut raw).unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
    let head = String::from_utf8_lossy(&raw[..split]).to_lowercase();
    (
        head[9..12].parse().unwrap(),
        head,
        raw[split + 4..].to_vec(),
    )
}

fn has(head: &str, line: &str) -> bool {
    head.lines().any(|l| l.trim() == line.to_lowercase())
}

#[test]
fn serves_the_web_app_and_stays_inside_it() {
    let base = std::env::temp_dir().join(format!("flick-server-web-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    let web = base.join("site");
    fs::create_dir_all(web.join("assets")).unwrap();
    fs::create_dir_all(base.join("media")).unwrap();
    fs::write(web.join("index.html"), "<!doctype html>flick app").unwrap();
    fs::write(web.join("assets/x.js"), "console.log(1)").unwrap();
    fs::write(web.join("site.webmanifest"), "{}").unwrap();
    fs::write(base.join("secret"), "top secret").unwrap();
    let h = start(Config {
        media: vec![base.join("media")],
        port: 0,
        name: "Web box".into(),
        lan: false,
        config_dir: base.join("cfg"),
        web: Some(web),
    })
    .unwrap();
    let p = h.port();

    let (s, head, body) = get(p, "/");
    assert_eq!(
        (s, body.as_slice()),
        (200, &b"<!doctype html>flick app"[..])
    );
    assert!(has(&head, "Content-Type: text/html; charset=utf-8"));
    assert!(has(&head, "Cache-Control: no-cache"));

    let (s, head, body) = get(p, "/assets/x.js?v=1");
    assert_eq!((s, body.as_slice()), (200, &b"console.log(1)"[..]));
    assert!(has(&head, "Content-Type: text/javascript; charset=utf-8"));
    assert!(has(
        &head,
        "Cache-Control: public, max-age=31536000, immutable"
    ));

    let (_, head, _) = get(p, "/site.webmanifest");
    assert!(has(&head, "Content-Type: application/manifest+json"));

    let (s, head, body) = get(p, "/library/show/42");
    assert_eq!(
        (s, body.as_slice()),
        (200, &b"<!doctype html>flick app"[..])
    );
    assert!(has(&head, "Cache-Control: no-cache"));

    for evil in [
        "/../secret",
        "/%2e%2e/secret",
        "/assets/%2E%2E/%2e%2e/secret",
        "/..%2fsecret",
        "/assets/..%5c..%5csecret",
    ] {
        let (_, _, body) = get(p, evil);
        assert!(
            !String::from_utf8_lossy(&body).contains("top secret"),
            "{evil} leaked the file"
        );
    }

    let (s, _, _) = get(p, "/api/library");
    assert_eq!(s, 401);
    let (s, _, body) = get(p, "/api/nope");
    assert_eq!(s, 401, "{}", String::from_utf8_lossy(&body));

    assert!(h.serves_web());
    let url = "https://nas.tail1234.ts.net:8740";
    assert!(h.setup_link(url).starts_with(&format!("{url}/#/setup?c=")));
    h.stop();
    let _ = fs::remove_dir_all(&base);
}

#[cfg(not(feature = "embed-web"))]
#[test]
fn setup_link_uses_the_hosted_app_without_a_web_app() {
    let base = std::env::temp_dir().join(format!("flick-server-noweb-{}", std::process::id()));
    fs::create_dir_all(base.join("media")).unwrap();
    let h = start(Config {
        media: vec![base.join("media")],
        port: 0,
        name: "Plain".into(),
        lan: false,
        config_dir: base.join("cfg"),
        web: None,
    })
    .unwrap();
    assert!(!h.serves_web());
    assert!(h
        .setup_link("https://x.example")
        .starts_with(&format!("{}/#/setup?c=", flick_server::SETUP_BASE)));
    let (s, _, body) = get(h.port(), "/anything");
    assert_eq!(s, 200);
    assert!(String::from_utf8_lossy(&body).contains("is running"));
    h.stop();
    let _ = fs::remove_dir_all(&base);
}

#[test]
fn safe_path_rejects_escapes() {
    use flick_server::web::safe_path;
    assert_eq!(safe_path("/").as_deref(), Some(""));
    assert_eq!(
        safe_path("/assets//a%20b.js").as_deref(),
        Some("assets/a b.js")
    );
    for bad in [
        "/..",
        "/a/../b",
        "/%2e%2e/x",
        "/a%2f..%2fb",
        "/C:/x",
        "/a%5cb",
        "/%00",
        "/%zz",
        "/%ff",
    ] {
        assert_eq!(safe_path(bad), None, "{bad}");
    }
}
