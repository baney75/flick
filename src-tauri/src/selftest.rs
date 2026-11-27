// The desktop self-test (scripts/desktop-selftest.mjs). Only a build with a self-test identifier, started
// with FLICK_SELFTEST=plugins, perf, youtube or playback, runs it, so the user's own Flick and its data never do. The report goes to the
// path in FLICK_SELFTEST_OUT, which the web side cannot choose, and then the app quits.

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

/// Every self-test build is `dev.flick.selftest.<8 hex>`, the hex from its worktree's path, so two
/// worktrees never share a profile. Nothing else, Flick's own com.dbaney.flick above all, passes.
pub const PREFIX: &str = "dev.flick.selftest.";

pub fn is_selftest(identifier: &str) -> bool {
    identifier.strip_prefix(PREFIX).is_some_and(|h| {
        h.len() == 8 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}
const MODES: [&str; 4] = ["plugins", "perf", "youtube", "playback"];
static LAUNCHED_MS: OnceLock<u64> = OnceLock::new();
static SETUP_MS: OnceLock<u64> = OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Called first thing in run(): the perf check times cold start from here.
pub fn mark_launch() {
    let _ = LAUNCHED_MS.set(now_ms());
}

/// Called first thing in setup(), once Tauri and its plugins are up and before the window's page loads.
pub fn mark_setup() {
    let _ = SETUP_MS.set(now_ms());
}

/// The mode asked for in the environment, if it is one Flick knows.
fn env_mode() -> Option<&'static str> {
    let m = std::env::var("FLICK_SELFTEST").ok()?;
    MODES.into_iter().find(|k| *k == m)
}

/// Runs before the page's own scripts in a self-test run: the mode and launch time, and the time of the
/// last DOM change, so the perf check sees start-up from the first frame. A window that is never shown
/// has no display, so in perf mode animation frames are emulated at 60 Hz (rafEmulated tells the report).
pub fn init_script(identifier: &str) -> Option<String> {
    if !is_selftest(identifier) {
        return None;
    }
    let mode = env_mode()?;
    let at = LAUNCHED_MS.get().copied().unwrap_or(0);
    let raf = if mode == "perf" {
        "window.__FLICK_SELFTEST__.rafEmulated=true;\
         window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(performance.now())},16)};\
         window.cancelAnimationFrame=function(id){clearTimeout(id)};"
    } else if mode == "playback" {
        // The player's Now Playing handlers, so the run seeks the way the system's controls do.
        "window.__FLICK_SELFTEST__.actions={};\
         if(navigator.mediaSession){var own=navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);\
         navigator.mediaSession.setActionHandler=function(a,f){window.__FLICK_SELFTEST__.actions[a]=f;try{own(a,f)}catch(e){}}};"
    } else {
        ""
    };
    Some(format!(
        "window.__FLICK_SELFTEST__={{mode:'{mode}',launchedAt:{at},lastMutation:0}};{raf}\
         new MutationObserver(function(){{window.__FLICK_SELFTEST__.lastMutation=performance.now()}})\
         .observe(document,{{subtree:true,childList:true,attributes:true,characterData:true}});"
    ))
}

/// WebKit slows timers in a page that is not on screen (a 20 ms timeout ran in 140 to 260 ms), which
/// would charge the hidden window's handicap to the app. The self-test turns that off, where this
/// WebKit has the switches.
pub fn unthrottle<M: Manager<tauri::Wry>>(app: &M) {
    #[cfg(target_os = "macos")]
    for w in app.webview_windows().values() {
        let _ = w.with_webview(|pv| unsafe {
            use objc2::runtime::{AnyObject, Bool};
            use objc2::{msg_send, sel};
            let wk = pv.inner() as *mut AnyObject;
            let conf: *mut AnyObject = msg_send![wk, configuration];
            let prefs: *mut AnyObject = msg_send![conf, preferences];
            if prefs.is_null() {
                return;
            }
            let has = |s| -> bool { msg_send![prefs, respondsToSelector: s] };
            if has(sel!(_setHiddenPageDOMTimerThrottlingEnabled:)) {
                let _: () = msg_send![prefs, _setHiddenPageDOMTimerThrottlingEnabled: Bool::NO];
            }
            if has(sel!(_setPageVisibilityBasedProcessSuppressionEnabled:)) {
                let _: () =
                    msg_send![prefs, _setPageVisibilityBasedProcessSuppressionEnabled: Bool::NO];
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// True when the process was started for a self-test, before the app config is read.
pub fn requested() -> bool {
    std::env::var_os("FLICK_SELFTEST").is_some()
}

/// True only in the self-test build started for a self-test: the hide and no-focus rules key on this, so
/// another build started with FLICK_SELFTEST set behaves as usual.
pub fn active<M: Manager<tauri::Wry>>(app: &M) -> bool {
    requested() && is_selftest(&app.config().identifier)
}

/// The yt-dlp folder the script shares between runs (FLICK_SELFTEST_TOOLS), read-only, so a run whose
/// profile is new each time does not download yt-dlp again. Only a self-test run honors it.
pub fn tools_dir<M: Manager<tauri::Wry>>(app: &M) -> Option<PathBuf> {
    tools_gate(
        active(app),
        std::env::var_os("FLICK_SELFTEST_TOOLS").map(PathBuf::from),
    )
}

fn tools_gate(active: bool, dir: Option<PathBuf>) -> Option<PathBuf> {
    dir.filter(|d| active && d.is_absolute())
}

/// A self-test run shows no window and no Dock icon, whatever the config says.
pub fn stay_hidden<M: Manager<tauri::Wry>>(app: &M) {
    #[cfg(target_os = "macos")]
    let _ = app
        .app_handle()
        .set_activation_policy(tauri::ActivationPolicy::Prohibited);
    for w in app.webview_windows().values() {
        let _ = w.hide();
    }
}

/// Where the report goes, or None unless the identifier, the mode and the path all say self-test.
/// The self-test modes: every bundled plugin's install, or YouTube end to end (search, resolve, open).
fn gate(identifier: &str, mode: Option<&str>, out: Option<PathBuf>) -> Option<PathBuf> {
    if !is_selftest(identifier) || !mode.is_some_and(|m| MODES.contains(&m)) {
        return None;
    }
    out.filter(|p| p.is_absolute())
}

fn out_path(app: &AppHandle) -> Option<PathBuf> {
    let mode = std::env::var("FLICK_SELFTEST").ok();
    gate(
        &app.config().identifier,
        mode.as_deref(),
        std::env::var_os("FLICK_SELFTEST_OUT").map(PathBuf::from),
    )
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    mode: String,
    launched_at: u64,
    setup_at: u64,
    /// The playback mode's fixture server (scripts/desktop-selftest.mjs), always on this Mac.
    media: Option<String>,
}

/// FLICK_SELFTEST_MEDIA, when it names a server on the loopback address: the run never plays anything else.
fn loopback(url: Option<String>) -> Option<String> {
    url.filter(|u| u.starts_with("http://127.0.0.1:") && !u.contains('@'))
}

#[tauri::command]
pub fn selftest_mode(app: AppHandle) -> Option<Mode> {
    out_path(&app)?;
    Some(Mode {
        mode: env_mode()?.to_string(),
        launched_at: LAUNCHED_MS.get().copied().unwrap_or(0),
        setup_at: SETUP_MS.get().copied().unwrap_or(0),
        media: loopback(std::env::var("FLICK_SELFTEST_MEDIA").ok()),
    })
}

/// One progress line, appended next to the report, so a run that never finishes still shows where it stopped.
#[tauri::command]
pub fn selftest_note(app: AppHandle, line: String) -> Result<(), String> {
    use std::io::Write;
    let out = out_path(&app).ok_or("Not a self-test run.")?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(out.with_extension("log"))
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn selftest_done(app: AppHandle, report: String) -> Result<(), String> {
    let out = out_path(&app).ok_or("Not a self-test run.")?;
    let tmp = out.with_extension("part");
    std::fs::write(&tmp, report).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    let handle = app.clone();
    // Quit after the reply reaches the page.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(200));
        handle.exit(0);
    });
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTIFIER: &str = "dev.flick.selftest.0123abcd";

    #[test]
    fn a_selftest_identifier_is_the_prefix_and_8_hex() {
        assert!(is_selftest(IDENTIFIER));
        for bad in [
            "com.dbaney.flick",
            "dev.flick.selftest",
            "dev.flick.selftest.",
            "dev.flick.selftest.0123abc",
            "dev.flick.selftest.0123abcde",
            "dev.flick.selftest.0123ABCD",
            "dev.flick.selftest.0123abcg",
            "dev.flick.selftest.0123abcd.x",
            "com.dbaney.flick.selftest.0123abcd",
        ] {
            assert!(!is_selftest(bad), "{bad}");
        }
    }

    #[test]
    fn only_a_selftest_run_reads_the_shared_tools_folder() {
        let d = || Some(PathBuf::from("/Users/x/Library/Caches/flick-selftest-tools"));
        assert_eq!(tools_gate(true, d()), d());
        assert_eq!(tools_gate(false, d()), None);
        assert_eq!(tools_gate(true, Some("rel".into())), None);
        assert_eq!(tools_gate(true, None), None);
    }

    #[test]
    fn only_the_selftest_identifier_with_the_mode_and_an_absolute_path_runs() {
        let p = || Some(PathBuf::from("/tmp/flick-selftest.json"));
        assert_eq!(gate(IDENTIFIER, Some("plugins"), p()), p());
        assert_eq!(gate(IDENTIFIER, Some("perf"), p()), p());
        assert_eq!(gate("com.dbaney.flick", Some("perf"), p()), None);
        assert_eq!(gate(IDENTIFIER, Some("youtube"), p()), p());
        assert_eq!(gate("com.dbaney.flick", Some("youtube"), p()), None);
        assert_eq!(gate("com.dbaney.flick", Some("plugins"), p()), None);
        assert_eq!(gate(IDENTIFIER, None, p()), None);
        assert_eq!(gate(IDENTIFIER, Some("other"), p()), None);
        assert_eq!(gate(IDENTIFIER, Some("plugins"), None), None);
        assert_eq!(
            gate(IDENTIFIER, Some("plugins"), Some("rel.json".into())),
            None
        );
    }

    #[test]
    fn the_playback_mode_plays_only_from_this_mac() {
        let p = || Some(PathBuf::from("/tmp/report.json"));
        assert_eq!(gate(IDENTIFIER, Some("playback"), p()), p());
        assert_eq!(gate("com.dbaney.flick", Some("playback"), p()), None);
        let l = |u: &str| loopback(Some(u.into()));
        assert_eq!(
            l("http://127.0.0.1:18766"),
            Some("http://127.0.0.1:18766".into())
        );
        assert_eq!(l("https://example.com/a.mkv"), None);
        assert_eq!(l("http://127.0.0.1:1@example.com/"), None);
        assert_eq!(loopback(None), None);
    }

    #[test]
    fn only_the_selftest_build_gets_the_page_hook() {
        // The identifier is checked before the environment, so no env var can put the hook in Flick itself.
        assert_eq!(init_script("com.dbaney.flick"), None);
        assert_eq!(init_script(""), None);
    }
}
