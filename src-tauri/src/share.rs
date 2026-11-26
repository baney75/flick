// Share this computer's library with the person's other devices through the embedded flick-server.
use flick_server::{reach, Config, Handle, DEFAULT_PORT};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

/// How many ports after the first one to try when it is taken.
const PORT_TRIES: u16 = 20;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Link {
    pub label: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct ShareStatus {
    pub on: bool,
    pub local_url: Option<String>,
    pub lan_urls: Vec<String>,
    pub tailscale_url: Option<String>,
    pub tailscale_error: Option<String>,
    pub setup_links: Vec<Link>,
    pub code: Option<String>,
}

pub struct Running {
    handle: Handle,
    lan_urls: Vec<String>,
    tailscale_url: Option<String>,
    tailscale_error: Option<String>,
}

#[derive(Default)]
pub struct Share(Mutex<Option<Running>>);

/// Starts the server on `first`, or on the next free port when that one is taken.
pub fn start_on(cfg: Config, first: u16) -> Result<Handle, String> {
    let mut last = String::new();
    for port in first..first.saturating_add(PORT_TRIES) {
        match flick_server::start(Config {
            port,
            ..cfg.clone()
        }) {
            Ok(h) => return Ok(h),
            Err(e) if e.starts_with("bind ") => last = e,
            Err(e) => return Err(e),
        }
    }
    Err(last)
}

/// Setup links in the order Flick shows them: Tailscale first, then the LAN, then this computer.
pub fn links(handle: &Handle, tailscale: Option<&str>, lan: &[String]) -> Vec<Link> {
    let mut out = Vec::new();
    if let Some(t) = tailscale {
        out.push(Link {
            label: "Tailscale".into(),
            url: handle.setup_link(t),
        });
    }
    for u in lan {
        out.push(Link {
            label: format!("Wi-Fi ({})", u.trim_start_matches("http://")),
            url: handle.setup_link(u),
        });
    }
    out.push(Link {
        label: "This computer".into(),
        url: handle.setup_link(&handle.url()),
    });
    out
}

fn status_of(r: Option<&Running>) -> ShareStatus {
    let Some(r) = r else {
        return ShareStatus::default();
    };
    ShareStatus {
        on: true,
        local_url: Some(r.handle.url()),
        lan_urls: r.lan_urls.clone(),
        tailscale_url: r.tailscale_url.clone(),
        tailscale_error: r.tailscale_error.clone(),
        setup_links: links(&r.handle, r.tailscale_url.as_deref(), &r.lan_urls),
        code: Some(r.handle.token().to_string()),
    }
}

fn lan_urls(port: u16) -> Vec<String> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() => {
                Some(format!("http://{ip}:{port}"))
            }
            _ => None,
        })
        .collect()
}

fn run_cli(cli: &Path, args: &[String]) -> Option<String> {
    let out = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Removes the Tailscale mapping on `port` only when it points at this server, so a port another
/// app takes later is never exposed to the tailnet.
fn tailscale_off(port: u16) {
    let Some(cli) = reach::tailscale_cli() else {
        return;
    };
    let Some(Ok(host)) =
        run_cli(&cli, &["status".into(), "--json".into()]).map(|s| reach::parse_status(&s))
    else {
        return;
    };
    let serve = run_cli(&cli, &["serve".into(), "status".into(), "--json".into()]);
    if serve.is_some_and(|s| reach::parse_serve_status(&s, &host, port) == Ok(reach::Slot::Ours)) {
        run_cli(&cli, &reach::serve_off_args(port));
    }
}

/// Stops `r`, removing its Tailscale mapping.
fn stop_running(r: Running) {
    if r.tailscale_url.is_some() {
        tailscale_off(r.handle.port());
    }
    r.handle.stop();
}

pub fn start(
    dir: PathBuf,
    folders: Vec<String>,
    name: Option<String>,
    lan: bool,
    tailscale: bool,
) -> Result<Running, String> {
    let cfg = Config {
        media: folders.into_iter().map(PathBuf::from).collect(),
        port: DEFAULT_PORT,
        name: name
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(|| "Flick".into()),
        lan,
        config_dir: dir,
        web: None,
    };
    let handle = start_on(cfg, DEFAULT_PORT)?;
    let lan_urls = if lan { lan_urls(handle.port()) } else { vec![] };
    let (ts_url, ts_err) = if tailscale {
        match reach::tailscale_serve(handle.port()) {
            Ok(u) => (Some(u), None),
            Err(e) => (None, Some(e)),
        }
    } else {
        (None, None)
    };
    Ok(Running {
        handle,
        lan_urls,
        tailscale_url: ts_url,
        tailscale_error: ts_err,
    })
}

fn share_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("share"))
}

pub fn stop_all(app: &tauri::AppHandle) {
    if let Some(r) = app.state::<Share>().0.lock().unwrap().take() {
        stop_running(r);
    }
}

#[tauri::command]
pub async fn share_start(
    app: tauri::AppHandle,
    folders: Vec<String>,
    name: Option<String>,
    lan: bool,
    tailscale: bool,
) -> Result<ShareStatus, String> {
    let dir = share_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Share>();
        let mut slot = state.0.lock().unwrap();
        if let Some(r) = slot.take() {
            // Keep the Tailscale mapping when the new share uses it on the same port.
            if tailscale && r.tailscale_url.is_some() {
                r.handle.stop();
            } else {
                stop_running(r);
            }
        }
        *slot = Some(start(dir, folders, name, lan, tailscale)?);
        Ok(status_of(slot.as_ref()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn share_stop(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stop_all(&app))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn share_status(app: tauri::AppHandle) -> ShareStatus {
    status_of(app.state::<Share>().0.lock().unwrap().as_ref())
}

/// Replaces the access code. A running share keeps the old one until the app restarts it.
#[tauri::command]
pub fn share_new_code(app: tauri::AppHandle) -> Result<(), String> {
    flick_server::access_code(&share_dir(&app)?, true).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flick-share-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn cfg(media: Vec<PathBuf>, dir: PathBuf) -> Config {
        Config {
            media,
            port: 0,
            name: "Test".into(),
            lan: false,
            config_dir: dir,
            web: None,
        }
    }

    fn get(port: u16, path: &str, extra: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "GET {path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n{extra}\r\n"
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    #[test]
    fn port_falls_back_when_taken() {
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let p = taken.local_addr().unwrap().port();
        let h = start_on(cfg(vec![], tmp("port")), p).unwrap();
        assert_ne!(h.port(), p);
        assert!(h.port() > p && h.port() < p + PORT_TRIES);
    }

    #[test]
    fn links_put_tailscale_first() {
        let h = start_on(cfg(vec![], tmp("links")), 0).unwrap();
        let lan = vec!["http://192.168.1.5:8740".to_string()];
        let l = links(&h, Some("https://mac.tail1.ts.net:8740"), &lan);
        let labels: Vec<&str> = l.iter().map(|x| x.label.as_str()).collect();
        assert_eq!(
            labels,
            ["Tailscale", "Wi-Fi (192.168.1.5:8740)", "This computer"]
        );
        assert_eq!(l[0].url, h.setup_link("https://mac.tail1.ts.net:8740"));
        let l = links(&h, None, &[]);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].url, h.setup_link(&h.url()));
    }

    #[test]
    fn share_serves_and_stops() {
        let media = tmp("media");
        std::fs::write(media.join("Clip.mp4"), b"0123456789").unwrap();
        let r = start(
            tmp("serve"),
            vec![media.to_string_lossy().into()],
            Some("Mac".into()),
            false,
            false,
        )
        .unwrap();
        assert!(r.lan_urls.is_empty() && r.tailscale_url.is_none() && r.tailscale_error.is_none());
        let h = r.handle;
        let port = h.port();
        let info = get(port, "/api/info", "");
        assert!(info.starts_with("HTTP/1.1 200"), "{info}");
        assert!(info.contains(r#""name":"Mac""#), "{info}");
        let lib = get(port, &format!("/api/library?t={}", h.token()), "");
        let id = lib
            .split(r#""id":""#)
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        let part = get(
            port,
            &format!("/media/{id}?t={}", h.token()),
            "Range: bytes=2-5\r\n",
        );
        assert!(part.starts_with("HTTP/1.1 206"), "{part}");
        assert!(part.contains("Content-Range: bytes 2-5/10"), "{part}");
        assert!(part.ends_with("2345"), "{part}");
        h.stop();
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
    }
}
