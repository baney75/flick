// Flick desktop backend: folder scanning, format probing, ffmpeg remux for MKV/AVI,
// thumbnails, subtitles, Finder "Open With", and the default-player switch.

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, Manager};

mod plugins;
mod selftest;
mod share;
#[cfg(desktop)]
mod torrent;
#[cfg(desktop)]
mod torrent_http;
#[cfg(desktop)]
mod vpn;
mod ytdlp;

const VIDEO: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "ts", "m2ts", "mts", "mpg", "mpeg",
    "ogv", "3gp",
];
const AUDIO: &[&str] = &[
    "mp3", "m4a", "m4b", "aac", "flac", "wav", "ogg", "opus", "alac", "aiff", "aif", "wma",
];
const SUBS: &[&str] = &["srt", "vtt", "ass", "ssa"];
const BOOKS: &[&str] = &["pdf", "epub"];
const PHOTOS: &[&str] = &["jpg", "jpeg", "png", "heic", "heif", "webp", "gif", "avif"];
// What WKWebView plays without help.
const NATIVE_EXT: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mp3", "m4a", "m4b", "aac", "wav", "flac", "aiff", "aif", "3gp",
];

#[derive(Default)]
struct Opened(Mutex<Vec<String>>);

fn ext_of(p: &Path) -> String {
    p.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_media(p: &Path) -> bool {
    let e = ext_of(p);
    [VIDEO, AUDIO, BOOKS, PHOTOS]
        .iter()
        .any(|list| list.contains(&e.as_str()))
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    // Apps launched from Finder do not get the shell PATH, so check the usual spots first.
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = Path::new(dir).join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|d| d.join(&name))
            .find(|p| p.is_file())
    })
}

#[derive(Serialize)]
struct ScanEntry {
    path: String,
    name: String,
    size: u64,
    mtime: u64,
}

#[tauri::command]
async fn scan_folder(path: String) -> Result<Vec<ScanEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out = Vec::new();
        let walker = walkdir::WalkDir::new(&path)
            .follow_links(true)
            .into_iter()
            .filter_entry(|e| {
                !e.file_name()
                    .to_str()
                    .map(|s| s.starts_with('.'))
                    .unwrap_or(false)
            });
        for entry in walker.flatten() {
            if !entry.file_type().is_file() || !is_media(entry.path()) {
                continue;
            }
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(ScanEntry {
                path: entry.path().to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
                size: meta.len(),
                mtime,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize, Default, Clone)]
struct Probe {
    duration: f64,
    container: String,
    video: Option<String>,
    audio: Option<String>,
    playable: bool,
    subs: Vec<(usize, String, String)>,
}

fn is_url(input: &str) -> bool {
    let l = input.get(..8).unwrap_or(input).to_ascii_lowercase();
    l.starts_with("http://") || l.starts_with("https://")
}

/// The Basic auth header value, or None with no username.
fn basic(user: &str, pass: &str) -> Option<String> {
    use base64::Engine;
    (!user.is_empty()).then(|| {
        format!(
            "Basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"))
        )
    })
}

/// ffmpeg/ffprobe input arguments. An http(s) input gets the login as a header, never in the URL.
fn input_args(input: &str, auth: Option<&str>) -> Vec<String> {
    let mut a = vec![];
    if let (true, Some(auth)) = (is_url(input), auth) {
        a.extend(["-headers".into(), format!("Authorization: {auth}\r\n")]);
    }
    a.extend(["-i".into(), input.into()]);
    a
}

fn run_probe(path: &str, auth: Option<&str>) -> Option<Probe> {
    let ffprobe = find_tool("ffprobe")?;
    let out = Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=format_name,duration:stream=index,codec_type,codec_name:stream_tags=language,title", "-of", "json"])
        .args(input_args(path, auth))
        .output()
        .ok()?;
    let j: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let mut p = Probe {
        container: j["format"]["format_name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        duration: j["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        ..Default::default()
    };
    let mut sub_n = 0;
    for s in j["streams"].as_array().cloned().unwrap_or_default() {
        let codec = s["codec_name"].as_str().unwrap_or("").to_string();
        match s["codec_type"].as_str() {
            Some("video") if p.video.is_none() && codec != "mjpeg" && codec != "png" => {
                p.video = Some(codec)
            }
            Some("audio") if p.audio.is_none() => p.audio = Some(codec),
            Some("subtitle") => {
                if ["subrip", "ass", "ssa", "webvtt", "mov_text", "text"].contains(&codec.as_str())
                {
                    let lang = s["tags"]["language"].as_str().unwrap_or("").to_string();
                    let title = s["tags"]["title"].as_str().unwrap_or("").to_string();
                    p.subs.push((sub_n, lang, title));
                }
                sub_n += 1;
            }
            _ => {}
        }
    }
    let c = p.container.as_str();
    let container_ok = c.contains("mp4")
        || c.contains("mov")
        || c == "mp3"
        || c == "wav"
        || c == "flac"
        || c == "aac"
        || c.contains("webm")
        || c == "aiff";
    // ffprobe calls WebM "matroska,webm", so check the extension to tell MKV from WebM.
    let is_mkv = Path::new(path)
        .extension()
        .map(|e| e.eq_ignore_ascii_case("mkv"))
        .unwrap_or(false);
    let video_ok = p
        .video
        .as_deref()
        .map(|v| ["h264", "hevc", "vp9", "vp8", "av1", "mjpeg"].contains(&v))
        .unwrap_or(true);
    let audio_ok = p
        .audio
        .as_deref()
        .map(|a| {
            [
                "aac",
                "mp3",
                "alac",
                "flac",
                "opus",
                "vorbis",
                "pcm_s16le",
                "pcm_s24le",
                "ac3",
                "eac3",
            ]
            .contains(&a)
        })
        .unwrap_or(true);
    p.playable = container_ok && !is_mkv && video_ok && audio_ok;
    Some(p)
}

#[derive(Serialize, Debug, PartialEq)]
struct Chapter {
    title: String,
    start: f64,
}

/// An audiobook's chapters as ffprobe reads them (M4B, MP3 with ID3 chapters, MKA, Ogg). Empty without ffprobe.
fn run_chapters(path: &str) -> Vec<Chapter> {
    let Some(ffprobe) = find_tool("ffprobe") else {
        return vec![];
    };
    let Ok(out) = Command::new(ffprobe)
        .args(["-v", "error", "-show_chapters", "-of", "json", "-i", path])
        .output()
    else {
        return vec![];
    };
    let j: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or_default();
    let list = j["chapters"].as_array().cloned().unwrap_or_default();
    list.iter()
        .enumerate()
        .map(|(i, c)| Chapter {
            title: c["tags"]["title"]
                .as_str()
                .map(str::to_string)
                .unwrap_or_else(|| format!("Chapter {}", i + 1)),
            start: c["start_time"]
                .as_str()
                .and_then(|s| s.parse().ok())
                .unwrap_or(0.0),
        })
        .collect()
}

#[tauri::command]
async fn chapters(path: String) -> Result<Vec<Chapter>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(run_chapters(&path)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn probe(path: String, user: Option<String>, pass: Option<String>) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let auth = basic(&user.unwrap_or_default(), &pass.unwrap_or_default());
        Ok(run_probe(&path, auth.as_deref()).unwrap_or_else(|| Probe {
            // No ffprobe: trust the extension.
            playable: NATIVE_EXT.contains(&ext_of(Path::new(&path)).as_str()),
            ..Default::default()
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cache_key(path: &str) -> String {
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    if let Ok(m) = std::fs::metadata(path) {
        m.len().hash(&mut h);
        if let Ok(t) = m.modified() {
            t.hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}

#[derive(Serialize, Clone)]
struct PrepareProgress {
    path: String,
    pct: f64,
}

/// Turn a file WKWebView cannot open (MKV, AVI, DTS audio...) into an MP4 it can.
/// Streams are copied when possible, so this takes seconds, not minutes.
/// `path` is a local file or an http(s) URL; the login, if any, goes to ffmpeg as a header.
#[tauri::command]
async fn prepare(
    app: tauri::AppHandle,
    path: String,
    user: Option<String>,
    pass: Option<String>,
) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("remux");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{}.mp4", cache_key(&path)));
    if out.is_file() {
        return Ok(out.to_string_lossy().into_owned());
    }
    let auth = basic(&user.unwrap_or_default(), &pass.unwrap_or_default());
    tauri::async_runtime::spawn_blocking(move || {
        remux(&path, auth.as_deref(), &out, |pct| {
            let _ = app.emit(
                "prepare-progress",
                PrepareProgress {
                    path: path.clone(),
                    pct,
                },
            );
        })?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// ffmpeg video arguments: copy H.264 and HEVC, transcode anything else to H.264.
/// VideoToolbox exists only on macOS, so other platforms use libx264.
fn video_args(codec: Option<&str>) -> Vec<String> {
    let v: &[&str] = match codec {
        Some("h264") => &["-c:v", "copy"],
        Some("hevc") => &["-c:v", "copy", "-tag:v", "hvc1"],
        Some(_) if cfg!(target_os = "macos") => &[
            "-c:v",
            "h264_videotoolbox",
            "-b:v",
            "10M",
            "-pix_fmt",
            "yuv420p",
        ],
        Some(_) => &[
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
        ],
        None => &[],
    };
    v.iter().map(|a| a.to_string()).collect()
}

fn remux(input: &str, auth: Option<&str>, out: &Path, on_pct: impl Fn(f64)) -> Result<(), String> {
    let ffmpeg = find_tool("ffmpeg")
        .ok_or("This format needs ffmpeg. Install it with: brew install ffmpeg")?;
    let probe = run_probe(input, auth).unwrap_or_default();
    let tmp = out.with_extension("part.mp4");
    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into()];
    args.extend(input_args(input, auth));
    args.extend([
        "-map".into(),
        "0:v:0?".into(),
        "-map".into(),
        "0:a:0?".into(),
    ]);
    args.extend(video_args(probe.video.as_deref()));
    match probe.audio.as_deref() {
        Some("aac") | Some("mp3") | Some("alac") => args.extend(["-c:a".into(), "copy".into()]),
        Some(_) => args.extend(["-c:a".into(), "aac".into(), "-b:a".into(), "320k".into()]),
        None => {}
    }
    args.extend([
        "-sn".into(),
        "-movflags".into(),
        "+faststart".into(),
        "-progress".into(),
        "pipe:1".into(),
        "-nostats".into(),
    ]);
    args.push(tmp.to_string_lossy().into_owned());

    let mut child = Command::new(ffmpeg)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=") {
                if let (Ok(us), true) = (us.parse::<f64>(), probe.duration > 0.0) {
                    on_pct((us / 1e6 / probe.duration * 100.0).clamp(0.0, 100.0));
                }
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "ffmpeg could not convert this file: {}",
            String::from_utf8_lossy(&output.stderr)
                .lines()
                .last()
                .unwrap_or("")
        ));
    }
    std::fs::rename(&tmp, out).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct SubFile {
    name: String,
    text: String,
}

/// Subtitle files next to the video with the same base name: Movie.srt, Movie.en.srt.
#[tauri::command]
fn sidecar_subs(path: String) -> Vec<SubFile> {
    let p = Path::new(&path);
    let (Some(dir), Some(stem)) = (p.parent(), p.file_stem().and_then(|s| s.to_str())) else {
        return vec![];
    };
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let ep = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if SUBS.contains(&ext_of(&ep).as_str()) && name.starts_with(stem) {
                if let Ok(bytes) = std::fs::read(&ep) {
                    out.push(SubFile {
                        name,
                        text: String::from_utf8_lossy(&bytes).into_owned(),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// Text subtitles inside the file (MKV and MP4), converted to WebVTT.
#[tauri::command]
async fn embedded_subs(path: String) -> Result<Vec<SubFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let Some(ffmpeg) = find_tool("ffmpeg") else {
            return Ok(vec![]);
        };
        let Some(probe) = run_probe(&path, None) else {
            return Ok(vec![]);
        };
        let mut out = vec![];
        for (n, lang, title) in probe.subs.iter().take(6) {
            let r = Command::new(&ffmpeg)
                .args([
                    "-v",
                    "error",
                    "-i",
                    &path,
                    "-map",
                    &format!("0:s:{n}"),
                    "-f",
                    "webvtt",
                    "-",
                ])
                .output();
            if let Ok(o) = r {
                if o.status.success() && !o.stdout.is_empty() {
                    let label = match (lang.is_empty(), title.is_empty()) {
                        (false, false) => format!("{title} ({lang})"),
                        (false, true) => lang.clone(),
                        (true, false) => title.clone(),
                        _ => format!("Track {}", n + 1),
                    };
                    out.push(SubFile {
                        name: format!("{label}.vtt"),
                        text: String::from_utf8_lossy(&o.stdout).into_owned(),
                    });
                }
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
struct Thumb {
    duration: f64,
    jpeg: Option<Vec<u8>>,
}

#[tauri::command]
async fn thumbnail(path: String) -> Result<Thumb, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let duration = run_probe(&path, None).map(|p| p.duration).unwrap_or(0.0);
        if let Some(ffmpeg) = find_tool("ffmpeg") {
            let at = (duration * 0.12).clamp(1.0, 120.0);
            let o = Command::new(ffmpeg)
                .args([
                    "-v",
                    "error",
                    "-ss",
                    &format!("{at:.2}"),
                    "-i",
                    &path,
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=400:-2",
                    "-f",
                    "image2pipe",
                    "-c:v",
                    "mjpeg",
                    "-q:v",
                    "5",
                    "-",
                ])
                .output()
                .map_err(|e| e.to_string())?;
            if o.status.success() && !o.stdout.is_empty() {
                return Ok(Thumb {
                    duration,
                    jpeg: Some(o.stdout),
                });
            }
        }
        Ok(Thumb {
            duration,
            jpeg: quicklook_thumb(&path),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Without ffmpeg, ask macOS Quick Look for a thumbnail. Works for MP4 and MOV.
fn quicklook_thumb(path: &str) -> Option<Vec<u8>> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("flick-ql-{}", cache_key(path)));
    std::fs::create_dir_all(&dir).ok()?;
    Command::new("/usr/bin/qlmanage")
        .args(["-t", "-s", "400", "-o"])
        .arg(&dir)
        .arg(path)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .ok()?;
    let file = std::fs::read_dir(&dir).ok()?.flatten().next()?.path();
    let bytes = std::fs::read(&file).ok();
    let _ = std::fs::remove_dir_all(&dir);
    bytes
}

#[derive(Serialize)]
struct FfmpegStatus {
    ffmpeg: Option<String>,
}

#[tauri::command]
fn ffmpeg_status() -> FfmpegStatus {
    FfmpegStatus {
        ffmpeg: find_tool("ffmpeg").map(|p| p.to_string_lossy().into_owned()),
    }
}

/// Calls Kodi's JSON-RPC API. Kodi sends no CORS headers, so the web view cannot call it directly.
#[tauri::command]
async fn kodi_rpc(
    url: String,
    user: String,
    pass: String,
    method: String,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || kodi_call(&url, &user, &pass, &method, params))
        .await
        .map_err(|e| e.to_string())?
}

fn kodi_agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(std::time::Duration::from_secs(10)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// Fetches Kodi art with the login and returns it as a data URL, since <img> cannot send the header.
#[tauri::command]
async fn kodi_image(url: String, user: String, pass: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let mut req = kodi_agent().get(&url);
        if let Some(auth) = basic(&user, &pass) {
            req = req.header("Authorization", auth);
        }
        let mut resp = req.call().map_err(|e| e.to_string())?;
        if resp.status() != 200 {
            return Err(format!("Kodi said {}", resp.status().as_u16()));
        }
        let mime = resp
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_string();
        let bytes = resp
            .body_mut()
            .with_config()
            .limit(2 * 1024 * 1024)
            .read_to_vec()
            .map_err(|e| e.to_string())?;
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn kodi_call(
    url: &str,
    user: &str,
    pass: &str,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let mut req = kodi_agent().post(format!("{}/jsonrpc", url.trim_end_matches('/')));
    if let Some(auth) = basic(user, pass) {
        req = req.header("Authorization", auth);
    }
    let body = serde_json::json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params });
    let mut resp = req
        .send_json(&body)
        .map_err(|e| format!("No Kodi answered at that address ({e})."))?;
    match resp.status().as_u16() {
        200 => {}
        401 => return Err("Wrong username or password.".into()),
        code => return Err(format!("Kodi said {code}")),
    }
    // A big library's JSON-RPC answer can pass ureq's 10 MB default.
    let mut j: serde_json::Value = resp
        .body_mut()
        .with_config()
        .limit(64 * 1024 * 1024)
        .read_json()
        .map_err(|e| e.to_string())?;
    if let Some(err) = j.get("error") {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("error");
        return Err(format!("Kodi said: {msg}"));
    }
    Ok(j["result"].take())
}

// ---- kodi:// streaming proxy ----
// <video> cannot send Basic auth, so the web view asks kodi://localhost/<server id>/<path> and the
// shell fetches base + path with the login. Each answer is at most CHUNK bytes, so a 10 GB file
// never sits in memory; media elements ask again for the next range.

const CHUNK: u64 = 8 * 1024 * 1024;

struct KodiLogin {
    base: String,
    auth: Option<String>,
}

#[derive(Default)]
struct KodiProxy(Mutex<HashMap<String, KodiLogin>>);

/// Stores a Kodi login for the kodi:// proxy. Only base + path under it is ever fetched.
#[tauri::command]
fn kodi_proxy_register(
    state: tauri::State<KodiProxy>,
    id: String,
    base: String,
    user: String,
    pass: String,
) -> Result<(), String> {
    if !is_url(&base) {
        return Err("Kodi address must start with http:// or https://".into());
    }
    let base = base.trim_end_matches('/').to_string();
    let auth = basic(&user, &pass);
    state.0.lock().unwrap().insert(id, KodiLogin { base, auth });
    Ok(())
}

/// Splits a proxy URI path ("/<id>%2F<path>", as convertFileSrc builds it) into id and path.
/// Returns None unless the path is vfs/<one segment>, Kodi's file endpoint, so the login never
/// reaches jsonrpc or any other Kodi URL.
fn proxy_target(uri_path: &str) -> Option<(String, String)> {
    let decoded = percent_encoding::percent_decode_str(uri_path.trim_start_matches('/'))
        .decode_utf8()
        .ok()?;
    let (id, rest) = decoded.split_once('/')?;
    // Only Kodi's file endpoint, vfs/<one encoded segment>: never jsonrpc, image or a query.
    let file = rest.strip_prefix("vfs/")?;
    let bad = |c: char| matches!(c, '/' | '?' | '#' | ':' | '\\');
    if id.is_empty() || file.is_empty() || file.contains(bad) {
        return None;
    }
    let d = percent_encoding::percent_decode_str(file).decode_utf8_lossy();
    if d == ".." || d == "." {
        return None;
    }
    Some((id.to_string(), rest.to_string()))
}

#[derive(Debug, PartialEq)]
enum Want {
    /// bytes=start- or bytes=start-end (or no Range: from 0).
    From(u64, Option<u64>),
    /// bytes=-n: the last n bytes.
    Last(u64),
}

fn parse_range(h: Option<&str>) -> Want {
    let spec = h.and_then(|h| h.trim().strip_prefix("bytes="));
    let Some(spec) = spec.filter(|s| !s.contains(',')) else {
        return Want::From(0, None);
    };
    let Some((a, b)) = spec.trim().split_once('-') else {
        return Want::From(0, None);
    };
    match (a.parse::<u64>(), b.parse::<u64>()) {
        (Ok(a), Ok(b)) if b >= a => Want::From(a, Some(b)),
        (Ok(a), Err(_)) if b.is_empty() => Want::From(a, None),
        (Err(_), Ok(n)) if a.is_empty() && n > 0 => Want::Last(n),
        _ => Want::From(0, None),
    }
}

/// The Range sent to Kodi: what was asked, capped to CHUNK bytes.
fn upstream_range(w: &Want) -> String {
    match *w {
        Want::From(a, b) => {
            let cap = a + CHUNK - 1;
            format!("bytes={a}-{}", b.map_or(cap, |b| b.min(cap)))
        }
        Want::Last(n) => format!("bytes=-{}", n.min(CHUNK)),
    }
}

/// The inclusive span to answer for a file of `total` bytes, capped to CHUNK. None means 416.
fn answer_span(w: &Want, total: u64) -> Option<(u64, u64)> {
    let (a, b) = match *w {
        Want::From(a, b) => (a, b.unwrap_or(u64::MAX)),
        Want::Last(n) => (total.saturating_sub(n.min(CHUNK)), u64::MAX),
    };
    if a >= total {
        return None;
    }
    Some((a, b.min(total - 1).min(a + CHUNK - 1)))
}

type Answer = tauri::http::Response<Vec<u8>>;

fn plain(status: u16, msg: &str) -> Answer {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}

/// Fetches base/path from Kodi with the login and the capped Range, and builds the answer.
fn proxy_fetch(base: &str, auth: Option<&str>, path: &str, range: Option<&str>) -> Answer {
    use std::io::Read;
    let want = parse_range(range);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(10)))
        .timeout_global(Some(std::time::Duration::from_secs(120)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut req = agent
        .get(format!("{base}/{path}"))
        .header("Range", upstream_range(&want));
    if let Some(auth) = auth {
        req = req.header("Authorization", auth);
    }
    let resp = match req.call() {
        Ok(r) => r,
        Err(e) => return plain(502, &format!("Kodi did not answer ({e})")),
    };
    let status = resp.status().as_u16();
    let head = |name: &str| {
        resp.headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let mime = head("content-type").unwrap_or_else(|| "application/octet-stream".into());
    let kodi_range = head("content-range");
    let total = head("content-length").and_then(|v| v.parse::<u64>().ok());
    let mut body = resp.into_body().into_reader();
    let mut buf = vec![];
    let out = tauri::http::Response::builder()
        .header("Content-Type", mime)
        .header("Accept-Ranges", "bytes");
    let out = match status {
        206 => {
            if let Err(e) = body.take(CHUNK).read_to_end(&mut buf) {
                return plain(502, &e.to_string());
            }
            let out = out.status(206);
            match kodi_range {
                Some(cr) => out.header("Content-Range", cr),
                None => out,
            }
        }
        // Kodi ignored the Range and sent the whole file: cut the span out here.
        200 => {
            let Some(total) = total else {
                let _ = body.take(CHUNK).read_to_end(&mut buf);
                return tauri::http::Response::builder()
                    .status(200)
                    .header("Content-Length", buf.len())
                    .body(buf)
                    .unwrap();
            };
            let Some((a, b)) = answer_span(&want, total) else {
                return tauri::http::Response::builder()
                    .status(416)
                    .header("Content-Range", format!("bytes */{total}"))
                    .body(vec![])
                    .unwrap();
            };
            let skipped = std::io::copy(&mut (&mut body).take(a), &mut std::io::sink());
            if skipped.ok() != Some(a) || body.take(b - a + 1).read_to_end(&mut buf).is_err() {
                return plain(502, "Kodi closed the connection early");
            }
            out.status(206)
                .header("Content-Range", format!("bytes {a}-{b}/{total}"))
        }
        code => {
            let _ = body.take(64 * 1024).read_to_end(&mut buf);
            out.status(code)
        }
    };
    out.header("Content-Length", buf.len()).body(buf).unwrap()
}

fn kodi_proxy(app: &tauri::AppHandle, req: &tauri::http::Request<Vec<u8>>) -> Answer {
    let Some((id, path)) = proxy_target(req.uri().path()) else {
        return plain(400, "Bad Kodi path");
    };
    let login = {
        let map = app.state::<KodiProxy>();
        let map = map.0.lock().unwrap();
        map.get(&id).map(|l| (l.base.clone(), l.auth.clone()))
    };
    let Some((base, auth)) = login else {
        return plain(404, "Unknown Kodi server");
    };
    let range = req.headers().get("range").and_then(|v| v.to_str().ok());
    proxy_fetch(&base, auth.as_deref(), &path, range)
}

// ---- offline downloads ----
// A server file streams into app_data_dir/downloads/<id>.<ext>.part, resumes from the part's
// size with a Range request, and is renamed to <id>.<ext> once complete.

fn valid_id(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

fn valid_ext(s: &str) -> bool {
    (1..=5).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// Stop flags for running downloads, by item id.
#[derive(Default)]
struct Downloads(Mutex<HashMap<String, Arc<AtomicBool>>>);

impl Downloads {
    /// Registers a run for `id` and returns its stop flag. A second run for the same id would
    /// append to the same .part, so it is refused. Check and insert share one lock.
    fn begin(&self, id: &str) -> Result<Arc<AtomicBool>, String> {
        let mut map = self.0.lock().unwrap();
        if map.contains_key(id) {
            return Err("Already downloading".into());
        }
        let stop = Arc::new(AtomicBool::new(false));
        map.insert(id.to_string(), stop.clone());
        Ok(stop)
    }

    /// Unregisters the run that owns `stop`, leaving any newer run's entry alone.
    fn end(&self, id: &str, stop: &Arc<AtomicBool>) {
        let mut map = self.0.lock().unwrap();
        if map.get(id).is_some_and(|s| Arc::ptr_eq(s, stop)) {
            map.remove(id);
        }
    }
}

#[derive(Serialize, Clone)]
struct DownloadProgress {
    id: String,
    done: u64,
    total: u64,
    part: String,
}

fn downloads_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("downloads"))
}

/// The total size from a Content-Range like "bytes 100-199/1000".
fn range_total(cr: Option<&str>) -> Option<u64> {
    cr?.rsplit_once('/')?.1.trim().parse().ok()
}

/// The first byte from a Content-Range like "bytes 100-199/1000".
fn range_start(cr: Option<&str>) -> Option<u64> {
    let span = cr?.trim().strip_prefix("bytes")?.trim_start();
    span.split_once('-')?.0.trim().parse().ok()
}

/// The resume sidecar next to a part: `<part>.meta` holds the first answer's validator.
fn meta_path(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_owned();
    s.push(".meta");
    PathBuf::from(s)
}

/// Empties the part and forgets its validator, so the next request starts from 0.
fn restart_part(part: &Path, meta: &Path) -> Result<(), String> {
    std::fs::File::create(part).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(meta);
    Ok(())
}

/// Streams `url` into `part`, resuming from its size. A 200 answer to a Range starts over, and
/// so does a 206 that starts at the wrong byte. The first answer's strong ETag (or else its
/// Last-Modified) goes to `<part>.meta` and rides along as If-Range, so a file that changed
/// on the server comes back as a 200. A 206 that ends short of the total (servers that cap
/// open ranges) is followed by the next Range from where it ended, in this same call.
fn fetch_to(
    url: &str,
    auth: Option<&str>,
    part: &Path,
    stop: &AtomicBool,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<(), String> {
    use std::io::{Read, Write};
    let meta = meta_path(part);
    // No global timeout: a 20 GB file takes a long time. Each read gets its own limit instead.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_connect(Some(std::time::Duration::from_secs(15)))
        .timeout_per_read(Some(std::time::Duration::from_secs(60)))
        .http_status_as_error(false)
        .build()
        .into();
    let mut may_retry_shrunk = true;
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let have = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
        let mut req = agent.get(url);
        if have > 0 {
            req = req.header("Range", format!("bytes={have}-"));
            let tag = std::fs::read_to_string(&meta).unwrap_or_default();
            if !tag.trim().is_empty() {
                req = req.header("If-Range", tag.trim());
            }
        }
        if let Some(auth) = auth {
            req = req.header("Authorization", auth);
        }
        let resp = req
            .call()
            .map_err(|e| format!("The server did not answer ({e})"))?;
        let head = |name: &str| {
            resp.headers()
                .get(name)
                .and_then(|v| v.to_str().ok())
                .map(str::to_string)
        };
        let len = head("content-length").and_then(|v| v.parse::<u64>().ok());
        let cr = head("content-range");
        let range = range_total(cr.as_deref());
        let (start, total) = match resp.status().as_u16() {
            206 => {
                if range_start(cr.as_deref()).is_some_and(|s| s != have) {
                    if have == 0 {
                        return Err("The server sent the wrong part of the file.".into());
                    }
                    restart_part(part, &meta)?;
                    continue;
                }
                (have, range.or(len.map(|l| l + have)))
            }
            200 => (0, len),
            // The part already holds the whole file.
            416 if have > 0 && range == Some(have) => {
                let _ = std::fs::remove_file(&meta);
                return Ok(());
            }
            // The server file shrank below the part: start over, once.
            416 if have > 0 && may_retry_shrunk && range.is_some_and(|t| t < have) => {
                may_retry_shrunk = false;
                restart_part(part, &meta)?;
                continue;
            }
            401 | 403 => return Err("The server refused the login.".into()),
            code => return Err(format!("The server said {code}")),
        };
        let total = total.unwrap_or(0);
        if start == 0 {
            let tag = head("etag")
                .filter(|t| !t.starts_with("W/"))
                .or_else(|| head("last-modified"));
            match tag {
                Some(t) => std::fs::write(&meta, t).map_err(|e| e.to_string())?,
                None => {
                    let _ = std::fs::remove_file(&meta);
                }
            }
        }
        let mut f = if start == 0 {
            std::fs::File::create(part)
        } else {
            std::fs::OpenOptions::new().append(true).open(part)
        }
        .map_err(|e| e.to_string())?;
        let mut body = resp.into_body().into_reader();
        let mut done = start;
        let mut last = std::time::Instant::now();
        on_progress(done, total);
        loop {
            if stop.load(Ordering::Relaxed) {
                return Err("Canceled".into());
            }
            let n = body.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            f.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            done += n as u64;
            if last.elapsed() >= std::time::Duration::from_millis(250) {
                on_progress(done, total);
                last = std::time::Instant::now();
            }
        }
        f.sync_all().map_err(|e| e.to_string())?;
        if total > 0 && done < total {
            if done == start {
                return Err("The download stopped early. Try again to resume.".into());
            }
            // A capped or cut-short answer: ask for the rest.
            continue;
        }
        let _ = std::fs::remove_file(&meta);
        on_progress(done, total.max(done));
        return Ok(());
    }
}

/// A file extension from the first bytes, for servers whose URL names none (Jellyfin).
fn sniff_ext(head: &[u8]) -> Option<&'static str> {
    match head {
        [0x1a, 0x45, 0xdf, 0xa3, ..] => Some("mkv"),
        [_, _, _, _, b'f', b't', b'y', b'p', ..] => Some("mp4"),
        [b'I', b'D', b'3', ..] => Some("mp3"),
        [b'f', b'L', b'a', b'C', ..] => Some("flac"),
        [b'O', b'g', b'g', b'S', ..] => Some("ogg"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'A', b'V', b'E', ..] => Some("wav"),
        _ => None,
    }
}

/// The final extension: `ext`, or for "bin" (unknown) one sniffed from the file.
fn final_ext(part: &Path, ext: &str) -> String {
    use std::io::Read;
    if ext != "bin" {
        return ext.to_string();
    }
    let mut head = [0u8; 16];
    let n = std::fs::File::open(part)
        .and_then(|mut f| f.read(&mut head))
        .unwrap_or(0);
    sniff_ext(&head[..n]).unwrap_or("bin").to_string()
}

/// Downloads `url` (the login goes as Basic auth, never in the URL) and returns the final path.
#[tauri::command]
async fn download(
    app: tauri::AppHandle,
    id: String,
    url: String,
    user: Option<String>,
    pass: Option<String>,
    ext: String,
) -> Result<String, String> {
    if !valid_id(&id) || !valid_ext(&ext) {
        return Err("Bad download name".into());
    }
    if !is_url(&url) {
        return Err("Downloads need an http:// or https:// address".into());
    }
    let dir = downloads_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let state = app.state::<Downloads>();
    let stop = state.begin(&id)?;
    let mine = stop.clone();
    let auth = basic(&user.unwrap_or_default(), &pass.unwrap_or_default());
    let (app2, id2) = (app.clone(), id.clone());
    let res = tauri::async_runtime::spawn_blocking(move || {
        let part = dir.join(format!("{id2}.{ext}.part"));
        let part_s = part.to_string_lossy().into_owned();
        fetch_to(&url, auth.as_deref(), &part, &stop, |done, total| {
            let p = DownloadProgress {
                id: id2.clone(),
                done,
                total,
                part: part_s.clone(),
            };
            let _ = app2.emit("download-progress", p);
        })?;
        let out = dir.join(format!("{id2}.{}", final_ext(&part, &ext)));
        std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string());
    state.end(&id, &mine);
    res?
}

/// Stops a running download. The .part stays, so the next download of that id resumes.
#[tauri::command]
fn download_cancel(state: tauri::State<Downloads>, id: String) {
    if let Some(stop) = state.0.lock().unwrap().get(&id) {
        stop.store(true, Ordering::Relaxed);
    }
}

/// Deletes `path` only when it is a file directly inside `dir`, after resolving `..` and symlinks.
fn remove_inside(dir: &Path, path: &Path) -> Result<(), String> {
    let dir = dir.canonicalize().map_err(|e| e.to_string())?;
    let p = match path.canonicalize() {
        Ok(p) => p,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    if p.parent() != Some(dir.as_path()) || !p.is_file() {
        return Err("That file is not a Flick download".into());
    }
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// Deletes a download or a .part, plus the part's resume sidecar.
fn remove_download(dir: &Path, path: &Path) -> Result<(), String> {
    remove_inside(dir, path)?;
    remove_inside(dir, &meta_path(path))
}

#[tauri::command]
fn download_remove(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let dir = downloads_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    remove_download(&dir, Path::new(&path))
}

/// Whether a finished download is still on disk, so playback can fall back to the server.
#[tauri::command]
fn download_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

#[derive(Serialize)]
struct Space {
    free: Option<u64>,
    used: u64,
}

#[tauri::command]
fn downloads_space(app: tauri::AppHandle) -> Result<Space, String> {
    let dir = downloads_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let used = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|e| e.metadata().ok())
        .filter(|m| m.is_file())
        .map(|m| m.len())
        .sum();
    Ok(Space {
        free: fs4::available_space(&dir).ok(),
        used,
    })
}

#[tauri::command]
fn take_opened(state: tauri::State<Opened>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

#[cfg(target_os = "macos")]
mod default_app {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: CFStringRef,
            role: u32,
            handler: CFStringRef,
        ) -> i32;
    }

    // Video and audio types QuickTime Player and Music usually own.
    const TYPES: &[&str] = &[
        "public.movie",
        "public.video",
        "public.mpeg-4",
        "com.apple.quicktime-movie",
        "com.apple.m4v-video",
        "public.avi",
        "org.matroska.mkv",
        "org.webmproject.webm",
        "public.mpeg",
        "public.mpeg-2-transport-stream",
        "com.microsoft.windows-media-wmv",
        "public.3gpp",
        "public.mp3",
        "public.mpeg-4-audio",
        "com.apple.m4a-audio",
        "public.aac-audio",
        "org.xiph.flac",
        "com.microsoft.waveform-audio",
        "public.aiff-audio",
        "org.xiph.ogg-audio",
    ];

    pub fn set(bundle_id: &str) -> (usize, usize) {
        let handler = CFString::new(bundle_id);
        let mut ok = 0;
        for t in TYPES {
            let ct = CFString::new(t);
            // Role "all" = 0xFFFFFFFF.
            let r = unsafe {
                LSSetDefaultRoleHandlerForContentType(
                    ct.as_concrete_TypeRef(),
                    0xFFFF_FFFF,
                    handler.as_concrete_TypeRef(),
                )
            };
            if r == 0 {
                ok += 1;
            }
        }
        (ok, TYPES.len())
    }
}

#[tauri::command]
fn make_default_player(app: tauri::AppHandle) -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let id = app.config().identifier.clone();
        let (ok, total) = default_app::set(&id);
        if ok == 0 {
            return Err("macOS refused the change. Move Flick to Applications, open it once, then try again.".into());
        }
        Ok(format!("Flick now opens {ok} of {total} video and audio types. Double-click a video in Finder to try it."))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("Set Flick as the default player in your system settings.".into())
    }
}

fn queue_open(app: &tauri::AppHandle, paths: Vec<String>) {
    let paths: Vec<String> = paths
        .into_iter()
        .filter(|p| is_media(Path::new(p)))
        .collect();
    if paths.is_empty() {
        return;
    }
    // A self-test run never comes forward.
    if !selftest::active(app) {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.set_focus();
        }
    }
    // Keep them for a window that has not loaded yet, and tell one that has.
    app.state::<Opened>()
        .0
        .lock()
        .unwrap()
        .extend(paths.clone());
    let _ = app.emit("open-files", paths);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    selftest::mark_launch();
    let context = tauri::generate_context!();
    let builder = tauri::Builder::default().plugin(tauri_plugin_dialog::init());
    let builder = match selftest::init_script(&context.config().identifier) {
        Some(js) => builder.plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("flick-selftest")
                .js_init_script(js)
                .build(),
        ),
        None => builder,
    };
    // Desktop builds update themselves from GitHub Releases; phones update through their stores.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());
    // A self-test run starts in the background and stays there (`open -g`).
    #[cfg(target_os = "macos")]
    let builder = builder.activate_ignoring_other_apps(!selftest::requested());
    let app = builder
        .manage(Opened::default())
        .manage(KodiProxy::default())
        .manage(Downloads::default())
        .manage(plugins::PluginHosts::default())
        .manage(share::Share::default())
        .manage(ytdlp::PluginTools::default())
        .register_asynchronous_uri_scheme_protocol("kodi", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || responder.respond(kodi_proxy(&app, &req)));
        })
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            probe,
            chapters,
            prepare,
            sidecar_subs,
            embedded_subs,
            thumbnail,
            ffmpeg_status,
            take_opened,
            kodi_rpc,
            kodi_image,
            kodi_proxy_register,
            download,
            download_cancel,
            download_remove,
            download_exists,
            downloads_space,
            make_default_player,
            plugins::plugin_hosts,
            plugins::plugin_fetch,
            selftest::selftest_mode,
            selftest::selftest_note,
            selftest::selftest_done,
            share::share_start,
            share::share_stop,
            share::share_status,
            share::share_new_code,
            ytdlp::plugin_tools,
            ytdlp::plugin_tool,
            ytdlp::tool_open,
            ytdlp::tool_download,
            ytdlp::tool_download_clean,
            #[cfg(desktop)]
            vpn::watch::vpn_gate,
            #[cfg(desktop)]
            vpn::watch::vpn_gate_hold,
            #[cfg(desktop)]
            vpn::watch::vpn_gate_release,
            #[cfg(desktop)]
            torrent::torrent_play,
            #[cfg(desktop)]
            torrent::torrent_stop
        ])
        .setup(|app| {
            selftest::mark_setup();
            if selftest::active(app) {
                selftest::stay_hidden(app);
                selftest::unthrottle(app);
            }
            // Files passed on the command line: `Flick movie.mkv`.
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            if !args.is_empty() {
                queue_open(app.handle(), args);
            }
            if let Ok(cache) = app.path().app_cache_dir() {
                std::thread::spawn(move || ytdlp::clean_cache(&cache));
            }
            #[cfg(desktop)]
            vpn::watch::install(app.handle().clone());
            Ok(())
        })
        .build(context)
        .expect("error while building Flick");

    app.run(|handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let tauri::RunEvent::Opened { urls } = &event {
            let paths = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            queue_open(handle, paths);
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = &event {
            if selftest::active(handle) {
                selftest::stay_hidden(handle);
                return;
            }
        }
        if let tauri::RunEvent::Exit = &event {
            share::stop_all(handle);
            ytdlp::stop_job(&handle.state::<ytdlp::PluginTools>());
            #[cfg(desktop)]
            torrent::shutdown();
        }
        let _ = (handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn media(name: &str) -> String {
        format!("{}/../test-media/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn chapters_from_an_m4b() {
        let (Some(ffmpeg), Some(_)) = (find_tool("ffmpeg"), find_tool("ffprobe")) else {
            eprintln!("skipped: needs ffmpeg and ffprobe");
            return;
        };
        let dir = std::env::temp_dir().join(format!("flick-chapters-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let meta = dir.join("meta.txt");
        std::fs::write(&meta, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=2000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=5000\ntitle=Ending\n").unwrap();
        let book = dir.join("book.m4b");
        let ok = Command::new(ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "sine=d=5", "-i"])
            .arg(&meta)
            .args(["-map_chapters", "1", "-c:a", "aac"])
            .arg(&book)
            .status()
            .unwrap();
        assert!(ok.success());
        let ch = run_chapters(book.to_str().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            ch,
            [
                Chapter {
                    title: "Opening".into(),
                    start: 0.0
                },
                Chapter {
                    title: "Ending".into(),
                    start: 2.0
                }
            ]
        );
    }

    #[test]
    fn probe_tells_native_from_needs_conversion() {
        if find_tool("ffprobe").is_none()
            || !Path::new(&media("Demo.Show.S01E02.Pilot.mkv")).exists()
        {
            eprintln!("skipped: needs ffprobe and test-media");
            return;
        }
        let mp4 = run_probe(&media("Test.Movie.2024.1080p.mp4"), None).unwrap();
        assert!(mp4.playable, "H.264/AAC MP4 plays natively");
        assert_eq!(mp4.video.as_deref(), Some("h264"));
        assert!((mp4.duration - 20.0).abs() < 0.5);
        let mkv = run_probe(&media("Demo.Show.S01E02.Pilot.mkv"), None).unwrap();
        assert!(!mkv.playable, "MKV must go through prepare");
        assert_eq!(mkv.audio.as_deref(), Some("ac3"));
        assert!(
            run_probe(&media("Sample.Clip.2023.webm"), None)
                .unwrap()
                .playable,
            "WebM plays natively"
        );
    }

    #[test]
    fn finds_sidecar_subtitles() {
        let subs = sidecar_subs(media("Test.Movie.2024.1080p.mp4"));
        if subs.is_empty() && !Path::new(&media("Test.Movie.2024.1080p.srt")).exists() {
            return;
        }
        assert_eq!(subs.len(), 1);
        assert!(subs[0].text.contains("Hello from Flick"));
    }

    #[test]
    fn transcode_encoder_exists_on_this_platform() {
        let args = video_args(Some("mpeg4"));
        let enc = &args[1];
        if cfg!(target_os = "macos") {
            assert_eq!(enc, "h264_videotoolbox");
        } else {
            assert_eq!(enc, "libx264");
        }
        assert_eq!(video_args(Some("h264")), ["-c:v", "copy"]);
        assert!(video_args(None).is_empty());
    }

    #[test]
    fn http_input_gets_auth_header() {
        use base64::Engine;
        let auth = basic("kodi", "p@ss").unwrap();
        let b64 = auth.strip_prefix("Basic ").unwrap();
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .unwrap();
        assert_eq!(decoded, b"kodi:p@ss");
        let url = "http://192.168.1.30:8080/vfs/%2Fa.mkv";
        assert_eq!(
            input_args(url, Some(&auth)),
            [
                "-headers".to_string(),
                format!("Authorization: {auth}\r\n"),
                "-i".to_string(),
                url.to_string()
            ]
        );
        assert_eq!(input_args("HTTPS://h/x.mkv", Some(&auth))[0], "-headers");
        assert_eq!(input_args(url, None), ["-i", url]);
        // A local file never gets the header, even with a login.
        assert_eq!(
            input_args("/media/http:/a.mkv", Some(&auth)),
            ["-i", "/media/http:/a.mkv"]
        );
        assert!(basic("", "x").is_none());
    }

    /// Needs a local server with Basic auth. Set FLICK_HTTP_MKV (URL), FLICK_HTTP_USER, FLICK_HTTP_PASS.
    #[test]
    #[ignore]
    fn remux_reads_http_with_basic_auth() {
        let url = std::env::var("FLICK_HTTP_MKV").unwrap();
        let auth = basic(
            &std::env::var("FLICK_HTTP_USER").unwrap(),
            &std::env::var("FLICK_HTTP_PASS").unwrap(),
        );
        let p = run_probe(&url, auth.as_deref()).expect("ffprobe reads the URL");
        assert!(!p.playable, "MKV over http still needs prepare");
        let out = std::env::temp_dir().join(format!("flick-http-{}.mp4", cache_key(&url)));
        remux(&url, auth.as_deref(), &out, |_| {}).unwrap();
        let mp4 = run_probe(out.to_str().unwrap(), None).unwrap();
        eprintln!(
            "output {} container={} video={:?} audio={:?} duration={}",
            out.display(),
            mp4.container,
            mp4.video,
            mp4.audio,
            mp4.duration
        );
        assert!(mp4.playable && mp4.duration > 0.5);
    }

    #[test]
    fn proxy_path_parses_both_url_forms_and_stays_under_base() {
        // convertFileSrc("kodi-a/vfs/%2Fm%2FA.mp4", "kodi") on macOS/Linux and on Windows/Android.
        let enc = "kodi-a%2Fvfs%2F%252Fm%252FA.mp4";
        for u in [
            format!("kodi://localhost/{enc}"),
            format!("http://kodi.localhost/{enc}"),
        ] {
            let uri: tauri::http::Uri = u.parse().unwrap();
            assert_eq!(
                proxy_target(uri.path()),
                Some(("kodi-a".into(), "vfs/%2Fm%2FA.mp4".into()))
            );
        }
        for bad in [
            "/kodi-a%2F..%2Fjsonrpc",
            "/kodi-a%2Fjsonrpc",
            "/kodi-a%2Fjsonrpc%3Frequest%3D%257B%257D",
            "/kodi-a%2Fimage%2Fx",
            "/kodi-a%2Fvfs%2Fx%3Fa%3Db",
            "/kodi-a%2Fvfs%2Fa%2Fb",
            "/kodi-a%2Fvfs%2F",
            "/kodi-a%2Fvfs%2F..%2F..%2Fx",
            "/kodi-a%2Fvfs%2F%252E%252E%2Fx",
            "/kodi-a%2Fhttp%3A%2F%2Fevil.example%2Fx",
            "/kodi-a%2F%2Fevil.example%2Fx",
            "/kodi-a%2F.%2Fx",
            "/kodi-a",
            "/%2Fvfs%2Fx",
        ] {
            assert_eq!(proxy_target(bad), None, "{bad}");
        }
        // A dotted file name inside the encoded Kodi path is fine.
        assert!(proxy_target("/k%2Fvfs%2F%252Fm%252FA..B.mp4").is_some());
    }

    #[test]
    fn range_is_capped_to_one_chunk() {
        let c = CHUNK;
        let total = 10 * c;
        let w = parse_range(Some("bytes=0-"));
        assert_eq!(upstream_range(&w), format!("bytes=0-{}", c - 1));
        assert_eq!(answer_span(&w, total), Some((0, c - 1)));
        assert_eq!(answer_span(&w, 1000), Some((0, 999)));

        let w = parse_range(Some("bytes=100-199"));
        assert_eq!(upstream_range(&w), "bytes=100-199");
        assert_eq!(answer_span(&w, total), Some((100, 199)));

        let w = parse_range(None);
        assert_eq!(w, Want::From(0, None));
        assert_eq!(upstream_range(&w), format!("bytes=0-{}", c - 1));

        let w = parse_range(Some("bytes=-500"));
        assert_eq!(upstream_range(&w), "bytes=-500");
        assert_eq!(answer_span(&w, total), Some((total - 500, total - 1)));
        let w = parse_range(Some(&format!("bytes=-{}", 3 * c)));
        assert_eq!(upstream_range(&w), format!("bytes=-{c}"));
        assert_eq!(answer_span(&w, total), Some((total - c, total - 1)));

        let w = parse_range(Some("bytes=5-"));
        assert_eq!(upstream_range(&w), format!("bytes=5-{}", 5 + c - 1));
        let w = parse_range(Some(&format!("bytes=0-{}", 5 * c)));
        assert_eq!(upstream_range(&w), format!("bytes=0-{}", c - 1));
        assert_eq!(answer_span(&parse_range(Some("bytes=2000-")), 1000), None);
        assert_eq!(parse_range(Some("bytes=0-1,5-9")), Want::From(0, None));
        assert_eq!(parse_range(Some("items=1-2")), Want::From(0, None));
    }

    /// A tiny Kodi stand-in: needs Basic auth, serves `data`, honors Range only when `ranges`.
    fn fake_kodi(data: Vec<u8>, ranges: bool) -> String {
        Fake::new(data, ranges).serve()
    }

    /// Knobs for the fake server. `data` and `etag` can change between requests, and every
    /// request head is logged (lowercased) so tests can check what was sent.
    #[derive(Clone)]
    struct Fake {
        data: Arc<Mutex<Vec<u8>>>,
        ranges: bool,
        /// Most bytes one ranged answer carries, like the kodi proxy's chunk cap.
        cap: Option<usize>,
        /// Answers every Range with a 206 that starts at 0.
        bad_start: bool,
        /// The next 200 sends only this many bytes of its body, then closes.
        short_once: Arc<Mutex<Option<usize>>>,
        etag: Arc<Mutex<Option<String>>>,
        log: Arc<Mutex<Vec<String>>>,
    }

    impl Fake {
        fn new(data: Vec<u8>, ranges: bool) -> Fake {
            Fake {
                data: Arc::new(Mutex::new(data)),
                ranges,
                cap: None,
                bad_start: false,
                short_once: Arc::new(Mutex::new(None)),
                etag: Arc::new(Mutex::new(None)),
                log: Arc::new(Mutex::new(vec![])),
            }
        }

        fn serve(self) -> String {
            use std::io::{Read, Write};
            let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let addr = l.local_addr().unwrap();
            std::thread::spawn(move || {
                for mut s in l.incoming().flatten() {
                    let mut req = vec![];
                    let mut b = [0u8; 1];
                    while !req.ends_with(b"\r\n\r\n") && s.read(&mut b).unwrap_or(0) == 1 {
                        req.push(b[0]);
                    }
                    let req = String::from_utf8_lossy(&req).to_ascii_lowercase();
                    self.log.lock().unwrap().push(req.clone());
                    let data = self.data.lock().unwrap().clone();
                    let etag = self.etag.lock().unwrap().clone();
                    let header = |name: &str| {
                        req.lines()
                            .find_map(|l| l.strip_prefix(name))
                            .map(|v| v.trim().to_string())
                    };
                    // An If-Range that no longer matches means "send the whole file".
                    let same = header("if-range: ").is_none_or(|v| etag.as_deref() == Some(&v));
                    let extra = etag.map(|e| format!("ETag: {e}\r\n")).unwrap_or_default();
                    let path_ok = req.starts_with("get /vfs/%2fm%2fa.mp4 ");
                    let auth = format!(
                        "authorization: {}",
                        basic("kodi", "pw").unwrap().to_ascii_lowercase()
                    );
                    let (head, body) = if !req.contains(&auth) {
                        ("HTTP/1.1 401 Unauthorized\r\n".to_string(), vec![])
                    } else if !path_ok {
                        ("HTTP/1.1 404 Not Found\r\n".to_string(), vec![])
                    } else {
                        let range = header("range: bytes=")
                            .and_then(|r| {
                                let (a, b) = r.split_once('-')?;
                                Some((a.to_string(), b.to_string()))
                            })
                            .map(|(a, b)| match a.parse::<usize>() {
                                // An open range runs to the end.
                                Ok(a) => (a, b.parse::<usize>().unwrap_or(usize::MAX)),
                                // Suffix range: the last n bytes.
                                Err(_) => {
                                    (data.len() - b.parse::<usize>().unwrap(), data.len() - 1)
                                }
                            });
                        match range.filter(|_| self.ranges && same) {
                            Some((a, _)) if a >= data.len() => (
                                format!(
                                    "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{}\r\n",
                                    data.len()
                                ),
                                vec![],
                            ),
                            Some((a, b)) => {
                                let a = if self.bad_start { 0 } else { a };
                                let mut b = b.min(data.len() - 1);
                                if let Some(cap) = self.cap {
                                    b = b.min(a + cap - 1);
                                }
                                (
                                    format!(
                                        "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {a}-{b}/{}\r\n",
                                        data.len()
                                    ),
                                    data[a..=b].to_vec(),
                                )
                            }
                            None => ("HTTP/1.1 200 OK\r\n".to_string(), data.clone()),
                        }
                    };
                    let _ = write!(
                        s,
                        "{head}{extra}Content-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let short = if head.starts_with("HTTP/1.1 200") {
                        self.short_once.lock().unwrap().take()
                    } else {
                        None
                    };
                    let n = short.unwrap_or(body.len()).min(body.len());
                    let _ = s.write_all(&body[..n]);
                }
            });
            format!("http://{addr}")
        }
    }

    #[test]
    fn proxy_fetch_sends_login_and_range() {
        let data: Vec<u8> = (0..(CHUNK as usize + 5000))
            .map(|i| (i % 251) as u8)
            .collect();
        let auth = basic("kodi", "pw");
        for ranges in [true, false] {
            let base = fake_kodi(data.clone(), ranges);
            let r = proxy_fetch(
                &base,
                auth.as_deref(),
                "vfs/%2Fm%2FA.mp4",
                Some("bytes=100-199"),
            );
            assert_eq!(r.status(), 206, "ranges={ranges}");
            assert_eq!(r.body(), &data[100..200]);
            let cr = format!("bytes 100-199/{}", data.len());
            assert_eq!(r.headers()["content-range"], cr.as_str());
            assert_eq!(r.headers()["content-type"], "video/mp4");

            // An open range gets one chunk, not the whole file.
            let r = proxy_fetch(&base, auth.as_deref(), "vfs/%2Fm%2FA.mp4", Some("bytes=0-"));
            assert_eq!(r.status(), 206);
            assert_eq!(r.body().len() as u64, CHUNK);
            assert_eq!(r.body()[..], data[..CHUNK as usize]);
            let cr = format!("bytes 0-{}/{}", CHUNK - 1, data.len());
            assert_eq!(r.headers()["content-range"], cr.as_str());

            let r = proxy_fetch(
                &base,
                auth.as_deref(),
                "vfs/%2Fm%2FA.mp4",
                Some("bytes=-10"),
            );
            assert_eq!(r.status(), 206);
            assert_eq!(r.body(), &data[data.len() - 10..]);
            assert_eq!(
                proxy_fetch(&base, None, "vfs/%2Fm%2FA.mp4", None).status(),
                401
            );
        }
    }

    #[test]
    fn download_names_are_checked() {
        for ok in ["a", "abc123", "A_b-9", &"x".repeat(64)] {
            assert!(valid_id(ok), "{ok}");
        }
        for bad in ["", "../x", "a/b", "a.b", "a b", &"x".repeat(65), "é"] {
            assert!(!valid_id(bad), "{bad}");
        }
        for ok in ["mp4", "mkv", "m4a", "bin", "a1234"] {
            assert!(valid_ext(ok), "{ok}");
        }
        for bad in ["", "MP4", "abcdef", "m.4", "m/4", "-"] {
            assert!(!valid_ext(bad), "{bad}");
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flick-dl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn download_remove_stays_inside_the_folder() {
        let root = scratch("remove");
        let dir = root.join("downloads");
        std::fs::create_dir_all(&dir).unwrap();
        let outside = root.join("keep.mp4");
        std::fs::write(&outside, b"x").unwrap();
        let inside = dir.join("a.mp4");
        std::fs::write(&inside, b"x").unwrap();

        assert!(remove_inside(&dir, &outside).is_err());
        assert!(remove_inside(&dir, &dir.join("../keep.mp4")).is_err());
        assert!(
            remove_inside(&dir, &dir).is_err(),
            "never the folder itself"
        );
        #[cfg(unix)]
        {
            let link = dir.join("link.mp4");
            std::os::unix::fs::symlink(&outside, &link).unwrap();
            assert!(
                remove_inside(&dir, &link).is_err(),
                "a symlink out is refused"
            );
        }
        assert!(outside.exists());

        remove_inside(&dir, &inside).unwrap();
        assert!(!inside.exists());
        remove_inside(&dir, &inside).unwrap();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn sniffs_extensions() {
        assert_eq!(sniff_ext(&[0x1a, 0x45, 0xdf, 0xa3, 1]), Some("mkv"));
        assert_eq!(sniff_ext(b"\0\0\0\x20ftypisom"), Some("mp4"));
        assert_eq!(sniff_ext(b"ID3\x04"), Some("mp3"));
        assert_eq!(sniff_ext(b"RIFF\0\0\0\0WAVEfmt "), Some("wav"));
        assert_eq!(sniff_ext(b"hello"), None);
    }

    #[test]
    fn downloads_resume_restart_and_send_the_login() {
        let data: Vec<u8> = (0..700_000).map(|i| (i % 251) as u8).collect();
        let dir = scratch("fetch");
        let auth = basic("kodi", "pw");
        let go = AtomicBool::new(false);
        let path = "/vfs/%2Fm%2FA.mp4";

        // Full download, with progress.
        let base = fake_kodi(data.clone(), true);
        let part = dir.join("full.mp4.part");
        let mut last = (0, 0);
        fetch_to(
            &format!("{base}{path}"),
            auth.as_deref(),
            &part,
            &go,
            |d, t| last = (d, t),
        )
        .unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), data);
        assert_eq!(last, (data.len() as u64, data.len() as u64));

        // Resume: a part with marked bytes keeps them, so only the rest came over the wire.
        let part = dir.join("resume.mp4.part");
        std::fs::write(&part, vec![0u8; 1000]).unwrap();
        fetch_to(
            &format!("{base}{path}"),
            auth.as_deref(),
            &part,
            &go,
            |_, _| {},
        )
        .unwrap();
        let got = std::fs::read(&part).unwrap();
        assert_eq!(got.len(), data.len());
        assert!(got[..1000].iter().all(|&b| b == 0));
        assert_eq!(got[1000..], data[1000..]);

        // A server that ignores Range answers 200: start over, no marked bytes left.
        let base = fake_kodi(data.clone(), false);
        let part = dir.join("restart.mp4.part");
        std::fs::write(&part, vec![0u8; 1000]).unwrap();
        fetch_to(
            &format!("{base}{path}"),
            auth.as_deref(),
            &part,
            &go,
            |_, _| {},
        )
        .unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), data);

        // fake_kodi answers 401 without the Basic header.
        let part = dir.join("nologin.mp4.part");
        let e = fetch_to(&format!("{base}{path}"), None, &part, &go, |_, _| {}).unwrap_err();
        assert!(e.contains("login"), "{e}");

        // Cancel keeps the part.
        let stop = AtomicBool::new(true);
        let part = dir.join("cancel.mp4.part");
        let e = fetch_to(
            &format!("{base}{path}"),
            auth.as_deref(),
            &part,
            &stop,
            |_, _| {},
        )
        .unwrap_err();
        assert_eq!(e, "Canceled");
        assert!(part.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn fetch(base: &str, part: &Path) -> Result<(), String> {
        let url = format!("{base}/vfs/%2Fm%2FA.mp4");
        fetch_to(
            &url,
            basic("kodi", "pw").as_deref(),
            part,
            &AtomicBool::new(false),
            |_, _| {},
        )
    }

    fn meta_of(part: &Path) -> PathBuf {
        PathBuf::from(format!("{}.meta", part.display()))
    }

    #[test]
    fn one_run_per_id() {
        let d = Downloads::default();
        let a = d.begin("x").unwrap();
        assert_eq!(d.begin("x").unwrap_err(), "Already downloading");
        assert!(d.begin("y").is_ok());
        d.end("x", &a);
        let b = d.begin("x").unwrap();
        // A stale run ending must not drop the newer run's stop flag.
        d.end("x", &a);
        assert!(Arc::ptr_eq(d.0.lock().unwrap().get("x").unwrap(), &b));
        d.end("x", &b);
        assert!(!d.0.lock().unwrap().contains_key("x"));
    }

    #[test]
    fn resume_restarts_when_the_206_starts_elsewhere() {
        let data: Vec<u8> = (0..300_000).map(|i| (i % 251) as u8).collect();
        let dir = scratch("badstart");
        let mut f = Fake::new(data.clone(), true);
        f.bad_start = true;
        let base = f.serve();
        let part = dir.join("a.mp4.part");
        std::fs::write(&part, vec![0u8; 1000]).unwrap();
        fetch(&base, &part).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), data);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn resume_sends_if_range_and_restarts_on_a_changed_file() {
        let data: Vec<u8> = (0..300_000).map(|i| (i % 251) as u8).collect();
        let dir = scratch("ifrange");
        let f = Fake::new(data.clone(), true);
        *f.etag.lock().unwrap() = Some("\"v1\"".into());
        *f.short_once.lock().unwrap() = Some(1000);
        let (log, etag) = (f.log.clone(), f.etag.clone());
        let base = f.serve();

        // The first answer is cut short; the validator is kept for the resume.
        let part = dir.join("a.mp4.part");
        if fetch(&base, &part).is_err() {
            assert!(meta_of(&part).exists(), "validator saved");
            assert!(std::fs::metadata(&part).unwrap().len() > 0);
            fetch(&base, &part).unwrap();
        }
        assert_eq!(std::fs::read(&part).unwrap(), data);
        assert!(
            log.lock()
                .unwrap()
                .iter()
                .any(|r| r.contains("range: bytes=") && r.contains("if-range: \"v1\"")),
            "resume sent If-Range"
        );
        assert!(!meta_of(&part).exists(), "sidecar removed when done");

        // The file changed on the server: the If-Range misses, the 200 starts over.
        *etag.lock().unwrap() = Some("\"v2\"".into());
        let part = dir.join("b.mp4.part");
        std::fs::write(&part, vec![0u8; 1000]).unwrap();
        std::fs::write(meta_of(&part), "\"v1\"").unwrap();
        fetch(&base, &part).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), data);
        assert!(!meta_of(&part).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_shrunk_server_file_restarts_from_zero() {
        let data: Vec<u8> = (0..500).map(|i| (i % 251) as u8).collect();
        let dir = scratch("shrunk");
        let base = fake_kodi(data.clone(), true);
        let part = dir.join("a.mp4.part");
        std::fs::write(&part, vec![0u8; 1000]).unwrap();
        fetch(&base, &part).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), data);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn capped_ranges_continue_in_one_call() {
        let data: Vec<u8> = (0..700_000).map(|i| (i % 251) as u8).collect();
        let dir = scratch("capped");
        let mut f = Fake::new(data.clone(), true);
        f.cap = Some(100_000);
        let log = f.log.clone();
        let base = f.serve();
        let url = format!("{base}/vfs/%2Fm%2FA.mp4");
        let auth = basic("kodi", "pw");
        let part = dir.join("a.mp4.part");
        std::fs::write(&part, &data[..1000]).unwrap();
        let mut last = (0, 0);
        let go = AtomicBool::new(false);
        fetch_to(&url, auth.as_deref(), &part, &go, |d, t| last = (d, t)).unwrap();
        assert_eq!(std::fs::read(&part).unwrap(), data);
        assert_eq!(last, (data.len() as u64, data.len() as u64));
        assert_eq!(log.lock().unwrap().len(), 7);

        // Stop still works between capped requests.
        let part = dir.join("b.mp4.part");
        std::fs::write(&part, &data[..1000]).unwrap();
        let stop = AtomicBool::new(false);
        let e = fetch_to(&url, auth.as_deref(), &part, &stop, |d, _| {
            if d >= 200_000 {
                stop.store(true, Ordering::Relaxed);
            }
        })
        .unwrap_err();
        assert_eq!(e, "Canceled");
        assert!(std::fs::metadata(&part).unwrap().len() < data.len() as u64);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remove_takes_the_resume_sidecar_too() {
        let dir = scratch("removemeta");
        let part = dir.join("a.mp4.part");
        std::fs::write(&part, b"x").unwrap();
        std::fs::write(meta_of(&part), b"\"v1\"").unwrap();
        remove_download(&dir, &part).unwrap();
        assert!(!part.exists());
        assert!(!meta_of(&part).exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn books_count_as_media() {
        assert!(is_media(Path::new("/b/Jane Doe - Dune.epub")));
        assert!(is_media(Path::new("/b/Dune.PDF")));
        assert!(!is_media(Path::new("/b/notes.txt")));
    }

    #[test]
    fn photos_count_as_media() {
        for p in ["/p/IMG_1234.JPG", "/p/IMG_1235.heic", "/p/a.webp", "/p/b.avif"] {
            assert!(is_media(Path::new(p)), "{p}");
        }
    }

    #[test]
    fn scan_finds_media_only() {
        let dir = media("");
        if !Path::new(&dir).exists() {
            return;
        }
        let found = tauri::async_runtime::block_on(scan_folder(dir)).unwrap();
        assert!(found.iter().any(|e| e.name.ends_with(".mkv")));
        assert!(found.iter().all(|e| !e.name.ends_with(".srt")));
    }
}
