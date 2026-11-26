//! Start flick-server at login: a LaunchAgent on macOS, a systemd user unit on Linux, a logon task on Windows.
//! File contents come from pure functions; `install` and `uninstall` run the OS tools and return lines to print.
use std::path::{Path, PathBuf};
use std::process::Command;

pub const LABEL: &str = "com.dbaney.flick-server";
pub const UNIT: &str = "flick-server";
pub const TASK: &str = "FlickServer";

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// LaunchAgent that runs `exe --config <config>` at login, keeps it alive and logs to `log`.
pub fn plist(exe: &Path, config: &Path, log: &Path) -> String {
    let args: String = [exe, Path::new("--config"), config]
        .iter()
        .map(|a| format!("    <string>{}</string>\n", xml(&a.to_string_lossy())))
        .collect();
    let log = xml(&log.to_string_lossy());
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
{args}  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{log}</string>
  <key>StandardErrorPath</key>
  <string>{log}</string>
</dict>
</plist>
"
    )
}

/// One systemd command line word: double-quoted, with `\` and `"` escaped and `%` and `$` doubled.
pub fn systemd_quote(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '%' => o.push_str("%%"),
            '$' => o.push_str("$$"),
            _ => o.push(c),
        }
    }
    o + "\""
}

/// systemd user unit that runs `exe --config <config>` and restarts it when it fails.
pub fn unit(exe: &Path, config: &Path) -> String {
    format!(
        "[Unit]\nDescription=Flick media server\n\n[Service]\nExecStart={} --config {}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
        systemd_quote(&exe.to_string_lossy()),
        systemd_quote(&config.to_string_lossy())
    )
}

/// One Windows command line word, quoted so CommandLineToArgvW reads it back unchanged.
pub fn win_quote(s: &str) -> String {
    let (mut o, mut slashes) = (String::from("\""), 0);
    for c in s.chars() {
        match c {
            '\\' => {
                slashes += 1;
                continue;
            }
            '"' => o.push_str(&"\\".repeat(slashes * 2 + 1)),
            _ => o.push_str(&"\\".repeat(slashes)),
        }
        o.push(c);
        slashes = 0;
    }
    o + &"\\".repeat(slashes * 2) + "\""
}

/// Task Scheduler XML for a logon task of `user` running `exe --config <config>`. Unlike a plain
/// `schtasks /Create`, it has no 72 hour run limit, keeps running on battery and restarts after a crash.
pub fn task_xml(exe: &Path, config: &Path, user: &str) -> String {
    let exe = xml(&plain(exe).to_string_lossy());
    let args = xml(&format!(
        "--config {}",
        win_quote(&plain(config).to_string_lossy())
    ));
    let user = xml(user);
    format!(
        r#"<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Flick server: shares media folders with Flick</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{user}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>{user}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <StartWhenAvailable>true</StartWhenAvailable>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author"><Exec><Command>{exe}</Command><Arguments>{args}</Arguments></Exec></Actions>
</Task>
"#
    )
}

/// UTF-16 LE with a byte order mark, the encoding `schtasks /XML` reads reliably.
pub fn utf16le(s: &str) -> Vec<u8> {
    [0xFF, 0xFE]
        .into_iter()
        .chain(s.encode_utf16().flat_map(|u| u.to_le_bytes()))
        .collect()
}

/// `schtasks` arguments that create the task from the XML at `xml_path`, replacing an old one.
pub fn schtasks_create_args(xml_path: &Path) -> Vec<String> {
    ["/Create", "/TN", TASK, "/XML"]
        .iter()
        .map(|s| s.to_string())
        .chain([plain(xml_path).to_string_lossy().into_owned(), "/F".into()])
        .collect()
}

/// Drops the `\\?\` prefix Windows canonicalize adds, which schtasks and some programs reject.
pub fn plain(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    s.strip_prefix(r"\\?\")
        .map_or(p.to_path_buf(), PathBuf::from)
}

fn run(cmd: &str, args: &[&str]) -> Result<(bool, String), String> {
    let o = Command::new(cmd)
        .args(args)
        .output()
        .map_err(|e| format!("{cmd}: {e}"))?;
    let text = String::from_utf8_lossy(&o.stdout).to_string() + &String::from_utf8_lossy(&o.stderr);
    Ok((o.status.success(), text.trim().to_string()))
}

fn must(cmd: &str, args: &[&str]) -> Result<(), String> {
    match run(cmd, args)? {
        (true, _) => Ok(()),
        (false, out) => Err(format!("{cmd} {} failed: {out}", args.join(" "))),
    }
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| "HOME is not set".into())
}

fn write(path: &Path, body: &str) -> Result<(), String> {
    let err = |e: std::io::Error| format!("{}: {e}", path.display());
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(err)?;
    std::fs::write(path, body).map_err(err)
}

fn launchd_paths() -> Result<(PathBuf, PathBuf, String), String> {
    let home = home()?;
    let plist = home.join(format!("Library/LaunchAgents/{LABEL}.plist"));
    let log = home.join("Library/Logs/flick-server.log");
    let (_, uid) = run("id", &["-u"])?;
    Ok((plist, log, format!("gui/{uid}")))
}

fn unit_path() -> Result<PathBuf, String> {
    let base = match std::env::var_os("XDG_CONFIG_HOME") {
        Some(d) => PathBuf::from(d),
        None => home()?.join(".config"),
    };
    Ok(base.join(format!("systemd/user/{UNIT}.service")))
}

/// Registers `exe --config <config>` to start at login and starts it now. Both paths should be absolute.
pub fn install(exe: &Path, config: &Path) -> Result<Vec<String>, String> {
    let run_line = format!("{} --config {}", exe.display(), config.display());
    let mut lines = vec![];
    if cfg!(target_os = "macos") {
        let (path, log, domain) = launchd_paths()?;
        let _ = run("launchctl", &["bootout", &format!("{domain}/{LABEL}")]);
        write(&path, &plist(exe, config, &log))?;
        let p = path.to_string_lossy();
        let mut tries = 0;
        while let (false, out) = run("launchctl", &["bootstrap", &domain, &p])? {
            tries += 1;
            if tries == 10 {
                return Err(format!("launchctl bootstrap {domain} {p} failed: {out}"));
            }
            std::thread::sleep(std::time::Duration::from_millis(300));
        }
        lines.push(format!("Installed LaunchAgent {}", path.display()));
        lines.push(format!("Log: {}", log.display()));
    } else if cfg!(target_os = "linux") {
        let path = unit_path()?;
        write(&path, &unit(exe, config))?;
        must("systemctl", &["--user", "daemon-reload"])?;
        must("systemctl", &["--user", "enable", "--now", UNIT])?;
        must("systemctl", &["--user", "restart", UNIT])?;
        lines.push(format!("Installed systemd user unit {}", path.display()));
        lines.push(format!("Log: journalctl --user -u {UNIT}"));
        let user = std::env::var("USER").unwrap_or_default();
        let linger = run("loginctl", &["show-user", &user, "-p", "Linger"]).unwrap_or_default();
        if linger.1 != "Linger=yes" {
            lines.push(format!("Note: it stops when you log out. To keep it running after logout and start it at boot, run: sudo loginctl enable-linger {user}"));
        }
    } else if cfg!(windows) {
        let user = match (std::env::var("USERDOMAIN"), std::env::var("USERNAME")) {
            (Ok(d), Ok(u)) => format!("{d}\\{u}"),
            (_, Ok(u)) => u,
            _ => return Err("USERNAME is not set, so the logon task has no user".into()),
        };
        let xml_path = config.join("flick-server-task.xml");
        std::fs::write(&xml_path, utf16le(&task_xml(exe, config, &user)))
            .map_err(|e| format!("{}: {e}", xml_path.display()))?;
        let args = schtasks_create_args(&xml_path);
        let made = must(
            "schtasks",
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
        );
        let _ = std::fs::remove_file(&xml_path);
        made?;
        let _ = run("schtasks", &["/End", "/TN", TASK]);
        must("schtasks", &["/Run", "/TN", TASK])?;
        lines.push(format!("Installed scheduled task {TASK} (runs at logon)"));
        lines.push("Log: none; run flick-server in a terminal to see its output".into());
    } else {
        return Err("--install supports macOS, Linux and Windows".into());
    }
    lines.insert(1, format!("It runs: {run_line}"));
    lines.push(format!("Remove it with: {} --uninstall", exe.display()));
    Ok(lines)
}

/// Stops and removes what `install` set up. Succeeds when nothing is installed.
pub fn uninstall() -> Result<Vec<String>, String> {
    let mut removed = None;
    if cfg!(target_os = "macos") {
        let (path, _, domain) = launchd_paths()?;
        let (loaded, _) = run("launchctl", &["bootout", &format!("{domain}/{LABEL}")])?;
        let existed = path.exists();
        if existed {
            std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        }
        if loaded || existed {
            removed = Some(format!("LaunchAgent {}", path.display()));
        }
    } else if cfg!(target_os = "linux") {
        let path = unit_path()?;
        if path.exists() {
            let _ = run("systemctl", &["--user", "disable", "--now", UNIT]);
            std::fs::remove_file(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            let _ = run("systemctl", &["--user", "daemon-reload"]);
            removed = Some(format!("systemd user unit {}", path.display()));
        }
    } else if cfg!(windows) && run("schtasks", &["/Query", "/TN", TASK])?.0 {
        let _ = run("schtasks", &["/End", "/TN", TASK]);
        must("schtasks", &["/Delete", "/TN", TASK, "/F"])?;
        removed = Some(format!("scheduled task {TASK}"));
    }
    Ok(vec![match removed {
        Some(what) => format!("Stopped and removed {what}"),
        None => "flick-server was not installed; nothing to remove".into(),
    }])
}
