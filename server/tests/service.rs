use flick_server::service::*;
use std::path::Path;

const EXE: &str = "/Users/a b/My Apps/flick-server";
const CFG: &str = "/Users/a b/.config/flick & co";
const LOG: &str = "/Users/a b/Library/Logs/flick-server.log";

/// The text of each `<string>` inside `<array>`, with XML entities decoded.
fn program_arguments(plist: &str) -> Vec<String> {
    let arr = &plist[plist.find("<array>").unwrap()..plist.find("</array>").unwrap()];
    arr.split("<string>")
        .skip(1)
        .map(|s| s.split("</string>").next().unwrap())
        .map(|s| {
            s.replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&amp;", "&")
        })
        .collect()
}

#[test]
fn plist_runs_exe_with_config_only() {
    let p = plist(Path::new(EXE), Path::new(CFG), Path::new(LOG));
    assert_eq!(program_arguments(&p), [EXE, "--config", CFG]);
    assert!(p.contains("<string>/Users/a b/.config/flick &amp; co</string>"));
    assert!(!p.contains("flick & co"), "raw & breaks the XML");
    for key in ["RunAtLoad", "KeepAlive"] {
        assert!(p.contains(&format!("<key>{key}</key>\n  <true/>")), "{key}");
    }
    assert_eq!(p.matches(&format!("<string>{LOG}</string>")).count(), 2);
    assert!(p.contains(&format!("<string>{LABEL}</string>")));
}

#[cfg(target_os = "macos")]
#[test]
fn plist_passes_plutil() {
    let dir = std::env::temp_dir().join(format!("flick-svc-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("t.plist");
    std::fs::write(&file, plist(Path::new(EXE), Path::new(CFG), Path::new(LOG))).unwrap();
    let lint = std::process::Command::new("plutil")
        .arg("-lint")
        .arg(&file)
        .output()
        .unwrap();
    assert!(
        lint.status.success(),
        "{}",
        String::from_utf8_lossy(&lint.stdout)
    );
    for (i, want) in [EXE, "--config", CFG].iter().enumerate() {
        let out = std::process::Command::new("plutil")
            .args([
                "-extract",
                &format!("ProgramArguments.{i}"),
                "raw",
                "-o",
                "-",
            ])
            .arg(&file)
            .output()
            .unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim_end(), *want);
    }
    std::fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn systemd_quoting() {
    assert_eq!(systemd_quote("/opt/my apps/x"), "\"/opt/my apps/x\"");
    assert_eq!(systemd_quote(r#"a"b\c"#), r#""a\"b\\c""#);
    assert_eq!(systemd_quote("50%$HOME"), "\"50%%$$HOME\"");
    let u = unit(
        Path::new("/opt/my apps/flick-server"),
        Path::new("/home/u/.config/flick-server"),
    );
    let exec: Vec<&str> = u.lines().filter(|l| l.starts_with("ExecStart=")).collect();
    assert_eq!(
        exec,
        ["ExecStart=\"/opt/my apps/flick-server\" --config \"/home/u/.config/flick-server\""]
    );
    assert!(u.contains("\nRestart=on-failure\n"));
    assert!(u.contains("\nWantedBy=default.target\n"));
}

#[test]
fn windows_quoting() {
    assert_eq!(
        win_quote(r"C:\Program Files\x.exe"),
        r#""C:\Program Files\x.exe""#
    );
    assert_eq!(
        win_quote(r"C:\cfg dir\"),
        r#""C:\cfg dir\\""#,
        "a trailing \\ must not eat the quote"
    );
    assert_eq!(win_quote(r#"a\"b"#), r#""a\\\"b""#);
    assert_eq!(plain(Path::new(r"\\?\C:\x")), Path::new(r"C:\x"));
    assert_eq!(
        plain(Path::new(r"\\?\UNC\nas\share")),
        Path::new(r"\\nas\share")
    );
    let exe = Path::new(r"\\?\C:\Program Files\Flick & Co\flick-server.exe");
    let cfg = Path::new(r"C:\Users\A B\AppData\Roaming\flick-server\");
    let x = task_xml(exe, cfg, r"PC\A B");
    assert!(
        x.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"),
        "no 72 hour limit"
    );
    assert!(x.contains("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
    assert!(x.contains("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
    assert!(x.contains(r"<Command>C:\Program Files\Flick &amp; Co\flick-server.exe</Command>"));
    assert!(x.contains(r#"<Arguments>--config &quot;"#) || x.contains(r#"<Arguments>--config ""#));
    assert!(
        x.contains(r#"AppData\Roaming\flick-server\\"</Arguments>"#),
        "{x}"
    );
    assert!(x.contains(r"<UserId>PC\A B</UserId>"));
    let bytes = utf16le("<a/>");
    assert_eq!(&bytes[..4], &[0xFF, 0xFE, b'<', 0]);
    assert_eq!(
        schtasks_create_args(Path::new(r"\\?\C:\t\task.xml")).join(" "),
        r"/Create /TN FlickServer /XML C:\t\task.xml /F"
    );
}
