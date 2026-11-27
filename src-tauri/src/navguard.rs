// Keeps every webview, and every frame in it, on Flick's own pages. A page or frame that set
// `location.href` to an outside server could carry data out in the address, around a plugin's host
// list and the plugin page's `connect-src 'none'`. WebKit asks this for subframes too.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, Url};

/// Flick's own origin on each platform: `tauri://localhost` on macOS and Linux, `http(s)://tauri.localhost`
/// on Windows and Android.
const APP: [(&str, &str); 3] = [
    ("tauri", "localhost"),
    ("http", "tauri.localhost"),
    ("https", "tauri.localhost"),
];

/// Whether a webview or frame may load `url`: Flick's own origin, `about:blank`, `about:srcdoc` (the
/// EPUB reader's page), or the dev server in `tauri dev`.
pub fn allowed(url: &Url, dev: Option<&Url>) -> bool {
    if url.scheme() == "about" {
        return matches!(url.path(), "blank" | "srcdoc");
    }
    let host = url.host_str();
    let own = APP
        .iter()
        .any(|(scheme, h)| url.scheme() == *scheme && host == Some(h) && url.port().is_none());
    own || dev.is_some_and(|d| {
        url.scheme() == d.scheme()
            && host == d.host_str()
            && url.port_or_known_default() == d.port_or_known_default()
    })
}

pub fn init<R: Runtime>(dev: Option<Url>) -> TauriPlugin<R> {
    Builder::new("flick-navguard")
        .on_navigation(move |_, url| {
            let ok = allowed(url, dev.as_ref());
            // Only the scheme and host: the rest of a refused address may be the data it tried to carry out.
            if !ok {
                eprintln!(
                    "flick: refused a navigation to {}://{}",
                    url.scheme(),
                    url.host_str().unwrap_or("")
                );
            }
            ok
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(url: &str, dev: Option<&str>) -> bool {
        let dev = dev.map(|d| Url::parse(d).unwrap());
        allowed(&Url::parse(url).unwrap(), dev.as_ref())
    }

    #[test]
    fn flick_pages_and_blank_frames_load() {
        for url in [
            "tauri://localhost",
            "tauri://localhost/",
            "tauri://localhost/index.html#/settings/plugins",
            "tauri://localhost/plugin-host-app.html",
            "http://tauri.localhost/plugin-host-app.html",
            "https://tauri.localhost/",
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
}
