use flick_server::{access_code, setup_link, start, Config, DEFAULT_PORT, SETUP_BASE};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const HELP: &str = "flick-server: share media folders with Flick

Usage: flick-server [--media DIR]... [--port N] [--name NAME] [--lan] [--config DIR] [--new-code]

  --media DIR   share DIR (repeat for more folders)
  --port N      port to listen on (default 8740)
  --name NAME   name Flick shows for this server (default: the hostname)
  --lan         listen on all interfaces, not just this machine
  --config DIR  settings folder (default: $FLICK_SERVER_CONFIG, else ~/.config/flick-server)
  --new-code    replace the access code
  --help        show this help

Flags are saved, so plain `flick-server` starts with the last settings.";

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    media: Vec<PathBuf>,
    name: Option<String>,
    port: Option<u16>,
    lan: bool,
}

fn default_config_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("FLICK_SERVER_CONFIG") {
        return d.into();
    }
    if cfg!(windows) {
        if let Some(d) = std::env::var_os("APPDATA") {
            return PathBuf::from(d).join("flick-server");
        }
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .unwrap_or_default();
    PathBuf::from(home).join(".config").join("flick-server")
}

fn hostname() -> String {
    let out = std::process::Command::new("hostname").output().ok();
    let name = out
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let name = name.trim_end_matches(".local").to_string();
    if name.is_empty() {
        "Flick server".into()
    } else {
        name
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let (mut media, mut port, mut name, mut lan, mut dir, mut renew) =
        (vec![], None, None, false, None, false);
    while let Some(a) = args.next() {
        let mut val = || args.next().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--media" => media.push(PathBuf::from(val()?)),
            "--port" => port = Some(val()?.parse::<u16>().map_err(|_| "--port needs a number")?),
            "--name" => name = Some(val()?),
            "--config" => dir = Some(PathBuf::from(val()?)),
            "--lan" => lan = true,
            "--new-code" => renew = true,
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(());
            }
            _ => return Err(format!("unknown argument {a}\n\n{HELP}")),
        }
    }
    let dir = dir.unwrap_or_else(default_config_dir);
    let file = dir.join("config.json");
    let mut saved: Saved = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    if !media.is_empty() {
        saved.media = media
            .iter()
            .map(|m| std::fs::canonicalize(m).unwrap_or(m.clone()))
            .collect();
    }
    saved.name = name.or(saved.name);
    saved.port = port.or(saved.port);
    saved.lan |= lan;
    if saved.media.is_empty() {
        return Err(format!("no media folders yet: pass --media DIR\n\n{HELP}"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let body = serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?;
    std::fs::write(&file, body).map_err(|e| format!("{}: {e}", file.display()))?;
    if renew {
        access_code(&dir, true)?;
        println!("Made a new access code. Old setup links no longer work.");
    }
    let name = saved.name.clone().unwrap_or_else(hostname);
    let cfg = Config {
        media: saved.media.clone(),
        port: saved.port.unwrap_or(DEFAULT_PORT),
        name: name.clone(),
        lan: saved.lan,
        config_dir: dir,
    };
    let handle = start(cfg)?;
    let mut urls = vec![handle.url()];
    if saved.lan {
        for i in if_addrs::get_if_addrs().unwrap_or_default() {
            if let std::net::IpAddr::V4(ip) = i.ip() {
                if !ip.is_loopback() {
                    urls.push(format!("http://{ip}:{}", handle.port()));
                }
            }
        }
    }
    println!("Flick server \"{name}\" is sharing:");
    for m in &saved.media {
        println!("  {}", m.display());
    }
    for u in &urls {
        println!(
            "\n{u}\n  Setup link: {}",
            setup_link(SETUP_BASE, &name, u, handle.token())
        );
    }
    println!("\nPress Ctrl-C to stop.");
    let (tx, rx) = std::sync::mpsc::channel();
    ctrlc::set_handler(move || {
        let _ = tx.send(());
    })
    .map_err(|e| e.to_string())?;
    let _ = rx.recv();
    handle.stop();
    println!("Stopped.");
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("flick-server: {e}");
        std::process::exit(1);
    }
}
