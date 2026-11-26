// The `ytdlp` desktop tool for source plugins (docs/PLUGINS.md, ctx.tools.ytdlp).
// Only a plugin whose installed manifest lists `tools: ['ytdlp']` may call it: the web side registers
// each plugin's tools from its installed record (plugin_tools), and plugin_tool checks that list here.
// Flick keeps its own yt-dlp: the official release binary, checked against the release's SHA2-256SUMS
// and updated with `yt-dlp -U` at most once a day. A yt-dlp on PATH is used only when that one fails.

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, Url};

const RELEASES: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
// H.264 and AAC play in every web view and copy into HLS without re-encoding.
const PLAY_FORMAT: &str =
    "bv[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]";
const DAY: Duration = Duration::from_secs(86_400);

#[derive(Clone, Default, Debug)]
enum Fetch {
    #[default]
    Idle,
    Getting {
        got: u64,
        total: u64,
    },
    Failed(String),
}

#[derive(Default)]
pub struct PluginTools {
    tools: Mutex<HashMap<String, Vec<String>>>,
    /// `flick-tool:ytdlp/<token>` to the page it plays. Only resolve() adds entries.
    tokens: Mutex<HashMap<String, String>>,
    fetch: Arc<Mutex<Fetch>>,
    /// yt-dlp and ffmpeg for the stream playing now. A new stream or app exit stops them.
    job: Mutex<Vec<Child>>,
}

/// The release file for this computer, and the name Flick saves it under.
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => Some("yt-dlp_macos"),
        ("windows", "aarch64") => Some("yt-dlp_arm64.exe"),
        ("windows", _) => Some("yt-dlp.exe"),
        ("linux", "x86_64") => Some("yt-dlp_linux"),
        ("linux", "aarch64") => Some("yt-dlp_linux_aarch64"),
        _ => None,
    }
}

fn managed_path(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    })
}

/// The SHA-256 the release lists for `name`, from SHA2-256SUMS ("<hex>  <name>" per line).
fn expected_sum(sums: &str, name: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let (hash, file) = l.split_once(char::is_whitespace)?;
        (file.trim().trim_start_matches('*') == name && hash.len() == 64)
            .then(|| hash.to_ascii_lowercase())
    })
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Download the release binary into `dir`, refuse it unless its SHA-256 matches, then make it executable.
fn install(dir: &Path, base: &str, state: &Mutex<Fetch>) -> Result<(), String> {
    let name = asset().ok_or("yt-dlp has no release for this computer.")?;
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_per_read(Some(Duration::from_secs(60)))
        .build()
        .into();
    let get = |url: &str| {
        agent
            .get(url)
            .call()
            .map_err(|e| format!("Could not download yt-dlp: {e}"))
    };
    let sums = get(&format!("{base}/SHA2-256SUMS"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let want = expected_sum(&sums, name)
        .ok_or("The yt-dlp release lists no checksum for this computer.")?;
    let mut resp = get(&format!("{base}/{name}"))?;
    let total = resp.body().content_length().unwrap_or(0);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let part = dir.join("yt-dlp.part");
    let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut body = resp.body_mut().with_config().limit(u64::MAX).reader();
    let (mut hash, mut buf, mut got) = (Sha256::new(), vec![0u8; 1 << 16], 0u64);
    loop {
        let n = body
            .read(&mut buf)
            .map_err(|e| format!("Could not download yt-dlp: {e}"))?;
        if n == 0 {
            break;
        }
        hash.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        *state.lock().unwrap() = Fetch::Getting { got, total };
    }
    drop(file);
    if hex(&hash.finalize()) != want {
        let _ = std::fs::remove_file(&part);
        return Err(
            "The yt-dlp download did not match its published checksum, so Flick did not keep it."
                .into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&part, managed_path(dir)).map_err(|e| e.to_string())
}

/// `yt-dlp -U` in the background, at most once a day (the stamp file's age says when it last ran).
fn update_daily(bin: &Path) {
    let stamp = bin.with_extension("updated");
    let fresh = std::fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .is_ok_and(|t| t.elapsed().is_ok_and(|a| a < DAY));
    if fresh || std::fs::write(&stamp, b"").is_err() {
        return;
    }
    let bin = bin.to_path_buf();
    std::thread::spawn(move || {
        Command::new(bin)
            .arg("-U")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    });
}

/// Flick's own yt-dlp, fetched on first use. Waits up to `wait`; past that, says how far the download got.
fn managed(dir: &Path, fetch: &Arc<Mutex<Fetch>>, wait: Duration) -> Result<PathBuf, String> {
    let bin = managed_path(dir);
    let start = Instant::now();
    loop {
        if bin.is_file() {
            update_daily(&bin);
            return Ok(bin);
        }
        let now = {
            let mut g = fetch.lock().unwrap();
            let was = g.clone();
            if matches!(was, Fetch::Idle) {
                *g = Fetch::Getting { got: 0, total: 0 };
            }
            was
        };
        match now {
            Fetch::Idle => {
                let (dir, f) = (dir.to_path_buf(), fetch.clone());
                std::thread::spawn(move || {
                    let r = install(&dir, RELEASES, &f);
                    *f.lock().unwrap() = r.err().map(Fetch::Failed).unwrap_or_default();
                });
            }
            Fetch::Failed(e) => {
                // Try again on the next call.
                *fetch.lock().unwrap() = Fetch::Idle;
                return Err(e);
            }
            Fetch::Getting { got, total } if start.elapsed() >= wait => {
                let mb = |b: u64| b / 1_000_000;
                return Err(match total {
                    0 => "Flick is downloading yt-dlp. Try again in a moment.".into(),
                    t => format!(
                        "Flick is downloading yt-dlp ({} of {} MB). Try again in a moment.",
                        mb(got),
                        mb(t)
                    ),
                });
            }
            Fetch::Getting { .. } => std::thread::sleep(Duration::from_millis(200)),
        }
    }
}

/// Run yt-dlp with Flick's own binary, and with one on PATH only when Flick's fails.
fn run_json(env: &Env, args: &[&str]) -> Result<Value, String> {
    let once = |bin: &Path| -> Result<Value, String> {
        let out = Command::new(bin)
            .arg("--no-warnings")
            .args(args)
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(format!(
                "yt-dlp: {}",
                err.lines().last().unwrap_or("failed")
            ));
        }
        serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
    };
    let first = managed(&env.dir, &env.fetch, Duration::from_secs(12)).and_then(|b| once(&b));
    match (first, super::find_tool("yt-dlp")) {
        (Err(e), Some(path)) if !e.starts_with("Flick is downloading") => {
            once(&path).map_err(|_| e)
        }
        (r, _) => r,
    }
}

/// Search results as Flick metas. The id is the watch URL, ready for resolve().
fn metas(j: &Value) -> Vec<Value> {
    let entries = j["entries"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    entries
        .iter()
        // Videos only: a search also finds channels and playlists (ie_key YoutubeTab).
        .filter(|e| e["ie_key"].as_str().is_none_or(|k| k == "Youtube"))
        .filter_map(|e| {
            let id = e["id"].as_str().filter(|i| !i.is_empty() && i.len() <= 64 && i.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))?;
            let name = e["title"].as_str().filter(|t| !t.is_empty())?;
            let url = e["url"].as_str().filter(|u| u.starts_with("https://")).map(String::from).unwrap_or_else(|| format!("https://www.youtube.com/watch?v={id}"));
            let thumb = e["thumbnails"].as_array().and_then(|t| t.iter().max_by_key(|x| x["width"].as_u64().unwrap_or(0))?["url"].as_str().map(String::from));
            let secs = e["duration"].as_f64().unwrap_or(0.0) as u64;
            let channel = e["channel"].as_str().or(e["uploader"].as_str()).unwrap_or("");
            Some(json!({
                "id": url, "type": "video", "name": name, "posterShape": "landscape",
                "poster": thumb.unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),
                "description": e["description"].as_str().unwrap_or(""),
                "channel": channel, "duration": secs,
                "runtime": if secs > 0 { format!("{}:{:02}", secs / 60, secs % 60) } else { String::new() },
            }))
        })
        .collect()
}

/// What one call needs from the app: Flick's tools folder and the download state.
struct Env {
    dir: PathBuf,
    fetch: Arc<Mutex<Fetch>>,
}

/// A fresh random token per resolve, so no other plugin can work out the token for a page and play it.
fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| format!("random: {e}"))?;
    Ok(hex(&bytes))
}

/// One ctx.tools call. `tools` and `hosts` are the plugin's own, from its installed manifest.
fn run_tool(
    env: &Env,
    state: &PluginTools,
    tools: &[String],
    hosts: &[String],
    tool: &str,
    op: &str,
    args: &[Value],
) -> Result<Value, String> {
    if tool != "ytdlp" {
        return Err(format!("Flick has no desktop tool called \"{tool}\"."));
    }
    if !tools.iter().any(|t| t == tool) {
        return Err(format!(
            "This plugin did not list the {tool} tool when it was installed."
        ));
    }
    let arg = |i: usize| {
        args.get(i)
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string()
    };
    match op {
        "search" => {
            let q = arg(0);
            if q.is_empty() || q.len() > 200 {
                return Err("Search needs a term of 1 to 200 characters.".into());
            }
            let n = args
                .get(1)
                .and_then(Value::as_u64)
                .unwrap_or(20)
                .clamp(1, 50);
            let j = run_json(
                env,
                &["--flat-playlist", "-J", "--", &format!("ytsearch{n}:{q}")],
            )?;
            Ok(Value::Array(metas(&j)))
        }
        "resolve" => {
            let url = arg(0);
            let parsed = Url::parse(&url).map_err(|_| format!("Not a web address: {url}"))?;
            if parsed.scheme() != "https" || !super::plugins::host_allowed(hosts, &parsed) {
                return Err(format!(
                    "This plugin may not play {url}. Its hosts list does not include it."
                ));
            }
            let token = new_token()?;
            state
                .tokens
                .lock()
                .unwrap()
                .insert(token.clone(), parsed.into());
            // Fetch yt-dlp now, so the player does not wait for it.
            let _ = managed(&env.dir, &env.fetch, Duration::ZERO);
            Ok(json!(format!("flick-tool:ytdlp/{token}")))
        }
        "download" => {
            Err("Saving videos for offline with yt-dlp comes in a later version of Flick.".into())
        }
        _ => Err(format!("The {tool} tool has no \"{op}\" call.")),
    }
}

fn env(app: &tauri::AppHandle, state: &PluginTools) -> Result<Env, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tools");
    Ok(Env {
        dir,
        fetch: state.fetch.clone(),
    })
}

#[tauri::command]
pub fn plugin_tools(state: tauri::State<'_, PluginTools>, id: String, tools: Vec<String>) {
    let mut map = state.tools.lock().unwrap();
    if tools.is_empty() {
        map.remove(&id);
    } else {
        map.insert(id, tools);
    }
}

#[tauri::command]
pub async fn plugin_tool(
    app: tauri::AppHandle,
    id: String,
    tool: String,
    op: String,
    args: Vec<Value>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginTools>();
        let tools = state
            .tools
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .unwrap_or_default();
        let hosts = app.state::<super::plugins::PluginHosts>().hosts_of(&id);
        run_tool(
            &env(&app, &state)?,
            &state,
            &tools,
            &hosts,
            &tool,
            &op,
            &args,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- playing a flick-tool: stream ----------

pub fn stop_job(state: &PluginTools) {
    for mut c in std::mem::take(&mut *state.job.lock().unwrap()) {
        let _ = c.kill();
        let _ = c.wait();
    }
}

/// The URL Tauri's convertFileSrc gives a path. Segment names need it in full: the
/// playlist URL encodes every slash, so a relative name would resolve to the root.
fn asset_url(path: &Path) -> String {
    let mut out = String::from(if cfg!(windows) {
        "http://asset.localhost/"
    } else {
        "asset://localhost/"
    });
    for b in path.to_string_lossy().bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn segments(playlist: &Path) -> usize {
    std::fs::read_to_string(playlist)
        .map(|t| {
            t.lines()
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .count()
        })
        .unwrap_or(0)
}

fn last_line(p: &Path) -> String {
    let t = std::fs::read_to_string(p).unwrap_or_default();
    t.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .to_string()
}

/// yt-dlp writes the video to stdout (it picks the format) and ffmpeg turns that into a local HLS
/// event playlist, so a long video plays while it streams. Returns the playlist once it lists a segment.
fn stream(
    bin: &Path,
    ffmpeg: &Path,
    page: &str,
    dir: &Path,
    base: &str,
    state: &PluginTools,
) -> Result<PathBuf, String> {
    stop_job(state);
    let playlist = dir.join("index.m3u8");
    if std::fs::read_to_string(&playlist).is_ok_and(|t| t.contains("#EXT-X-ENDLIST")) {
        return Ok(playlist);
    }
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = |n: &str| std::fs::File::create(dir.join(n)).map_err(|e| e.to_string());
    let mut yt = Command::new(bin)
        .args([
            "--no-warnings",
            "--no-progress",
            "--no-playlist",
            "--no-part",
            "-f",
            PLAY_FORMAT,
            "--ffmpeg-location",
        ])
        .arg(ffmpeg)
        .args(["-o", "-", "--", page])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(file("yt-dlp.log")?)
        .spawn()
        .map_err(|e| e.to_string())?;
    let pipe = yt.stdout.take().ok_or("yt-dlp gave no output")?;
    let ff = Command::new(ffmpeg)
        .args([
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            "pipe:0",
            "-map",
            "0:v:0",
            "-map",
            "0:a:0?",
            "-c",
            "copy",
            "-f",
            "hls",
        ])
        .args([
            "-hls_time",
            "4",
            "-hls_playlist_type",
            "event",
            "-hls_flags",
            "independent_segments",
            "-hls_base_url",
            base,
        ])
        .arg(&playlist)
        .stdin(pipe)
        .stdout(Stdio::null())
        .stderr(file("ffmpeg.log")?)
        .spawn();
    let ff = match ff {
        Ok(c) => c,
        Err(e) => {
            let _ = yt.kill();
            return Err(e.to_string());
        }
    };
    *state.job.lock().unwrap() = vec![yt, ff];
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(45) {
        if segments(&playlist) > 0 {
            return Ok(playlist);
        }
        let ended = state
            .job
            .lock()
            .unwrap()
            .iter_mut()
            .any(|c| !matches!(c.try_wait(), Ok(None)));
        if ended && segments(&playlist) == 0 {
            stop_job(state);
            let why = [
                last_line(&dir.join("yt-dlp.log")),
                last_line(&dir.join("ffmpeg.log")),
            ]
            .into_iter()
            .find(|l| !l.is_empty());
            return Err(format!(
                "This video could not stream: {}",
                why.unwrap_or_else(|| "yt-dlp stopped early".into())
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    stop_job(state);
    Err("The video sent nothing within 45 seconds. Try again.".into())
}

/// Start a `flick-tool:` stream a plugin resolved. Returns the local playlist path for convertFileSrc.
fn open(env: &Env, state: &PluginTools, cache: &Path, url: &str) -> Result<PathBuf, String> {
    let token = url
        .strip_prefix("flick-tool:ytdlp/")
        .ok_or_else(|| format!("Flick cannot play {url}."))?;
    let page = state
        .tokens
        .lock()
        .unwrap()
        .get(token)
        .cloned()
        .ok_or("This stream has expired. Open the title again.")?;
    let ffmpeg = super::find_tool("ffmpeg")
        .ok_or("Playing this needs ffmpeg. Install it with: brew install ffmpeg")?;
    let bin = match managed(&env.dir, &env.fetch, Duration::from_secs(300)) {
        Ok(b) => b,
        Err(e) => super::find_tool("yt-dlp").ok_or(e)?,
    };
    let dir = cache.join(token);
    stream(&bin, &ffmpeg, &page, &dir, &asset_url(&dir.join("")), state)
}

#[tauri::command]
pub async fn tool_open(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("ytdlp");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginTools>();
        let p = open(&env(&app, &state)?, &state, &cache, &url)?;
        Ok(p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Streams are a cache: drop any older than a day.
pub fn clean_cache(cache: &Path) {
    for d in std::fs::read_dir(cache.join("ytdlp"))
        .into_iter()
        .flatten()
        .flatten()
    {
        if d.metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            > Some(DAY)
        {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_in(dir: &Path) -> Env {
        Env {
            dir: dir.to_path_buf(),
            fetch: Arc::default(),
        }
    }
    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn only_a_plugin_that_listed_the_tool_may_call_it() {
        let (st, e) = (PluginTools::default(), env_in(Path::new("/nonexistent")));
        let hosts = s(&["www.youtube.com"]);
        let url = [json!("https://www.youtube.com/watch?v=aqz-KE-bpKQ")];
        let err = run_tool(&e, &st, &[], &hosts, "ytdlp", "resolve", &url).unwrap_err();
        assert!(err.contains("did not list the ytdlp tool"), "{err}");
        assert!(
            run_tool(&e, &st, &s(&["ytdlp"]), &hosts, "shell", "run", &[])
                .unwrap_err()
                .contains("no desktop tool")
        );
        let ok = run_tool(&e, &st, &s(&["ytdlp"]), &hosts, "ytdlp", "resolve", &url).unwrap();
        assert!(ok.as_str().unwrap().starts_with("flick-tool:ytdlp/"));
    }

    #[test]
    fn a_stream_token_cannot_be_worked_out_from_the_page() {
        let (st, e) = (PluginTools::default(), env_in(Path::new("/nonexistent")));
        let (t, hosts) = (s(&["ytdlp"]), s(&["www.youtube.com"]));
        let page = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
        let url = [json!(page)];
        let a = run_tool(&e, &st, &t, &hosts, "ytdlp", "resolve", &url).unwrap();
        let b = run_tool(&e, &st, &t, &hosts, "ytdlp", "resolve", &url).unwrap();
        assert_ne!(a, b, "the same page got the same token twice");
        let guess = format!(
            "flick-tool:ytdlp/{}",
            hex(&Sha256::digest(page.as_bytes())[..12])
        );
        assert_ne!(a.as_str().unwrap(), guess);
        assert_eq!(a.as_str().unwrap().len(), "flick-tool:ytdlp/".len() + 32);
    }

    #[test]
    fn resolve_plays_only_https_pages_on_the_plugins_hosts() {
        let (st, e, t) = (
            PluginTools::default(),
            env_in(Path::new("/nonexistent")),
            s(&["ytdlp"]),
        );
        let hosts = s(&["www.youtube.com"]);
        for bad in [
            "https://evil.example/v",
            "http://www.youtube.com/watch?v=x",
            "file:///etc/passwd",
            "--exec=rm",
        ] {
            assert!(
                run_tool(&e, &st, &t, &hosts, "ytdlp", "resolve", &[json!(bad)]).is_err(),
                "{bad}"
            );
        }
        assert!(st.tokens.lock().unwrap().is_empty());
        // A token only plays what resolve() registered.
        let err = open(&e, &st, Path::new("/nonexistent"), "flick-tool:ytdlp/abc").unwrap_err();
        assert!(err.contains("expired"), "{err}");
    }

    #[test]
    fn reads_the_release_checksum_for_this_asset() {
        let sums = "e866  short\n57654854886d0398a798895aadf5173e2749fbb5e249b9f3728022ab376e11fb  yt-dlp_macos\n43fc87fc581f64b48c366ce20b9cacb9c2949cc1ac4b9eca56fe25ac52dbb63b  yt-dlp_macos.zip\n";
        assert_eq!(
            expected_sum(sums, "yt-dlp_macos").unwrap(),
            "57654854886d0398a798895aadf5173e2749fbb5e249b9f3728022ab376e11fb"
        );
        assert!(expected_sum(sums, "yt-dlp_linux").is_none());
        assert!(expected_sum(sums, "short").is_none());
    }

    #[test]
    fn install_refuses_a_binary_that_does_not_match_its_checksum() {
        // A tiny local release server: the checksum lists zeros, so the download must be thrown away.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let name = asset().unwrap();
        std::thread::spawn(move || {
            for conn in listener.incoming().take(2).flatten() {
                let mut c = conn;
                let mut req = [0u8; 1024];
                let n = c.read(&mut req).unwrap();
                let body = if String::from_utf8_lossy(&req[..n]).contains("SHA2-256SUMS") {
                    format!("{}  {name}\n", "0".repeat(64))
                } else {
                    "not yt-dlp".into()
                };
                let _ = write!(
                    c,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        let dir = std::env::temp_dir().join(format!("flick-ytdlp-sum-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let err = install(&dir, &base, &Mutex::default()).unwrap_err();
        assert!(err.contains("did not match"), "{err}");
        assert!(!managed_path(&dir).exists() && !dir.join("yt-dlp.part").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_json_becomes_metas() {
        // plugin:check's ytdlp stub answers with this same file, so the two cannot drift apart.
        let j: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/yt-search.json")).unwrap();
        let want: Value =
            serde_json::from_str(include_str!("../../tests/fixtures/ytdlp-search.json")).unwrap();
        if std::env::var_os("FLICK_WRITE_FIXTURE").is_some() {
            println!("{}", serde_json::to_string_pretty(&metas(&j)).unwrap());
        }
        assert_eq!(Value::Array(metas(&j)), want);
    }

    /// Real network run on this computer: Flick's own yt-dlp searches, resolves and streams.
    /// `FLICK_YTDLP_DIR=<dir> cargo test ytdlp_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn ytdlp_live() {
        let dir = std::env::var("FLICK_YTDLP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("flick-ytdlp-live"));
        let (st, e) = (PluginTools::default(), env_in(&dir));
        let (t, hosts) = (s(&["ytdlp"]), s(&["www.youtube.com", "youtube.com"]));
        let clock = Instant::now();
        let bin = managed(&e.dir, &e.fetch, Duration::from_secs(300)).unwrap();
        let ver = Command::new(&bin).arg("--version").output().unwrap();
        println!(
            "managed yt-dlp {} at {} ({:?})",
            String::from_utf8_lossy(&ver.stdout).trim(),
            bin.display(),
            clock.elapsed()
        );
        let clock = Instant::now();
        let found = run_tool(
            &e,
            &st,
            &t,
            &hosts,
            "ytdlp",
            "search",
            &[json!("big buck bunny"), json!(5)],
        )
        .unwrap();
        let first = &found[0];
        println!(
            "search: {} results in {:?}; first {} | {} | {}",
            found.as_array().unwrap().len(),
            clock.elapsed(),
            first["id"],
            first["name"],
            first["runtime"]
        );
        let url = run_tool(
            &e,
            &st,
            &t,
            &hosts,
            "ytdlp",
            "resolve",
            &[first["id"].clone()],
        )
        .unwrap();
        println!("resolve: {url}");
        let clock = Instant::now();
        let cache = std::env::temp_dir().join("flick-ytdlp-live-cache");
        let playlist = open(&e, &st, &cache, url.as_str().unwrap()).unwrap();
        println!(
            "stream: first segment listed after {:?}: {}",
            clock.elapsed(),
            playlist.display()
        );
        let text = std::fs::read_to_string(&playlist).unwrap();
        let seg = text
            .lines()
            .find(|l| !l.is_empty() && !l.starts_with('#'))
            .unwrap();
        let name = seg.rsplit("%2F").next().unwrap();
        let bytes = std::fs::read(playlist.with_file_name(name)).unwrap();
        println!(
            "first segment {name}: {} bytes, starts {:02x?}",
            bytes.len(),
            &bytes[..4]
        );
        assert!(
            bytes.len() > 10_000 && bytes[0] == 0x47,
            "an MPEG-TS segment starts with 0x47"
        );
        stop_job(&st);
    }
}
