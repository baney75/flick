use flick_server::{access_code, reach, service, start, Config, DEFAULT_PORT, SETUP_BASE};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const HELP: &str = "flick-server: share media folders with Flick

Usage: flick-server [--media DIR]... [--port N] [--name NAME] [--lan | --local] [--web DIR | --no-web]
                    [--tailscale] [--cloudflare] [--public-url URL | --no-public-url] [--config DIR] [--new-code]
                    [--install | --uninstall]

  --media DIR   share DIR (repeat for more folders)
  --port N      port to listen on (default 8740)
  --name NAME   name Flick shows for this server (default: the hostname)
  --lan         listen on all interfaces, not just this machine (remembered)
  --local       listen on this machine only again (the default)
  --web DIR     serve the Flick web app from DIR (remembered; default: the built-in copy, if any)
  --no-web      forget --web
  --tailscale   reach this server at https://<machine>.<tailnet>.ts.net:<port> with Tailscale Serve
  --cloudflare  open a Cloudflare quick tunnel (a new trycloudflare.com address each run)
  --public-url URL  address of your own named tunnel or reverse proxy, for the setup link (remembered)
  --no-public-url   forget --public-url
  --config DIR  settings folder (default: $FLICK_SERVER_CONFIG, else ~/.config/flick-server)
  --new-code    replace the access code
  --install     save the settings, then start this server at login (and now) in the background
  --uninstall   stop the background server and remove it from login
  --help        show this help

Flags marked remembered are saved, as are --media, --port and --name, so plain
`flick-server` starts with the last settings. --tailscale and --cloudflare apply to one run.";

#[derive(Serialize, Deserialize, Default)]
struct Saved {
    media: Vec<PathBuf>,
    name: Option<String>,
    port: Option<u16>,
    lan: bool,
    #[serde(default)]
    web: Option<PathBuf>,
    #[serde(default)]
    public_url: Option<String>,
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
        (vec![], None, None, None, None, false);
    let (mut web, mut public_url, mut tailscale, mut cloudflare) = (None, None, false, false);
    let (mut install, mut uninstall) = (false, false);
    while let Some(a) = args.next() {
        let mut val = || args.next().ok_or(format!("{a} needs a value"));
        match a.as_str() {
            "--media" => media.push(PathBuf::from(val()?)),
            "--port" => port = Some(val()?.parse::<u16>().map_err(|_| "--port needs a number")?),
            "--name" => name = Some(val()?),
            "--config" => dir = Some(PathBuf::from(val()?)),
            "--lan" => lan = Some(true),
            "--local" => lan = Some(false),
            "--new-code" => renew = true,
            "--web" => web = Some(Some(PathBuf::from(val()?))),
            "--no-web" => web = Some(None),
            "--public-url" => public_url = Some(Some(val()?.trim_end_matches('/').to_string())),
            "--no-public-url" => public_url = Some(None),
            "--tailscale" => tailscale = true,
            "--cloudflare" => cloudflare = true,
            "--install" => install = true,
            "--uninstall" => uninstall = true,
            "--help" | "-h" => {
                println!("{HELP}");
                return Ok(());
            }
            _ => return Err(format!("unknown argument {a}\n\n{HELP}")),
        }
    }
    if uninstall {
        service::uninstall()?.iter().for_each(|l| println!("{l}"));
        return Ok(());
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
    if let Some(l) = lan {
        saved.lan = l;
    }
    if let Some(w) = web {
        saved.web = w.map(|w| std::fs::canonicalize(&w).unwrap_or(w));
    }
    if let Some(u) = public_url {
        saved.public_url = u;
    }
    if let Some(w) = &saved.web {
        if !w.join("index.html").is_file() {
            return Err(format!("{} has no index.html", w.display()));
        }
    }
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
    if install {
        return install_service(&dir, &saved, tailscale, cloudflare);
    }
    let name = saved.name.clone().unwrap_or_else(hostname);
    let cfg = Config {
        media: saved.media.clone(),
        port: saved.port.unwrap_or(DEFAULT_PORT),
        name: name.clone(),
        lan: saved.lan,
        config_dir: dir,
        web: saved.web.clone(),
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
    if let Some(u) = &saved.public_url {
        urls.push(u.clone());
    }
    for u in &urls {
        println!("\n{u}\n  Setup link: {}", handle.setup_link(u));
    }
    let port = handle.port();
    if tailscale {
        match reach::tailscale_serve(port) {
            Ok(u) => {
                println!(
                    "\nTailscale (devices on your tailnet): {u}\n  Setup link: {}",
                    handle.setup_link(&u)
                );
                let off = reach::serve_off_args(port).join(" ");
                println!("  The mapping stays after you stop. Remove it with: tailscale {off}");
            }
            Err(e) => eprintln!("\nTailscale: {e}"),
        }
    }
    let _tunnel = if cloudflare {
        match reach::cloudflare_quick(port, std::time::Duration::from_secs(30)) {
            Ok(t) => {
                println!(
                    "\nCloudflare quick tunnel: {}\n  Setup link: {}",
                    t.url,
                    handle.setup_link(&t.url)
                );
                println!("  The address changes each run. Anyone with the link and the code can reach this server.");
                Some(t)
            }
            Err(e) => {
                eprintln!("\nCloudflare: {e}\n  Still serving locally.");
                None
            }
        }
    } else {
        None
    };
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

/// Registers this binary to start at login with the saved settings, and prints how to reach it.
fn install_service(
    dir: &Path,
    saved: &Saved,
    tailscale: bool,
    cloudflare: bool,
) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    let dir = std::fs::canonicalize(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    service::install(&exe, &dir)?
        .iter()
        .for_each(|l| println!("{l}"));
    let port = saved.port.unwrap_or(DEFAULT_PORT);
    let (name, token) = (
        saved.name.clone().unwrap_or_else(hostname),
        access_code(&dir, false)?,
    );
    let own_web = flick_server::serves_web(saved.web.clone());
    let link = |u: &str| {
        let base = if own_web { u } else { SETUP_BASE };
        flick_server::setup_link(base, &name, u, &token)
    };
    let mut urls = vec![format!("http://127.0.0.1:{port}")];
    urls.extend(saved.public_url.clone());
    for u in &urls {
        println!("\n{u}\n  Setup link: {}", link(u));
    }
    if tailscale {
        match reach::tailscale_serve(port) {
            Ok(u) => println!(
                "\nTailscale: {u}\n  Setup link: {}\n  The Serve mapping persists, so the installed server stays reachable there after a reboot.",
                link(&u)
            ),
            Err(e) => eprintln!("\nTailscale: {e}"),
        }
    }
    if cloudflare {
        println!("\nCloudflare: --install does not start a quick tunnel, since its address changes each run. For a lasting address, run a named tunnel to http://127.0.0.1:{port} and save it with --public-url URL.");
    }
    Ok(())
}

fn main() {
    if let Err(e) = run() {
        eprintln!("flick-server: {e}");
        std::process::exit(1);
    }
}
