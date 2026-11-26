use flick_server::reach::*;

const HOST: &str = "nas.tail1234.ts.net";

#[test]
fn tailscale_status() {
    let ok =
        r#"{"BackendState":"Running","Self":{"DNSName":"nas.tail1234.ts.net.","HostName":"nas"}}"#;
    assert_eq!(parse_status(ok).unwrap(), HOST);
    let stopped = r#"{"BackendState":"Stopped","Self":{"DNSName":""}}"#;
    assert!(parse_status(stopped).unwrap_err().contains("Stopped"));
    let no_dns = r#"{"BackendState":"Running","Self":{"DNSName":""}}"#;
    assert!(parse_status(no_dns).unwrap_err().contains("MagicDNS"));
    assert!(parse_status("not json").is_err());
}

#[test]
fn tailscale_serve_status() {
    // Another app on 443, nothing on 8740.
    let other = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"nas.tail1234.ts.net:443":{"Handlers":
        {"/v1/ws":{"Proxy":"http://127.0.0.1:18093/v1/ws"}}}}}"#;
    assert_eq!(parse_serve_status(other, HOST, 8740).unwrap(), Slot::Free);
    assert_eq!(parse_serve_status("{}", HOST, 8740).unwrap(), Slot::Free);
    assert_eq!(parse_serve_status("", HOST, 8740).unwrap(), Slot::Free);
    match parse_serve_status(other, HOST, 443).unwrap() {
        Slot::Taken(w) => assert!(w.contains("/v1/ws -> http://127.0.0.1:18093/v1/ws"), "{w}"),
        s => panic!("{s:?}"),
    }
    let ours = r#"{"TCP":{"443":{"HTTPS":true},"8740":{"HTTPS":true}},"Web":{
        "nas.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}},
        "nas.tail1234.ts.net:8740":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8740"}}}}}"#;
    assert_eq!(parse_serve_status(ours, HOST, 8740).unwrap(), Slot::Ours);
    let elsewhere = r#"{"TCP":{"8740":{"HTTPS":true}},"Web":{
        "nas.tail1234.ts.net:8740":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9000"}}}}}"#;
    assert_eq!(
        parse_serve_status(elsewhere, HOST, 8740).unwrap(),
        Slot::Taken("/ -> http://127.0.0.1:9000".into())
    );
    let tcp = r#"{"TCP":{"8740":{"TCPForward":"127.0.0.1:22"}}}"#;
    assert_eq!(
        parse_serve_status(tcp, HOST, 8740).unwrap(),
        Slot::Taken("TCP forward to 127.0.0.1:22".into())
    );
}

#[test]
fn tailscale_commands() {
    assert_eq!(
        serve_args(8740),
        ["serve", "--bg", "--https=8740", "http://127.0.0.1:8740"]
    );
    assert_eq!(serve_off_args(8740), ["serve", "--https=8740", "off"]);
}

#[test]
fn cloudflared_url() {
    let lines = [
        "2026-11-25T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...",
        "2026-11-25T10:00:01Z INF |  https://quiet-river-a1b2.trycloudflare.com                                  |",
        "2026-11-25T10:00:01Z INF Settings: map[url:http://127.0.0.1:8740]",
        "ERR failed to reach https://api.trycloudflare.com/tunnel",
    ];
    let found: Vec<_> = lines.iter().filter_map(|l| trycloudflare_url(l)).collect();
    assert_eq!(found, ["https://quiet-river-a1b2.trycloudflare.com"]);
    assert_eq!(
        trycloudflare_url("see https://example.com and https://a-b.trycloudflare.com."),
        Some("https://a-b.trycloudflare.com".into())
    );
}

#[test]
fn malformed_serve_status_is_an_error() {
    assert!(parse_serve_status("tailscale: not logged in", HOST, 8740).is_err());
}

#[test]
fn serve_not_enabled_gives_the_page() {
    let text = "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n";
    assert_eq!(
        serve_enable_url(text).as_deref(),
        Some("https://login.tailscale.com/f/serve?node=abc123")
    );
    assert_eq!(serve_enable_url("error: no such port"), None);
}

#[cfg(unix)]
#[test]
fn long_output_does_not_stall_and_timeout_keeps_output() {
    use std::path::Path;
    use std::time::{Duration, Instant};
    let sh = Path::new("/bin/sh");
    let start = Instant::now();
    let big = run_capture(
        sh,
        &["-c".into(), "head -c 300000 /dev/zero | tr '\\0' a".into()],
        Duration::from_secs(5),
    )
    .unwrap();
    assert_eq!(big.ok, Some(true));
    assert_eq!(big.out.len(), 300000);
    assert!(start.elapsed() < Duration::from_secs(4));
    let slow = run_capture(
        sh,
        &[
            "-c".into(),
            "echo visit https://login.tailscale.com/f/serve?x=1; sleep 30".into(),
        ],
        Duration::from_millis(500),
    )
    .unwrap();
    assert_eq!(slow.ok, None);
    assert!(slow.out.contains("login.tailscale.com"));
}
