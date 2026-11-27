// Streams the web view cannot open (SPEC-playback): an MKV, DTS or TrueHD audio, HEVC tagged hev1.
// `probe_stream` reads at most 5 MB of a stream within 20 seconds and says whether the web view plays it
// as it is (direct) or needs the live remux, and why ("MKV", "DTS audio"). Results are kept for the session.
// A probe that fails never fails a play (SPEC-playback-2 rule 2): the player decides without it.
// The verdict reads what the video is, not only its name (rule 4): profile, pixel format and Dolby
// Vision side data decide whether the video is copied, tagged or transcoded.

use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

use super::ytdlp::{kill_tree, own_group};
use super::{basic, find_tool, input_args};

pub const PROBE_LIMIT: Duration = Duration::from_secs(20);
/// What `output_within` returns when the command ran out of time.
pub const TIMED_OUT: &str = "timed out";

/// Audio fMP4 HLS carries that the web view plays: copied as is. Anything else becomes AAC.
pub const COPY_AUDIO: &[&str] = &["aac", "mp3", "alac", "ac3", "eac3"];
/// What the web view plays without help (the table `run_probe` uses).
const DIRECT_VIDEO: &[&str] = &["h264", "hevc", "vp9", "vp8", "av1"];
/// Played as they are only when the web view says so (`plays`, from its canPlayType).
const ASK_VIDEO: &[&str] = &["vp9", "av1"];
/// The pixel formats the web view decodes in H.264 (8-bit 4:2:0) and, with 10-bit, in HEVC.
const H264_PIX: &[&str] = &["yuv420p", "yuvj420p"];
const HEVC_PIX: &[&str] = &["yuv420p", "yuvj420p", "yuv420p10le"];

/// What a remux run does with the video (SPEC-playback-2 rule 4).
#[derive(Serialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VideoOut {
    /// Copied as it is: 8-bit 4:2:0 H.264.
    #[default]
    Copy,
    /// HEVC copied and tagged hvc1, as Safari needs.
    Hvc1,
    /// Dolby Vision profile 5 copied with its DOVI box, tagged dvh1.
    Dvh1,
    /// Transcoded to 8-bit H.264.
    H264,
    /// Transcoded to HEVC main10, which keeps 10-bit.
    Hevc10,
}

/// ffmpeg's video arguments for `v`.
pub fn video_out_args(v: VideoOut) -> Vec<String> {
    let mac = cfg!(target_os = "macos");
    let a: &[&str] = match v {
        VideoOut::Copy => &["-c:v", "copy"],
        VideoOut::Hvc1 => &["-c:v", "copy", "-tag:v", "hvc1"],
        VideoOut::Dvh1 => &["-c:v", "copy", "-tag:v", "dvh1", "-strict", "unofficial"],
        VideoOut::H264 if mac => &["-c:v", "h264_videotoolbox", "-b:v", "10M", "-pix_fmt", "yuv420p"],
        VideoOut::H264 => &["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"],
        VideoOut::Hevc10 if mac => &[
            "-c:v", "hevc_videotoolbox", "-profile:v", "main10", "-pix_fmt", "p010le", "-tag:v", "hvc1",
            "-b:v", "12M",
        ],
        VideoOut::Hevc10 => &[
            "-c:v", "libx265", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p10le", "-tag:v",
            "hvc1",
        ],
    };
    a.iter().map(|x| x.to_string()).collect()
}
const DIRECT_AUDIO: &[&str] = &[
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
];

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StreamProbe {
    /// Seconds, 0 when the source does not say.
    pub duration: f64,
    pub container: String,
    pub video: Option<String>,
    pub audio: Option<String>,
    pub channels: u32,
    /// The web view plays it as it is.
    pub direct: bool,
    /// Why it needs the remux, in a few words ("MKV", "DTS audio"); None when direct.
    pub why: Option<String>,
    /// What a remux run does: transcode the video to H.264, or the audio to AAC.
    pub converts_video: bool,
    pub converts_audio: bool,
    /// False when ffprobe is missing: nothing was checked and the player plays it as it is.
    pub checked: bool,
    /// What a remux run does with the video; None decides by the codec name alone.
    pub video_out: Option<VideoOut>,
}

impl StreamProbe {
    /// The safe profile, for a stream the probe could not read: video to 8-bit H.264, audio to AAC
    /// stereo, length unknown (rule 2).
    pub fn safe() -> Self {
        StreamProbe {
            video: Some("unknown".into()),
            audio: Some("unknown".into()),
            channels: 2,
            why: Some("safe profile".into()),
            converts_video: true,
            converts_audio: true,
            video_out: Some(VideoOut::H264),
            ..Default::default()
        }
    }

    /// What a remux run does with the video.
    pub fn video_out(&self) -> VideoOut {
        self.video_out.unwrap_or(match self.video.as_deref() {
            Some("h264") => VideoOut::Copy,
            Some("hevc") => VideoOut::Hvc1,
            _ => VideoOut::H264,
        })
    }
}

/// The extension of a path or URL, without its query or fragment.
fn ext_of(input: &str) -> String {
    let p = input.split(['?', '#']).next().unwrap_or(input);
    Path::new(p)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn audio_name(c: &str) -> String {
    match c {
        "dts" => "DTS".into(),
        "truehd" => "TrueHD".into(),
        "mlp" => "MLP".into(),
        "wmav2" | "wmapro" => "WMA".into(),
        c if c.starts_with("pcm_") => "PCM".into(),
        c => c.to_ascii_uppercase(),
    }
}

fn video_name(c: &str) -> String {
    match c {
        "mpeg4" => "MPEG-4".into(),
        "mpeg2video" => "MPEG-2".into(),
        "mpeg1video" => "MPEG-1".into(),
        "vc1" => "VC-1".into(),
        "msmpeg4v3" => "DivX".into(),
        c => c.to_ascii_uppercase(),
    }
}

/// The container's problem, or None when the web view opens it.
fn container_why(
    format: &str,
    ext: &str,
    video: Option<&str>,
    audio: Option<&str>,
) -> Option<String> {
    let f = format;
    let plays = ["hls", "mp3", "aac", "wav", "flac", "aiff"];
    if f.contains("mp4") || f.contains("mov") || plays.contains(&f) {
        return None;
    }
    if f.contains("matroska") {
        // ffprobe names WebM and MKV alike: WebM holds only WebM's own codecs.
        let webm = video.is_none_or(|v| ["vp8", "vp9", "av1"].contains(&v))
            && audio.is_none_or(|a| ["opus", "vorbis"].contains(&a));
        return (ext == "mkv" || !webm).then(|| "MKV".into());
    }
    Some(
        match f.split(',').next().unwrap_or(f) {
            "avi" => "AVI",
            "mpegts" => "MPEG-TS",
            "asf" => "WMV",
            "flv" => "FLV",
            "mpeg" => "MPEG",
            "ogg" => "Ogg",
            other => return Some(other.to_ascii_uppercase()),
        }
        .into(),
    )
}

/// The video's own problem and what a remux does with it, from its profile, pixel format and side data.
fn video_verdict(
    v: &str,
    tag: &str,
    pix: &str,
    dv5: bool,
    mp4: bool,
    plays: &[String],
) -> (Option<String>, VideoOut) {
    let deep = pix.contains("p10") || pix.contains("p12");
    let chroma = || match pix {
        p if p.contains("444") => "4:4:4",
        p if p.contains("422") => "4:2:2",
        _ => "4:2:0",
    };
    let other = if deep { VideoOut::Hevc10 } else { VideoOut::H264 };
    match v {
        "h264" if pix.is_empty() || H264_PIX.contains(&pix) => (None, VideoOut::Copy),
        "h264" if deep => (Some("10-bit H.264".into()), VideoOut::Hevc10),
        "h264" => (Some(format!("{} H.264", chroma())), VideoOut::Hevc10),
        "hevc" if dv5 => (Some("Dolby Vision".into()), VideoOut::Dvh1),
        "hevc" if !pix.is_empty() && !HEVC_PIX.contains(&pix) => {
            (Some(format!("{} HEVC", chroma())), VideoOut::Hevc10)
        }
        // Safari plays HEVC in MP4 only when it is tagged hvc1.
        "hevc" if mp4 && tag == "hev1" => (Some("HEVC tagged hev1".into()), VideoOut::Hvc1),
        "hevc" => (None, VideoOut::Hvc1),
        v if ASK_VIDEO.contains(&v) && !plays.iter().any(|p| p == v) => {
            (Some(format!("{} video", video_name(v))), other)
        }
        v if DIRECT_VIDEO.contains(&v) => (None, other),
        v => (Some(format!("{} video", video_name(v))), other),
    }
}

/// ffprobe's JSON for `input`, read as direct or remux. `plays` names the codecs among VP9 and AV1
/// that the web view's canPlayType accepts.
pub fn verdict(j: &serde_json::Value, input: &str, plays: &[String]) -> StreamProbe {
    let mut p = StreamProbe {
        container: j["format"]["format_name"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        duration: j["format"]["duration"]
            .as_str()
            .and_then(|s| s.parse().ok())
            .unwrap_or(0.0),
        checked: true,
        ..Default::default()
    };
    let (mut tag, mut pix, mut dv5) = (String::new(), String::new(), false);
    for s in j["streams"].as_array().into_iter().flatten() {
        let codec = s["codec_name"].as_str().unwrap_or("").to_string();
        match s["codec_type"].as_str() {
            Some("video") if p.video.is_none() && codec != "mjpeg" && codec != "png" => {
                tag = s["codec_tag_string"].as_str().unwrap_or("").to_string();
                pix = s["pix_fmt"].as_str().unwrap_or("").to_string();
                // Dolby Vision profile 5 has no HDR10 base layer: its DOVI record, or its MP4 tag.
                dv5 = ["dvh1", "dvhe"].contains(&tag.as_str())
                    || s["side_data_list"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|d| d["dv_profile"].as_u64() == Some(5));
                p.video = Some(codec);
            }
            Some("audio") if p.audio.is_none() => {
                p.channels = s["channels"].as_u64().unwrap_or(2) as u32;
                p.audio = Some(codec);
            }
            _ => {}
        }
    }
    let (v, a) = (p.video.as_deref(), p.audio.as_deref());
    let mp4 = p.container.contains("mp4") || p.container.contains("mov");
    let (video_why, out) = v.map_or((None, VideoOut::Copy), |v| {
        video_verdict(v, &tag, &pix, dv5, mp4, plays)
    });
    // A video the web view cannot decode at all names the problem first: it is why the remux transcodes.
    let first = video_why.clone().filter(|_| matches!(out, VideoOut::Hevc10 | VideoOut::Dvh1));
    p.why = first
        .or_else(|| container_why(&p.container, &ext_of(input), v, a))
        .or_else(|| {
            a.filter(|a| !DIRECT_AUDIO.contains(a))
                .map(|a| format!("{} audio", audio_name(a)))
        })
        .or(video_why);
    p.direct = p.why.is_none();
    p.video_out = Some(out);
    p.converts_video = matches!(out, VideoOut::H264 | VideoOut::Hevc10);
    p.converts_audio = a.is_some_and(|a| !COPY_AUDIO.contains(&a));
    p
}

/// Runs `cmd` with a deadline, killing it (and anything it started) when time runs out.
pub(crate) fn output_within(
    cmd: &mut Command,
    limit: Duration,
) -> Result<(bool, Vec<u8>, Vec<u8>), String> {
    let mut child = own_group(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    let drain = |r: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut b = vec![];
            if let Some(mut r) = r {
                let _ = r.read_to_end(&mut b);
            }
            b
        })
    };
    let out = drain(child.stdout.take().map(|r| Box::new(r) as _));
    let err = drain(child.stderr.take().map(|r| Box::new(r) as _));
    let start = Instant::now();
    let ok = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status.success(),
            None if start.elapsed() >= limit => {
                kill_tree(&mut child);
                let _ = child.wait();
                return Err(TIMED_OUT.into());
            }
            None => std::thread::sleep(Duration::from_millis(20)),
        }
    };
    Ok((
        ok,
        out.join().unwrap_or_default(),
        err.join().unwrap_or_default(),
    ))
}

pub fn probe_args(input: &str, auth: Option<&str>) -> Vec<String> {
    let mut a: Vec<String> = ["-v", "error", "-probesize", "5M", "-analyzeduration", "5M"]
        .map(String::from)
        .into();
    a.extend(
        [
            "-show_entries",
            "format=format_name,duration:stream=codec_type,codec_name,codec_tag_string,channels,profile,pix_fmt:stream_side_data=dv_profile",
            "-of",
            "json",
        ]
        .map(String::from),
    );
    a.extend(input_args(input, auth));
    a
}

/// Probes `input` with ffprobe, reading at most 5 MB, for at most `limit`.
pub fn probe(
    ffprobe: &Path,
    input: &str,
    auth: Option<&str>,
    limit: Duration,
    plays: &[String],
) -> Result<StreamProbe, String> {
    let mut cmd = Command::new(ffprobe);
    cmd.args(probe_args(input, auth));
    let (ok, out, err) = output_within(&mut cmd, limit)?;
    let j: serde_json::Value = serde_json::from_slice(&out).unwrap_or_default();
    if !ok || j["format"].is_null() {
        let why = String::from_utf8_lossy(&err);
        let why = why
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("no answer");
        return Err(format!("This stream could not be read: {}", why.trim()));
    }
    Ok(verdict(&j, input, plays))
}

/// Probe results for this session, by input and login.
#[derive(Default)]
pub struct Probes(Mutex<HashMap<String, StreamProbe>>);

/// The probe of `input`, from this session's results when it has one. Without ffprobe nothing is
/// checked and the player plays the stream as it is.
pub fn probe_cached(
    st: &Probes,
    input: &str,
    auth: Option<&str>,
    plays: &[String],
) -> Result<StreamProbe, String> {
    let key = format!("{input}\n{}", auth.unwrap_or(""));
    if let Some(p) = st.0.lock().unwrap().get(&key) {
        return Ok(p.clone());
    }
    let Some(ffprobe) = find_tool("ffprobe") else {
        return Ok(StreamProbe {
            direct: true,
            ..Default::default()
        });
    };
    let p = probe(&ffprobe, input, auth, PROBE_LIMIT, plays)?;
    st.0.lock().unwrap().insert(key, p.clone());
    Ok(p)
}

#[tauri::command]
pub async fn probe_stream(
    app: tauri::AppHandle,
    url: String,
    user: Option<String>,
    pass: Option<String>,
    plays: Option<Vec<String>>,
) -> Result<StreamProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let auth = basic(&user.unwrap_or_default(), &pass.unwrap_or_default());
        let plays = plays.unwrap_or_default();
        probe_cached(&app.state::<Probes>(), &url, auth.as_deref(), &plays)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Fixture media and a fixture server for the playback tests. Media is made with ffmpeg in the test.
#[cfg(test)]
pub mod fixtures {
    use std::collections::HashMap;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    /// ffmpeg and ffprobe, or None so a test skips on a computer without them. In CI (`CI` set) a
    /// missing tool fails the test instead, so a runner without ffmpeg cannot pass these tests unseen.
    pub fn tools() -> Option<(PathBuf, PathBuf)> {
        required(
            super::find_tool("ffmpeg").zip(super::find_tool("ffprobe")),
            std::env::var_os("CI").is_some(),
        )
    }

    fn required<T>(found: Option<T>, ci: bool) -> Option<T> {
        assert!(
            found.is_some() || !ci,
            "CI is set but ffmpeg or ffprobe is missing: install ffmpeg in this job"
        );
        found
    }

    #[test]
    fn a_missing_ffmpeg_skips_locally_and_fails_in_ci() {
        assert_eq!(required(None::<()>, false), None);
        assert_eq!(required(Some(1), true), Some(1));
        assert!(std::panic::catch_unwind(|| required(None::<()>, true)).is_err());
    }

    pub fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("flick-playback-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Makes a fixture with ffmpeg: a test pattern and silent audio, `secs` long.
    pub fn fixture(ffmpeg: &Path, out: &Path, secs: u32, fps: u32, codecs: &[&str]) {
        let ok = Command::new(ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i"])
            .arg(format!("testsrc=size=320x180:rate={fps}"))
            .args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"])
            .args(["-t", &secs.to_string(), "-pix_fmt", "yuv420p"])
            .args(codecs)
            .arg(out)
            .status()
            .unwrap();
        assert!(ok.success(), "ffmpeg could not make {out:?}");
    }

    /// How the fixture server answers one path that is not a plain file.
    #[derive(Clone)]
    pub enum Route {
        /// After a wait, a 302 to another path on this server.
        Redirect(Duration, String),
        /// A valid 200 typed video/mp4, then bytes that are no media at all.
        Garbage,
        /// The file's headers, then nothing more.
        StallBody,
        /// 416 to any range.
        RangeRefused,
    }

    pub fn redirect(after: Duration, to: &str) -> Route {
        Route::Redirect(after, to.into())
    }

    pub struct Server {
        pub base: String,
        hits: Arc<Mutex<HashMap<String, usize>>>,
    }

    impl Server {
        /// How many requests reached `path`.
        pub fn hits(&self, path: &str) -> usize {
            *self.hits.lock().unwrap().get(path).unwrap_or(&0)
        }
    }

    /// Serves `dir` over http on a free port with byte ranges; `hang` never answers at all.
    pub fn serve(dir: PathBuf, hang: bool) -> String {
        serve_with(dir, hang, vec![]).base
    }

    pub fn serve_routes(dir: PathBuf, routes: Vec<(&str, Route)>) -> Server {
        serve_with(dir, false, routes)
    }

    fn type_of(path: &str) -> &'static str {
        match path.rsplit('.').next() {
            Some("mp4") => "video/mp4",
            Some("mkv") => "video/x-matroska",
            _ => "application/octet-stream",
        }
    }

    fn serve_with(dir: PathBuf, hang: bool, routes: Vec<(&str, Route)>) -> Server {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let routes: HashMap<String, Route> = routes
            .into_iter()
            .map(|(p, r)| (p.to_string(), r))
            .collect();
        let hits = Arc::new(Mutex::new(HashMap::<String, usize>::new()));
        let counted = hits.clone();
        std::thread::spawn(move || {
            for s in l.incoming().flatten() {
                let (dir, routes, hits) = (dir.clone(), routes.clone(), counted.clone());
                std::thread::spawn(move || {
                    let mut r = BufReader::new(s.try_clone().unwrap());
                    let (mut path, mut range) = (String::new(), None::<(u64, Option<u64>)>);
                    let mut line = String::new();
                    while r.read_line(&mut line).unwrap_or(0) > 0 && line != "\r\n" {
                        if let Some(p) = line.strip_prefix("GET ") {
                            path = p
                                .split(' ')
                                .next()
                                .unwrap_or("")
                                .trim_start_matches('/')
                                .into();
                        }
                        if let Some(v) = line.to_ascii_lowercase().strip_prefix("range: bytes=") {
                            let (a, b) = v.trim().split_once('-').unwrap_or((v.trim(), ""));
                            range = a.parse().ok().map(|a| (a, b.parse().ok()));
                        }
                        line.clear();
                    }
                    *hits.lock().unwrap().entry(path.clone()).or_default() += 1;
                    if hang {
                        std::thread::sleep(Duration::from_secs(30));
                        return;
                    }
                    let mut w = &s;
                    match routes.get(&path) {
                        Some(Route::Redirect(after, to)) => {
                            std::thread::sleep(*after);
                            let _ = w.write_all(format!("HTTP/1.1 302 Found\r\nLocation: /{to}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes());
                            return;
                        }
                        Some(Route::Garbage) => {
                            let junk: Vec<u8> =
                                (0..200_000u32).map(|i| (i * 7919 % 251) as u8).collect();
                            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", junk.len());
                            let _ = w
                                .write_all(head.as_bytes())
                                .and_then(|_| w.write_all(&junk));
                            return;
                        }
                        Some(Route::StallBody) => {
                            let _ = w.write_all(b"HTTP/1.1 206 Partial Content\r\nContent-Type: video/x-matroska\r\nContent-Range: bytes 0-0/50000000\r\nAccept-Ranges: bytes\r\nContent-Length: 50000000\r\n\r\n");
                            std::thread::sleep(Duration::from_secs(30));
                            return;
                        }
                        Some(Route::RangeRefused) => {
                            let _ = w.write_all(b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */0\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                            return;
                        }
                        None => {}
                    }
                    let Ok(data) = std::fs::read(dir.join(&path)) else {
                        let _ = w.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                        return;
                    };
                    let n = data.len() as u64;
                    let from = range.map_or(0, |r| r.0).min(n);
                    let to = range
                        .and_then(|r| r.1)
                        .map_or(n, |b| (b + 1).min(n))
                        .max(from);
                    let head = match range {
                        Some(_) => format!(
                            "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {from}-{}/{n}\r\n",
                            to.saturating_sub(1)
                        ),
                        None => "HTTP/1.1 200 OK\r\n".into(),
                    };
                    let head = format!("{head}Content-Type: {}\r\nAccept-Ranges: bytes\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", type_of(&path), to - from);
                    let _ = w
                        .write_all(head.as_bytes())
                        .and_then(|_| w.write_all(&data[from as usize..to as usize]));
                });
            }
        });
        Server {
            base: format!("http://127.0.0.1:{port}"),
            hits,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixtures::*;
    use super::*;

    #[test]
    fn verdicts_name_what_needs_the_remux() {
        let j = |fmt: &str, v: &str, tag: &str, a: &str| {
            serde_json::json!({"format": {"format_name": fmt, "duration": "60.0"}, "streams": [
                {"codec_type": "video", "codec_name": v, "codec_tag_string": tag},
                {"codec_type": "audio", "codec_name": a, "channels": 6}]})
        };
        let mp4 = "mov,mp4,m4a,3gp,3g2,mj2";
        let why = |fmt, v, tag, a, url| verdict(&j(fmt, v, tag, a), url, &[]).why;
        assert_eq!(why(mp4, "h264", "avc1", "aac", "https://x/a.mp4"), None);
        assert_eq!(why(mp4, "hevc", "hvc1", "eac3", "https://x/a.mp4"), None);
        assert_eq!(
            why(mp4, "hevc", "hev1", "aac", "https://x/a.mp4").as_deref(),
            Some("HEVC tagged hev1")
        );
        assert_eq!(
            why(mp4, "h264", "avc1", "dts", "https://x/a.mp4").as_deref(),
            Some("DTS audio")
        );
        assert_eq!(
            why(mp4, "h264", "avc1", "truehd", "/m/a.mp4").as_deref(),
            Some("TrueHD audio")
        );
        assert_eq!(
            why(mp4, "mpeg4", "", "aac", "/m/a.mp4").as_deref(),
            Some("MPEG-4 video")
        );
        assert_eq!(
            why("matroska,webm", "h264", "", "aac", "https://x/a.mkv?t=1").as_deref(),
            Some("MKV")
        );
        // A debrid link has no extension: WebM codecs make it WebM, anything else MKV.
        let vp9 = j("matroska,webm", "vp9", "", "opus");
        assert_eq!(verdict(&vp9, "https://x/dl/123", &["vp9".into()]).why, None);
        assert_eq!(
            why("matroska,webm", "h264", "", "ac3", "https://x/dl/123").as_deref(),
            Some("MKV")
        );
        assert_eq!(
            why("avi", "mpeg4", "", "mp3", "/m/a.avi").as_deref(),
            Some("AVI")
        );
        assert_eq!(why("hls", "h264", "", "aac", "https://x/a.m3u8"), None);
        let p = verdict(&j("matroska,webm", "vc1", "", "dts"), "/m/a.mkv", &[]);
        assert!(p.converts_video && p.converts_audio && !p.direct && p.channels == 6);
        let p = verdict(&j("matroska,webm", "hevc", "", "eac3"), "/m/a.mkv", &[]);
        assert!(!p.converts_video && !p.converts_audio);
    }

    // SPEC-playback-2 rule 4: the video's profile, pixel format and side data, not only its name.
    #[test]
    fn verdicts_read_the_pixel_format_and_dolby_vision() {
        let mp4 = "mov,mp4,m4a,3gp,3g2,mj2";
        let j = |fmt: &str, v: &str, tag: &str, pix: &str, side: serde_json::Value| {
            serde_json::json!({"format": {"format_name": fmt, "duration": "60.0"}, "streams": [
                {"codec_type": "video", "codec_name": v, "codec_tag_string": tag, "pix_fmt": pix, "side_data_list": side},
                {"codec_type": "audio", "codec_name": "opus", "channels": 2}]})
        };
        let none = serde_json::json!([]);
        let v = |fmt, c, tag, pix| verdict(&j(fmt, c, tag, pix, none.clone()), "https://x/a", &[]);
        // 8-bit 4:2:0 H.264 plays and copies, full range too.
        for pix in ["yuv420p", "yuvj420p"] {
            let p = v(mp4, "h264", "avc1", pix);
            assert!(p.direct && p.video_out() == VideoOut::Copy, "{pix}: {p:?}");
        }
        // Case 7 and 8: 10-bit, 4:2:2 or 4:4:4 H.264 transcodes to HEVC main10, its problem named first.
        let p = v("matroska,webm", "h264", "", "yuv420p10le");
        assert_eq!((p.direct, p.why.as_deref()), (false, Some("10-bit H.264")));
        assert_eq!((p.video_out(), p.converts_video), (VideoOut::Hevc10, true));
        let p = v(mp4, "h264", "avc1", "yuv444p");
        assert_eq!((p.why.as_deref(), p.video_out()), (Some("4:4:4 H.264"), VideoOut::Hevc10));
        assert_eq!(v(mp4, "h264", "avc1", "yuv422p10le").why.as_deref(), Some("10-bit H.264"));
        // HEVC 4:2:0 at 8 or 10 bits plays tagged hvc1; 4:2:2 HEVC transcodes.
        let p = v(mp4, "hevc", "hvc1", "yuv420p10le");
        assert!(p.direct && p.video_out() == VideoOut::Hvc1 && !p.converts_video, "{p:?}");
        assert_eq!(v(mp4, "hevc", "hvc1", "yuv422p10le").why.as_deref(), Some("4:2:2 HEVC"));
        // Case 9: Dolby Vision profile 5, from its DOVI record or its tag, is copied as dvh1, never direct.
        let dv = serde_json::json!([{"side_data_type": "DOVI configuration record", "dv_profile": 5}]);
        let p = verdict(&j(mp4, "hevc", "hvc1", "yuv420p10le", dv), "https://x/a.mp4", &[]);
        assert_eq!((p.direct, p.why.as_deref()), (false, Some("Dolby Vision")));
        assert_eq!((p.video_out(), p.converts_video), (VideoOut::Dvh1, false));
        assert_eq!(v(mp4, "hevc", "dvh1", "yuv420p10le").video_out(), VideoOut::Dvh1);
        assert_eq!(v("matroska,webm", "hevc", "dvhe", "yuv420p10le").why.as_deref(), Some("Dolby Vision"));
        // Profile 8 keeps an HDR10 base layer and plays as HEVC.
        let dv8 = serde_json::json!([{"side_data_type": "DOVI configuration record", "dv_profile": 8}]);
        assert!(verdict(&j(mp4, "hevc", "hvc1", "yuv420p10le", dv8), "https://x/a.mp4", &[]).direct);
        // VP9 and AV1 play only when the web view says so; a remux transcodes them.
        let web = |c: &str, plays: &[String]| verdict(&j("matroska,webm", c, "", "yuv420p", none.clone()), "https://x/a.webm", plays);
        assert_eq!(web("vp9", &[]).why.as_deref(), Some("VP9 video"));
        assert!(web("vp9", &["vp9".into()]).direct);
        assert_eq!(web("av1", &["vp9".into()]).why.as_deref(), Some("AV1 video"));
        assert!(web("av1", &["av1".into()]).direct);
        assert_eq!(web("vp9", &[]).video_out(), VideoOut::H264);
    }

    // Cases 7 and 8 against real files: the probe reads the pixel format ffmpeg wrote.
    #[test]
    fn ten_bit_and_four_four_four_h264_fixtures_probe_as_transcodes() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("deep");
        let x264 = |pix: &'static str, prof: &'static str| ["-c:v", "libx264", "-pix_fmt", pix, "-profile:v", prof, "-c:a", "aac"];
        fixture(&ffmpeg, &dir.join("a10.mkv"), 2, 24, &x264("yuv420p10le", "high10"));
        fixture(&ffmpeg, &dir.join("b444.mp4"), 2, 24, &x264("yuv444p", "high444"));
        let base = serve(dir.clone(), false);
        let p = probe(&ffprobe, &format!("{base}/a10.mkv"), None, PROBE_LIMIT, &[]).unwrap();
        assert_eq!((p.direct, p.why.as_deref(), p.video_out()), (false, Some("10-bit H.264"), VideoOut::Hevc10));
        let p = probe(&ffprobe, &format!("{base}/b444.mp4"), None, PROBE_LIMIT, &[]).unwrap();
        assert_eq!((p.direct, p.why.as_deref(), p.video_out()), (false, Some("4:4:4 H.264"), VideoOut::Hevc10));
        let _ = std::fs::remove_dir_all(dir);
    }

    // Cases 1, 2 and 3 (the probe): an MKV is remux "MKV", an MP4 with DTS is remux "DTS audio",
    // an MP4 with h264 and aac is direct; each knows its duration.
    #[test]
    fn fixtures_over_http_probe_as_remux_or_direct() {
        let Some((ffmpeg, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffmpeg");
        };
        let dir = scratch("probe");
        let mkv = ["-c:v", "libx264", "-g", "48", "-c:a", "ac3", "-ac", "6"];
        fixture(&ffmpeg, &dir.join("a.mkv"), 60, 24, &mkv);
        let hevc = [
            "-c:v",
            "libx265",
            "-tag:v",
            "hev1",
            "-x265-params",
            "log-level=error",
        ];
        let dts = ["-c:a", "dca", "-strict", "-2", "-ac", "2"];
        fixture(
            &ffmpeg,
            &dir.join("b.mp4"),
            20,
            24,
            &[&hevc[..], &dts].concat(),
        );
        fixture(
            &ffmpeg,
            &dir.join("c.mp4"),
            10,
            24,
            &["-c:v", "libx264", "-c:a", "aac"],
        );
        let base = serve(dir.clone(), false);
        let p = |n: &str| probe(&ffprobe, &format!("{base}/{n}"), None, PROBE_LIMIT, &[]).unwrap();

        let a = p("a.mkv");
        assert_eq!((a.direct, a.why.as_deref()), (false, Some("MKV")));
        assert_eq!(
            (a.video.as_deref(), a.audio.as_deref(), a.channels),
            (Some("h264"), Some("ac3"), 6)
        );
        assert!(!a.converts_audio && !a.converts_video);
        assert!((a.duration - 60.0).abs() < 1.0, "duration {}", a.duration);
        let b = p("b.mp4");
        assert_eq!((b.direct, b.why.as_deref()), (false, Some("DTS audio")));
        assert!(b.converts_audio && !b.converts_video);
        let c = p("c.mp4");
        assert!(c.direct && c.why.is_none() && c.checked, "{c:?}");

        // The session keeps a result: the file gone from the server, the second probe still answers.
        let st = Probes::default();
        let url = format!("{base}/c.mp4");
        let first = probe_cached(&st, &url, None, &[]).unwrap();
        std::fs::remove_file(dir.join("c.mp4")).unwrap();
        assert!(probe(&ffprobe, &url, None, PROBE_LIMIT, &[]).is_err());
        assert_eq!(probe_cached(&st, &url, None, &[]).unwrap(), first);
        let _ = std::fs::remove_dir_all(dir);
    }

    // SPEC-playback-2 case 6 (the probe's half): a server that never answers stops the probe at its
    // limit (20 s, shortened here) with no player message; the run then takes the safe profile.
    #[test]
    fn a_probe_that_times_out_says_nothing_and_leaves_the_safe_profile() {
        assert_eq!(PROBE_LIMIT, Duration::from_secs(20));
        let a = super::super::live::run_args(
            "https://x/a.mkv",
            None,
            &StreamProbe::safe(),
            0.0,
            Path::new("/c/r"),
        );
        let a = a.join(" ");
        assert!(a.contains("-c:a aac -b:a 384k -ac 2"), "{a}");
        if cfg!(target_os = "macos") {
            assert!(
                a.contains("-c:v h264_videotoolbox -b:v 10M -pix_fmt yuv420p"),
                "{a}"
            );
        }
        let Some((_, ffprobe)) = tools() else {
            return eprintln!("skipped: needs ffprobe");
        };
        let base = serve(std::env::temp_dir(), true);
        let limit = Duration::from_secs(2);
        let t0 = Instant::now();
        let e = probe(&ffprobe, &format!("{base}/a.mkv"), None, limit, &[]).unwrap_err();
        let took = t0.elapsed();
        assert_eq!(e, TIMED_OUT);
        assert!(
            took >= limit && took < limit + Duration::from_secs(1),
            "took {took:?}"
        );
    }
}
