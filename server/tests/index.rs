use flick_server::index::{content_type, item_id, kind, labels, scan};
use flick_server::{parse_range, Range::*};
use std::fs;
use std::path::PathBuf;

pub fn temp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("flick-server-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn range_forms() {
    assert_eq!(parse_range("bytes=0-99", 1000), Part(0, 99));
    assert_eq!(parse_range("bytes=900-", 1000), Part(900, 999));
    assert_eq!(parse_range("bytes=-100", 1000), Part(900, 999));
    assert_eq!(parse_range("bytes=-5000", 1000), Part(0, 999));
    assert_eq!(parse_range("bytes=990-5000", 1000), Part(990, 999));
    assert_eq!(parse_range("bytes=0-0", 1), Part(0, 0));
}

#[test]
fn range_unsatisfiable_and_malformed() {
    assert_eq!(parse_range("bytes=1000-", 1000), Unsatisfiable);
    assert_eq!(parse_range("bytes=2000-3000", 1000), Unsatisfiable);
    assert_eq!(parse_range("bytes=-0", 1000), Unsatisfiable);
    assert_eq!(parse_range("bytes=0-", 0), Unsatisfiable);
    assert_eq!(parse_range("bytes=-5", 0), Unsatisfiable);
    assert_eq!(parse_range("bytes=50-10", 1000), Full);
    assert_eq!(parse_range("items=0-10", 1000), Full);
    assert_eq!(parse_range("bytes=abc", 1000), Full);
}

#[test]
fn range_multiple_serves_first() {
    assert_eq!(parse_range("bytes=10-19, 50-59", 1000), Part(10, 19));
    assert_eq!(parse_range("bytes=-10,0-5", 1000), Part(990, 999));
}

#[test]
fn id_is_stable_sha256_prefix() {
    // First 16 hex of sha256("Movies/Heat.mkv"), computed with Python's hashlib.
    assert_eq!(item_id("Movies", "Heat.mkv"), "d3022286ce55fd84");
    assert_ne!(
        item_id("Movies", "Heat.mkv"),
        item_id("Movies 2", "Heat.mkv")
    );
}

#[test]
fn kinds() {
    for e in ["mp4", "mkv", "webm", "m2ts", "3gp", "ogv"] {
        assert_eq!(kind(e), Some("video"), "{e}");
    }
    for e in ["mp3", "m4b", "flac", "opus", "aiff", "wma"] {
        assert_eq!(kind(e), Some("audio"), "{e}");
    }
    assert_eq!(kind("pdf"), Some("book"));
    assert_eq!(kind("epub"), Some("book"));
    assert_eq!(kind("txt"), None);
    assert_eq!(kind("srt"), None);
}

#[test]
fn book_content_types() {
    assert_eq!(content_type("pdf"), "application/pdf");
    assert_eq!(content_type("epub"), "application/epub+zip");
}

#[test]
fn folder_labels_dedupe() {
    let roots = [
        PathBuf::from("/a/Movies"),
        PathBuf::from("/b/Movies"),
        PathBuf::from("/c/TV"),
        PathBuf::from("/d/Movies"),
    ];
    assert_eq!(labels(&roots), ["Movies", "Movies 2", "TV", "Movies 3"]);
}

#[test]
fn scan_skips_hidden_symlinks_and_other_files() {
    let root = temp("scan").join("Movies");
    fs::create_dir_all(root.join("Heat (1995)")).unwrap();
    fs::create_dir_all(root.join(".secret")).unwrap();
    fs::write(root.join("Heat (1995)/Heat (1995).MKV"), b"x").unwrap();
    fs::write(root.join("song.mp3"), b"xy").unwrap();
    fs::write(root.join("notes.txt"), b"x").unwrap();
    fs::write(root.join(".hidden.mp4"), b"x").unwrap();
    fs::write(root.join(".secret/inside.mp4"), b"x").unwrap();
    let outside = temp("scan-outside");
    fs::write(outside.join("leak.mp4"), b"x").unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&outside, root.join("linkdir")).unwrap();
        std::os::unix::fs::symlink(outside.join("leak.mp4"), root.join("link.mp4")).unwrap();
    }
    let idx = scan(&[root]);
    let paths: Vec<_> = idx.items.iter().map(|i| i.path.as_str()).collect();
    assert_eq!(paths, ["Heat (1995)/Heat (1995).MKV", "song.mp3"]);
    let heat = &idx.items[0];
    assert_eq!(
        (heat.folder.as_str(), heat.kind, heat.ext.as_str()),
        ("Movies", "video", "mkv")
    );
    assert_eq!(heat.id, item_id("Movies", "Heat (1995)/Heat (1995).MKV"));
    assert!(heat.mtime > 1_600_000_000_000);
    assert_eq!(idx.items[1].size, 2);
}
