// The desktop self-test (scripts/desktop-selftest.mjs). Only a build with the self-test identifier, started
// with FLICK_SELFTEST=plugins, runs it, so the user's own Flick and its data never do. The report goes to the
// path in FLICK_SELFTEST_OUT, which the web side cannot choose, and then the app quits.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

pub const IDENTIFIER: &str = "dev.flick.selftest";

/// True when the process was started for a self-test, before the app config is read.
pub fn requested() -> bool {
    std::env::var_os("FLICK_SELFTEST").is_some()
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
    if identifier != IDENTIFIER || mode != Some("plugins") {
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

#[tauri::command]
pub fn selftest_mode(app: AppHandle) -> Option<String> {
    out_path(&app).map(|_| "plugins".to_string())
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
        assert_eq!(gate("com.dbaney.flick", Some("plugins"), p()), None);
        assert_eq!(gate(IDENTIFIER, None, p()), None);
        assert_eq!(gate(IDENTIFIER, Some("other"), p()), None);
        assert_eq!(gate(IDENTIFIER, Some("plugins"), None), None);
        assert_eq!(gate(IDENTIFIER, Some("plugins"), Some("rel.json".into())), None);
    }
}
