//! Reach a server from other devices: Tailscale Serve and Cloudflare quick tunnels.
//! These return results and never print, so the desktop app can call them too.
use serde_json::Value;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

pub const CLOUDFLARED_DOWNLOAD: &str =
    "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/";
const MAC_TAILSCALE: &str = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

/// Finds `name` on PATH.
pub fn which(name: &str) -> Option<PathBuf> {
    let exe = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|d| d.join(&exe))
        .find(|p| p.is_file())
}

/// `tailscale` on PATH, else the Mac app's CLI.
pub fn tailscale_cli() -> Option<PathBuf> {
    which("tailscale").or_else(|| {
        let p = Path::new(MAC_TAILSCALE);
        (cfg!(target_os = "macos") && p.is_file()).then(|| p.to_path_buf())
    })
}

/// The MagicDNS name from `tailscale status --json`, without the trailing dot.
pub fn parse_status(json: &str) -> Result<String, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| format!("tailscale status: {e}"))?;
    let state = v["BackendState"].as_str().unwrap_or("unknown");
    if state != "Running" {
        return Err(format!(
            "Tailscale is not connected (state: {state}). Sign in and connect, then try again."
        ));
    }
    match v["Self"]["DNSName"]
        .as_str()
        .map(|d| d.trim_end_matches('.'))
    {
        Some(d) if !d.is_empty() => Ok(d.to_string()),
        _ => Err(
            "Tailscale has no MagicDNS name for this machine. Turn on MagicDNS for the tailnet."
                .into(),
        ),
    }
}

#[derive(Debug, PartialEq)]
pub enum Slot {
    Free,
    /// Already proxied to this server.
    Ours,
    /// Mapped to something else, described.
    Taken(String),
}

/// What `tailscale serve status --json` maps on HTTPS `port` of `host`.
pub fn parse_serve_status(json: &str, host: &str, port: u16) -> Slot {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let target = local_target(port);
    let web = &v["Web"][format!("{host}:{port}")]["Handlers"];
    if let Some(h) = web.as_object() {
        let proxy = h.get("/").and_then(|x| x["Proxy"].as_str());
        if h.len() == 1 && proxy.map(|p| p.trim_end_matches('/')) == Some(target.as_str()) {
            return Slot::Ours;
        }
        let what: Vec<String> = h
            .iter()
            .map(|(k, x)| {
                format!(
                    "{k} -> {}",
                    x["Proxy"]
                        .as_str()
                        .or(x["Path"].as_str())
                        .or(x["Text"].as_str())
                        .unwrap_or("?")
                )
            })
            .collect();
        return Slot::Taken(what.join(", "));
    }
    match &v["TCP"][port.to_string()] {
        Value::Null => Slot::Free,
        t => Slot::Taken(
            t["TCPForward"]
                .as_str()
                .map_or("a TCP mapping".into(), |f| format!("TCP forward to {f}")),
        ),
    }
}

fn local_target(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Args for `tailscale` that map HTTPS `port` on the tailnet to this server, in the background.
pub fn serve_args(port: u16) -> Vec<String> {
    vec![
        "serve".into(),
        "--bg".into(),
        format!("--https={port}"),
        local_target(port),
    ]
}

/// Args for `tailscale` that remove only that mapping.
pub fn serve_off_args(port: u16) -> Vec<String> {
    vec!["serve".into(), format!("--https={port}"), "off".into()]
}

/// Runs a command with stdin closed, killing it after `limit`. Returns (success, stdout, stderr).
fn run(cli: &Path, args: &[String], limit: Duration) -> Result<(bool, String, String), String> {
    let mut child = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", cli.display()))?;
    let start = Instant::now();
    let status = loop {
        if let Some(s) = child.try_wait().map_err(|e| e.to_string())? {
            break s;
        }
        if start.elapsed() > limit {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "{} {} did not finish in {}s",
                cli.display(),
                args.join(" "),
                limit.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let mut out = String::new();
    let mut err = String::new();
    child.stdout.take().map(|mut o| o.read_to_string(&mut out));
    child.stderr.take().map(|mut e| e.read_to_string(&mut err));
    Ok((status.success(), out, err))
}

/// Maps `https://<dnsname>:<port>` to `http://127.0.0.1:<port>` with Tailscale Serve and returns that URL.
/// Never replaces a mapping that points elsewhere.
pub fn tailscale_serve(port: u16) -> Result<String, String> {
    let cli =
        tailscale_cli().ok_or("Tailscale is not installed: https://tailscale.com/download")?;
    let t = Duration::from_secs(20);
    let (ok, out, err) = run(&cli, &["status".into(), "--json".into()], t)?;
    if !ok && out.trim().is_empty() {
        return Err(format!("tailscale status failed: {}", err.trim()));
    }
    let host = parse_status(&out)?;
    let url = format!("https://{host}:{port}");
    let (_, out, _) = run(&cli, &["serve".into(), "status".into(), "--json".into()], t)?;
    match parse_serve_status(&out, &host, port) {
        Slot::Ours => return Ok(url),
        Slot::Taken(what) => {
            return Err(format!(
                "Tailscale already serves HTTPS port {port} ({what}). Pick another port with --port, or remove that mapping yourself."
            ))
        }
        Slot::Free => {}
    }
    let args = serve_args(port);
    let (ok, out, err) = run(&cli, &args, t)?;
    if ok {
        return Ok(url);
    }
    let mut msg = format!(
        "tailscale serve failed: {}\nRun it yourself to see more: {} {}\n\
         Common causes: HTTPS certificates are off for the tailnet (turn on HTTPS at https://login.tailscale.com/admin/dns)",
        format!("{} {}", err.trim(), out.trim()).trim(),
        cli.display(),
        args.join(" ")
    );
    if cfg!(target_os = "linux") {
        msg.push_str(
            ", or this user may not run Serve (run `sudo tailscale set --operator=$USER` once)",
        );
    }
    Err(msg + ".")
}

/// The `https://<x>.trycloudflare.com` URL in a cloudflared log line, if any.
pub fn trycloudflare_url(line: &str) -> Option<String> {
    let mut rest = line;
    while let Some(i) = rest.find("https://") {
        let tail = &rest[i..];
        let end = tail[8..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '.'))
            .map_or(tail.len(), |e| e + 8);
        let url = tail[..end].trim_end_matches('.');
        let host = &url[8..];
        if host.ends_with(".trycloudflare.com") && host != "api.trycloudflare.com" {
            return Some(url.to_string());
        }
        rest = &tail[end..];
    }
    None
}

/// A running cloudflared quick tunnel. Dropping it stops cloudflared.
pub struct Tunnel {
    pub url: String,
    child: Child,
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Starts `cloudflared tunnel --no-autoupdate --url http://127.0.0.1:<port>` and waits up to `limit` for its URL.
pub fn cloudflare_quick(port: u16, limit: Duration) -> Result<Tunnel, String> {
    let cli = which("cloudflared")
        .ok_or_else(|| format!("cloudflared is not installed: {CLOUDFLARED_DOWNLOAD}"))?;
    let mut child = Command::new(&cli)
        .args(["tunnel", "--no-autoupdate", "--url", &local_target(port)])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("{}: {e}", cli.display()))?;
    let stderr = child.stderr.take().ok_or("cloudflared: no stderr")?;
    let (tx, rx) = mpsc::channel();
    // Keeps draining stderr after the URL so cloudflared never blocks on a full pipe.
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            if let Some(u) = trycloudflare_url(&line) {
                let _ = tx.send(u);
            }
        }
    });
    let mut tunnel = Tunnel {
        url: String::new(),
        child,
    };
    match rx.recv_timeout(limit) {
        Ok(url) => {
            tunnel.url = url;
            Ok(tunnel)
        }
        Err(_) => Err(format!(
            "cloudflared gave no trycloudflare.com address within {}s",
            limit.as_secs()
        )),
    }
}
