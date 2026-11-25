// Flick desktop backend: folder scanning, format probing, ffmpeg remux for MKV/AVI,
// thumbnails, subtitles, Finder "Open With", and the default-player switch.

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const VIDEO: &[&str] = &[
    "mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "ts", "m2ts", "mts", "mpg", "mpeg",
    "ogv", "3gp",
];
const AUDIO: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "alac", "aiff", "aif", "wma",
];
const SUBS: &[&str] = &["srt", "vtt", "ass", "ssa"];
// What WKWebView plays without help.
const NATIVE_EXT: &[&str] = &[
    "mp4", "m4v", "mov", "webm", "mp3", "m4a", "aac", "wav", "flac", "aiff", "aif", "3gp",
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
    VIDEO.contains(&e.as_str()) || AUDIO.contains(&e.as_str())
}

fn find_tool(name: &str) -> Option<PathBuf> {
    let name = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    // Apps launched from Finder do not get the shell PATH, so check the usual spots first.
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let p = Path::new(dir).join(&name);
        if p.is_file() {
            return Some(p);
        }
    }
    std::env::var_os("PATH").and_then(|paths| std::env::split_paths(&paths).map(|d| d.join(&name)).find(|p| p.is_file()))
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

fn run_probe(path: &str) -> Option<Probe> {
    let ffprobe = find_tool("ffprobe")?;
    let out = Command::new(ffprobe)
        .args(["-v", "error", "-show_entries", "format=format_name,duration:stream=index,codec_type,codec_name:stream_tags=language,title", "-of", "json", path])
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

#[tauri::command]
async fn probe(path: String) -> Result<Probe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        Ok(run_probe(&path).unwrap_or_else(|| Probe {
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
#[tauri::command]
async fn prepare(app: tauri::AppHandle, path: String) -> Result<String, String> {
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
    let ffmpeg = find_tool("ffmpeg")
        .ok_or("This format needs ffmpeg. Install it with: brew install ffmpeg")?;
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let probe = run_probe(&path).unwrap_or_default();
        let tmp = out.with_extension("part.mp4");
        let mut args: Vec<String> = vec![
            "-y".into(),
            "-v".into(),
            "error".into(),
            "-i".into(),
            path.clone(),
            "-map".into(),
            "0:v:0?".into(),
            "-map".into(),
            "0:a:0?".into(),
        ];
        match probe.video.as_deref() {
            Some("h264") => args.extend(["-c:v".into(), "copy".into()]),
            Some("hevc") => {
                args.extend(["-c:v".into(), "copy".into(), "-tag:v".into(), "hvc1".into()])
            }
            Some(_) => args.extend([
                "-c:v".into(),
                "h264_videotoolbox".into(),
                "-b:v".into(),
                "10M".into(),
                "-pix_fmt".into(),
                "yuv420p".into(),
            ]),
            None => {}
        }
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
                        let pct = (us / 1e6 / probe.duration * 100.0).clamp(0.0, 100.0);
                        let _ = app2.emit(
                            "prepare-progress",
                            PrepareProgress {
                                path: path.clone(),
                                pct,
                            },
                        );
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
        std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
        Ok(out.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
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
        let Some(probe) = run_probe(&path) else {
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
        let duration = run_probe(&path).map(|p| p.duration).unwrap_or(0.0);
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

#[tauri::command]
fn take_opened(state: tauri::State<Opened>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

// ---------- YouTube through yt-dlp ----------

fn yt_dlp() -> Result<PathBuf, String> {
    find_tool("yt-dlp")
        .ok_or_else(|| "YouTube needs yt-dlp. Install it with: brew install yt-dlp".to_string())
}

/// YouTube ids are short and URL safe; anything else is not passed to yt-dlp.
fn yt_url(id: &str) -> Result<String, String> {
    if id.is_empty()
        || id.len() > 20
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!("Not a YouTube video id: {id}"));
    }
    Ok(format!("https://www.youtube.com/watch?v={id}"))
}

fn yt_json(args: &[&str]) -> Result<serde_json::Value, String> {
    let out = Command::new(yt_dlp()?)
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
}

/// Raw yt-dlp search JSON. The UI turns it into results (src/lib/youtube.ts).
fn yt_search_blocking(query: &str) -> Result<serde_json::Value, String> {
    yt_json(&["--flat-playlist", "-J", &format!("ytsearch25:{query}")])
}

#[tauri::command]
async fn yt_search(query: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || yt_search_blocking(&query))
        .await
        .map_err(|e| e.to_string())?
}

#[derive(Serialize, Debug)]
struct YtPart {
    url: String,
    headers: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize, Debug)]
struct YtStream {
    video: YtPart,
    audio: YtPart,
    title: String,
    channel: String,
    duration: f64,
    thumbnail: String,
}

// YouTube answers the one muxed MP4 with 403, while the separate parts serve.
// H.264 up to 1080p plays everywhere; ffmpeg joins it with the m4a audio (yt_stream).
const YT_PLAY_FORMAT: &str = "bv[vcodec^=avc1][height<=1080]+ba[ext=m4a]";

fn yt_part(f: &serde_json::Value) -> Option<YtPart> {
    let headers = f["http_headers"].as_object().map(|h| {
        h.iter()
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
            .collect()
    });
    Some(YtPart {
        url: f["url"].as_str()?.to_string(),
        headers: headers.unwrap_or_default(),
    })
}

fn yt_resolve_blocking(id: &str) -> Result<YtStream, String> {
    let j = yt_json(&[
        "-J",
        "--no-playlist",
        "-f",
        YT_PLAY_FORMAT,
        "--",
        &yt_url(id)?,
    ])?;
    let parts = j["requested_formats"].as_array();
    let (video, audio) = match parts.map(|p| p.as_slice()) {
        Some([v, a]) => (yt_part(v), yt_part(a)),
        _ => (None, None),
    };
    let (Some(video), Some(audio)) = (video, audio) else {
        return Err("yt-dlp found no H.264 video and m4a audio for this video".into());
    };
    let s = |k: &str| j[k].as_str().unwrap_or("").to_string();
    Ok(YtStream {
        video,
        audio,
        title: s("title"),
        channel: if j["channel"].is_string() {
            s("channel")
        } else {
            s("uploader")
        },
        duration: j["duration"].as_f64().unwrap_or(0.0),
        thumbnail: s("thumbnail"),
    })
}

#[tauri::command]
async fn yt_resolve(id: String) -> Result<YtStream, String> {
    tauri::async_runtime::spawn_blocking(move || yt_resolve_blocking(&id))
        .await
        .map_err(|e| e.to_string())?
}

/// The one ffmpeg job that turns a YouTube video into HLS. A new stream or app exit kills it.
#[derive(Default)]
struct YtJob(Mutex<Option<Child>>);

fn stop_job(job: &Mutex<Option<Child>>) {
    if let Some(mut c) = job.lock().unwrap().take() {
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

fn hls_segments(playlist: &Path) -> usize {
    std::fs::read_to_string(playlist)
        .map(|t| {
            t.lines()
                .filter(|l| !l.is_empty() && !l.starts_with('#'))
                .count()
        })
        .unwrap_or(0)
}

/// yt-dlp's headers for one part: User-Agent through -user_agent, the rest through -headers.
fn ffmpeg_input(cmd: &mut Command, part: &YtPart) {
    let mut headers = String::new();
    for (k, v) in &part.headers {
        if k.eq_ignore_ascii_case("user-agent") {
            cmd.arg("-user_agent").arg(v);
        } else {
            headers.push_str(&format!("{k}: {v}\r\n"));
        }
    }
    if !headers.is_empty() {
        cmd.arg("-headers").arg(headers);
    }
    cmd.arg("-i").arg(&part.url);
}

/// Starts ffmpeg writing `<cache>/<id>/index.m3u8` and returns it once it lists a segment.
/// `base` gives the prefix for segment names in the playlist.
fn yt_stream_blocking(
    cache: &Path,
    id: &str,
    base: impl Fn(&Path) -> String,
    job: &Mutex<Option<Child>>,
) -> Result<PathBuf, String> {
    yt_url(id)?;
    stop_job(job);
    let dir = cache.join(id);
    let playlist = dir.join("index.m3u8");
    if std::fs::read_to_string(&playlist).is_ok_and(|t| t.contains("#EXT-X-ENDLIST")) {
        return Ok(playlist);
    }
    let ffmpeg = find_tool("ffmpeg")
        .ok_or("YouTube playback needs ffmpeg. Install it with: brew install ffmpeg")?;
    let s = yt_resolve_blocking(id)?;
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let log_path = dir.join("ffmpeg.log");
    let log = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(ffmpeg);
    cmd.args(["-nostdin", "-loglevel", "error"]);
    ffmpeg_input(&mut cmd, &s.video);
    ffmpeg_input(&mut cmd, &s.audio);
    cmd.args(["-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-f", "hls"])
        .args(["-hls_time", "4", "-hls_playlist_type", "event"])
        .args(["-hls_flags", "independent_segments", "-hls_base_url"])
        .arg(base(&dir))
        .arg(&playlist)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    *job.lock().unwrap() = Some(cmd.spawn().map_err(|e| e.to_string())?);
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        if hls_segments(&playlist) > 0 {
            return Ok(playlist);
        }
        let exited = job
            .lock()
            .unwrap()
            .as_mut()
            .is_none_or(|c| !matches!(c.try_wait(), Ok(None)));
        if exited && hls_segments(&playlist) == 0 {
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            return Err(format!(
                "ffmpeg could not stream this video: {}",
                log.lines().last().unwrap_or("it stopped early")
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    stop_job(job);
    Err("YouTube sent no video within 20 seconds. Try again.".into())
}

#[tauri::command]
async fn yt_stream(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("yt");
    tauri::async_runtime::spawn_blocking(move || {
        let job = &app.state::<YtJob>().0;
        let p = yt_stream_blocking(&cache, &id, |d| asset_url(&d.join("")), job)?;
        Ok(p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Streams are a cache: drop any older than a day.
fn clean_yt_cache(cache: &Path) {
    let Ok(dirs) = std::fs::read_dir(cache) else {
        return;
    };
    for d in dirs.flatten() {
        let age = d.metadata().and_then(|m| m.modified()).ok();
        if age.and_then(|t| t.elapsed().ok()) > Some(Duration::from_secs(86_400)) {
            let _ = std::fs::remove_dir_all(d.path());
        }
    }
}

/// "[download]  42.5% of 10.00MiB at 2.00MiB/s ETA 00:04" gives 42.5.
fn parse_yt_progress(line: &str) -> Option<f64> {
    let rest = line.strip_prefix("[download]")?.trim_start();
    rest.split_once('%')?.0.trim().parse().ok()
}

/// Video and audio download one after the other, so scale each part into one 0 to 100 bar.
fn yt_download_blocking(
    dir: &Path,
    id: &str,
    mut on_pct: impl FnMut(f64),
) -> Result<PathBuf, String> {
    let url = yt_url(id)?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let out = dir.join(format!("{id}.mp4"));
    if out.is_file() {
        return Ok(out);
    }
    let template = dir.join("%(id)s.%(ext)s");
    let mut cmd = Command::new(yt_dlp()?);
    cmd.args([
        "--no-warnings",
        "--newline",
        "--no-playlist",
        "-f",
        // H.264 first: every Mac and PC plays it, while AV1 needs newer hardware.
        "bv[ext=mp4][vcodec^=avc1]+ba[ext=m4a]/bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
        "--merge-output-format",
        "mp4",
        "-o",
    ])
    .arg(&template);
    if let Some(ffmpeg) = find_tool("ffmpeg") {
        cmd.arg("--ffmpeg-location").arg(ffmpeg);
    }
    let mut child = cmd
        .args(["--", &url])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let (mut parts, mut part) = (1.0_f64, 0.0_f64);
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            // "[info] id: Downloading 1 format(s): 137+140" is two files.
            if let Some((_, ids)) = line.split_once(" format(s): ") {
                parts = (ids.matches('+').count() + 1) as f64;
            } else if line.starts_with("[download] Destination:") {
                part += 1.0;
            } else if let Some(p) = parse_yt_progress(&line) {
                on_pct((((part - 1.0).max(0.0) * 100.0 + p) / parts).clamp(0.0, 100.0));
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    if !output.status.success() || !out.is_file() {
        let err = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "yt-dlp could not save this video: {}",
            err.lines().last().unwrap_or("")
        ));
    }
    Ok(out)
}

#[derive(Serialize, Clone)]
struct YtProgress {
    id: String,
    pct: f64,
}

#[tauri::command]
async fn yt_download(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("youtube");
    tauri::async_runtime::spawn_blocking(move || {
        let path = yt_download_blocking(&dir, &id, |pct| {
            let _ = app.emit(
                "yt-progress",
                YtProgress {
                    id: id.clone(),
                    pct,
                },
            );
        })?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
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
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Opened::default())
        .manage(YtJob::default())
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            probe,
            prepare,
            sidecar_subs,
            embedded_subs,
            thumbnail,
            ffmpeg_status,
            take_opened,
            make_default_player,
            yt_search,
            yt_resolve,
            yt_download,
            yt_stream
        ])
        .setup(|app| {
            // Files passed on the command line: `Flick movie.mkv`.
            let args: Vec<String> = std::env::args()
                .skip(1)
                .filter(|a| !a.starts_with('-'))
                .collect();
            if !args.is_empty() {
                queue_open(app.handle(), args);
            }
            if let Ok(cache) = app.path().app_cache_dir() {
                std::thread::spawn(move || clean_yt_cache(&cache.join("yt")));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
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
        if let tauri::RunEvent::Exit = event {
            stop_job(&handle.state::<YtJob>().0);
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
    fn probe_tells_native_from_needs_conversion() {
        if find_tool("ffprobe").is_none() || !Path::new(&media("Demo.Show.S01E02.Pilot.mkv")).exists() {
            eprintln!("skipped: needs ffprobe and test-media");
            return;
        }
        let mp4 = run_probe(&media("Test.Movie.2024.1080p.mp4")).unwrap();
        assert!(mp4.playable, "H.264/AAC MP4 plays natively");
        assert_eq!(mp4.video.as_deref(), Some("h264"));
        assert!((mp4.duration - 20.0).abs() < 0.5);
        let mkv = run_probe(&media("Demo.Show.S01E02.Pilot.mkv")).unwrap();
        assert!(!mkv.playable, "MKV must go through prepare");
        assert_eq!(mkv.audio.as_deref(), Some("ac3"));
        assert!(run_probe(&media("Sample.Clip.2023.webm")).unwrap().playable, "WebM plays natively");
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
    fn scan_finds_media_only() {
        let dir = media("");
        if !Path::new(&dir).exists() {
            return;
        }
        let found = tauri::async_runtime::block_on(scan_folder(dir)).unwrap();
        assert!(found.iter().any(|e| e.name.ends_with(".mkv")));
        assert!(found.iter().all(|e| !e.name.ends_with(".srt")));
    }

    #[test]
    fn parses_yt_dlp_progress_lines() {
        assert_eq!(
            parse_yt_progress("[download]  42.5% of   10.00MiB at    2.00MiB/s ETA 00:04"),
            Some(42.5)
        );
        assert_eq!(
            parse_yt_progress("[download] 100% of  190.70KiB in 00:00:00 at 1.2MiB/s"),
            Some(100.0)
        );
        assert_eq!(
            parse_yt_progress("[download] Destination: /tmp/abc.f160.mp4"),
            None
        );
        assert_eq!(
            parse_yt_progress("[info] abc: Downloading 2 format(s): 160+140"),
            None
        );
    }

    #[test]
    fn rejects_bad_youtube_ids() {
        assert!(yt_url("jNQXAC9IVRw").is_ok());
        assert!(yt_url("--exec=rm").is_err());
        assert!(yt_url("a b").is_err());
    }

    /// Real network run: `cargo test yt_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn yt_live() {
        let t = std::time::Instant::now();
        let found = yt_search_blocking("me at the zoo").unwrap();
        let n = found["entries"].as_array().map(|a| a.len()).unwrap_or(0);
        println!(
            "search: {n} entries in {:?}, first {}",
            t.elapsed(),
            found["entries"][0]["id"]
        );
        assert!(n > 0);
        let t = std::time::Instant::now();
        match yt_resolve_blocking("jNQXAC9IVRw") {
            Ok(s) => println!("resolve in {:?}: {} by {}", t.elapsed(), s.title, s.channel),
            Err(e) => println!("resolve failed in {:?}: {e}", t.elapsed()),
        }
        let dir = std::env::temp_dir().join("flick-yt-live");
        let _ = std::fs::remove_dir_all(&dir);
        let mut last = -1.0;
        let path = yt_download_blocking(&dir, "jNQXAC9IVRw", |p| {
            if p - last >= 25.0 || p >= 100.0 {
                println!("progress {p:.1}");
                last = p;
            }
        })
        .unwrap();
        println!(
            "download: {} ({} bytes)",
            path.display(),
            std::fs::metadata(&path).unwrap().len()
        );
    }

    #[test]
    fn asset_urls_match_convert_file_src() {
        let u = asset_url(Path::new("/Users/a b/yt/x/"));
        let root = if cfg!(windows) {
            "http://asset.localhost/"
        } else {
            "asset://localhost/"
        };
        assert_eq!(u, format!("{root}%2FUsers%2Fa%20b%2Fyt%2Fx%2F"));
    }

    fn probe_codecs(playlist: &Path) -> Vec<String> {
        let out = Command::new(find_tool("ffprobe").unwrap())
            .args([
                "-v",
                "error",
                "-show_entries",
                "stream=codec_name",
                "-of",
                "json",
            ])
            .arg(playlist)
            .output()
            .unwrap();
        // Top-level streams only: the "programs" section lists the same streams again.
        let j: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
        let mut c: Vec<String> = j["streams"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|s| s["codec_name"].as_str().map(String::from))
            .collect();
        c.sort();
        c
    }

    /// Real network run: `cargo test yt_stream_live -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn yt_stream_live() {
        let cache = std::env::temp_dir().join("flick-yt-stream-live");
        let _ = std::fs::remove_dir_all(&cache);
        let job = Mutex::new(None);
        for (id, check_growth) in [("jNQXAC9IVRw", false), ("aqz-KE-bpKQ", true)] {
            let t = Instant::now();
            let playlist = yt_stream_blocking(&cache, id, |_| String::new(), &job).unwrap();
            let first = hls_segments(&playlist);
            println!(
                "{id}: first segment ready in {:?} ({first} listed)",
                t.elapsed()
            );
            let codecs = probe_codecs(&playlist);
            println!("{id}: ffprobe streams {codecs:?}");
            assert_eq!(codecs, ["aac", "h264"]);
            if check_growth {
                std::thread::sleep(Duration::from_secs(10));
                let later = hls_segments(&playlist);
                println!("{id}: {first} segments, then {later} after 10s");
                assert!(later > first);
            }
        }
        stop_job(&job);
    }
}
