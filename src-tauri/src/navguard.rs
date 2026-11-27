// Keeps every webview, and every frame in it, on Flick's own pages. A page or frame that set
// `location.href` to an outside server could carry data out in the address, around a plugin's host
// list and the plugin page's `connect-src 'none'`. WebKit asks this for subframes too.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// The scheme and host Flick's pages load from on this platform: `tauri://localhost` on macOS, iOS and
/// Linux, `http(s)://tauri.localhost` on Windows and Android (`https` when the window sets
/// `useHttpsScheme`). Only that one: on Windows `https://tauri.localhost` with the `http` scheme in use
/// is not Flick, it resolves to this machine's port 443.
pub fn app_origin(https: bool) -> (&'static str, &'static str) {
    if cfg!(any(windows, target_os = "android")) {
        (if https { "https" } else { "http" }, "tauri.localhost")
    } else {
        ("tauri", "localhost")
    }
}

/// Whether a webview or frame may load `url`: Flick's own origin `app`, `about:blank`, `about:srcdoc`
/// (the EPUB reader's page), or the dev server in `tauri dev`.
pub fn allowed(url: &Url, app: (&str, &str), dev: Option<&Url>) -> bool {
    if url.scheme() == "about" {
        return matches!(url.path(), "blank" | "srcdoc");
    }
    let host = url.host_str();
    let own = url.scheme() == app.0 && host == Some(app.1) && url.port().is_none();
    own || dev.is_some_and(|d| {
        url.scheme() == d.scheme()
            && host == d.host_str()
            && url.port_or_known_default() == d.port_or_known_default()
    })
}

pub fn init<R: Runtime>(https: bool, dev: Option<Url>) -> TauriPlugin<R> {
    let app = app_origin(https);
    Builder::new("flick-navguard")
        .on_navigation(move |_, url| {
            let ok = allowed(url, app, dev.as_ref());
            // Only the scheme: the host, path and query of a refused address may be the data it tried to carry out.
            if !ok {
                eprintln!("flick: refused a navigation (scheme {})", url.scheme());
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TAURI: (&str, &str) = ("tauri", "localhost");

    fn ok(url: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|d| Url::parse(d).unwrap());
        allowed(&Url::parse(url).unwrap(), TAURI, dev.as_ref())
    }

    #[test]
    fn flick_pages_and_blank_frames_load() {
        for url in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html#/settings/plugins",
            "tauri://localhost/plugin-host-app.html",
            "about:blank",
            "about:srcdoc",
        ] {
            assert!(ok(url, None), "{url}");
        }
        assert!(ok(
            "http://localhost:5178/#/",
            Some("http://localhost:5178")
        ));
        assert!(ok(
            "http://localhost:5178/plugin-host-app.html",
            Some("http://localhost:5178/")
        ));
    }

    #[test]
    fn outside_addresses_are_refused() {
        for url in [
            "https://evil.example/?data=secret",
            "http://127.0.0.1:8080/leak",
            "http://localhost:5178/",
            "tauri://evil.example/",
            "tauri://localhost.evil.example/",
            "http://tauri.localhost.evil.example/",
            "http://tauri.localhost:8080/",
            "https://tauri.localhost:444/",
            "http://evil.example@tauri.localhost.evil.example/",
            "file:///etc/passwd",
            "data:text/html,<p>x</p>",
            "blob:tauri://localhost/1234",
            "about:config",
            "javascript:alert(1)",
            "kodi://localhost/x",
        ] {
            assert!(!ok(url, None), "{url}");
        }
        // The dev server is allowed only on its own port, and only when one is set.
        assert!(!ok("http://localhost:5179/", Some("http://localhost:5178")));
        assert!(!ok(
            "https://localhost:5178/",
            Some("http://localhost:5178")
        ));
        assert!(!ok("http://127.0.0.1:5178/", Some("http://localhost:5178")));
    }

    #[test]
    fn only_the_origin_in_use_counts_as_flick() {
        let on = |url: &str, app| allowed(&Url::parse(url).unwrap(), app, None);
        // With tauri://localhost in use, the Windows and Android names go to this machine's ports.
        assert!(!on("http://tauri.localhost/", TAURI));
        assert!(!on("https://tauri.localhost/?d=secret", TAURI));
        let http = ("http", "tauri.localhost");
        assert!(on("http://tauri.localhost/plugin-host-app.html", http));
        assert!(!on("https://tauri.localhost/?d=secret", http));
        assert!(!on("tauri://localhost/", http));
        let https = ("https", "tauri.localhost");
        assert!(on("https://tauri.localhost/", https));
        assert!(!on("http://tauri.localhost/?d=secret", https));
        if cfg!(any(windows, target_os = "android")) {
            assert_eq!(app_origin(false), http);
            assert_eq!(app_origin(true), https);
        } else {
            assert_eq!(app_origin(false), TAURI);
            assert_eq!(app_origin(true), TAURI);
        }
    }
}
