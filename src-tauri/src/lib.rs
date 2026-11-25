// Flick desktop backend: folder scanning, format probing, ffmpeg remux for MKV/AVI,
// thumbnails, subtitles, Finder "Open With", and the default-player switch.

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager, RunEvent};

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
        .invoke_handler(tauri::generate_handler![
            scan_folder,
            probe,
            prepare,
            sidecar_subs,
            embedded_subs,
            thumbnail,
            ffmpeg_status,
            take_opened,
            make_default_player
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
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Flick");

    app.run(|handle, event| {
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        if let RunEvent::Opened { urls } = &event {
            let paths = urls
                .iter()
                .filter_map(|u| u.to_file_path().ok())
                .map(|p| p.to_string_lossy().into_owned())
                .collect();
            queue_open(handle, paths);
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
}
