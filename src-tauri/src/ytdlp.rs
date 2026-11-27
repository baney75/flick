// The `ytdlp` desktop tool for source plugins (docs/PLUGINS.md, ctx.tools.ytdlp).
// Only a plugin whose installed manifest lists `tools: ['ytdlp']` may call it: the web side registers
// each plugin's tools from its installed record (plugin_tools), and plugin_tool checks that list here.
// Flick keeps its own yt-dlp: the official release binary, checked against the release's SHA2-256SUMS
// and updated at most once a day. A yt-dlp on PATH is used only when that one fails. On macOS it is the
// unpacked build (yt-dlp_macos.zip): the one-file build unpacks itself on every run, and macOS checks the
// unpacked files each time, which cost about 4 s per call (`--version` 4.35 s, against 0.18 s unpacked).

use super::ytmaster::{self, Masters};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, Url};

const RELEASES: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
// What Download saves: H.264 and AAC, merged by yt-dlp into one MP4 file.
const SAVE_FORMAT: &str =
    "bv[vcodec^=avc1][height<=1080]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]";
// Play without a master (SPEC-youtube-play rule 4): one file with both tracks, fetched by yt-dlp's own
// downloader. A `+` merge to stdout made yt-dlp's ffmpeg fetch two URLs, and it hung or got 403.
const FALLBACK_FORMAT: &str = "b[vcodec^=avc1][acodec^=mp4a][protocol^=http]";
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
    job: Mutex<Job>,
    /// YouTube masters per page, looked up early (ytmaster.rs).
    masters: Arc<Masters>,
}

/// The processes of one stream. `id` changes with every new stream, so an older call that is
/// still waiting can tell it was replaced and leave the newer stream's processes alone.
#[derive(Default)]
struct Job {
    id: u64,
    children: Vec<Child>,
}

/// The release file for this computer, and the name Flick saves it under.
fn asset() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", _) => Some("yt-dlp_macos.zip"),
        ("windows", "aarch64") => Some("yt-dlp_arm64.exe"),
        ("windows", _) => Some("yt-dlp.exe"),
        ("linux", "x86_64") => Some("yt-dlp_linux"),
        ("linux", "aarch64") => Some("yt-dlp_linux_aarch64"),
        _ => None,
    }
}

/// The unpacked macOS build's folder, and the file next to its program that holds the zip's SHA-256.
const MAC_DIR: &str = "yt-dlp_macos";
const SUM_FILE: &str = "release.sha256";

fn managed_path(dir: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        return dir.join(MAC_DIR).join("yt-dlp_macos");
    }
    dir.join(if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    })
}

/// The one-file build Flick kept on macOS before; used only while the unpacked build downloads.
fn legacy_path(dir: &Path) -> Option<PathBuf> {
    cfg!(target_os = "macos").then(|| dir.join("yt-dlp"))
}

/// Whether the daily check should fetch the release again: its checksum changed, or none was kept.
fn needs_fetch(kept: Option<&str>, published: Option<&str>) -> bool {
    match (kept, published) {
        (_, None) => false,
        (None, Some(_)) => true,
        (Some(k), Some(p)) => k.trim() != p,
    }
}

/// Unpacks the verified zip into `dir`/yt-dlp_macos, replacing any copy there, and removes the old
/// one-file build. The program is run once in the background so macOS checks its files now, not
/// during the first search (6 s here, once).
fn unpack(zip: &Path, dir: &Path, sum: &str) -> Result<(), String> {
    let new = dir.join(format!("{MAC_DIR}.new"));
    let old = dir.join(format!("{MAC_DIR}.old"));
    let live = dir.join(MAC_DIR);
    let _ = std::fs::remove_dir_all(&new);
    let ok = Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(zip)
        .arg(&new)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(zip);
    if !ok || !new.join("yt-dlp_macos").is_file() {
        let _ = std::fs::remove_dir_all(&new);
        return Err("Could not unpack yt-dlp.".into());
    }
    std::fs::write(new.join(SUM_FILE), sum).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(&old);
    if live.exists() {
        std::fs::rename(&live, &old).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&new, &live).map_err(|e| e.to_string())?;
    // The previous copy stays in .old until the next update: a search or stream still running from it
    // loads its modules from those files.
    if let Some(l) = legacy_path(dir) {
        let _ = std::fs::remove_file(&l);
        let _ = std::fs::remove_file(l.with_extension("updated"));
    }
    let bin = live.join("yt-dlp_macos");
    std::thread::spawn(move || {
        Command::new(bin)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
    });
    Ok(())
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_per_read(Some(Duration::from_secs(60)))
        .build()
        .into()
}

fn release_sums(agent: &ureq::Agent, base: &str) -> Result<String, String> {
    agent
        .get(&format!("{base}/SHA2-256SUMS"))
        .call()
        .map_err(|e| format!("Could not download yt-dlp: {e}"))?
        .body_mut()
        .read_to_string()
        .map_err(|e| e.to_string())
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
    let agent = agent();
    let get = |url: &str| {
        agent
            .get(url)
            .call()
            .map_err(|e| format!("Could not download yt-dlp: {e}"))
    };
    let sums = release_sums(&agent, base)?;
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
    if name.ends_with(".zip") {
        return unpack(&part, dir, &want);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&part, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| e.to_string())?;
    }
    std::fs::rename(&part, managed_path(dir)).map_err(|e| e.to_string())
}

/// When the daily update last ran. On macOS it sits beside the unpacked build's folder, not in it,
/// so an update that replaces the folder keeps it.
fn stamp_path(dir: &Path, bin: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        return dir.join(format!("{MAC_DIR}.updated"));
    }
    bin.with_extension("updated")
}

/// Holds the one daily update slot until dropped. Home asks for several rows at once, and two macOS
/// installs at the same time would unpack over each other.
struct Claim(&'static AtomicBool);
impl Claim {
    fn take(flag: &'static AtomicBool) -> Option<Self> {
        (!flag.swap(true, Ordering::SeqCst)).then_some(Claim(flag))
    }
}
impl Drop for Claim {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
static UPDATING: AtomicBool = AtomicBool::new(false);

/// An update in the background, at most once a day (the stamp file's age says when it last ran) and
/// one at a time: `yt-dlp -U`, or for the unpacked macOS build, which cannot update itself, the
/// release again when its checksum changed.
fn update_daily(dir: &Path, bin: &Path) {
    let stamp = stamp_path(dir, bin);
    let fresh = std::fs::metadata(&stamp)
        .and_then(|m| m.modified())
        .is_ok_and(|t| t.elapsed().is_ok_and(|a| a < DAY));
    if fresh {
        return;
    }
    let Some(claim) = Claim::take(&UPDATING) else {
        return;
    };
    if std::fs::write(&stamp, b"").is_err() {
        return;
    }
    let (dir, bin) = (dir.to_path_buf(), bin.to_path_buf());
    std::thread::spawn(move || {
        let _claim = claim;
        if cfg!(target_os = "macos") {
            let kept = std::fs::read_to_string(dir.join(MAC_DIR).join(SUM_FILE)).ok();
            let published = release_sums(&agent(), RELEASES)
                .ok()
                .and_then(|s| asset().and_then(|n| expected_sum(&s, n)));
            if needs_fetch(kept.as_deref(), published.as_deref()) {
                let _ = install(&dir, RELEASES, &Mutex::default());
            }
            return;
        }
        let _ = Command::new(bin)
            .arg("-U")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    });
}

/// Flick's own yt-dlp, fetched on first use. Waits up to `wait`; past that, says how far the download got.
fn managed(dir: &Path, fetch: &Arc<Mutex<Fetch>>, wait: Duration) -> Result<PathBuf, String> {
    let bin = managed_path(dir);
    let start = Instant::now();
    loop {
        if bin.is_file() {
            update_daily(dir, &bin);
            return Ok(bin);
        }
        // Moving to the unpacked build: the old one keeps working while the new one downloads.
        let legacy = legacy_path(dir).filter(|l| l.is_file());
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
                if legacy.is_none() {
                    return Err(e);
                }
            }
            Fetch::Getting { got, total } if legacy.is_none() && start.elapsed() >= wait => {
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
            Fetch::Getting { .. } if legacy.is_none() => {
                std::thread::sleep(Duration::from_millis(200))
            }
            Fetch::Getting { .. } => {}
        }
        if let Some(l) = legacy {
            return Ok(l);
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

/// A length as YouTube writes it: "3:05", "1:02:05". Empty for zero (unknown or live).
fn clock(secs: u64) -> String {
    match (secs / 3600, secs / 60 % 60, secs % 60) {
        (0, 0, 0) => String::new(),
        (0, m, s) => format!("{m}:{s:02}"),
        (h, m, s) => format!("{h}:{m:02}:{s:02}"),
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
            // Null when the search page did not say. `uploaded` is approximate ("3 years ago").
            let views = e["view_count"].as_u64();
            let uploaded = e["timestamp"].as_i64().filter(|t| *t > 0);
            Some(json!({
                "id": url, "type": "video", "name": name, "posterShape": "landscape",
                "poster": thumb.unwrap_or_else(|| format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),
                "description": e["description"].as_str().unwrap_or(""),
                "channel": channel, "duration": secs, "views": views, "uploaded": uploaded,
                "runtime": clock(secs),
            }))
        })
        .collect()
}

/// What one call needs from the app: Flick's tools folder and the download state.
#[derive(Clone)]
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
                // approximate_date turns the page's "3 years ago" into `timestamp`.
                &[
                    "--flat-playlist",
                    "--extractor-args",
                    "youtubetab:approximate_date",
                    "-J",
                    "--",
                    &format!("ytsearch{n}:{q}"),
                ],
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
        "download" => Err(
            "A plugin cannot start a download. The viewer saves a stream with its Download button."
                .into(),
        ),
        _ => Err(format!("The {tool} tool has no \"{op}\" call.")),
    }
}

fn env(app: &tauri::AppHandle, state: &PluginTools) -> Result<Env, String> {
    let dir = match crate::selftest::tools_dir(app) {
        Some(d) => d,
        None => app
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("tools"),
    };
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

fn kill_all(children: Vec<Child>) {
    for mut c in children {
        kill_tree(&mut c);
        let _ = c.wait();
    }
}

/// Starts `cmd` in its own process group, so `kill_tree` can stop everything it starts.
pub(crate) fn own_group(cmd: &mut Command) -> &mut Command {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(cmd, 0);
    cmd
}

pub fn stop_job(state: &PluginTools) {
    let children = std::mem::take(&mut state.job.lock().unwrap().children);
    kill_all(children);
}

/// Stops the job only while it is still stream `id`'s.
fn stop_job_if(state: &PluginTools, id: u64) {
    let children = {
        let mut job = state.job.lock().unwrap();
        if job.id != id {
            return;
        }
        std::mem::take(&mut job.children)
    };
    kill_all(children);
}

/// Makes `children` the playing job, stops any older one, and returns the new job's id.
fn start_job(state: &PluginTools, children: Vec<Child>) -> u64 {
    let old = {
        let mut job = state.job.lock().unwrap();
        job.id += 1;
        std::mem::replace(&mut job.children, children)
    };
    kill_all(old);
    state.job.lock().unwrap().id
}

/// Waits for the first segment of stream `id`. Gives up when its processes end with nothing
/// written, after `limit`, or as soon as a newer stream has replaced it.
fn wait_for_segment(
    state: &PluginTools,
    id: u64,
    playlist: &Path,
    dir: &Path,
    log: &str,
    limit: Duration,
) -> Result<PathBuf, String> {
    let start = Instant::now();
    while start.elapsed() < limit {
        if segments(playlist) > 0 {
            return Ok(playlist.to_path_buf());
        }
        let ended = {
            let mut job = state.job.lock().unwrap();
            if job.id != id {
                return Err("Another video started playing.".into());
            }
            job.children
                .iter_mut()
                .any(|c| !matches!(c.try_wait(), Ok(None)))
        };
        if ended && segments(playlist) == 0 {
            stop_job_if(state, id);
            let why = [
                last_line(&dir.join(log)),
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
    stop_job_if(state, id);
    Err("The video sent nothing within 45 seconds. Try again.".into())
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

/// Serves whatever `source` writes to stdout as a local HLS event playlist in `dir`, so a long video
/// plays while it streams: ffmpeg copies the tracks into segments, re-encoding nothing. The source's
/// stderr goes to `dir/<log>`. Returns the playlist once it lists a segment. The yt-dlp fallback uses it,
/// and so may any other source that writes a stream to stdout.
pub(crate) fn local_hls(
    mut source: Command,
    log: &str,
    ffmpeg: &Path,
    dir: &Path,
    state: &PluginTools,
) -> Result<PathBuf, String> {
    stop_job(state);
    let playlist = dir.join("index.m3u8");
    if std::fs::read_to_string(&playlist).is_ok_and(|t| t.contains("#EXT-X-ENDLIST")) {
        return Ok(playlist);
    }
    let _ = std::fs::remove_dir_all(dir);
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let base = asset_url(&dir.join(""));
    let file = |n: &str| std::fs::File::create(dir.join(n)).map_err(|e| e.to_string());
    let mut yt = own_group(&mut source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(file(log)?)
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
            &base,
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
    let id = start_job(state, vec![yt, ff]);
    wait_for_segment(state, id, &playlist, dir, log, Duration::from_secs(45))
}

/// The page a `flick-tool:ytdlp/<token>` plays, and the token. Only resolve() makes tokens.
fn page_of(state: &PluginTools, url: &str) -> Result<(String, String), String> {
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
    Ok((page, token.into()))
}

/// Flick's yt-dlp, or one on PATH when Flick's fails (the same order as run_json).
fn with_ytdlp<T>(
    env: &Env,
    wait: Duration,
    f: impl Fn(&Path) -> Result<T, String>,
) -> Result<T, String> {
    match (
        managed(&env.dir, &env.fetch, wait).and_then(|b| f(&b)),
        super::find_tool("yt-dlp"),
    ) {
        (Err(e), Some(path)) if !e.starts_with("Flick is downloading") => f(&path).map_err(|_| e),
        (r, _) => r,
    }
}

/// One master lookup (ytmaster.rs): about 7 s, most of it YouTube's JS challenge.
/// A lookup takes about 3 to 8 s; one that hangs (a stalled network, a challenge that never ends) is
/// stopped here, so Play shows a message instead of waiting on it for good.
const LOOKUP_LIMIT: Duration = Duration::from_secs(45);

fn find_master(env: &Env, page: &str) -> ytmaster::Found {
    find_master_within(env, page, LOOKUP_LIMIT)
}

fn find_master_within(env: &Env, page: &str, limit: Duration) -> ytmaster::Found {
    with_ytdlp(env, Duration::from_secs(300), |bin| {
        let (ok, out, err) =
            crate::playback::output_within(Command::new(bin).args(ytmaster::args(page)), limit)
                .map_err(|e| {
                    if e == crate::playback::SLOW_SERVER {
                        format!("yt-dlp found no stream within {} s.", limit.as_secs())
                    } else {
                        e
                    }
                })?;
        ytmaster::parse(
            ok,
            &String::from_utf8_lossy(&out),
            &String::from_utf8_lossy(&err),
        )
    })
}

/// How a stream plays: YouTube's master straight in the web view, or the local fallback for a page.
#[derive(Debug, PartialEq)]
enum Play {
    Master(ytmaster::Master),
    Fallback { page: String, token: String },
}

fn choose(
    state: &PluginTools,
    url: &str,
    fresh: bool,
    find: &dyn Fn(&str) -> ytmaster::Found,
) -> Result<Play, String> {
    let (page, token) = page_of(state, url)?;
    Ok(match state.masters.get(&page, fresh, find)? {
        Some(m) => Play::Master(m),
        None => Play::Fallback { page, token },
    })
}

fn fallback_args(page: &str) -> [&str; 10] {
    [
        "--no-warnings",
        "--no-progress",
        "--no-playlist",
        "--no-part",
        "-f",
        FALLBACK_FORMAT,
        "-o",
        "-",
        "--",
        page,
    ]
}

/// Start a `flick-tool:` stream a plugin resolved: `{kind: 'hls', url, live}` for a master, or
/// `{kind: 'file', path}`, a local playlist for convertFileSrc.
fn open(
    env: &Env,
    state: &PluginTools,
    cache: &Path,
    url: &str,
    fresh: bool,
) -> Result<Value, String> {
    match choose(state, url, fresh, &|p| find_master(env, p))? {
        Play::Master(m) => {
            // Nothing local plays now: stop an older fallback stream.
            stop_job(state);
            Ok(json!({ "kind": "hls", "url": m.url, "live": m.live, "duration": m.duration }))
        }
        Play::Fallback { page, token } => {
            let ffmpeg = super::find_tool("ffmpeg")
                .ok_or("Playing this needs ffmpeg. Install it with: brew install ffmpeg")?;
            let bin = with_ytdlp(env, Duration::from_secs(300), |b| Ok(b.to_path_buf()))?;
            let mut yt = Command::new(bin);
            yt.args(fallback_args(&page));
            let p = local_hls(yt, "yt-dlp.log", &ffmpeg, &cache.join(token), state)?;
            Ok(json!({ "kind": "file", "path": p }))
        }
    }
}

#[tauri::command]
pub async fn tool_open(
    app: tauri::AppHandle,
    url: String,
    fresh: Option<bool>,
) -> Result<Value, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("ytdlp");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginTools>();
        open(
            &env(&app, &state)?,
            &state,
            &cache,
            &url,
            fresh.unwrap_or(false),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Starts finding a stream's master before Play (the title page, a focused card). Never waits.
#[tauri::command]
pub fn tool_prefetch(app: tauri::AppHandle, url: String) {
    let state = app.state::<PluginTools>();
    let (Ok((page, _)), Ok(e)) = (page_of(&state, &url), env(&app, &state)) else {
        return;
    };
    state
        .masters
        .prefetch(&page, Arc::new(move |p: &str| find_master(&e, p)));
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

// ---------- saving a flick-tool: stream for offline ----------
// yt-dlp writes its parts to cache/ytdlp-dl/<id> (outside the stream cache's daily sweep) and moves the merged file to downloads/<id>.mp4,
// where the server downloads live. Progress goes out as `download-progress`, the same event.

/// The page a download may save: a token resolve() registered, from a plugin that lists the tool,
/// on that plugin's hosts as they are now (a plugin turned off has none).
fn download_page(
    state: &PluginTools,
    tools: &[String],
    hosts: &[String],
    id: &str,
    url: &str,
) -> Result<String, String> {
    if !super::valid_id(id) {
        return Err("Bad download name".into());
    }
    if !tools.iter().any(|t| t == "ytdlp") {
        return Err("This plugin did not list the ytdlp tool when it was installed.".into());
    }
    let token = url
        .strip_prefix("flick-tool:ytdlp/")
        .ok_or_else(|| format!("Flick cannot save {url}."))?;
    let page = state
        .tokens
        .lock()
        .unwrap()
        .get(token)
        .cloned()
        .ok_or("This stream has expired. Open the title again.")?;
    match Url::parse(&page) {
        Ok(u) if u.scheme() == "https" && super::plugins::host_allowed(hosts, &u) => Ok(page),
        _ => Err("This plugin may not save that page. Its hosts list does not include it.".into()),
    }
}

/// yt-dlp's arguments: the play format, merged into one `<id>.mp4` in `home`. The page comes last, after `--`.
fn download_args(
    ffmpeg: &Path,
    home: &Path,
    temp: &Path,
    id: &str,
    page: &str,
) -> Vec<std::ffi::OsString> {
    let mut a: Vec<std::ffi::OsString> = [
        // A user's own yt-dlp config (archive, subtitles, other formats) must not change what is saved.
        "--ignore-config",
        "--no-warnings", "--no-playlist", "--newline", "--progress-template",
        "download:FLICK %(progress.downloaded_bytes)s %(progress.total_bytes,progress.total_bytes_estimate)s",
        "-f", SAVE_FORMAT, "--merge-output-format", "mp4", "--ffmpeg-location",
    ]
    .map(Into::into)
    .into();
    a.push(ffmpeg.into());
    for (k, p) in [("home:", home), ("temp:", temp)] {
        a.push("-P".into());
        let mut v = std::ffi::OsString::from(k);
        v.push(p);
        a.push(v);
    }
    a.extend(["-o".into(), format!("{id}.mp4"), "--".into(), page.into()].map(Into::into));
    a
}

/// One progress line, "FLICK <done> <total>", as bytes. yt-dlp prints NA for what it does not know.
fn progress_line(line: &str) -> Option<(u64, u64)> {
    // An estimated total is a float ("12345.6").
    let num = |t: &str| {
        t.parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n as u64)
    };
    let mut w = line.strip_prefix("FLICK ")?.split_whitespace();
    let done = num(w.next()?)?;
    Some((done, w.next().and_then(num).unwrap_or(0)))
}

/// Adds up the video part and then the audio part, so done only grows across the two.
#[derive(Default)]
struct Tally {
    base: u64,
    done: u64,
    total: u64,
}

impl Tally {
    fn add(&mut self, done: u64, total: u64) -> (u64, u64) {
        if done < self.done {
            self.base += self.total.max(self.done);
        }
        (self.done, self.total) = (done, total);
        (self.base + done, self.base + total.max(done))
    }
}

/// yt-dlp's release builds run as two processes (a PyInstaller loader and the program), and it
/// starts ffmpeg to merge: stop them all, not only the process Flick started.
pub(crate) fn kill_tree(c: &mut Child) {
    #[cfg(unix)]
    let _ = Command::new("kill")
        .args(["-KILL", "--", &format!("-{}", c.id())])
        .stderr(Stdio::null())
        .status();
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/T", "/F", "/PID", &c.id().to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = c.kill();
}

/// Runs yt-dlp until it finishes, fails, or `stop` is set (then it is killed). Returns the saved file.
fn save(
    bin: &Path,
    args: &[std::ffi::OsString],
    home: &Path,
    temp: &Path,
    id: &str,
    stop: &std::sync::atomic::AtomicBool,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<PathBuf, String> {
    use std::io::BufRead;
    use std::sync::atomic::Ordering;
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(temp).map_err(|e| e.to_string())?;
    let log = temp.join("yt-dlp.log");
    let mut child = own_group(&mut Command::new(bin))
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(std::fs::File::create(&log).map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| e.to_string())?;
    let out = child.stdout.take().ok_or("yt-dlp gave no output")?;
    let child = Mutex::new(child);
    let status = std::thread::scope(|s| {
        // yt-dlp can sit quiet for a long time, so a watcher kills it on cancel rather than the reader.
        let watch = s.spawn(|| loop {
            let mut c = child.lock().unwrap();
            if !matches!(c.try_wait(), Ok(None)) {
                return;
            }
            if stop.load(Ordering::Relaxed) {
                kill_tree(&mut c);
                return;
            }
            drop(c);
            std::thread::sleep(Duration::from_millis(100));
        });
        let (mut tally, mut last) = (Tally::default(), Instant::now() - Duration::from_secs(1));
        let (mut now, mut sent) = ((0, 0), (0, 0));
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            if let Some((d, t)) = progress_line(&line) {
                now = tally.add(d, t);
                if last.elapsed() >= Duration::from_millis(250) {
                    (sent, last) = (now, Instant::now());
                    on_progress(now.0, now.1);
                }
            }
        }
        if now != sent {
            on_progress(now.0, now.1);
        }
        let _ = watch.join();
        child.lock().unwrap().wait()
    })
    .map_err(|e| e.to_string())?;
    let file = home.join(format!("{id}.mp4"));
    // A cancel that lands after yt-dlp finished keeps the finished file.
    if stop.load(Ordering::Relaxed) && !(status.success() && file.is_file()) {
        let _ = std::fs::remove_file(&file);
        return Err("Canceled".into());
    }
    if !status.success() || !file.is_file() {
        let why = last_line(&log);
        return Err(format!(
            "yt-dlp: {}",
            if why.is_empty() { "failed" } else { &why }
        ));
    }
    let _ = std::fs::remove_dir_all(temp);
    Ok(file)
}

fn download_temp(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("ytdlp-dl")
        .join(id))
}

/// Saves the page behind a `flick-tool:ytdlp/` stream of plugin `plugin` as downloads/<id>.mp4.
#[tauri::command]
pub async fn tool_download(
    app: tauri::AppHandle,
    id: String,
    plugin: String,
    url: String,
) -> Result<String, String> {
    use tauri::Emitter;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<PluginTools>();
        let tools = state
            .tools
            .lock()
            .unwrap()
            .get(&plugin)
            .cloned()
            .unwrap_or_default();
        let hosts = app.state::<super::plugins::PluginHosts>().hosts_of(&plugin);
        let page = download_page(&state, &tools, &hosts, &id, &url)?;
        let ffmpeg = super::find_tool("ffmpeg")
            .ok_or("Saving this needs ffmpeg. Install it with: brew install ffmpeg")?;
        let bin = match managed(
            &env(&app, &state)?.dir,
            &state.fetch,
            Duration::from_secs(300),
        ) {
            Ok(b) => b,
            Err(e) => super::find_tool("yt-dlp").ok_or(e)?,
        };
        let (home, temp) = (super::downloads_dir(&app)?, download_temp(&app, &id)?);
        let downloads = app.state::<super::Downloads>();
        let stop = downloads.begin(&id)?;
        let args = download_args(&ffmpeg, &home, &temp, &id, &page);
        let res = save(&bin, &args, &home, &temp, &id, &stop, |done, total| {
            let _ = app.emit(
                "download-progress",
                super::DownloadProgress {
                    id: id.clone(),
                    done,
                    total,
                    part: String::new(),
                },
            );
        });
        downloads.end(&id, &stop);
        res.map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes what an unfinished yt-dlp download left in the cache.
#[tauri::command]
pub fn tool_download_clean(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if !super::valid_id(&id) {
        return Err("Bad download name".into());
    }
    if app
        .state::<super::Downloads>()
        .0
        .lock()
        .unwrap()
        .contains_key(&id)
    {
        return Err("That download is still running.".into());
    }
    match std::fs::remove_dir_all(download_temp(&app, &id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
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
        let err = open(
            &e,
            &st,
            Path::new("/nonexistent"),
            "flick-tool:ytdlp/abc",
            false,
        )
        .unwrap_err();
        assert!(err.contains("expired"), "{err}");
    }

    /// Review first-F1 on #45: open video A, close it while it starts, open video B. A's wait
    /// must end without touching B's yt-dlp and ffmpeg; only B's own timeout stops them.
    #[cfg(unix)]
    #[test]
    fn an_older_stream_never_stops_the_newer_one() {
        let st = PluginTools::default();
        let dir = std::env::temp_dir().join(format!("flick-ytdlp-job-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let playlist = dir.join("index.m3u8");
        let sleeper = || Command::new("sleep").arg("30").spawn().unwrap();
        let running = |st: &PluginTools| {
            let mut job = st.job.lock().unwrap();
            !job.children.is_empty()
                && job
                    .children
                    .iter_mut()
                    .all(|c| matches!(c.try_wait(), Ok(None)))
        };
        let a = start_job(&st, vec![sleeper()]);
        let b = start_job(&st, vec![sleeper(), sleeper()]);
        assert_ne!(a, b);
        let err = wait_for_segment(
            &st,
            a,
            &playlist,
            &dir,
            "yt-dlp.log",
            Duration::from_millis(300),
        )
        .unwrap_err();
        assert!(err.contains("Another video"), "{err}");
        assert!(running(&st), "A's wait stopped B's processes");
        // A replaced call that reaches its own timeout still leaves B running.
        stop_job_if(&st, a);
        assert!(running(&st), "stop_job_if(A) stopped B's processes");
        let err = wait_for_segment(
            &st,
            b,
            &playlist,
            &dir,
            "yt-dlp.log",
            Duration::from_millis(200),
        )
        .unwrap_err();
        assert!(err.contains("nothing within"), "{err}");
        assert!(st.job.lock().unwrap().children.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// yt-dlp's loader starts the real program as a child. Stopping a stream must stop that child
    /// too, or switching videos leaves the old download running.
    #[cfg(unix)]
    #[test]
    fn stopping_a_stream_stops_what_its_ytdlp_started() {
        let st = PluginTools::default();
        let pidfile = std::env::temp_dir().join(format!("flick-ytdlp-tree-{}", std::process::id()));
        let _ = std::fs::remove_file(&pidfile);
        let loader = own_group(
            Command::new("sh")
                .args(["-c", "sleep 30 & echo $! > \"$0\"; wait"])
                .arg(&pidfile),
        )
        .spawn()
        .unwrap();
        start_job(&st, vec![loader]);
        let t = Instant::now();
        let pid = loop {
            if let Some(p) = std::fs::read_to_string(&pidfile)
                .ok()
                .and_then(|p| p.trim().parse::<u32>().ok())
            {
                break p;
            }
            assert!(
                t.elapsed() < Duration::from_secs(5),
                "the loader never started its child"
            );
            std::thread::sleep(Duration::from_millis(20));
        };
        let alive = || {
            Command::new("kill")
                .args(["-0", &pid.to_string()])
                .stderr(Stdio::null())
                .status()
                .unwrap()
                .success()
        };
        assert!(alive());
        stop_job(&st);
        let t = Instant::now();
        while alive() && t.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(20));
        }
        let left = alive();
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .status();
        let _ = std::fs::remove_file(&pidfile);
        assert!(
            !left,
            "the loader's child kept running after the stream stopped"
        );
    }

    /// Flick's own yt-dlp, replaced by a script that prints `out` (SPEC-youtube-play cases 1 to 3).
    #[cfg(unix)]
    fn with_fake_master(out: &str) -> (PluginTools, Env, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "flick-master-{}-{}",
            std::process::id(),
            new_token().unwrap()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = managed_path(&dir);
        std::fs::create_dir_all(bin.parent().unwrap()).unwrap();
        std::fs::write(
            &bin,
            format!("#!/bin/sh\necho \"$@\" >> \"$0.calls\"\nprintf '{out}'\n"),
        )
        .unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Fresh, so update_daily never runs the stand-in with -U.
        std::fs::write(stamp_path(&dir, &bin), b"").unwrap();
        let st = PluginTools::default();
        st.tokens
            .lock()
            .unwrap()
            .insert("t".into(), "https://www.youtube.com/watch?v=a".into());
        (st, env_in(&dir), dir)
    }

    #[cfg(unix)]
    #[test]
    fn plays_youtubes_master_with_no_ffmpeg() {
        let m = "https://manifest.googlevideo.com/api/manifest/hls_variant/expire/99999999999/file/index.m3u8";
        let (st, e, dir) = with_fake_master(&format!("{m}\\nFalse\\n12660\\n"));
        let v = open(&e, &st, &dir.join("cache"), "flick-tool:ytdlp/t", false).unwrap();
        assert_eq!(
            v,
            json!({ "kind": "hls", "url": m, "live": false, "duration": 12660.0 })
        );
        assert!(
            st.job.lock().unwrap().children.is_empty(),
            "a process started for a master"
        );
        assert!(!dir.join("cache").exists(), "the local pipeline ran");
        let calls = std::fs::read_to_string(managed_path(&dir).with_extension("calls")).unwrap();
        assert!(calls.contains("-f bv*[protocol^=m3u8] -O manifest_url -O is_live -O duration -- https://www.youtube.com/watch?v=a"), "{calls}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_lookup_that_hangs_is_stopped_with_a_message() {
        let (_st, e, dir) = with_fake_master("");
        let bin = managed_path(&dir);
        std::fs::write(&bin, "#!/bin/sh\nsleep 30\n").unwrap();
        let t = Instant::now();
        let r = find_master_within(
            &e,
            "https://www.youtube.com/watch?v=a",
            Duration::from_secs(1),
        );
        assert_eq!(r.unwrap_err(), "yt-dlp found no stream within 1 s.");
        assert!(t.elapsed() < Duration::from_secs(5), "{:?}", t.elapsed());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn no_master_or_one_elsewhere_plays_one_file_through_ytdlp() {
        for out in [
            "NA\\nFalse\\n60\\n",
            "https://evil.example/api/manifest/index.m3u8\\nFalse\\n60\\n",
        ] {
            let (st, _e, dir) = with_fake_master(out);
            let find = |p: &str| {
                let o = Command::new(managed_path(&dir))
                    .args(ytmaster::args(p))
                    .output()
                    .unwrap();
                ytmaster::parse(o.status.success(), &String::from_utf8_lossy(&o.stdout), "")
            };
            assert_eq!(
                choose(&st, "flick-tool:ytdlp/t", false, &find).unwrap(),
                Play::Fallback {
                    page: "https://www.youtube.com/watch?v=a".into(),
                    token: "t".into()
                },
                "{out}"
            );
            let _ = std::fs::remove_dir_all(&dir);
        }
        let a = fallback_args("https://www.youtube.com/watch?v=a");
        let f = a[a.iter().position(|x| *x == "-f").unwrap() + 1];
        assert!(f.starts_with("b[") && !f.contains('+'), "{f}");
        assert_eq!(
            a[a.len() - 4..],
            ["-o", "-", "--", "https://www.youtube.com/watch?v=a"]
        );
    }

    #[test]
    fn a_download_saves_only_a_resolved_token_on_the_plugins_hosts() {
        let (st, e) = (PluginTools::default(), env_in(Path::new("/nonexistent")));
        let (t, hosts) = (s(&["ytdlp"]), s(&["www.youtube.com"]));
        let page = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
        let url = run_tool(&e, &st, &t, &hosts, "ytdlp", "resolve", &[json!(page)]).unwrap();
        let url = url.as_str().unwrap();
        assert_eq!(download_page(&st, &t, &hosts, "pl-1", url).unwrap(), page);
        let refused = |tools: &[String], hosts: &[String], id: &str, url: &str| {
            download_page(&st, tools, hosts, id, url).unwrap_err()
        };
        assert!(refused(&t, &hosts, "pl-1", "flick-tool:ytdlp/0123").contains("expired"));
        assert!(refused(&t, &hosts, "pl-1", page).contains("cannot save"));
        assert!(refused(&[], &hosts, "pl-1", url).contains("did not list"));
        // A plugin turned off (no hosts) or another plugin's hosts cannot save the page.
        assert!(refused(&t, &[], "pl-1", url).contains("hosts list"));
        assert!(refused(&t, &s(&["archive.org"]), "pl-1", url).contains("hosts list"));
        for bad in ["", "../etc", "a/b", &"x".repeat(65)] {
            assert!(
                refused(&t, &hosts, bad, url).contains("Bad download name"),
                "{bad}"
            );
        }
    }

    #[test]
    fn download_args_use_the_play_format_merged_to_one_mp4() {
        let a = download_args(
            Path::new("/bin/ffmpeg"),
            Path::new("/d"),
            Path::new("/c/dl-x"),
            "pl-x",
            "https://www.youtube.com/watch?v=a",
        );
        let a: Vec<String> = a.iter().map(|x| x.to_string_lossy().into_owned()).collect();
        let after = |k: &str| a[a.iter().position(|x| x == k).unwrap() + 1].clone();
        assert_eq!(after("-f"), SAVE_FORMAT);
        assert_eq!(after("--merge-output-format"), "mp4");
        assert_eq!(after("--ffmpeg-location"), "/bin/ffmpeg");
        assert!(
            a.windows(2).any(|w| w == ["-P", "home:/d"])
                && a.windows(2).any(|w| w == ["-P", "temp:/c/dl-x"])
        );
        // The page is the last argument, after `--`, so it can never be read as an option.
        assert_eq!(
            a[a.len() - 4..],
            ["-o", "pl-x.mp4", "--", "https://www.youtube.com/watch?v=a"]
        );
        assert_eq!(a[0], "--ignore-config");
        assert!(!a
            .iter()
            .any(|x| x.starts_with("--exec") || x == "-a" || x == "--batch-file"));
    }

    #[test]
    fn progress_adds_the_video_and_audio_parts() {
        assert_eq!(progress_line("FLICK 10 100"), Some((10, 100)));
        assert_eq!(progress_line("FLICK 10 NA"), Some((10, 0)));
        assert_eq!(progress_line("FLICK 10 12345.6"), Some((10, 12345)));
        assert_eq!(progress_line("[download] 10%"), None);
        let mut t = Tally::default();
        assert_eq!(t.add(50, 100), (50, 100));
        assert_eq!(t.add(100, 100), (100, 100));
        assert_eq!(t.add(5, 20), (105, 120));
        assert_eq!(t.add(20, 20), (120, 120));
    }

    /// A stand-in yt-dlp: prints progress, writes `<home>/<id>.mp4`, or sleeps when told to.
    #[cfg(unix)]
    fn fake_ytdlp(dir: &Path, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let bin = dir.join("fake-yt-dlp");
        std::fs::write(&bin, format!("#!/bin/sh\nfor a; do case \"$a\" in home:*) H=\"${{a#home:}}\";; esac; done\n{body}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    #[cfg(unix)]
    #[test]
    fn save_reports_progress_returns_the_file_and_stops_on_cancel() {
        use std::sync::atomic::AtomicBool;
        let dir = std::env::temp_dir().join(format!("flick-ytdlp-save-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (home, temp) = (dir.join("downloads"), dir.join("dl-x"));
        let args = download_args(
            Path::new("ffmpeg"),
            &home,
            &temp,
            "pl-x",
            "https://www.youtube.com/watch?v=a",
        );
        let ok = fake_ytdlp(
            &dir,
            "echo 'FLICK 4 8'; sleep 0.3; echo 'FLICK 6 8'; echo 'FLICK 8 8'; printf mp4 > \"$H/pl-x.mp4\"",
        );
        let mut seen = vec![];
        let stop = AtomicBool::new(false);
        let file = save(&ok, &args, &home, &temp, "pl-x", &stop, |d, t| {
            seen.push((d, t))
        })
        .unwrap();
        assert_eq!(file, home.join("pl-x.mp4"));
        assert_eq!(
            seen,
            [(4, 8), (6, 8), (8, 8)],
            "the last tick always goes out"
        );
        assert!(!temp.exists(), "a finished download leaves no parts behind");
        // yt-dlp fails: its last line is the error.
        let bad = fake_ytdlp(&dir, "echo 'ERROR: Video unavailable' >&2; exit 1");
        let err = save(&bad, &args, &home, &temp, "pl-y", &stop, |_, _| {}).unwrap_err();
        assert_eq!(err, "yt-dlp: ERROR: Video unavailable");
        // Cancel kills a yt-dlp that prints nothing.
        // Review first-F1 on #52: the real yt-dlp is a loader plus a child that holds the output
        // open; killing only the loader left the read waiting for the whole download.
        let slow = fake_ytdlp(&dir, "sleep 30 & wait");
        let stop = Arc::new(AtomicBool::new(false));
        let s2 = stop.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            s2.store(true, std::sync::atomic::Ordering::Relaxed);
        });
        let clock = Instant::now();
        let err = save(&slow, &args, &home, &temp, "pl-z", &stop, |_, _| {}).unwrap_err();
        assert_eq!(err, "Canceled");
        assert!(clock.elapsed() < Duration::from_secs(5));
        let _ = std::fs::remove_dir_all(&dir);
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

    /// Real network run: Flick's own yt-dlp saves a short video as one mp4 through the same path.
    /// `FLICK_YTDLP_DIR=<dir> cargo test ytdlp_save_live -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn ytdlp_save_live() {
        let dir = std::env::var("FLICK_YTDLP_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("flick-ytdlp-live"));
        let (st, e) = (PluginTools::default(), env_in(&dir));
        let (t, hosts) = (s(&["ytdlp"]), s(&["www.youtube.com"]));
        let page = "https://www.youtube.com/watch?v=jNQXAC9IVRw";
        let url = run_tool(&e, &st, &t, &hosts, "ytdlp", "resolve", &[json!(page)]).unwrap();
        let page = download_page(&st, &t, &hosts, "pl-live", url.as_str().unwrap()).unwrap();
        let bin = managed(&e.dir, &e.fetch, Duration::from_secs(300)).unwrap();
        let ffmpeg = super::super::find_tool("ffmpeg").expect("ffmpeg");
        let out = std::env::temp_dir().join("flick-ytdlp-save-live");
        let (home, temp) = (out.join("downloads"), out.join("dl-pl-live"));
        let _ = std::fs::remove_dir_all(&out);
        let args = download_args(&ffmpeg, &home, &temp, "pl-live", &page);
        let stop = std::sync::atomic::AtomicBool::new(false);
        let mut last = (0, 0);
        let file = save(&bin, &args, &home, &temp, "pl-live", &stop, |d, t| {
            last = (d, t)
        })
        .unwrap();
        let bytes = std::fs::read(&file).unwrap();
        println!(
            "saved {} ({} bytes), last progress {last:?}",
            file.display(),
            bytes.len()
        );
        assert_eq!(&bytes[4..8], b"ftyp", "an mp4 starts with an ftyp box");
        assert!(last.0 > 0 && last.0 <= last.1);
        assert_eq!(
            std::fs::read_dir(&home).unwrap().count(),
            1,
            "one file, no parts"
        );
        // Cancel a long one mid-download: the real two-process yt-dlp stops within seconds.
        let url = run_tool(
            &e,
            &st,
            &t,
            &hosts,
            "ytdlp",
            "resolve",
            &[json!("https://www.youtube.com/watch?v=aqz-KE-bpKQ")],
        )
        .unwrap();
        let page = download_page(&st, &t, &hosts, "pl-long", url.as_str().unwrap()).unwrap();
        let temp = out.join("dl-pl-long");
        let args = download_args(&ffmpeg, &home, &temp, "pl-long", &page);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (s2, at) = (stop.clone(), Arc::new(Mutex::new(None::<Instant>)));
        let at2 = at.clone();
        let err = save(&bin, &args, &home, &temp, "pl-long", &stop, move |d, _| {
            if d > 2_000_000 && !s2.swap(true, std::sync::atomic::Ordering::Relaxed) {
                *at2.lock().unwrap() = Some(Instant::now());
            }
        })
        .unwrap_err();
        let took = at.lock().unwrap().expect("cancel was sent").elapsed();
        println!("cancel: {err} after {took:?}");
        assert!(err == "Canceled" && took < Duration::from_secs(3));
        assert!(!home.join("pl-long.mp4").exists());
    }

    /// Real network run on this computer: Flick's own yt-dlp searches, resolves and finds each master.
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
        // Case 10 of SPEC-youtube-play: a long video's master, and its first segment in under 2 s.
        let long = run_tool(
            &e,
            &st,
            &t,
            &hosts,
            "ytdlp",
            "resolve",
            &[json!("https://www.youtube.com/watch?v=7xTGNNLPyMI")],
        )
        .unwrap();
        for url in [url, long] {
            let clock = Instant::now();
            let cache = std::env::temp_dir().join("flick-ytdlp-live-cache");
            let v = open(&e, &st, &cache, url.as_str().unwrap(), false).unwrap();
            assert_eq!(v["kind"], "hls", "{v}");
            let master = v["url"].as_str().unwrap();
            assert!(master.starts_with("https://manifest.googlevideo.com/"));
            println!(
                "master found after {:?}, live {}",
                clock.elapsed(),
                v["live"]
            );
            let clock = Instant::now();
            let get = |u: &str| {
                ureq::get(u)
                    .call()
                    .unwrap()
                    .body_mut()
                    .read_to_vec()
                    .unwrap()
            };
            let text = |u: &str| String::from_utf8(get(u)).unwrap();
            let first = |t: &str| {
                t.lines()
                    .find(|l| !l.is_empty() && !l.starts_with('#'))
                    .unwrap()
                    .to_string()
            };
            let variant = first(&text(master));
            let seg = first(&text(&variant));
            let bytes = get(&seg);
            let took = clock.elapsed();
            println!(
                "variant, then first segment: {} bytes in {took:?}",
                bytes.len()
            );
            assert!(
                bytes.len() > 10_000 && took < Duration::from_secs(2),
                "{took:?}"
            );
        }
        stop_job(&st);
    }

    #[test]
    fn fetches_again_only_when_the_published_checksum_changed() {
        assert!(!needs_fetch(Some("ab"), Some("ab")));
        assert!(!needs_fetch(Some("ab\n"), Some("ab")));
        assert!(needs_fetch(Some("ab"), Some("cd")));
        assert!(needs_fetch(None, Some("cd")));
        assert!(!needs_fetch(Some("ab"), None));
        assert!(!needs_fetch(None, None));
    }

    #[cfg(target_os = "macos")]
    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flick-ytdlp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_mac_build_is_the_unpacked_one() {
        let d = Path::new("/t");
        assert_eq!(asset(), Some("yt-dlp_macos.zip"));
        assert_eq!(managed_path(d), d.join("yt-dlp_macos/yt-dlp_macos"));
        assert_eq!(legacy_path(d), Some(d.join("yt-dlp")));
        // Outside the folder an update replaces, so it survives the update.
        assert_eq!(
            stamp_path(d, &managed_path(d)),
            d.join("yt-dlp_macos.updated")
        );
    }

    #[test]
    fn one_daily_update_at_a_time() {
        static FLAG: AtomicBool = AtomicBool::new(false);
        let first = Claim::take(&FLAG).expect("the first update gets the slot");
        assert!(
            Claim::take(&FLAG).is_none(),
            "a second update waits for the next call"
        );
        drop(first);
        assert!(
            Claim::take(&FLAG).is_some(),
            "the slot frees when the update ends"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unpack_replaces_the_copy_and_removes_the_one_file_build() {
        let dir = tmp("unpack");
        let make_zip = |tag: &str| {
            let src = dir.join(format!("src-{tag}"));
            std::fs::create_dir_all(src.join("_internal")).unwrap();
            std::fs::write(src.join("yt-dlp_macos"), format!("#!/bin/sh\necho {tag}\n")).unwrap();
            std::fs::write(src.join("_internal/lib"), tag).unwrap();
            let zip = dir.join(format!("{tag}.zip"));
            assert!(Command::new("/usr/bin/ditto")
                .args(["-c", "-k"])
                .arg(&src)
                .arg(&zip)
                .status()
                .unwrap()
                .success());
            zip
        };
        std::fs::write(dir.join("yt-dlp"), "old one-file").unwrap();
        std::fs::write(dir.join("yt-dlp.updated"), "").unwrap();
        unpack(&make_zip("one"), &dir, "sum1").unwrap();
        assert!(managed_path(&dir).is_file());
        assert_eq!(
            std::fs::read_to_string(dir.join("yt-dlp_macos/_internal/lib")).unwrap(),
            "one"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("yt-dlp_macos/release.sha256")).unwrap(),
            "sum1"
        );
        assert!(!dir.join("yt-dlp").exists() && !dir.join("yt-dlp.updated").exists());
        assert!(!dir.join("one.zip").exists());
        // An update replaces the copy in place.
        unpack(&make_zip("two"), &dir, "sum2").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("yt-dlp_macos/_internal/lib")).unwrap(),
            "two"
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("yt-dlp_macos/release.sha256")).unwrap(),
            "sum2"
        );
        assert!(!dir.join("yt-dlp_macos.new").exists());
        // The copy it replaced stays until the next update, for a search still running from it.
        assert_eq!(
            std::fs::read_to_string(dir.join("yt-dlp_macos.old/_internal/lib")).unwrap(),
            "one"
        );
        unpack(&make_zip("three"), &dir, "sum3").unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.join("yt-dlp_macos.old/_internal/lib")).unwrap(),
            "two"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unpack_refuses_what_is_not_the_build_and_keeps_the_copy() {
        let dir = tmp("badzip");
        std::fs::create_dir_all(dir.join("yt-dlp_macos")).unwrap();
        std::fs::write(managed_path(&dir), "kept").unwrap();
        let bad = dir.join("bad.zip");
        std::fs::write(&bad, "not a zip").unwrap();
        assert_eq!(
            unpack(&bad, &dir, "x").unwrap_err(),
            "Could not unpack yt-dlp."
        );
        assert_eq!(std::fs::read_to_string(managed_path(&dir)).unwrap(), "kept");
        assert!(!bad.exists() && !dir.join("yt-dlp_macos.new").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_one_file_build_keeps_working_while_the_unpacked_one_downloads_or_fails() {
        let dir = tmp("legacy");
        std::fs::write(dir.join("yt-dlp"), "old").unwrap();
        let getting = Arc::new(Mutex::new(Fetch::Getting { got: 1, total: 2 }));
        assert_eq!(
            managed(&dir, &getting, Duration::from_secs(300)).unwrap(),
            dir.join("yt-dlp")
        );
        let failed = Arc::new(Mutex::new(Fetch::Failed("offline".into())));
        assert_eq!(
            managed(&dir, &failed, Duration::ZERO).unwrap(),
            dir.join("yt-dlp")
        );
        assert!(matches!(*failed.lock().unwrap(), Fetch::Idle));
        // Without the old build, a failed download is an error as before.
        std::fs::remove_file(dir.join("yt-dlp")).unwrap();
        let failed = Arc::new(Mutex::new(Fetch::Failed("offline".into())));
        assert_eq!(
            managed(&dir, &failed, Duration::ZERO).unwrap_err(),
            "offline"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
