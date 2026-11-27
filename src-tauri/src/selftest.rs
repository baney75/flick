// The desktop self-test (scripts/desktop-selftest.mjs). Only a build with the self-test identifier, started
// with FLICK_SELFTEST=plugins or perf, runs it, so the user's own Flick and its data never do. The report goes to the
// path in FLICK_SELFTEST_OUT, which the web side cannot choose, and then the app quits.

use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

pub const IDENTIFIER: &str = "dev.flick.selftest";
const MODES: [&str; 2] = ["plugins", "perf"];
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
    if identifier != IDENTIFIER {
        return None;
    }
    let mode = env_mode()?;
    let at = LAUNCHED_MS.get().copied().unwrap_or(0);
    let raf = if mode == "perf" {
        "window.__FLICK_SELFTEST__.rafEmulated=true;\
         window.requestAnimationFrame=function(cb){return setTimeout(function(){cb(performance.now())},16)};\
         window.cancelAnimationFrame=function(id){clearTimeout(id)};"
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
                let _: () = msg_send![prefs, _setPageVisibilityBasedProcessSuppressionEnabled: Bool::NO];
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
    requested() && app.config().identifier == IDENTIFIER
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
fn gate(identifier: &str, mode: Option<&str>, out: Option<PathBuf>) -> Option<PathBuf> {
    if identifier != IDENTIFIER || !mode.is_some_and(|m| MODES.contains(&m)) {
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
}

#[tauri::command]
pub fn selftest_mode(app: AppHandle) -> Option<Mode> {
    out_path(&app)?;
    Some(Mode {
        mode: env_mode()?.to_string(),
        launched_at: LAUNCHED_MS.get().copied().unwrap_or(0),
        setup_at: SETUP_MS.get().copied().unwrap_or(0),
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

    #[test]
    fn only_the_selftest_identifier_with_the_mode_and_an_absolute_path_runs() {
        let p = || Some(PathBuf::from("/tmp/flick-selftest.json"));
        assert_eq!(gate(IDENTIFIER, Some("plugins"), p()), p());
        assert_eq!(gate(IDENTIFIER, Some("perf"), p()), p());
        assert_eq!(gate("com.dbaney.flick", Some("perf"), p()), None);
        assert_eq!(gate("com.dbaney.flick", Some("plugins"), p()), None);
        assert_eq!(gate(IDENTIFIER, None, p()), None);
        assert_eq!(gate(IDENTIFIER, Some("other"), p()), None);
        assert_eq!(gate(IDENTIFIER, Some("plugins"), None), None);
        assert_eq!(gate(IDENTIFIER, Some("plugins"), Some("rel.json".into())), None);
    }

    #[test]
    fn only_the_selftest_build_gets_the_page_hook() {
        // The identifier is checked before the environment, so no env var can put the hook in Flick itself.
        assert_eq!(init_script("com.dbaney.flick"), None);
        assert_eq!(init_script(""), None);
    }
}
